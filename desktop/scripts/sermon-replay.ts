// Replay a harness dump (final transcripts + shown verses) through the
// console's summary logic and list every summary slide the room would see.
//   npx esbuild scripts/sermon-replay.ts --bundle --platform=node --outfile=/tmp/replay.js
//   node /tmp/replay.js dump.json > slides.json
import { readFileSync } from "fs";
import {
  buildSummary,
  cleanText,
  extractSermonStructure,
  logVerse,
  newSermonState,
  noteFromLine,
  sermonTitle,
} from "../src/lib/sermon";

const VERSE_HOLD_S = 60;

type Final = { t: number; text: string };
type Shown = { t: number; label: string; text: string; trigger: string };

const dump = JSON.parse(readFileSync(process.argv[2], "utf8"));
const finals: Final[] = dump.finals;
const shown: Shown[] = dump.shown;
const end: number = dump.clip[1];

const st = newSermonState();
const lines: string[] = [];
const slides: { t: number; title: string; points: { text: string; verses: string[] }[] }[] = [];

type Ev = { t: number; kind: "final"; f: Final } | { t: number; kind: "verse"; v: Shown } | { t: number; kind: "summary" };
const evs: Ev[] = [];
finals.forEach((f) => evs.push({ t: f.t, kind: "final", f }));
shown.forEach((v, i) => {
  evs.push({ t: v.t, kind: "verse", v });
  // The verse holds 60 s; if nothing replaces it, the summary takes over.
  const next = shown[i + 1];
  if (!next || next.t > v.t + VERSE_HOLD_S) evs.push({ t: v.t + VERSE_HOLD_S, kind: "summary" });
});
evs.push({ t: end, kind: "summary" });
const order = { final: 0, verse: 1, summary: 2 };
evs.sort((a, b) => a.t - b.t || order[a.kind] - order[b.kind]);

for (const e of evs) {
  if (e.kind === "final") {
    const c = cleanText(e.f.text);
    if (!c) continue;
    extractSermonStructure(st, c);
    lines.push(c);
    noteFromLine(st, c);
  } else if (e.kind === "verse") {
    logVerse(st, e.v.label, e.v.text, cleanText(e.v.trigger));
  } else {
    if (e.t > end) continue;
    const data = buildSummary(st);
    if (data.points.length) slides.push({ t: e.t, title: sermonTitle(st, lines), points: data.points });
  }
}

console.log(JSON.stringify({ title: st.title, points: st.points, notes: st.notes, slides }, null, 2));
