#!/usr/bin/env python3
"""Per-reference live delay for any engine's event log, under three rules,
replayed through examples/replay_events.rs (no new transcription):

  two partials : a chapter:verse must appear in two partials in a row of one segment (the app's rule for whisper)
  one partial  : a single partial is enough
  hybrid       : the app's rule for Deepgram and Nemotron: one partial, and a later partial that drops that verse for a new one swaps it
                 (swapped verses are not counted wrong; "swapped" says how many, and for how long)
  finals only  : only endpoint finals count

  python3 scripts/stt-eval/live_delay.py <source> [<source> ...]
    source = alt/<variant>          events from deepgram_stream.py / nemotron_stream.py
             alt/<variant>:changed  same, keeping only partials whose text changed
             whisper                alt/whisper-stream-<slug>.json (examples/latency.rs --dump)

Clips are the two used for the Deepgram live run (fixtures/real/<slug>.json "clip").
With several sources it also prints a paired view on the references all of them caught.
Delay = shown time minus the reference's spoken end (score_real.refine_times).
"""
import json, os, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
import score_alt as sa  # noqa: E402

sr = sa.sr
REPLAY = os.path.join(sr.ROOT, "desktop", "target", "release", "examples", "replay_events")
SLUGS = ["20111129-can-do-man-2", "dhm-P64gA5d4SoQ"]
RULES = {"two partials": {}, "one partial": {"ONE_PARTIAL": "1"}, "hybrid": {"HYBRID": "1"}, "finals only": None}


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * p))] if xs else float("nan")


def load(source, slug):
    if source == "whisper":
        d = json.load(open(os.path.join(sr.REAL, "alt", f"whisper-stream-{slug}.json")))
        ev = [{"t": e["t"], "text": e["text"], "final": False, "seg": e["seg"]} for e in d["partials"]]
        ev += [{"t": e["t"], "text": e["text"], "final": True, "seg": e["seg"]} for e in d["finals"]]
        # a final arrives after the partials of its own segment
        ev.sort(key=lambda e: (e["t"], e["final"]))
        return {"clip": d["clip"], "events": ev}
    path, _, flag = source.partition(":")
    d = json.load(open(os.path.join(sr.REAL, path, slug + ".events.json")))
    if flag == "changed":
        d["events"] = [e for e in d["events"] if e["final"] or e.get("changed", True)]
    return d


def run(source):
    out = {}
    for rule, env in RULES.items():
        delays, found, scored, wrong, keyed, up = [], 0, 0, 0, {}, []
        for slug in SLUGS:
            d = load(source, slug)
            if env is None:
                d = {"clip": d["clip"], "events": [e for e in d["events"] if e["final"]]}
            with tempfile.TemporaryDirectory() as tmp:
                i, o = os.path.join(tmp, "in.json"), os.path.join(tmp, "out.json")
                json.dump(d, open(i, "w"))
                subprocess.run([REPLAY, i, o], check=True, capture_output=True, env={**os.environ, **(env or {})})
                shown = json.load(open(o))["shown"]
            refs = [r for r in sa.refs_for(slug) if d["clip"][0] <= r["spoken_start_s"] and r["spoken_end_s"] <= d["clip"][1]]
            swapped = {(s["label"], round(s["t"], 1)) for s in shown if "swapped" in s}
            up += [s["swapped"] - s["t"] for s in shown if "swapped" in s]
            sc = sr.score(refs, shown)
            sc["wrong"] = [w for w in sc["wrong"] if (w["label"], w["at"]) not in swapped]
            delays += [h["delay"] for h in sc["hits"]]
            keyed.update({(slug, h["at"]): h["delay"] for h in sc["hits"]})
            found += sc["found"]; scored += sc["scored"]; wrong += len(sc["wrong"])
        out[rule] = dict(median=pct(delays, .5), p90=pct(delays, .9), max=max(delays) if delays else float("nan"),
                         n=len(delays), found=found, scored=scored, wrong=wrong, keyed=keyed)
        print(f"{source:34} {rule:13} median {out[rule]['median']:5.2f}s  p90 {out[rule]['p90']:5.2f}s  "
              f"max {out[rule]['max']:5.2f}s  (n={len(delays)})  found {found}/{scored}  wrong {wrong}"
              + (f"  swapped {len(up)} (up {pct(up, .5):.2f}s median, {max(up):.2f}s max)" if up else ""), flush=True)
    return out


if __name__ == "__main__":
    res = {src: run(src) for src in sys.argv[1:]}
    if len(res) > 1:
        # Paired view: only references every source caught with a measurable delay.
        for rule in RULES:
            common = set.intersection(*(set(r[rule]["keyed"]) for r in res.values()))
            print(f"\n{rule}: {len(common)} references caught by every source")
            for src, r in res.items():
                d = [r[rule]["keyed"][k] for k in common]
                print(f"  {src:34} median {pct(d, .5):5.2f}s  max {max(d) if d else float('nan'):5.2f}s")
