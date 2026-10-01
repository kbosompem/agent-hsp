# AMC Preso

**The sermon, on screen, by itself.**

A local-first worship presentation app. It listens to the preacher, puts the right Bible verse on the projector within seconds, runs the service flow on spoken cues, and writes the sermon summary — all on the church's own machine. No cloud. No subscription. No per-minute billing. Nothing spoken in the building ever leaves the building.

It combines what PewBeam does (real-time AI scripture display) with what VideoPsalm does (a full manual presentation toolkit) and adds a cue-driven automation engine neither of them has. See `plan.html` in this repo for the full product and engineering plan.

## Two codebases

| Path | What it is | Status |
|---|---|---|
| `alpha/` | Browser-based proof (Chrome/Edge). Proves verse detection, cue flows and the dual-window layout. Zero install. | Demo-safe |
| `desktop/` | The real product: Tauri 2 + Rust. Native audio capture, native whisper.cpp inference, native verse engine. | In active development |

## What works today (desktop)

- Full KJV embedded in Rust; ASV, WEB and BBE bundled; import any translation (Zefania, OpenSong, OSIS XML or JSON)
- Spoken references in all their forms: "john 3 16", "Romans five verse eight", "the third chapter of John", "psalm 91 1-2", homophone ranges ("verse 1 two 5")
- Verse ranges advance by voice: "next verse", "previous verse", "jump to verse 15"
- Spoken corrections: "Isaiah 2:14... sorry, chapter 3" updates the on-screen verse
- Verse lifecycle: instant show, 60-second hold, then a live summary slide
- Sermon outline capture: "the title of my message is...", "point number one..." drive the summary
- Instant show on the projector, NDI-ready layout, light/dark operator themes, output theme designer with auto-generated styling from any background image
- Whisper speech-to-text (tiny.en / base.en / small.en) running natively via whisper.cpp: Metal GPU on macOS, CPU on Windows. Default: small.en on Mac, base.en on Windows
- Hold (H), blackout (B), logo (L) and panic (Shift+Esc) safety keys

## In flight

- Quote matching: say "while we were yet sinners" without naming the verse and Romans 5:8 appears. Engine: precomputed verse embeddings + local sentence embeddings (MiniLM).
- Local LLM (Llama 3.2 3B via llama.cpp) for sermon theme/title generation and polished summary wording
- Silero VAD to replace the energy-based voice detector for noisy rooms
- Streaming partial transcripts for true sub-2-second verse display
- CI: GitHub Actions workflow builds macOS DMG and Windows NSIS installers on every push

## Build the desktop app

```bash
cd desktop
npm install
npm run tauri dev      # runs it
npm run tauri build    # installers
```

Prerequisites: Node 20+, Rust stable, CMake. The Whisper model (466 MB small.en on Mac, 142 MB base.en on Windows) downloads once into the app data folder on first use.

### Rebuild the verse quote index

Quote matching ships without its embedding index (about 47 MB). Generate it once:

```bash
cd scripts/verse-index
npm install
node build.js
```

### Measure verse speed and accuracy

`fixtures/latency/` holds synthetic sermons (macOS text-to-speech, some with simulated sanctuary echo and noise) with the time each reference is spoken. The harness replays them through the real segmenter, whisper and parser in simulated real time and reports verses found, wrong verses, and seconds from spoken to detected.

```bash
cd desktop && cargo build --release --example latency
../scripts/latency-fixture/run-all.sh small.en      # one line per fixture
python3 ../scripts/latency-fixture/make.py hard-tessa-hall Tessa 185 hall   # make a new fixture
```

## Repository layout

```
plan.html            product + engineering plan (start here)
website/             project website (static)
alpha/               browser proof (open alpha/index.html in Chrome)
desktop/             the Tauri desktop app
  crates/preso-core/ Rust verse engine: parser, KJV+translations, corrections
  src-tauri/         Tauri shell: audio capture, whisper.cpp, commands
  src/               console + output window frontends
scripts/             offline tooling (verse index builder)
fixtures/            labeled sermon audio for the test harness (growing)
```

## Testing philosophy

Every verse-parsing fix lands with a test. The parser corpus covers spoken forms, homophones, ranges, corrections and negatives ("John the Baptist" must never fire John 3:3). 25 Rust tests and 36 browser tests as of this writing.

## License

Code: MIT. Bible text: KJV, ASV, WEB, BBE are public domain and bundled. Copyrighted translations (NIV, NLT, NASB, NKJV, NIRV, AMP, The Message) are never bundled or redistributed; users import files they have rights to use.
