import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import SlideView, { OutputTheme, Slide, setPlayBlockedHandler } from "./SlideView";

/** "Which display is which?": a big number on each display. */
export function Identify({ n, name }: { n: string; name: string }) {
  return (
    // It closes by itself after 4 s; a click on any display's number closes them all.
    <div onClick={() => void invoke("identify_close").catch(() => {})} style={{ height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#111827", color: "#fbbf24", fontFamily: "system-ui, sans-serif", border: "6px solid #fbbf24", boxSizing: "border-box", cursor: "pointer" }}>
      <div style={{ fontSize: 160, fontWeight: 700, lineHeight: 1 }}>{n}</div>
      <div style={{ fontSize: 20, color: "#e5e7eb", marginTop: 12 }}>{name}</div>
      <div style={{ fontSize: 13, color: "#9ca3af", marginTop: 8 }}>Click to close</div>
    </div>
  );
}

// The projector window: draws whatever slide the console sends.
export default function Output() {
  const [slide, setSlide] = useState<Slide | null>(null);
  const [ot, setOt] = useState<OutputTheme | null>(null);

  useEffect(() => {
    const subs = [
      listen<Slide>("slide", (e) => setSlide(e.payload)),
      listen<OutputTheme>("output-theme", (e) => setOt(e.payload)),
    ];
    // After a reload or crash, ask the console for the current slide and theme.
    Promise.all(subs).then(() => void emit("output-ready"));
    // Fill the display without the page's own fullscreen, which on macOS
    // moves the window into a separate Space where it gets lost.
    const onDbl = () => void invoke("projector_toggle_fill").catch(() => {});
    // The projector has no keys of its own: when it has the keyboard, the
    // console's live keys (B, L, H, P, arrows) still work.
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      void emit("projector-key", e.key);
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    // A refused background video: ask the app to start it (see projector_play), at most every second.
    let lastAsk = 0;
    setPlayBlockedHandler(() => {
      if (Date.now() - lastAsk < 1000) return;
      lastAsk = Date.now();
      void invoke("projector_play").catch(() => {});
    });
    document.addEventListener("dblclick", onDbl);
    return () => {
      subs.forEach((u) => u.then((f) => f()));
      document.removeEventListener("dblclick", onDbl);
      document.removeEventListener("keydown", onKey);
      setPlayBlockedHandler(null);
    };
  }, []);

  return (
    <div className="output">
      <SlideView slide={slide} theme={ot} />
    </div>
  );
}
