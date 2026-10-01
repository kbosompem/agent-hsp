// Verse latency harness. Replays a fixture WAV through the app's segmenter
// and whisper in simulated real time: while whisper runs, audio keeps
// "arriving", exactly as it would from a live microphone.
//
//   cargo run --release --example latency -- <model.bin> <fixture.json> [legacy|streaming] [--no-actx]
//
// Reports, per expected reference, the seconds between the speaker finishing
// the reference and the app knowing which verse to show. The operator-console
// fire delay (600 ms) comes on top of this.

use amc_preso_lib::audio::{run_whisper_opts, TARGET_SR};
use amc_preso_lib::segmenter::{rms_of, Job, SegConfig, Segmenter};
use std::collections::{HashMap, HashSet};
use whisper_rs::{WhisperContext, WhisperContextParameters};

fn read_wav16(path: &str) -> Vec<f32> {
    let b = std::fs::read(path).expect("read wav");
    let mut i = 12;
    while i + 8 <= b.len() {
        let id = &b[i..i + 4];
        let n = u32::from_le_bytes([b[i + 4], b[i + 5], b[i + 6], b[i + 7]]) as usize;
        if id == b"data" {
            let d = &b[i + 8..(i + 8 + n).min(b.len())];
            return d
                .chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
                .collect();
        }
        i += 8 + n + (n & 1);
    }
    panic!("no data chunk");
}

fn drop_trailing_number(t: &str) -> String {
    const WORDS: &[&str] = &["zero","one","two","three","four","five","six","seven","eight","nine","ten",
        "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen",
        "twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety","hundred"];
    let trimmed = t.trim_end();
    let cut = trimmed.rfind(|c: char| c.is_whitespace()).map(|i| i + 1).unwrap_or(0);
    let last = trimmed[cut..].trim_end_matches(|c: char| ".,!?".contains(c));
    let last = last.trim_start_matches(|c: char| ",.:;-".contains(c));
    let numeric = !last.is_empty()
        && (last.chars().all(|c| c.is_ascii_digit() || ":.-".contains(c)) && last.chars().any(|c| c.is_ascii_digit())
            || WORDS.contains(&last.to_lowercase().as_str()));
    if numeric { trimmed[..cut].to_string() } else { t.to_string() }
}

/// Mirror of settleTail() in App.tsx.
fn settle_tail(t: &str) -> String {
    let mut s = drop_trailing_number(t);
    loop {
        let words: Vec<&str> = s.split_whitespace().collect();
        if words.len() < 2 {
            return s;
        }
        let last = words[words.len() - 1]
            .trim_matches(|c: char| ",.:;-!?".contains(c))
            .to_lowercase();
        if !["and", "to", "through", "thru", "until", "till"].contains(&last.as_str()) {
            return s;
        }
        let rest = words[..words.len() - 1].join(" ");
        let dropped = drop_trailing_number(&rest);
        if dropped.trim_end() == rest.trim_end() {
            return s;
        }
        s = dropped;
    }
}

fn norm(l: &str) -> String {
    l.to_lowercase().replace("psalms", "psalm")
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let model = &args[1];
    let fixture = &args[2];
    let mode = args.get(3).map(|s| s.as_str()).unwrap_or("streaming");
    let actx = !args.iter().any(|a| a == "--no-actx");
    let cfg = if mode == "legacy" { SegConfig::legacy() } else { SegConfig::streaming() };

    let meta: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(fixture).unwrap()).unwrap();
    let dir = std::path::Path::new(fixture).parent().unwrap();
    let audio = read_wav16(dir.join(meta["wav"].as_str().unwrap()).to_str().unwrap());
    let expected: Vec<(String, f64)> = meta["refs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["label"].as_str().unwrap().to_string(), r["spoken_end_s"].as_f64().unwrap()))
        .collect();

    preso_core::init_engine(None);
    let eng = preso_core::engine();
    let ctx = WhisperContext::new_with_params(model, WhisperContextParameters::default()).unwrap();
    let mut state = ctx.create_state().unwrap();

    let sr = TARGET_SR as u64;
    let mut seg = Segmenter::new(cfg, 0.002);
    let mut t: u64 = sr;
    let mut first: HashMap<String, (f64, &'static str)> = HashMap::new();
    let mut prev: HashSet<String> = HashSet::new();
    let mut prev_seg = u64::MAX;
    let (mut n_partial, mut n_final, mut whisper_ms) = (0usize, 0usize, 0usize);

    while (t as usize) < audio.len() {
        t += sr / 10;
        let end = (t as usize).min(audio.len());
        let tail = rms_of(&audio[end - TARGET_SR / 2..end]);
        let job = match seg.step(tail, t) {
            Some(j) => j,
            None => continue,
        };
        let (start, stop, s, partial) = match job {
            Job::Partial { start, end, seg } => (start, end, seg, true),
            Job::Final { start, end, seg } => (start, end, seg, false),
        };
        let samples = &audio[start as usize..(stop as usize).min(audio.len())];
        let (text, ms) = run_whisper_opts(&mut state, samples, partial, actx);
        whisper_ms += ms;
        if partial { n_partial += 1 } else { n_final += 1 }
        t += (ms as u64) * sr / 1000;
        let now = t as f64 / sr as f64;
        // Partials only act on chapter:verse hits; "John chapter 3" mid-sentence
        // is usually the front half of "John chapter 3 verse 16".
        // ...and ignore a trailing number: "John 3 1" may be "John 3 16" half-spoken.
        let settled = if partial { settle_tail(&text) } else { text.clone() };
        let labels: HashSet<String> = eng
            .lookup(&settled, None)
            .into_iter()
            .filter(|h| !partial || h.reference.as_ref().map_or(false, |r| r.verse.is_some()))
            .map(|h| h.label)
            .collect();
        // Same rule as the console: a partial hit must repeat in the next
        // partial of the same segment; a final hit counts at once.
        let accepted: Vec<String> = if partial {
            if s != prev_seg {
                prev.clear();
            }
            let a = labels.intersection(&prev).cloned().collect();
            prev = labels.clone();
            prev_seg = s;
            a
        } else {
            prev.clear();
            labels.iter().cloned().collect()
        };
        for l in accepted {
            first.entry(l).or_insert((now, if partial { "partial" } else { "final" }));
        }
        if std::env::var("VERBOSE").is_ok() {
            println!("{:7.2}s {} {:4}ms {:?} {:?}", now, if partial { "P" } else { "F" }, ms, text, labels);
        }
    }

    println!("mode={} audio_ctx={} partials={} finals={} whisper_total={}ms", mode, actx, n_partial, n_final, whisper_ms);
    let mut lat = Vec::new();
    for (label, spoken) in &expected {
        let hit = first.iter().find(|(k, _)| norm(k) == norm(label));
        match hit {
            Some((_, (at, via))) => {
                let l = at - spoken;
                lat.push(l);
                println!("  {:18} {:+6.2}s  via {}", label, l, via);
            }
            None => println!("  {:18}   MISSED", label),
        }
    }
    let exp: HashSet<String> = expected.iter().map(|(l, _)| norm(l)).collect();
    for k in first.keys() {
        if !exp.contains(&norm(k)) {
            println!("  extra (false hit): {}", k);
        }
    }
    if !lat.is_empty() {
        lat.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mean = lat.iter().sum::<f64>() / lat.len() as f64;
        println!("  found {}/{}  mean {:.2}s  median {:.2}s  worst {:.2}s",
            lat.len(), expected.len(), mean, lat[lat.len() / 2], lat[lat.len() - 1]);
    }
}
