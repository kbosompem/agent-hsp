#!/usr/bin/env python3
"""Closing summary slide from the app's own transcript, written by a small
local model (Llama 3.2 3B via llama.cpp's llama-server). Shows what the
planned LLM summary would put on screen, next to the rule-based slides.

  python3 scripts/latency-fixture/llm_summary.py            # all sermons with app runs
Writes fixtures/real/app/<slug>.llm.json.
"""
import json, os, subprocess, sys, time, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
APP = os.path.join(ROOT, "fixtures", "real", "app")
MODEL = os.path.expanduser("~/Library/Application Support/com.agenthsp.desktop/models/llama-3.2-3b-instruct-q4_k_m.gguf")
PORT = 8099
MAX_WORDS = 9000

SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "big_idea": {"type": "string"},
        "points": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"text": {"type": "string"}, "verses": {"type": "array", "items": {"type": "string"}}},
                "required": ["text", "verses"],
            },
        },
    },
    "required": ["title", "big_idea", "points"],
}

PROMPT = """You write the closing summary slide for a church projector.

Below is an automatic transcript of a sermon. It has speech-recognition errors. After it is the list of Bible verses that were shown on screen during the sermon.

Write:
- title: the sermon title, at most 8 words. Use the preacher's stated title or topic if he gives one.
- big_idea: one sentence, at most 20 words, that a listener could repeat.
- points: 3 or 4 main points in the order preached, each at most 10 words, each with 0 to 2 supporting verses taken only from the shown list.

Use plain words. Do not invent verses.

TRANSCRIPT:
{transcript}

VERSES SHOWN:
{verses}
"""


def post(path, body):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read())


def main():
    server = subprocess.Popen(
        ["llama-server", "-m", MODEL, "-c", "16384", "-ngl", "99", "--port", str(PORT), "-np", "1"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(120):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2)
                break
            except Exception:
                time.sleep(1)
        for fn in sorted(os.listdir(APP)):
            if not fn.endswith(".after.json"):
                continue
            slug = fn[: -len(".after.json")]
            out = os.path.join(APP, slug + ".llm.json")
            if os.path.exists(out) and "--force" not in sys.argv:
                continue
            d = json.load(open(os.path.join(APP, fn)))
            words = " ".join(f["text"] for f in d["finals"]).split()
            if len(words) > MAX_WORDS:
                # keep the opening (title, text) and the close (application)
                words = words[: MAX_WORDS * 2 // 3] + ["..."] + words[-MAX_WORDS // 3 :]
            verses = list(dict.fromkeys(s["label"] for s in d["shown"]))
            t0 = time.time()
            r = post("/v1/chat/completions", {
                "messages": [{"role": "user", "content": PROMPT.format(transcript=" ".join(words), verses=", ".join(verses) or "(none)")}],
                "temperature": 0.2,
                "response_format": {"type": "json_object", "schema": SCHEMA},
            })
            content = json.loads(r["choices"][0]["message"]["content"])
            content["_seconds"] = round(time.time() - t0, 1)
            content["_words_in"] = len(words)
            json.dump(content, open(out, "w"), indent=1)
            print(f"{slug:42} {content['_seconds']:6.1f}s  {content['title']}")
    finally:
        server.terminate()


if __name__ == "__main__":
    main()
