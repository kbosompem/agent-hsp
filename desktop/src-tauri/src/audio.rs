use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use serde_json::json;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub const TARGET_SR: usize = 16000;
const MAX_RING: usize = 60 * TARGET_SR;
const MAX_SEGMENT: usize = 25 * TARGET_SR;

pub struct ListenState {
    pub running: Arc<AtomicBool>,
    pub generation: Arc<AtomicUsize>,
    pub pcm: Arc<Mutex<Vec<f32>>>,
    pub total: Arc<AtomicU64>,
    pub level: Arc<Mutex<f32>>,
    pub floor: Arc<Mutex<f32>>,
    pub ctx: Arc<Mutex<Option<WhisperContext>>>,
    pub ctx_model: Arc<Mutex<String>>,
}

impl ListenState {
    pub fn new() -> ListenState {
        ListenState {
            running: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(AtomicUsize::new(0)),
            pcm: Arc::new(Mutex::new(Vec::new())),
            total: Arc::new(AtomicU64::new(0)),
            level: Arc::new(Mutex::new(0.0)),
            floor: Arc::new(Mutex::new(0.002)),
            ctx: Arc::new(Mutex::new(None)),
            ctx_model: Arc::new(Mutex::new(String::new())),
        }
    }
}

pub fn model_file(app: &AppHandle, model: &str) -> std::path::PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("models");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(format!("ggml-{}.bin", model))
}

pub fn download_model(app: AppHandle, model: String) {
    std::thread::spawn(move || {
        let path = model_file(&app, &model);
        if path.exists() {
            let _ = app.emit("model-ready", &model);
            return;
        }
        let url = format!(
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{}.bin",
            model
        );
        let _ = app.emit(
            "model-progress",
            json!({ "status": "downloading", "model": model }),
        );
        match ureq::get(&url).call() {
            Ok(resp) => {
                let total = resp
                    .header("content-length")
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(0);
                let mut reader = resp.into_reader();
                let tmp = path.with_extension("part");
                let file = std::fs::File::create(&tmp);
                if file.is_err() {
                    let _ = app.emit(
                        "model-progress",
                        json!({ "status": "error", "error": "cannot write model file" }),
                    );
                    return;
                }
                let mut file = file.unwrap();
                let mut buf = [0u8; 65536];
                let mut done = 0usize;
                let mut failed = false;
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if file.write_all(&buf[..n]).is_err() {
                                failed = true;
                                break;
                            }
                            done += n;
                            if total > 0 && done % (4 * 1024 * 1024) < n {
                                let _ = app.emit(
                                    "model-progress",
                                    json!({ "status": "progress", "loaded": done, "total": total }),
                                );
                            }
                        }
                        Err(_) => {
                            failed = true;
                            break;
                        }
                    }
                }
                if failed || std::fs::rename(&tmp, &path).is_err() {
                    let _ = app.emit(
                        "model-progress",
                        json!({ "status": "error", "error": "download failed" }),
                    );
                } else {
                    let _ = app.emit("model-ready", &model);
                }
            }
            Err(e) => {
                let _ = app.emit(
                    "model-progress",
                    json!({ "status": "error", "error": e.to_string() }),
                );
            }
        }
    });
}

fn rms_of(buf: &[f32]) -> f32 {
    if buf.is_empty() {
        return 0.0;
    }
    let s: f32 = buf.iter().map(|x| x * x).sum();
    (s / buf.len() as f32).sqrt()
}

fn resample_to_16k(data: &[f32], sr: usize) -> Vec<f32> {
    if sr == TARGET_SR {
        return data.to_vec();
    }
    let ratio = TARGET_SR as f32 / sr as f32;
    let n = ((data.len() as f32) * ratio) as usize;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let x = i as f32 / ratio;
        let i0 = x as usize;
        let i1 = std::cmp::min(i0 + 1, data.len() - 1);
        let f = x - i0 as f32;
        out.push(data[i0] * (1.0 - f) + data[i1] * f);
    }
    out
}

