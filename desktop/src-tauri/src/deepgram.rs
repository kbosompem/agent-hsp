// Deepgram (cloud speech-to-text) as a third speech engine, for churches with
// reliable internet and a Deepgram account. Audio from the same ring buffer
// is streamed to Deepgram's live endpoint as 16-bit PCM; its interim and final
// results become the same "transcript-partial" / "transcript" events as the
// local engines, so the console does not change.
//
// The API key is kept in the app data folder (deepgram.key, owner-only on
// Unix) and never sent back to the console.

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

pub const MODEL: &str = "deepgram";

const URL: &str = "wss://api.deepgram.com/v1/listen?model=nova-3&language=en&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&endpointing=300&utterance_end_ms=1000&punctuate=true";

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
