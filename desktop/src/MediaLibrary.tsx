// Media page: the library's five folders, files added from the computer, and
// YouTube search and download (yt-dlp, fetched by the app on first use).

import { useEffect, useMemo, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Download, Film, Loader2, Music, Pencil, Play, Plus, Search, Trash2, Upload, Clapperboard } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { MediaFolder, MediaItem, fmtTime } from "@/lib/media";

type YtResult = { id: string; title: string; channel: string; duration_s: number | null; thumbnail: string };

type Props = {
  media: MediaItem[];
  setMedia: (m: MediaItem[]) => void;
  folders: MediaFolder[];
  onPlayAudio: (m: MediaItem) => void;
  onShowVideo: (m: MediaItem) => void;
  onAddToService: (m: MediaItem) => void;
  /** Downloads in progress (kept by App so they survive leaving this page). */
  progress: Record<string, number>;
  setProgress: React.Dispatch<React.SetStateAction<Record<string, number>>>;
};

export default function MediaLibrary({ media, setMedia, folders, onPlayAudio, onShowVideo, onAddToService, progress, setProgress }: Props) {
  const [folder, setFolder] = useState<string>("all");
  const [q, setQ] = useState("");
  const [yt, setYt] = useState<YtResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [target, setTarget] = useState<Record<string, string>>({});
  const [ffmpeg, setFfmpeg] = useState(true);

  useEffect(() => {
    invoke<{ ffmpeg: boolean }>("media_tools").then((t) => setFfmpeg(t.ffmpeg)).catch(() => {});
    void invoke<MediaItem[]>("list_media").then(setMedia).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = useMemo(
    () => media.filter((m) => folder === "all" || m.folder === folder).sort((a, b) => b.added - a.added),
    [media, folder]
  );
  const folderName = (id: string) => folders.find((f) => f.id === id)?.name ?? id;

  async function search() {
    if (!q.trim()) return;
    setSearching(true);
    try {
      setYt(await invoke<YtResult[]>("youtube_search", { query: q }));
    } catch (e) {
      toast.error("YouTube search failed: " + String(e));
    } finally {
      setSearching(false);
    }
  }

  async function importFiles() {
    const dest = folder === "all" ? folders[0]?.id : folder;
    const picked = await openDialog({
      title: "Add audio or video to " + folderName(dest),
      multiple: true,
      filters: [{ name: "Audio and video", extensions: ["mp3", "m4a", "aac", "wav", "ogg", "opus", "flac", "mp4", "m4v", "mov", "webm"] }],
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (!paths.length) return;
    try {
      setMedia(await invoke<MediaItem[]>("import_media", { paths, folder: dest }));
      toast.success("Added to " + folderName(dest) + ".");
    } catch (e) {
      toast.error(String(e));
    }
  }

  function download(r: YtResult) {
    const dest = target[r.id] || (folder !== "all" ? folder : "general-video");
    setProgress((p) => ({ ...p, [r.id]: 0 }));
    void invoke("youtube_download", { videoId: r.id, folder: dest, title: r.title, channel: r.channel }).catch((e) => {
      toast.error(String(e));
      setProgress((p) => {
        const n = { ...p };
        delete n[r.id];
        return n;
      });
    });
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[220px_minmax(0,1fr)_minmax(340px,440px)] grid-rows-[minmax(0,1fr)] gap-3">
      {/* Folders */}
      <div className="flex min-h-0 flex-col gap-1 rounded-lg border bg-card p-2">
        <FolderButton on={folder === "all"} onClick={() => setFolder("all")} label="All media" count={media.length} />
        {folders.map((f) => (
          <FolderButton
            key={f.id}
            on={folder === f.id}
            onClick={() => setFolder(f.id)}
            label={f.name}
            count={media.filter((m) => m.folder === f.id).length}
            icon={f.kind === "audio" ? <Music className="size-4" /> : <Film className="size-4" />}
          />
        ))}
      </div>

      {/* Library */}
      <div className="flex min-h-0 flex-col rounded-lg border bg-card">
        <div className="flex items-center justify-between gap-2 border-b p-3">
          <div className="text-sm font-semibold">{folder === "all" ? "All media" : folderName(folder)}</div>
          <Button size="sm" variant="outline" onClick={() => void importFiles()}>
            <Upload /> Add from this computer
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 p-3">
            {shown.length === 0 && (
              <p className="col-span-full p-2 text-sm text-muted-foreground">
                Nothing here yet. Search YouTube on the right, or add files from this computer.
              </p>
            )}
            {shown.map((m) => (
              <div key={m.id} className="group flex flex-col overflow-hidden rounded-md border bg-background">
                <div className="relative aspect-video bg-black">
                  {m.kind === "video" ? (
                    <video src={convertFileSrc(m.path) + "#t=2"} muted preload="metadata" className="h-full w-full object-cover" />
                  ) : m.youtube_id ? (
                    <img src={"https://i.ytimg.com/vi/" + m.youtube_id + "/mqdefault.jpg"} alt="" className="h-full w-full object-cover opacity-70" />
                  ) : (
                    <div className="grid h-full place-items-center text-white/70"><Music className="size-8" /></div>
                  )}
                  <Badge className="absolute left-1.5 top-1.5 bg-black/70 text-white">{m.kind === "audio" ? "Audio" : "Video"}</Badge>
                </div>
                <div className="flex flex-1 flex-col gap-1 p-2">
                  <div className="line-clamp-2 text-sm font-medium" title={m.title}>{m.title}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {folderName(m.folder)}
                    {m.channel ? " · " + m.channel : ""}
                  </div>
                  <div className="mt-auto flex flex-wrap gap-1 pt-1">
                    <Button size="sm" className="h-7" onClick={() => (m.kind === "audio" ? onPlayAudio(m) : onShowVideo(m))}>
                      <Play /> {m.kind === "audio" ? "Play" : "Show"}
                    </Button>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => onAddToService(m)} title="Add to the open service">
                      <Plus /> Service
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="ml-auto size-7"
                      title="Rename"
                      onClick={() => {
                        const t = window.prompt("Name", m.title);
                        if (t && t.trim()) void invoke<MediaItem[]>("rename_media", { id: m.id, title: t }).then(setMedia);
                      }}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      title="Delete from this computer"
                      onClick={() => {
                        if (window.confirm("Delete “" + m.title + "” from this computer?")) {
                          void invoke<MediaItem[]>("delete_media", { id: m.id }).then(setMedia);
                        }
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* YouTube */}
      <div className="flex min-h-0 flex-col rounded-lg border bg-card">
        <div className="flex flex-col gap-2 border-b p-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Clapperboard className="size-4 text-red-500" /> YouTube
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input className="pl-8" placeholder="Search, e.g. soaking piano instrumental" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <Button type="submit" disabled={searching || !q.trim()}>
              {searching ? <Loader2 className="animate-spin" /> : <Search />} Search
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">
            Download only what your church has the right to use: your own uploads, Creative Commons videos, or music
            covered by your licences (for example CCLI streaming or video licences). YouTube's terms limit downloading.
            {!ffmpeg && " Without ffmpeg installed, videos download at standard quality."}
          </p>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2 p-3">
            {!yt.length && !searching && <p className="text-sm text-muted-foreground">Results appear here.</p>}
            {yt.map((r) => {
              const pct = progress[r.id];
              const dest = target[r.id] || (folder !== "all" ? folder : "general-video");
              return (
                <div key={r.id} className="flex gap-2 rounded-md border p-2">
                  <img src={r.thumbnail} alt="" className="aspect-video w-36 shrink-0 rounded object-cover" loading="lazy" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="line-clamp-2 text-sm font-medium" title={r.title}>{r.title}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {r.channel} · {fmtTime(r.duration_s)}
                    </div>
                    <div className="mt-auto flex items-center gap-1">
                      <Select value={dest} onValueChange={(v) => setTarget((t) => ({ ...t, [r.id]: v }))}>
                        <SelectTrigger className="h-7 min-w-0 flex-1 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {folders.map((f) => (
                            <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {pct != null ? (
                        <div className="flex h-7 w-20 items-center gap-1 text-xs tabular-nums">
                          <Loader2 className="size-3.5 animate-spin" /> {Math.round(pct)}%
                        </div>
                      ) : (
                        <Button size="sm" className="h-7" onClick={() => download(r)}>
                          <Download /> Get
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function FolderButton({ on, onClick, label, count, icon }: { on: boolean; onClick: () => void; label: string; count: number; icon?: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn("flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted", on && "bg-muted font-medium")}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
    </button>
  );
}
