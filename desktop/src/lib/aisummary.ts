// The live AI sermon summary: the instructions for the model, the message
// built from the transcript and the verses shown, and a careful reading of
// its reply. Pure functions, so scripts can replay a recorded sermon through
// the same prompt the console uses.

export type AiPoint = { point: string; detail: string; verses: string[] };
export type AiSummary = { title: string; big_idea: string; points: AiPoint[] };
export type AiLine = { at: number; text: string };
export type AiVerse = { at: number; label: string; text: string; translation: string };
/** A sentence the preacher quoted from one of the imported books. */
export type AiBookQuote = { at: number; book: string; chapter: string; text: string };
/** A book chapter close to the sermon (preso-core books.rs). */
export type AiOutline = { book: string; chapter: string; heads: string[]; refs: string[]; score: number };
/** What the console knows besides the transcript: verses named but never shown, and the preacher's books. */
export type AiExtra = { named: string[]; quotes: AiBookQuote[]; outlines: AiOutline[] };

export const SUMMARY_SYSTEM = `You keep a live summary of a church sermon for the church's media team. You receive the Bible verses that were put on screen, other verses the preacher named, and the transcript so far. The transcript is raw speech-to-text: expect misheard words, missing punctuation, and parts of the service that are not the sermon. Return the updated summary as JSON only.

What to capture
- title: the title the preacher announces ("my message today is...", "I've titled this..."). If none is announced, a short title from the main theme. At most 8 words.
- big_idea: one sentence, the single thing the preacher wants people to leave with.
- points: the main movements of the sermon, in the order preached. A point is a claim or instruction the preacher states and develops for a while. It is often announced ("first", "number two", "step three", "the next thing I want you to see"), often repeated, and often tied to a verse. A whole sermon usually has 2 to 7, never more than 10.
- When the preacher announces a structure ("seven steps", "three things"), those steps are the points, and the introduction before them is not: fold it into big_idea.
- Not a point: a story, a joke, an aside, one passing sentence, or a line that restates another point in other words ("believe God", "obey God" and "do the works of God" as reasons for one attitude are one point). Fold these into the point they support.
- Several examples of one idea are one point: if the preacher lists signs, kinds or ways of something ("absence is a sign of dishonor... stubbornness is a sign of dishonor..."), make one point that names them ("Absence, stubbornness and ignoring advice are signs of dishonor").
- point: a short line of at most 12 words, in plain language, written as a statement the way the preacher would put it on a slide. Write the point itself, not its number or a description of it: "Hear from God", not "The first step is to hear from God"; "God finishes what He starts", not "The pastor talks about God's faithfulness".
- detail: one sentence of at most 25 words on how the preacher developed the point.
- verses: the references the preacher used for this point, written exactly as they appear in the two verse lists (put on screen, or named). Only references from those lists. An empty list if the point has none.
- When a point rests on a Bible story ("the young prophet who disobeyed God and was killed by a lion"), say so in detail, with the book and chapter if he named them.

The preacher's books
- Preachers in this church often preach from and quote the books of Dag Heward-Mills (they call him Bishop Dag, Daddy or the Prophet). You may receive sentences the preacher quoted from a book, and the outline (title, headings, numbered points, verses) of book chapters whose words and verses are close to this sermon.
- Use a chapter only where the preacher clearly followed it: when he preached one of its points, you may word that point as the book does. Never add a point, verse or idea from a book that he did not preach. If a chapter does not match what he preached, ignore it.
- When he quoted a book, name it in that point's detail ("as Dag Heward-Mills writes in Loyalty and Disloyalty").

What to leave out
- Worship songs, announcements, greetings, the offering, prayer requests, and anything said before the sermon starts or after it ends. If the sermon has not started yet, return an empty points list and empty title and big_idea.
- Read through speech-to-text mistakes to what was meant, but never add anything the preacher did not say: no theology, applications or verses of your own.

While the sermon goes on
- The summary is rebuilt from the transcript every minute or two. Outline what has been preached so far; do not guess what comes next.
- The latest point may still be developing: give your best short line for it.

Reply with only this JSON, no other text and no code fences:
{"title": "...", "big_idea": "...", "points": [{"point": "...", "detail": "...", "verses": ["John 3:16"]}]}`;

/** Most recent transcript words sent each time (about two hours of preaching). */
const MAX_WORDS = 16000;

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  return p(Math.floor(s / 3600)) + ":" + p(Math.floor(s / 60) % 60) + ":" + p(s % 60);
}

function firstWords(text: string, n: number): string {
  const w = text.trim().split(/\s+/);
  return w.slice(0, n).join(" ") + (w.length > n ? "..." : "");
}

