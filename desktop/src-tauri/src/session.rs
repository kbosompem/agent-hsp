// Records each listening session to disk so a service can be replayed and
// scored afterwards (issue 12): the 16 kHz audio, every final transcript and
// every slide put on the projector.
//
//   <app data>/sessions/<YYYY-MM-DD_HH-MM-SS>/
//     audio.wav         16-bit mono 16 kHz; header rewritten every few seconds,
//                       so a crash loses at most that much
//     transcript.jsonl  {"t": seconds from start, "text": ...}
//     slides.jsonl      {"t": ..., "kind", "title", "body", "sub"}
//
// One writer thread owns the files; callers only send messages, so the audio
// callback never waits on the disk.

use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::audio::TARGET_SR;

enum Msg {
    Audio(Vec<f32>),
    Line(&'static str, Value),
    Stop,
}

struct Session {
    tx: Sender<Msg>,
    started: Instant,
    /// Absolute sample position (ListenState.total) when recording began.
    start_sample: u64,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// Start recording into a new folder under `root`. Stops any session already running.
pub fn start(root: PathBuf, start_sample: u64) -> Result<PathBuf, String> {
    stop();
    let dir = root.join(stamp());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut wav = File::create(dir.join("audio.wav")).map_err(|e| e.to_string())?;
    write_header(&mut wav, 0).map_err(|e| e.to_string())?;
    let (tx, rx) = channel::<Msg>();
    let d = dir.clone();
    std::thread::spawn(move || {
        let open = |name: &str| OpenOptions::new().create(true).append(true).open(d.join(name)).ok();
        let mut transcript = open("transcript.jsonl");
        let mut slides = open("slides.jsonl");
        let mut samples: u32 = 0;
        let mut last_header = Instant::now();
        let mut pcm: Vec<u8> = Vec::new();
        loop {
            let msg = rx.recv_timeout(Duration::from_secs(1));
            match msg {
                Ok(Msg::Audio(chunk)) => {
                    pcm.clear();
                    for x in chunk {
                        let v = (x.clamp(-1.0, 1.0) * 32767.0) as i16;
                        pcm.extend_from_slice(&v.to_le_bytes());
                    }
                    if wav.write_all(&pcm).is_ok() {
                        samples = samples.saturating_add((pcm.len() / 2) as u32);
                    }
                }
                Ok(Msg::Line(file, v)) => {
                    let f = if file == "transcript" { transcript.as_mut() } else { slides.as_mut() };
                    if let Some(f) = f {
                        let _ = writeln!(f, "{}", v);
                    }
                }
                Ok(Msg::Stop) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    let _ = fix_header(&mut wav, samples);
                    return;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            }
            if last_header.elapsed() > Duration::from_secs(5) {
                last_header = Instant::now();
                let _ = fix_header(&mut wav, samples);
            }
        }
    });
    *SESSION.lock().unwrap() = Some(Session { tx, started: Instant::now(), start_sample });
    Ok(dir)
}

pub fn stop() {
    if let Some(s) = SESSION.lock().unwrap().take() {
        let _ = s.tx.send(Msg::Stop);
    }
}

pub fn audio(chunk: &[f32]) {
    if let Some(s) = SESSION.lock().unwrap().as_ref() {
        let _ = s.tx.send(Msg::Audio(chunk.to_vec()));
    }
}

/// A final transcript; `end_sample` is the absolute sample where it ends.
pub fn transcript(end_sample: u64, text: &str) {
    if let Some(s) = SESSION.lock().unwrap().as_ref() {
        let t = end_sample.saturating_sub(s.start_sample) as f64 / TARGET_SR as f64;
        let _ = s.tx.send(Msg::Line("transcript", json!({ "t": (t * 100.0).round() / 100.0, "text": text })));
    }
}

pub fn slide(kind: &str, title: &str, body: &str, sub: &str) {
    if let Some(s) = SESSION.lock().unwrap().as_ref() {
        let t = s.started.elapsed().as_secs_f64();
        let _ = s.tx.send(Msg::Line(
            "slides",
            json!({ "t": (t * 100.0).round() / 100.0, "kind": kind, "title": title, "body": body, "sub": sub }),
        ));
    }
}

fn write_header(f: &mut File, samples: u32) -> std::io::Result<()> {
    let data = samples * 2;
    let sr = TARGET_SR as u32;
    let mut h = Vec::with_capacity(44);
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&(36 + data).to_le_bytes());
    h.extend_from_slice(b"WAVEfmt ");
    h.extend_from_slice(&16u32.to_le_bytes());
    h.extend_from_slice(&1u16.to_le_bytes()); // PCM
    h.extend_from_slice(&1u16.to_le_bytes()); // mono
    h.extend_from_slice(&sr.to_le_bytes());
    h.extend_from_slice(&(sr * 2).to_le_bytes());
    h.extend_from_slice(&2u16.to_le_bytes());
    h.extend_from_slice(&16u16.to_le_bytes());
    h.extend_from_slice(b"data");
    h.extend_from_slice(&data.to_le_bytes());
    f.write_all(&h)
}

fn fix_header(f: &mut File, samples: u32) -> std::io::Result<()> {
    let end = f.stream_position()?;
    f.seek(SeekFrom::Start(0))?;
    write_header(f, samples)?;
    f.seek(SeekFrom::Start(end))?;
    f.flush()
}

/// Local-time-free folder name from the UTC clock: 2026-10-11_14-05-33.
fn stamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!(
        "{:04}-{:02}-{:02}_{:02}-{:02}-{:02}",
        y, m, d, rem / 3600, (rem % 3600) / 60, rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_a_valid_wav_and_lines() {
        let root = std::env::temp_dir().join(format!("agenthsp-session-test-{}", std::process::id()));
        let dir = start(root.clone(), 1000).unwrap();
        audio(&vec![0.5; 16000]);
        transcript(1000 + 8000, "John 3 16");
        slide("verse", "John 3:16", "For God so loved", "KJV");
        stop();
        std::thread::sleep(Duration::from_millis(300));
        let wav = std::fs::read(dir.join("audio.wav")).unwrap();
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 32000);
        assert_eq!(wav.len(), 44 + 32000);
        let tr = std::fs::read_to_string(dir.join("transcript.jsonl")).unwrap();
        assert!(tr.contains("\"t\":0.5") && tr.contains("John 3 16"), "{}", tr);
        assert!(std::fs::read_to_string(dir.join("slides.jsonl")).unwrap().contains("John 3:16"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stamp_looks_like_a_date() {
        let s = stamp();
        assert_eq!(s.len(), 19);
        assert!(s.starts_with("20"));
    }
}
