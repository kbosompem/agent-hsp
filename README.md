# Agent HSP

*High Speed Projection.* The projectionist is called the HSP; Agent HSP is an AI projectionist that works alongside them.

**The sermon, on screen, by itself.**

A local-first worship presentation app. It listens to the preacher, puts the right Bible verse on the projector within seconds, follows the reading verse by verse, and builds a sermon summary slide, all on the church's own machine. No cloud. No subscription. No per-minute billing. Nothing spoken in the building ever leaves the building.

The goal is to combine what PewBeam does (real-time AI scripture display) with what VideoPsalm does (a full manual presentation toolkit), and add a cue-driven automation engine neither of them has. Today the desktop app does the scripture part. Service flow, songs and spoken "HSP" commands are on the roadmap. See `plan.html` for the full product and engineering plan.

## Download

Installers for macOS (`.dmg`, Apple Silicon) and Windows (`.exe`) are on the [GitHub Releases page](https://github.com/kbosompem/agent-hsp/releases).

The installers are not signed yet, so your computer will warn you the first time:

- **Windows:** SmartScreen says "Windows protected your PC". Click **More info**, then **Run anyway**.
- **macOS:** Gatekeeper says the app cannot be checked for malicious software. Open **System Settings > Privacy & Security**, scroll down, and click **Open Anyway** next to Agent HSP. Then allow microphone access when asked.

On first use, click **Load model** to download the speech model (466 MB `small.en` on Mac, 142 MB `base.en` on Windows). It downloads once and then runs offline.

## Two codebases

| Path | What it is | Status |
|---|---|---|
| `alpha/` | Browser-based proof (Chrome/Edge). Proves verse detection, cue flows and the dual-window layout. Zero install. | Demo-safe |
| `desktop/` | The real product: Tauri 2 + Rust. Native audio capture, native whisper.cpp inference, native verse engine. | In active development |

## What works today (desktop)

- Full KJV embedded in Rust; ASV, WEB, BBE, Berean Standard Bible (BSB), Literal Standard Version (LSV) and Free Bible Version (FBV) bundled; import any translation (Zefania, OpenSong, OSIS XML or JSON)
- Spoken references in all their forms: "john 3 16", "Romans five verse eight", "the third chapter of John", "psalm 91 1-2", homophone ranges ("verse 1 two 5"), glued numbers ("Philippians 413")
- Streaming partial transcripts: verses show about 1.4 seconds after the reference is spoken on our test fixtures
- Follow-up verses: "verse 6 says..." shows verse 6 of the chapter that is open
- Follows the reading: while a range like Matthew 5:1-12 is up, the screen moves to the next verse as the preacher reads it
- Verse navigation by voice: "next verse", "previous verse", "jump to verse 15", "show it again"
- Translation by voice: "show NLT", "read it in the NIV" (for translations you have imported)
- Spoken corrections: "Isaiah 2:14... sorry, chapter 3" updates the on-screen verse
- Quote matching: say "while we were yet sinners" without naming the verse and Romans 5:8 appears. Engine: precomputed verse embeddings plus local sentence embeddings (MiniLM). Needs the verse index (see below).
- Verse lifecycle: instant show; the verse stays up until the next one. The summary slide shows only when the operator asks for it
- Sermon outline capture: "the title of my message is...", "point number one..." drive the summary
- Instant show on the projector, light/dark operator themes, output theme designer with auto-generated styling from any background image
- Projector text scales with the screen, with a text-size control (Theme slider, A- / A+ on the console preview)
- Whisper speech-to-text (tiny.en / base.en / small.en) running natively via whisper.cpp: Metal GPU on macOS, CPU on Windows. Default: small.en on Mac, base.en on Windows
- CI: a GitHub Actions workflow builds the macOS DMG and Windows NSIS installer on every push to `main`

## In flight

- Safety keys on the desktop console: hold (H), blackout (B), logo (L) and panic (Shift+Esc). These exist in the browser alpha only today.
- "HSP" voice commands for the projectionist
- Service agenda, song library and lyrics, presentations and video
- Local LLM (Llama 3.2 3B via llama.cpp) for sermon theme/title generation and polished summary wording
- Silero VAD to replace the energy-based voice detector for noisy rooms
- Code signing, notarization and auto-update

See [ROADMAP.md](ROADMAP.md) for the full list and where to help.

## Build the desktop app

```bash
cd desktop
npm install
npm run tauri dev      # runs it
npm run tauri build    # installers
```

Prerequisites: Node 20+, Rust stable, CMake. Windows also needs the Visual Studio C++ Build Tools and LLVM. [CONTRIBUTING.md](CONTRIBUTING.md) has the full list per OS. The Whisper model downloads once into the app data folder on first use.

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
ARCHITECTURE.md      how audio becomes a verse on screen
CONTRIBUTING.md      set up, test, and send a pull request
CHANGELOG.md         what changed in each version
ROADMAP.md           planned work
docs/RELEASING.md    how to cut a release
website/             project website (static)
alpha/               browser proof (open alpha/index.html in Chrome)
desktop/             the Tauri desktop app
  crates/preso-core/ Rust verse engine: parser, KJV+translations, live context
  src-tauri/         Tauri shell: audio capture, segmenter, whisper.cpp, commands
  src/               console + output window frontends
scripts/             offline tooling (verse index builder, latency fixtures)
fixtures/            labeled sermon audio for the test harness (growing)
```

## Testing philosophy

Every verse-parsing fix lands with a test. The parser corpus covers spoken forms, homophones, ranges, follow-ups and negatives ("John the Baptist" must never fire John 3:3). 40 Rust tests and 36 browser tests as of this writing, plus the latency harness and real-sermon replays.

## Contributing

Church volunteers are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the pull request flow, [ARCHITECTURE.md](ARCHITECTURE.md) for how the code fits together, and [ROADMAP.md](ROADMAP.md) for what to work on.

## License

Code: to be decided. See LICENSE once added. Bible text: KJV, ASV, WEB, BBE and BSB are public domain and bundled. LSV and FBV are bundled under Creative Commons Attribution-ShareAlike 4.0 (CC BY-SA 4.0). Licences, copyright holders, sources and the changes we made are listed in [desktop/crates/preso-core/assets/BIBLES.md](desktop/crates/preso-core/assets/BIBLES.md). Copyrighted translations (NIV, NLT, NASB, NKJV, NIRV, AMP, The Message) are never bundled or redistributed; users import files they have rights to use.
