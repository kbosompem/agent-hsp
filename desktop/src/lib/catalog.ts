// Song catalogs beside YouTube on the Media page: ShemenMusic (fetched by
// src-tauri/src/shemen.rs) and a songbook file. Each entry has a backing track
// and, usually, lyrics. Pure data, no Tauri, so it can be tested from a script.

import { Song, parseSongSheet } from "./library";

export type CatalogSong = {
  /** Unique and stable: "shemen:5247", "songbook:Arise". Stored on the Song as `source`. */
  key: string;
  title: string;
  /** Backing track address (MP3/M4A, or a MediaFire page). */
  audioUrl?: string;
  durationS?: number;
  /** Lyrics with headings ("CHORUS", "Verse 1:"), or "" when there are none. */
  lyrics: string;
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", ndash: "–", mdash: "—" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** WordPress post HTML to plain lines: <br> and block ends become line breaks. */
export function htmlToText(html: string): string {
  // One paragraph per line (stanzas split by empty paragraphs), or one per
  // stanza with <br> between lines.
  const perStanza = (html.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || []).some((p) => /<br/i.test(p));
  const t = html
    .replace(/<\/p>\s+<p/gi, "</p><p")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, perStanza ? "\n\n" : "\n")
    .replace(/<\/(div|pre|h\d|li)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(t)
    .split("\n")
    .map((l) => l.replace(/ /g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "Strong Christian 91" -> "Strong Christian" (ShemenMusic titles end in a hymn-book number). */
export function cleanTitle(t: string): string {
  return t.replace(/\s+\d{1,4}$/, "").trim();
}

const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

type ShemenRaw = { id: number; title: string; url: string; duration_s?: number | null; lyrics_html?: string };

export function shemenCatalog(raw: ShemenRaw[]): CatalogSong[] {
  return raw.map((r) => {
    const title = decodeEntities(r.title).trim();
    let lyrics = htmlToText(r.lyrics_html || "");
    // Many sheets repeat the title (in capitals) as their first line.
    const first = lyrics.split("\n", 1)[0];
    if (first && plain(first).replace(/\s*\d+$/, "") === plain(cleanTitle(title))) lyrics = lyrics.slice(first.length).trim();
    return { key: "shemen:" + r.id, title, audioUrl: r.url, durationS: r.duration_s ?? undefined, lyrics };
  });
}

export type Songbook = { format: "agenthsp-songbook"; version: 1; name: string; songs: { title: string; lyrics: string; audioUrl?: string | null }[] };

export function songbookCatalog(b: Songbook): CatalogSong[] {
  return b.songs.map((s) => ({ key: "songbook:" + s.title, title: s.title, audioUrl: s.audioUrl || undefined, lyrics: s.lyrics || "" }));
}

/** The library song for a catalog entry: lyrics in singing order, linked to its track. */
export function catalogToSong(c: CatalogSong): Song {
  const song = parseSongSheet(c.lyrics, cleanTitle(c.title));
  return { ...song, source: c.key, trackUrl: c.audioUrl };
}

/** Filter by words in the title (and lyrics, when `inLyrics`); title matches first. */
export function searchCatalog(items: CatalogSong[], q: string, inLyrics = true): CatalogSong[] {
  const words = plain(q).split(" ").filter(Boolean);
  if (!words.length) return items;
  const all = (hay: string) => words.every((w) => hay.includes(w));
  const inTitle = items.filter((c) => all(plain(c.title)));
  if (!inLyrics) return inTitle;
  const titled = new Set(inTitle);
  return [...inTitle, ...items.filter((c) => !titled.has(c) && all(plain(c.title + " " + c.lyrics)))];
}
