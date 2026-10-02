// Re-run verse detection over a finals dump (from `latency ... finals --dump`)
// with the current parser, without re-running whisper. Used to score parser
// and follow-up changes against real sermons quickly.
//
//   cargo run --release --example redetect -- in.finals.json out.json
//
// Finals that are only words from the old whisper prompt (the
// "Micah chapter 3 verse 5" echo) are dropped, as the new prompt and filter
// would have prevented them.

use preso_core::LiveLookup;
use std::collections::HashSet;

const OLD_PROMPT_TAIL: &str = "Bible reading. Deuteronomy chapter 1. Micah chapter 3 verse 5.";

fn words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_string())
        .collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dump: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
    preso_core::init_engine(None);
    let mut live = LiveLookup::new();
    let echo: HashSet<String> = words(OLD_PROMPT_TAIL).into_iter().collect();
    let mut shown: Vec<serde_json::Value> = Vec::new();
    let mut last: Vec<(f64, String)> = Vec::new();
    let mut finals = Vec::new();
    for f in dump["finals"].as_array().unwrap() {
        let t = f["t"].as_f64().unwrap();
        let text = f["text"].as_str().unwrap();
        let w = words(&text.split('[').map(|p| p.split_once(']').map_or(p, |(_, r)| r)).collect::<String>());
        if w.len() >= 3 && w.iter().all(|x| echo.contains(x)) {
            continue;
        }
        finals.push(f.clone());
        for h in live.lookup(text, None, t, true) {
            if last.iter().any(|(at, l)| *l == h.label && t - at < 180.0) {
                continue;
            }
            last.push((t, h.label.clone()));
            shown.push(serde_json::json!({ "t": t + 0.6, "label": h.label, "text": h.text, "trigger": text }));
        }
    }
    let out = serde_json::json!({ "clip": dump["clip"], "finals": finals, "shown": shown });
    std::fs::write(&args[2], serde_json::to_string_pretty(&out).unwrap()).unwrap();
}
