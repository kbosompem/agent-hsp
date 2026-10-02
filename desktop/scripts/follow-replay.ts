// Replay a harness dump (streaming mode) through the console's follow-the-
// reading rules and print when each verse of a range would go up.
//   node follow-replay.js dump.json kjv.json "Matthew" 5 1 12
import { readFileSync } from "fs";
import { contentWords, readPast } from "../src/lib/voice";

const [dumpPath, biblePath, bookName, ch, from, to] = process.argv.slice(2);
const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
const bible = JSON.parse(readFileSync(biblePath, "utf8"));
const book = bible.books.find((b: any) => b.n === bookName);
const slides: string[] = book.c[+ch - 1].slice(+from - 1, +to);
const startAt = dump.shown.find((s: any) => s.label.startsWith(`${bookName} ${ch}:${from}`))?.t ?? 0;

type Ev = { t: number; text: string; seg: number; final: boolean };
const evs: Ev[] = [
  ...dump.partials.map((p: any) => ({ ...p, final: false })),
  ...dump.finals.map((f: any) => ({ ...f, final: true })),
].sort((a, b) => a.t - b.t || (a.final ? 1 : -1));

let idx = 0;
let words: string[] = [];
let skipSeg = -1, skipCount = 0;
let lastPartial = { seg: -1, text: "" };
console.log(`${startAt.toFixed(1)}s  ${bookName} ${ch}:${+from}`);
function show(n: number, t: number) {
  idx = n;
  words = [];
  skipSeg = lastPartial.seg;
  skipCount = contentWords(lastPartial.text).length;
  console.log(`${t.toFixed(1)}s  ${bookName} ${ch}:${+from + n}`);
}
function follow(live: string[], t: number) {
  if (idx >= slides.length - 1) return;
  if (readPast(words.concat(live), slides[idx], slides[idx + 1] ?? null)) show(idx + 1, t);
}
for (const e of evs) {
  if (e.t < startAt) continue;
  if (!e.final) {
    lastPartial = { seg: e.seg, text: e.text };
    let live = contentWords(e.text);
    if (e.seg === skipSeg) live = live.slice(skipCount);
    follow(live, e.t);
  } else {
    let fw = contentWords(e.text);
    if (e.seg === skipSeg) { fw = fw.slice(skipCount); skipSeg = -1; }
    words.push(...fw);
    follow([], e.t);
    lastPartial = { seg: -1, text: "" };
  }
}
