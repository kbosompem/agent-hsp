#!/usr/bin/env python3
"""whisper-cli -oj output -> '[start-end] text' lines of about 6 s, for labelling."""
import json, sys
d = json.load(open(sys.argv[1]))
block, b0, b1 = [], None, None
for seg in d["transcription"]:
    s, e = seg["offsets"]["from"] / 1000, seg["offsets"]["to"] / 1000
    if b0 is None:
        b0 = s
    block.append(seg["text"].strip())
    b1 = e
    if b1 - b0 >= 6:
        print(f"[{b0:.0f}-{b1:.0f}] {' '.join(block)}")
        block, b0 = [], None
if block:
    print(f"[{b0:.0f}-{b1:.0f}] {' '.join(block)}")
