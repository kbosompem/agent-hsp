# Architecture

This page explains how Agent HSP turns a preacher's voice into a verse on the projector. It covers the desktop app in `desktop/`. The browser alpha in `alpha/` is an older proof and is not described here.

If you only read one section, read "The data flow".

## The big picture

Agent HSP is a Tauri 2 app. Tauri is a framework for desktop apps: a Rust process does the native work, and web pages (here, React + TypeScript) draw the windows. The two talk through "commands" (the web page calls a Rust function) and "events" (one side broadcasts a message, the other listens).

The app has two windows:

- **Console** (`desktop/src/App.tsx`): what the operator sees. It holds most of the live decision logic. Built with shadcn/ui components (`src/components/ui/`, Radix underneath) and Tailwind CSS v4 (`src/index.css`). Its colours are shadcn theme variables, so a tweakcn.com theme can replace them at run time (`src/lib/uitheme.ts`).
- **Output** (`desktop/src/Output.tsx`): what the room sees on the projector. It only draws the slide it is sent, with `SlideView.tsx`, the same component the console uses for every preview and thumbnail. Slide styles are in `src/slides.css`, separate from the console's Tailwind styles.

The Rust side has two parts:

- **The Tauri shell** (`desktop/src-tauri/src/`): audio capture, the speech segmenter, whisper.cpp, and the command handlers.
- **preso-core** (`desktop/crates/preso-core/src/lib.rs`): the verse engine. It holds the Bible text and turns words like "Romans five verse eight" into Romans 5:8. It has no audio or UI code, so it is easy to test.

## The data flow

```
 microphone / mixer feed
          |
          v
 [capture thread]  audio.rs: spawn_capture
   cpal input stream, any sample rate
   -> resampled to 16 kHz -> 60 s ring buffer
          |
          v
 [segmenter thread]  audio.rs: spawn_segmenter + segmenter.rs
   every 100 ms: loudness of the last 0.5 s vs. an adaptive noise floor
   -> Job::Partial  (every 0.5 s of new speech, last <= 8 s of the sentence)
   -> Job::Final    (after 0.7 s of silence, or forced at 15 s on the quietest moment)
          |
          v
 [whisper.cpp]  audio.rs: run_whisper
   Metal GPU on macOS, CPU on Windows
   Bible book names as the prompt; prompt echoes dropped
          |
          |  events: "transcript-partial" {text, ms, seg}
          |          "transcript"         {text, ms, seg}
          v
 [console window]  App.tsx
   partial: follow the reading, settle the tail,
            lookup_live(commit=false), fire a chapter:verse
            (Deepgram/Nemotron: first partial; Whisper: two in
            a row); swap it if the next words change it
   final:   drop junk -> voice commands -> corrections
            -> sermon outline notes -> lookup_live(commit=true)
            -> quote matching (embeddings)
          |
          |  a spoken reference fires at once; a quote match waits 600 ms
          v
   invoke("show_verse") / invoke("show_slide")      (Rust command)
          |
          |  event: "slide" {kind, title, body, sub}
          v
 [output window]  Output.tsx  -> projector
```

The theme travels separately. The console sends an `output-theme` event straight to the output window whenever the theme changes.

## Each stage in more detail

### 1. Audio capture (`audio.rs`)

- Uses `cpal`, a Rust library for audio devices. It lists inputs (`list_audio_inputs`) and opens the one the operator picks, or the system default.
- Accepts f32 or i16 samples at the device's own rate. A simple linear resampler converts to 16 kHz, which whisper needs.
- Samples go into a ring buffer that keeps the last 60 seconds. A counter tracks the absolute sample position, so later stages can ask for "samples 120000 to 136000" even after old audio has been dropped.
- If no non-zero sample arrives in 3 seconds, it tells the operator to check microphone permission. macOS gives an app without permission pure silence and no error. `Info.plist` holds the microphone usage text that makes macOS ask.
- Known gap: the capture code does not read the device's channel count. A stereo or multi-channel input is treated as one channel. Mono inputs work as intended.

