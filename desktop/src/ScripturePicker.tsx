// Quick verse selection for a scripture reading, laid out like VideoPsalm:
// books | chapters | verses side by side, every one visible without scrolling
// (66 short book names; Psalms' 150 chapters and Psalm 119's 176 verses fit).
// Click a book, then a chapter, then click or drag across verse numbers
// (shift-click extends). Writes the same
// reference text ("John 3:16-17") the reading already stores, so typing a
// reference still works and the two stay in step.

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type BookShape = { name: string; chapters: number[] };

/** Short names so all 66 books fit at once; the full name is the tooltip. */
const SHORT: Record<string, string> = {
  Genesis: "Gen", Exodus: "Exo", Leviticus: "Lev", Numbers: "Num", Deuteronomy: "Deut", Joshua: "Josh", Judges: "Judg", Ruth: "Ruth",
  "1 Samuel": "1 Sam", "2 Samuel": "2 Sam", "1 Kings": "1 Kgs", "2 Kings": "2 Kgs", "1 Chronicles": "1 Chr", "2 Chronicles": "2 Chr",
  Ezra: "Ezra", Nehemiah: "Neh", Esther: "Est", Job: "Job", Psalms: "Ps", Proverbs: "Prov", Ecclesiastes: "Eccl", "Song of Solomon": "Song",
  Isaiah: "Isa", Jeremiah: "Jer", Lamentations: "Lam", Ezekiel: "Ezek", Daniel: "Dan", Hosea: "Hos", Joel: "Joel", Amos: "Amos",
  Obadiah: "Obad", Jonah: "Jon", Micah: "Mic", Nahum: "Nah", Habakkuk: "Hab", Zephaniah: "Zeph", Haggai: "Hag", Zechariah: "Zech",
  Malachi: "Mal", Matthew: "Matt", Mark: "Mark", Luke: "Luke", John: "John", Acts: "Acts", Romans: "Rom", "1 Corinthians": "1 Cor",
  "2 Corinthians": "2 Cor", Galatians: "Gal", Ephesians: "Eph", Philippians: "Phil", Colossians: "Col", "1 Thessalonians": "1 Th",
  "2 Thessalonians": "2 Th", "1 Timothy": "1 Tim", "2 Timothy": "2 Tim", Titus: "Titus", Philemon: "Phlm", Hebrews: "Heb", James: "Jas",
  "1 Peter": "1 Pet", "2 Peter": "2 Pet", "1 John": "1 Jn", "2 John": "2 Jn", "3 John": "3 Jn", Jude: "Jude", Revelation: "Rev",
};
const short = (name: string) => SHORT[name] ?? name.slice(0, 4);

let cache: { tr: string; books: BookShape[] } | null = null;

/** "John 3:16-17" -> parts, given the book list. Null when it does not parse. */
export function parseRef(ref: string, books: BookShape[]): { book: number; chapter: number; from: number | null; to: number | null } | null {
  const m = ref.trim().match(/^(.+?)\s+(\d+)(?::(\d+)(?:\s*-\s*(\d+))?)?$/);
  if (!m) return null;
  const name = m[1].toLowerCase().replace(/\s+/g, " ").replace(/^psalm$/, "psalms");
  const book = books.findIndex((b) => b.name.toLowerCase() === name);
  if (book < 0) return null;
  return { book, chapter: parseInt(m[2], 10), from: m[3] ? parseInt(m[3], 10) : null, to: m[4] ? parseInt(m[4], 10) : null };
}

export function formatRef(name: string, chapter: number, from: number | null, to: number | null): string {
  if (!from) return name + " " + chapter;
  return name + " " + chapter + ":" + from + (to && to > from ? "-" + to : "");
}

export default function ScripturePicker({ value, onChange, translation }: { value: string; onChange: (ref: string) => void; translation?: string }) {
  const [books, setBooks] = useState<BookShape[]>(cache?.books ?? []);
  useEffect(() => {
    const tr = translation || "";
    if (cache && cache.tr === tr) return;
    invoke<BookShape[]>("bible_structure", { translation: translation || null })
      .then((b) => {
        cache = { tr, books: b };
        setBooks(b);
      })
      .catch(() => {});
  }, [translation]);

  const parts = useMemo(() => parseRef(value, books), [value, books]);
  const book = parts?.book ?? -1;
  const chapters = book >= 0 ? books[book].chapters : [];
  const chapter = parts?.chapter ?? 0;
  const verses = chapter > 0 && chapter <= chapters.length ? chapters[chapter - 1] : 0;
  const from = parts?.from ?? null;
  const to = parts?.to ?? null;

  const set = (b: number, c: number, f: number | null, t: number | null) => {
    if (b < 0) return;
    const cc = Math.min(Math.max(1, c), books[b].chapters.length || 1);
    const vc = books[b].chapters[cc - 1] || 0;
    const ff = f && f <= vc ? f : null;
    const tt = ff && t && t > ff && t <= vc ? t : null;
    onChange(formatRef(books[b].name, cc, ff, tt));
  };

  // Verse drag: [anchor, current] while the button is held; written on release
  // so a live reading is not re-rendered for every verse crossed.
  const [drag, setDrag] = useState<[number, number] | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  useEffect(() => {
    const up = () => {
      const d = dragRef.current;
      if (!d) return;
      setDrag(null);
      const lo = Math.min(d[0], d[1]);
      const hi = Math.max(d[0], d[1]);
      set(book, chapter, lo, hi);
    };
    const cancel = () => setDrag(null);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  });
  const lo = drag ? Math.min(drag[0], drag[1]) : from;
  const hi = drag ? Math.max(drag[0], drag[1]) : from ? to ?? from : null;

  const cell = "h-5 rounded-sm text-[11px] leading-5 tabular-nums select-none";
  const testament = (label: string, first: number, last: number) => (
    <div>
      <div className="px-1 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="grid grid-cols-6 gap-0.5">
        {books.slice(first, last).map((b, j) => {
          const i = first + j;
          return (
            <button
              key={b.name}
              type="button"
              title={b.name}
              disabled={!b.chapters.length}
              className={cn(cell, "truncate px-0.5 disabled:opacity-40", i === book ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
              onClick={() => set(i, 1, null, null)}
            >
              {short(b.name)}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.2fr)] rounded-md border text-sm">
        <div className="flex flex-col gap-1.5 border-r p-1">
          {testament("Old Testament", 0, 39)}
          {testament("New Testament", 39, 66)}
        </div>
        <div className="border-r p-1">
          {chapters.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(1.6rem,1fr))] gap-0.5">
              {chapters.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  title={"Whole chapter " + (i + 1)}
                  className={cn(cell, i + 1 === chapter ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
                  onClick={() => set(book, i + 1, null, null)}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          ) : (
            <p className="p-1 text-xs text-muted-foreground">Pick a book.</p>
          )}
        </div>
        <div className="p-1">
          {verses ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(1.6rem,1fr))] gap-0.5" title="Click a verse, or drag across verses. Shift-click extends.">
              {Array.from({ length: verses }, (_, i) => {
                const v = i + 1;
                const on = lo != null && hi != null && v >= lo && v <= hi;
                return (
                  <button
                    key={v}
                    type="button"
                    className={cn(cell, on ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      setDrag([e.shiftKey && from ? from : v, v]);
                    }}
                    onPointerEnter={() => setDrag((d) => (d ? [d[0], v] : d))}
                  >
                    {v}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="p-1 text-xs text-muted-foreground">{chapters.length ? "Pick a chapter." : ""}</p>
          )}
        </div>
      </div>
      <Input placeholder="…or type it, e.g. John 3:16-18 or Psalm 23" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
