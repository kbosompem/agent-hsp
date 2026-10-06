// Voice control helpers for the console: following a preacher's reading
// through a verse range, and translation requests ("show NLT").
// Pure functions so they can be tested outside the app (scripts/test-voice.ts).

// ---------------------------------------------------------------- reading

const STOP = new Set(
  (
    "the and that for with his her him she they them their you your our ours this these those was were are " +
    "has had have not but from all any one two who whom what when where which will would shall should " +
    "unto upon thee thou thy thine ye hath doth also into out over then than there here been being " +
    "came come said say says saith let may might did does done very much many more most such even only " +
    "own same other some each every both just now yet nor because about after before again verse verses"
  ).split(" ")
);

/** Crude stem so "blessed"/"blesseth"/"bless" and "heavens"/"heaven" meet. */
function stem(w: string): string {
  return w
    .replace(/(eth|est|ing|ed|es|s)$/, "")
    .replace(/(.)\1$/, "$1")
    .replace(/(...)e$/, "$1");
}

/** Content words of a text, lower-cased and stemmed. */
export function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+/g) || [])
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map(stem)
    .filter((w) => w.length >= 3);
}

/**
 * Has the preacher read past the verse on screen? True when he has said
 * most of its closing words (and a fair share of the whole verse), or has
 * started the next verse. Works across translations because it only needs
 * a share of the content words, not exact wording.
 */
export function readPast(spoken: string[], current: string, next: string | null): boolean {
  const heard = new Set(spoken);
  const cw = contentWords(current);
  if (cw.length) {
    // He must reach the end: the verse's last content word, or most of its
    // last three, and in either case at least half the verse.
    const unique = Array.from(new Set(cw));
    const coverage = unique.filter((w) => heard.has(w)).length / unique.length;
    const tail = cw.slice(-3);
    const tailHits = tail.filter((w) => heard.has(w)).length;
    const lastHeard = heard.has(cw[cw.length - 1]);
    if (coverage >= 0.5 && (lastHeard || (tail.length >= 3 && tailHits >= 3))) return true;
  }
  if (next) {
    const head = Array.from(new Set(contentWords(next))).slice(0, 4);
    if (head.length >= 3 && head.filter((w) => heard.has(w)).length >= head.length - 1) {
      // The opening words of the next verse must not simply be words the
      // current verse also uses ("Blessed are ..." in every beatitude).
      const novel = head.filter((w) => !cw.includes(w));
      if (novel.length === 0 || novel.some((w) => heard.has(w))) return true;
    }
  }
  return false;
}

/**
 * Share of a spoken line's content words that come from the verse on screen.
 * High overlap means the preacher is reading it, so the line must not be
 * treated as a new quote.
 */
export function readingOverlap(spoken: string, verseText: string): number {
  const said = Array.from(new Set(contentWords(spoken)));
  if (!said.length) return 0;
  const verse = new Set(contentWords(verseText));
  return said.filter((w) => verse.has(w)).length / said.length;
}

/**
 * "go back", "next verse" and similar are navigation only when the sentence
 * carries no reference of its own: "go back to James chapter 3 verse 3" is a
 * reference to show, not a step backwards.
 */
export function hasReferenceWords(normalized: string): boolean {
  return /\d|\b(chapter|chapters|verse|verses)\b/.test(normalized.replace(/\b(next|previous|last) verse\b/g, ""));
}

// ----------------------------------------------------------- translations

