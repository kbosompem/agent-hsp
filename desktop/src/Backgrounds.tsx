// Stock backgrounds: a curated list of free Pexels photos and motion loops
// (public/backgrounds/manifest.json). Nothing is bundled: a background is
// downloaded from Pexels the first time it is chosen and kept in the app data
// folder. Each one credits its creator, here and in the Credits list.

import { useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { Check, Film, Loader2, Plus, Trash2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { OutputTheme } from "./SlideView";

export type StockBackground = {
  id: string;
  kind: "image" | "video";
  title: string;
  creator: string;
  creatorUrl: string;
  sourceUrl: string;
  downloadUrl: string;
  license: string;
  licenseUrl: string;
  /** Small preview picture (videos have one from Pexels too). */
  thumbUrl?: string;
};

/** Small preview image straight from Pexels (images only). */
function thumbUrl(b: StockBackground): string {
  if (b.thumbUrl) return b.thumbUrl;
  return b.downloadUrl.replace(/([?&])w=\d+/, "$1w=400").replace(/([?&])h=\d+/, "$1h=225");
}

function openLink(url: string) {
  void invoke("open_url", { url });
}

export function Credit({ b }: { b: StockBackground }) {
  return (
    <span>
      {b.kind === "video" ? "Video" : "Photo"}: “{b.title}” by{" "}
      <button className="underline underline-offset-2" onClick={() => openLink(b.creatorUrl)}>{b.creator}</button> on{" "}
      <button className="underline underline-offset-2" onClick={() => openLink(b.sourceUrl)}>Pexels</button> ·{" "}
      <button className="underline underline-offset-2" onClick={() => openLink(b.licenseUrl)}>{b.license}</button>
    </span>
  );
}

type Props = { theme: OutputTheme; setTheme: (t: OutputTheme) => void; setStatus: (s: string) => void };

/** A picture or video the church added itself (src-tauri/src/backgrounds.rs). */
type UserBackground = { id: string; kind: "image" | "video"; title: string; file: string; path: string };
type Tab = "image" | "video" | "my-image" | "my-video";

export default function Backgrounds({ theme, setTheme, setStatus }: Props) {
  const [list, setList] = useState<StockBackground[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [credits, setCredits] = useState(false);
  const [mine, setMine] = useState<UserBackground[]>([]);
  const [tab, setTab] = useState<Tab>(() => {
    const own = theme.bgFile?.startsWith("user-");
    return ((own ? "my-" : "") + (theme.bgKind === "video" ? "video" : "image")) as Tab;
  });

  useEffect(() => {
    invoke<UserBackground[]>("list_user_backgrounds").then(setMine).catch(() => setMine([]));
  }, []);

  async function addOwn() {
    const picked = await openDialog({
      title: "Add your own pictures or videos",
      multiple: true,
      filters: [{ name: "Pictures and videos", extensions: ["jpg", "jpeg", "png", "webp", "gif", "mp4", "m4v", "mov", "webm"] }],
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (!paths.length) return;
    try {
      const before = new Set(mine.map((m) => m.id));
      const list = await invoke<UserBackground[]>("import_user_backgrounds", { paths });
      setMine(list);
      const added = list.filter((m) => !before.has(m.id));
      if (added.length) {
        setTab(added[added.length - 1].kind === "video" ? "my-video" : "my-image");
        chooseOwn(added[added.length - 1]);
      }
      setStatus("Added " + added.length + " background" + (added.length === 1 ? "" : "s") + ". They are kept on this computer.");
    } catch (e) {
      setStatus("Could not add those files: " + String(e));
    }
  }

  function chooseOwn(b: UserBackground) {
    const src = convertFileSrc(b.path);
    setTheme({
      ...theme,
      bgKind: b.kind,
      image: b.kind === "image" ? src : theme.image,
      video: b.kind === "video" ? src : theme.video,
      videoPoster: undefined,
      overlay: Math.max(theme.overlay, 0.35),
      bgId: undefined,
      bgFile: b.file,
    });
    setStatus("Background: " + b.title);
  }

  async function removeOwn(b: UserBackground) {
    try {
      setMine(await invoke<UserBackground[]>("delete_user_background", { id: b.id }));
    } catch (e) {
      setStatus("Could not remove it: " + String(e));
    }
  }

  useEffect(() => {
    fetch("/backgrounds/manifest.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((m) => setList(Array.isArray(m) ? m : []))
      .catch(() => setList([]));
  }, []);

  async function choose(b: StockBackground) {
    setBusy(b.id);
    try {
      const path = await invoke<string>("fetch_background", { id: b.id, url: b.downloadUrl, video: b.kind === "video" });
      const src = convertFileSrc(path);
      setTheme({
        ...theme,
        bgKind: b.kind,
        image: b.kind === "image" ? src : theme.image,
        video: b.kind === "video" ? src : theme.video,
        videoPoster: b.kind === "video" ? thumbUrl(b).replace(/w=\d+/, "w=1280").replace(/h=\d+/, "h=720") : theme.videoPoster,
        overlay: Math.max(theme.overlay, 0.4),
        bgId: b.id,
        bgFile: b.id + (b.kind === "video" ? ".mp4" : ".jpg"),
      });
      setStatus("Background: " + b.title + " by " + b.creator + " (Pexels).");
    } catch (e) {
      setStatus("Could not download that background: " + String(e) + ". Check the internet connection.");
    } finally {
      setBusy(null);
    }
  }

  const current = list.find((b) => b.id === theme.bgId && theme.bgKind === b.kind);
  const ownTab = tab === "my-image" || tab === "my-video";
  const ownKind = tab === "my-video" ? "video" : "image";

  const ownTile = (b: UserBackground) => {
    const on = theme.bgFile === b.file && theme.bgKind === b.kind;
    const src = convertFileSrc(b.path);
    return (
      <div key={b.id} className="group relative">
        <button
          title={b.title}
          onClick={() => chooseOwn(b)}
          className={cn("relative block aspect-video w-full overflow-hidden rounded-md border-2 border-transparent bg-muted", on && "border-primary")}
        >
          {b.kind === "image" ? (
            <img src={src} alt={b.title} loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <>
              <video src={src + "#t=1"} muted preload="metadata" className="h-full w-full object-cover" />
              <Film className="absolute bottom-1 left-1 size-3.5 rounded bg-black/60 p-0.5 text-white" />
            </>
          )}
          {on && <Check className="absolute right-1 top-1 size-4 rounded-full bg-primary p-0.5 text-primary-foreground" />}
        </button>
        <button
          title="Remove from this computer"
          onClick={() => void removeOwn(b)}
          className="absolute left-1 top-1 hidden rounded bg-black/60 p-0.5 text-white group-hover:block"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    );
  };

  const tile = (b: StockBackground) => {
    const on = current?.id === b.id;
    return (
      <button
        key={b.id}
        title={b.title + " · " + b.creator}
        onClick={() => void choose(b)}
        className={cn("relative aspect-video overflow-hidden rounded-md border-2 border-transparent bg-muted", on && "border-primary")}
      >
        {b.kind === "image" || b.thumbUrl ? (
          <>
            <img src={thumbUrl(b)} alt={b.title} loading="lazy" className="h-full w-full object-cover" />
            {b.kind === "video" && <Film className="absolute bottom-1 left-1 size-3.5 rounded bg-black/60 p-0.5 text-white" />}
          </>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-slate-800 to-slate-950 p-1 text-white">
            <Film className="size-4 opacity-80" />
            <span className="line-clamp-2 text-center text-[10px] leading-tight opacity-90">{b.title}</span>
          </div>
        )}
        {busy === b.id && (
          <div className="absolute inset-0 grid place-items-center bg-black/50 text-white"><Loader2 className="size-5 animate-spin" /></div>
        )}
        {on && busy !== b.id && <Check className="absolute right-1 top-1 size-4 rounded-full bg-primary p-0.5 text-primary-foreground" />}
      </button>
    );
  };

  return (
    <section className="flex flex-col gap-2">
      <ToggleGroup type="single" size="sm" variant="outline" value={tab} onValueChange={(v) => v && setTab(v as Tab)} className="w-full">
        <ToggleGroupItem value="image" className="flex-1 px-2 text-xs">Photos · {list.filter((b) => b.kind === "image").length}</ToggleGroupItem>
        <ToggleGroupItem value="video" className="flex-1 px-2 text-xs">Motion · {list.filter((b) => b.kind === "video").length}</ToggleGroupItem>
        <ToggleGroupItem value="my-image" className="flex-1 px-2 text-xs">My photos · {mine.filter((b) => b.kind === "image").length}</ToggleGroupItem>
        <ToggleGroupItem value="my-video" className="flex-1 px-2 text-xs">My motion · {mine.filter((b) => b.kind === "video").length}</ToggleGroupItem>
      </ToggleGroup>
      {ownTab ? (
        <>
          <div className="grid grid-cols-3 gap-2">
            {mine.filter((b) => b.kind === ownKind).map(ownTile)}
            <button
              onClick={() => void addOwn()}
              className="flex aspect-video flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed text-xs text-muted-foreground hover:border-primary hover:text-foreground"
            >
              <Plus className="size-4" /> Add {ownKind === "video" ? "videos" : "pictures"}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Your own {ownKind === "video" ? "videos (MP4, MOV, WebM)" : "pictures (JPG, PNG, WebP)"} are copied into the app and kept on this computer. Hover a tile to remove it.
          </p>
        </>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">{list.filter((b) => b.kind === tab).map(tile)}</div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {current ? <Credit b={current} /> : "Free to use from Pexels. Downloaded the first time you pick one, then kept on this computer."}
            </p>
            <Button variant="link" size="sm" className="h-auto shrink-0 p-0 text-xs" onClick={() => setCredits(true)}>Credits</Button>
          </div>
        </>
      )}
      <Dialog open={credits} onOpenChange={setCredits}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Background credits</DialogTitle>
            <DialogDescription>
              These photos and videos are free to use under the Pexels License. Thank you to the creators.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            <ul className="flex flex-col gap-2 pr-3 text-sm">
              {list.map((b) => (
                <li key={b.id}><Credit b={b} /></li>
              ))}
            </ul>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </section>
  );
}
