// Background audio while projecting: piano under prayer, a song track, an
// instrumental. Plays from the console window through the computer's sound
// output and keeps going while slides change. Shown as a bar at the bottom
// of the console whenever something is loaded.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Music, Pause, Play, Repeat, Square, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { MediaItem, fmtTime } from "@/lib/media";

export type AudioControl = {
  /** Start `item` (from the top). Does nothing if it is already playing. */
  play: (item: MediaItem, opts?: { loop?: boolean }) => void;
  /** Fade out over `seconds`, then stop. */
  fadeOut: (seconds?: number) => void;
  stop: () => void;
  current: () => MediaItem | null;
};

const VOLUME_KEY = "hsp-audio-volume";

const AudioPlayer = forwardRef<AudioControl, { onStatus?: (s: string) => void }>(function AudioPlayer({ onStatus }, ref) {
  const el = useRef<HTMLAudioElement>(null);
  const [item, setItem] = useState<MediaItem | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [volume, setVolume] = useState(() => {
    try {
      const v = parseFloat(localStorage.getItem(VOLUME_KEY) || "");
      return isFinite(v) ? v : 0.8;
    } catch {
      return 0.8;
    }
  });
  const [muted, setMuted] = useState(false);
  const fade = useRef<number | null>(null);
  const itemRef = useRef<MediaItem | null>(null);
  itemRef.current = item;

  useEffect(() => {
    if (el.current) el.current.volume = muted ? 0 : volume;
    try {
      localStorage.setItem(VOLUME_KEY, String(volume));
    } catch {
      /* ignore */
    }
  }, [volume, muted]);

  function clearFade() {
    if (fade.current != null) window.clearInterval(fade.current);
    fade.current = null;
  }

  function stop() {
    clearFade();
    const a = el.current;
    if (a) {
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
    setItem(null);
    setPlaying(false);
  }

  useImperativeHandle(ref, () => ({
    play(next, opts) {
      const a = el.current;
      if (!a) return;
      if (itemRef.current?.id === next.id && !a.paused) {
        // Already playing: just cancel a fade-out in progress and restore the volume.
        if (fade.current != null) {
          clearFade();
          a.volume = muted ? 0 : volume;
        }
        return;
      }
      clearFade();
      setItem(next);
      setLoop(!!opts?.loop);
      a.loop = !!opts?.loop;
      a.src = convertFileSrc(next.path);
      a.volume = muted ? 0 : volume;
      void a.play().catch((e) => onStatus?.("Could not play " + next.title + ": " + String(e)));
      onStatus?.("Playing " + next.title);
    },
    fadeOut(seconds = 4) {
      const a = el.current;
      if (!a || a.paused) return stop();
      clearFade();
      const start = a.volume;
      const steps = Math.max(1, Math.round(seconds * 20));
      let i = 0;
      fade.current = window.setInterval(() => {
        i++;
        a.volume = Math.max(0, start * (1 - i / steps));
        if (i >= steps) stop();
      }, 50);
    },
    stop,
    current: () => itemRef.current,
  }));

  return (
    <>
      <audio
        ref={el}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => !loop && setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
      />
      {item && (
        <div className="flex h-12 shrink-0 items-center gap-3 border-t bg-card px-4">
          <Music className="size-4 shrink-0 text-primary" />
          <div className="w-56 min-w-0 truncate text-sm font-medium" title={item.title}>{item.title}</div>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={() => {
              const a = el.current;
              if (!a) return;
              clearFade();
              a.volume = muted ? 0 : volume;
              if (a.paused) void a.play();
              else a.pause();
            }}
            title={playing ? "Pause" : "Play"}
          >
            {playing ? <Pause /> : <Play />}
          </Button>
          <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">{fmtTime(time)}</span>
          <Slider
            className="min-w-24 flex-1"
            min={0}
            max={Math.max(1, dur || 1)}
            step={1}
            value={[Math.min(time, dur || time)]}
            onValueChange={(v) => {
              if (el.current) el.current.currentTime = v[0];
            }}
          />
          <span className="w-12 text-xs tabular-nums text-muted-foreground">{fmtTime(dur)}</span>
          <Button
            size="icon"
            variant="ghost"
            className={cn("size-8", loop && "text-primary")}
            title={loop ? "Looping" : "Loop"}
            onClick={() => {
              setLoop(!loop);
              if (el.current) el.current.loop = !loop;
            }}
          >
            <Repeat />
          </Button>
          <Button size="icon" variant="ghost" className="size-8" title={muted ? "Unmute" : "Mute"} onClick={() => setMuted(!muted)}>
            {muted ? <VolumeX /> : <Volume2 />}
          </Button>
          <Slider className="w-24" min={0} max={1} step={0.01} value={[volume]} onValueChange={(v) => setVolume(v[0])} />
          <Button size="sm" variant="outline" onClick={() => {
            const a = el.current;
            if (!a || a.paused) return stop();
            clearFade();
            const start = a.volume;
            let i = 0;
            fade.current = window.setInterval(() => {
              i++;
              a.volume = Math.max(0, start * (1 - i / 80));
              if (i >= 80) stop();
            }, 50);
          }} title="Fade out over 4 seconds">
            Fade out
          </Button>
          <Button size="icon" variant="ghost" className="size-8" title="Stop" onClick={stop}>
            <Square />
          </Button>
        </div>
      )}
    </>
  );
});

export default AudioPlayer;
