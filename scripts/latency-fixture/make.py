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

# Harder set: books whisper often mangles, ordinal books, ranges, single-chapter
# books, and verse-only follow-ups. Fewer filler words between references.
SERMON_HARD = [
    ("Our foundation this morning is", None),
    ("First Corinthians 13 verse 4", "1 Corinthians 13:4"),
    ("love is patient, love is kind.", None),
    ("Paul tells his son in the faith in", None),
    ("Second Timothy 3 16", "2 Timothy 3:16"),
    ("that all scripture is given by inspiration of God.", None),
    ("||", None),
    ("The prophet", None),
    ("Habakkuk chapter 2 verse 3", "Habakkuk 2:3"),
    ("says the vision is yet for an appointed time.", None),
    ("And the preacher in", None),
    ("Ecclesiastes 3 1", "Ecclesiastes 3:1"),
    ("says to everything there is a season.", None),
    ("Look at", None),
    ("Lamentations 3 22 to 23", "Lamentations 3:22-23"),
    ("his mercies are new every morning.", None),
    ("||", None),
    ("Little books matter too. In", None),
    ("Zephaniah 3 17", "Zephaniah 3:17"),
    ("he rejoices over you with singing. And", None),
    ("Nahum 1 7", "Nahum 1:7"),
    ("the Lord is good, a stronghold in the day of trouble.", None),
    ("John writes in", None),
    ("First John 1 9", "1 John 1:9"),
    ("if we confess our sins he is faithful.", None),
    ("||", None),
    ("Moses told the people in", None),
    ("Deuteronomy 31 verse 6", "Deuteronomy 31:6"),
    ("be strong and of good courage. And", None),
    ("Micah 6 8", "Micah 6:8"),
    ("asks what does the Lord require of thee.", None),
    ("Turn to", None),
    ("Jeremiah 29 11", "Jeremiah 29:11"),
    ("for I know the thoughts that I think toward you.", None),
    ("||", None),
    ("Solomon says in", None),
    ("Proverbs 3 verses 5 and 6", "Proverbs 3:5-6"),
    ("trust in the Lord with all thine heart.", None),
    ("Jesus said in", None),
    ("Matthew 6 33", "Matthew 6:33"),
    ("seek ye first the kingdom of God.", None),
    ("Paul says in", None),
    ("Ephesians 2 8", "Ephesians 2:8"),
    ("for by grace are ye saved through faith.", None),
    ("||", None),
    ("James puts it plainly in", None),
    ("James 1 2", "James 1:2"),
    ("count it all joy. And God told", None),
    ("Joshua chapter 1 verse 9", "Joshua 1:9"),
    ("be strong and courageous.", None),
    ("Bring the tithes, says", None),
    ("Malachi 3 10", "Malachi 3:10"),
    ("and see if I will not open the windows of heaven.", None),
    ("||", None),
    ("Finally,", None),
    ("Revelation 21 4", "Revelation 21:4"),
    ("God shall wipe away all tears from their eyes. Amen.", None),
]

SERMONS = {"sermon1": SERMON, "hard": SERMON_HARD}

def sh(*a):
    subprocess.run(a, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def main(name="sermon1", voice="Daniel", rate="175", room="dry"):
    """room: dry (light pink noise) or hall (echo + louder noise + hum)."""
    parts = SERMONS[name.split("-")[0]]
    os.makedirs(OUT, exist_ok=True)
    tmp = tempfile.mkdtemp()
    raw = []  # list of float sample counts per clip
    files = []
    expected = []
    t = 1.0  # lead-in silence
    lead = os.path.join(tmp, "lead.wav")
    sh("ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r={SR}:cl=mono", "-t", "1.0", lead)
    files.append(lead)
    for i, (text, label) in enumerate(parts):
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
    if room == "hall":
        # sanctuary-ish: two early reflections plus a long tail, room noise and 60 Hz hum
        fc = ("[0:a]aecho=0.8:0.7:60|180|420:0.35|0.25|0.18,volume=0.8[v];"
              f"[1:a]volume=1[n];[2:a]volume=0.006[h];[v][n][h]amix=inputs=3:duration=first:normalize=0")
        noise = f"anoisesrc=color=pink:amplitude=0.02:r={SR}"
    else:
        fc = "[0:a][1:a][2:a]amix=inputs=3:duration=first:normalize=0"
        noise = f"anoisesrc=color=pink:amplitude=0.004:r={SR}"
    sh("ffmpeg", "-y", "-i", clean, "-f", "lavfi", "-i", noise, "-f", "lavfi", "-i",
       f"sine=frequency=60:sample_rate={SR}" if room == "hall" else f"anullsrc=r={SR}:cl=mono",
       "-filter_complex", fc, "-ar", str(SR), "-ac", "1", "-c:a", "pcm_s16le", out_wav)
    with open(os.path.join(OUT, name + ".json"), "w") as f:
        json.dump({"wav": name + ".wav", "duration_s": round(t, 3), "refs": expected}, f, indent=2)
    print(out_wav, round(t, 1), "s,", len(expected), "refs")

if __name__ == "__main__":
    main(*sys.argv[1:])
