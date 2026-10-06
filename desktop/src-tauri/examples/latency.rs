// Verse latency harness. Replays a fixture WAV through the app's segmenter
// and whisper in simulated real time: while whisper runs, audio keeps
// "arriving", exactly as it would from a live microphone.
//
//   cargo run --release --example latency -- <model.bin> <fixture.json> [legacy|streaming|finals] [--no-actx] [--dump out.json]
//
// "finals" is the streaming segmenter without partials: same final
// transcripts as the app, several times faster, but no latency figures.
// --dump writes the final transcripts and shown verses for the summary replay.
//
// Reports, per expected reference, the seconds between the speaker finishing
// the reference and the app knowing which verse to show. The operator-console
// fire delay (600 ms) comes on top of this.

use agent_hsp_lib::audio::{run_whisper_opts, TARGET_SR};
use agent_hsp_lib::segmenter::{rms_of, Job, SegConfig, Segmenter};
use std::collections::HashSet;
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
    let dump = args.iter().position(|a| a == "--dump").and_then(|i| args.get(i + 1)).cloned();
    let cfg = match mode {
        "legacy" => SegConfig::legacy(),
        "finals" => SegConfig { partials: false, ..SegConfig::streaming() },
        _ => SegConfig::streaming(),
    };

    let meta: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(fixture).unwrap()).unwrap();
    let dir = std::path::Path::new(fixture).parent().unwrap();
    let full = read_wav16(dir.join(meta["wav"].as_str().unwrap()).to_str().unwrap());
    // Optional "clip": [start_s, end_s] tests part of a long recording.
    // All times in the fixture and in the report are on the full recording.
    let (clip_start, clip_end) = match meta["clip"].as_array() {
        Some(c) => (c[0].as_f64().unwrap(), c[1].as_f64().unwrap()),
        None => (0.0, full.len() as f64 / TARGET_SR as f64),
    };
    let audio = &full[(clip_start * TARGET_SR as f64) as usize..((clip_end * TARGET_SR as f64) as usize).min(full.len())];
    let expected: Vec<Expected> = meta["refs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            let end = r["spoken_end_s"].as_f64().unwrap();
            Expected {
                label: r["label"].as_str().unwrap().to_string(),
                start: r["spoken_start_s"].as_f64().unwrap_or(end),
                end,
                scored: r["kind"].as_str().map_or(true, |k| k == "explicit"),
            }
        })
        .filter(|e| e.start >= clip_start && e.end <= clip_end)
        .collect();

    preso_core::init_engine(None);
    let mut live = preso_core::LiveLookup::new();
    // `nemotron` mode: the model argument is a Nemotron model folder and the
    // app's own streaming engine (nemotron::Engine) runs instead of whisper.
    let nemotron = mode == "nemotron";
    #[cfg(feature = "nemotron")]
    let mut nem = if nemotron {
        let rec = std::sync::Arc::new(agent_hsp_lib::nemotron::create_recognizer(std::path::Path::new(model)).unwrap());
        Some(agent_hsp_lib::nemotron::Engine::new(rec, 0))
    } else {
        None
    };
    #[cfg(not(feature = "nemotron"))]
    assert!(!nemotron, "build with --features nemotron for nemotron mode");
    let ctx = if nemotron { None } else { Some(WhisperContext::new_with_params(model, WhisperContextParameters::default()).unwrap()) };
    let mut state = ctx.as_ref().map(|c| c.create_state().unwrap());

    let sr = TARGET_SR as u64;
    let mut seg = Segmenter::new(cfg, 0.002);
    let mut t: u64 = sr;
    // Accepted detections after the console's rule: a label shown in the
    // last 180 s is not shown again.
    let mut shown: Vec<(f64, String, &'static str)> = Vec::new();
    let mut finals_log: Vec<serde_json::Value> = Vec::new();
    let mut partials_log: Vec<serde_json::Value> = Vec::new();
    let mut shown_log: Vec<serde_json::Value> = Vec::new();
    let mut prev: HashSet<String> = HashSet::new();
    let mut prev_seg = u64::MAX;
    // Experiment knobs: ONE_PARTIAL=1 accepts a chapter:verse hit from a single
    // partial (tried 2026-10-06: about 0.5 s faster but 2.7x the wrong verses);
    // FIRE_DELAY_S sets the console's delay before a spoken reference shows.
    let one_partial = std::env::var("ONE_PARTIAL").is_ok();
    let fire_delay: f64 = std::env::var("FIRE_DELAY_S").ok().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let (mut n_partial, mut n_final, mut whisper_ms) = (0usize, 0usize, 0usize);

    while (t as usize) < audio.len() {
        t += sr / 10;
        let end = (t as usize).min(audio.len());
        // (text, compute ms, segment, is partial) produced by this step.
        let mut evs: Vec<(String, usize, u64, bool)> = Vec::new();
        #[cfg(feature = "nemotron")]
        if let Some(e) = nem.as_mut() {
            let t0 = std::time::Instant::now();
            let (outs, _) = e.step(end as u64, 0, |a, b| audio[a as usize..(b as usize).min(audio.len())].to_vec());
            let ms = t0.elapsed().as_millis() as usize;
            for o in outs {
                match o {
                    agent_hsp_lib::nemotron::Out::Partial { text, seg } => evs.push((text, ms, seg, true)),
                    agent_hsp_lib::nemotron::Out::Final { text, seg, .. } => evs.push((text, ms, seg, false)),
                }
            }
            whisper_ms += ms;
            t += (ms as u64) * sr / 1000;
        }
        if !nemotron {
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
            let (text, ms) = run_whisper_opts(state.as_mut().unwrap(), samples, partial, actx);
            whisper_ms += ms;
            t += (ms as u64) * sr / 1000;
            evs.push((text, ms, s, partial));
        }
        for (text, ms, s, partial) in evs {
        if partial { n_partial += 1 } else { n_final += 1 }
        let now = clip_start + t as f64 / sr as f64;
        // Partials only act on chapter:verse hits; "John chapter 3" mid-sentence
        // is usually the front half of "John chapter 3 verse 16".
        // ...and ignore a trailing number: "John 3 1" may be "John 3 16" half-spoken.
        let settled = if partial { settle_tail(&text) } else { text.clone() };
        let hits: Vec<_> = live
            .lookup(&settled, None, now, !partial)
            .into_iter()
            .filter(|h| !partial || h.reference.as_ref().map_or(false, |r| r.verse.is_some()))
            .collect();
        let labels: HashSet<String> = hits.iter().map(|h| h.label.clone()).collect();
        if !text.is_empty() {
            let row = serde_json::json!({ "t": now, "text": text, "seg": s });
            if partial { partials_log.push(row) } else { finals_log.push(row) }
        }
        // Same rule as the console: a partial hit must repeat in the next
        // partial of the same segment; a final hit counts at once.
        let accepted: Vec<String> = if partial {
            if s != prev_seg {
                prev.clear();
            }
            let a = if one_partial { labels.iter().cloned().collect() } else { labels.intersection(&prev).cloned().collect() };
            prev = labels.clone();
            prev_seg = s;
            a
        } else {
            prev.clear();
            labels.iter().cloned().collect()
        };
        for l in accepted {
            if !shown.iter().any(|(at, sl, _)| *sl == l && now - at < 180.0) {
                let vt = hits.iter().find(|h| h.label == l).map(|h| h.text.clone()).unwrap_or_default();
                shown_log.push(serde_json::json!({ "t": now + fire_delay, "label": l, "text": vt, "trigger": text }));
                shown.push((now, l, if partial { "partial" } else { "final" }));
            }
        }
        if std::env::var("VERBOSE").is_ok() {
            println!("{:7.2}s {} {:4}ms {:?} {:?}", now, if partial { "P" } else { "F" }, ms, text, labels);
        }
        }
    }

    if let Some(path) = &dump {
        let out = serde_json::json!({ "clip": [clip_start, clip_end], "finals": finals_log, "partials": partials_log, "shown": shown_log });
        std::fs::write(path, serde_json::to_string_pretty(&out).unwrap()).unwrap();
    }
    println!("mode={} audio_ctx={} partials={} finals={} whisper_total={}ms", mode, actx, n_partial, n_final, whisper_ms);
    let mut lat = Vec::new();
    let (mut found, mut already, mut scored) = (0usize, 0usize, 0usize);
    for e in expected.iter().filter(|e| e.scored) {
        scored += 1;
        let hit = shown
            .iter()
            .find(|(at, l, _)| covers(&e.label, l) && *at >= e.start - 5.0 && *at <= e.end + 30.0);
        match hit {
            Some((at, _, via)) => {
                found += 1;
                lat.push(at - e.end);
                println!("  {:8.1}s {:22} {:+6.2}s  via {}", e.end, e.label, at - e.end, via);
            }
            None => {
                if shown.iter().any(|(at, l, _)| covers(&e.label, l) && *at < e.start && e.start - at < 180.0) {
                    found += 1;
                    already += 1;
                    println!("  {:8.1}s {:22}   already on screen", e.end, e.label);
                } else {
                    println!("  {:8.1}s {:22}   MISSED", e.end, e.label);
                }
            }
        }
    }
    // A detection is wrong when nothing the speaker said nearby (scored or
    // not: chapter mentions, follow-ups, quotes) explains it.
    let mut wrong = 0;
    for (at, l, via) in &shown {
        if !expected.iter().any(|e| covers_(&e.label, l, false) && (at - e.end).abs() <= 60.0) {
            wrong += 1;
            println!("  extra (false hit): {} at {:.1}s via {}", l, at, via);
        }
    }
    lat.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mean = if lat.is_empty() { 0.0 } else { lat.iter().sum::<f64>() / lat.len() as f64 };
    let med = if lat.is_empty() { 0.0 } else { lat[lat.len() / 2] };
    let worst = lat.last().copied().unwrap_or(0.0);
    println!(
        "  found {}/{}  ({} already on screen)  wrong {}  mean {:.2}s  median {:.2}s  worst {:.2}s",
        found, scored, already, wrong, mean, med, worst
    );
}

