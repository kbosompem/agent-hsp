#!/usr/bin/env python3
"""Score finals dumps from any engine with score_real.py's exact logic.

  python3 scripts/stt-eval/score_alt.py app                # baseline (whisper dumps in fixtures/real/app)
  python3 scripts/stt-eval/score_alt.py alt/<engine>       # an alternative engine
  python3 scripts/stt-eval/score_alt.py app alt/<engine>   # also prints per-reference differences

Runs redetect on each <slug>.finals.json -> fixtures/real/alt/_redetect/<dir>/<slug>.json, then score() against labels refined the same way score_real.py does.
Only slugs that have an app/<slug>.finals.json baseline are scored (16).
"""
import json, os, subprocess, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "latency-fixture"))
import score_real as sr

REAL = sr.REAL
REDETECT = os.path.join(sr.ROOT, "desktop", "target", "release", "examples", "redetect")


def slugs():
    out = []
    for fn in sorted(os.listdir(os.path.join(REAL, "labels"))):
        s = fn[: -len(".labels.json")]
        if os.path.exists(os.path.join(REAL, "app", s + ".finals.json")):
            out.append(s)
    return out


def refs_for(slug):
    lab = json.load(open(os.path.join(REAL, "labels", slug + ".labels.json")))
    ref = json.load(open(os.path.join(REAL, slug + ".ref.json")))
    segs = [(s["offsets"]["from"] / 1000, s["offsets"]["to"] / 1000, s["text"]) for s in ref["transcription"]]
    return sr.refine_times(lab["refs"], segs)


def followups(refs, shown):
    """Same hit rule as score() but for kind == followup."""
    fu = [r for r in refs if r["kind"] == "followup"]
    n = sum(1 for r in fu if any(sr.covers(r["label"], s["label"]) and r["spoken_start_s"] - 5 <= s["t"] <= r["spoken_end_s"] + 30 for s in shown))
    return n, len(fu)


def run(d):
    d = os.path.join(REAL, d)
    res = {}
    for s in slugs():
        src = os.path.join(d, s + ".finals.json")
        if not os.path.exists(src):
            continue
        od = os.path.join(REAL, "alt", "_redetect", os.path.relpath(d, REAL).replace("/", "_"))
        os.makedirs(od, exist_ok=True)
        out = os.path.join(od, s + ".json")
        subprocess.run([REDETECT, src, out], check=True, capture_output=True)
        shown = json.load(open(out))["shown"]
        refs = refs_for(s)
        sc = sr.score(refs, shown)
        sc["fu"] = followups(refs, shown)
        sc["refs"] = refs
        sc["shown"] = shown
        sc["finals"] = json.load(open(src))["finals"]
        res[s] = sc
    return res


def table(name, res):
    groups = {"ghana": [s for s in res if not s.startswith("dhm-")], "dhm": [s for s in res if s.startswith("dhm-")]}
    groups["total"] = list(res)
    print(f"== {name}")
    for g, ss in groups.items():
        f = sum(res[s]["found"] for s in ss); n = sum(res[s]["scored"] for s in ss)
        w = sum(len(res[s]["wrong"]) for s in ss)
        fu = sum(res[s]["fu"][0] for s in ss); fn = sum(res[s]["fu"][1] for s in ss)
        print(f"  {g:6} files {len(ss):2}  explicit {f:3}/{n:<3}  wrong {w:3}  followups {fu:2}/{fn}")


def heard(finals, t, span=20):
    return " | ".join(f["text"].strip() for f in finals if t - span <= f["t"] <= t + span)[:400]


def diff(a, b, an, bn):
    for s in a:
        if s not in b:
            continue
        miss_a = {(m["label"], m["at"]) for m in a[s]["missed"]}
        miss_b = {(m["label"], m["at"]) for m in b[s]["missed"]}
        for (l, at) in sorted(miss_a ^ miss_b, key=lambda x: x[1]):
            who = bn if (l, at) in miss_a else an
            r = next(r for r in a[s]["refs"] if r["kind"] == "explicit" and r["label"] == l and r["spoken_end_s"] == at)
            print(f"\n[{s} @{at:.0f}s] {l}: only {who} caught it. label heard: {r.get('heard','')!r}")
            print(f"   {an}: {heard(a[s]['finals'], at, 12)}")
            print(f"   {bn}: {heard(b[s]['finals'], at, 12)}")


if __name__ == "__main__":
    results = [(d, run(d)) for d in sys.argv[1:]]
    for d, r in results:
        table(d, r)
    if len(results) == 2:
        diff(results[0][1], results[1][1], results[0][0], results[1][0])