fn run_whisper(ctx: &WhisperContext, samples: &[f32]) -> (String, usize) {
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_translate(false);
    params.set_no_context(true);
    params.set_suppress_blank(true);
    params.set_print_progress(false);
    params.set_print_special(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_initial_prompt(BIBLE_VOCAB_PROMPT);
    let mut state = match ctx.create_state() {
        Ok(s) => s,
        Err(_) => return (String::new(), 0),
    };
    let t0 = std::time::Instant::now();
    if state.full(params, samples).is_err() {
        return (String::new(), 0);
    }
    let ms = t0.elapsed().as_millis() as usize;
    let n = state.full_n_segments().unwrap_or(0);
    let text: Vec<String> = (0..n)
        .filter_map(|i| state.full_get_segment_text(i).ok())
        .map(|s| s.to_string())
        .collect();
    (text.join(" ").trim().to_string(), ms)
}

const BIBLE_VOCAB_PROMPT: &str = "Bible reading. Genesis, Exodus, Leviticus, Numbers, Deuteronomy, Joshua, Judges, Ruth, Samuel, Kings, Chronicles, Ezra, Nehemiah, Esther, Job, Psalms, Proverbs, Ecclesiastes, Isaiah, Jeremiah, Lamentations, Ezekiel, Daniel, Hosea, Joel, Amos, Obadiah, Jonah, Micah, Nahum, Habakkuk, Zephaniah, Haggai, Zechariah, Malachi, Matthew, Mark, Luke, John, Acts, Romans, Corinthians, Galatians, Ephesians, Philippians, Colossians, Thessalonians, Timothy, Titus, Philemon, Hebrews, James, Peter, Jude, Revelation. Deuteronomy chapter 1. Micah chapter 3 verse 5.";

fn spawn_capture(
    app: AppHandle,
    device_name: Option<String>,
    shared: Arc<ListenState>,
    gen: usize,
) {
    std::thread::spawn(move || {
        let host = cpal::default_host();
        let device = match device_name.as_deref() {
            Some(n) if !n.is_empty() => host
                .input_devices()
                .ok()
                .and_then(|mut ds| {
                    ds.find(|d| d.name().map(|dn| dn == n).unwrap_or(false))
                }),
            _ => host.default_input_device(),
        };
        let device = match device {
            Some(d) => d,
            None => {
                let _ = app.emit("listen-status", "No input device found.");
                return;
            }
        };
        let name = device.name().unwrap_or_else(|_| "input".into());
        let cfg = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit("listen-status", format!("Config error: {}", e));
                return;
            }
        };
        let sr = cfg.sample_rate().0 as usize;
        let pcm = shared.pcm.clone();
        let level = shared.level.clone();
        let total = shared.total.clone();
        let err_fn = move |e| {
            let _ = e;
        };
        let push = move |data: &[f32]| {
            let chunk = resample_to_16k(data, sr);
            let rms = rms_of(&chunk);
            *level.lock().unwrap() = rms;
            {
                let mut buf = pcm.lock().unwrap();
                buf.extend_from_slice(&chunk);
                if buf.len() > MAX_RING {
                    let cut = buf.len() - MAX_RING;
                    buf.drain(0..cut);
                }
            }
            total.fetch_add(chunk.len() as u64, Ordering::SeqCst);
        };
        let stream = match cfg.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &cfg.clone().into(),
                move |d: &[f32], _| push(d),
                err_fn,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &cfg.clone().into(),
                move |d: &[i16], _| {
                    let f: Vec<f32> = d.iter().map(|x| *x as f32 / 32768.0).collect();
                    push(&f);
                },
                err_fn,
                None,
            ),
            _ => {
                let _ = app.emit("listen-status", "Unsupported sample format.");
                return;
            }
        };
        match stream {
            Ok(s) => {
                if s.play().is_err() {
                    let _ = app.emit("listen-status", "Could not start capture.");
                    return;
                }
                let _ = app.emit("listen-status", format!("Capturing from {}", name));
                loop {
                    if !shared.running.load(Ordering::SeqCst)
                        || shared.generation.load(Ordering::SeqCst) != gen
                    {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
            Err(e) => {
                let _ = app.emit("listen-status", format!("Capture error: {}", e));
            }
        }
    });
}

#[derive(Serialize, Clone)]
struct TranscriptEvent {
    text: String,
    ms: usize,
}

