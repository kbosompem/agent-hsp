// Grouping consecutive verses onto slides: "John 3:16-17" on one slide with
// small verse numbers, or a long passage split so each slide stays readable.

export type Ref = { book: number; chapter: number; verse: number | null; end_verse: number | null };
export type Hit = { label: string; text: string; translation: string; reference: Ref | null };

/** "fit": as many verses as fit in FIT_CHARS (at most FIT_MAX); or a fixed count. */
export type PerSlide = "fit" | 1 | 2 | 3 | 4;
export const FIT_CHARS = 350;
export const FIT_MAX = 4;

const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
export function superscript(n: number): string {
  return String(n)
    .split("")
    .map((d) => SUP[Number(d)])
    .join("");
}

/** One slide's worth of verses as a single hit: "John 3:16-17", "¹⁶ For God… ¹⁷ For God sent…". */
export function combine(hits: Hit[]): Hit {
  if (hits.length === 1) return hits[0];
  const first = hits[0];
  const last = hits[hits.length - 1];
  const v1 = first.reference?.verse ?? 0;
  const v2 = last.reference?.verse ?? v1;
  const label = first.label.replace(/:\d+(?:-\d+)?$/, "") + ":" + v1 + "-" + v2;
  const text = hits.map((h) => superscript(h.reference?.verse ?? 0) + " " + h.text).join(" ");
  return { label, text, translation: first.translation, reference: first.reference ? { ...first.reference, verse: v1, end_verse: v2 } : null };
}

/** Split consecutive verse hits into slides. `fitChars` is the "fit" limit,
 * halved when a second translation shares the slide. */
export function groupVerses(hits: Hit[], per: PerSlide, fitChars = FIT_CHARS): Hit[] {
  const out: Hit[] = [];
  let cur: Hit[] = [];
  let chars = 0;
  for (const h of hits) {
    const len = h.text.length + 4;
    const full = per === "fit" ? cur.length >= FIT_MAX || (cur.length > 0 && chars + len > fitChars) : cur.length >= per;
    if (full) {
      out.push(combine(cur));
      cur = [];
      chars = 0;
    }
    cur.push(h);
    chars += len;
  }
  if (cur.length) out.push(combine(cur));
  return out;
}

/** True when `verse` is on the slide `h` (a single verse or a combined range). */
export function slideHas(h: Hit, book: number, chapter: number, verse: number): boolean {
  const r = h.reference;
  if (!r || r.book !== book || r.chapter !== chapter || r.verse == null) return false;
  return verse >= r.verse && verse <= (r.end_verse ?? r.verse);
}

export function parsePerSlide(v: string | null | undefined): PerSlide {
  return v === "1" || v === "2" || v === "3" || v === "4" ? (Number(v) as PerSlide) : "fit";
}

/** A second translation shown with the first: side by side or one above the other. */
export type Second = { tr: string; layout: "side" | "stack" };

export function parseSecond(v: string | null | undefined): Second | null {
  try {
    const d = v ? JSON.parse(v) : null;
    return d && typeof d.tr === "string" && d.tr ? { tr: d.tr, layout: d.layout === "stack" ? "stack" : "side" } : null;
  } catch {
    return null;
  }
}

/** The "verse2" slide: the same passage in two translations. Its body is
 * JSON (SlideView draws it); its sub names both translations. */
export function pairSlide(a: Hit, b: Hit, layout: Second["layout"]) {
  return {
    kind: "verse2",
    title: a.label,
    body: JSON.stringify({ layout, a: { text: a.text, tr: a.translation }, b: { text: b.text, tr: b.translation } }),
    sub: a.translation + " · " + b.translation,
  };
}

/** A verse is on screen, in one translation or two. */
export function isVerseSlide(kind: string | undefined): boolean {
  return kind === "verse" || kind === "verse2";
}
