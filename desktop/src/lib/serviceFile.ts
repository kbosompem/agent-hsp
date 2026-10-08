// Service files: one agenda exported for this computer (.hspservice, songs by
// id, backgrounds by path) or as a bundle for another computer (.hspbundle,
// songs in full and media alongside). Pure functions; the file I/O is in
// src-tauri/src/bundle.rs.

import { Agenda, Library, Song, newId } from "./library";
import type { OutputTheme } from "../SlideView";

export type ServiceFile = {
  format: "agent-hsp-service";
  version: 1;
  kind: "local" | "bundle";
  exportedAt: string;
  agenda: Agenda;
  /** Bundle: every song the agenda uses. Local: empty (songs stay in the library). */
  songs: Song[];
  /** The projector look, with downloaded media as `bgMedia` paths. */
  theme: (OutputTheme & { bgMedia?: string }) | null;
};

/** The app data path of a stock background the theme uses, if any. */
export function themeMedia(t: OutputTheme): string | null {
  if (!t.bgId || (t.bgKind !== "image" && t.bgKind !== "video")) return null;
  return "backgrounds/" + t.bgId + (t.bgKind === "video" ? ".mp4" : ".jpg");
}

export function buildServiceFile(
  agenda: Agenda,
  lib: Library,
  theme: OutputTheme | null,
  bundle: boolean
): { file: ServiceFile; media: string[] } {
  const ids = new Set(agenda.items.map((i) => i.songId).filter(Boolean) as string[]);
  const songs = bundle ? lib.songs.filter((s) => ids.has(s.id)) : [];
  let t: ServiceFile["theme"] = null;
  const media: string[] = [];
  if (theme) {
    const rel = themeMedia(theme);
    t = { ...theme };
    if (rel) {
      // Asset URLs are machine-specific; keep the path inside app data.
      t.bgMedia = rel;
      if (theme.bgKind === "video") t.video = "";
      else t.image = "";
      media.push(rel);
    }
  }
  return {
    file: { format: "agent-hsp-service", version: 1, kind: bundle ? "bundle" : "local", exportedAt: new Date().toISOString(), agenda, songs, theme: t },
    media,
  };
}

export function parseServiceFile(json: string): ServiceFile {
  const d = JSON.parse(json);
  if (d?.format !== "agent-hsp-service" || !d.agenda || !Array.isArray(d.agenda.items)) {
    throw new Error("This is not an Agent HSP service file.");
  }
  return { ...d, songs: Array.isArray(d.songs) ? d.songs : [] };
}

/**
 * Add an imported service to the library. Bundled songs are matched to
 * library songs by title (no duplicates); new ones are added. Returns the
 * new library, the new agenda's id, and songs the agenda needs but cannot find.
 */
export function mergeServiceFile(lib: Library, f: ServiceFile): { library: Library; agendaId: string; missing: string[] } {
  const byTitle = new Map(lib.songs.map((s) => [s.title.trim().toLowerCase(), s]));
  const byId = new Map(lib.songs.map((s) => [s.id, s]));
  const remap = new Map<string, string>();
  const added: Song[] = [];
  for (const s of f.songs) {
    const same = byTitle.get(s.title.trim().toLowerCase());
    if (same) {
      remap.set(s.id, same.id);
    } else {
      const id = byId.has(s.id) ? newId() : s.id;
      const song = { ...s, id };
      added.push(song);
      byId.set(id, song);
      byTitle.set(s.title.trim().toLowerCase(), song);
      remap.set(s.id, id);
    }
  }
  const missing: string[] = [];
  const items = f.agenda.items.map((it) => {
    const copy = { ...it, id: newId() };
    if (it.kind === "song" && it.songId) {
      const id = remap.get(it.songId) ?? it.songId;
      if (!byId.has(id)) missing.push(it.title);
      copy.songId = id;
    }
    return copy;
  });
  const names = new Set(lib.agendas.map((a) => a.name));
  let name = f.agenda.name || "Imported service";
  if (names.has(name)) name = name + " (imported)";
  const agenda: Agenda = { ...f.agenda, id: newId(), name, items };
  return {
    library: { ...lib, songs: [...lib.songs, ...added], agendas: [agenda, ...lib.agendas], currentAgendaId: agenda.id },
    agendaId: agenda.id,
    missing,
  };
}
