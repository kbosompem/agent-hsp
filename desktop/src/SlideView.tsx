// Draws one projector slide. The output window and every console preview use
// this same component, so what the operator sees is exactly what the room sees.
// Styles live in slides.css; sizes scale with the box the slide is drawn in.

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

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
  /** What sits in each corner of verse, lyric and text slides. */
  corners?: Partial<Record<CornerPos, Corner>>;
  /** Picture for the Logo screen; the church name is shown when empty. */
  logoImage?: string;
  /** Stock background id (public/backgrounds/manifest.json), for its credit. */
  bgId?: string;
};

export type CornerPos = "tl" | "tr" | "bl" | "br";
export const CORNERS: CornerPos[] = ["tl", "tr", "bl", "br"];
export type Corner = {
  kind: "none" | "text" | "image";
  text?: string;
  /** Data URL of the logo picture. */
  image?: string;
  /** Height as a percentage of the slide height (pictures) or a text scale. */
  size?: number;
};

/** Older themes only had a church name, shown top right. */
export function cornersOf(t: OutputTheme | null): Partial<Record<CornerPos, Corner>> {
  if (t?.corners) return t.corners;
  return { tr: { kind: "text", text: t?.churchName?.trim() || "AMC CHURCH" } };
}

function Corners({ t }: { t: OutputTheme | null }) {
  const cs = cornersOf(t);
  return (
    <>
      {CORNERS.map((pos) => {
        const c = cs[pos];
        if (!c || c.kind === "none") return null;
        if (c.kind === "image" && c.image) {
          return <img key={pos} className={"corner corner-" + pos} src={c.image} alt="" style={{ height: (c.size ?? 9) + "cqh" }} />;
        }
        if (c.kind === "text" && c.text?.trim()) {
          return (
            <span key={pos} className={"corner corner-" + pos + " cornertext"} style={{ fontSize: "calc(" + 1.2 * ((c.size ?? 100) / 100) + "cqw * var(--ts, 1))" }}>
              {c.text}
            </span>
          );
        }
        return null;
      })}
    </>
  );
}

/** A muted, looping background video. React does not set the `muted`
 * attribute, and WebKit only autoplays muted video, so set it by hand and
 * start playback ourselves; restart it if anything pauses it. */
function LoopingVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.muted = true;
    v.defaultMuted = true;
    v.loop = true;
    const play = () => void v.play().catch(() => {});
    play();
    v.addEventListener("canplay", play);
    v.addEventListener("pause", play);
    v.addEventListener("ended", play);
    return () => {
      v.removeEventListener("canplay", play);
      v.removeEventListener("pause", play);
      v.removeEventListener("ended", play);
    };
  }, [src]);
  return (
    <video
      ref={ref}
      src={src}
      autoPlay
      loop
      muted
      playsInline
      disablePictureInPicture
      controls={false}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none" }}
    />
  );
}

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
      {t.bgKind === "video" && t.video && <LoopingVideo key={t.video} src={t.video} />}
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
        {t?.logoImage ? (
          <img className="logoimage" src={t.logoImage} alt={church} style={front} />
        ) : (
          <div className="logoname" style={{ ...front, ...accent }}>{church}</div>
        )}
      </div>
    );
  }

  if (slide.kind === "text") {
    return (
      <div className="slide text" style={bgStyle(t)}>
        <Background t={t} />
        <Corners t={t} />
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
        <Corners t={t} />
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
      <Corners t={t} />
      <div className={"vtxt " + sizeClass(slide.body)} style={{ ...front, ...txt }}>{slide.body}</div>
      <div className="vref" style={{ ...front, ...accent }}>
        {slide.title} · {slide.sub}
      </div>
    </div>
  );
}
