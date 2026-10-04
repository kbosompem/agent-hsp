# Roadmap

Goal: replace VideoPsalm on Sunday. A church should be able to run a whole service in Agent HSP, with or without the AI listening.

Each item below is sized to be one pull request. Items marked **good first issue** need no Rust or AI knowledge.

## Wave 0: Foundation (blocks most of what follows)

| # | Item | Why |
|---|---|---|
| 0.0 | Fix stereo and multi-channel audio input (USB mixers) | Capture assumes one channel, so a mixer feed comes through garbled. Most churches will use a mixer feed. |
| 0.1 | Local database (SQLite, a single file on the machine) for sessions, agendas, songs and media | Today everything lives in browser storage and is lost or capped. Every feature below needs a real store. |
| 0.2 | Media library folder: copy imported pictures, video and audio into the app data folder and index them | Agendas need to point at files that do not move. |
| 0.3 | Slide model: one shared "slide" type (verse, song lyric, text, picture, video, audio, countdown, blank) rendered by the output window | Today the output only knows "verse" and "summary". |

## Wave 1: Sessions and transcript

| # | Item |
|---|---|
| 1.1 | Session = one service. Start, stop, name, date. Created automatically when listening starts. |
| 1.2 | Save the full raw and processed transcript to the session, with timestamps. No 30/50-line cap. |
| 1.3 | Scrollable transcript panel with auto-follow that pauses when you scroll up, and a "jump to live" button. |
| 1.4 | Sessions list: open a past session, read its transcript, verses shown, outline and summary. |
| 1.5 | Export a session as Markdown or plain text. **good first issue** |
| 1.6 | Filter noise lines like "(speaking in foreign language)" out of the processed view. **good first issue** |

## Wave 2: Agenda (order of service)

| # | Item |
|---|---|
| 2.1 | Agenda editor: add, reorder (drag), rename, delete items. Save and reuse agendas. |
| 2.2 | Item types: Bible passage, song, text slides, picture, video, audio, karaoke (audio with timed lyrics), countdown, blank/logo. |
| 2.3 | Live console: agenda on the left, current and next slide, Space/arrows to advance across items. |
| 2.4 | Duplicate last week's agenda as a starting point. **good first issue** |

## Wave 3: Content types

| # | Item |
|---|---|
| 3.1 | Song library: title, verses, chorus, bridge, order, search as you type. |
| 3.2 | Song import: OpenLyrics, OpenSong, plain text, and VideoPsalm songbooks (the migration path). |
| 3.3 | Pictures: show full screen, fit or fill. **good first issue** |
| 3.4 | Video: play, pause, loop, mute; video as a moving background behind lyrics. |
| 3.5 | Audio: play a track, with a volume control and fade out. |
| 3.6 | Karaoke: audio plus lyrics that advance on timestamps; a simple "tap to time" tool to set them. |
| 3.7 | Text slides and announcements. **good first issue** |
| 3.8 | Countdown timer and clock slides. **good first issue** |

## Wave 4: Live safety and display

| # | Item |
|---|---|
| 4.1 | Hotkeys: Hold (H), Blackout (B), Logo (L), Panic (Shift+Esc), next/previous. |
| 4.2 | Per-slide-type text size and position (the global text size control shipped). |
| 4.3 | Church name/logo setting instead of the hard-coded "AMC CHURCH". **good first issue** |
| 4.4 | Stage display (a second output for the preacher and band: current and next lyric, clock). |
| 4.5 | NDI output for livestream software. |

## Wave 5: AI cues and script mode

| # | Item |
|---|---|
| 5.1 | Cue phrases per agenda item ("let's stand for praise and worship" starts the Praise item). |
| 5.2 | Copilot cards: AI suggestions appear with a countdown; Enter approves, Backspace skips. |
| 5.3 | Script following: the AI tracks where the service is in the agenda. |
| 5.4 | Local LLM sermon summary and title. |
| 5.5 | Silero VAD (a small speech-detection model) for noisy rooms. |
| 5.6 | Bundle the quote-matching model in the installer so it works with no internet. |

## Project and release

| # | Item |
|---|---|
| R.1 | Choose a license and publish the repo. |
| R.2 | Tagged releases build signed-or-documented installers for Windows and macOS automatically. |
| R.3 | Code signing (Windows certificate, Apple Developer ID) so installers stop showing warnings. |
| R.4 | Auto-update. |
