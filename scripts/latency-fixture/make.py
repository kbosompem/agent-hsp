#!/usr/bin/env python3
"""Build a synthetic sermon WAV with known reference timings.

Uses macOS `say` and ffmpeg. Each part is (text, expected_label or None).
Parts join with short phrase pauses; "||" inserts a longer breath.
Output: fixtures/latency/<name>.wav (16 kHz mono) and <name>.json listing
each reference's expected label and the time (s) it finishes being spoken.
Low pink noise is mixed in so the voice detector has a real noise floor.
"""
import json, os, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "fixtures", "latency")
SR = 16000

SERMON = [
    ("Good morning church. Turn with me in your Bibles this morning to", None),
    ("John chapter 3 verse 16", "John 3:16"),
    ("where the Lord tells us how much he loved the world, and I want us to sit with that for a moment.", None),
    ("||", None),
    ("Paul says it another way. Look at", None),
    ("Romans 5 verse 8", "Romans 5:8"),
    ("because while we were yet sinners, Christ died for us. Not after we cleaned up. While.", None),
    ("||", None),
    ("And when you feel like you cannot go on, remember", None),
    ("Philippians 4 13", "Philippians 4:13"),
    ("and keep walking, church, keep walking even when the road is long.", None),
    ("The psalmist knew this too. In", None),
    ("Psalm 23 verse 1", "Psalms 23:1"),
    ("he says the Lord is my shepherd, so I lack nothing at all.", None),
    ("||", None),
    ("Let me take you to the prophet. Turn to", None),
    ("Isaiah chapter 40 verse 31", "Isaiah 40:31"),
    ("they that wait upon the Lord shall renew their strength, and that is a promise for you today.", None),
    ("Finally, look at", None),
    ("Hebrews 11 1", "Hebrews 11:1"),
    ("faith is the substance of things hoped for. Hold on to that this week.", None),
]

def sh(*a):
    subprocess.run(a, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def main(name="sermon1", voice="Daniel", rate="175"):
    os.makedirs(OUT, exist_ok=True)
    tmp = tempfile.mkdtemp()
    raw = []  # list of float sample counts per clip
    files = []
    expected = []
    t = 1.0  # lead-in silence
    lead = os.path.join(tmp, "lead.wav")
    sh("ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r={SR}:cl=mono", "-t", "1.0", lead)
    files.append(lead)
    for i, (text, label) in enumerate(SERMON):
        if text == "||":
            p = os.path.join(tmp, f"p{i}.wav")
            sh("ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r={SR}:cl=mono", "-t", "1.5", p)
            files.append(p); t += 1.5
            continue
        aiff = os.path.join(tmp, f"c{i}.aiff")
        wav = os.path.join(tmp, f"c{i}.wav")
        sh("say", "-v", voice, "-r", rate, "-o", aiff, text)
        # trim say's leading/trailing silence so offsets are exact
        sh("ffmpeg", "-y", "-i", aiff, "-af",
           "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse",
           "-ar", str(SR), "-ac", "1", wav)
        dur = float(subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav]).strip())
        files.append(wav); t += dur
        if label:
            expected.append({"label": label, "spoken_end_s": round(t, 3), "text": text})
        gap = os.path.join(tmp, f"g{i}.wav")
        sh("ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r={SR}:cl=mono", "-t", "0.25", gap)
        files.append(gap); t += 0.25
    tail = os.path.join(tmp, "tail.wav")
    sh("ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r={SR}:cl=mono", "-t", "3.0", tail)
    files.append(tail); t += 3.0
    lst = os.path.join(tmp, "list.txt")
    with open(lst, "w") as f:
        for p in files:
            f.write(f"file '{p}'\n")
    clean = os.path.join(tmp, "clean.wav")
    sh("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-ar", str(SR), "-ac", "1", clean)
    out_wav = os.path.join(OUT, name + ".wav")
    sh("ffmpeg", "-y", "-i", clean, "-f", "lavfi", "-i", f"anoisesrc=color=pink:amplitude=0.004:r={SR}",
       "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:normalize=0", "-ar", str(SR), "-ac", "1",
       "-c:a", "pcm_s16le", out_wav)
    with open(os.path.join(OUT, name + ".json"), "w") as f:
        json.dump({"wav": name + ".wav", "duration_s": round(t, 3), "refs": expected}, f, indent=2)
    print(out_wav, round(t, 1), "s,", len(expected), "refs")

if __name__ == "__main__":
    main(*sys.argv[1:])