### 2. Segmenter (`segmenter.rs`)

- Pure logic: no audio device and no Tauri. The latency harness drives exactly the same code the app runs.
- It is an energy-based voice detector. It compares the level of the last half second to a noise floor that adapts to the room.
- `SegConfig::streaming()` is what the app uses. `SegConfig::legacy()` is the old behaviour (wait for 1 s of silence, no partials) and is kept for comparison in the harness.
- When a segment runs too long, it cuts at the quietest point in the last 3 seconds instead of mid-word.

### 3. Speech to text (`audio.rs`, `run_whisper`)

- Uses `whisper-rs`, Rust bindings to whisper.cpp. whisper.cpp is a C++ build of OpenAI's Whisper speech model that runs on the local machine.
- On macOS it is built with the `metal` feature, so it runs on the GPU. Windows runs on the CPU.
- Models are downloaded once from Hugging Face into the app data folder (`models/ggml-<name>.bin`) by `ensure_model`. Defaults: `small.en` on Mac, `base.en` on Windows. `tiny.en` is also offered.
- Partials trade a little accuracy for speed. They use a smaller encoder window (`audio_ctx`, rounded to 64 frames because Metal requires it) and a token cap so a repetition loop cannot stall them.
- One whisper state is created per listening session and reused.
- A "generation" counter lets Stop cancel results that were still being transcribed.

### 3b. Nemotron streaming engine (optional, `nemotron.rs`)

