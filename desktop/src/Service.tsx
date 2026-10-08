// Service page: build the order of service, keep a song library, and run the
// service live. Everything here is manual; the AI only acts inside a sermon
// item (App turns Hold on for every other item).

import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Agenda,
  AgendaItem,
  AgendaKind,
  ItemSlide,
  Library,
  Song,
  duplicateAgenda,
  newAgenda,
  newId,
  parsePlainSong,
  parseSongFile,
  songSlides,
  songToText,
  textSlides,
} from "./lib/library";
import { parseVideoPsalmAgenda, parseVideoPsalmJson } from "./lib/videopsalm";
import {
  BookOpen, ChevronDown, ChevronUp, Copy, Download, EyeOff, FolderInput, Package, FileText, GripVertical, Image as ImageIcon, Mic, MoreHorizontal,
  Music, Pencil, Play, Plus, Search, Trash2, Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import SlideView, { OutputTheme } from "./SlideView";
import { PerSlide, parsePerSlide } from "./lib/verses";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { buildServiceFile, mergeServiceFile, parseServiceFile, ServiceFile } from "./lib/serviceFile";

export type ServiceNav = { next: () => void; prev: () => void };

type Props = {
  library: Library;
  setLibrary: (l: Library) => void;
  /** The live projector screen and its Blackout / Logo / Hold buttons, from App. */
  live: ReactNode;
  liveControls: ReactNode;
  /** Projector theme, for slide thumbnails. */
  theme: OutputTheme;
  /** Replace the projector theme (applying an imported service's look). */
  setTheme: (t: OutputTheme) => void;
  /** Put one slide on the projector. */
  showSlide: (s: ItemSlide) => Promise<void>;
  /** Verse slides for a scripture item ("John 3:16-18") in a translation (default: the Live page's). */
  scriptureSlides: (reference: string, translation?: string, per?: PerSlide) => Promise<ItemSlide[]>;
  /** Verses per slide from the Look page, the default for readings. */
  perSlide: PerSlide;
  /** Loaded translations, and the one the Live page uses. */
  translations: { id: string; name: string; abbrev?: string }[];
  translation: string;
  /** Called when the operator goes live on an item (App sets Hold, starts the sermon). */
  onEnterItem: (item: AgendaItem) => void;
  registerNav: (nav: ServiceNav | null) => void;
  setStatus: (s: string) => void;
};

const LIVE_KEY = "hsp-live-position";

const KIND_ICONS: Record<AgendaKind, typeof Music> = {
  song: Music,
  scripture: BookOpen,
  text: FileText,
  logo: ImageIcon,
  blank: EyeOff,
  sermon: Mic,
};

const KIND_NAMES: Record<AgendaKind, string> = {
  song: "Song",
  scripture: "Scripture",
  text: "Text / announcement",
  logo: "Logo",
  blank: "Blackout",
  sermon: "Sermon (AI listens)",
};

export default function Service(p: Props) {
  const lib = p.library;
  const agenda = lib.agendas.find((a) => a.id === lib.currentAgendaId) || null;
  const [selId, setSelId] = useState<string | null>(null);
  // Where the service is, kept across a restart (issue 14).
  const [live, setLiveState] = useState<{ itemId: string; idx: number } | null>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(LIVE_KEY) || "null");
      if (v && v.agendaId === lib.currentAgendaId && Date.now() - v.at < 3 * 3600 * 1000) return { itemId: v.itemId, idx: v.idx };
    } catch {
      /* nothing saved */
    }
    return null;
  });
  function setLive(v: { itemId: string; idx: number } | null) {
    setLiveState(v);
    try {
      localStorage.setItem(LIVE_KEY, JSON.stringify(v ? { ...v, agendaId: lib.currentAgendaId, at: Date.now() } : null));
    } catch {
      /* ignore */
    }
  }
  const [slides, setSlides] = useState<Record<string, ItemSlide[]>>({});
  const [songQ, setSongQ] = useState("");
  const [editSong, setEditSong] = useState<{ id: string | null; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const songSearchRef = useRef<HTMLInputElement>(null);

  const songsById = useMemo(() => new Map(lib.songs.map((s) => [s.id, s])), [lib.songs]);
  const sel = agenda?.items.find((i) => i.id === selId) || null;

  function update(fn: (l: Library) => Library) {
    p.setLibrary(fn(lib));
  }
  function updateAgenda(fn: (a: Agenda) => Agenda) {
    if (!agenda) return;
    update((l) => ({ ...l, agendas: l.agendas.map((a) => (a.id === agenda.id ? fn(a) : a)) }));
  }
  function updateItem(id: string, patch: Partial<AgendaItem>) {
    updateAgenda((a) => ({ ...a, items: a.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) }));
  }

  // Slides for each item; scripture is looked up through Rust.
  useEffect(() => {
    if (!agenda) return;
    let stop = false;
    (async () => {
      const out: Record<string, ItemSlide[]> = {};
      for (const it of agenda.items) out[it.id] = await itemSlides(it);
      if (!stop) setSlides(out);
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agenda, lib.songs, p.translation, p.perSlide]);

  async function itemSlides(it: AgendaItem): Promise<ItemSlide[]> {
    switch (it.kind) {
      case "song": {
        const s = it.songId ? songsById.get(it.songId) : undefined;
        return s ? songSlides(s) : [];
      }
      case "scripture":
        return it.reference
          ? await p.scriptureSlides(it.reference, it.translation || undefined, it.perSlide ? parsePerSlide(it.perSlide) : undefined).catch(() => [])
          : [];
      case "text":
        return textSlides(it);
      case "logo":
        return [{ kind: "logo", title: "", body: "", sub: "", label: "Logo" }];
      case "blank":
        return [{ kind: "blank", title: "", body: "", sub: "", label: "Blackout" }];
      case "sermon":
        return [];
    }
  }

  async function goLive(itemId: string, idx: number) {
    if (!agenda) return;
    const it = agenda.items.find((i) => i.id === itemId);
    if (!it) return;
    const entering = !live || live.itemId !== itemId;
    setLive({ itemId, idx });
    setSelId(itemId);
    if (entering) p.onEnterItem(it);
    const sl = slides[itemId] || [];
    if (sl[idx]) await p.showSlide(sl[idx]);
  }

  // Next/previous slide, crossing into the next or previous item.
  function step(dir: 1 | -1) {
    if (!agenda || !agenda.items.length) return;
    const items = agenda.items;
    if (!live) {
      const first = selId ? items.findIndex((i) => i.id === selId) : 0;
      void goLive(items[Math.max(0, first)].id, 0);
      return;
    }
    const ii = items.findIndex((i) => i.id === live.itemId);
    const n = (slides[live.itemId] || []).length;
    const j = live.idx + dir;
    if (j >= 0 && j < n) {
      void goLive(live.itemId, j);
      return;
    }
    const ni = ii + dir;
    if (ni < 0 || ni >= items.length) return;
    const nn = (slides[items[ni].id] || []).length;
    void goLive(items[ni].id, dir === 1 ? 0 : Math.max(0, nn - 1));
  }

  /** The slide that → would show next, for the "Next" screen. */
  function peekNext(): ItemSlide | null {
    if (!agenda) return null;
    const items = agenda.items;
    if (!live) {
      const first = selId ? Math.max(0, items.findIndex((i) => i.id === selId)) : 0;
      for (let k = first; k < items.length; k++) if ((slides[items[k].id] || []).length) return slides[items[k].id][0];
      return null;
    }
    const ii = items.findIndex((i) => i.id === live.itemId);
    const cur = slides[live.itemId] || [];
    if (live.idx + 1 < cur.length) return cur[live.idx + 1];
    for (let k = ii + 1; k < items.length; k++) if ((slides[items[k].id] || []).length) return slides[items[k].id][0];
    return null;
  }

  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    p.registerNav({ next: () => stepRef.current(1), prev: () => stepRef.current(-1) });
    return () => p.registerNav(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- agenda editing ----------

  function addItem(kind: AgendaKind, extra: Partial<AgendaItem> = {}) {
    if (!agenda) return;
    const it: AgendaItem = { id: newId(), kind, title: extra.title || KIND_NAMES[kind].replace(/ \(.*\)$/, ""), ...extra };
    const at = sel ? agenda.items.findIndex((i) => i.id === sel.id) + 1 : agenda.items.length;
    updateAgenda((a) => ({ ...a, items: [...a.items.slice(0, at), it, ...a.items.slice(at)] }));
    setSelId(it.id);
  }
  // Drag and drop: move the dragged item to the drop target's position.
  const dragId = useRef<string | null>(null);
  function moveTo(id: string, targetId: string) {
    if (id === targetId) return;
    updateAgenda((a) => {
      const items = a.items.slice();
      const from = items.findIndex((x) => x.id === id);
      const to = items.findIndex((x) => x.id === targetId);
      if (from < 0 || to < 0) return a;
      const [it] = items.splice(from, 1);
      items.splice(to, 0, it);
      return { ...a, items };
    });
  }
  function move(id: string, d: -1 | 1) {
    updateAgenda((a) => {
      const i = a.items.findIndex((x) => x.id === id);
      const j = i + d;
      if (i < 0 || j < 0 || j >= a.items.length) return a;
      const items = a.items.slice();
      [items[i], items[j]] = [items[j], items[i]];
      return { ...a, items };
    });
  }
  function remove(id: string) {
    updateAgenda((a) => ({ ...a, items: a.items.filter((x) => x.id !== id) }));
    if (selId === id) setSelId(null);
  }
  function createAgenda(copyFrom?: Agenda) {
    const name = "Sunday service " + new Date().toISOString().slice(0, 10);
    const a = copyFrom ? duplicateAgenda(copyFrom, name) : newAgenda(name);
    update((l) => ({ ...l, agendas: [a, ...l.agendas], currentAgendaId: a.id }));
    setLive(null);
    setSelId(null);
  }

  // ---------- songs ----------

  const songHits = useMemo(() => {
    const q = songQ.trim().toLowerCase();
    const all = lib.songs.slice().sort((a, b) => a.title.localeCompare(b.title));
    if (!q) return all.slice(0, 60);
    return all
      .filter((s) => s.title.toLowerCase().includes(q) || s.sections.some((x) => x.text.toLowerCase().includes(q)))
      .slice(0, 60);
  }, [lib.songs, songQ]);

  async function importFiles(files: FileList | null) {
    if (!files) return;
    const got: Song[] = [];
    for (const f of Array.from(files)) {
      try {
        if (/\.(vpagd|zip)$/i.test(f.name)) {
          got.push(...(await parseVideoPsalmAgenda(await f.arrayBuffer())));
          continue;
        }
        const text = await f.text();
        // VideoPsalm songbooks and songs: loose JSON with Verses / Songs keys.
        if (/^\s*[\[{]/.test(text) && /\b(Verses|Songs)\s*:/.test(text)) got.push(...parseVideoPsalmJson(text));
        else got.push(...parseSongFile(f.name, text));
      } catch (e) {
        console.error(e);
      }
    }
    if (!got.length) {
      p.setStatus("No songs found in those files. Supported: VideoPsalm (.vpagd, songbook .json), plain text, OpenLyrics XML, OpenSong XML.");
      return;
    }
    const have = new Set(lib.songs.map((s) => s.title.toLowerCase()));
    const fresh = got.filter((s) => !have.has(s.title.toLowerCase()));
    update((l) => ({ ...l, songs: [...l.songs, ...fresh] }));
    p.setStatus("Imported " + fresh.length + " song" + (fresh.length === 1 ? "" : "s") +
      (got.length > fresh.length ? " (" + (got.length - fresh.length) + " already in the library)" : "") + ".");
  }

  function saveSong() {
    if (!editSong) return;
    const parsed = parsePlainSong(editSong.text);
    if (!parsed.sections.length) {
      p.setStatus("A song needs at least one section of lyrics.");
      return;
    }
    if (editSong.id) {
      const id = editSong.id;
      update((l) => ({ ...l, songs: l.songs.map((s) => (s.id === id ? { ...s, title: parsed.title, sections: parsed.sections } : s)) }));
    } else {
      update((l) => ({ ...l, songs: [...l.songs, parsed] }));
    }
    setEditSong(null);
  }

  // ---------- export / import ----------

  async function exportService(bundle: boolean) {
    if (!agenda) return;
    const { file, media } = buildServiceFile(agenda, lib, p.theme, bundle);
    const ext = bundle ? "hspbundle" : "hspservice";
    const path = await saveDialog({
      title: bundle ? "Export a bundle for another computer" : "Export for this computer",
      defaultPath: agenda.name.replace(/[\\/:*?"<>|]/g, "-") + "." + ext,
      filters: [{ name: bundle ? "Agent HSP bundle" : "Agent HSP service", extensions: [ext] }],
    });
    if (!path) return;
    try {
      await invoke("export_service", { path, manifest: JSON.stringify(file), media, bundle });
      toast.success(
        bundle
          ? "Bundle saved with " + file.songs.length + " song" + (file.songs.length === 1 ? "" : "s") + (media.length ? " and the background" : "") + "."
          : "Service saved. It opens on this computer."
      );
    } catch (e) {
      toast.error("Export failed: " + String(e));
    }
  }

  async function applyLook(t: NonNullable<ServiceFile["theme"]>) {
    const look: OutputTheme & { bgMedia?: string } = { ...t };
    if (look.bgMedia) {
      try {
        const src = convertFileSrc(await invoke<string>("media_path", { rel: look.bgMedia }));
        if (look.bgKind === "video") look.video = src;
        else look.image = src;
      } catch (e) {
        toast.error(String(e) + ". Keeping the current background.");
        look.bgKind = p.theme.bgKind;
        look.image = p.theme.image;
        look.video = p.theme.video;
      }
    }
    delete look.bgMedia;
    p.setTheme(look);
    toast.success("Applied the service's look.");
  }

  async function importService() {
    const path = await openDialog({
      title: "Import a service",
      multiple: false,
      filters: [{ name: "Agent HSP service or bundle", extensions: ["hspservice", "hspbundle"] }],
    });
    if (!path || Array.isArray(path)) return;
    try {
      const f = parseServiceFile(await invoke<string>("import_service", { path }));
      const r = mergeServiceFile(lib, f);
      p.setLibrary(r.library);
      setLive(null);
      setSelId(null);
      const msg = "Imported " + f.agenda.name + " (" + f.agenda.items.length + " items" + (f.songs.length ? ", " + f.songs.length + " songs" : "") + ").";
      if (r.missing.length) {
        toast.warning(msg + " Songs not on this computer: " + r.missing.join(", ") + ". Use a bundle to bring them.");
      } else if (f.theme) {
        toast.success(msg, { action: { label: "Use its look", onClick: () => void applyLook(f.theme!) }, duration: 12000 });
      } else {
        toast.success(msg);
      }
    } catch (e) {
      toast.error("Import failed: " + String(e instanceof Error ? e.message : e));
    }
  }

  // ---------- render ----------

  const thumb = (sl: ItemSlide | null, label?: ReactNode) => (
    <div className="aspect-video w-full overflow-hidden rounded-md border bg-black">
      <div className="relative h-full w-full">
        <SlideView slide={sl} theme={p.theme} idle={label ?? "End of service"} still />
      </div>
    </div>
  );

  if (!agenda) {
    const last = lib.agendas[0];
    return (
      <div className="grid h-full place-items-center">
        <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border bg-card p-6">
          <div>
            <h2 className="text-lg font-semibold">No service open</h2>
            <p className="text-sm text-muted-foreground">Start a new order of service, or copy a previous one.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => createAgenda()}><Plus /> New service</Button>
            {last && <Button variant="secondary" onClick={() => createAgenda(last)}><Copy /> Copy “{last.name}”</Button>}
            <Button variant="outline" onClick={() => void importService()}><FolderInput /> Import a service…</Button>
          </div>
          {lib.agendas.length > 0 && <AgendaPicker lib={lib} update={update} />}
        </div>
      </div>
    );
  }

  const selSlides = sel ? slides[sel.id] || [] : [];
  const nextSlide = peekNext();

  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)] grid-cols-[300px_minmax(0,1fr)_minmax(300px,380px)] gap-3">
      {/* Order of service */}
      <div className="flex min-h-0 flex-col rounded-lg border bg-card">
        <div className="flex flex-col gap-2 border-b p-3">
          <Input className="font-semibold" value={agenda.name} onChange={(e) => updateAgenda((a) => ({ ...a, name: e.target.value }))} />
          <div className="flex gap-1.5">
          <div className="min-w-0 flex-1">
            <AgendaPicker lib={lib} update={update} onNew={() => createAgenda()} onCopy={() => createAgenda(agenda)} />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="h-8" title="Export or import a service">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void exportService(false)}>
                <Download /> Export for this computer
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void exportService(true)}>
                <Package /> Export bundle for another computer
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void importService()}>
                <FolderInput /> Import a service…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1 p-2">
            {agenda.items.length === 0 && (
              <p className="p-2 text-sm text-muted-foreground">Add songs, readings, announcements and the sermon below.</p>
            )}
            {agenda.items.map((it, i) => {
              const Icon = KIND_ICONS[it.kind];
              const isLive = live?.itemId === it.id;
              return (
                <div
                  key={it.id}
                  draggable
                  onDragStart={() => (dragId.current = it.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => dragId.current && moveTo(dragId.current, it.id)}
                  onClick={() => setSelId(it.id)}
                  onDoubleClick={() => void goLive(it.id, 0)}
                  className={cn(
                    "group flex cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-2 text-sm hover:bg-muted",
                    it.id === selId && "border-border bg-muted",
                    isLive && "border-live/60 bg-live/15"
                  )}
                >
                  <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground opacity-0 group-hover:opacity-100" />
                  <span className="w-4 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                  <Icon className={cn("size-4 shrink-0", isLive ? "text-live" : "text-muted-foreground")} />
                  <span className="min-w-0 flex-1 truncate font-medium">{it.title}</span>
                  {isLive && <Badge className="bg-live text-live-foreground">LIVE</Badge>}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                      <Button size="icon" variant="ghost" className="size-7 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100">
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenuItem onClick={() => void goLive(it.id, 0)}><Play /> Go live</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => move(it.id, -1)}><ChevronUp /> Move up</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => move(it.id, 1)}><ChevronDown /> Move down</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => remove(it.id)}><Trash2 /> Remove</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })}
          </div>
        </ScrollArea>
        <div className="flex flex-col gap-2 border-t p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Add to the service</div>
          <div className="grid grid-cols-3 gap-1.5">
            <Button size="sm" variant="outline" onClick={() => addItem("scripture", { title: "Scripture reading", reference: "" })}><BookOpen /> Reading</Button>
            <Button size="sm" variant="outline" onClick={() => addItem("text", { title: "Announcements", body: "" })}><FileText /> Text</Button>
            <Button size="sm" variant="outline" onClick={() => addItem("sermon", { title: "Sermon" })}><Mic /> Sermon</Button>
            <Button size="sm" variant="outline" onClick={() => addItem("logo")}><ImageIcon /> Logo</Button>
            <Button size="sm" variant="outline" onClick={() => addItem("blank")}><EyeOff /> Blackout</Button>
            <Button size="sm" variant="outline" onClick={() => songSearchRef.current?.focus()}><Music /> Song</Button>
          </div>
        </div>
      </div>

      {/* Item editor and slides */}
      <div className="flex min-h-0 flex-col rounded-lg border bg-card">
        {!sel ? (
          <div className="grid flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">
            <div>
              Select an item to see its slides.
              <br />
              Double-click an item, or press → or Page Down, to go live.
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2 border-b p-3">
              <div className="flex items-center gap-2">
                <Input className="text-base font-semibold" value={sel.title} onChange={(e) => updateItem(sel.id, { title: e.target.value })} />
                <Button onClick={() => void goLive(sel.id, 0)}><Play /> Go live</Button>
              </div>
              {sel.kind === "scripture" && (
                <div className="flex gap-2">
                  <Input className="flex-1" placeholder="Reference, e.g. John 3:16-18 or Psalm 23" value={sel.reference || ""} onChange={(e) => updateItem(sel.id, { reference: e.target.value })} />
                  <Select value={sel.perSlide || "__default"} onValueChange={(v) => updateItem(sel.id, { perSlide: v === "__default" ? undefined : v })}>
                    <SelectTrigger className="w-44" title="Verses per slide for this reading">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default">Per slide: default ({p.perSlide === "fit" ? "fit" : p.perSlide})</SelectItem>
                      <SelectItem value="fit">As many as fit</SelectItem>
                      <SelectItem value="1">1 verse per slide</SelectItem>
                      <SelectItem value="2">2 verses per slide</SelectItem>
                      <SelectItem value="3">3 verses per slide</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={sel.translation || "__live"} onValueChange={(v) => updateItem(sel.id, { translation: v === "__live" ? undefined : v })}>
                    <SelectTrigger className="w-64" title="Translation for this reading">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__live">
                        Same as Live ({p.translations.find((t) => t.id === p.translation)?.name ?? p.translation})
                      </SelectItem>
                      {p.translations.map((t) => (
                        <SelectItem key={t.id} value={t.id}>{t.abbrev && t.abbrev !== t.name ? t.abbrev + " · " + t.name : t.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {sel.kind === "text" && (
                <Textarea rows={5} placeholder="One slide per paragraph. Leave a blank line between slides." value={sel.body || ""} onChange={(e) => updateItem(sel.id, { body: e.target.value })} />
              )}
              {sel.kind === "song" && sel.songId && songsById.get(sel.songId) && (
                <div>
                  <Button size="sm" variant="outline" onClick={() => setEditSong({ id: sel.songId!, text: songToText(songsById.get(sel.songId!)!) })}>
                    <Pencil /> Edit lyrics
                  </Button>
                </div>
              )}
              {sel.kind === "sermon" && (
                <p className="text-sm text-muted-foreground">
                  Going live here releases Hold and starts listening, so verses the preacher names go on screen. Every
                  other item keeps the AI off the screen.
                </p>
              )}
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 p-3">
                {selSlides.map((s, i) => {
                  const isLive = live?.itemId === sel.id && live.idx === i;
                  return (
                    <button key={i} className="group flex flex-col gap-1.5 text-left" onClick={() => void goLive(sel.id, i)}>
                      <div className={cn("rounded-lg p-0.5 ring-2 ring-transparent transition group-hover:ring-primary/60", isLive && "ring-live")}>
                        {thumb(s)}
                      </div>
                      <div className="flex items-center gap-1.5 px-0.5 text-xs">
                        <span className="tabular-nums text-muted-foreground">{i + 1}</span>
                        <span className="truncate font-medium">{s.label}</span>
                        {isLive && <Badge className="ml-auto bg-live text-live-foreground">LIVE</Badge>}
                      </div>
                    </button>
                  );
                })}
                {sel.kind === "scripture" && sel.reference && selSlides.length === 0 && (
                  <p className="text-sm text-muted-foreground">No verses found for “{sel.reference}”.</p>
                )}
              </div>
            </ScrollArea>
          </>
        )}
      </div>

      {/* Live, next, song library */}
      <div className="flex min-h-0 flex-col gap-3">
        {p.live}
        {p.liveControls}
        <div className="flex items-center gap-3 rounded-lg border bg-card p-2">
          <div className="w-32 shrink-0">{thumb(nextSlide)}</div>
          <div className="min-w-0 text-xs">
            <div className="font-semibold uppercase tracking-wider text-muted-foreground">Next · → or Page Down</div>
            <div className="truncate">{nextSlide ? nextSlide.label : "End of service"}</div>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col rounded-lg border bg-card">
          <div className="flex items-center justify-between gap-2 border-b p-2 pl-3">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Songs · {lib.songs.length}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setEditSong({ id: null, text: "Song title\n\n[Verse 1]\n\n[Chorus]\n" })}><Plus /> New</Button>
              <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}><Upload /> Import</Button>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".txt,.xml,.sng,.json,.vpagd,.zip,text/plain,application/xml,application/json"
                className="hidden"
                onChange={(e) => {
                  void importFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
          {editSong ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
              <Textarea className="min-h-0 flex-1 font-mono text-xs" value={editSong.text} onChange={(e) => setEditSong({ ...editSong, text: e.target.value })} />
              <p className="text-xs text-muted-foreground">First line is the title. Start sections with [Verse 1], [Chorus], [Bridge].</p>
              <div className="flex gap-2">
                <Button size="sm" onClick={saveSong}>Save song</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditSong(null)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <>
              <div className="relative p-2">
                <Search className="absolute left-4 top-4.5 size-4 text-muted-foreground" />
                <Input ref={songSearchRef} className="pl-8" placeholder="Search title or lyrics" value={songQ} onChange={(e) => setSongQ(e.target.value)} />
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col p-1 pt-0">
                  {songHits.map((s) => (
                    <div key={s.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                      <Music className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{s.title}</span>
                      <Button size="icon" variant="ghost" className="size-7 opacity-0 group-hover:opacity-100" title="Edit lyrics" onClick={() => setEditSong({ id: s.id, text: songToText(s) })}>
                        <Pencil />
                      </Button>
                      <Button size="sm" variant="secondary" className="h-7" onClick={() => addItem("song", { title: s.title, songId: s.id })}>
                        <Plus /> Add
                      </Button>
                    </div>
                  ))}
                  {lib.songs.length === 0 && (
                    <p className="p-2 text-sm text-muted-foreground">Import songs (VideoPsalm, OpenLyrics, OpenSong or plain text) or create one.</p>
                  )}
                </div>
              </ScrollArea>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AgendaPicker(props: { lib: Library; update: (fn: (l: Library) => Library) => void; onNew?: () => void; onCopy?: () => void }) {
  const { lib, update } = props;
  return (
    <div className="flex gap-1.5">
      <Select value={lib.currentAgendaId || undefined} onValueChange={(v) => update((l) => ({ ...l, currentAgendaId: v }))}>
        <SelectTrigger className="h-8 min-w-0 flex-1 text-xs"><SelectValue placeholder="Open a service…" /></SelectTrigger>
        <SelectContent>
          {lib.agendas.map((a) => (
            <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {props.onNew && <Button size="sm" variant="outline" className="h-8" onClick={props.onNew} title="New service"><Plus /></Button>}
      {props.onCopy && <Button size="sm" variant="outline" className="h-8" title="Duplicate for next week" onClick={props.onCopy}><Copy /></Button>}
    </div>
  );
}
