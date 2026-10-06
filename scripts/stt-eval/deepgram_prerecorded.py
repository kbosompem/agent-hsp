#!/usr/bin/env python3
"""Transcribe sermons with Deepgram's pre-recorded API and write finals dumps
in the app's format, for score_alt.py.

  DG_KEY=... python3 scripts/stt-eval/deepgram_prerecorded.py <variant> [--keyterms FILE]
      [--smart-format] [--numerals] [--model nova-3] [--utt-split 0.8] [--slugs a,b] [--jobs 4]

Raw responses: fixtures/real/alt/deepgram-raw/<variant>/<slug>.json (kept, so
a re-run only converts). Finals: fixtures/real/alt/<variant>/<slug>.finals.json
with one final per Deepgram utterance, t = utterance end.
The API key is read from the DG_KEY environment variable only.
"""
import argparse, concurrent.futures as cf, json, os, sys, time
import requests

sys.path.insert(0, os.path.dirname(__file__))
from score_alt import slugs as scored_slugs, REAL  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("variant")
ap.add_argument("--model", default="nova-3")
ap.add_argument("--keyterms", default="")
ap.add_argument("--smart-format", action="store_true")
ap.add_argument("--numerals", action="store_true")
ap.add_argument("--utt-split", type=float, default=0.8)
ap.add_argument("--slugs", default="")
ap.add_argument("--jobs", type=int, default=4)
a = ap.parse_args()

RAW = os.path.join(REAL, "alt", "deepgram-raw", a.variant)
OUT = os.path.join(REAL, "alt", a.variant)
os.makedirs(RAW, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

params = [("model", a.model), ("language", "en"), ("punctuate", "true"), ("utterances", "true"),
          ("utt_split", str(a.utt_split)), ("smart_format", str(a.smart_format).lower()),
          ("numerals", str(a.numerals).lower())]
if a.keyterms:
    params += [("keyterm", t.strip()) for t in open(a.keyterms) if t.strip()]


def to_finals(resp):
    utts = resp["results"]["utterances"]
    finals = [{"t": round(u["end"], 3), "t_first_word": round(u["start"], 3), "text": u["transcript"], "seg": i}
              for i, u in enumerate(utts) if u["transcript"].strip()]
    dur = resp["metadata"].get("duration")
    return {"clip": None, "finals": finals, "stats": {"audio_s": dur, "n_finals": len(finals),
                                                       "request_id": resp["metadata"].get("request_id"),
                                                       "config": {k: v for k, v in params if k != "keyterm"},
                                                       "keyterms": len([p for p in params if p[0] == "keyterm"])}}


def one(slug):
    raw = os.path.join(RAW, slug + ".json")
    if not os.path.exists(raw):
        key = os.environ["DG_KEY"]
        t0 = time.time()
        with open(os.path.join(REAL, slug + ".wav"), "rb") as f:
            r = requests.post("https://api.deepgram.com/v1/listen", params=params, data=f, timeout=1800,
                              headers={"Authorization": "Token " + key, "Content-Type": "audio/wav"})
        if r.status_code != 200:
            return f"{slug}: HTTP {r.status_code} {r.text[:300]}"
        json.dump(r.json(), open(raw, "w"))
        took = time.time() - t0
    else:
        took = 0
    resp = json.load(open(raw))
    d = to_finals(resp)
    json.dump(d, open(os.path.join(OUT, slug + ".finals.json"), "w"), indent=1)
    return f"{slug}: {d['stats']['audio_s']:.0f}s audio, {d['stats']['n_finals']} utterances, {took:.0f}s"


ss = a.slugs.split(",") if a.slugs else scored_slugs()
with cf.ThreadPoolExecutor(a.jobs) as ex:
    for line in ex.map(one, ss):
        print(line, flush=True)
