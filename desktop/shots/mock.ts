// Screenshot harness: runs the real console UI in a browser with the Tauri
// backend replaced by canned data. Dev only (not a build input). Drive it from
// a Playwright script via window.__hsp (see shots/README.md).
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import kjv from "../crates/preso-core/kjv.json";

type Book = { n: string; c: string[][] };
const books = (kjv as { books: Book[] }).books;

const verse = (b: number, c: number, v: number) => books[b]?.c[c - 1]?.[v - 1] ?? "";
const bookIndex = (name: string) => books.findIndex((x) => x.n.toLowerCase() === name.toLowerCase());

function hit(b: number, c: number, v: number, end: number | null = null) {
  const text = end
    ? Array.from({ length: end - v + 1 }, (_, i) => `${v + i} ${verse(b, c, v + i)}`).join(" ")
    : verse(b, c, v);
  return {
    label: `${books[b].n} ${c}:${v}${end ? `-${end}` : ""}`,
    text,
    translation: "KJV",
    reference: { book: b + 1, chapter: c, verse: v, end_verse: end },
  };
}

// "John 3 16", "John 3:16", "Romans 5 verse 8", "Psalm 91 1 to 2".
const NAMES = books.map((b) => b.n).concat(["Psalm"]).sort((a, b) => b.length - a.length);
const REF = new RegExp(
  `\\b(${NAMES.map((n) => n.replace(/ /g, "\\s")).join("|")})\\s+(\\d+)(?:\\s*(?::|verse|verses)\\s*|\\s+)(\\d+)(?:\\s*(?:-|to|through)\\s*(\\d+))?`,
  "gi",
);
function lookup(text: string) {
  const out = [];
  for (const m of text.matchAll(REF)) {
    const b = bookIndex(m[1].toLowerCase() === "psalm" ? "Psalms" : m[1]);
    if (b >= 0) out.push(hit(b, +m[2], +m[3], m[4] ? +m[4] : null));
  }
  return out;
}

const slideFor = (h: ReturnType<typeof hit>) => ({ kind: "verse", title: h.label, body: h.text, sub: h.translation });
const library = (window as any).__hspLibrary ?? { version: 1, songs: [], agendas: [], currentAgendaId: null };

const handlers: Record<string, (a: any) => unknown> = {
  bible_structure: () => books.map((b) => ({ name: b.n, chapters: b.c.map((c) => c.length) })),
  list_translations: () =>
    [["kjv", "King James Version", "KJV"], ["bsb", "Berean Standard Bible", "BSB"], ["web", "World English Bible", "WEB"],
     ["asv", "American Standard Version", "ASV"], ["bbe", "Bible in Basic English", "BBE"], ["lsv", "Literal Standard Version", "LSV"],
     ["fbv", "Free Bible Version", "FBV"]].map(([id, name, abbrev]) => ({ id, name, abbrev, edition: "", copyright: "Public domain", bundled: true })),
  list_audio_inputs: () => ["MacBook Pro Microphone", "Behringer UMC202HD 192k"],
  speech_engines: () => ({ nemotron: true }),
  media_tools: () => ({ ffmpeg: true }),
  has_deepgram_key: () => false,
  last_session: () => null,
  list_media: () => (window as any).__hspMedia ?? [],
  media_folders: () => [],
  list_user_backgrounds: () => [],
  load_library: () => JSON.stringify(library),
  load_songbook: () => "",
  save_library: () => null,
  ensure_model: () => "ok",
  start_listening: () => "listening",
  stop_listening: () => null,
  lookup: (a) => lookup(a?.input ?? a?.query ?? ""),
  lookup_live: (a) => lookup(a?.input ?? ""),
  verse_at: (a) => hit(a.book - 1, a.chapter, a.verse),
  verse_range: (a) => {
    const out = [];
    for (let v = a.from; v <= a.to; v++) out.push(hit(a.book - 1, a.chapter, v));
    return out;
  },
  show_verse: (a) => slideFor(a?.hit ?? hit(42, 3, 16)),
  show_slide: (a) => ({ kind: a.kind, title: a.title, body: a.body, sub: a.sub }),
  log_event: () => null,
};

mockWindows("main");
mockIPC(
  (cmd, args) => {
    const h = handlers[cmd];
    if (!h) {
      console.info("[mock] unhandled", cmd, args);
      return null;
    }
    return h(args);
  },
  { shouldMockEvents: true },
);

// Screenshot scripts call these.
(window as any).__hsp = {
  emit: async (event: string, payload: unknown) => (await import("@tauri-apps/api/event")).emit(event, payload),
  lookup,
  hit,
};
localStorage.setItem("hsp-setup-done", "1");
