// Songs and service agendas. Pure data and parsing, no Tauri, so the import
// parsers can be tested from a script. Stored as one JSON document by the
// load_library / save_library commands.

export type SongSection = { tag: string; text: string };
export type Song = {
  id: string;
  title: string;
  author?: string;
  sections: SongSection[];
  /** Section tags in singing order, e.g. ["V1", "C", "V2", "C"]. Empty means as written. */
  order: string[];
  /** Each section is already one slide (VideoPsalm imports); never split it. */
  keepSlides?: boolean;
};

export type AgendaKind = "song" | "scripture" | "text" | "logo" | "blank" | "sermon";
export type AgendaItem = {
  id: string;
  kind: AgendaKind;
  title: string;
  /** song: the song id. */
  songId?: string;
  /** scripture: a reference such as "John 3:16-18". */
  reference?: string;
  /** scripture: translation id ("kjv", "bsb"); empty uses the Live page's choice. */
  translation?: string;
  /** text: slides separated by a blank line. */
  body?: string;
};
export type Agenda = { id: string; name: string; date: string; items: AgendaItem[] };

export type Library = { version: 1; songs: Song[]; agendas: Agenda[]; currentAgendaId: string | null };

/** One slide of an agenda item, ready for show_slide. */
export type ItemSlide = { kind: string; title: string; body: string; sub: string; label: string; hit?: unknown };

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function emptyLibrary(): Library {
  return { version: 1, songs: [], agendas: [], currentAgendaId: null };
}

export function parseLibrary(json: string): Library {
  if (!json.trim()) return emptyLibrary();
  const d = JSON.parse(json);
  return {
    version: 1,
    songs: Array.isArray(d.songs) ? d.songs : [],
    agendas: Array.isArray(d.agendas) ? d.agendas : [],
    currentAgendaId: d.currentAgendaId ?? null,
  };
}

export function newAgenda(name: string): Agenda {
  return { id: newId(), name, date: new Date().toISOString().slice(0, 10), items: [] };
}

/** Copy an agenda with fresh ids, for "use last week's as a start". */
export function duplicateAgenda(a: Agenda, name: string): Agenda {
  return { ...newAgenda(name), items: a.items.map((it) => ({ ...it, id: newId() })) };
}

// ---------- Song text ----------

const TAG_WORDS: [RegExp, string][] = [
  [/^(?:verse|v)\s*(\d+)$/i, "V"],
  [/^(?:chorus|refrain|c)\s*(\d*)$/i, "C"],
  [/^(?:pre-?chorus|p)\s*(\d*)$/i, "P"],
  [/^(?:bridge|b)\s*(\d*)$/i, "B"],
  [/^(?:tag|ending|outro|e)\s*(\d*)$/i, "E"],
  [/^(?:intro|i)\s*(\d*)$/i, "I"],
];

/** "Verse 2" -> "V2", "[Chorus]" -> "C". Null if the line is not a section heading. */
export function sectionTag(line: string): string | null {
  const t = line.trim().replace(/^[\[(]|[\])]$/g, "").replace(/:$/, "").trim();
  if (!t || t.length > 16) return null;
  for (const [re, base] of TAG_WORDS) {
    const m = t.match(re);
    if (m) return base + (m[1] || "");
  }
  return null;
}

export function tagName(tag: string): string {
  const m = tag.match(/^([A-Z])(\d*)$/);
  if (!m) return tag;
  const names: Record<string, string> = { V: "Verse", C: "Chorus", P: "Pre-chorus", B: "Bridge", E: "Ending", I: "Intro" };
  return (names[m[1]] || m[1]) + (m[2] ? " " + m[2] : "");
}

/**
 * Plain-text song: first non-empty line is the title unless it is a section
 * heading. Sections start at headings ("Verse 1", "[Chorus]") or, without
 * headings, at blank lines (numbered V1, V2, ...).
 */
export function parsePlainSong(text: string, fallbackTitle = "Untitled song"): Song {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  let title = fallbackTitle;
  if (i < lines.length && !sectionTag(lines[i])) {
    title = lines[i].trim();
    i++;
  }
  const sections: SongSection[] = [];
  const hasHeadings = lines.slice(i).some((l) => sectionTag(l));
  let cur: { tag: string; lines: string[] } | null = null;
  let auto = 0;
  const flush = () => {
    if (cur && cur.lines.some((l) => l.trim())) {
      sections.push({ tag: cur.tag, text: trimBlank(cur.lines).join("\n") });
    }
    cur = null;
  };
  for (; i < lines.length; i++) {
    const l = lines[i];
    const tag = sectionTag(l);
    if (tag) {
      flush();
      cur = { tag, lines: [] };
      continue;
    }
    if (!l.trim()) {
      if (!hasHeadings) flush();
      else if (cur) cur.lines.push("");
      continue;
    }
    if (!cur) cur = { tag: "V" + ++auto, lines: [] };
    cur.lines.push(l.trim());
  }
  flush();
  return { id: newId(), title, sections, order: [] };
}

function trimBlank(ls: string[]): string[] {
  let a = 0;
  let b = ls.length;
  while (a < b && !ls[a].trim()) a++;
  while (b > a && !ls[b - 1].trim()) b--;
  return ls.slice(a, b);
}