fn covers(expected: &str, shown: &str) -> bool {
    covers_(expected, shown, true)
}

struct Expected {
    label: String,
    start: f64,
    end: f64,
    scored: bool,
}

/// "1 John 1:9-10" -> ("1 john", 1, Some(9), Some(10)).
fn parse_label(l: &str) -> Option<(String, usize, Option<usize>, Option<usize>)> {
    let l = norm(l);
    let sp = l.rfind(' ')?;
    let (book, cv) = (l[..sp].to_string(), &l[sp + 1..]);
    let mut it = cv.splitn(2, ':');
    let c = it.next()?.parse().ok()?;
    let (v, e) = match it.next() {
        Some(vs) => {
            let mut r = vs.splitn(2, '-');
            let v: usize = r.next()?.parse().ok()?;
            (Some(v), r.next().and_then(|x| x.parse().ok()))
        }
        None => (None, None),
    };
    Some((book, c, v, e))
}

/// Does showing `shown` satisfy the citation `expected`? Same book and
/// chapter, and the shown verse falls inside the cited verse or range.
fn covers_(expected: &str, shown: &str, strict: bool) -> bool {
    let (Some(x), Some(y)) = (parse_label(expected), parse_label(shown)) else {
        return norm(expected) == norm(shown);
    };
    if x.0 != y.0 || x.1 != y.1 {
        return false;
    }
    match (x.2, y.2) {
        (None, None) => true,
        (Some(v), Some(sv)) => sv >= v && sv <= x.3.unwrap_or(v),
        // chapter-only on one side: not a find, but close enough to not be "wrong"
        _ => !strict,
    }
}