// Each summary is built from the whole transcript, with no earlier summary
// in the message: replays showed an earlier draft anchors the model to points
// it guessed during the introduction.
export function summaryMessage(lines: AiLine[], verses: AiVerse[], startedAt: number, final: boolean, extra?: AiExtra): string {
  const out: string[] = [];
  out.push("Verses put on screen (time, reference, first words):");
  if (!verses.length) out.push("(none yet)");
  for (const v of verses) out.push(clock(v.at - startedAt) + " · " + v.label + " · " + firstWords(v.text, 10));
  out.push("");
  const shown = new Set(verses.map((v) => norm(v.label)));
  const named = (extra?.named ?? []).filter((l) => !shown.has(norm(l)));
  if (named.length) out.push("Other verses the preacher named (heard in the transcript, not put on screen; some may be misheard):", named.join(", "), "");
  if (extra?.quotes.length) {
    out.push("Sentences the preacher quoted from a book (time, book, the book's words):");
    for (const q of extra.quotes) out.push(clock(q.at - startedAt) + " · " + q.book + (q.chapter ? ", " + q.chapter : "") + " · " + q.text);
    out.push("");
  }
  for (const o of extra?.outlines ?? []) {
    out.push("A book chapter close to this sermon (a guide only): " + o.book + ", chapter \"" + o.chapter + "\"");
    if (o.heads.length) out.push("Its headings and points:", ...o.heads.map((h) => "- " + h));
    if (o.refs.length) out.push("Its verses: " + o.refs.join(", "));
    out.push("");
  }
  // Keep the newest lines within the word budget.
  const kept: string[] = [];
  let words = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    words += lines[i].text.split(/\s+/).length;
    if (words > MAX_WORDS) {
      kept.push("(the start of the transcript is left out for length)");
      break;
    }
    kept.push("[" + clock(lines[i].at - startedAt) + "] " + lines[i].text);
  }
  out.push(final ? "The service has ended. Full transcript, oldest first:" : "Transcript so far, oldest first:");
  out.push(...kept.reverse());
  if (final) out.push("", "This is the final summary of the whole sermon.");
  return out.join("\n");
}

const norm = (l: string) => l.toLowerCase().replace(/\bpsalms\b/, "psalm").replace(/\s+/g, " ").trim();

/** The model's reply as a summary, or null if it is not one. Verses not in `shown` (shown or named) are dropped. */
export function parseSummary(reply: string, shown: string[]): AiSummary | null {
  const a = reply.indexOf("{");
  const b = reply.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let v: any;
  try {
    v = JSON.parse(reply.slice(a, b + 1));
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || !Array.isArray(v.points)) return null;
  const byNorm = new Map(shown.map((l) => [norm(l), l]));
  const str = (x: unknown, max: number) => (typeof x === "string" ? x.trim().slice(0, max) : "");
  const points: AiPoint[] = [];
  for (const p of v.points.slice(0, 10)) {
    const point = str(p?.point, 120);
    if (!point) continue;
    const verses: string[] = [];
    for (const r of Array.isArray(p?.verses) ? p.verses : []) {
      const l = typeof r === "string" ? byNorm.get(norm(r)) : undefined;
      if (l && !verses.includes(l)) verses.push(l);
    }
    points.push({ point, detail: str(p?.detail, 300), verses });
  }
  return { title: str(v.title, 100), big_idea: str(v.big_idea, 300), points };
}

/** summary.md for the session folder. */
export function summaryMarkdown(s: AiSummary, heading: string, by: string): string {
  const out = ["# " + (s.title || heading), "", heading + " · summary by " + by, ""];
  if (s.big_idea) out.push(s.big_idea, "");
  if (s.points.length) {
    out.push("## Points", "");
    s.points.forEach((p, i) => {
      out.push(i + 1 + ". **" + p.point + "**" + (p.detail ? " " + p.detail : ""));
      if (p.verses.length) out.push("   Verses: " + p.verses.join(", "));
    });
    out.push("");
  } else {
    out.push("No sermon points were found.", "");
  }
  out.push("Files in this folder: audio.m4a (the recording; audio.wav on Windows), transcript.txt (the full raw transcript with times), summary.md (this file), verses.md (only the verses shown).");
  return out.join("\n") + "\n";
}

/** verses.md: only the verses shown, in order, then any book quotes recognized. */
export function versesMarkdown(verses: AiVerse[], heading: string, quotes: AiBookQuote[] = []): string {
  const t = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const out = ["# Verses shown", "", heading, ""];
  if (!verses.length) out.push("None.");
  for (const v of verses) out.push("- " + t(v.at) + " · **" + v.label + "** (" + v.translation + ") " + v.text);
  if (quotes.length) {
    out.push("", "## Quoted from books", "");
    for (const q of quotes) out.push("- " + t(q.at) + " · **" + q.book + "**" + (q.chapter ? " (" + q.chapter + ")" : "") + " " + q.text);
  }
  return out.join("\n") + "\n";
}
