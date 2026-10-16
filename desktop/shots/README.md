# Screenshot harness

Runs the real console and projector UI in Chrome with the Tauri backend
replaced by canned data (`mock.ts`): KJV text from `crates/preso-core/kjv.json`,
a sample Sunday agenda with public-domain hymns (`library.json`), and a
staged sermon. Used for the website screenshots. Not part of the app build.

```bash
cd desktop
npx vite --port 5180            # serves /shots/ and /shots/output.html
# in another terminal; needs the playwright package (NODE_PATH=…/node_modules) and Chrome:
node shots/scene.cjs live    live.png       # transcript, verse on screen, notes
node shots/scene.cjs song    song.png       # Service page, a song live
node shots/scene.cjs Look    look.png       # also: Service, Media, Bibles
node shots/projector.cjs     projector.png  # projector output, John 3:16
```

Scripts call `window.__hsp.emit(event, payload)` to send the events the Rust
side normally sends (`transcript`, `listen-status`, `stt-health`, `slide`).
Unhandled commands are logged to the console as `[mock] unhandled <cmd>`.
The bundled LSV and FBV are CC BY-SA 4.0; the mock lists every translation
as public domain, so don't publish the Bibles page from it.
