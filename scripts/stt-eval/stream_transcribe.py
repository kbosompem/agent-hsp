#!/usr/bin/env python3
"""Transcribe a sermon WAV with a sherpa-onnx streaming transducer (Nemotron),
feeding audio in 100 ms pieces as a live mic would, and write a finals dump in
the app's format: {"clip": [0, dur], "finals": [{"t", "text", "seg"}], ...}.

Each final is one endpoint-detected utterance. "t" is the recording time at
which the endpoint fired (when an app would know the utterance is done);
"t_last_word" is the end of its last token. Partials are used to measure how
long after a token is spoken it first appears ("first-seen delay").

  python stream_transcribe.py --model DIR --wav in.wav --out out.finals.json \
      [--hotwords FILE --hotwords-score 1.5] [--method greedy_search|modified_beam_search]
"""
import argparse, json, os, re, statistics, time
import numpy as np
import soundfile as sf
import sherpa_onnx

ap = argparse.ArgumentParser()
ap.add_argument("--model", required=True)
ap.add_argument("--wav", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--method", default="greedy_search")
ap.add_argument("--hotwords", default="")
ap.add_argument("--hotwords-score", type=float, default=1.5)
ap.add_argument("--beam", type=int, default=4)
ap.add_argument("--threads", type=int, default=2)
ap.add_argument("--silence", type=float, default=1.0, help="rule2 trailing silence after speech (s)")
ap.add_argument("--max-utt", type=float, default=15.0, help="rule3 forced cut (s)")
ap.add_argument("--language", default="en")
ap.add_argument("--preroll", type=float, default=1.0, help="seconds of audio replayed into each new stream")
a = ap.parse_args()

m = a.model
enc = next(os.path.join(m, f) for f in os.listdir(m) if f.startswith("encoder"))
dec = next(os.path.join(m, f) for f in os.listdir(m) if f.startswith("decoder"))
joi = next(os.path.join(m, f) for f in os.listdir(m) if f.startswith("joiner"))
tokens = os.path.join(m, "tokens.txt")
extra = {}
if a.hotwords:
    # Release tarballs ship no bpe.vocab; derive an encoding-equivalent one
    # (equal scores -> longest match), as sherpa-onnx PR #3723 does.
    vocab = os.path.join(m, "bpe.vocab")
    if not os.path.exists(vocab):
        with open(tokens) as f, open(vocab, "w") as g:
            for line in f:
                tok = line.rsplit(" ", 1)[0]
                if tok and not tok.startswith("<"):
                    g.write(f"{tok}\t0\n")
    extra = dict(hotwords_file=a.hotwords, hotwords_score=a.hotwords_score, modeling_unit="bpe", bpe_vocab=vocab)
rec = sherpa_onnx.OnlineRecognizer.from_transducer(
    tokens=tokens, encoder=enc, decoder=dec, joiner=joi, num_threads=a.threads,
    decoding_method=a.method, max_active_paths=a.beam,
    enable_endpoint_detection=True, rule1_min_trailing_silence=2.4,
    rule2_min_trailing_silence=a.silence, rule3_min_utterance_length=a.max_utt, **extra)

audio, sr = sf.read(a.wav, dtype="float32")
if audio.ndim > 1:
    audio = audio.mean(axis=1)
assert sr == 16000, sr
dur = len(audio) / sr


def new_stream():
    s = rec.create_stream()
    if a.language and hasattr(s, "set_option"):
        s.set_option("language", a.language)
    return s


def clean(t):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", t)).strip()


step = int(0.1 * sr)
PREROLL = int(a.preroll * sr)
finals, delays = [], []
t0 = time.time()


def emit(toks, ts, lo, hi, now):
    text = clean("".join(toks[lo:hi]).replace("\u2581", " "))
    if text:
        finals.append({"t": round(min(now, dur), 3), "t_first_word": round(ts[lo], 3),
                       "t_last_word": round(ts[hi - 1], 3), "text": text, "seg": len(finals)})


# Endpointing is done here on token timestamps: a final when no new token has
# appeared for --silence seconds, or a forced cut at the widest gap once an
# utterance passes --max-utt seconds. After each final a fresh stream starts,
# primed with the last --preroll seconds of audio. (recognizer.reset() would
# re-initialise the encoder cache right where the next word may begin, which
# dropped first words; one never-reset stream grows without bound.)
def run_stream(begin):
    """Decode from sample `begin` until an endpoint. Returns next begin sample."""
    s = new_stream()
    off = begin / sr
    pos, cut, seen = begin, 0, 0
    while True:
        s.accept_waveform(sr, audio[pos:pos + step])
        pos = min(pos + step, len(audio))
        now = pos / sr
        last = pos >= len(audio)
        if last:
            s.accept_waveform(sr, np.zeros(int(1.2 * sr), dtype=np.float32))
            s.input_finished()
        decoded = False
        while rec.is_ready(s):
            rec.decode_stream(s)
            decoded = True
        if not decoded and not last:
            continue
        r = rec.get_result_all(s)
        pairs = [(t, off + x) for t, x in zip(r.tokens, r.timestamps) if not (t.startswith("<") and t.endswith(">"))]
        toks, ts = [p[0] for p in pairs], [p[1] for p in pairs]
        cut = min(cut, len(toks))  # beam search may revise the tail
        for x in ts[max(seen, cut):]:
            delays.append(now - x)
        seen = max(seen, len(ts))
        if len(toks) > cut and (now - ts[-1] >= a.silence or last):
            emit(toks, ts, cut, len(toks), now)
            return None if last else max(begin, pos - PREROLL)
        if len(toks) > cut and ts[-1] - ts[cut] >= a.max_utt:
            lo = cut + (len(toks) - cut) // 2
            j = max(range(lo, len(toks)), key=lambda k: ts[k] - ts[k - 1])
            emit(toks, ts, cut, j, now)
            cut = j
        if last:
            return None
        if len(toks) == cut and now - off > 30:
            # long silence or noise with no words: restart to keep the stream short
            return pos - PREROLL


b = 0
while b is not None:
    b = run_stream(b)
elapsed = time.time() - t0
q = sorted(delays)
stats = {"audio_s": round(dur, 1), "proc_s": round(elapsed, 1), "rtf": round(elapsed / dur, 4),
         "first_seen_delay_s": {"p50": round(q[len(q) // 2], 2), "p90": round(q[int(len(q) * .9)], 2), "mean": round(statistics.mean(q), 2)} if q else None,
         "n_finals": len(finals), "config": vars(a)}
os.makedirs(os.path.dirname(a.out), exist_ok=True)
json.dump({"clip": [0.0, dur], "finals": finals, "stats": stats}, open(a.out, "w"), indent=1)
print(json.dumps({k: v for k, v in stats.items() if k != "config"}))
