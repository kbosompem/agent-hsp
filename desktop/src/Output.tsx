import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import SlideView, { OutputTheme, Slide } from "./SlideView";

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
    const onDbl = () => {
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen();
      }
    };
    document.addEventListener("dblclick", onDbl);
    return () => {
      subs.forEach((u) => u.then((f) => f()));
      document.removeEventListener("dblclick", onDbl);
    };
  }, []);

  return (
    <div className="output">
      <SlideView slide={slide} theme={ot} audible />
    </div>
  );
}
