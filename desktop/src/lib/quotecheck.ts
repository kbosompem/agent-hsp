// Verses quoted or paraphrased without a reference, found by the AI model
// set up for the summary. Word-pair matching (preso-core recite.rs) catches
// a verse said nearly as written; the model also knows the NIV, NLT, NASB
// and the rest, and a paraphrase. Its answer is only a suggestion: the app
// shows it when the words just spoken carry enough of the verse
// (recite::quote_supported). Measured on 5 sermons with 86 marked quotes:
// 60 caught against 38 for word matching alone, under one wrong verse an
// hour, 1.5 s per call (median).

export const QUOTE_SYSTEM = `You follow a live sermon through speech-to-text (expect misheard words). The preacher often quotes or paraphrases Bible verses without naming them.
Look only at the NEWEST line (with the lines before it as context). If the newest line quotes or closely paraphrases one specific Bible verse, give that verse.
Rules:
- Answer only when the words clearly come from that verse: its wording in any translation (KJV, NKJV, NIV, NLT, NASB, ESV...) or a close paraphrase of its distinctive content. Famous half-verses count ("death and life are in the power of the tongue").
- Not for general Christian talk, themes, stories told in the preacher's own words, or stock phrases ("praise the Lord", "in Jesus' name", "God is good").
- Not when the preacher is praying (talking to God: "Father we pray", "oh God", "Lord, help us") unless he is clearly reciting a whole verse.
- If a reference is named ("Romans 10:17"), ignore it: that is handled elsewhere. Judge the words only.
- If unsure, answer null.
Reply with JSON only: {"verse": "Book chapter:verse"} or {"verse": null}.`;

/** New words to gather before asking, and words of context sent before them. */
export const QUOTE_MIN_NEW = 15;
const CONTEXT_WORDS = 60;
const NEWEST_WORDS = 60;

const lastWords = (text: string, n: number) => text.split(/\s+/).filter(Boolean).slice(-n).join(" ");

export function quoteMessage(context: string, newest: string): { user: string; newest: string } {
  const n = lastWords(newest, NEWEST_WORDS);
  return { user: "Earlier lines:\n" + (lastWords(context, CONTEXT_WORDS) || "(none)") + "\n\nNEWEST line:\n" + n, newest: n };
}

/** The verse in the model's reply ("Psalm 119:105"), or null. */
export function parseQuote(reply: string): string | null {
  const m = reply.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]).verse;
    return typeof v === "string" && /\d+:\d+/.test(v) ? v.trim() : null;
  } catch {
    return null;
  }
}
