// Replay a stream of partial + final transcripts from any speech engine
// (e.g. Deepgram's live websocket) through the parser with the same rules as
// the latency harness: partials are tail-settled, only chapter:verse hits
// count, and a partial hit must repeat in the next partial of the same
// segment; a final hit counts at once and commits context.
//
//   cargo run --release --example replay_events -- events.json out.json
//
// events.json: {"clip": [a, b], "events": [{"t", "text", "final": bool, "seg"}]}
// t is the moment the transcript arrived, on the recording clock.
// ONE_PARTIAL=1 accepts a hit from a single partial.

use preso_core::LiveLookup;
use std::collections::HashSet;

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

/// Same as settle_tail() in examples/latency.rs (mirror of settleTail() in App.tsx).
fn settle_tail(t: &str) -> String {
    let mut s = drop_trailing_number(t);
    loop {
        let words: Vec<&str> = s.split_whitespace().collect();
        if words.len() < 2 {
            return s;
        }
        let last = words[words.len() - 1].trim_matches(|c: char| ",.:;-!?".contains(c)).to_lowercase();
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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dump: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
    let one_partial = std::env::var("ONE_PARTIAL").is_ok();
    preso_core::init_engine(None);
    let mut live = LiveLookup::new();
    let mut shown: Vec<(f64, String)> = Vec::new();
    let mut shown_log: Vec<serde_json::Value> = Vec::new();
    let mut prev: HashSet<String> = HashSet::new();
    let mut prev_seg = -1i64;
    for e in dump["events"].as_array().unwrap() {
        let t = e["t"].as_f64().unwrap();
        let text = e["text"].as_str().unwrap();
        let partial = !e["final"].as_bool().unwrap();
        let s = e["seg"].as_i64().unwrap_or(0);
        let settled = if partial { settle_tail(text) } else { text.to_string() };
        let hits: Vec<_> = live
            .lookup(&settled, None, t, !partial)
            .into_iter()
            .filter(|h| h.reference.as_ref().map_or(false, |r| r.verse.is_some()))
            .collect();
        let labels: HashSet<String> = hits.iter().map(|h| h.label.clone()).collect();
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
            if !shown.iter().any(|(at, sl)| *sl == l && t - at < 180.0) {
                let vt = hits.iter().find(|h| h.label == l).map(|h| h.text.clone()).unwrap_or_default();
                shown_log.push(serde_json::json!({ "t": t, "label": l, "text": vt, "trigger": text,
                                                   "via": if partial { "partial" } else { "final" } }));
                shown.push((t, l));
            }
        }
    }
    let out = serde_json::json!({ "clip": dump["clip"], "shown": shown_log });
    std::fs::write(&args[2], serde_json::to_string_pretty(&out).unwrap()).unwrap();
}
