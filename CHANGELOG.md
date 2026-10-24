# Changelog

All notable changes to Agent HSP are listed here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers follow [Semantic Versioning](https://semver.org/). While the version starts with 0, any release may change behaviour.

## [Unreleased]

### Fixed

- "Which display is which?" no longer leaves a number stuck on screen. Pressing it twice within four seconds left the first press's number up for good, covering the console until the app restarted. A new press now replaces the numbers still showing, and a click on any display's number closes them all at once.
- Displays are listed by the name macOS gives them ("Built-in Retina Display", "DELL U2720Q") instead of "Monitor #41038".

## [0.3.0] - 2026-10-24

### Added

- Preview on the Media page (#26): click a YouTube result's picture to watch it in a wide player before downloading it, or the eye button on a library item. It plays on the console only, starts with the sound off (the console's sound may be going to the room), and offers Get, or Show on projector and Add to service. YouTube previews use yt-dlp's stream addresses: HLS on macOS (WebKit stalls on YouTube's separate picture files), separate picture and sound kept in step on Windows.

- Projector menu in the console header (#29): bring the projector window to the front (P key), reload it, close it, fill a chosen display, "Which display is which?" (a big number on each display for four seconds) and "Bring back as a window on the main screen". The button turns red when the projector window is closed, and choosing it reopens the window with the current slide. Double-click fills the display without a separate macOS Space.
- Settings is a page in the top bar (#27), with the console's own look (dark mode, built-in and tweakcn themes) first.
- AI sermon summary. Settings has an "AI summary" section for any OpenAI- or Anthropic-compatible service: z.ai (GLM), Claude, OpenAI, or a model on this computer through Ollama or LM Studio, with presets, a saved key that never leaves the app's data folder, and "Save and test". While listening, the sermon's title, big idea and points with their verses appear under Sermon notes and update every minute and a half; "Summary now" and "Copy notes" use them. At Stop the session folder gets `summary.md` (a final pass over the whole sermon) and `verses.md` (only the verses shown) next to the recording and `transcript.txt`. On three recorded sermons with glm-5.3-flash, the final outlines matched the hand-written ones (for example all seven steps of "Seven Steps to the Can-Do Man"), each in about 10 seconds.
- Deepgram no longer bills for an empty room. After 10 quiet seconds it stops sending audio (a KeepAlive holds the connection, which Deepgram does not charge for) and resumes, with the second before, when someone speaks. A steady hum such as a fan or air conditioning counts as quiet. After 5 quiet minutes the session stops and is saved. Every hour of Deepgram listening asks "Still listening?"; no answer within 5 minutes stops it. Replayed on the 9.6-hour session left running overnight on 2026-10-23, it would have stopped after 36 minutes, 29 of them billed; on three recorded sermons it never paused mid-sermon. `examples/spend_gate.rs` replays any recording this way.

### Changed

- With Deepgram and Nemotron, spoken references show from the first partial transcript instead of waiting for two in a row: about 1 second sooner with Deepgram (typical 1.6 s to 0.5 s on the recorded sermon clips). Whisper keeps the two-in-a-row check (without it, the latency fixtures showed 57 wrong verses instead of 12). If the next words change the reference within 1.5 seconds ("verse eleven" becoming "eleven, twelve"), the new verse replaces the first, which then stays out of undo, history and the summary.

### Fixed

- Motion backgrounds start by themselves (#28). Under macOS Low Power Mode WebKit refused to start any video without a click on the projector; the projector now asks the app to start it.
- A spoken two-word number at the end of a partial ("verse thirty two") no longer shows verse 30 for a moment before the rest arrives.

## [0.2.0] - 2026-10-14

### Added

- Error log: errors from the app and its screens go to `agent-hsp.log` in the app's data folder. Settings has "Open log folder".
- First-run setup offers each download as an optional checkbox: Nemotron, Whisper, yt-dlp, ShemenMusic songs, ShemenMusic backing tracks. It can be run again from Settings.
- Verse picker in VideoPsalm style: all 66 books, chapters and verses visible at once. Click a book, click a chapter, then click or drag across verses.
- The Windows build includes Nemotron. CI builds sherpa-onnx with the DLL C runtime and caches it.

- ShemenMusic and Songbook tabs beside YouTube on the Media page. ShemenMusic lists the songs on shemenmusic.com (the church's music repository) with their backing tracks and lyrics; search titles and lyrics, preview, and "Get" puts the lyrics in the song library (verses, choruses and repeats in singing order) and downloads the track. Songbook opens a songbook file (JSON of songs, lyrics and track links, e.g. made from a PDF songbook; MediaFire links are followed to the file) and "Get all" loads it. Tracks download one at a time and are never fetched twice. Adding a song whose backing track is downloaded sets it to play once when the song goes live ("Play its backing track" on the Service page does the same for songs already in a service). Changing the background audio of the item on screen takes effect at once.
- Scripture readings have Book, Chapter, From verse and To verse pickers (typing a reference still works). Any service item can have its own background (photo or motion, from the same choices as the Look page) while it is live. Double-click a song to add it and go live; double-click media to play or show it.
- Media library (Media page) with five folders: General video, Song video (no lyrics), Song audio, Instrumental audio, Instrumental with lyrics. Add files from the computer, or search YouTube in the app and download into a folder (yt-dlp, fetched on first use and kept up to date; HD video when ffmpeg is installed, H.264 preferred). Live streams are left out of results. A notice reminds churches to download only what they have the right to use.
- Audio while projecting: a player bar at the bottom of the console (play/pause, seek, loop, volume, mute, 4-second fade out, stop) that keeps playing while slides change. Service items: Video (plays full screen on the projector with sound; play/pause/restart on the live screen) and Audio; any item can start background audio (looping by default) or fade it out, e.g. piano under a prayer session's topics and verses.
- Translation details: every Bible has a short name (NLT), full name, edition and copyright notice. The bundled ones are filled in; imported ones are edited on the Bibles page (Edit), saved with the translation, and can be removed. Slides show the short name after the reference by default ("JOHN 3:16 · NLT"); the Look page switches to full names. Dropdowns show "NLT · New Living Translation".
- Verse ranges on one slide: "Verses per slide" on the Look page (As many as fit, 1, 2 or 3) and per reading on the Service page. "As many as fit" puts short ranges like John 3:16-17 together (up to 4 verses, about 350 characters) with small verse numbers, and splits long passages; following the reading moves on after the last verse on the slide.
- Each scripture reading in a service has its own translation picker (default: the Live page's translation), saved with the reading.
- Console themes from tweakcn are saved under "Your themes" in Settings, named from the theme or by you, shown with colour dots, selectable and removable.
- My photos and My motion tabs on the Look page: add your own pictures (JPG, PNG, WebP, GIF) and videos (MP4, MOV, M4V, WebM). They are copied into the app data folder, listed in backgrounds/user.json, kept between runs, can be removed, and travel in service bundles. Replaces the one-off "Use my own picture".
- Export a service two ways from the Service page menu: "for this computer" (.hspservice: the order of service, songs by reference, background by its path) or "bundle for another computer" (.hspbundle: a zip with the songs in full, the projector look and the background file). Import reads either: songs are matched by title, missing ones are added from a bundle, and its look can be applied with one click.
- Recordings are compressed at Stop to audio.m4a (AAC 48 kbps, about 21 MB an hour instead of 115 MB) with macOS's built-in afconvert. Recording itself stays WAV so a crash loses almost nothing; continuing a session converts it back first. Windows keeps WAV for now.
- Listen starts a session folder named by local date and time; Stop saves audio.wav, transcript.txt (raw transcript with times) and summary.md (title, outline, every verse shown with its time, key lines). Listen after a recent session asks whether it is the same service (append to the same recording) or a new one. Going live on the Sermon item continues the day's session without asking. "Open recordings folder" in Settings.
- "HSP" from the pulpit means the wrong thing went up: the last verse comes down, what was on screen before it comes back, and that verse stays off for a minute. It acts on the first partial transcript. Words after it are an instruction ("HSP clear the screen", "HSP next", "HSP John 3:16"). Works under Hold. U on the keyboard does the same undo.
- "Clear the screen", "clear the board", "take it down": the Logo screen with no text; L brings the slide back.
- Agent HSP logo (brand/agent-hsp-icon.svg): app icon, console header, page icons and website.
- Voice commands: "next" on its own, "next chapter", "previous chapter", "jump to chapter 2", "go to chapter 4 verse 5" (also "vs"), and spoken numbers ("go to verse twenty"). "Chapter 4 verse 5" without a book uses the book on screen.
- Deepgram (online, paid) as a third speech engine in Settings, with the API key stored only on this computer. Streams 16-bit audio to Deepgram's live service and reconnects on its own if the connection drops.
- The Look page is an accordion (background, free photos and motion, text and dimming, church name and corner logos), with Photos and Motion tabs and video preview pictures.
- Corner logos: each of the four corners of verse, lyric, announcement and summary slides can show nothing, text, or a logo picture with its own size (Look page). The Logo screen can show a picture instead of the church name.
- Optional Nemotron streaming speech engine (NVIDIA Nemotron 3.5, 0.6B, run locally with sherpa-onnx and Bible book-name hotwords). Choose it in Settings. Verses typically reach the console about a second after the reference is spoken. Build with `npm run build:nemotron` after `scripts/sherpa/build.sh`.
- Three more bundled translations: Berean Standard Bible (BSB, public domain), Literal Standard Version (LSV, CC BY-SA 4.0) and Free Bible Version (FBV, CC BY-SA 4.0). KJV stays the default. Licences and credits are in `desktop/crates/preso-core/assets/BIBLES.md`. `scripts/bibles/usfm2json.py` rebuilds them from eBible.org USFM. The app binary grows by about 12 MB.
- Free stock backgrounds: 40 photos and 40 motion backgrounds from Pexels, chosen in the Look page, downloaded on first use (not bundled) and credited to their creators. Motion (video) backgrounds play behind verses and lyrics.
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

- New console interface built on shadcn/ui and Tailwind CSS: a top bar with Listen, transcription status, input level and settings; a Live page with a large live screen and big Blackout, Logo and Hold buttons; a Service page with real slide thumbnails and Live and Next screens; a Look page for the projector. Dark and light modes, built-in looks, and any tweakcn.com theme (paste its link or CSS in Settings).
- The projector window and every console preview draw slides with one shared component (`SlideView.tsx`), so the preview always matches the room.
- The Bibles page warns that NLT, NIV, ESV, NASB, NKJV, AMP, The Message and other copyrighted translations need a licence from their owners before import. The link to a third-party collection of copyrighted translation files was removed.

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

- Videos on the projector failed with NotAllowedError: macOS only lets a window play sound after someone clicks in it, and nobody clicks the projector. The console now plays the video's sound and the projector and previews play muted, kept in step every quarter second.
- Long service item names spilled out of the list; they now wrap to two lines with an ellipsis (the scroll area let rows grow wider than the panel).
- Importing a JSON Bible failed unless it was in the app's own layout. The importer now reads the common layouts ({"Genesis": {"1": {"1": ..}}}, an array of books with chapters, {"books": [...]} with verse objects, and flat verse records), takes the name from the file name ("Bible_NLT.json" becomes "NLT"), gives each import its own id so a second import no longer replaces the first, and accepts files with missing books (at least the New Testament). `cargo run -p preso-core --example check_bible -- file.json` checks a file.
- "Verse 95" and other follow-ups only worked after a spoken reference. A verse shown from the search box, a service reading, history or a voice command now sets the open passage too, and pressing Listen keeps it.
- Upgraded React to 19: the shadcn components pass refs as props, so on React 18 the search boxes could not be focused from code.
- Motion backgrounds no longer jump when the clip restarts: two copies of the clip crossfade over the last second. Thumbnails show a still picture so only the live screen and the projector play video.
- Side panels on the Live, Service and Look pages grew past the window instead of scrolling (grid rows sized to their content).
- Motion backgrounds stood still with a play button: React does not set the video's muted attribute, so WebKit refused to autoplay. Videos are now muted and started by hand, and restarted if anything pauses them.
- "Number thirteen verse twenty six" (the s dropped by the speech engine) shows Numbers 13:26. "Point number one" still shows nothing.
- Chapters read digit by digit: "Psalm one one nine verse five" is Psalm 119:5 and "Psalm one o seven" is 107 (was Psalm 1:1).
- A numbered book split across two transcripts ("... First" / "John four four") shows 1 John 4:4, not John 4:4. Only the words first, second and third join; a trailing "verse 1" does not.
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

[Unreleased]: https://github.com/kbosompem/agent-hsp/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/kbosompem/agent-hsp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kbosompem/agent-hsp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kbosompem/agent-hsp/releases/tag/v0.1.0
