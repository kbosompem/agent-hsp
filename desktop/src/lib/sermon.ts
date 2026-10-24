// Sermon outline and summary-slide logic. Pure functions over a plain state
// object, shared by the console (App.tsx) and the offline replay
// (scripts/sermon-eval), so the replay shows exactly what the room would see.

export type SermonPoint = { num: number; text: string };
export type VerseLogEntry = { label: string; line: string; pointNum: number | null };
export type SummaryData = { points: { text: string; verses: string[] }[] };
export type SermonState = {
  title: string | null;
  points: SermonPoint[];
  verseLog: VerseLogEntry[];
  notes: string[];
};

const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

export function newSermonState(): SermonState {
  return { title: null, points: [], verseLog: [], notes: [] };
}

export function cleanText(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function trimWords(text: string, n: number): string {
  const w = text.trim().split(/\s+/);
  return w.slice(0, n).join(" ") + (w.length > n ? "…" : "");
}

export function addNote(st: SermonState, bullet: string) {
  const b = bullet.trim();
  if (!b) return;
  const last = st.notes[st.notes.length - 1];
  if (last === b) return;
  st.notes.push(b);
  if (st.notes.length > 30) st.notes.shift();
}

/** Long, faith-heavy lines become notes. */
export function noteFromLine(st: SermonState, cleaned: string) {
  const words = cleaned.split(/\s+/);
  if (words.length >= 14 && /god|jesus|lord|christ|love|faith|grace|cross|spirit|pray|mercy/i.test(cleaned)) {
    addNote(st, trimWords(cleaned, 14));
  }
}

/** Record a verse shown on screen, tied to the current sermon point. */
export function logVerse(st: SermonState, label: string, verseText: string, trigger?: string) {
  if (trigger !== undefined) {
    st.verseLog.push({
      label,
      line: trigger,
      pointNum: st.points.length ? st.points[st.points.length - 1].num : null,
    });
    if (st.verseLog.length > 24) st.verseLog.shift();
  }
  addNote(st, label + " — " + trimWords(verseText, 12));
}

/** Take back the last logVerse() of a verse that was swapped out as misheard. */
export function unlogVerse(st: SermonState, label: string) {
  const i = st.verseLog.map((e) => e.label).lastIndexOf(label);
  if (i >= 0) st.verseLog.splice(i, 1);
  const n = st.notes.map((b) => b.startsWith(label + " — ")).lastIndexOf(true);
  if (n >= 0) st.notes.splice(n, 1);
}

/** Pick up "the title of my message is…" and "point number one…". Returns status messages. */
export function extractSermonStructure(st: SermonState, text: string): string[] {
  const msgs: string[] = [];
  const tm = text.match(
    /title\s+(?:of\s+(?:my|the|his|her)\s+(?:message|sermon|teaching)\s+)?(?:is|:)\s+(.+)/i
  );
  if (tm) {
    const t = cleanText(tm[1]).replace(/[.!]+$/, "");
    if (t.length >= 3) {
      st.title = t.split(/\s+/).slice(0, 12).join(" ");
      msgs.push("Sermon title set: " + st.title);
    }
  }
  const markerRe =
    /point\s+(?:number\s+|no\.?\s*|#\s*)?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/gi;
  const marks: { num: number; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(text)) !== null) {
    const raw = m[1].toLowerCase();
    const num = /^\d+$/.test(raw) ? parseInt(raw, 10) : WORD_NUM[raw];
    if (num && num >= 1 && num <= 12) {
      marks.push({ num: num, start: m.index, end: m.index + m[0].length });
    }
  }
  for (let i = 0; i < marks.length; i++) {
    const segEnd = i + 1 < marks.length ? marks[i + 1].start : undefined;
    let seg = text.slice(marks[i].end, segEnd);
    seg = seg.split(/[.?!]/)[0];
    seg = seg.replace(/^[\s,:-]+|[\s,]+$/g, "").trim();
    if (!seg || seg.split(/\s+/).length < 1) continue;
    const pt = { num: marks[i].num, text: trimWords(seg, 12).replace(/…$/, "") };
    const existing = st.points.findIndex((p) => p.num === pt.num);
    if (existing >= 0) st.points[existing] = pt;
    else st.points.push(pt);
    st.points.sort((a, b) => a.num - b.num);
    msgs.push("Point " + pt.num + " registered: " + pt.text);
  }
  return msgs;
}

export function buildSummary(st: SermonState): SummaryData {
  if (st.points.length > 0) {
    return {
      points: st.points.slice(0, 4).map((p) => ({
        text: p.text,
        verses: st.verseLog
          .filter((v) => v.pointNum === p.num)
          .map((v) => v.label)
          .slice(0, 4),
      })),
    };
  }
  const log = st.verseLog.slice(-14);
  const points: { text: string; verses: string[] }[] = [];
  for (const e of log) {
    const prefix = e.label.replace(/:\d+(-\d+)?$/, "");
    const last = points[points.length - 1];
    if (last && last.verses.some((v) => v.startsWith(prefix + " "))) {
      if (last.verses.length < 4) last.verses.push(e.label);
    } else {
      points.push({ text: e.line ? trimWords(e.line, 10) : e.label, verses: [e.label] });
    }
    if (points.length >= 4) break;
  }
  return { points: points.slice(-4) };
}

/** `lines` is the recent transcript, oldest first. */
export function sermonTitle(st: SermonState, lines: string[]): string {
  if (st.title) return st.title;
  for (const l of lines.slice(-80)) {
    const m = l.match(/(?:this morning|today|the message|the theme|the title|we are (?:looking|talking)|preaching)[^.]{0,90}/i);
    if (m) return trimWords(m[0], 10);
  }
  return "Sermon summary";
}
