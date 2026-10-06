#!/usr/bin/env python3
"""Rebuild Deepgram finals from saved raw word timings with a different pause
threshold (no API call). A final closes when the gap to the next word is >= GAP s.

  python3 scripts/stt-eval/deepgram_regroup.py <raw-variant> <out-variant> <gap_s> [max_len_s]
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from score_alt import REAL  # noqa: E402

src, dst, gap = sys.argv[1], sys.argv[2], float(sys.argv[3])
max_len = float(sys.argv[4]) if len(sys.argv) > 4 else 1e9  # forced cut, seconds
raw_dir = os.path.join(REAL, "alt", "deepgram-raw", src)
out_dir = os.path.join(REAL, "alt", dst)
os.makedirs(out_dir, exist_ok=True)
for fn in sorted(os.listdir(raw_dir)):
    r = json.load(open(os.path.join(raw_dir, fn)))
    words = r["results"]["channels"][0]["alternatives"][0]["words"]
    finals, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        if i == len(words) - 1 or words[i + 1]["start"] - w["end"] >= gap or w["end"] - cur[0]["start"] >= max_len:
            finals.append({"t": round(w["end"], 3), "t_first_word": round(cur[0]["start"], 3),
                           "text": " ".join(x.get("punctuated_word", x["word"]) for x in cur), "seg": len(finals)})
            cur = []
    json.dump({"clip": None, "finals": finals}, open(os.path.join(out_dir, fn.replace(".json", ".finals.json")), "w"), indent=1)
