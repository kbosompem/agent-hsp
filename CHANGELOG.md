# Changelog

All notable changes to Agent HSP are listed here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers follow [Semantic Versioning](https://semver.org/). While the version starts with 0, any release may change behaviour.

## [Unreleased]

Work on the `streaming-latency` branch, not yet merged to `main`.

### Added

- Every listening session is recorded to `sessions/<date_time UTC>/` in the app data folder: `audio.wav` (16 kHz mono, header refreshed every 5 s so a crash loses little), `transcript.jsonl` and `slides.jsonl`, for replay and scoring after a service (issue 12, first part).
- Service page: build an order of service (songs, scripture, text/announcements, logo, blackout, sermon), save it, duplicate last week's, and run it live with the arrow keys, Page Down/Up or a presentation clicker. Every item except the sermon keeps the AI off the screen; going live on the sermon starts listening.
- Song library with search by title or lyrics, a plain-text editor, and import from VideoPsalm (agenda `.vpagd` files and songbook `.json`), plain text, OpenLyrics XML and OpenSong XML. VideoPsalm verses keep their slide breaks. Long sections split into slides of at most four lines.
- Songs and services are saved to `library.json` in the app data folder (written atomically, previous copy kept as `library.bak.json`).
- Live keys: B blackout, L logo, Esc clear to logo, H hold, Right/Left next/previous verse, Enter shows the oldest waiting card. Pressing B or L again brings back the slide that was up. Blackout and Logo turn on Hold, where the AI never changes the screen and detected verses wait as clickable cards.
- Projector slide kinds for blackout, logo and plain text (lyrics, announcements). Church name setting on the Theme page replaces the hard-coded "AMC CHURCH".
- Transcription health on the console: Listening, Behind by N s, or Not transcribing with the reason. Whisper failures are logged instead of silently returning empty text (issue 2).
- Streaming partial transcripts. The app transcribes the current sentence every half second while the preacher is still talking. Typical time from a spoken reference to a verse on screen dropped from about 9 seconds to about 1.4 seconds on the synthetic fixtures. A verse fires from partials only when the same chapter and verse appear in two partials in a row.
- Following a reading. While a range such as Matthew 5:1-12 is on screen, the console moves to the next verse when the preacher reads past the current one, and stops at the last verse. It tolerates reading from a different translation.
- Switching translation by voice: "show NLT", "read it in the NIV", "the amplified version says". Commentary such as "in the NIV it says" does not switch. Translations that are not loaded give a clear message.
- Follow-up verses. "Verse 6 says..." shows verse 6 of the chapter the preacher has open. A book named at the end of one sentence joins a chapter named at the start of the next.
- Projector text scales with the screen size. A text-size control (slider on the Theme page, A- and A+ buttons on the console preview) sets the size.
- `small.en` speech model option. It is the default on Mac; `base.en` stays the default on Windows.
- macOS asks for microphone permission (new `Info.plist`). If the input is pure silence for 3 seconds, the operator sees how to fix it.
- Latency harness (`desktop/src-tauri/examples/latency.rs`) that replays fixtures through the real segmenter, whisper and parser in simulated real time. Modes: streaming, legacy and finals, plus `--dump`.
- Harder fixtures: 18 references, 5 voices and accents, simulated sanctuary echo and noise. `run-all.sh` summarises found, wrong and latency per fixture.
- Real-sermon tooling: `redetect` example, scoring, offline summary replay, local LLM summary drafts, and a results page generator. Sermon audio stays out of git.
- Windows `.ico` and macOS `.icns` icons.

### Changed

- The summary slide no longer replaces a verse after 60 seconds. A verse stays up until the next one; the summary shows only when the operator presses Summary now.
- Spoken references show the moment two partials agree, without the 600 ms card wait. Quote matches still wait.
- A chapter-only mention ("turn to Mark 2") opens the chapter for follow-ups but shows nothing. Wrong verses on the 10 scored sermons fell from 27 to 16 with no lost catches (issue 1).

- Renamed the app from AMC Preso to Agent HSP (High Speed Projection). New bundle id `com.agenthsp.desktop`. On first launch, speech models and imported translations move over from the old `com.amcpreso.desktop` folder.
- whisper.cpp now runs on the Metal GPU on macOS. The README already claimed this, but builds were CPU only.
- Long segments are cut at the quietest recent moment instead of mid-word.
- The segmenter is a pure, tested struct. One whisper state is reused per listening session.
- Spoken references can repeat after 30 seconds (quotes still wait 3 minutes). They are skipped only when already on screen.
- Quote match threshold raised from 0.55 to 0.62.
- Summary and outline logic moved to `src/lib/sermon.ts` so the offline replay uses the same code.
- The console uses `lookup_live`: final transcripts update the open chapter, partials only read it.

### Fixed

- Stereo and multi-channel inputs, such as a USB mixer feed, are now mixed down to one channel correctly. Silent channels are left out so a voice on one side of the feed is not buried. 16-bit unsigned inputs are also accepted.
- Glued numbers such as "Philippians 413" now read as 4:13 when only one reading is valid.
- Book ordinals ("1st", "2nd", "3rd"), "Micah 6a" as 6:8, and common misspellings such as "Ecclesiast".
- "point number one" no longer matches the book of Numbers. "number" after chapter or verse is skipped.
- Whisper no longer echoes a sample reference from its prompt. Transcripts that are only prompt words are dropped.
- Partials hold a hit while a range is unfinished ("verses 5 and ...").
- Partials cap their token count, so a repetition loop cannot stall them.
- Metal crash on unaligned encoder window sizes (now rounded to 64 frames).
- Quote matches no longer replace a range being read. Quote matching is off while a range is on screen or the line reads the verse on screen.
- "Go back to James chapter 3 verse 3" shows the verse instead of running the "go back" command. Navigation phrases only act when the sentence names no chapter, verse or number.
- A single verse inside the range on screen jumps within the range and keeps following.
- Stop now drops results that were still being transcribed. Empty final transcripts clear the live line.
- Windows installer build failed for lack of an `.ico` icon.

## [0.1.0] - 2026-09-29

First version, released as "AMC Preso".

### Added

- Product and engineering plan (`plan.html`) and project website (`website/`).
- Browser alpha (`alpha/`): verse detection from speech, cue flows, and the two-window layout, with 36 parser tests.
- Native desktop app (Tauri 2 + Rust) with a console window and a projector output window.
- Native audio capture (cpal) and whisper.cpp speech recognition with an energy-based voice detector.
- Rust verse engine (`preso-core`) with the KJV embedded. Parses spoken references, ranges, homophones and corrections, and rejects false hits such as "John the Baptist".
- ASV, WEB and BBE bundled. Import any translation from Zefania, OpenSong or OSIS XML, or JSON.
- Downloads page with links to free translation files.
- Quote matching: say a verse without naming it and the matching verse appears. Uses precomputed MiniLM embeddings of 31,102 verses and a local sentence embedder.
- Output theme designer, with styling generated from any background image.
- Verse history, a 60-second hold, then a live sermon summary slide built from spoken outline cues ("the title of my message is", "point number one").
- Voice commands: "next verse", "previous verse", "jump to verse 15", "show it again".
- Light and dark console themes.
- GitHub Actions workflow that builds macOS and Windows installers on every push to `main`.

[Unreleased]: https://github.com/kbosompem/agent-hsp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kbosompem/agent-hsp/releases/tag/v0.1.0
