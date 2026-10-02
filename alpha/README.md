# Agent HSP · Alpha 0.4

A browser-based proof of the plan in `../plan.html`. It demonstrates the three risky parts before any desktop code is written:

1. Live verse detection from speech (local Whisper, no cloud)
2. The praise-and-worship cue flow: hear the cue, 12-second splash, then soundtrack with synced lyrics
3. The dual-window layout: operator console plus a separate projector output window

Everything runs on-device. The Whisper model files download once from the Hugging Face CDN on first use, then run entirely in the browser (WebGPU if available, otherwise WASM).

## Run it

Open `index.html` in Chrome or Edge. No install, no server, no build step.

## Demo flow (5 minutes)

1. Click **Open output window**, drag it to the projector/TV, double-click it for fullscreen.
2. Pick the audio input (X-USB / XR16 from the desk, or the laptop mic).
3. Click **Load model** and wait for the green `ready` chip.
4. Click **Self test (no mic)**: it plays a built-in voice fixture through the real model and must pop the John 3:16 card. This proves the brain works without any audio hardware.
5. Click **Test input** and speak for ten seconds: it reports level, floor, and what it heard.
6. Click **Listen** and speak: "turn with me to John chapter three verse sixteen".
7. Say: "it is time for praise and worship." Approve the cue card with **Enter**.
8. If anything fails, press **D**: the scripted demo runs the whole flow without a mic.

The **Diagnostics** panel (right column) shows the live state of every stage: version, browser, model + device (wasm/q8 etc.), mic, last window result, output window. Read those six lines to anyone helping you debug.

### Keys

| Key | Action |
|---|---|
| `Enter` | Approve top AI card |
| `Backspace` | Skip top AI card |
| `H` | Hold all AI actions |
| `B` / `L` | Blackout / logo |
| `Space` / arrows | Next / previous slide |
| `A` / `V` | Focus alert / verse search |
| `D` | Toggle scripted demo |
| `Shift+Esc` | Panic: clear everything, blackout |

## XR16 wiring (one-time)

1. USB-B port on the back of the XR16 to the laptop (shows as a 16-in / 4-out device, no driver).
2. X-Edit or console: Routing -> Card. Set Card Out 1 to a spare Mixbus (say Mixbus 6, "Transcript").
3. Send the pulpit mic post-fader at unity plus a little worship leader to that bus, out of the main path.
4. Peaks around -18 to -12 dBFS.
5. Select that device as the input here.

## Modes

- **Manual**: listening off, operator drives everything (quick verse search, transport, alerts).
- **AI Copilot** (default): verses auto-show after a 3-second countdown; cue sequences need one key approval.
- **AI Autopilot**: cue sequences fire after a 6-second cancel window.

## Troubleshooting

- **Nothing appears when I speak**: click **Test input** and speak for ten seconds. It prints the input level, the noise floor, and what the model heard.
  - "levels VERY low / low": untick **raw desk feed** (lets the browser boost a quiet laptop mic), or pick a different input, or raise the source volume.
  - "levels good but nothing transcribed": make sure the model chip says `ready`, speak closer to the mic, and check you are in Chrome or Edge.
- **No internet / model fails**: the scripted demo (`D`) and manual mode still work fully.
- **Mic permission**: the browser will ask once; choose the desk feed if available.
- **Track does not play**: browsers require one click before audio; click anywhere once, or rely on lyric auto-advance (6.5 s per line).
- **Slow first transcription**: the WASM fallback is single-threaded on file:// pages; give the first window a few seconds.

### The raw desk feed toggle

Ticked (raw): no browser echo cancellation, noise suppression, or auto-gain. Right for a leveled desk feed from the XR16. Unticked: browser processing on, which rescues quiet laptop mics. Test input tells you which you need.

## What 0.4 adds

- **Quote detection**: say a verse quote like "there is no god" or "the Lord is my shepherd" and it matches against all 31,102 KJV verses. Sentence-bounded matches rank first (Psalm 14:1 beats Deuteronomy 32:39 for "there is no god"). The Quick verse box also searches quotes.
- **Voice slide commands**: "next verse", "next slide", "previous verse", "go back" advance the projector directly.
- **Ranges**: "Philippians chapter one verses one through four" builds verse-by-verse slides; advance with Space or by voice.
- **No hearing gaps**: each listening cycle now consumes all audio since the previous one (up to 28 s), so slow transcription delays results instead of losing them. Repeats of the same verse within 3 minutes are intentionally ignored (the transcript still badges them so you can see it heard you).
- **Fullscreen button** in the output window (or double-click, or F11).
- Note on paraphrase: KJV says "Charity suffereth long" where modern speech says "love is patient". Quote matching needs the KJV wording; the desktop app's 3B model will handle paraphrase.

## Tests

```
node test.js
```

27 cases over the verse reference parser (spoken forms like "the third chapter of John", "Romans five verse eight", "Psalms ninety one") and the cue matcher. The same parser design carries into the Rust core of the desktop app.

## Alpha scope (on purpose)

- KJV only; one demo schedule; one hymn (Amazing Grace, public domain) with fixed lyric timing; no song library, theme designer, NDI, or stage view.
- Verse paraphrase matching (embeddings) is not in the alpha; the desktop plan covers it.
- The transcript window rolls every ~4 seconds, so live latency is a few seconds, not the sub-2-second target of the desktop build.
