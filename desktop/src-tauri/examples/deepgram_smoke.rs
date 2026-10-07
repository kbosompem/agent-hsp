// Stream a WAV fixture to Deepgram in real time through the app's connection
// code and print interim (P) and final (F) transcripts.
//   DG_KEY=... cargo run --release --example deepgram_smoke -- fixtures/latency/sermon1.wav 20
use agent_hsp_lib::deepgram::{connect, parse_result};
use std::time::{Duration, Instant};
use tungstenite::Message;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let key = std::env::var("DG_KEY").expect("DG_KEY");
    let secs: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(20);
    let b = std::fs::read(&args[1]).unwrap();
    let pcm = &b[44..(44 + secs * 32000).min(b.len())];
    let mut ws = connect(&key).expect("connect");
    let t0 = Instant::now();
    let mut i = 0;
    while t0.elapsed() < Duration::from_secs(secs as u64 + 4) {
        if i < pcm.len() && t0.elapsed().as_millis() as usize >= i / 32 {
            let end = (i + 3200).min(pcm.len());
            ws.send(Message::Binary(pcm[i..end].to_vec().into())).unwrap();
            i = end;
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                if let Some((text, fin, sf)) = parse_result(&v) {
                    if !text.is_empty() {
                        println!("{:5.2}s {} {}", t0.elapsed().as_secs_f32(), if fin { if sf { "F*" } else { "F " } } else { "P " }, text);
                    }
                }
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(e) => {
                println!("error: {e}");
                break;
            }
        }
    }
    let _ = ws.send(Message::Text(r#"{"type":"CloseStream"}"#.into()));
}
