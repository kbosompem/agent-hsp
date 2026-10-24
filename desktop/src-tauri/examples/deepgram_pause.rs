// Check that a Deepgram connection survives a pause held open by KeepAlive
// (the spend gate's quiet mode): 3 s of speech, Finalize, 25 s of KeepAlive
// only, then 3 s more speech. About 6 s of billed audio.
//   DG_KEY=... cargo run --release --example deepgram_pause -- fixtures/latency/sermon1.wav
use agent_hsp_lib::deepgram::{connect, parse_result};
use std::time::{Duration, Instant};
use tungstenite::Message;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let key = std::env::var("DG_KEY").expect("DG_KEY");
    let b = std::fs::read(&args[1]).unwrap();
    let pcm = &b[44..];
    let mut ws = connect(&key).expect("connect");
    let t0 = Instant::now();
    let (mut i, mut finals_after) = (0usize, 0);
    let mut last_ka = Instant::now();
    let mut finalized = false;
    while t0.elapsed() < Duration::from_secs(36) {
        let s = t0.elapsed().as_secs_f32();
        let speaking = s < 3.0 || (28.0..31.0).contains(&s);
        // Audio time owed so far: the pause does not count.
        let ms = t0.elapsed().as_millis() as usize;
        let owed = if s < 3.0 { ms } else { 3000 + ms.saturating_sub(28000) };
        if speaking && owed >= i / 32 {
            let end = (i + 3200).min(pcm.len());
            ws.send(Message::Binary(pcm[i..end].to_vec().into())).expect("send audio");
            i = end;
            finalized = false;
        } else if !speaking && s >= 3.0 {
            if !finalized {
                ws.send(Message::Text(r#"{"type":"Finalize"}"#.into())).expect("finalize");
                finalized = true;
                println!("{s:5.1}s paused");
            }
            if last_ka.elapsed() >= Duration::from_secs(5) {
                last_ka = Instant::now();
                ws.send(Message::Text(r#"{"type":"KeepAlive"}"#.into())).expect("keepalive (connection closed?)");
                println!("{s:5.1}s keepalive");
            }
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                if let Some((text, is_final, _)) = parse_result(&v) {
                    if is_final && !text.is_empty() {
                        println!("{s:5.1}s F {text}");
                        if s > 28.0 {
                            finals_after += 1;
                        }
                    }
                }
            }
            Ok(Message::Close(c)) => panic!("closed: {c:?}"),
            _ => {}
        }
    }
    println!("{}", if finals_after > 0 { "OK: transcribing after the pause" } else { "FAIL: nothing after the pause" });
}
