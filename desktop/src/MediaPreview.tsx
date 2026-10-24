// A wide preview player on the Media page, for a YouTube search result
// (before downloading it) or a file in the library. It plays on this
// computer only, never on the projector, and starts with the sound off:
// during a service this computer's sound may be going to the room.
import { ReactNode, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Loader2, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type PreviewTarget =
  | { kind: "youtube"; id: string; title: string; sub: string }
  | { kind: "file"; path: string; audio: boolean; title: string; sub: string };

export default function MediaPreview({ target, onClose, actions }: { target: PreviewTarget | null; onClose: () => void; actions?: ReactNode }) {
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-5xl">
        {target && (
          <>
            <DialogHeader>
              <DialogTitle className="pr-6">{target.title}</DialogTitle>
              <DialogDescription>{target.sub} · preview on this computer only, not on the projector</DialogDescription>
            </DialogHeader>
            <Player key={target.kind === "youtube" ? target.id : target.path} target={target} />
            {actions && <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Player({ target }: { target: PreviewTarget }) {
  const [src, setSrc] = useState<{ video: string; audio: string | null } | null>(
    target.kind === "file" ? { video: convertFileSrc(target.path), audio: null } : null
  );
  const [error, setError] = useState("");
  const [sound, setSound] = useState(false);
  const soundRef = useRef(false);
  soundRef.current = sound;
  const v = useRef<HTMLVideoElement>(null);
  const a = useRef<HTMLAudioElement>(null);
  // The separate picture and sound, to fall back on if HLS fails.
  const separate = useRef<{ video: string; audio: string | null } | null>(null);

  useEffect(() => {
    if (target.kind !== "youtube") return;
    invoke<{ hls: string | null; video: string | null; audio: string | null }>("youtube_preview_url", { videoId: target.id })
      .then((p) => {
        // WebKit (macOS) plays HLS, picture and sound in one; it stalls on the
        // separate files, which WebView2 (Windows, no HLS) plays instead.
        const webkit = !/Windows/i.test(navigator.userAgent);
        separate.current = p.video ? { video: p.video, audio: p.audio } : null;
        if (webkit && p.hls) setSrc({ video: p.hls, audio: null });
        else if (p.video) setSrc({ video: p.video, audio: p.audio });
        else if (p.hls) setSrc({ video: p.hls, audio: null });
        else setError("this computer cannot play YouTube's stream for this video.");
      })
      .catch((e) => setError(String(e).replace(/^Error:\s*/, "")));
  }, [target]);

  // React does not reliably set `muted`; the picture starts silent either way.
  useEffect(() => {
    if (v.current) v.current.muted = true;
  }, [src]);

  // A YouTube preview's sound is a separate stream: keep it with the picture.
  useEffect(() => {
    const vid = v.current;
    const aud = a.current;
    if (!vid || !aud) return;
    const sync = () => {
      if (Math.abs(aud.currentTime - vid.currentTime) > 0.25) aud.currentTime = vid.currentTime;
    };
    const go = () => {
      sync();
      if (soundRef.current) void aud.play().catch(() => {});
    };
    const stop = () => aud.pause();
    const rate = () => (aud.playbackRate = vid.playbackRate);
    vid.addEventListener("playing", go);
    vid.addEventListener("pause", stop);
    vid.addEventListener("waiting", stop);
    vid.addEventListener("seeked", sync);
    vid.addEventListener("ratechange", rate);
    const t = window.setInterval(() => soundRef.current && !vid.paused && sync(), 1000);
    return () => {
      vid.removeEventListener("playing", go);
      vid.removeEventListener("pause", stop);
      vid.removeEventListener("waiting", stop);
      vid.removeEventListener("seeked", sync);
      vid.removeEventListener("ratechange", rate);
      window.clearInterval(t);
      aud.pause();
    };
  }, [src]);

  function toggleSound() {
    const on = !sound;
    setSound(on);
    const vid = v.current;
    const aud = a.current;
    if (!vid) return;
    if (aud) {
      aud.currentTime = vid.currentTime;
      if (on && !vid.paused) void aud.play().catch(() => {});
      else aud.pause();
    } else {
      vid.muted = !on;
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
        {src ? (
          <video
            ref={v}
            src={src.video}
            controls
            autoPlay
            muted
            playsInline
            onError={() => {
              const alt = separate.current;
              if (alt && src.audio === null && src.video !== alt.video) setSrc(alt);
            }}
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="grid h-full place-items-center text-sm text-white/70">
            {error ? "Could not load the preview: " + error : <span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Loading the preview…</span>}
          </div>
        )}
        {src?.audio && <audio ref={a} src={src.audio} preload="auto" />}
        {target.kind === "file" && target.audio && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-white/60">Audio</div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button variant={sound ? "default" : "outline"} size="sm" onClick={toggleSound} disabled={!src}>
          {sound ? <Volume2 /> : <VolumeX />} {sound ? "Sound on" : "Sound off"}
        </Button>
        {!sound && <span className="text-xs text-muted-foreground">Sound starts off: this computer's sound may be going to the room.</span>}
      </div>
    </div>
  );
}
