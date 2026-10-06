#!/usr/bin/env python3
"""Live-delay harness for a sherpa-onnx streaming transducer (Nemotron).

Feeds the same 15-minute clip deepgram_stream.py uses (fixtures/real/<slug>.json
"clip") in 100 ms chunks on a simulated clock, the way examples/latency.rs
runs whisper: audio keeps arriving while the model computes, so each decode's
measured wall time is added to the clock, and every chunk that arrived
meanwhile is fed before the next decode.

  PY=<venv with hotword-capable sherpa_onnx> $PY scripts/stt-eval/nemotron_stream.py <slug> \
      --model DIR --variant nemotron-stream-560 [--hotwords FILE] [--silence 1.0] [--language en|auto]

Writes fixtures/real/alt/<variant>/<slug>.events.json in the format
examples/replay_events.rs consumes:
{"clip": [a, b], "events": [{"t", "text", "final", "seg", "audio_end", "changed"}]}
A partial is logged after every decode step that yields text (like Deepgram's
interims, which repeat unchanged text); "changed" marks a new hypothesis.
Endpointing follows stream_transcribe.py: a final when no new token has
appeared for --silence s (or a forced cut past --max-utt s); then a fresh
stream starts primed with the last --preroll s of audio (recognizer.reset()
dropped the next utterance's first word). Re-decoding that preroll is timed
and charged to the clock like any other decode.
"""
import argparse, json, os, re, sys, time, wave
import numpy as np
import sherpa_onnx

sys.path.insert(0, os.path.dirname(__file__))
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
REAL = os.path.join(ROOT, "fixtures", "real")

ap = argparse.ArgumentParser()
ap.add_argument("slug")
ap.add_argument("--model", required=True)
ap.add_argument("--variant", required=True)
ap.add_argument("--method", default="modified_beam_search")
ap.add_argument("--hotwords", default=os.path.join(os.path.dirname(__file__), "bible-hotwords.txt"))
ap.add_argument("--hotwords-score", type=float, default=1.5)
ap.add_argument("--beam", type=int, default=4)
ap.add_argument("--threads", type=int, default=2)
ap.add_argument("--silence", type=float, default=1.0)
ap.add_argument("--max-utt", type=float, default=15.0)
ap.add_argument("--preroll", type=float, default=1.0)
ap.add_argument("--language", default="en", help='"en" or "auto"; "en" blanks the hypothesis on Spanish (code-switched) speech')
a = ap.parse_args()

m = a.model
pick = lambda p: next(os.path.join(m, f) for f in sorted(os.listdir(m)) if f.startswith(p))
tokens = os.path.join(m, "tokens.txt")
extra = {}
if a.hotwords:
    vocab = os.path.join(m, "bpe.vocab")
    if not os.path.exists(vocab):  # encoding-equivalent vocab, as in stream_transcribe.py
        with open(tokens) as f, open(vocab, "w") as g:
            for line in f:
                tok = line.rsplit(" ", 1)[0]
                if tok and not tok.startswith("<"):
                    g.write(f"{tok}\t0\n")
    extra = dict(hotwords_file=a.hotwords, hotwords_score=a.hotwords_score, modeling_unit="bpe", bpe_vocab=vocab)
rec = sherpa_onnx.OnlineRecognizer.from_transducer(
    tokens=tokens, encoder=pick("encoder"), decoder=pick("decoder"), joiner=pick("joiner"),
    num_threads=a.threads, decoding_method=a.method, max_active_paths=a.beam,
    enable_endpoint_detection=False, **extra)

c0, c1 = json.load(open(os.path.join(REAL, a.slug + ".json")))["clip"]
w = wave.open(os.path.join(REAL, a.slug + ".wav"))
assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2
w.setpos(int(c0 * 16000))
audio = np.frombuffer(w.readframes(int((c1 - c0) * 16000)), dtype=np.int16).astype(np.float32) / 32768
SR, STEP, N = 16000, 1600, len(audio)
PRE = int(a.preroll * SR)


