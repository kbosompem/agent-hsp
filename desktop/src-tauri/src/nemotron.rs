// NVIDIA Nemotron 3.5 streaming speech model, run locally through sherpa-onnx
// (optional `nemotron` feature). It transcribes word by word as audio arrives,
// so a reference reaches the console well under a second after it is spoken,
// against 2 to 3 s for whisper's re-transcribe-every-half-second loop
// (measured on real sermons: scripts/stt-eval/live_delay.py).
//
// Same events as the whisper path, so the console does not care which engine
// runs: "transcript-partial" whenever the open sentence changes, "transcript"
// when it ends, plus "stt-health" / "stt-alive" and session recording.
//
// Sentence ends are ours, not sherpa's: a sentence closes after SILENCE_S
// without a new word, or is cut at its widest pause after MAX_UTT_S. After a
// close we start a fresh stream primed with the last PREROLL_S of audio,
// because sherpa's own reset drops the first word of the next sentence.

use serde::Serialize;
use sherpa_onnx::{OnlineRecognizer, OnlineRecognizerConfig, OnlineStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

use crate::audio::{slice_abs, ListenState, TARGET_SR};

const SILENCE_S: f32 = 1.0;
const MAX_UTT_S: f32 = 15.0;
const PREROLL_S: f32 = 1.0;
const STEP_MS: u64 = 100;

/// The 66 books and spoken forms ("First Corinthians", "Psalm"), boosted so
/// accented book names are heard as books.
const HOTWORDS: &str = include_str!("../../../scripts/stt-eval/bible-hotwords.txt");

/// Model variants by chunk size: smaller chunks show words sooner but cost
/// more compute (160 ms: 37% of real time on 2 cores of an M3 Pro).
pub fn model_dir_name(model: &str) -> Option<&'static str> {
    Some(match model {
        "nemotron-160" => "sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-160ms-int8-2026-06-11",
        "nemotron-560" => "sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11",
        _ => return None,
    })
}

pub fn is_nemotron(model: &str) -> bool {
    model_dir_name(model).is_some()
}

pub fn download_url(model: &str) -> Option<String> {
    model_dir_name(model).map(|d| {
        format!("https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/{}.tar.bz2", d)
    })
}

fn pick(dir: &Path, prefix: &str) -> Option<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().to_string()))
        .filter(|n| n.starts_with(prefix) && n.ends_with(".onnx"))
        .collect();
    names.sort();
    names.first().map(|n| dir.join(n).to_string_lossy().to_string())
}

pub fn model_ready(dir: &Path) -> bool {
    pick(dir, "encoder").is_some() && pick(dir, "decoder").is_some() && pick(dir, "joiner").is_some()
        && dir.join("tokens.txt").exists()
}

