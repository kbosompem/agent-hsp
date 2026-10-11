// First-run setup: offers the downloads the app needs, each optional, and
// gets the ticked ones in one go. Shown on a fresh install (no songs yet) and
// from Settings > Setup.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { catalogToSong, shemenCatalog } from "@/lib/catalog";
import { logEvent } from "@/lib/log";
import { Song } from "@/lib/library";

type Task = "nemotron" | "whisper" | "ytdlp" | "shemen" | "shemenTracks";
type State = { status: "waiting" | "working" | "done" | "failed"; note?: string };

type Props = {
  open: boolean;
  onClose: () => void;
  /** This build includes the Nemotron engine. */
  nemotron: boolean;
  /** The Whisper model to offer: small.en on Macs, base.en elsewhere. */
  whisperModel: string;
  onAddSongs: (songs: Song[]) => void;
  /** Called with the speech model to use once setup has installed one. */
  onModel: (model: string) => void;
};

const NEMOTRON = "nemotron-160";

/** Download a speech model and wait for it. One at a time: the progress events do not say which model they are for. */
function getModel(model: string, progress: (note: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const off: (() => void)[] = [];
    const done = (err?: string) => {
      off.forEach((f) => f());
      if (err) reject(new Error(err));
      else resolve();
    };
    void Promise.all([
      listen<string>("model-ready", (e) => e.payload === model && done()),
      listen<any>("model-progress", (e) => {
        const p = e.payload;
        if (p.status === "error") done(p.error || "download failed");
        else if (p.status === "progress" && p.total) progress(Math.round(p.loaded / 1048576) + " / " + Math.round(p.total / 1048576) + " MB");
        else if (p.status === "unpacking") progress("unpacking…");
      }),
    ])
      .then((fns) => {
        off.push(...fns);
        return invoke("ensure_model", { model });
      })
      .catch((e) => done(String(e)));
  });
}

export default function Setup({ open, onClose, nemotron, whisperModel, onAddSongs, onModel }: Props) {
  const tasks: { id: Task; label: string; detail: string; on: boolean }[] = [
    ...(nemotron ? [{ id: "nemotron" as Task, label: "Nemotron speech model", detail: "Hears Bible references in about a second, offline. 650 MB.", on: true }] : []),
    {
      id: "whisper",
      label: "Whisper speech model",
      detail: (nemotron ? "A slower backup to Nemotron. " : "Hears Bible references, offline. ") + (whisperModel === "small.en" ? "465 MB." : "140 MB."),
      on: !nemotron,
    },
    { id: "ytdlp", label: "YouTube downloader (yt-dlp)", detail: "Search and download YouTube videos on the Media page. 15 to 35 MB.", on: true },
    { id: "shemen", label: "ShemenMusic songs and lyrics", detail: "The church's song repository: about 400 songs into the song library.", on: true },
    { id: "shemenTracks", label: "ShemenMusic backing tracks", detail: "Every backing track, about 450 files and several GB. Downloads one at a time in the background.", on: false },
  ];
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [state, setState] = useState<Record<string, State>>({});
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (open) {
      setPicked(Object.fromEntries(tasks.map((t) => [t.id, t.on])));
      setState({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, nemotron]);

  const set = (id: Task, s: State) => setState((m) => ({ ...m, [id]: s }));

  async function step(id: Task, work: (note: (n: string) => void) => Promise<string | void>) {
    if (!picked[id] || !tasks.some((t) => t.id === id)) return;
    set(id, { status: "working" });
    try {
      const note = await work((n) => set(id, { status: "working", note: n }));
      set(id, { status: "done", note: note || undefined });
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      logEvent("error", "setup: " + id + " failed: " + msg);
      set(id, { status: "failed", note: msg });
    }
  }

  async function run() {
    setRunning(true);
    const models = (async () => {
      let haveNemotron = false;
      await step("nemotron", async (note) => {
        await getModel(NEMOTRON, note);
        haveNemotron = true;
        onModel(NEMOTRON);
      });
      await step("whisper", async (note) => {
        await getModel(whisperModel, note);
        if (!haveNemotron) onModel(whisperModel);
      });
    })();
    const ytdlp = step("ytdlp", () => invoke("install_ytdlp"));
    const shemen = (async () => {
      let raw: any[] | null = null;
      const catalog = async () => (raw ??= await invoke<any[]>("shemen_catalog", { refresh: false }));
      await step("shemen", async () => {
        const songs = shemenCatalog(await catalog()).filter((c) => c.lyrics).map(catalogToSong).filter((s) => s.sections.length);
        onAddSongs(songs);
        return songs.length + " songs added";
      });
      await step("shemenTracks", async () => {
        const list = shemenCatalog(await catalog()).filter((c) => c.audioUrl);
        for (const c of list) await invoke("fetch_audio", { key: c.audioUrl, url: c.audioUrl, folder: "instrumental-audio", title: c.title });
        return list.length + " tracks queued; see the Media page";
      });
    })();
    await Promise.all([models, ytdlp, shemen]);
    setRunning(false);
  }

  const started = Object.keys(state).length > 0;
  const anyPicked = tasks.some((t) => picked[t.id]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !running && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up Agent HSP</DialogTitle>
          <DialogDescription>Choose what to download now. Each is optional, and you can run this again from Settings.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          {tasks.map((t) => {
            const s = state[t.id];
            return (
              <label key={t.id} className="flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-primary"
                  checked={!!picked[t.id]}
                  disabled={running || started}
                  onChange={(e) => setPicked((p) => ({ ...p, [t.id]: e.target.checked }))}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{t.label}</div>
                  <div className="text-xs text-muted-foreground">{t.detail}</div>
                  {s?.note && <div className={"text-xs " + (s.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{s.note}</div>}
                </div>
                <span className="mt-0.5 w-5 shrink-0">
                  {s?.status === "working" && <Loader2 className="size-4 animate-spin" />}
                  {s?.status === "done" && <Check className="size-4 text-live" />}
                  {s?.status === "failed" && <X className="size-4 text-destructive" />}
                </span>
              </label>
            );
          })}
        </div>
        <DialogFooter>
          {started && !running ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" disabled={running} onClick={onClose}>Skip</Button>
              <Button disabled={running || !anyPicked} onClick={() => void run()}>
                {running ? <><Loader2 className="animate-spin" /> Downloading…</> : "Download selected"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
