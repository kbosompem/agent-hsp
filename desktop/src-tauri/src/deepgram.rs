// Deepgram (cloud speech-to-text) as a third speech engine, for churches with
// reliable internet and a Deepgram account. Audio from the same ring buffer
// is streamed to Deepgram's live endpoint as 16-bit PCM; its interim and final
// results become the same "transcript-partial" / "transcript" events as the
// local engines, so the console does not change.
//
// The API key is kept in the app data folder (deepgram.key, owner-only on
// Unix) and never sent back to the console.
//
// Deepgram bills every second of audio sent, speech or not. After a stretch of
// quiet the audio stops (a KeepAlive holds the connection, which is not
// billed); after five quiet minutes the console is told to stop the session.

use serde::Serialize;
use std::io::ErrorKind;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tungstenite::client::IntoClientRequest;
use tungstenite::{Message, WebSocket};

use crate::audio::{slice_abs, ListenState, TARGET_SR};
use crate::segmenter::rms_of;

pub const MODEL: &str = "deepgram";

const URL: &str = "wss://api.deepgram.com/v1/listen?model=nova-3&language=en&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&endpointing=300&utterance_end_ms=1000&punctuate=true";

const SR: u64 = TARGET_SR as u64;
/// Quiet this long pauses the audio. Longer than any pause for breath or
/// effect, or a stretch of quiet prayer. (10 s cut into the 2026-10-25 service.)
const PAUSE_AFTER: u64 = 30 * SR;
/// On resuming, this much audio from before the first loud moment goes too,
/// so the first word is not cut.
const PREROLL: u64 = SR;
/// Quiet this long ends the session.
pub const STOP_AFTER: u64 = 300 * SR;
/// Deepgram closes a connection with no data for 10 s.
const KEEPALIVE_EVERY: Duration = Duration::from_secs(5);

/// The room's floor is the quietest half second in this window. Speech always
/// has gaps between sentences; a fan or air conditioning does not, so a steady
/// hum becomes the floor and counts as quiet.
const FLOOR_WINDOW: u64 = 30 * SR;

/// Speech is any half second this many times louder than the room's floor.
/// A church sound-board feed never goes quiet between sentences (reverb,
/// keyboard pads, "amen"), so speech stands only 1.5 to 2 times above it: at 3
/// the 2026-10-25 service would have lost 81% of its words (the session
/// stopped after 16 minutes), at 1.5 it loses 1%. A steady hum still varies
/// less than that, so the 2026-10-23 overnight recording still stops (after 65
/// minutes instead of 36). Replay with `examples/spend_gate.rs`.
const VOICE_RATIO: f32 = 1.5;

/// Decides whether the audio is worth paying Deepgram for. Speech is any half
/// second VOICE_RATIO times louder than the room's floor.
pub struct SpendGate {
    /// The floor the app last measured, used until the window has filled.
    start_floor: f32,
    started: u64,
    floor: f32,
    recent: std::collections::VecDeque<(u64, f32)>,
    last_voiced: u64,
    pub sending: bool,
}

#[derive(Debug, PartialEq)]
pub enum Gate {
    Send,
    /// Speech again after a pause: send from this sample position.
    Resume(u64),
    /// Quiet long enough: stop sending.
    Pause,
    Paused,
    /// Quiet for STOP_AFTER: end the session.
    Stop,
}

impl SpendGate {
    pub fn new(floor: f32, now: u64) -> SpendGate {
        SpendGate { start_floor: floor, started: now, floor, recent: Default::default(), last_voiced: now, sending: true }
    }

    /// `tail_rms` is the level of the last half second, ending at `pos`.
    pub fn step(&mut self, tail_rms: f32, pos: u64) -> Gate {
        self.recent.push_back((pos, tail_rms));
        while self.recent.front().map_or(false, |&(p, _)| p + FLOOR_WINDOW < pos) {
            self.recent.pop_front();
        }
        self.floor = self.recent.iter().map(|&(_, l)| l).fold(f32::MAX, f32::min);
        if pos < self.started + FLOOR_WINDOW {
            self.floor = self.floor.min(self.start_floor);
        }
        let voiced = tail_rms > (self.floor * VOICE_RATIO).max(0.0035);
        if voiced {
            self.last_voiced = pos;
            if !self.sending {
                self.sending = true;
                return Gate::Resume(pos.saturating_sub(SR / 2 + PREROLL));
            }
            return Gate::Send;
        }
        let quiet = pos.saturating_sub(self.last_voiced);
        if quiet >= STOP_AFTER {
            return Gate::Stop;
        }
        if self.sending && quiet >= PAUSE_AFTER {
            self.sending = false;
            return Gate::Pause;
        }
        if self.sending { Gate::Send } else { Gate::Paused }
    }
}