- Built only with the `nemotron` Cargo feature (`npm run build:nemotron`, `npm run dev:nemotron`). It needs the native sherpa-onnx libraries from `scripts/sherpa/build.sh`, which builds a pinned commit of sherpa-onnx main into `desktop/vendor/` (not in git); `desktop/.cargo/config.toml` points the Rust crate at them.
- Selected in Settings as "Nemotron" (`nemotron-160`, 160 ms chunks) or "Nemotron light" (`nemotron-560`). Load downloads the model archive from the sherpa-onnx releases and unpacks it into `models/`.
- It replaces the segmenter and whisper with a streaming transducer: audio from the same ring buffer goes in every 100 ms and words come out as they are recognised, typically about a second after the end of a spoken reference. Bible book names are boosted with hotwords (`scripts/stt-eval/bible-hotwords.txt`).
- `nemotron::Engine` holds the loop (our own sentence ends: 1 s without a new word, or a cut at the widest pause after 15 s; a fresh stream primed with the last second of audio after each sentence, because sherpa's reset drops the next first word). The app thread and `examples/latency.rs` (`nemotron` mode) run the same code.
- It emits the same events as whisper (`transcript-partial`, `transcript`, `stt-health`, `stt-alive`) and records sessions the same way, so the console does not change.

### 4. Verse engine (`preso-core`)

- **Bible text.** KJV, ASV, WEB, BBE, BSB, LSV and FBV are compiled into the binary with `include_str!` (KJV first, so it is the default). KJV is `kjv.json`; the others are in `assets/`. BSB, LSV and FBV are built from eBible.org USFM with `scripts/bibles/usfm2json.py`; licences and attribution are in `assets/BIBLES.md`. Verse N is always at index N-1, so verses a translation omits are stored as empty text.
- **Imports.** `import_translation` accepts our JSON, Zefania XML, OpenSong XML or OSIS XML. The parsed result is saved as JSON in the app data folder under `translations/` and loaded on every start.
- **Parser** (`Engine::parse_refs`, `Engine::lookup`). Handles number words, "chapter"/"verse" words, ordinals ("first Corinthians"), ranges with homophones ("verse 1 two 5"), glued numbers ("Philippians 413" becomes 4:13 when only one reading is valid), and common misspellings of book names (edit-distance matching). It rejects false hits such as "John the Baptist" and "point number one".
- **LiveLookup** (`lookup_live`). Remembers the open chapter for 10 minutes, so "verse 6 says" shows verse 6 of that chapter. It also joins a book named at the end of one sentence with a chapter at the start of the next. Final transcripts move this context (`commit: true`). Partials only read it.

### 5. Console logic (`App.tsx` and `src/lib/`)

Much of the "when should the screen change" logic lives in the console, in TypeScript:

- **Partials.** `settleTail` trims an unfinished end ("John 3 1" may become "John 3 16"; "verse thirty two" is dropped whole, never leaving "thirty"). With Deepgram and Nemotron a verse fires from the first partial that has it. Whisper re-transcribes the whole sentence each time and invents references from half-heard audio, so there a verse fires only when the same label appears in two partials in a row. If a later partial within 1.5 seconds no longer says that verse and names another, the new one replaces it, and the misheard one leaves undo, history and the summary.
- **Voice commands.** "next verse", "previous verse", "go back", "jump to verse 15", "show it again". Navigation words are ignored when the sentence also names a chapter or verse, so "go back to James chapter 3" shows James 3.
- **Corrections.** Within 30 seconds of a verse, "sorry, chapter 3" or "I mean verse 5" changes the verse on screen.
- **Following a reading** (`lib/voice.ts`). While a range such as Matthew 5:1-12 is up, the console moves to the next verse once the preacher has read past the current one. It compares stemmed content words, so it tolerates a different translation.
- **Translation by voice** (`lib/voice.ts`). "show NLT" or "read it in the NIV" switches translation if it is loaded.
- **Chapter-only mentions.** "Turn to Mark 2" opens the chapter for follow-ups but shows nothing. Many were misheard or never read.
- **Transcription health.** The Rust side sends `stt-health` after every whisper call (lag behind live audio, or the error) and `stt-alive` every second between calls. The status chip shows Listening, Behind by N s, or Not transcribing. `AGENTHSP_STT_FAULT=fail` or `slow:<ms>` forces the failure states for testing.
- **Live keys and Hold.** B blackout, L logo, Esc clear to logo, H hold, arrows for next/previous verse, Enter to show the oldest waiting card. Under Hold the ticker does not fire cards, and following the reading, voice commands and corrections are off. Releasing Hold drops the waiting cards so a backlog never floods the screen.
- **Repeat rules.** A spoken reference is not re-shown within 30 seconds unless it is off screen. Quote matches wait 3 minutes.
- **Hold and summary** (`lib/sermon.ts`). A verse stays up until the next one. The operator can show a summary slide built from the sermon outline with "Summary now"; it never replaces a verse on its own. The outline comes from phrases such as "the title of my message is" and "point number one", or, with the AI summary on, from the AI.
- **AI summary** (`lib/aisummary.ts`, `AiSettings.tsx`, `src-tauri/src/llm.rs`). Every 90 seconds while listening, the whole transcript so far and the verses shown go to an OpenAI- or Anthropic-compatible model with the prompt in `SUMMARY_SYSTEM`; the JSON outline it returns is checked (only verses that were shown survive) and shown under Sermon notes. Each request is built from the full transcript with no earlier summary: an earlier draft anchored the model to points guessed during the introduction. At Stop a final pass rewrites `summary.md`. The key stays in `llm.json` in the app data folder and never reaches the console. `scripts/ai-summary-replay.ts` replays a recorded sermon through the same prompt.
- `lib/stt.ts`, `lib/stt-worker.ts` and `lib/audio.ts` are left over from browser speech recognition. They are not used by the desktop app.

### 6. Quote matching (embeddings)

Quote matching finds a verse the preacher quotes without naming it.

- An "embedding" is a list of numbers that captures what a sentence means. Sentences with similar meaning have similar numbers.
- `scripts/verse-index/build.js` embeds all 31,102 KJV verses with the MiniLM model (`Xenova/all-MiniLM-L6-v2`, 384 numbers per verse). It writes `desktop/public/verse-index.bin` (about 47 MB, not in git) and `verse-index.json` (in git).
- At run time, a Web Worker (`lib/embed-worker.ts`) embeds each final transcript line with transformers.js. The console then compares it to every verse and takes the best match if its score is at least 0.62.
- Quote matching is off while a range is on screen or while the line reads the verse on screen.
- Note: the worker loads transformers.js from the jsDelivr CDN and the model from Hugging Face on first use. Only the library and model are downloaded. Sermon text is not sent anywhere.
- If `verse-index.bin` is missing, the console shows "index missing" and everything else still works.

### 7. Output window (`Output.tsx`)

- Listens for `slide` and `output-theme` events and draws them. It has no logic of its own.
- Slide kinds today: `verse`, `summary`, `blank` (blackout), `logo` (church name on the theme background) and `text` (title, body, sub; for lyrics and announcements).
- Text size follows the screen size and the theme's `textScale` (set by the Theme slider or the A- / A+ buttons on the console preview).
- Double-click fills the display (`projector_toggle_fill`). It is a borderless window sized to the display (macOS simple fullscreen), not the page's own fullscreen, which put the window in a separate macOS Space where it got lost.
- `projector.rs` finds, reloads, closes and places the window: the console's Projector menu lists the displays, fills one, and shows each display's number in a small window for four seconds. The console hears `projector-closed` and turns the Projector button red.
- Motion backgrounds under macOS Low Power Mode: WebKit refuses to start any video, even muted, without a user action, and the background sat on its first frame. A refused `play()` makes the page call `projector_play`, which runs a script in the page; WebKit counts that as a user action, and the page's `hsp-play` handler starts the visible copy and unlocks the other for the crossfade. The projector's WKWebView also has occlusion detection off, so a projector behind the console still counts as visible.

## Tauri commands

Called from the console with `invoke(...)`. Registered in `desktop/src-tauri/src/lib.rs`.

| Command | What it does |
|---|---|
| `lookup` | Parse text and return matching verses (Quick verse search box). |
| `lookup_live` | Same, but uses and updates the open-chapter context. |
| `reset_live` | Clear that context (called when Listen starts). |
| `verse_at` | One verse by book index, chapter, verse. |
| `verse_range` | A list of verses, one per slide. |
| `list_translations` | Bundled and imported translations. |
| `import_translation` | Parse and save a translation file. |
| `open_url` | Open an http(s) link in the system browser. |
| `show_verse` | Turn a verse into a slide and broadcast it. |
| `show_slide` | Broadcast any slide (used for the summary). |
| `load_library` | Read `library.json` (songs and agendas). |
| `fetch_background` | Download a stock background from Pexels once into `backgrounds/` and return its path (shown via the asset protocol). |
| `save_library` | Write it atomically, keeping a `.bak` copy. |
| `list_audio_inputs` | Names of input devices. |
| `ensure_model` | Download a whisper model if it is not on disk. |
| `start_listening` | Load the model and start the capture and segmenter threads. |
| `stop_listening` | Stop both threads and drop in-flight results. |

## Events

| Event | From | To | Payload |
|---|---|---|---|
| `transcript-partial` | Rust | console | `{text, ms, seg}` |
| `transcript` | Rust | console | `{text, ms, seg}` (sent even when empty, to clear the live line) |
| `level` | Rust | console | input level, about 3 times a second |
| `listen-status` | Rust | console | plain-text status or error |
| `stt-health` | Rust | console | `{lag_s, ms, error}` after every whisper call |
| `stt-alive` | Rust | console | heartbeat, every second between whisper calls |
| `model-progress` | Rust | console | download status and byte counts |
| `model-ready` | Rust | console | model name |
| `slide` | Rust | all windows (the output draws it) | `{kind, title, body, sub}` |
| `output-theme` | console | output | the output theme object |

## Where state lives

- **Rust memory.** `ListenState` (audio buffer, whisper model, run flags), `LiveLookup` (open chapter), and the global `Engine` (all translations).
- **App data folder** (`com.agenthsp.desktop` in the OS app data location):
  - `models/` whisper model files
  - `translations/` imported translations as JSON
  - `backgrounds/` stock photos and motion loops, downloaded on first use from the list in `desktop/public/backgrounds/manifest.json` (Pexels, credited in the Look page). Nothing is bundled.
  - `sessions/<YYYY-MM-DD_HH-MM-SS>/` one folder per service (local date and time): `audio.m4a` (compressed at Stop on macOS; `audio.wav` while recording and on Windows), `transcript.txt`, `summary.md`, `verses.md`, plus `transcript.jsonl`, `slides.jsonl` and `session.json`. Written by a single thread in `session.rs`; the audio callback only sends it chunks.
  - On first start, data from the old `com.amcpreso.desktop` folder is moved here.
- **Browser localStorage in the console window.** `hsp-ui-mode` (light/dark console), `hsp-ui-theme` (the console's shadcn/tweakcn theme variables) and `preso-output-theme` (the projector theme, including any picture of your own as a data URL; a large image may not fit and then only lasts for the session).
- **Console memory only.** Transcript, verse history, pending cards, sermon outline and notes. These are lost when the app closes.
- **`library.json`** in the app data folder: songs and service agendas (`src/lib/library.ts` defines the shape; `load_library` / `save_library` only store it). There are no saved sessions yet. `plan.html` describes a SQLite data model for later.

## Tests and tools

| What | Where | How to run |
|---|---|---|
| Parser and LiveLookup tests | `desktop/crates/preso-core/src/lib.rs` | `cd desktop && cargo test -p preso-core` |
| Segmenter and prompt-echo tests | `desktop/src-tauri/src/segmenter.rs`, `audio.rs` | `cd desktop && cargo test -p agent-hsp --lib` |
| Voice helper tests | `desktop/scripts/test-voice.ts` | see CONTRIBUTING.md |
| Alpha parser tests | `alpha/test.js` | `node alpha/test.js` |
| Latency harness | `desktop/src-tauri/examples/latency.rs` | see below |

### The latency harness

`examples/latency.rs` replays a WAV fixture through the real segmenter, whisper and parser. It runs in simulated real time: while whisper works, audio keeps "arriving", as it would from a live microphone. For each expected reference it reports whether the verse was found, any wrong verses, and the seconds between the speaker finishing the reference and the app knowing the verse. Spoken references show the moment they are detected; `FIRE_DELAY_S` adds a delay and `ONE_PARTIAL=1` accepts a hit from a single partial, for experiments.

- Fixtures: `fixtures/latency/*.wav` plus a `.json` answer key with the time each reference ends. They are made with macOS text-to-speech by `scripts/latency-fixture/make.py`, some with simulated echo and noise.
- `scripts/latency-fixture/run-all.sh <model>` runs every fixture and prints one line each.
- Modes: `streaming` (what the app does), `legacy` (old behaviour), `finals` (no partials, faster, no latency figures). `--dump` writes transcripts for the offline replays.
- `examples/redetect.rs` re-runs the parser over a saved dump without whisper. It is the fast way to test a parser change against real sermons.
- Real sermon recordings live in `fixtures/real/` and are not in git.

## Continuous integration

`.github/workflows/build.yml` runs on every push to `main` and on manual dispatch. It builds the app on `macos-latest` and `windows-latest` with Node 20 and stable Rust, then uploads the installers as workflow artifacts. It does not run the tests yet.

`.github/workflows/release.yml` builds the same installers when a `v*` tag is pushed and attaches them to a draft GitHub Release. See `docs/RELEASING.md`.