/** Common English translations: code, full name, and the ways people say them. */
export const TRANSLATIONS: { code: string; name: string; say: string[] }[] = [
  { code: "nkjv", name: "New King James Version", say: ["new king james", "nkjv"] },
  { code: "kjv", name: "King James Version", say: ["king james", "kjv", "authorized version"] },
  { code: "nasb", name: "New American Standard Bible", say: ["new american standard", "nasb"] },
  { code: "asv", name: "American Standard Version", say: ["american standard", "asv"] },
  { code: "nlt", name: "New Living Translation", say: ["new living", "nlt", "living bible"] },
  { code: "niv", name: "New International Version", say: ["new international", "niv"] },
  { code: "nirv", name: "New International Reader's Version", say: ["nirv", "international readers", "international reader"] },
  { code: "esv", name: "English Standard Version", say: ["english standard", "esv"] },
  { code: "amp", name: "Amplified Bible", say: ["amplified"] },
  { code: "msg", name: "The Message", say: ["message bible", "message translation", "message version"] },
  { code: "csb", name: "Christian Standard Bible", say: ["christian standard", "csb", "hcsb"] },
  { code: "gnt", name: "Good News Translation", say: ["good news translation", "good news bible", "gnt"] },
  { code: "web", name: "World English Bible", say: ["world english", "web bible"] },
  { code: "bbe", name: "Bible in Basic English", say: ["basic english", "bbe"] },
  { code: "bsb", name: "Berean Standard Bible", say: ["berean", "bsb"] },
  { code: "lsv", name: "Literal Standard Version", say: ["literal standard", "lsv"] },
  { code: "fbv", name: "Free Bible Version", say: ["free bible", "fbv"] },
  { code: "rsv", name: "Revised Standard Version", say: ["revised standard", "rsv"] },
];

const CODES = new Set(TRANSLATIONS.flatMap((t) => t.say.filter((x) => !x.includes(" "))));

/**
 * Lower-case, strip punctuation, and join spelled-out letters: "N.L.T." -> "nlt".
 * A single-letter word before the letters ("I N.I.V.") is kept apart when the
 * rest of the run spells a translation code.
 */
export function normalizeSpeech(text: string): string {
  const toks = text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  let i = 0;
  while (i < toks.length) {
    let j = i;
    while (j < toks.length && toks[j].length === 1 && /[a-z]/.test(toks[j])) j++;
    if (j - i >= 2) {
      const run = toks.slice(i, j);
      let k = 0;
      while (k < run.length - 1 && !CODES.has(run.slice(k).join(""))) k++;
      if (k < run.length - 1) {
        out.push(...run.slice(0, k), run.slice(k).join(""));
      } else {
        out.push(run.join(""));
      }
      i = j;
    } else {
      out.push(toks[i]);
      i++;
    }
  }
  return out.join(" ");
}

// Asking verbs only: "in the NIV it says" is commentary, not a request.
const ASK = /\b(show|read|reading|display|put|switch|change|use|give|see)\b/;
const PHRASES = TRANSLATIONS.flatMap((t) => t.say.map((say) => ({ t, say }))).sort((a, b) => b.say.length - a.say.length);

/**
 * A translation the speaker is asking for, or null. Accepts "show NLT",
 * "read it in the NIV", "let's see the Amplified", "American Standard
 * Version", "the amplified version says", "NLT please". Longer names are
 * tried first, so "New American Standard" is never taken for "American Standard".
 */
export function translationRequest(text: string): { code: string; name: string } | null {
  const norm = normalizeSpeech(text);
  const words = norm.split(" ");
  for (const { t, say } of PHRASES) {
    const idx = (" " + norm + " ").indexOf(" " + say + " ");
    if (idx < 0) continue;
    const before = norm.slice(0, idx).split(" ").filter(Boolean).slice(-4).join(" ");
    const after = norm.slice(idx + say.length).trim();
    const nameOnly = words.length <= say.split(" ").length + 2;
    const asked = ASK.test(before) || /^(version|translation|bible|please)\b/.test(after) || nameOnly;
    if (asked) return { code: t.code, name: t.name };
    return null;
  }
  return null;
}

/** The loaded translation that matches a requested code, if any. */
export function findLoaded<T extends { id: string; name: string }>(code: string, loaded: T[]): T | undefined {
  const want = TRANSLATIONS.find((t) => t.code === code);
  return loaded.find((l) => {
    const id = l.id.toLowerCase();
    const name = l.name.toLowerCase();
    if (id === code) return true;
    if (!want) return false;
    if (name === want.name.toLowerCase()) return true;
    // "New American Standard" must not be taken for "American Standard"
    const clash = TRANSLATIONS.some((o) => o.code !== code && o.say[0].includes(want.say[0]) && name.includes(o.say[0]));
    return !clash && (name.includes(want.say[0]) || new RegExp("\\b" + code + "\\b").test(name));
  });
}