fn spawn_segmenter(app: AppHandle, shared: Arc<ListenState>, gen: usize) {
    std::thread::spawn(move || {
        let mut in_speech = false;
        let mut silence_ms = 0usize;
        let mut seg_start_abs: Option<u64> = None;
        let mut last_level_emit = 0u64;
        loop {
            if !shared.running.load(Ordering::SeqCst)
                || shared.generation.load(Ordering::SeqCst) != gen
            {
                break;
            }
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                std::thread::sleep(std::time::Duration::from_millis(200));
                let (tail_rms, plen_rel, total_abs) = {
                    let buf = shared.pcm.lock().unwrap();
                    let total_now = shared.total.load(Ordering::SeqCst);
                    if buf.len() < TARGET_SR {
                        (0.0f32, 0usize, total_now)
                    } else {
                        (
                            rms_of(&buf[buf.len() - TARGET_SR / 2..]),
                            buf.len(),
                            total_now,
                        )
                    }
                };
                if plen_rel == 0 {
                    return;
                }
                let ring_start_abs = total_abs as usize - plen_rel;
                {
                    let mut floor = shared.floor.lock().unwrap();
                    let threshold_now = (*floor * 3.0).max(0.0035);
                    if tail_rms < *floor {
                        *floor = tail_rms;
                    } else if tail_rms <= threshold_now {
                        *floor = *floor * 0.999 + tail_rms * 0.001;
                    }
                }
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64;
                if now_ms - last_level_emit > 300 {
                    last_level_emit = now_ms;
                    let _ = app.emit("level", tail_rms);
                }
                let floor = *shared.floor.lock().unwrap();
                let threshold = (floor * 3.0).max(0.0035);
                let voiced = tail_rms > threshold;
                if voiced {
                    silence_ms = 0;
                    if !in_speech {
                        in_speech = true;
                        seg_start_abs = Some(
                            (total_abs as usize).saturating_sub(TARGET_SR / 2) as u64,
                        );
                    }
                    if let Some(ss) = seg_start_abs {
                        if total_abs as usize - ss as usize >= MAX_SEGMENT {
                            let start_rel =
                                ((ss as usize).max(ring_start_abs) - ring_start_abs).min(plen_rel);
                            let seg = {
                                let buf = shared.pcm.lock().unwrap();
                                let s = start_rel.min(buf.len());
                                buf[s..].to_vec()
                            };
                            seg_start_abs = Some(total_abs);
                            finalize(&app, &shared, seg);
                        }
                    }
                } else if in_speech {
                    silence_ms += 200;
                    if silence_ms >= 1000 {
                        if let Some(ss) = seg_start_abs {
                            let start_rel = ((ss as usize).max(ring_start_abs) - ring_start_abs)
                                .min(plen_rel);
                            let seg = {
                                let buf = shared.pcm.lock().unwrap();
                                let s = start_rel.min(buf.len());
                                buf[s..].to_vec()
                            };
                            if seg.len() >= TARGET_SR / 2 {
                                finalize(&app, &shared, seg);
                            }
                        }
                        in_speech = false;
                        silence_ms = 0;
                        seg_start_abs = None;
                    }
                }
            }));
            if result.is_err() {
                let _ = app.emit(
                    "listen-status",
                    "Recovered from an internal audio error; still listening.",
                );
            }
        }
    });
}

fn finalize(app: &AppHandle, shared: &Arc<ListenState>, seg: Vec<f32>) {
    let guard = shared.ctx.lock().unwrap();
    if let Some(ctx) = guard.as_ref() {
        let (text, ms) = run_whisper(ctx, &seg);
        if !text.is_empty() {
            let _ = app.emit(
                "transcript",
                TranscriptEvent {
                    text: text,
                    ms: ms,
                },
            );
        }
    }
}

#[tauri::command]
pub fn list_audio_inputs() -> Vec<String> {
    let host = cpal::default_host();
    host.input_devices()
        .map(|ds| ds.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}

#[tauri::command]
pub fn ensure_model(app: AppHandle, model: String) {
    download_model(app, model);
}

#[tauri::command]
pub fn start_listening(
    app: AppHandle,
    state: tauri::State<'_, ListenState>,
    device: Option<String>,
    model: String,
) -> Result<String, String> {
    if state.running.load(Ordering::SeqCst) {
        return Ok("already".to_string());
    }
    let mpath = model_file(&app, &model);
    if !mpath.exists() {
        return Err("Model not downloaded yet. Click Load model first.".to_string());
    }
    {
        let mut guard = state.ctx.lock().unwrap();
        let same = *state.ctx_model.lock().unwrap() == model;
        if guard.is_none() || !same {
            let ctx = WhisperContext::new_with_params(
                mpath.to_str().ok_or("bad model path")?,
                WhisperContextParameters::default(),
            )
            .map_err(|e| e.to_string())?;
            *guard = Some(ctx);
            *state.ctx_model.lock().unwrap() = model.clone();
        }
    }
    state.pcm.lock().unwrap().clear();
    state.running.store(true, Ordering::SeqCst);
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let shared = Arc::new(ListenState {
        running: state.running.clone(),
        generation: state.generation.clone(),
        pcm: state.pcm.clone(),
        total: state.total.clone(),
        level: state.level.clone(),
        floor: state.floor.clone(),
        ctx: state.ctx.clone(),
        ctx_model: state.ctx_model.clone(),
    });
    spawn_capture(app.clone(), device, shared.clone(), gen);
    spawn_segmenter(app, shared, gen);
    Ok("started".to_string())
}

#[tauri::command]
pub fn stop_listening(state: tauri::State<'_, ListenState>) {
    state.running.store(false, Ordering::SeqCst);
    state.generation.fetch_add(1, Ordering::SeqCst);
}
