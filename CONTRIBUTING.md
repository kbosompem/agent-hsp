# Contributing to Agent HSP

Thank you for helping. Agent HSP is built for church volunteers, and it is built by them too. You do not need to be an expert. Small, careful fixes are the most useful thing you can send.

Read `ARCHITECTURE.md` first if you want to know how the pieces fit.

## What you need

All platforms:

- **Node.js 20 or newer.** Runs the console and output windows during development.
- **Rust (stable).** Install with [rustup](https://rustup.rs). The app's native side is Rust.
- **CMake.** whisper.cpp (the speech model engine) is C++ and is built with CMake during `cargo build`.
- **Git.**

### macOS

1. Install the Xcode Command Line Tools: `xcode-select --install`. This gives you the C/C++ compiler and the Metal GPU framework.
2. Install CMake: `brew install cmake` (or from cmake.org).
3. Install Node 20+ and Rust stable.

Apple Silicon is the main test machine. Intel Macs should build but are not tested.

### Windows 10 / 11

1. Install **Visual Studio 2022 Build Tools** with the "Desktop development with C++" workload.
2. Install **CMake** and make sure it is on your PATH.
3. Install **LLVM** (for example `winget install LLVM.LLVM`). The whisper-rs build uses `bindgen`, which needs `libclang` from LLVM. If you cannot install LLVM, set `WHISPER_DONT_GENERATE_BINDINGS=1` before building to use the bindings that ship with the crate.
4. Install Node 20+ and Rust stable (choose the MSVC toolchain).
5. WebView2 is already part of Windows 10 and 11. Tauri uses it to draw the windows.

Windows runs speech recognition on the CPU, so it is slower than a Mac. The Windows build is not yet verified end to end (GitHub issue #19). Reports from Windows users are very welcome.

### Linux

Not supported yet. It may build, but nobody tests it.

## Get the code and run it

1. Fork `github.com/kbosompem/agent-hsp` on GitHub.
2. Clone your fork and start the app:

```bash
git clone https://github.com/<you>/agent-hsp.git
cd agent-hsp/desktop
npm install
npm run tauri dev
```

The first build compiles whisper.cpp and takes several minutes. Later builds are much faster.

3. In the app, click **Load model**. The speech model (466 MB `small.en` on Mac, 142 MB `base.en` on Windows) downloads once into the app data folder.
4. Optional: build the quote-matching index (about 47 MB, not in git). Without it, everything except quote matching still works.

```bash
cd scripts/verse-index
npm install
node build.js
```

To build installers on your own machine: `cd desktop && npm run tauri build`. Output goes to `desktop/target/release/bundle/`.

## Run the tests

Run these before you open a pull request.

```bash
cd desktop

# Rust: verse parser, LiveLookup, segmenter
cargo test -p preso-core
cargo test -p agent-hsp --lib

# TypeScript type check (must pass)
npx tsc --noEmit

# Voice helper tests (following a reading, translation requests)
npx esbuild scripts/test-voice.ts --bundle --platform=node --outfile=/tmp/tv.js && node /tmp/tv.js
npx esbuild scripts/test-library.ts --bundle --platform=node --outfile=/tmp/tl.js && node /tmp/tl.js

# Browser alpha parser tests (only if you touched alpha/)
cd .. && node alpha/test.js
```

If `cargo` fails with "failed to read plugin permissions" after you moved or renamed your checkout, run `cargo clean` in `desktop/` and try again.

**Every verse-parsing fix lands with a test.** Add a case to the `tests` module at the bottom of `desktop/crates/preso-core/src/lib.rs`. Add negatives too: a phrase that must not show a verse (for example "John the Baptist").

## Measure speed and accuracy (latency harness)

If you change the segmenter, whisper settings, or the parser, run the harness. It replays recorded sermons through the real pipeline and reports verses found, wrong verses, and seconds from spoken to detected.

```bash
cd desktop
cargo build --release --example latency
../scripts/latency-fixture/run-all.sh small.en
```

`run-all.sh` looks for models in the macOS app data folder, so run the app and click **Load model** first. On Windows, call the binary directly:

```bash
target/release/examples/latency <path to ggml-base.en.bin> ../fixtures/latency/sermon1.json streaming
```

Put the before and after numbers in your pull request. A change that finds more verses but adds wrong verses needs a clear reason.

To make a new fixture (macOS only, needs `ffmpeg`):

```bash
python3 scripts/latency-fixture/make.py hard-tessa-hall Tessa 185 hall
```

## Branches and pull requests

1. Fork the repo and branch off `main`. Name the branch after the change, for example `fix-psalm-plural` or `windows-mic-list`.
2. Keep pull requests small. One concern per pull request. A parser fix and a UI change are two pull requests.
3. In the description, say:
   - what problem you fixed and how a user would notice it,
   - how you tested it (which tests, which fixtures, which OS and model),
   - before and after harness numbers if speed or accuracy can change.
4. For any UI change, add a screenshot or short screen recording of the console and, if it changed, the projector output.
5. Link the GitHub issue if there is one.
6. A maintainer will review. Expect questions. That is normal.

## Commit messages

Match the style in `git log`:

- One plain-English summary line in the imperative: "Stop quote matches hijacking a reading", "Add Windows .ico and macOS .icns so the Windows installer build succeeds".
- Say what changes for the user, not which function you edited.
- If it needs more, add a blank line and a short body. Bullets are fine. Explain why, and include numbers when you have them.

## Code style

- Match the code around you. Read the file before you change it.
- Rust: run `cargo fmt` on the files you touched.
- TypeScript: `npx tsc --noEmit` must pass. The project uses `strict`, and unused variables are errors.
- Keep pure logic out of Tauri and React when you can. `segmenter.rs`, `preso-core`, `lib/voice.ts` and `lib/sermon.ts` are pure so they can be tested and replayed offline. Follow that pattern.
- Comments explain why, in short sentences. Many comments in this codebase cite the live test or sermon that caused the change. That habit is good.
- No new network calls without discussion. The promise is that nothing spoken in the building leaves the building.
- Never bundle a copyrighted Bible translation. KJV, ASV, WEB and BBE are public domain. Everything else is imported by the user.

## Where to start

See `ROADMAP.md` for planned work and good first tasks. Open GitHub issues are the other list. Comment on an issue before you start a large change, so two people do not build the same thing.

Good small starting points: a spoken reference the parser misses (with a test), clearer operator messages, and Windows testing.

## Reporting bugs

Open a GitHub issue using the bug report template. Please include:

- your OS and version, and the Agent HSP version,
- the speech model (`tiny.en`, `base.en` or `small.en`),
- your audio setup: laptop mic, USB mic, or a mixer feed (which mixer, which input),
- what was said and what the screen showed. Copy the transcript lines from the console if you can. "He said 'Romans five eight', the screen showed Romans 8:5" is perfect.

Do not attach full sermon recordings to public issues without the speaker's permission.

## License

License: to be decided. See LICENSE once added.
