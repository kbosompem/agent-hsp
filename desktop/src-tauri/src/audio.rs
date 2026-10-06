use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use serde_json::json;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState};

use crate::segmenter::{rms_of, Job, SegConfig, Segmenter};

pub const TARGET_SR: usize = 16000;
const MAX_RING: usize = 60 * TARGET_SR;

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

/// Transcribe 16 kHz mono samples. `partial` trades a little accuracy for
/// speed: the encoder only looks at as much audio as was passed in.
pub fn run_whisper(state: &mut WhisperState, samples: &[f32], partial: bool) -> (String, usize) {
    run_whisper_opts(state, samples, partial, PARTIAL_AUDIO_CTX)
}

pub fn run_whisper_opts(
    state: &mut WhisperState,
    samples: &[f32],
    partial: bool,
    audio_ctx: bool,
) -> (String, usize) {
    run_whisper_checked(state, samples, partial, audio_ctx).unwrap_or((String::new(), 0))
}

/// Test hook for the lag warning: AGENTHSP_STT_FAULT=fail makes every whisper
/// call fail; AGENTHSP_STT_FAULT=slow:<ms> adds that much time to each call.
fn injected_fault() -> Result<(), String> {
    match std::env::var("AGENTHSP_STT_FAULT") {
        Ok(v) if v == "fail" => Err("test fault".to_string()),
        Ok(v) => {
            if let Some(ms) = v.strip_prefix("slow:").and_then(|n| n.parse::<u64>().ok()) {
                std::thread::sleep(std::time::Duration::from_millis(ms));
            }
            Ok(())
        }
        Err(_) => Ok(()),
    }
}

/// Like `run_whisper_opts`, but reports a failed whisper call instead of
/// returning empty text.
pub fn run_whisper_checked(
    state: &mut WhisperState,
    samples: &[f32],
    partial: bool,
    audio_ctx: bool,
) -> Result<(String, usize), String> {
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
    if partial {
        params.set_single_segment(true);
        params.set_no_timestamps(true);
        // Speech runs at about 4 tokens a second. A cap well above that stops
        // a repetition loop from stalling partials for seconds at a time.
        let secs = samples.len() as f32 / TARGET_SR as f32;
        params.set_max_tokens((secs * 8.0) as i32 + 16);
        if audio_ctx {
            // 1500 encoder frames cover 30 s; size the window to the audio plus margin.
            let secs = samples.len() as f32 / TARGET_SR as f32;
            // Rounded to 64 frames: Metal kernels assert on unaligned row sizes.
            let frames = ((secs * 50.0) as i32 + 128 + 63) / 64 * 64;
            params.set_audio_ctx(frames.min(1500));
        }
    }
    let t0 = std::time::Instant::now();
    injected_fault()?;
    if let Err(e) = state.full(params, samples) {
        return Err(format!("speech model error: {}", e));
    }
    let ms = t0.elapsed().as_millis() as usize;
    let n = state.full_n_segments().unwrap_or(0);
    let text: Vec<String> = (0..n)
        .filter_map(|i| state.full_get_segment_text(i).ok())
        .map(|s| s.to_string())
        .collect();
    let text = text.join(" ").trim().to_string();
    if is_prompt_echo(&text) {
        return Ok((String::new(), ms));
    }
    Ok((text, ms))
}

pub const PARTIAL_AUDIO_CTX: bool = true;

const BIBLE_VOCAB_PROMPT: &str = "Bible reading. Genesis, Exodus, Leviticus, Numbers, Deuteronomy, Joshua, Judges, Ruth, Samuel, Kings, Chronicles, Ezra, Nehemiah, Esther, Job, Psalms, Proverbs, Ecclesiastes, Isaiah, Jeremiah, Lamentations, Ezekiel, Daniel, Hosea, Joel, Amos, Obadiah, Jonah, Micah, Nahum, Habakkuk, Zephaniah, Haggai, Zechariah, Malachi, Matthew, Mark, Luke, John, Acts, Romans, Corinthians, Galatians, Ephesians, Philippians, Colossians, Thessalonians, Timothy, Titus, Philemon, Hebrews, James, Peter, Jude, Revelation.";

