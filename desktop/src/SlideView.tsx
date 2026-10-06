// Draws one projector slide. The output window and every console preview use
// this same component, so what the operator sees is exactly what the room sees.
// Styles live in slides.css; sizes scale with the box the slide is drawn in.

import type { CSSProperties, ReactNode } from "react";

export type Slide = { kind: string; title: string; body: string; sub: string };

export type OutputTheme = {
  bgKind: "gradient" | "image" | "video";
  gradient: string;
  /** Image URL or data URL. */
  image: string;
  /** Looping video URL (asset protocol), for motion backgrounds. */
  video?: string;
  overlay: number;
  textColor: string;
  accent: string;
  font: "serif" | "sans";
  textScale?: number;
  churchName?: string;
  /** Stock background id (public/backgrounds/manifest.json), for its credit. */
  bgId?: string;
};

export function sizeClass(text: string): string {
  if (text.length < 90) return "xl";
  if (text.length < 200) return "lg";
  return "md";
}

type SummaryData = { points: { text: string; verses: string[] }[] };

function density(data: SummaryData | null): string {
  if (!data) return "";
  let chars = 0;
  data.points.forEach((p) => (chars += p.text.length + p.verses.length * 9));
  const n = data.points.length;
  return n <= 2 && chars < 200 ? "compact" : n <= 3 && chars < 420 ? "mid" : "dense";
}

function Background({ t }: { t: OutputTheme | null }) {
  if (!t) return null;
  return (
    <>
      {t.bgKind === "video" && t.video && (
        <video
          key={t.video}
          src={t.video}
          autoPlay
          loop
          muted
          playsInline
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
      {(t.bgKind === "image" || t.bgKind === "video") && t.overlay > 0 && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(5,8,14," + t.overlay + ")" }} />
      )}
    </>
  );
}

function bgStyle(t: OutputTheme | null): CSSProperties {
  const base: any = { "--ts": t?.textScale ?? 1 };
  if (!t) return base;
  if (t.bgKind === "image" && t.image) {
    return { ...base, backgroundImage: "url(" + t.image + ")", backgroundSize: "cover", backgroundPosition: "center" };
  }
  if (t.bgKind === "video") return { ...base, background: "#000" };
  return { ...base, background: t.gradient };
}

const front: CSSProperties = { position: "relative", zIndex: 1 };

export default function SlideView({ slide, theme, idle }: { slide: Slide | null; theme: OutputTheme | null; idle?: ReactNode }) {
  const t = theme;
  const txt: CSSProperties = t ? { color: t.textColor, fontFamily: t.font === "sans" ? "inherit" : undefined } : {};
  const accent: CSSProperties = t ? { color: t.accent } : {};
  const church = t?.churchName?.trim() || "AMC CHURCH";

  if (!slide) {
    return (
      <div className="slide idle">
        <div className="spsub">{idle ?? "Agent HSP"}</div>
      </div>
    );
  }

  if (slide.kind === "blank") return <div className="slide idle" style={{ background: "#000" }} />;

  if (slide.kind === "logo") {
    return (
      <div className="slide logo" style={bgStyle(t)}>
        <Background t={t} />
        <div className="logoname" style={{ ...front, ...accent }}>{church}</div>
      </div>
    );
  }

  if (slide.kind === "text") {
    return (
      <div className="slide text" style={bgStyle(t)}>
        <Background t={t} />
        {slide.title && <div className="texttitle" style={{ ...front, ...accent }}>{slide.title}</div>}
        <div className={"textbody " + sizeClass(slide.body)} style={{ ...front, ...txt }}>{slide.body}</div>
        {slide.sub && <div className="textsub" style={{ zIndex: 1 }}>{slide.sub}</div>}
      </div>
    );
  }

  if (slide.kind === "summary") {
    let data: SummaryData | null = null;
    try {
      data = JSON.parse(slide.body);
    } catch {
      data = null;
    }
    return (
      <div className={"slide summary " + density(data)} style={bgStyle(t)}>
        <Background t={t} />
        <div className="sumtitle" style={{ ...front, ...accent }}>{slide.title}</div>
        {data && data.points ? (
          <ol className="points" style={front}>
            {data.points.map((p, i) => (
              <li key={i}>
                <div className="pointtext" style={txt}>{p.text}</div>
                {p.verses.length > 0 && (
                  <ul className="subbullets">
                    {p.verses.map((v, j) => (
                      <li key={j} style={accent}>{v}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <ul className="bullets" style={front}>
            {slide.body.split("\n").filter((b) => b.trim()).map((b, i) => (
              <li key={i} style={txt}>{b}</li>
            ))}
          </ul>
        )}
        <div className="sumsub" style={front}>{slide.sub}</div>
      </div>
    );
  }

  return (
    <div className="slide verse" style={bgStyle(t)}>
      <Background t={t} />
      <span className="vlogo" style={{ position: "absolute", zIndex: 1 }}>{church}</span>
      <div className={"vtxt " + sizeClass(slide.body)} style={{ ...front, ...txt }}>{slide.body}</div>
      <div className="vref" style={{ ...front, ...accent }}>
        {slide.title} · {slide.sub}
      </div>
    </div>
  );
}
