import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

type Slide = {
  kind: string;
  title: string;
  body: string;
  sub: string;
};

export default function Output() {
  const [slide, setSlide] = useState<Slide | null>(null);

  useEffect(() => {
    const unlisten = listen<Slide>("slide", (e) => setSlide(e.payload));
    const onDbl = () => {
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen();
      }
    };
    document.addEventListener("dblclick", onDbl);
    return () => {
      unlisten.then((f) => f());
      document.removeEventListener("dblclick", onDbl);
    };
  }, []);

  if (!slide) {
    return (
      <div className="output">
        <div className="slide idle">
          <div className="spsub">AMC Preso</div>
        </div>
      </div>
    );
  }

  if (slide.kind === "summary") {
    let data: { points: { text: string; verses: string[] }[] } | null = null;
    try {
      data = JSON.parse(slide.body);
    } catch (e) {
      data = null;
    }
    let chars = 0;
    let count = 0;
    if (data) {
      data.points.forEach((p) => {
        count += 1;
        chars += p.text.length + p.verses.length * 9;
      });
    }
    const density = !data ? "" : count <= 2 && chars < 200 ? "compact" : count <= 3 && chars < 420 ? "mid" : "dense";
    if (data && data.points) {
      return (
        <div className={"output"}>
          <div className={"slide summary " + density}>
            <div className="sumtitle">{slide.title}</div>
            <ol className="points">
              {data.points.map((p, i) => (
                <li key={i}>
                  <div className="pointtext">{p.text}</div>
                  {p.verses.length > 0 && (
                    <ul className="subbullets">
                      {p.verses.map((v, j) => (
                        <li key={j}>{v}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
            <div className="sumsub">{slide.sub}</div>
          </div>
        </div>
      );
    }
    const bullets = slide.body.split("\n").filter((b) => b.trim().length > 0);
    return (
      <div className="output">
        <div className="slide summary">
          <div className="sumtitle">{slide.title}</div>
          <ul className="bullets">
            {bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
          <div className="sumsub">{slide.sub}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="output">
      <div className="slide verse">
        <span className="vlogo">AMC CHURCH</span>
        <div className={"vtxt " + sizeClass(slide.body)}>{slide.body}</div>
        <div className="vref">
          {slide.title} · {slide.sub}
        </div>
      </div>
    </div>
  );
}

function sizeClass(text: string): string {
  if (text.length < 90) return "xl";
  if (text.length < 200) return "lg";
  return "md";
}
