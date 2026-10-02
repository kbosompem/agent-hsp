#!/usr/bin/env python3
"""Score the app against labelled real sermons.

For each fixtures/real/labels/<slug>.labels.json:
  1. Pin each reference's spoken_end_s to the exact reference-transcript
     segment containing its "heard" words.
  2. Score the app's full-sermon run (app/<slug>.finals.json): found, missed,
     already-on-screen, wrong.
  3. Write <slug>.json (fixture with refined refs and the densest 15-minute
     clip) for the streaming latency run.
  4. Collect everything into report.json for the results page.

  python3 scripts/latency-fixture/score_real.py [--replay path/to/replay.js]
"""
import json, os, re, subprocess, sys
from difflib import SequenceMatcher

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
REAL = os.path.join(ROOT, "fixtures", "real")
CLIP_S = 900


def words(s):
    return re.findall(r"[a-z0-9]+", s.lower())


def norm_label(l):
    return l.lower().replace("psalms", "psalm").strip()


def parse_label(l):
    l = norm_label(l)
    m = re.match(r"^(.*) (\d+)(?::(\d+)(?:-(\d+))?)?$", l)
    if not m:
        return None
    return m.group(1), int(m.group(2)), int(m.group(3)) if m.group(3) else None, int(m.group(4)) if m.group(4) else None


def covers(expected, shown, strict=True):
    x, y = parse_label(expected), parse_label(shown)
    if not x or not y:
        return norm_label(expected) == norm_label(shown)
    if x[0] != y[0] or x[1] != y[1]:
        return False
    if x[2] is None and y[2] is None:
        return True
    if x[2] is not None and y[2] is not None:
        return x[2] <= y[2] <= (x[3] or x[2])
    return not strict


def refine_times(refs, segs):
    """segs: [(start, end, text)]. Move spoken_end_s to the segment where the
    heard words end, searching 40 s around the labelled time."""
    flat = []  # (word, seg_end)
    for s, e, t in segs:
        for w in words(t):
            flat.append((w, s, e))
    for r in refs:
        hw = words(r.get("heard", ""))
        if len(hw) < 2:
            continue
        lo, hi = r["spoken_start_s"] - 40, r["spoken_end_s"] + 40
        idx = [i for i, (_, s, _) in enumerate(flat) if lo <= s <= hi]
        best, best_i = 0.0, None
        for i in idx:
            window = [w for w, _, _ in flat[i:i + len(hw)]]
            sc = SequenceMatcher(None, hw, window).ratio()
            if sc > best:
                best, best_i = sc, i
        if best_i is not None and best >= 0.6:
            j = min(best_i + len(hw) - 1, len(flat) - 1)
            r["spoken_start_s"] = round(flat[best_i][1], 2)
            r["spoken_end_s"] = round(flat[j][2], 2)
            r["pinned"] = round(best, 2)
    return refs


def score(refs, shown):
    out = {"found": 0, "already": 0, "missed": [], "wrong": [], "hits": []}
    scored = [r for r in refs if r["kind"] == "explicit"]
    for r in scored:
        hit = next((s for s in shown if covers(r["label"], s["label"]) and r["spoken_start_s"] - 5 <= s["t"] <= r["spoken_end_s"] + 30), None)
        if hit:
            out["found"] += 1
            out["hits"].append({"label": r["label"], "at": r["spoken_end_s"], "delay": round(hit["t"] - r["spoken_end_s"], 2)})
        elif any(covers(r["label"], s["label"]) and s["t"] < r["spoken_start_s"] and r["spoken_start_s"] - s["t"] < 180 for s in shown):
            out["found"] += 1
            out["already"] += 1
        else:
            out["missed"].append({"label": r["label"], "at": r["spoken_end_s"], "heard": r.get("heard", ""), "note": r.get("note", "")})
    for s in shown:
        if not any(covers(r["label"], s["label"], strict=False) and abs(s["t"] - r["spoken_end_s"]) <= 60 for r in refs):
            out["wrong"].append({"label": s["label"], "at": round(s["t"], 1), "trigger": s["trigger"][:160]})
    out["scored"] = len(scored)
    return out


