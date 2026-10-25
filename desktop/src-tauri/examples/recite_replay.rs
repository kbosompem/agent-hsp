// Replay fixture transcripts through the recited-verse matcher the way the
// console calls it: after each finished line, the last WORDS words spoken in
// the last WINDOW_S seconds; a verse is not repeated within REPEAT_S.
//
//   cargo run --release --example recite_replay -- fixtures/real out.json
//   cargo run --release --example recite_replay -- x.events.json out.json
//
// Reads every <slug>.ref.json (whisper segments), or the finals of one live
// event log (deepgram_stream.py, nemotron_stream.py); writes
// {slug: [[t, [book, chapter, verse], share, text], ...]} for scoring against
// the fixtures' refs (book is 0-based).
use std::collections::HashMap;

const WORDS: usize = 35;
const WINDOW_S: f64 = 30.0;
const REPEAT_S: f64 = 180.0;

fn secs(s: &str) -> f64 {
    let s = s.replace(',', ".");
    let p: Vec<f64> = s.split(':').map(|x| x.parse().unwrap_or(0.0)).collect();
    p[0] * 3600.0 + p[1] * 60.0 + p[2]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = std::path::Path::new(&args[1]);
    preso_core::recite::warm();
    let mut out = serde_json::Map::new();
    if args[1].ends_with(".events.json") {
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir).unwrap()).unwrap();
        let lines: Vec<(f64, String)> = v["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["final"].as_bool() == Some(true))
            .map(|e| {
                (
                    e["t"].as_f64().unwrap(),
                    e["text"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        let slug = dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .trim_end_matches(".events.json")
            .to_string();
        out.insert(slug, serde_json::Value::Array(replay(&lines)));
        std::fs::write(&args[2], serde_json::to_string(&out).unwrap()).unwrap();
        return;
    }
    let mut names: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".ref.json"))
        .collect();
    names.sort();
    for n in names {
        let slug = n.trim_end_matches(".ref.json").to_string();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(&n)).unwrap()).unwrap();
        let lines: Vec<(f64, String)> = v["transcription"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                (
                    secs(s["timestamps"]["to"].as_str().unwrap()),
                    s["text"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        let fired = replay(&lines);
        eprintln!("{} {}", slug, fired.len());
        out.insert(slug, serde_json::Value::Array(fired));
    }
    std::fs::write(&args[2], serde_json::to_string(&out).unwrap()).unwrap();
}

/// Finished lines (arrival time, text) -> the recited verses the console would queue.
fn replay(lines: &[(f64, String)]) -> Vec<serde_json::Value> {
    let mut recent: Vec<(f64, String)> = Vec::new();
    let mut shown: HashMap<String, f64> = HashMap::new();
    let mut fired = Vec::new();
    for (t, line) in lines {
        let t = *t;
        for w in line.split_whitespace() {
            recent.push((t, w.to_string()));
        }
        recent.retain(|(at, _)| t - at <= WINDOW_S);
        let start = recent.len().saturating_sub(WORDS);
        let text = recent[start..]
            .iter()
            .map(|(_, w)| w.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        if let Some(r) = preso_core::recite::recited(&text, None) {
            let label = r.hit.label.clone();
            if shown.get(&label).map_or(true, |at| t - at >= REPEAT_S) {
                shown.insert(label, t);
                let rf = r.hit.reference.unwrap();
                fired.push(serde_json::json!([
                    t,
                    [rf.book, rf.chapter, rf.verse],
                    r.share,
                    text
                ]));
            }
        }
    }
    fired
}