pub fn create_recognizer(dir: &Path) -> Result<OnlineRecognizer, String> {
    let mut c = OnlineRecognizerConfig::default();
    c.model_config.transducer.encoder = pick(dir, "encoder");
    c.model_config.transducer.decoder = pick(dir, "decoder");
    c.model_config.transducer.joiner = pick(dir, "joiner");
    c.model_config.tokens = Some(dir.join("tokens.txt").to_string_lossy().to_string());
    c.model_config.num_threads = 2;
    c.model_config.provider = Some("cpu".into());
    c.model_config.modeling_unit = Some("bpe".into());
    c.model_config.bpe_vocab = Some(dir.join("bpe.vocab").to_string_lossy().to_string());
    c.decoding_method = Some("modified_beam_search".into());
    c.max_active_paths = 4;
    c.enable_endpoint = false;
    c.hotwords_buf = Some(HOTWORDS.as_bytes().to_vec());
    c.hotwords_score = 1.5;
    OnlineRecognizer::create(&c).ok_or_else(|| "Could not load the Nemotron speech model.".to_string())
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

/// sherpa's BPE pieces ("▁First", "▁Co", "rin") -> plain text.
fn clean(pieces: &[String]) -> String {
    let s: String = pieces
        .iter()
        .filter(|t| !(t.starts_with('<') && t.ends_with('>')))
        .map(|t| t.as_str())
        .collect();
    s.replace('▁', " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

fn new_stream(rec: &OnlineRecognizer) -> OnlineStream {
    let s = rec.create_stream();
    s.set_option("language", "en");
    s
}

/// What one step of the engine produced.
pub enum Out {
    /// The open sentence so far changed.
    Partial { text: String, seg: u64 },
    /// A sentence closed; `end_abs` is the absolute sample of its last word.
    Final { text: String, seg: u64, end_abs: u64 },
}

/// The streaming loop without Tauri: feed it the absolute audio position and
/// a way to read samples, and it returns partials and finals. Used by the app
/// thread below and by examples/latency.rs, so both run the same code.
pub struct Engine {
    rec: Arc<OnlineRecognizer>,
    stream: OnlineStream,
    begin: u64,
    fed: u64,
    cut: usize,
    last_text: String,
    seg: u64,
}

impl Engine {
    pub fn new(rec: Arc<OnlineRecognizer>, start: u64) -> Engine {
        let stream = new_stream(&rec);
        Engine { rec, stream, begin: start, fed: start, cut: 0, last_text: String::new(), seg: 0 }
    }

    /// Absolute sample the engine has consumed up to.
    pub fn fed(&self) -> u64 {
        self.fed
    }

    fn restart(&mut self) {
        let pre = (PREROLL_S * TARGET_SR as f32) as u64;
        self.begin = self.fed.saturating_sub(pre).max(self.begin);
        self.stream = new_stream(&self.rec);
        // The preroll is re-read on the next step.
        self.fed = self.begin;
        self.cut = 0;
    }

    /// Feed audio up to `total` (absolute samples). `read(a, b)` returns the
    /// samples in [a, b); `oldest` is the first sample still readable.
    /// Returns what changed and whether the model decoded anything.
    pub fn step(&mut self, total: u64, oldest: u64, read: impl Fn(u64, u64) -> Vec<f32>) -> (Vec<Out>, bool) {
        let mut out = Vec::new();
        if total <= self.fed {
            return (out, false);
        }
        if self.fed < oldest {
            self.fed = oldest;
        }
        let samples = read(self.fed, total);
        self.stream.accept_waveform(TARGET_SR as i32, &samples);
        self.fed = total;
        let mut stepped = false;
        while self.rec.is_ready(&self.stream) {
            self.rec.decode(&self.stream);
            stepped = true;
        }
        if !stepped {
            return (out, false);
        }
        let r = match self.rec.get_result(&self.stream) {
            Some(r) => r,
            None => return (out, true),
        };
        let sr = TARGET_SR as f32;
        let stamps = r.timestamps.clone().unwrap_or_default();
        let pairs: Vec<(String, f32)> = r
            .tokens
            .iter()
            .cloned()
            .zip(stamps.iter().cloned())
            .filter(|(t, _)| !(t.starts_with('<') && t.ends_with('>')))
            .collect();
        if self.cut > pairs.len() {
            self.cut = pairs.len();
        }
        let cut = self.cut;
        let now_s = (self.fed - self.begin) as f32 / sr;
        let text = clean(&pairs[cut..].iter().map(|p| p.0.clone()).collect::<Vec<_>>());
        if !text.is_empty() && text != self.last_text {
            out.push(Out::Partial { text: text.clone(), seg: self.seg });
            self.last_text = text;
        }
        if pairs.len() > cut {
            let last_word = pairs[pairs.len() - 1].1;
            let endpoint = now_s - last_word >= SILENCE_S;
            let forced = last_word - pairs[cut].1 >= MAX_UTT_S;
            if endpoint || forced {
                let mut j = pairs.len();
                if forced && !endpoint {
                    // Cut at the widest gap in the second half.
                    let lo = (cut + (pairs.len() - cut) / 2).max(cut + 1);
                    j = (lo..pairs.len())
                        .max_by(|&a, &b| {
                            (pairs[a].1 - pairs[a - 1].1)
                                .partial_cmp(&(pairs[b].1 - pairs[b - 1].1))
                                .unwrap_or(std::cmp::Ordering::Equal)
                        })
                        .unwrap_or(pairs.len());
                }
                let final_text = clean(&pairs[cut..j].iter().map(|p| p.0.clone()).collect::<Vec<_>>());
                if !final_text.is_empty() {
                    let end_abs = self.begin + (pairs[j - 1].1 * sr) as u64;
                    out.push(Out::Final { text: final_text, seg: self.seg, end_abs });
                }
                self.seg += 1;
                self.last_text.clear();
                if endpoint {
                    self.restart();
                } else {
                    self.cut = j;
                }
            }
        } else if now_s > 30.0 {
            // Long silence: start clean so the stream does not grow forever.
            self.restart();
        }
        (out, true)
    }
}

/// Runs until listening stops or the generation changes. `rec` is created by
/// start_listening so a load error is reported there.
pub fn spawn(app: AppHandle, shared: Arc<ListenState>, session_gen: usize, rec: Arc<OnlineRecognizer>) {
    std::thread::spawn(move || {
        let mut eng = Engine::new(rec, shared.total.load(Ordering::SeqCst));
        let mut last_alive = std::time::Instant::now();
        let mut last_level = std::time::Instant::now();
        loop {
            if !shared.running.load(Ordering::SeqCst) || shared.generation.load(Ordering::SeqCst) != session_gen {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(STEP_MS));
            if last_alive.elapsed().as_millis() >= 1000 {
                last_alive = std::time::Instant::now();
                let _ = app.emit("stt-alive", ());
            }
            if last_level.elapsed().as_millis() > 300 {
                last_level = std::time::Instant::now();
                let _ = app.emit("level", *shared.level.lock().unwrap());
            }
            let total = shared.total.load(Ordering::SeqCst);
            let oldest = total.saturating_sub(shared.pcm.lock().unwrap().len() as u64);
            let t0 = std::time::Instant::now();
            let (outs, decoded) = eng.step(total, oldest, |a, b| {
                let buf = shared.pcm.lock().unwrap();
                let now = shared.total.load(Ordering::SeqCst);
                slice_abs(&buf, now, a, b)
            });
            let ms = t0.elapsed().as_millis() as usize;
            if decoded {
                let lag_s = shared.total.load(Ordering::SeqCst).saturating_sub(eng.fed()) as f32 / TARGET_SR as f32;
                let _ = app.emit("stt-health", SttHealth { lag_s, ms, error: None });
            }
            for o in outs {
                match o {
                    Out::Partial { text, seg } => {
                        let _ = app.emit("transcript-partial", TranscriptEvent { text, ms, seg });
                    }
                    Out::Final { text, seg, end_abs } => {
                        crate::session::transcript(end_abs, &text);
                        let _ = app.emit("transcript", TranscriptEvent { text, ms, seg });
                    }
                }
            }
        }
    });
}

/// Download and unpack a Nemotron model into `models_dir` (uses the system
/// `tar`, present on macOS and Windows 10+). Reports progress like whisper's.
pub fn download(app: &AppHandle, model: &str, models_dir: &Path) -> Result<PathBuf, String> {
    let name = model_dir_name(model).ok_or("unknown model")?;
    let dir = models_dir.join(name);
    if model_ready(&dir) {
        return Ok(dir);
    }
    let url = download_url(model).ok_or("unknown model")?;
    std::fs::create_dir_all(models_dir).map_err(|e| e.to_string())?;
    let archive = models_dir.join(format!("{}.tar.bz2", name));
    let resp = ureq::get(&url).call().map_err(|e| e.to_string())?;
    let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut f = std::fs::File::create(&archive).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 1 << 20];
    let mut got: u64 = 0;
    let mut last = std::time::Instant::now();
    loop {
        let n = std::io::Read::read(&mut reader, &mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut f, &buf[..n]).map_err(|e| e.to_string())?;
        got += n as u64;
        if last.elapsed().as_millis() > 500 {
            last = std::time::Instant::now();
            let _ = app.emit("model-progress", serde_json::json!({ "status": "progress", "loaded": got, "total": total }));
        }
    }
    drop(f);
    let _ = app.emit("model-progress", serde_json::json!({ "status": "unpacking" }));
    let ok = std::process::Command::new("tar")
        .arg("-xjf")
        .arg(&archive)
        .arg("-C")
        .arg(models_dir)
        .status()
        .map_err(|e| e.to_string())?
        .success();
    let _ = std::fs::remove_file(&archive);
    if !ok || !model_ready(&dir) {
        return Err("Could not unpack the Nemotron model.".into());
    }
    Ok(dir)
}
