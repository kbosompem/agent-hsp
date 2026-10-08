// Draws one projector slide. The output window and every console preview use
// this same component, so what the operator sees is exactly what the room sees.
// Styles live in slides.css; sizes scale with the box the slide is drawn in.

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";

export type Slide = { kind: string; title: string; body: string; sub: string };

export type OutputTheme = {
  bgKind: "gradient" | "image" | "video";
  gradient: string;
  /** Image URL or data URL. */
  image: string;
  /** Looping video URL (asset protocol), for motion backgrounds. */
  video?: string;
  /** Still picture of the video, for thumbnails that should not play it. */
  videoPoster?: string;
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
  /** File name of the background in the app data backgrounds/ folder
   * (stock downloads and the church's own), for service bundles. */
  bgFile?: string;
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

/** A muted background video that loops without a visible jump: two copies
 * of the clip, and one second before the visible one ends the other starts
 * from the beginning and fades in over it. Most stock clips are camera
 * footage, not seamless loops, so a plain `loop` would jump.
 *
 * React does not set the `muted` attribute and WebKit only autoplays muted
 * video, so muting and playback are done by hand. */
const FADE_S = 1.0;

function LoopingVideo({ src }: { src: string }) {
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  const front = useRef<0 | 1>(0);
  useEffect(() => {
    const vids = [a.current, b.current];
    if (!vids[0] || !vids[1]) return;
    for (const v of vids as HTMLVideoElement[]) {
      v.muted = true;
      v.defaultMuted = true;
      v.loop = false;
    }
    const [v0, v1] = vids as HTMLVideoElement[];
    front.current = 0;
    v0.style.opacity = "1";
    v1.style.opacity = "0";
    v1.pause();
    const play = (v: HTMLVideoElement) => void v.play().catch(() => {});
    play(v0);
    let fading = false;
    const tick = () => {
      const cur = front.current === 0 ? v0 : v1;
      const next = front.current === 0 ? v1 : v0;
      // Keep the visible copy running whatever paused it.
      if (cur.paused && !fading) play(cur);
      const d = cur.duration;
      if (!fading && d && isFinite(d) && d > FADE_S * 3 && cur.currentTime >= d - FADE_S) {
        fading = true;
        next.currentTime = 0;
        play(next);
        next.style.transition = "opacity " + FADE_S + "s linear";
        cur.style.transition = "opacity " + FADE_S + "s linear";
        next.style.opacity = "1";
        cur.style.opacity = "0";
        window.setTimeout(() => {
          cur.pause();
          front.current = front.current === 0 ? 1 : 0;
          fading = false;
        }, FADE_S * 1000 + 50);
      } else if (cur.ended && !fading) {
        // Clips too short to crossfade just restart.
        cur.currentTime = 0;
        play(cur);
      }
    };
    const t = window.setInterval(tick, 100);
    return () => window.clearInterval(t);
  }, [src]);
  const style: CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none" };
  return (
    <>
      <video ref={a} src={src} autoPlay muted playsInline preload="auto" disablePictureInPicture controls={false} style={style} />
      <video ref={b} src={src} muted playsInline preload="auto" disablePictureInPicture controls={false} style={{ ...style, opacity: 0 }} />
    </>
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

function Background({ t, still }: { t: OutputTheme | null; still?: boolean }) {
  if (!t) return null;
  return (
    <>
      {t.bgKind === "video" && t.video && !still && <LoopingVideo key={t.video} src={t.video} />}
      {t.bgKind === "video" && still && t.videoPoster && (
        <img src={t.videoPoster} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
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

/** A video slide (kind "video", body = file URL). Only the projector plays
 * its sound; console previews are muted. "video-control" events
 * (play / pause / restart) drive every copy together. */
function VideoSlide({ src, still }: { src: string; still?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    // Every on-screen copy is muted (muted video may always autoplay). The
    // sound comes from the console (VideoSound in App.tsx), which the
    // operator has clicked, and "video-sync" keeps these copies in step.
    v.muted = true;
    if (still) return;
    void v.play().catch(() => {});
    const un = listen<{ src: string; t: number; playing: boolean }>("video-sync", (e) => {
      const m = e.payload;
      if (m.src !== src) return;
      if (m.playing && v.paused) void v.play().catch(() => {});
      if (!m.playing && !v.paused) v.pause();
      const drift = v.currentTime - m.t;
      if (Math.abs(drift) > 0.35) {
        v.currentTime = m.t;
        v.playbackRate = 1;
      } else if (m.playing) {
        // Small drift: catch up gently instead of jumping.
        v.playbackRate = Math.abs(drift) < 0.04 ? 1 : drift > 0 ? 0.96 : 1.04;
      }
    });
    return () => void un.then((f) => f());
  }, [src, still]);
  return (
    <div className="slide idle" style={{ background: "#000" }}>
      <video
        ref={ref}
        src={src + (still ? "#t=2" : "")}
        muted
        playsInline
        preload={still ? "metadata" : "auto"}
        disablePictureInPicture
        controls={false}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
      />
    </div>
  );
}

/** `still`: draw a motion background as its poster picture (thumbnails).
 * Video slides play muted everywhere; their sound comes from the console. */
export default function SlideView({ slide, theme, idle, still }: { slide: Slide | null; theme: OutputTheme | null; idle?: ReactNode; still?: boolean }) {
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

  if (slide.kind === "video") return <VideoSlide key={slide.body} src={slide.body} still={still} />;

  if (slide.kind === "blank") return <div className="slide idle" style={{ background: "#000" }} />;

  if (slide.kind === "logo") {
    return (
      <div className="slide logo" style={bgStyle(t)}>
        <Background t={t} still={still} />
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
        <Background t={t} still={still} />
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
        <Background t={t} still={still} />
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
      <Background t={t} still={still} />
      <Corners t={t} />
      <div className={"vtxt " + sizeClass(slide.body)} style={{ ...front, ...txt }}>{slide.body}</div>
      <div className="vref" style={{ ...front, ...accent }}>
        {slide.title} · {slide.sub}
      </div>
    </div>
  );
}
