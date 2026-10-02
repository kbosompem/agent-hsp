import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

type Slide = {
  kind: string;
  title: string;
  body: string;
  sub: string;
};

type OutputTheme = {
  bgKind: "gradient" | "image";
  gradient: string;
  image: string;
  overlay: number;
  textColor: string;
  accent: string;
  font: "serif" | "sans";
};

function slideBg(t: OutputTheme | null): any {
  if (!t) return undefined;
  if (t.bgKind === "image" && t.image) {
    return {
      backgroundImage: "url(" + t.image + ")",
      backgroundSize: "cover",
      backgroundPosition: "center",
    };
  }
  return { background: t.gradient };
}

function overlayEl(t: OutputTheme | null) {
  if (t && t.bgKind === "image" && t.overlay > 0) {
    return <div style={{ position: "absolute", inset: 0, background: "rgba(5,8,14," + t.overlay + ")" }} />;
  }
  return null;
}

export default function Output() {
  const [slide, setSlide] = useState<Slide | null>(null);
  const [ot, setOt] = useState<OutputTheme | null>(null);

  useEffect(() => {
    const subs = [
      listen<Slide>("slide", (e) => setSlide(e.payload)),
      listen<OutputTheme>("output-theme", (e) => setOt(e.payload)),
    ];
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

  if (!slide) {
    return (
      <div className="output">
        <div className="slide idle">
          <div className="spsub">Agent HSP</div>
        </div>
      </div>
    );
  }

  const bg: any = slideBg(ot);
  const txt: any = ot ? { color: ot.textColor, fontFamily: ot.font === "sans" ? "inherit" : undefined } : undefined;
  const accent: any = ot ? { color: ot.accent } : undefined;

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
    const density = !data
      ? ""
      : count <= 2 && chars < 200
      ? "compact"
      : count <= 3 && chars < 420
      ? "mid"
      : "dense";

    if (data && data.points) {
      return (
        <div className="output">
          <div className={"slide summary " + density} style={bg}>
            {overlayEl(ot)}
            <div className="sumtitle" style={{ position: "relative", zIndex: 1, ...accent }}>
              {slide.title}
            </div>
            <ol className="points" style={{ position: "relative", zIndex: 1 }}>
              {data.points.map((p, i) => (
                <li key={i}>
                  <div className="pointtext" style={txt}>
                    {p.text}
                  </div>
                  {p.verses.length > 0 && (
                    <ul className="subbullets">
                      {p.verses.map((v, j) => (
                        <li key={j} style={accent}>
                          {v}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
            <div className="sumsub" style={{ position: "relative", zIndex: 1 }}>
              {slide.sub}
            </div>
          </div>
        </div>
      );
    }
    const bullets = slide.body.split("\n").filter((b) => b.trim().length > 0);
    return (
      <div className="output">
        <div className="slide summary" style={bg}>
          {overlayEl(ot)}
          <div className="sumtitle" style={{ position: "relative", zIndex: 1, ...accent }}>
            {slide.title}
          </div>
          <ul className="bullets" style={{ position: "relative", zIndex: 1 }}>
            {bullets.map((b, i) => (
              <li key={i} style={txt}>
                {b}
              </li>
            ))}
          </ul>
          <div className="sumsub" style={{ position: "relative", zIndex: 1 }}>
            {slide.sub}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="output">
      <div className="slide verse" style={bg}>
        {overlayEl(ot)}
        <span className="vlogo" style={{ position: "absolute", zIndex: 1 }}>
          AMC CHURCH
        </span>
        <div className={"vtxt " + sizeClass(slide.body)} style={{ position: "relative", zIndex: 1, ...txt }}>
          {slide.body}
        </div>
        <div className="vref" style={{ position: "relative", zIndex: 1, ...accent }}>
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
