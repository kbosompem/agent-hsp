// ShemenMusic and Songbook tabs on the Media page: browse songs with backing
// tracks, preview, and "Get song" (lyrics into the song library, track into
// the media library) or just the track.

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, Download, FileText, FolderOpen, Loader2, Music, Pause, Play, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CatalogSong, Songbook, catalogToSong, searchCatalog, shemenCatalog, songbookCatalog } from "@/lib/catalog";
import { Song } from "@/lib/library";
import { MediaFolder, MediaItem, fmtTime } from "@/lib/media";

type Props = {
  source: "shemen" | "songbook";
  media: MediaItem[];
  songs: Song[];
  folders: MediaFolder[];
  onAddSongs: (songs: Song[]) => void;
  progress: Record<string, number>;
  setProgress: React.Dispatch<React.SetStateAction<Record<string, number>>>;
};

export default function SongCatalog({ source, media, songs, folders, onAddSongs, progress, setProgress }: Props) {
  const [items, setItems] = useState<CatalogSong[] | null>(null);
  const [bookName, setBookName] = useState("");
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [folder, setFolder] = useState("instrumental-audio");
  const [playing, setPlaying] = useState<string | null>(null);
  const preview = useRef<HTMLAudioElement | null>(null);

  async function loadShemen(refresh: boolean) {
    setLoading(true);
    try {
      setItems(shemenCatalog(await invoke("shemen_catalog", { refresh })));
    } catch (e) {
      toast.error(String(e));
      setItems((i) => i ?? []);
    } finally {
      setLoading(false);
    }
  }

  function showBook(text: string) {
    if (!text.trim()) return setItems([]);
    const b = JSON.parse(text) as Songbook;
    setBookName(b.name);
    setItems(songbookCatalog(b));
  }

  async function openBook() {
    const picked = await openDialog({ title: "Open a songbook", filters: [{ name: "Songbook", extensions: ["json"] }] });
    if (typeof picked !== "string") return;
    try {
      showBook(await invoke<string>("import_songbook", { path: picked }));
    } catch (e) {
      toast.error(String(e));
    }
  }

  useEffect(() => {
    if (source === "shemen") void loadShemen(false);
    else void invoke<string>("load_songbook").then(showBook).catch((e) => toast.error(String(e)));
    return () => preview.current?.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const shown = useMemo(() => searchCatalog(items ?? [], q), [items, q]);
  const have = useMemo(() => new Set(songs.map((s) => s.source).filter(Boolean)), [songs]);
  const got = useMemo(() => new Set(media.map((m) => m.source_url).filter(Boolean)), [media]);

  function getTrack(c: CatalogSong) {
    const url = c.audioUrl;
    if (!url || got.has(url) || progress[url] != null) return;
    setProgress((p) => ({ ...p, [url]: 0 }));
    void invoke("fetch_audio", { key: url, url, folder, title: c.title }).catch((e) => {
      toast.error(String(e));
      setProgress((p) => {
        const n = { ...p };
        delete n[url];
        return n;
      });
    });
  }

  function getSongs(list: CatalogSong[]) {
    const fresh = list.filter((c) => c.lyrics && !have.has(c.key)).map(catalogToSong).filter((s) => s.sections.length);
    if (fresh.length) onAddSongs(fresh);
    list.forEach(getTrack);
    return fresh.length;
  }

  function getAll() {
    const todo = shown.filter((c) => (c.lyrics && !have.has(c.key)) || (c.audioUrl && !got.has(c.audioUrl)));
    if (!todo.length) return toast.message("Everything shown is already in the library.");
    if (todo.length > 25 && !window.confirm("Get " + todo.length + " songs? Tracks download one at a time.")) return;
    const n = getSongs(todo);
    toast.success(n + " song" + (n === 1 ? "" : "s") + " added to the song library; tracks are downloading.");
  }

  function togglePreview(c: CatalogSong) {
    const a = preview.current;
    if (!a || !c.audioUrl) return;
    if (playing === c.key) {
      a.pause();
      setPlaying(null);
      return;
    }
    a.src = c.audioUrl;
    void a.play().then(() => setPlaying(c.key)).catch((e) => toast.error("Could not play: " + String(e?.message || e)));
  }

  const pending = Object.keys(progress).filter((k) => k.startsWith("http")).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <audio ref={preview} onEnded={() => setPlaying(null)} className="hidden" />
      <div className="flex flex-col gap-2 border-b p-3 pt-0">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input className="pl-8" placeholder="Search title or lyrics" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {source === "shemen" ? (
            <Button variant="outline" size="icon" title="Check ShemenMusic for new songs" disabled={loading} onClick={() => void loadShemen(true)}>
              <RefreshCw className={loading ? "animate-spin" : ""} />
            </Button>
          ) : (
            <Button variant="outline" onClick={() => void openBook()} title="Open a songbook file (.json)">
              <FolderOpen /> Open
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">Tracks go to</span>
          <Select value={folder} onValueChange={setFolder}>
            <SelectTrigger className="h-7 min-w-0 flex-1 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {folders.filter((f) => f.kind === "audio").map((f) => (
                <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="secondary" className="h-7" disabled={!shown.length} onClick={getAll} title="Get every song shown: lyrics and tracks">
            <Download /> Get all {shown.length ? "(" + shown.length + ")" : ""}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {source === "shemen"
            ? "Songs and backing tracks from shemenmusic.com, the church's music repository."
            : bookName
              ? bookName + ". Lyrics stay on this computer."
              : "Open a songbook file made from the church's PDF songbook."}
          {pending > 0 && " Downloading " + pending + " track" + (pending === 1 ? "" : "s") + "…"}
        </p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col p-1">
          {items == null || (loading && !items.length) ? (
            <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> {source === "shemen" ? "Getting the song list from ShemenMusic…" : "Loading…"}
            </p>
          ) : !shown.length ? (
            <p className="p-2 text-sm text-muted-foreground">{items.length ? "No songs match." : source === "songbook" ? "No songbook open yet." : "No songs found."}</p>
          ) : (
            shown.slice(0, 300).map((c) => {
              const inLib = have.has(c.key);
              const hasTrack = !!c.audioUrl && got.has(c.audioUrl);
              const pct = c.audioUrl ? progress[c.audioUrl] : undefined;
              const direct = !!c.audioUrl && !c.audioUrl.includes("mediafire.com/file/");
              return (
                <div key={c.key} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                  <Button size="icon" variant="ghost" className="size-7 shrink-0" disabled={!direct} title={direct ? "Preview" : "Preview after downloading"} onClick={() => togglePreview(c)}>
                    {playing === c.key ? <Pause /> : <Play />}
                  </Button>
                  <div className="min-w-0 flex-1">
                    <div className="truncate" title={c.title}>{c.title}</div>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {c.durationS ? <span>{fmtTime(c.durationS)}</span> : null}
                      {c.lyrics ? <span className="flex items-center gap-0.5"><FileText className="size-3" /> lyrics</span> : <span>no lyrics</span>}
                      {!c.audioUrl && <span>· no track</span>}
                    </div>
                  </div>
                  {inLib && <Badge variant="secondary" title="Lyrics are in the song library"><Check className="size-3" /> Song</Badge>}
                  {hasTrack && <Badge variant="secondary" title="Track is in the media library"><Music className="size-3" /> Track</Badge>}
                  {pct != null ? (
                    <span className="flex w-16 items-center justify-end gap-1 text-xs tabular-nums">
                      <Loader2 className="size-3.5 animate-spin" /> {pct > 0 ? Math.round(pct) + "%" : "queued"}
                    </span>
                  ) : (!inLib && c.lyrics) || (c.audioUrl && !hasTrack) ? (
                    <Button size="sm" className="h-7" onClick={() => getSongs([c])} title={c.lyrics ? "Add the lyrics to the song library and download the track" : "Download the track"}>
                      <Download /> Get
                    </Button>
                  ) : null}
                </div>
              );
            })
          )}
          {shown.length > 300 && <p className="p-2 text-xs text-muted-foreground">Showing 300 of {shown.length}. Search to narrow it down.</p>}
        </div>
      </ScrollArea>
    </div>
  );
}
