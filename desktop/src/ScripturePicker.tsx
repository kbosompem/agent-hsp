// Book / chapter / verse pickers for a scripture reading. Writes the same
// reference text ("John 3:16-17") the reading already stores, so typing a
// reference still works and the two stay in step.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";

type BookShape = { name: string; chapters: number[] };

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

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <Select value={book >= 0 ? String(book) : undefined} onValueChange={(v) => set(parseInt(v, 10), 1, null, null)}>
          <SelectTrigger className="w-full"><SelectValue placeholder="Book" /></SelectTrigger>
          <SelectContent className="max-h-80">
            <SelectGroup>
              <SelectLabel>Old Testament</SelectLabel>
              {books.slice(0, 39).map((b, i) => (
                <SelectItem key={b.name} value={String(i)} disabled={!b.chapters.length}>{b.name}</SelectItem>
              ))}
            </SelectGroup>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>New Testament</SelectLabel>
              {books.slice(39).map((b, i) => (
                <SelectItem key={b.name} value={String(i + 39)} disabled={!b.chapters.length}>{b.name}</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select value={chapter ? String(chapter) : undefined} disabled={book < 0} onValueChange={(v) => set(book, parseInt(v, 10), null, null)}>
          <SelectTrigger className="w-full"><SelectValue placeholder="Chapter" /></SelectTrigger>
          <SelectContent className="max-h-80">
            {chapters.map((_, i) => (
              <SelectItem key={i} value={String(i + 1)}>Chapter {i + 1}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={from ? String(from) : "all"} disabled={!verses} onValueChange={(v) => set(book, chapter, v === "all" ? null : parseInt(v, 10), to)}>
          <SelectTrigger className="w-full"><SelectValue placeholder="From verse" /></SelectTrigger>
          <SelectContent className="max-h-80">
            <SelectItem value="all">Whole chapter</SelectItem>
            {Array.from({ length: verses }, (_, i) => (
              <SelectItem key={i} value={String(i + 1)}>From verse {i + 1}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={to ? String(to) : "one"} disabled={!from} onValueChange={(v) => set(book, chapter, from, v === "one" ? null : parseInt(v, 10))}>
          <SelectTrigger className="w-full"><SelectValue placeholder="To verse" /></SelectTrigger>
          <SelectContent className="max-h-80">
            <SelectItem value="one">Just that verse</SelectItem>
            {from &&
              Array.from({ length: Math.max(0, verses - from) }, (_, i) => (
                <SelectItem key={i} value={String(from + i + 1)}>To verse {from + i + 1}</SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>
      <Input placeholder="…or type it, e.g. John 3:16-18 or Psalm 23" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