/// Whisper repeats its prompt back during music or silence. A transcript
/// that is just a run of prompt words (book names) is dropped.
fn is_prompt_echo(text: &str) -> bool {
    let norm = |s: &str| -> Vec<String> {
        s.to_lowercase()
            .split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|w| !w.is_empty())
            .map(|w| w.to_string())
            .collect()
    };
    let prompt: std::collections::HashSet<String> = norm(BIBLE_VOCAB_PROMPT).into_iter().collect();
    // "[BLANK_AUDIO]" and similar tags are not speech
    let stripped: String = text.split('[').map(|p| p.split_once(']').map_or(p, |(_, r)| r)).collect();
    let words = norm(&stripped);
    words.len() >= 3 && words.iter().all(|w| prompt.contains(w))
}

/// Interleaved multi-channel audio to mono. Mixer feeds often carry the
/// pastor's mic on one channel and near-silence on the rest, so only
/// channels within 20 dB of the loudest are averaged; a plain average
/// would bury the voice.
pub fn downmix(data: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }
    let frames = data.len() / channels;
    let mut energy = vec![0f32; channels];
    for f in 0..frames {
        for c in 0..channels {
            let x = data[f * channels + c];
            energy[c] += x * x;
        }
    }
    let loudest = energy.iter().cloned().fold(0f32, f32::max);
    let active: Vec<usize> = (0..channels)
        .filter(|&c| loudest == 0.0 || energy[c] >= loudest * 0.01)
        .collect();
    let n = active.len() as f32;
    (0..frames)
        .map(|f| active.iter().map(|&c| data[f * channels + c]).sum::<f32>() / n)
        .collect()
}

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
        let channels = cfg.channels() as usize;
        let pcm = shared.pcm.clone();
        let level = shared.level.clone();
        let total = shared.total.clone();
        // macOS hands an app without microphone permission pure digital
        // silence, with no error. Track whether any non-zero sample arrives.
        let heard = Arc::new(AtomicBool::new(false));
        let heard_cb = heard.clone();
        let err_fn = move |e| {
            let _ = e;
        };
        let push = move |data: &[f32]| {
            if !heard_cb.load(Ordering::Relaxed) && data.iter().any(|x| *x != 0.0) {
                heard_cb.store(true, Ordering::Relaxed);
            }
            let mono = downmix(data, channels);
            let chunk = resample_to_16k(&mono, sr);
            let rms = rms_of(&chunk);
            *level.lock().unwrap() = rms;
            {
                // Count under the lock so readers see buffer and total agree.
                let mut buf = pcm.lock().unwrap();
                buf.extend_from_slice(&chunk);
                if buf.len() > MAX_RING {
                    let cut = buf.len() - MAX_RING;
                    buf.drain(0..cut);
                }
                total.fetch_add(chunk.len() as u64, Ordering::SeqCst);
            }
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
            cpal::SampleFormat::U16 => device.build_input_stream(
                &cfg.clone().into(),
                move |d: &[u16], _| {
                    let f: Vec<f32> = d.iter().map(|x| (*x as f32 - 32768.0) / 32768.0).collect();
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
                let started = std::time::Instant::now();
                let mut warned = false;
                loop {
                    if !shared.running.load(Ordering::SeqCst)
                        || shared.generation.load(Ordering::SeqCst) != gen
                    {
                        break;
                    }
                    if !warned && started.elapsed().as_secs() >= 3 && !heard.load(Ordering::Relaxed) {
                        warned = true;
                        let _ = app.emit(
                            "listen-status",
                            format!(
                                "No sound from {}. Allow Agent HSP in System Settings > Privacy & Security > Microphone, then press Listen again.",
                                name
                            ),
                        );
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
    seg: u64,
}

#[derive(Clone, serde::Serialize)]
struct SttHealth {
    lag_s: f32,
    ms: usize,
    error: Option<String>,
}

fn spawn_segmenter(app: AppHandle, shared: Arc<ListenState>, gen: usize, cfg: SegConfig) {
    std::thread::spawn(move || {
        // One whisper state per listening session; creating it per call costs
        // an allocation of the model's working buffers every time.
        let mut wstate = {
            let guard = shared.ctx.lock().unwrap();
            match guard.as_ref().map(|c| c.create_state()) {
                Some(Ok(s)) => s,
                _ => {
                    let _ = app.emit("listen-status", "Could not start the speech model.");
                    return;
                }
            }
        };
        let mut seg = Segmenter::new(cfg, *shared.floor.lock().unwrap());
        let mut last_level_emit = std::time::Instant::now();
        let mut last_alive_emit = std::time::Instant::now();
        loop {
            if !shared.running.load(Ordering::SeqCst)
                || shared.generation.load(Ordering::SeqCst) != gen
            {
                break;
            }
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                std::thread::sleep(std::time::Duration::from_millis(100));
                let (tail_rms, total_abs) = {
                    let buf = shared.pcm.lock().unwrap();
                    if buf.len() < TARGET_SR {
                        return;
                    }
                    (
                        rms_of(&buf[buf.len() - TARGET_SR / 2..]),
                        shared.total.load(Ordering::SeqCst),
                    )
                };
                if last_alive_emit.elapsed().as_millis() >= 1000 {
                    last_alive_emit = std::time::Instant::now();
                    let _ = app.emit("stt-alive", ());
                }
                if last_level_emit.elapsed().as_millis() > 300 {
                    last_level_emit = std::time::Instant::now();
                    let _ = app.emit("level", tail_rms);
                }
                let job = seg.step(tail_rms, total_abs);
                *shared.floor.lock().unwrap() = seg.floor;
                let (start, end, s, partial) = match job {
                    Some(Job::Partial { start, end, seg }) => (start, end, seg, true),
                    Some(Job::Final { start, end, seg }) => (start, end, seg, false),
                    None => return,
                };
                let samples = {
                    let buf = shared.pcm.lock().unwrap();
                    let total = shared.total.load(Ordering::SeqCst);
                    slice_abs(&buf, total, start, end)
                };
                let res = run_whisper_checked(&mut wstate, &samples, partial, PARTIAL_AUDIO_CTX);
                // The user may have pressed Stop while whisper was running.
                if !shared.running.load(Ordering::SeqCst)
                    || shared.generation.load(Ordering::SeqCst) != gen
                {
                    return;
                }
                // How far the audio just transcribed trails live audio, so the
                // console can warn the operator (issue 2).
                let lag_s = shared.total.load(Ordering::SeqCst).saturating_sub(end) as f32 / TARGET_SR as f32;
                let (text, ms) = match res {
                    Ok(r) => {
                        let _ = app.emit("stt-health", SttHealth { lag_s, ms: r.1, error: None });
                        r
                    }
                    Err(e) => {
                        eprintln!("whisper failed on samples {}..{}: {}", start, end, e);
                        let _ = app.emit("stt-health", SttHealth { lag_s, ms: 0, error: Some(e) });
                        return;
                    }
                };
                // Finals are sent even when empty so the console clears its live line.
                if partial && text.is_empty() {
                    return;
                }
                let ev = if partial { "transcript-partial" } else { "transcript" };
                let _ = app.emit(ev, TranscriptEvent { text, ms, seg: s });
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

/// Copy absolute sample range [start, end) out of a ring buffer whose last
/// sample is at absolute position `total`.
pub fn slice_abs(buf: &[f32], total: u64, start: u64, end: u64) -> Vec<f32> {
    let ring_start = total.saturating_sub(buf.len() as u64);
    let s = start.max(ring_start).saturating_sub(ring_start) as usize;
    let e = end.min(total).saturating_sub(ring_start) as usize;
    if s >= e || e > buf.len() {
        return Vec::new();
    }
    buf[s..e].to_vec()
}

#[cfg(test)]
mod tests {
    use super::{downmix, is_prompt_echo};

    #[test]
    fn downmix_keeps_a_one_sided_mixer_feed() {
        // Left channel carries the voice, right is silent.
        let data = [0.5, 0.0, -0.5, 0.0, 0.25, 0.0];
        assert_eq!(downmix(&data, 2), vec![0.5, -0.5, 0.25]);
    }

    #[test]
    fn downmix_averages_balanced_stereo() {
        let data = [0.4, 0.2, -0.4, -0.2];
        let m = downmix(&data, 2);
        assert!((m[0] - 0.3).abs() < 1e-6 && (m[1] + 0.3).abs() < 1e-6);
    }

    #[test]
    fn prompt_echo_is_dropped() {
        assert!(is_prompt_echo("Bible reading. Genesis, Exodus, Leviticus"));
        assert!(!is_prompt_echo("Turn to Genesis chapter 1"));
        assert!(!is_prompt_echo("Amen"));
        assert!(is_prompt_echo("Genesis, Exodus, Leviticus.  [BLANK_AUDIO]"));
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
    spawn_segmenter(app, shared, gen, SegConfig::streaming());
    Ok("started".to_string())
}

#[tauri::command]
pub fn stop_listening(state: tauri::State<'_, ListenState>) {
    state.running.store(false, Ordering::SeqCst);
    state.generation.fetch_add(1, Ordering::SeqCst);
}