/** OpenLyrics XML (openlyrics.org), as exported by OpenLP and others. */
export function parseOpenLyrics(xml: string): Song | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) return null;
  const title = doc.getElementsByTagName("title")[0]?.textContent?.trim() || "Untitled song";
  const author = doc.getElementsByTagName("author")[0]?.textContent?.trim() || undefined;
  const sections: SongSection[] = [];
  for (const v of Array.from(doc.getElementsByTagName("verse"))) {
    const name = (v.getAttribute("name") || "v" + (sections.length + 1)).toUpperCase();
    const parts: string[] = [];
    for (const ln of Array.from(v.getElementsByTagName("lines"))) {
      // <br/> separates lines inside <lines>.
      const html = new XMLSerializer().serializeToString(ln);
      const text = html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"');
      parts.push(text.split("\n").map((s) => s.trim()).join("\n").trim());
    }
    sections.push({ tag: name.replace(/[^A-Z0-9]/g, ""), text: parts.join("\n") });
  }
  const orderAttr = doc.getElementsByTagName("verseOrder")[0]?.textContent?.trim();
  const order = orderAttr ? orderAttr.toUpperCase().split(/\s+/) : [];
  return sections.length ? { id: newId(), title, author, sections, order } : null;
}

/** OpenSong song XML: <song><title/><lyrics>[V1] lines ...</lyrics></song>. */
export function parseOpenSong(xml: string): Song | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) return null;
  const lyrics = doc.getElementsByTagName("lyrics")[0]?.textContent;
  if (!lyrics) return null;
  const title = doc.getElementsByTagName("title")[0]?.textContent?.trim() || "Untitled song";
  const author = doc.getElementsByTagName("author")[0]?.textContent?.trim() || undefined;
  const sections: SongSection[] = [];
  let cur: SongSection | null = null;
  for (const raw of lyrics.replace(/\r\n?/g, "\n").split("\n")) {
    const m = raw.match(/^\s*\[([^\]]+)\]/);
    if (m) {
      if (cur && cur.text.trim()) sections.push(cur);
      cur = { tag: m[1].toUpperCase().replace(/[^A-Z0-9]/g, ""), text: "" };
      continue;
    }
    // OpenSong lines start with a space (lyric), "." (chords) or ";" (comment).
    if (/^\s*[.;]/.test(raw)) continue;
    const line = raw.replace(/\|/g, "").trim();
    if (!cur) cur = { tag: "V1", text: "" };
    if (line) cur.text += (cur.text ? "\n" : "") + line;
  }
  if (cur && cur.text.trim()) sections.push(cur);
  const presentation = doc.getElementsByTagName("presentation")[0]?.textContent?.trim();
  const order = presentation ? presentation.toUpperCase().split(/\s+/) : [];
  return sections.length ? { id: newId(), title, author, sections, order } : null;
}

/** Any supported song file. Returns one or more songs, or an empty list. */
export function parseSongFile(name: string, content: string): Song[] {
  const stem = name.replace(/\.[^.]+$/, "");
  const t = content.trimStart();
  if (t.startsWith("<")) {
    if (/<song[\s>]/.test(t) && /openlyrics/i.test(t)) {
      const s = parseOpenLyrics(content);
      return s ? [s] : [];
    }
    const s = parseOpenSong(content) || parseOpenLyrics(content);
    return s ? [s] : [];
  }
  // Several plain-text songs in one file, separated by a line of 3+ dashes or equals.
  const chunks = content.split(/\n\s*(?:-{3,}|={3,})\s*\n/);
  return chunks
    .map((c, i) => parsePlainSong(c, chunks.length > 1 ? stem + " " + (i + 1) : stem))
    .filter((s) => s.sections.length > 0);
}

/** Song as editable plain text (title, then tagged sections). */
export function songToText(s: Song): string {
  return [s.title, "", ...s.sections.map((x) => "[" + tagName(x.tag) + "]\n" + x.text + "\n")].join("\n").trim() + "\n";
}

// ---------- Slides ----------

/** At most `max` lines per lyric slide; long sections split evenly. */
function chunkLines(text: string, max: number): string[] {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length <= max) return [lines.join("\n")];
  const n = Math.ceil(lines.length / max);
  const per = Math.ceil(lines.length / n);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += per) out.push(lines.slice(i, i + per).join("\n"));
  return out;
}

export function songSlides(song: Song, maxLines = 4): ItemSlide[] {
  const byTag = new Map(song.sections.map((s) => [s.tag, s]));
  const order = song.order.length ? song.order.filter((t) => byTag.has(t)) : song.sections.map((s) => s.tag);
  const out: ItemSlide[] = [];
  for (const tag of order) {
    const sec = byTag.get(tag)!;
    const parts = song.keepSlides ? [sec.text] : chunkLines(sec.text, maxLines);
    parts.forEach((body, i) =>
      out.push({
        kind: "text",
        title: "",
        body,
        sub: song.title,
        label: tagName(tag) + (parts.length > 1 ? " (" + (i + 1) + "/" + parts.length + ")" : ""),
      })
    );
  }
  return out;
}

export function textSlides(item: AgendaItem): ItemSlide[] {
  const parts = (item.body || "")
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return [{ kind: "text", title: item.title, body: "", sub: "", label: item.title }];
  return parts.map((body, i) => ({
    kind: "text",
    title: i === 0 ? item.title : "",
    body,
    sub: "",
    label: (i + 1) + ". " + body.split("\n")[0].slice(0, 40),
  }));
}
