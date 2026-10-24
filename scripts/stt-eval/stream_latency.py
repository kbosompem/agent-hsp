#!/usr/bin/env python3
"""Verse latency on streamed clips: seconds from a reference's spoken end
(pinned by score_real.refine_times) to the moment the parser would show it.

  python3 scripts/stt-eval/stream_latency.py deepgram <variant> <slug>...   # events.json from deepgram_stream.py
  python3 scripts/stt-eval/stream_latency.py whisper <slug>...              # alt/whisper-stream-<slug>.json from examples/latency.rs --dump

Deepgram events are replayed three ways with examples/replay_events.rs:
partials + finals (two partials in a row, the console's rule for whisper), one partial,
and finals only.
"""
import json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(__file__))
import score_alt as sa  # noqa: E402

sr = sa.sr
REPLAY = os.path.join(sr.ROOT, "desktop", "target", "release", "examples", "replay_events")


def clip_refs(slug, clip):
    return [r for r in sa.refs_for(slug) if clip[0] <= r["spoken_start_s"] and r["spoken_end_s"] <= clip[1]]


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * p))] if xs else float("nan")


def summarize(name, rows):
    delays = [h["delay"] for r in rows for h in r["hits"]]
    f = sum(r["found"] for r in rows); n = sum(r["scored"] for r in rows); w = sum(len(r["wrong"]) for r in rows)
    print(f"  {name:28} found {f}/{n} wrong {w}  delay median {pct(delays, .5):.2f}s  p90 {pct(delays, .9):.2f}s  (n={len(delays)})")


if sys.argv[1] == "whisper":
    rows = []
    for s in sys.argv[2:]:
        d = json.load(open(os.path.join(sr.REAL, "alt", f"whisper-stream-{s}.json")))
        rows.append(sr.score(clip_refs(s, d["clip"]), d["shown"]))
    summarize("whisper small.en streaming", rows)
else:
    variant, ss = sys.argv[2], sys.argv[3:]
    modes = {"partials (2 in a row)": {}, "one partial": {"ONE_PARTIAL": "1"}, "finals only": None}
    for mode, env in modes.items():
        rows = []
        for s in ss:
            src = os.path.join(sr.REAL, "alt", variant, s + ".events.json")
            ev = json.load(open(src))
            if env is None:
                tmp = src.replace(".events.json", ".finalsonly.json")
                json.dump({"clip": ev["clip"], "events": [e for e in ev["events"] if e["final"]]}, open(tmp, "w"))
                src = tmp
            out = os.path.join(sr.REAL, "alt", variant, f"{s}.shown-{mode.split()[0]}{'1' if env else ''}.json")
            subprocess.run([REPLAY, src, out], check=True, capture_output=True, env={**os.environ, **(env or {})})
            rows.append(sr.score(clip_refs(s, ev["clip"]), json.load(open(out))["shown"]))
        summarize(f"deepgram {mode}", rows)
    # Transcript-level lag: final arrival minus the end of the audio it covers.
    lag = [e["t"] - e["audio_end"] for s in ss
           for e in json.load(open(os.path.join(sr.REAL, "alt", variant, s + ".events.json")))["events"] if e["final"]]
    print(f"  deepgram final arrival after its last audio: median {pct(lag, .5):.2f}s  p90 {pct(lag, .9):.2f}s")
