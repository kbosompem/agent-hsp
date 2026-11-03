// The preacher's books (books.rs) from the command line.
//
//   cargo run --release -p preso-core --example books -- import <epub|pdf|zip|folder> <books dir>
//   cargo run --release -p preso-core --example books -- quotes <books dir> <transcript>...
//   cargo run --release -p preso-core --example books -- related <books dir> <fixtures/real> [slug...]
//
// import writes one JSON file per book (as the app does) and prints its
// chapters. quotes replays transcripts (fixtures/real/<slug>.ref.json, or a
// session's transcript.jsonl) through the quote matcher the way the console
// calls it, and prints every quote it would offer. related prints the
// chapters closest to each fixture sermon, from its transcript and labeled
// verses.
use std::path::Path;

const WORDS: usize = 60;
const WINDOW_S: f64 = 30.0;

fn secs(s: &str) -> f64 {
    let s = s.replace(',', ".");
    let p: Vec<f64> = s.split(':').map(|x| x.parse().unwrap_or(0.0)).collect();
    p[0] * 3600.0 + p[1] * 60.0 + p[2]
}

/// (time, text) lines of a fixture or a session transcript.
fn lines(path: &Path) -> Vec<(f64, String)> {
    let s = std::fs::read_to_string(path).unwrap();
    if path.to_string_lossy().ends_with(".jsonl") {
        return s
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .map(|v| (v["t"].as_f64().unwrap_or(0.0), v["text"].as_str().unwrap_or("").to_string()))
            .collect();
    }
    let v: serde_json::Value = serde_json::from_str(&s).unwrap();
    v["transcription"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (secs(s["timestamps"]["to"].as_str().unwrap()), s["text"].as_str().unwrap().to_string()))
        .collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("import") => {
            let dir = Path::new(&args[3]);
            let t = std::time::Instant::now();
            let r = preso_core::books::import(Path::new(&args[2]), dir).unwrap();
            for s in &r.skipped {
                println!("skipped {}", s);
            }
            for f in std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()) {
                let b: preso_core::books::Book = serde_json::from_str(&std::fs::read_to_string(f.path()).unwrap()).unwrap();
                if !r.added.contains(&b.title) {
                    continue;
                }
                let words: usize = b.chapters.iter().flat_map(|c| &c.paras).map(|p| p.text.split_whitespace().count()).sum();
                println!("{} · {} chapters · {} words", b.title, b.chapters.len(), words);
                if r.added.len() <= 3 {
                    for c in &b.chapters {
                        println!("  {} · {} paragraphs · {} heads · {} verses", c.title, c.paras.len(), c.heads.len(), c.refs.len());
                        for h in c.heads.iter().take(6) {
                            println!("      - {}", h);
                        }
                    }
                }
            }
            println!("{} added, {} skipped, {} in all, {:.1} s", r.added.len(), r.skipped.len(), r.total, t.elapsed().as_secs_f32());
        }
        Some("quotes") => {
            let t = std::time::Instant::now();
            preso_core::books::load_dir(Path::new(&args[2]));
            preso_core::recite::warm();
            eprintln!("loaded in {:.1} s", t.elapsed().as_secs_f32());
            let mut total_s = 0.0;
            let mut hits = 0;
            for p in &args[3..] {
                let ls = lines(Path::new(p));
                total_s += ls.last().map_or(0.0, |l| l.0);
                let mut recent: Vec<(f64, String)> = Vec::new();
                let mut last: Option<String> = None;
                for (t, line) in &ls {
                    for w in line.split_whitespace() {
                        recent.push((*t, w.to_string()));
                    }
                    recent.retain(|(at, _)| t - at <= WINDOW_S);
                    let start = recent.len().saturating_sub(WORDS);
                    let text = recent[start..].iter().map(|(_, w)| w.as_str()).collect::<Vec<_>>().join(" ");
                    if let Some(q) = preso_core::books::quoted(&text) {
                        if last.as_deref() == Some(q.text.as_str()) {
                            continue;
                        }
                        hits += 1;
                        println!("{} {:>7.1}s run {} weight {:.1} cue {} · {} · {}", Path::new(p).file_name().unwrap().to_string_lossy(), t, q.run, q.weight, preso_core::books::cued(&text), q.book, q.chapter);
                        println!("    said: {}", text);
                        println!("    book: {}", q.text);
                        last = Some(q.text);
                    }
                }
            }
            println!("{} quotes in {:.1} hours", hits, total_s / 3600.0);
        }
        Some("related") => {
            preso_core::books::load_dir(Path::new(&args[2]));
            let dir = Path::new(&args[3]);
            let mut slugs: Vec<String> = args[4..].to_vec();
            if slugs.is_empty() {
                slugs = std::fs::read_dir(dir.join("labels"))
                    .unwrap()
                    .filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().trim_end_matches(".labels.json").to_string())
                    .collect();
                slugs.sort();
            }
            for slug in slugs {
                let text = lines(&dir.join(format!("{}.ref.json", slug))).into_iter().map(|l| l.1).collect::<Vec<_>>().join(" ");
                let labels: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("labels").join(format!("{}.labels.json", slug))).unwrap()).unwrap();
                let refs: Vec<String> = labels["refs"].as_array().unwrap().iter().filter_map(|r| r["label"].as_str().map(String::from)).collect();
                println!("{} ({} verses) · {}", slug, refs.len(), labels["summary"]["title"].as_str().unwrap_or(""));
                for o in preso_core::books::related_scored(&text, &refs, 3) {
                    println!("   {:.3} (verses {:.3}, words {:.3}) {} · {}", o.score, o.verses, o.words, o.book, o.chapter);
                }
            }
        }
        _ => eprintln!("usage: books import|quotes|related ..."),
    }
}
