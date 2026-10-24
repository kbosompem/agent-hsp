// Replay a recording through the Deepgram spend gate: how much audio would be
// sent (billed), where it pauses, and when the session would stop.
//
//   afconvert -f WAVE -d LEI16@16000 -c 1 audio.m4a /tmp/a.wav
//   cargo run --release --example spend_gate -- /tmp/a.wav

use agent_hsp_lib::deepgram::{Gate, SpendGate};
use agent_hsp_lib::segmenter::rms_of;

fn read_wav16(path: &str) -> Vec<f32> {
    let b = std::fs::read(path).expect("read wav");
    let mut i = 12;
    while i + 8 <= b.len() {
        let n = u32::from_le_bytes([b[i + 4], b[i + 5], b[i + 6], b[i + 7]]) as usize;
        if &b[i..i + 4] == b"data" {
            let d = &b[i + 8..(i + 8 + n).min(b.len())];
            return d.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect();
        }
        i += 8 + n + (n & 1);
    }
    panic!("no data chunk");
}

fn clock(samples: u64) -> String {
    let s = samples / 16000;
    format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
}

fn main() {
    let path = std::env::args().nth(1).expect("wav path");
    let audio = read_wav16(&path);
    let step = 800u64; // 50 ms
    let mut gate = SpendGate::new(0.002, 0);
    let (mut sent, mut fed, mut pauses) = (0u64, 0u64, 0usize);
    let mut paused_at = None;
    let mut pos = step;
    while (pos as usize) <= audio.len() {
        let tail = &audio[(pos.saturating_sub(8000)) as usize..pos as usize];
        match gate.step(rms_of(tail), pos) {
            Gate::Resume(from) => {
                fed = from.max(fed);
                if let Some(p) = paused_at.take() {
                    if pos - p > 60 * 16000 {
                        println!("  paused {} to {}", clock(p), clock(pos));
                    }
                }
            }
            Gate::Pause => {
                pauses += 1;
                paused_at = Some(pos);
            }
            Gate::Stop => {
                println!("STOP at {} (5 quiet minutes)", clock(pos));
                break;
            }
            _ => {}
        }
        if gate.sending {
            sent += pos - fed;
        }
        fed = pos;
        pos += step;
    }
    let total = (audio.len() as u64).min(pos);
    println!(
        "listened {} · sent {} ({:.0}%) · {} pauses",
        clock(total),
        clock(sent),
        100.0 * sent as f64 / total.max(1) as f64,
        pauses
    );
}