fn key_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("deepgram.key"))
}

pub fn load_key(app: &AppHandle) -> Option<String> {
    let k = std::fs::read_to_string(key_path(app).ok()?).ok()?;
    let k = k.trim().to_string();
    (!k.is_empty()).then_some(k)
}

/// Save (or clear, with an empty string) the Deepgram API key.
#[tauri::command]
pub fn set_deepgram_key(app: AppHandle, key: String) -> Result<(), String> {
    let p = key_path(&app)?;
    let key = key.trim();
    if key.is_empty() {
        let _ = std::fs::remove_file(&p);
        return Ok(());
    }
    if !key.chars().all(|c| c.is_ascii_alphanumeric()) || key.len() > 200 {
        return Err("That does not look like a Deepgram API key.".into());
    }
    std::fs::write(&p, key).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
pub fn has_deepgram_key(app: AppHandle) -> bool {
    load_key(&app).is_some()
}

#[derive(Serialize, Clone)]
struct TranscriptEvent {
    text: String,
    ms: usize,
    seg: u64,
}

#[derive(Clone, Serialize)]
struct SttHealth {
    lag_s: f32,
    ms: usize,
    error: Option<String>,
}

type Socket = WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>;

pub fn connect(key: &str) -> Result<Socket, String> {
    let mut req = URL.into_client_request().map_err(|e| e.to_string())?;
    req.headers_mut().insert(
        "Authorization",
        format!("Token {}", key).parse().map_err(|_| "bad key".to_string())?,
    );
    let tcp = TcpStream::connect(("api.deepgram.com", 443)).map_err(|e| e.to_string())?;
    tcp.set_nodelay(true).ok();
    let (ws, _) = tungstenite::client_tls(req, tcp).map_err(|e| match e {
        tungstenite::HandshakeError::Failure(tungstenite::Error::Http(r)) if r.status() == 401 => {
            "Deepgram rejected the API key.".to_string()
        }
        other => other.to_string(),
    })?;
    // Short reads so one thread can both send audio and receive results.
    if let tungstenite::stream::MaybeTlsStream::Rustls(s) = ws.get_ref() {
        s.get_ref().set_read_timeout(Some(Duration::from_millis(20))).ok();
    }
    Ok(ws)
}

/// One Deepgram "Results" message: (text, is_final, speech_final).
pub fn parse_result(v: &serde_json::Value) -> Option<(String, bool, bool)> {
    if v["type"] != "Results" {
        return None;
    }
    let text = v["channel"]["alternatives"][0]["transcript"].as_str()?.trim().to_string();
    Some((text, v["is_final"].as_bool().unwrap_or(false), v["speech_final"].as_bool().unwrap_or(false)))
}

pub fn spawn(app: AppHandle, shared: Arc<ListenState>, session_gen: usize, key: String) {
    std::thread::spawn(move || {
        let running = || shared.running.load(Ordering::SeqCst) && shared.generation.load(Ordering::SeqCst) == session_gen;
        let mut seg: u64 = 0;
        while running() {
            let mut ws = match connect(&key) {
                Ok(ws) => ws,
                Err(e) => {
                    let _ = app.emit("stt-health", SttHealth { lag_s: 0.0, ms: 0, error: Some(format!("Deepgram: {}", e)) });
                    let _ = app.emit("listen-status", format!("Deepgram: {}. Retrying… (or choose Nemotron in Settings)", e));
                    std::thread::sleep(Duration::from_secs(3));
                    continue;
                }
            };
            let _ = app.emit("listen-status", "Listening with Deepgram (online).");
            // Start from live audio: never replay a backlog after a reconnect.
            let mut fed = shared.total.load(Ordering::SeqCst);
            let mut gate = SpendGate::new(*shared.floor.lock().unwrap(), fed);
            let mut last_keepalive = Instant::now();
            let mut stop_sent = false;
            // Final pieces of the sentence so far, and the latest interim.
            let mut committed: Vec<String> = Vec::new();
            let mut shown = String::new();
            let mut last_alive = Instant::now();
            let mut last_level = Instant::now();
            let mut last_result = Instant::now();
            let failure: Option<String> = loop {
                if !running() {
                    let _ = ws.send(Message::Text(r#"{"type":"CloseStream"}"#.into()));
                    break None;
                }
                std::thread::sleep(Duration::from_millis(50));
                if last_alive.elapsed() >= Duration::from_secs(1) {
                    last_alive = Instant::now();
                    let _ = app.emit("stt-alive", ());
                }
                if last_level.elapsed() > Duration::from_millis(300) {
                    last_level = Instant::now();
                    let _ = app.emit("level", *shared.level.lock().unwrap());
                }
                let total = shared.total.load(Ordering::SeqCst);
                let tail_rms = {
                    let buf = shared.pcm.lock().unwrap();
                    rms_of(&slice_abs(&buf, total, total.saturating_sub(SR / 2), total))
                };
                match gate.step(tail_rms, total) {
                    Gate::Send => {}
                    Gate::Resume(from) => {
                        fed = from.max(fed.min(total));
                        let _ = app.emit("listen-status", "Listening with Deepgram (online).");
                    }
                    Gate::Pause => {
                        // Flush the words still pending, then send nothing billable.
                        let _ = ws.send(Message::Text(r#"{"type":"Finalize"}"#.into()));
                        last_keepalive = Instant::now();
                        let _ = app.emit("listen-status", "Quiet: Deepgram paused (not billed). It resumes when someone speaks.");
                    }
                    Gate::Paused => {}
                    Gate::Stop => {
                        if !stop_sent {
                            stop_sent = true;
                            let _ = app.emit("idle-stop", "No one has spoken for 5 minutes.");
                        }
                    }
                }
                if !gate.sending {
                    fed = total;
                    // Nothing comes back while paused: that is not a dead line.
                    last_result = Instant::now();
                    if last_keepalive.elapsed() >= KEEPALIVE_EVERY {
                        last_keepalive = Instant::now();
                        if let Err(e) = ws.send(Message::Text(r#"{"type":"KeepAlive"}"#.into())) {
                            break Some(e.to_string());
                        }
                    }
                }
                if total > fed {
                    let pcm: Vec<u8> = {
                        let buf = shared.pcm.lock().unwrap();
                        let oldest = total.saturating_sub(buf.len() as u64);
                        slice_abs(&buf, total, fed.max(oldest), total)
                            .iter()
                            .flat_map(|x| ((x.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())
                            .collect()
                    };
                    fed = total;
                    if let Err(e) = ws.send(Message::Binary(pcm.into())) {
                        break Some(e.to_string());
                    }
                }
                // Drain whatever has arrived.
                loop {
                    match ws.read() {
                        Ok(Message::Text(t)) => {
                            last_result = Instant::now();
                            let v: serde_json::Value = match serde_json::from_str(&t) {
                                Ok(v) => v,
                                Err(_) => continue,
                            };
                            let end_of_speech = v["type"] == "UtteranceEnd";
                            let mut close = end_of_speech;
                            if let Some((text, is_final, speech_final)) = parse_result(&v) {
                                let lag_s = shared.total.load(Ordering::SeqCst).saturating_sub(fed) as f32 / TARGET_SR as f32;
                                let _ = app.emit("stt-health", SttHealth { lag_s, ms: 0, error: None });
                                let mut parts = committed.clone();
                                if !text.is_empty() {
                                    parts.push(text.clone());
                                }
                                let open = parts.join(" ");
                                if !open.is_empty() && open != shown {
                                    let _ = app.emit("transcript-partial", TranscriptEvent { text: open.clone(), ms: 0, seg });
                                    shown = open;
                                }
                                if is_final && !text.is_empty() {
                                    committed.push(text);
                                }
                                close = close || speech_final;
                            }
                            if close && !committed.is_empty() {
                                let final_text = committed.join(" ");
                                crate::session::transcript(fed, &final_text);
                                let _ = app.emit("transcript", TranscriptEvent { text: final_text, ms: 0, seg });
                                committed.clear();
                                shown.clear();
                                seg += 1;
                            }
                        }
                        Ok(Message::Close(_)) => {
                            break;
                        }
                        Ok(_) => {}
                        Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => break,
                        Err(e) => {
                            let _ = app.emit("stt-health", SttHealth { lag_s: 0.0, ms: 0, error: Some(format!("Deepgram: {}", e)) });
                            last_result = Instant::now() - Duration::from_secs(3600);
                            break;
                        }
                    }
                }
                if last_result.elapsed() > Duration::from_secs(20) {
                    break Some("no reply from Deepgram for 20 s".into());
                }
            };
            if let Some(e) = failure {
                let _ = app.emit("stt-health", SttHealth { lag_s: 0.0, ms: 0, error: Some(format!("Deepgram: {}", e)) });
                let _ = app.emit("listen-status", format!("Deepgram connection lost ({}). Reconnecting…", e));
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOUD: f32 = 0.05;
    const QUIET: f32 = 0.001;

    /// Feed `secs` seconds of one level in 50 ms steps; return what changed.
    fn run(g: &mut SpendGate, pos: &mut u64, level: f32, secs: u64) -> Vec<Gate> {
        let mut out = Vec::new();
        for _ in 0..secs * 20 {
            *pos += SR / 20;
            match g.step(level, *pos) {
                Gate::Send | Gate::Paused => {}
                other => out.push(other),
            }
        }
        out
    }

    #[test]
    fn short_pauses_keep_sending() {
        let mut pos = 0;
        let mut g = SpendGate::new(QUIET, pos);
        assert!(run(&mut g, &mut pos, LOUD, 5).is_empty());
        assert!(run(&mut g, &mut pos, QUIET, 25).is_empty());
        assert!(g.sending);
    }

    #[test]
    fn quiet_pauses_then_speech_resumes_with_preroll() {
        let mut pos = 0;
        let mut g = SpendGate::new(QUIET, pos);
        run(&mut g, &mut pos, LOUD, 2);
        assert_eq!(run(&mut g, &mut pos, QUIET, 31), vec![Gate::Pause]);
        assert!(!g.sending);
        pos += SR / 20;
        assert_eq!(g.step(LOUD, pos), Gate::Resume(pos - SR / 2 - PREROLL));
        assert!(g.sending);
    }

    #[test]
    fn five_quiet_minutes_stop() {
        let mut pos = 0;
        let mut g = SpendGate::new(QUIET, pos);
        let changes = run(&mut g, &mut pos, QUIET, 301);
        assert_eq!(changes[0], Gate::Pause);
        assert!(changes.contains(&Gate::Stop));
    }

    #[test]
    fn steady_room_noise_counts_as_quiet() {
        // A loud fan from the start, far above the floor the app last saw:
        // it must not keep Deepgram billing.
        let mut pos = 0;
        let mut g = SpendGate::new(0.002, pos);
        let changes = run(&mut g, &mut pos, 0.01, 65);
        assert_eq!(changes, vec![Gate::Pause]);
    }

    #[test]
    fn speech_barely_above_a_live_room_keeps_sending() {
        // A sound-board feed in service: the gaps between sentences are reverb
        // and music at 0.012, the preacher only twice that.
        let mut pos = 0;
        let mut g = SpendGate::new(0.012, pos);
        for i in 0..2400 {
            pos += SR / 20;
            let level = if i % 60 < 40 { 0.024 } else { 0.012 };
            assert!(matches!(g.step(level, pos), Gate::Send), "paused at step {i}");
        }
    }

    #[test]
    fn speech_over_a_fan_keeps_sending() {
        // Sentences with short breaths, over the same fan, for two minutes.
        let mut pos = 0;
        let mut g = SpendGate::new(0.002, pos);
        for i in 0..2400 {
            pos += SR / 20;
            let level = if i % 80 < 70 { 0.06 } else { 0.01 };
            assert!(matches!(g.step(level, pos), Gate::Send), "paused at step {i}");
        }
    }
}
