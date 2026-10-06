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

export type ServiceNav = { next: () => void; prev: () => void };

type Props = {
  library: Library;
  setLibrary: (l: Library) => void;
  preview: ReactNode;
  /** Put one slide on the projector. */
  showSlide: (s: ItemSlide) => Promise<void>;
  /** Verse slides for a scripture item ("John 3:16-18"). */
  scriptureSlides: (reference: string) => Promise<ItemSlide[]>;
  /** Called when the operator goes live on an item (App sets Hold, starts the sermon). */
  onEnterItem: (item: AgendaItem) => void;
  registerNav: (nav: ServiceNav | null) => void;
  setStatus: (s: string) => void;
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
  const [live, setLive] = useState<{ itemId: string; idx: number } | null>(null);
  const [slides, setSlides] = useState<Record<string, ItemSlide[]>>({});
  const [songQ, setSongQ] = useState("");
  const [editSong, setEditSong] = useState<{ id: string | null; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
  }, [agenda, lib.songs]);

  async function itemSlides(it: AgendaItem): Promise<ItemSlide[]> {
    switch (it.kind) {
      case "song": {
        const s = it.songId ? songsById.get(it.songId) : undefined;
        return s ? songSlides(s) : [];
      }
      case "scripture":
        return it.reference ? await p.scriptureSlides(it.reference).catch(() => []) : [];
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
        got.push(...parseSongFile(f.name, await f.text()));
      } catch (e) {
        console.error(e);
      }
    }
    if (!got.length) {
      p.setStatus("No songs found in those files. Supported: plain text, OpenLyrics XML, OpenSong XML.");
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

  // ---------- render ----------

  if (!agenda) {
    const last = lib.agendas[0];
    return (
      <div className="service empty">
        <div className="pane">
          <h3>No service open</h3>
          <div className="rowbtns">
            <button className="btn gold" onClick={() => createAgenda()}>New service</button>
            {last && <button className="btn" onClick={() => createAgenda(last)}>Copy "{last.name}"</button>}
          </div>
          {lib.agendas.length > 0 && <AgendaPicker lib={lib} update={update} />}
        </div>
      </div>
    );
  }

  const selSlides = sel ? slides[sel.id] || [] : [];

  return (
    <div className="service">
      <div className="pane svc-agenda">
        <div className="rowsp">
          <input
            className="svc-name"
            value={agenda.name}
            onChange={(e) => updateAgenda((a) => ({ ...a, name: e.target.value }))}
          />
        </div>
        <AgendaPicker lib={lib} update={update} onNew={() => createAgenda()} onCopy={() => createAgenda(agenda)} />
        <div className="svc-items">
          {agenda.items.length === 0 && <div className="sub dim">Add items below: songs, scripture, announcements, the sermon.</div>}
          {agenda.items.map((it, i) => (
            <div
              key={it.id}
              className={"svc-item" + (it.id === selId ? " sel" : "") + (live?.itemId === it.id ? " live" : "")}
              onClick={() => setSelId(it.id)}
              onDoubleClick={() => void goLive(it.id, 0)}
            >
              <span className="svc-num">{i + 1}</span>
              <span className="svc-title">
                {it.title}
                <span className="sub"> · {KIND_NAMES[it.kind]}</span>
              </span>
              <span className="svc-ops" onClick={(e) => e.stopPropagation()}>
                <button className="tab" title="Move up" onClick={() => move(it.id, -1)}>↑</button>
                <button className="tab" title="Move down" onClick={() => move(it.id, 1)}>↓</button>
                <button className="tab" title="Remove" onClick={() => remove(it.id)}>×</button>
              </span>
            </div>
          ))}
        </div>
        <div className="tiny">Add</div>
        <div className="rowbtns wrap">
          <button className="btn" onClick={() => addItem("scripture", { title: "Scripture reading", reference: "" })}>Scripture</button>
          <button className="btn" onClick={() => addItem("text", { title: "Announcements", body: "" })}>Text</button>
          <button className="btn" onClick={() => addItem("sermon", { title: "Sermon" })}>Sermon</button>
          <button className="btn" onClick={() => addItem("logo")}>Logo</button>
          <button className="btn" onClick={() => addItem("blank")}>Blackout</button>
        </div>
        <div className="sub dim">Songs: pick from the library on the right.</div>
      </div>

      <div className="pane svc-detail">
        {!sel && <div className="sub dim">Select an item to edit it or see its slides. Double-click an item, or press → / Page Down, to go live.</div>}
        {sel && (
          <>
            <div className="rowsp">
              <input className="svc-name" value={sel.title} onChange={(e) => updateItem(sel.id, { title: e.target.value })} />
              <button className="btn gold" onClick={() => void goLive(sel.id, 0)}>Go live</button>
            </div>
            {sel.kind === "scripture" && (
              <input
                placeholder="e.g. John 3:16-18 or Psalm 23"
                value={sel.reference || ""}
                onChange={(e) => updateItem(sel.id, { reference: e.target.value })}
              />
            )}
            {sel.kind === "text" && (
              <textarea
                rows={8}
                placeholder={"One slide per paragraph. Leave a blank line between slides."}
                value={sel.body || ""}
                onChange={(e) => updateItem(sel.id, { body: e.target.value })}
              />
            )}
            {sel.kind === "song" && sel.songId && songsById.get(sel.songId) && (
              <button className="btn" onClick={() => setEditSong({ id: sel.songId!, text: songToText(songsById.get(sel.songId!)!) })}>
                Edit song
              </button>
            )}
            {sel.kind === "sermon" && (
              <div className="sub">
                Going live here turns Hold off and starts listening, so verses the preacher names go on screen.
                Every other item keeps the AI off the screen.
              </div>
            )}
            <div className="svc-slides">
              {selSlides.map((s, i) => (
                <div
                  key={i}
                  className={"svc-slide" + (live?.itemId === sel.id && live.idx === i ? " live" : "")}
                  onClick={() => void goLive(sel.id, i)}
                >
                  <div className="tiny">{s.label}</div>
                  <div className="svc-slide-body">{s.body || (s.kind === "logo" ? "Logo" : s.kind === "blank" ? "Blackout" : "")}</div>
                </div>
              ))}
              {sel.kind === "scripture" && sel.reference && selSlides.length === 0 && (
                <div className="sub dim">No verses found for "{sel.reference}".</div>
              )}
            </div>
          </>
        )}
      </div>

      <div className="pane svc-right">
        <div className="tiny">Live preview</div>
        <div className="preview">{p.preview}</div>
        <div className="tiny">→ / Page Down next slide · ← / Page Up previous · B blackout · L logo</div>

        <div className="rowsp">
          <span className="tiny">Song library ({lib.songs.length})</span>
          <span className="rowbtns">
            <button className="btn" onClick={() => setEditSong({ id: null, text: "Song title\n\n[Verse 1]\n\n[Chorus]\n" })}>New</button>
            <button className="btn" onClick={() => fileRef.current?.click()}>Import</button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".txt,.xml,.sng,text/plain,application/xml"
              style={{ display: "none" }}
              onChange={(e) => {
                void importFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </span>
        </div>
        {editSong ? (
          <div className="svc-songedit">
            <textarea rows={16} value={editSong.text} onChange={(e) => setEditSong({ ...editSong, text: e.target.value })} />
            <div className="sub dim">First line is the title. Start sections with [Verse 1], [Chorus], [Bridge].</div>
            <div className="rowbtns">
              <button className="btn gold" onClick={saveSong}>Save song</button>
              <button className="btn" onClick={() => setEditSong(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <input placeholder="Search title or lyrics" value={songQ} onChange={(e) => setSongQ(e.target.value)} />
            <div className="svc-songs">
              {songHits.map((s) => (
                <div key={s.id} className="svc-song">
                  <span className="svc-title">{s.title}</span>
                  <button className="tab" onClick={() => addItem("song", { title: s.title, songId: s.id })}>Add</button>
                  <button className="tab" onClick={() => setEditSong({ id: s.id, text: songToText(s) })}>Edit</button>
                </div>
              ))}
              {lib.songs.length === 0 && <div className="sub dim">Import songs (plain text, OpenLyrics or OpenSong files) or create one.</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AgendaPicker(props: { lib: Library; update: (fn: (l: Library) => Library) => void; onNew?: () => void; onCopy?: () => void }) {
  const { lib, update } = props;
  return (
    <div className="rowbtns wrap">
      <select
        value={lib.currentAgendaId || ""}
        onChange={(e) => update((l) => ({ ...l, currentAgendaId: e.target.value || null }))}
      >
        <option value="">Open a service…</option>
        {lib.agendas.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      {props.onNew && <button className="btn" onClick={props.onNew}>New</button>}
      {props.onCopy && <button className="btn" title="Start next week from this one" onClick={props.onCopy}>Duplicate</button>}
    </div>
  );
}
