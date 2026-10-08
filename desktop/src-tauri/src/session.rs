// Records each service to disk (issue 12). Listen starts (or continues) a
// session folder; Stop finishes it:
//
//   <app data>/sessions/<YYYY-MM-DD_HH-MM local time>/
//     audio.wav         16-bit mono 16 kHz; header rewritten every few seconds,
//                       so a crash loses at most that much
//     transcript.txt    the raw transcript, "[mm:ss] text" per line (at Stop)
//     summary.md        title, outline, notes and verses shown (from the
//                       console, at Stop)
//     transcript.jsonl  {"t": seconds into audio.wav, "text": ...}
//     slides.jsonl      {"t": ..., "kind", "title", "body", "sub"}
//
// Continuing a session appends to the same audio.wav and transcripts, with
// times carrying on from where the audio stopped. One writer thread owns the
// files; callers only send messages, so the audio callback never waits on
// the disk.

use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::audio::TARGET_SR;

enum Msg {
    Audio(Vec<f32>),
    Line(&'static str, Value),
    Stop(Option<String>, Sender<()>),
}

struct Session {
    tx: Sender<Msg>,
    started: Instant,
    /// Seconds of audio already in audio.wav when this part began.
    offset_s: f64,
    /// Absolute sample position (ListenState.total) when this part began.
    start_sample: u64,
    dir: PathBuf,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// A folder name from the console's local time, e.g. "2026-10-11_10-02".
/// Anything but digits, letters, '-' and '_' is dropped.
pub fn safe_name(name: &str) -> String {
    let n: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(64).collect();
    if n.is_empty() { "session".into() } else { n }
}

/// Start a new session folder `root/name` (made unique if it exists), or
/// continue `continue_dir`. Stops any session already running.
pub fn start(root: &Path, name: &str, start_sample: u64, continue_dir: Option<&Path>) -> Result<PathBuf, String> {
    stop(None);
    let dir = match continue_dir {
        Some(d) if d.join("audio.wav").exists() && d.starts_with(root) => d.to_path_buf(),
        _ => {
            let base = safe_name(name);
            let mut dir = root.join(&base);
            let mut k = 2;
            while dir.exists() {
                dir = root.join(format!("{}_{}", base, k));
                k += 1;
            }
            dir
        }
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let wav_path = dir.join("audio.wav");
    let (mut wav, mut samples) = if wav_path.exists() {
        let mut f = OpenOptions::new().read(true).write(true).open(&wav_path).map_err(|e| e.to_string())?;
        let len = f.metadata().map_err(|e| e.to_string())?.len();
        let samples = (len.saturating_sub(44) / 2) as u32;
        f.seek(SeekFrom::Start(44 + samples as u64 * 2)).map_err(|e| e.to_string())?;
        (f, samples)
    } else {
        let mut f = File::create(&wav_path).map_err(|e| e.to_string())?;
        write_header(&mut f, 0).map_err(|e| e.to_string())?;
        (f, 0u32)
    };
    let offset_s = samples as f64 / TARGET_SR as f64;
    let (tx, rx) = channel::<Msg>();
    let d = dir.clone();
    std::thread::spawn(move || {
        let open = |name: &str| OpenOptions::new().create(true).append(true).open(d.join(name)).ok();
        let mut transcript = open("transcript.jsonl");
        let mut slides = open("slides.jsonl");
        let mut last_header = Instant::now();
        let mut pcm: Vec<u8> = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_secs(1)) {
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
                Ok(Msg::Stop(summary, done)) => {
                    let _ = fix_header(&mut wav, samples);
                    drop(transcript.take());
                    let _ = write_transcript_txt(&d);
                    if let Some(md) = summary {
                        let _ = std::fs::write(d.join("summary.md"), md);
                    }
                    let _ = done.send(());
                    return;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    let _ = fix_header(&mut wav, samples);
                    let _ = write_transcript_txt(&d);
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
    *SESSION.lock().unwrap() = Some(Session { tx, started: Instant::now(), offset_s, start_sample, dir: dir.clone() });
    Ok(dir)
}

/// Finish the session: complete audio.wav, write transcript.txt and (when
/// given) summary.md. Waits up to 3 s for the files. Returns the folder.
pub fn stop(summary: Option<String>) -> Option<PathBuf> {
    let s = SESSION.lock().unwrap().take()?;
    let (done_tx, done_rx) = channel();
    if s.tx.send(Msg::Stop(summary, done_tx)).is_ok() {
        let _ = done_rx.recv_timeout(Duration::from_secs(3));
    }
    Some(s.dir)
}

pub fn current_dir() -> Option<PathBuf> {
    SESSION.lock().unwrap().as_ref().map(|s| s.dir.clone())
}

pub fn audio(chunk: &[f32]) {
    if let Some(s) = SESSION.lock().unwrap().as_ref() {
        let _ = s.tx.send(Msg::Audio(chunk.to_vec()));
    }
}

/// A final transcript; `end_sample` is the absolute sample where it ends.
pub fn transcript(end_sample: u64, text: &str) {
    if let Some(s) = SESSION.lock().unwrap().as_ref() {
        let t = s.offset_s + end_sample.saturating_sub(s.start_sample) as f64 / TARGET_SR as f64;
        let _ = s.tx.send(Msg::Line("transcript", json!({ "t": (t * 100.0).round() / 100.0, "text": text })));
    }
}

pub fn slide(kind: &str, title: &str, body: &str, sub: &str) {
    if let Some(s) = SESSION.lock().unwrap().as_ref() {
        let t = s.offset_s + s.started.elapsed().as_secs_f64();
        let _ = s.tx.send(Msg::Line(
            "slides",
            json!({ "t": (t * 100.0).round() / 100.0, "kind": kind, "title": title, "body": body, "sub": sub }),
        ));
    }
}

/// transcript.txt from transcript.jsonl: "[mm:ss] text", one line each.
fn write_transcript_txt(dir: &Path) -> std::io::Result<()> {
    let mut raw = String::new();
    match File::open(dir.join("transcript.jsonl")) {
        Ok(mut f) => {
            f.read_to_string(&mut raw)?;
        }
        Err(_) => return Ok(()),
    }
    let mut out = String::new();
    for line in raw.lines() {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            let t = v["t"].as_f64().unwrap_or(0.0) as u64;
            let text = v["text"].as_str().unwrap_or("");
            out.push_str(&format!("[{:02}:{:02}:{:02}] {}\n", t / 3600, (t / 60) % 60, t % 60, text));
        }
    }
    std::fs::write(dir.join("transcript.txt"), out)
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

/// The newest session folder under `root`: (path, folder name, seconds since
/// it last changed, seconds of audio).
pub fn latest(root: &Path) -> Option<(PathBuf, String, u64, f64)> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for e in std::fs::read_dir(root).ok()?.flatten() {
        let p = e.path();
        let wav = p.join("audio.wav");
        if let Ok(m) = std::fs::metadata(&wav).and_then(|m| m.modified()) {
            if best.as_ref().map_or(true, |(t, _)| m > *t) {
                best = Some((m, p));
            }
        }
    }
    let (m, p) = best?;
    let age = m.elapsed().map(|d| d.as_secs()).unwrap_or(0);
    let len = std::fs::metadata(p.join("audio.wav")).map(|m| m.len()).unwrap_or(44);
    let secs = len.saturating_sub(44) as f64 / 2.0 / TARGET_SR as f64;
    let name = p.file_name()?.to_string_lossy().to_string();
    Some((p, name, age, secs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_continues_and_writes_three_files() {
        let root = std::env::temp_dir().join(format!("agenthsp-session-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let dir = start(&root, "2026-10-11_10-02", 1000, None).unwrap();
        audio(&vec![0.5; 16000]);
        transcript(1000 + 8000, "John 3 16");
        slide("verse", "John 3:16", "For God so loved", "KJV");
        assert_eq!(stop(Some("# Summary\n".into())).unwrap(), dir);
        let wav = std::fs::read(dir.join("audio.wav")).unwrap();
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 32000);
        assert!(std::fs::read_to_string(dir.join("transcript.txt")).unwrap().contains("[00:00:00] John 3 16"));
        assert_eq!(std::fs::read_to_string(dir.join("summary.md")).unwrap(), "# Summary\n");

        // Continue: audio appends, times carry on after the first second.
        let again = start(&root, "ignored", 50_000, Some(&dir)).unwrap();
        assert_eq!(again, dir);
        audio(&vec![0.25; 16000]);
        transcript(50_000 + 16000, "Romans 8 28");
        stop(None);
        let wav = std::fs::read(dir.join("audio.wav")).unwrap();
        assert_eq!(wav.len(), 44 + 64000);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 64000);
        let txt = std::fs::read_to_string(dir.join("transcript.txt")).unwrap();
        assert!(txt.contains("[00:00:02] Romans 8 28"), "{}", txt);

        // A new session with the same name gets its own folder.
        let other = start(&root, "2026-10-11_10-02", 0, None).unwrap();
        assert_ne!(other, dir);
        stop(None);
        let (newest, _, _, _) = latest(&root).unwrap();
        assert_eq!(newest, other);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn folder_names_are_safe() {
        assert_eq!(safe_name("2026-10-11_10-02"), "2026-10-11_10-02");
        assert_eq!(safe_name("../../etc"), "etc");
        assert_eq!(safe_name(""), "session");
    }
}