def densest_clip(refs, dur):
    ts = [r["spoken_end_s"] for r in refs if r["kind"] == "explicit"]
    if dur <= CLIP_S:
        return [0, dur]
    best, start = -1, 0
    for t in ts:
        a = max(0, min(t - 60, dur - CLIP_S))
        n = sum(1 for x in ts if a <= x <= a + CLIP_S - 30)
        if n > best:
            best, start = n, a
    return [round(start, 1), round(start + CLIP_S, 1)]


def main():
    replay = None
    if "--replay" in sys.argv:
        replay = sys.argv[sys.argv.index("--replay") + 1]
    sources = {}
    if os.path.exists(os.path.join(REAL, "sources.txt")):
        for line in open(os.path.join(REAL, "sources.txt")):
            if "|" in line:
                k, v = line.strip().split("|", 1)
                sources[k] = v
    report = []
    for fn in sorted(os.listdir(os.path.join(REAL, "labels"))):
        if not fn.endswith(".labels.json"):
            continue
        slug = fn[: -len(".labels.json")]
        lab = json.load(open(os.path.join(REAL, "labels", fn)))
        ref = json.load(open(os.path.join(REAL, slug + ".ref.json")))
        segs = [(s["offsets"]["from"] / 1000, s["offsets"]["to"] / 1000, s["text"]) for s in ref["transcription"]]
        dur = segs[-1][1] if segs else 0
        refs = refine_times(lab["refs"], segs)
        fx = {"wav": slug + ".wav", "clip": densest_clip(refs, dur), "refs": refs}
        json.dump(fx, open(os.path.join(REAL, slug + ".json"), "w"), indent=1)
        entry = {"slug": slug, "source": sources.get(slug, slug), "duration_s": round(dur), "labels": lab,
                 "kinds": {k: sum(1 for r in refs if r["kind"] == k) for k in ["explicit", "chapter", "followup", "quote"]}}
        app = os.path.join(REAL, "app", slug + ".finals.json")
        if os.path.exists(app):
            dump = json.load(open(app))
            entry["score"] = score(refs, dump["shown"])
            entry["shown_count"] = len(dump["shown"])
            if replay:
                rp = subprocess.run(["node", replay, app], capture_output=True, text=True)
                if rp.returncode == 0:
                    entry["replay"] = json.loads(rp.stdout)
        after = os.path.join(REAL, "app", slug + ".after.json")
        if os.path.exists(app):
            subprocess.run([os.path.join(ROOT, "desktop", "target", "release", "examples", "redetect"), app, after], check=True)
            ad = json.load(open(after))
            entry["after"] = score(refs, ad["shown"])
            if replay:
                rp = subprocess.run(["node", replay, after], capture_output=True, text=True)
                if rp.returncode == 0:
                    entry["after_replay"] = json.loads(rp.stdout)
        llm = os.path.join(REAL, "app", slug + ".llm.json")
        if os.path.exists(llm):
            entry["llm"] = json.load(open(llm))
        stream = os.path.join(REAL, "app", slug + ".stream.json")
        if os.path.exists(stream):
            sd = json.load(open(stream))
            clip_refs = [r for r in refs if sd["clip"][0] <= r["spoken_start_s"] and r["spoken_end_s"] <= sd["clip"][1]]
            entry["stream"] = score(clip_refs, sd["shown"])
            entry["stream"]["clip"] = sd["clip"]
        report.append(entry)
        s = entry.get("score")
        a = entry.get("after")
        print(f"{slug:42} explicit {entry['kinds']['explicit']:3}  " + (f"before: found {s['found']:3}/{s['scored']:<3} wrong {len(s['wrong']):2}   after: found {a['found']:3} wrong {len(a['wrong']):2}" if s else "(no app run yet)"))
    json.dump(report, open(os.path.join(REAL, "report.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