def clean(t):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", t.replace("▁", " "))).strip()


def new_stream():
    s = rec.create_stream()
    if hasattr(s, "set_option"):
        s.set_option("language", a.language)
    return s


clock = 0.0        # simulated seconds since clip start
compute = 0.0      # total decode wall time
events, seg = [], 0
s, begin, fed = new_stream(), 0, 0   # stream, its first sample, samples fed so far
cut, last_text = 0, None


def arrived():
    """Samples delivered by the mic by `clock` (whole 100 ms chunks)."""
    return min(N, int((clock + 1e-9) / 0.1) * STEP)


while True:
    avail = arrived()
    if avail <= fed:
        if fed >= N:
            break
        clock = (fed // STEP + 1) * 0.1  # idle until the next chunk lands
        continue
    s.accept_waveform(SR, audio[fed:avail])
    fed = avail
    t_start = time.perf_counter()
    stepped = False
    while rec.is_ready(s):
        rec.decode_stream(s)
        stepped = True
    r = rec.get_result_all(s) if stepped else None
    dt = time.perf_counter() - t_start
    compute += dt
    clock += dt
    if r is None:
        continue
    off = begin / SR
    pairs = [(t, off + x) for t, x in zip(r.tokens, r.timestamps) if not (t.startswith("<") and t.endswith(">"))]
    toks, ts = [p[0] for p in pairs], [p[1] for p in pairs]
    cut = min(cut, len(toks))
    now_audio = fed / SR
    T = round(c0 + clock, 3)
    if len(toks) > cut:
        text = clean("".join(toks[cut:]))
        if text:
            events.append({"t": T, "text": text, "final": False, "seg": seg,
                           "audio_end": round(c0 + now_audio, 3), "changed": text != last_text})
            last_text = text
    endpoint = len(toks) > cut and now_audio - ts[-1] >= a.silence
    forced = len(toks) > cut and ts[-1] - ts[cut] >= a.max_utt
    if endpoint or forced:
        j = len(toks)
        if forced and not endpoint:
            lo = cut + (len(toks) - cut) // 2
            j = max(range(lo, len(toks)), key=lambda k: ts[k] - ts[k - 1])
        text = clean("".join(toks[cut:j]))
        if text:
            events.append({"t": T, "text": text, "final": True, "seg": seg,
                           "audio_end": round(c0 + ts[j - 1], 3), "changed": True})
        seg += 1
        last_text = None
        if endpoint:
            # Fresh stream primed with the last --preroll s; its decode is timed
            # on the next pass through the loop (audio keeps arriving).
            s, begin, cut = new_stream(), max(begin, fed - PRE), 0
            fed = begin
        else:
            cut = j
    elif len(toks) == cut and now_audio - off > 30:
        s, begin, cut = new_stream(), max(begin, fed - PRE), 0
        fed = begin

# Flush the tail.
s.accept_waveform(SR, np.zeros(int(1.2 * SR), dtype=np.float32))
s.input_finished()
while rec.is_ready(s):
    rec.decode_stream(s)
r = rec.get_result_all(s)
text = clean("".join(t for t in r.tokens[cut:] if not (t.startswith("<") and t.endswith(">"))))
if text:
    events.append({"t": round(c0 + clock, 3), "text": text, "final": True, "seg": seg, "audio_end": c1, "changed": True})

out_dir = os.path.join(REAL, "alt", a.variant)
os.makedirs(out_dir, exist_ok=True)
json.dump({"clip": [c0, c1], "events": events, "config": vars(a), "compute_s": round(compute, 1)},
          open(os.path.join(out_dir, a.slug + ".events.json"), "w"), indent=1)
lag = sorted(e["t"] - e["audio_end"] for e in events if e["final"])
print(f"{a.slug} {a.variant}: {len(events)} events, finals {len(lag)}, compute {compute:.0f}s "
      f"(rtf {compute / (c1 - c0):.3f}), final after last word p50 {lag[len(lag)//2]:.2f}s")
