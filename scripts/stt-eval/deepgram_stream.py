#!/usr/bin/env python3
"""Stream a sermon clip to Deepgram's live websocket in real time (100 ms
chunks, paced by the wall clock) and record every interim and final
transcript with its arrival time on the recording clock.

  DG_KEY=... python3 scripts/stt-eval/deepgram_stream.py <slug> [--keyterms FILE]
      [--model nova-3] [--endpointing 400] [--variant deepgram-stream]

The clip is the densest 15 minutes from fixtures/real/<slug>.json (written by
score_real.py). Writes fixtures/real/alt/<variant>/<slug>.events.json:
{"clip": [a, b], "events": [{"t", "text", "final", "speech_final", "seg", "audio_end"}]}
for examples/replay_events.rs, plus the raw messages next to it.
The API key is read from the DG_KEY environment variable only.
"""
import argparse, asyncio, json, os, sys, time, wave
from urllib.parse import urlencode
import websockets

sys.path.insert(0, os.path.dirname(__file__))
from score_alt import REAL  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("slug")
ap.add_argument("--model", default="nova-3")
ap.add_argument("--keyterms", default="")
ap.add_argument("--endpointing", type=int, default=400)
ap.add_argument("--variant", default="deepgram-stream")
a = ap.parse_args()

fx = json.load(open(os.path.join(REAL, a.slug + ".json")))
c0, c1 = fx["clip"]
w = wave.open(os.path.join(REAL, a.slug + ".wav"))
assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2
w.setpos(int(c0 * 16000))
pcm = w.readframes(int((c1 - c0) * 16000))

params = [("model", a.model), ("language", "en"), ("encoding", "linear16"), ("sample_rate", "16000"),
          ("channels", "1"), ("interim_results", "true"), ("endpointing", str(a.endpointing)),
          ("punctuate", "true"), ("smart_format", "false")]
if a.keyterms:
    params += [("keyterm", t.strip()) for t in open(a.keyterms) if t.strip()]
url = "wss://api.deepgram.com/v1/listen?" + urlencode(params)
out_dir = os.path.join(REAL, "alt", a.variant)
os.makedirs(out_dir, exist_ok=True)
CHUNK = 3200  # 100 ms of 16-bit mono at 16 kHz


async def main():
    events, raw = [], []
    seg = 0
    async with websockets.connect(url, additional_headers={"Authorization": "Token " + os.environ["DG_KEY"]},
                                  max_size=None) as ws:
        t0 = time.monotonic()

        async def send():
            for i in range(0, len(pcm), CHUNK):
                due = t0 + i / 32000
                await asyncio.sleep(max(0, due - time.monotonic()))
                await ws.send(pcm[i:i + CHUNK])
            await ws.send(json.dumps({"type": "CloseStream"}))

        async def recv():
            nonlocal seg
            async for m in ws:
                now = c0 + time.monotonic() - t0
                d = json.loads(m)
                raw.append({"arrival": round(now, 3), "msg": d})
                if d.get("type") != "Results":
                    continue
                text = d["channel"]["alternatives"][0]["transcript"].strip()
                fin = bool(d.get("is_final"))
                if text:
                    events.append({"t": round(now, 3), "text": text, "final": fin,
                                   "speech_final": bool(d.get("speech_final")), "seg": seg,
                                   "audio_end": round(c0 + d["start"] + d["duration"], 3)})
                if fin:
                    seg += 1

        await asyncio.gather(send(), recv())
    json.dump({"clip": [c0, c1], "events": events}, open(os.path.join(out_dir, a.slug + ".events.json"), "w"), indent=1)
    json.dump(raw, open(os.path.join(out_dir, a.slug + ".raw.json"), "w"))
    lag = sorted(e["t"] - e["audio_end"] for e in events if e["final"])
    print(f"{a.slug}: {len(events)} events, finals {len(lag)}, "
          f"final arrival after audio end p50 {lag[len(lag)//2]:.2f}s p90 {lag[int(len(lag)*.9)]:.2f}s")


asyncio.run(main())
