import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { Embedder } from "./lib/embed";
import {
  addNote as addSermonNote,
  buildSummary as buildSermonSummary,
  cleanText,
  extractSermonStructure as extractStructure,
  logVerse,
  newSermonState,
  noteFromLine,
  sermonTitle as titleFor,
  SummaryData,
  trimWords,
} from "./lib/sermon";
import { contentWords, findLoaded, readPast, translationRequest } from "./lib/voice";

type VerseHit = {
  label: string;
  text: string;
  translation: string;
  reference: {
    book: number;
    chapter: number;
    verse: number | null;
    end_verse: number | null;
  } | null;
};

type TranslationInfo = { id: string; name: string };

type Slide = {
  kind: string;
  title: string;
  body: string;
  sub: string;
};

type Card = {
  id: number;
  label: string;
  hit: VerseHit;
  trigger: string;
  kind: "ref" | "quote";
  fireAt: number;
  status: "pending" | "done";
};

type TrLine = { text: string; labels: string[] };


type OutputTheme = {
  bgKind: "gradient" | "image";
  gradient: string;
  image: string;
  overlay: number;
  textColor: string;
  accent: string;
  font: "serif" | "sans";
};

const GRADIENTS: { name: string; css: string }[] = [
  { name: "Midnight Navy", css: "radial-gradient(120% 95% at 50% 0%, #24314e 0%, #101827 55%, #090d14 100%)" },
  { name: "Deep Gold", css: "radial-gradient(100% 120% at 50% 100%, #3a2f10 0%, #161207 60%, #0a0805 100%)" },
  { name: "Slate", css: "linear-gradient(180deg, #2a3548 0%, #10151f 100%)" },
  { name: "Purple Dawn", css: "linear-gradient(160deg, #2c2050 0%, #0b0f17 100%)" },
  { name: "Forest", css: "linear-gradient(170deg, #12301f 0%, #0a0d13 100%)" },
  { name: "Crimson Night", css: "linear-gradient(200deg, #3a1420 0%, #0c0a10 100%)" },
];

const DEFAULT_THEME: OutputTheme = {
  bgKind: "gradient",
  gradient: GRADIENTS[0].css,
  image: "",
  overlay: 0.45,
  textColor: "#f3ecdc",
  accent: "#e9c465",
  font: "serif",
};

const QUOTE_THRESHOLD = 0.55;

const FIRE_DELAY = 600;
const VERSE_HOLD_MS = 60000;

function isJunk(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^[\d\s.,:;_-]+$/.test(t)) return true;
  const junk = ["thank you.", "thanks for watching!", "you", "bye.", "thank you", "hm", "hmm", "uh", "um", "okay", "ok"];
  if (junk.includes(t.toLowerCase())) return true;
  const words = t.split(/\s+/);
  if (words.length === 1 && t.length < 4) return true;
  return false;
}

const NUMBER_WORDS = /^(\d+([:.-]\d+)*|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)$/i;

function isNumberWord(tail: string): boolean {
  return NUMBER_WORDS.test(tail.replace(/^[\s,.:;-]+/, "").replace(/[.,!?]+$/, ""));
}

const RANGE_WORDS = new Set(["and", "to", "through", "thru", "until", "till"]);

// Trim the unfinished end of a partial transcript. "John 3 1" may be "John 3 16"
// half-spoken, and "Proverbs 3 verses 5 and" may be the start of "5 and 6".
// Drops a trailing number, then any trailing "<number> <range word>".
function settleTail(text: string): string {
  const words = text.trim().split(/\s+/);
  const bare = (w: string) => w.replace(/^[,.:;-]+/, "").replace(/[.,!?:;-]+$/, "").toLowerCase();
  if (words.length && isNumberWord(words[words.length - 1])) words.pop();
  while (words.length >= 2 && RANGE_WORDS.has(bare(words[words.length - 1])) && isNumberWord(words[words.length - 2])) {
    words.splice(-2, 2);
  }
  return words.join(" ");
}

export default function App() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<VerseHit[]>([]);
  const [slide, setSlide] = useState<Slide | null>(null);
  const [listening, setListening] = useState(false);
  const [modelStatus, setModelStatus] = useState("native whisper.cpp · model loaded");
  const [micStatus, setMicStatus] = useState("");
  const [micLevelPct, setMicLevelPct] = useState(0);
  const [mics, setMics] = useState<string[]>([]);
  const [micId, setMicId] = useState("");
  // small.en finds the most verses in noisy-room tests; Macs run it on the GPU.
  // Windows runs whisper on the CPU, where base.en is the safer default.
  const [model, setModel] = useState(() => (/Mac/i.test(navigator.userAgent) ? "small.en" : "base.en"));
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("preso-theme") as "dark" | "light") || "dark"
  );
  const [transcriptView, setTranscriptView] = useState<"processed" | "raw">("processed");
  const [view, setView] = useState<"console" | "theme" | "downloads">("console");
  const [trId, setTrId] = useState("kjv");
  const [outTheme, setOutTheme] = useState<OutputTheme>(() => {
    try {
      const saved = localStorage.getItem("preso-output-theme");
      if (saved) return { ...DEFAULT_THEME, ...JSON.parse(saved) };
    } catch (e) {
      /* ignore */
    }
    return DEFAULT_THEME;
  });
  const [quoteStatus, setQuoteStatus] = useState("not loaded");
  const [translations, setTranslations] = useState<TranslationInfo[]>([]);
  const [, setForce] = useState(0);

  const trIdRef = useRef("kjv");
  const translationsRef = useRef<TranslationInfo[]>([]);
  const historyRef = useRef<{ label: string; hit: VerseHit }[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const transcriptRef = useRef<TrLine[]>([]);
  const rawRef = useRef<string[]>([]);
  const cardsRef = useRef<Card[]>([]);
  // Title, points, verse log and notes for the summary slide (see lib/sermon.ts).
  const stRef = useRef(newSermonState());
  const quoteIndexRef = useRef<{ vecs: Float32Array; refs: number[][] } | null>(null);
  const quoteBusy = useRef(false);
  const slideRef = useRef<Slide | null>(null);
  const lastVerse = useRef<VerseHit | null>(null);
  const verseShownAt = useRef(0);
  const seq = useRef(1);
  const shownRef = useRef<Record<string, number>>({});
  const lastCmdAt = useRef(0);
  const lastTrAt = useRef(0);
  const diagRef = useRef("");
  const listeningRef = useRef(false);
  // Streaming partials: live text of the segment still being spoken, the
  // labels the previous partial saw, and labels already fired from partials.
  const partialRef = useRef<{ seg: number; text: string; labels: Set<string>; fired: string[] }>({
    seg: -1,
    text: "",
    labels: new Set(),
    fired: [],
  });
  const indexLoadedRef = useRef(false);
  const dirtyRef = useRef(false);
  const seqRef = useRef<{ slides: VerseHit[]; idx: number } | null>(null);
  // Words heard since the current slide of a range went up, for following the
  // reading. Words of the live segment already counted at that moment are skipped.
  const followRef = useRef<{ words: string[]; skipSeg: number; skipCount: number }>({
    words: [],
    skipSeg: -1,
    skipCount: 0,
  });
  const advancingRef = useRef(false);

  function sync() {
    if (dirtyRef.current) return;
    dirtyRef.current = true;
    setTimeout(() => {
      dirtyRef.current = false;
      setForce((t) => t + 1);
    }, 120);
  }

  useEffect(() => {
    document.body.setAttribute("data-theme", theme);
    localStorage.setItem("preso-theme", theme);
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem("preso-output-theme", JSON.stringify(outTheme));
    } catch (e) {
      /* image too large for localStorage; theme stays for this session */
    }
    void emit("output-theme", outTheme);
  }, [outTheme]);

  async function applyImage(f: File) {
    const dataUrl: string = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsDataURL(f);
    });
    const lum: number = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = 64;
        c.height = 36;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0, 64, 36);
        const d = ctx.getImageData(0, 0, 64, 36).data;
        let r = 0, g = 0, b = 0;
        const hues: Record<number, number> = {};
        for (let i = 0; i < d.length; i += 4) {
          r += d[i]; g += d[i + 1]; b += d[i + 2];
          const mx = Math.max(d[i], d[i + 1], d[i + 2]);
          const mn = Math.min(d[i], d[i + 1], d[i + 2]);
          const l = (mx + mn) / 2 / 255;
          if (mx - mn > 30 && l > 0.15 && l < 0.85) {
            let h = 0;
            const df = mx - mn;
            if (mx === d[i]) h = ((d[i + 1] - d[i + 2]) / df) % 6;
            else if (mx === d[i + 1]) h = (d[i + 2] - d[i]) / df + 2;
            else h = (d[i] - d[i + 1]) / df + 4;
            h = Math.round((((h * 60) + 360) % 360) / 20) * 20;
            hues[h] = (hues[h] || 0) + 1;
          }
        }
        resolve(((r / d.length) * 0.299 + (g / d.length) * 0.587 + (b / d.length) * 0.114) / 255);
        void hues;
      };
      img.src = dataUrl;
    });
    setOutTheme((t) => ({
      ...t,
      bgKind: "image",
      image: dataUrl,
      overlay: Math.min(0.75, Math.max(0.25, 0.78 - lum)),
      textColor: lum > 0.55 ? "#f8f5ea" : "#f3ecdc",
    }));
    setMicStatus("Theme auto-generated from your image. Fine-tune below.");
  }

  function addNote(bullet: string) {
    addSermonNote(stRef.current, bullet);
  }

  async function showVerse(h: VerseHit, trigger?: string) {
    const ref = h.reference;
    if (ref && ref.verse && ref.end_verse && ref.end_verse > ref.verse) {
      const slides = await invoke<VerseHit[]>("verse_range", {
        book: ref.book,
        chapter: ref.chapter,
        from: ref.verse,
        to: ref.end_verse,
        translation: trIdRef.current,
      });
      if (slides.length > 1) {
        seqRef.current = { slides: slides, idx: 0 };
        await showSeqSlide(0);
        return;
      }
    }
    seqRef.current = null;
    const s = await invoke<Slide>("show_verse", { hit: h });
    setSlide(s);
    slideRef.current = s;
    lastVerse.current = h;
    verseShownAt.current = Date.now();
    const lastHist = historyRef.current[historyRef.current.length - 1];
    if (!lastHist || lastHist.label !== h.label) {
      historyRef.current.push({ label: h.label, hit: h });
      if (historyRef.current.length > 12) historyRef.current.shift();
    }
    logVerse(stRef.current, h.label, h.text, trigger);
  }

  async function showSeqSlide(idx: number) {
    const seqr = seqRef.current;
    if (!seqr) return;
    seqr.idx = Math.max(0, Math.min(idx, seqr.slides.length - 1));
    const h = seqr.slides[seqr.idx];
    followRef.current = {
      words: [],
      skipSeg: partialRef.current.seg,
      skipCount: contentWords(partialRef.current.text).length,
    };
    const s = await invoke<Slide>("show_verse", { hit: h });
    setSlide(s);
    slideRef.current = s;
    lastVerse.current = h;
    verseShownAt.current = Date.now();
    addNote(h.label + " — " + trimWords(h.text, 12));
  }

  async function nextVerse() {
    const seqr = seqRef.current;
    if (seqr && seqr.idx < seqr.slides.length - 1) {
      await showSeqSlide(seqr.idx + 1);
      return;
    }
    const ref = lastVerse.current?.reference;
    if (!ref) return;
    const cur = seqr ? seqr.slides[seqr.idx].reference : ref;
    if (!cur || !cur.verse) return;
    const nxt = await invoke<VerseHit | null>("verse_at", {
      book: cur.book,
      chapter: cur.chapter,
      verse: cur.verse + 1,
      translation: trIdRef.current,
    });
    if (nxt) {
      seqRef.current = null;
      await showVerse(nxt, "");
    } else {
      setMicStatus("End of chapter reached.");
    }
  }

  async function prevVerse() {
    const seqr = seqRef.current;
    if (seqr && seqr.idx > 0) {
      await showSeqSlide(seqr.idx - 1);
      return;
    }
    const cur = lastVerse.current?.reference;
    if (!cur || !cur.verse || cur.verse <= 1) return;
    const prv = await invoke<VerseHit | null>("verse_at", {
      book: cur.book,
      chapter: cur.chapter,
      verse: cur.verse - 1,
      translation: trIdRef.current,
    });
    if (prv) {
      seqRef.current = null;
      await showVerse(prv, "");
    }
  }

  function extractSermonStructure(text: string) {
    const msgs = extractStructure(stRef.current, text);
    if (msgs.length) {
      setMicStatus(msgs[msgs.length - 1]);
      sync();
    }
  }

  function buildSummary(): SummaryData {
    return buildSermonSummary(stRef.current);
  }

  function sermonTitle(): string {
    return titleFor(stRef.current, transcriptRef.current.map((l) => l.text));
  }

  async function emitSummary() {
    const data = buildSummary();
    if (!data.points.length) {
      setMicStatus("Nothing to summarize yet.");
      return;
    }
    const s = await invoke<Slide>("show_slide", {
      kind: "summary",
      title: sermonTitle(),
      body: JSON.stringify(data),
      sub: "live",
    });
    setSlide(s);
    slideRef.current = s;
  }

  async function refreshMics() {
    try {
      const devs = await invoke<string[]>("list_audio_inputs");
      setMics(devs);
    } catch (e) {
      console.error(e);
    }
  }

  async function refreshTranslations() {
    try {
      const ts = await invoke<TranslationInfo[]>("list_translations");
      setTranslations(ts);
      translationsRef.current = ts;
    } catch (e) {
      console.error(e);
    }
  }

  function changeTr(id: string) {
    setTrId(id);
    trIdRef.current = id;
  }

  async function importFile(f: File) {
    try {
      const content = await f.text();
      const info = await invoke<TranslationInfo>("import_translation", {
        content: content,
        filename: f.name,
      });
      await refreshTranslations();
      changeTr(info.id);
      setMicStatus("Translation loaded: " + info.name);
    } catch (e: any) {
      setMicStatus("Import failed: " + String(e).replace(/^Error:\s*/, ""));
    }
  }

  function openLink(url: string) {
    void invoke("open_url", { url: url });
  }

  async function loadModel() {
    setModelStatus("downloading…");
    await invoke("ensure_model", { model: model });
  }

  async function toggleListen() {
    if (listeningRef.current) {
      listeningRef.current = false;
      setListening(false);
      await invoke("stop_listening");
      setMicStatus("Stopped.");
      return;
    }
    try {
      await invoke("reset_live");
      const r = await invoke<string>("start_listening", { device: micId || null, model: model });
      listeningRef.current = true;
      setListening(true);
      if (r === "already") setMicStatus("Already listening.");
      else setMicStatus("Listening natively · verse shows instantly, holds 60 s");
      void loadQuoteIndex();
    } catch (e: any) {
      setMicStatus(String(e).replace(/^Error:\s*/, ""));
    }
  }

  async function show(h: VerseHit) {
    await showVerse(h, "");
  }

  function copyNotes() {
    const srm = stRef.current;
    let out = "";
    if (srm.title) out += "Title: " + srm.title + "\n\n";
    if (srm.points.length) {
      out +=
        "Outline\n" +
        srm.points
          .map((p) => {
            const vs = stRef.current.verseLog.filter((v) => v.pointNum === p.num).map((v) => v.label);
            return p.num + ". " + p.text + (vs.length ? "\n   " + vs.join(" · ") : "");
          })
          .join("\n") +
        "\n\n";
    }
    out += stRef.current.notes.map((n, i) => (i + 1) + ". " + n).join("\n");
    navigator.clipboard
      .writeText(out)
      .then(() => setMicStatus("Notes and outline copied to clipboard."))
      .catch(() => setMicStatus("Copy failed."));
  }

  useEffect(() => {
    const subs = [
      listen<{ text: string; ms: number; seg: number }>("transcript", (e) =>
        onTranscript(e.payload.text, e.payload.ms, e.payload.seg)
      ),
      listen<{ text: string; ms: number; seg: number }>("transcript-partial", (e) =>
        onPartial(e.payload.text, e.payload.ms, e.payload.seg)
      ),
      listen<number>("level", (e) => {
        const pct = Math.min(100, Math.round(e.payload * 900));
        setMicLevelPct((prev) => (Math.abs(prev - pct) >= 3 ? pct : prev));
      }),
      listen<any>("model-progress", (e) => {
        const p = e.payload;
        if (p.status === "progress" && p.total) {
          setModelStatus("downloading " + Math.round(p.loaded / 1048576) + " / " + Math.round(p.total / 1048576) + " MB");
        } else if (p.status) {
          setModelStatus(p.status);
        }
      }),
      listen<string>("model-ready", (e) => setModelStatus("ready · " + e.payload + " (native)")),
      listen<string>("listen-status", (e) => setMicStatus(e.payload)),
    ];
    refreshMics();
    refreshTranslations();
    inputRef.current?.focus();
    return () => {
      subs.forEach((u) => u.then((f) => f()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      const due = cardsRef.current.filter((c) => c.status === "pending" && now >= c.fireAt);
      if (due.length) {
        due.forEach((c) => {
          c.status = "done";
          void showVerse(c.hit, c.trigger);
        });
        cardsRef.current = cardsRef.current.filter((c) => c.status !== "done");
        sync();
      }
      if (
        slideRef.current &&
        slideRef.current.kind === "verse" &&
        verseShownAt.current &&
        now - verseShownAt.current > VERSE_HOLD_MS
      ) {
        void emitSummary();
      }
    }, 200);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadQuoteIndex() {
    if (indexLoadedRef.current) return;
    indexLoadedRef.current = true;
    try {
      const meta = await fetch("verse-index.json").then((r) => {
        if (!r.ok) throw new Error("missing");
        return r.json();
      });
      const buf = await fetch("verse-index.bin").then((r) => {
        if (!r.ok) throw new Error("missing");
        return r.arrayBuffer();
      });
      quoteIndexRef.current = { vecs: new Float32Array(buf), refs: meta.refs };
      setQuoteStatus("ready · " + meta.count + " verses");
    } catch (e) {
      indexLoadedRef.current = false;
      setQuoteStatus("index missing — run scripts/verse-index");
    }
  }

  async function quoteCheck(text: string) {
    const idx = quoteIndexRef.current;
    if (!idx || quoteBusy.current) return;
    const words = text.trim().split(/\s+/).length;
    if (words < 6) return;
    quoteBusy.current = true;
    try {
      const q = await Embedder.embed(cleanText(text));
      let best = -1;
      let bestS = 0;
      const n = idx.refs.length;
      for (let i = 0; i < n; i++) {
        let dot = 0;
        const off = i * 384;
        for (let k = 0; k < 384; k++) dot += q[k] * idx.vecs[off + k];
        if (dot > bestS) {
          bestS = dot;
          best = i;
        }
      }
      if (best >= 0 && bestS >= QUOTE_THRESHOLD) {
        const r = idx.refs[best];
        const hit = await invoke<VerseHit | null>("verse_at", {
          book: r[0],
          chapter: r[1],
          verse: r[2],
          translation: trIdRef.current,
        });
        const now = Date.now();
        if (hit) {
          const label = hit.label;
          if (
            !(shownRef.current[label] && now - shownRef.current[label] < 180000) &&
            !cardsRef.current.some((c) => c.label === label && c.status === "pending")
          ) {
            shownRef.current[label] = now;
            cardsRef.current.push({
              id: seq.current++,
              label: label,
              hit: hit,
              trigger: trimWords(text, 10),
              kind: "quote",
              fireAt: now + FIRE_DELAY,
              status: "pending",
            });
            sync();
          }
        }
      }
    } catch (e) {
      /* embedding unavailable; ignore */
    } finally {
      quoteBusy.current = false;
    }
  }

  async function detect(text: string, line: TrLine) {
    let found: VerseHit[] = [];
    try {
      found = await invoke<VerseHit[]>("lookup_live", { input: text, translation: trIdRef.current, commit: true });
    } catch (e) {
      console.error(e);
      return;
    }
    queueHits(found, line);
  }

  function queueHits(found: VerseHit[], line: TrLine) {
    const now = Date.now();
    for (const h of found) {
      const last = shownRef.current[h.label];
      if (last && now - last < 180000) continue;
      if (cardsRef.current.some((c) => c.label === h.label && c.status === "pending")) continue;
      shownRef.current[h.label] = now;
      line.labels.push(h.label);
      cardsRef.current.push({
        id: seq.current++,
        label: h.label,
        hit: h,
        trigger: line.text,
        kind: "ref",
        fireAt: now + FIRE_DELAY,
        status: "pending",
      });
    }
    if (found.length) sync();
  }

  function commitLine(text: string, carried: string[] = []) {
    const cleaned = cleanText(text);
    if (!cleaned || isJunk(cleaned)) return;
    extractSermonStructure(cleaned);
    // Verses already fired from this segment's partials belong to this line.
    const line: TrLine = { text: cleaned, labels: carried.slice() };
    transcriptRef.current.push(line);
    if (transcriptRef.current.length > 200) transcriptRef.current.shift();
    noteFromLine(stRef.current, cleaned);
    sync();
    void detect(cleaned, line);
    void loadQuoteIndex().then(() => quoteCheck(cleaned));
  }

  function matchCommand(text: string): boolean {
    const norm = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    const now = Date.now();
    const jump = norm.match(/(?:jump|go|skip|fast forward)\s+to\s+verse\s+(\d{1,3})/);
    if (jump) {
      if (now - lastCmdAt.current < 1200) return true;
      lastCmdAt.current = now;
      const ref = lastVerse.current?.reference;
      if (!ref) {
        setMicStatus("Show a verse first, then jump within that chapter.");
        return true;
      }
      const n = parseInt(jump[1], 10);
      invoke<VerseHit | null>("verse_at", {
        book: ref.book,
        chapter: ref.chapter,
        verse: n,
        translation: trIdRef.current,
      }).then((hit) => {
        if (hit) {
          seqRef.current = null;
          void showVerse(hit, "");
          setMicStatus("Jumped to " + hit.label);
        } else {
          setMicStatus("Verse " + n + " is out of range for that chapter.");
        }
      });
      return true;
    }
    // A translation request switches the screen but does not consume the
    // sentence: "the Amplified version of John 3:16" still shows John 3:16.
    const want = translationRequest(text);
    if (want && now - lastTrAt.current >= 1500) {
      lastTrAt.current = now;
      const tr = findLoaded(want.code, translationsRef.current);
      if (tr) {
        if (tr.id !== trIdRef.current) void switchTranslation(tr.id, tr.name);
      } else {
        setMicStatus(
          want.name + " is not loaded. Import it in Quick verse; copyrighted translations cannot ship with the app."
        );
      }
    }
    const nextPhrases = ["next verse", "next slide", "next one", "keep going"];
    if (nextPhrases.some((p) => norm.includes(p))) {
      if (now - lastCmdAt.current < 1200) return true;
      lastCmdAt.current = now;
      void nextVerse();
      return true;
    }
    const prevPhrases = ["previous verse", "previous slide", "go back", "last verse", "back one"];
    if (prevPhrases.some((p) => norm.includes(p))) {
      if (now - lastCmdAt.current < 1200) return true;
      lastCmdAt.current = now;
      void prevVerse();
      return true;
    }
    const reshowPhrases = [
      "show the verse again",
      "show that verse again",
      "show it again",
      "show the verse",
      "put the verse back",
      "put it back up",
      "one more time",
    ];
    if (reshowPhrases.some((p) => norm.includes(p))) {
      if (now - lastCmdAt.current < 2000) return true;
      lastCmdAt.current = now;
      if (lastVerse.current) {
        void showVerse(lastVerse.current);
        setMicStatus("Re-showing " + lastVerse.current.label);
      }
      return true;
    }
    return false;
  }

  function tryCorrection(text: string): boolean {
    const ref = lastVerse.current?.reference;
    if (!ref || Date.now() - verseShownAt.current > 30000) return false;
    const norm = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    const cm = Array.from(norm.matchAll(/chapter (\d{1,3})/g));
    const vm = Array.from(norm.matchAll(/verse (\d{1,3})/g));
    if (!cm.length && !vm.length) return false;
    const hasCorrectionWord = /(sorry|correction|i mean|actually|rather|excuse me|oops|not chapter|not verse|my bad)/i.test(norm);
    const residue = norm
      .replace(/chapter \d{1,3}|verse \d{1,3}/g, " ")
      .trim()
      .split(" ")
      .filter((w) => !["sorry","correction","i","mean","actually","rather","excuse","me","not","it","is","was","the","and","no","oops","its","that","said","wait","my","bad","a"].includes(w))
      .length;
    if (!hasCorrectionWord && residue > 0) return false;
    let newChapter = ref.chapter;
    let newVerse = ref.verse || 1;
    if (cm.length) newChapter = parseInt(cm[cm.length - 1][1], 10);
    if (vm.length) newVerse = parseInt(vm[vm.length - 1][1], 10);
    invoke<VerseHit | null>("verse_at", {
      book: ref.book,
      chapter: newChapter,
      verse: newVerse,
    }).then((hit) => {
      if (hit) {
        seqRef.current = null;
        void showVerse(hit);
        setMicStatus("Corrected to " + hit.label);
      } else {
        setMicStatus("That correction is out of range.");
      }
    });
    return true;
  }

  // A partial is the segment so far, re-transcribed every half second while
  // the speaker is still talking. Only chapter:verse hits that appear in two
  // partials in a row fire, so "John 3" on the way to "John 3:16" never shows.
  // Commands and corrections wait for the final transcript.
  async function onPartial(text: string, ms: number, seg: number) {
    const p = partialRef.current;
    if (seg !== p.seg) {
      partialRef.current = { seg, text: "", labels: new Set(), fired: [] };
    }
    const cleaned = cleanText(text);
    partialRef.current.text = cleaned;
    followReading(cleaned, seg);
    diagRef.current = "partial " + ms + " ms · " + trimWords(cleaned, 8);
    sync();
    if (!cleaned || isJunk(cleaned)) return;
    const settled = settleTail(cleaned);
    let found: VerseHit[] = [];
    try {
      found = await invoke<VerseHit[]>("lookup_live", { input: settled, translation: trIdRef.current, commit: false });
    } catch (e) {
      console.error(e);
      return;
    }
    const cur = partialRef.current;
    if (cur.seg !== seg) return;
    const withVerse = found.filter((h) => h.reference && h.reference.verse != null);
    const stable = withVerse.filter((h) => cur.labels.has(h.label));
    cur.labels = new Set(withVerse.map((h) => h.label));
    if (!stable.length) return;
    const line: TrLine = { text: cleaned, labels: [] };
    queueHits(stable, line);
    for (const lb of line.labels) if (!cur.fired.includes(lb)) cur.fired.push(lb);
  }

  // While a verse range is on screen, move to the next verse as soon as the
  // preacher has read past the current one, and stop at the end of the range.
  function followReading(partialText: string, seg: number) {
    const seqr = seqRef.current;
    if (!seqr || advancingRef.current || seqr.idx >= seqr.slides.length - 1) return;
    const f = followRef.current;
    let live = contentWords(partialText);
    if (seg === f.skipSeg) live = live.slice(f.skipCount);
    const spoken = f.words.concat(live);
    const cur = seqr.slides[seqr.idx];
    const next = seqr.slides[seqr.idx + 1];
    if (!readPast(spoken, cur.text, next ? next.text : null)) return;
    advancingRef.current = true;
    // A "next verse" said in the same breath must not move a second time.
    lastCmdAt.current = Date.now();
    const n = seqr.idx + 1;
    showSeqSlide(n)
      .then(() =>
        setMicStatus("Following the reading: " + seqr.slides[n].label + " (" + (n + 1) + " of " + seqr.slides.length + ")")
      )
      .catch((e) => console.error(e))
      .finally(() => {
        advancingRef.current = false;
      });
  }

  async function switchTranslation(id: string, name: string) {
    changeTr(id);
    setMicStatus("Translation: " + name);
    const seqr = seqRef.current;
    const shownBefore = lastVerse.current;
    // If a new verse went up while we fetched, it already uses the new
    // translation; do not put the old one back over it.
    const superseded = () => seqRef.current !== seqr || lastVerse.current !== shownBefore;
    const first = seqr?.slides[0].reference;
    const last = seqr?.slides[seqr.slides.length - 1].reference;
    if (seqr && first && last && first.verse && last.verse) {
      const slides = await invoke<VerseHit[]>("verse_range", {
        book: first.book,
        chapter: first.chapter,
        from: first.verse,
        to: last.verse,
        translation: id,
      });
      if (slides.length && !superseded()) {
        seqRef.current = { slides, idx: Math.min(seqr.idx, slides.length - 1) };
        await showSeqSlide(seqRef.current.idx);
      }
      return;
    }
    const ref = lastVerse.current?.reference;
    if (ref) {
      const hit = await invoke<VerseHit | null>("verse_at", {
        book: ref.book,
        chapter: ref.chapter,
        verse: ref.verse || 1,
        translation: id,
      });
      if (hit && !superseded()) {
        seqRef.current = null;
        await showVerse(hit);
      }
    }
  }

  function onTranscript(text: string, ms: number, seg: number = -1) {
    const f = followRef.current;
    let finalWords = contentWords(text);
    if (seg === f.skipSeg) {
      finalWords = finalWords.slice(f.skipCount);
      f.skipSeg = -1;
    }
    f.words.push(...finalWords);
    followReading("", -2);
    const firedFromPartials = partialRef.current.fired;
    partialRef.current = { seg: -1, text: "", labels: new Set(), fired: [] };
    if (!text.trim()) {
      sync();
      return;
    }
    rawRef.current.push(text);
    if (rawRef.current.length > 60) rawRef.current.shift();
    diagRef.current = "native " + ms + " ms · " + trimWords(text, 8);
    if (isJunk(text)) {
      sync();
      return;
    }
    if (matchCommand(text)) {
      sync();
      return;
    }
    if (tryCorrection(text)) {
      sync();
      return;
    }
    commitLine(text, firedFromPartials);
  }

  async function onQuery(v: string, setQ2: (s: string) => void, setHits2: (h: VerseHit[]) => void) {
    setQ2(v);
    if (v.trim().length === 0) {
      setHits2([]);
      return;
    }
    try {
      const r = await invoke<VerseHit[]>("lookup", { input: v, translation: trIdRef.current });
      setHits2(r);
    } catch (e) {
      console.error(e);
    }
  }

  function slideBg(t: OutputTheme): any {
    if (t.bgKind === "image" && t.image) {
      return {
        backgroundImage: "url(" + t.image + ")",
        backgroundSize: "cover",
        backgroundPosition: "center",
      };
    }
    return { background: t.gradient };
  }

  function overlayEl(t: OutputTheme) {
    if (t.bgKind === "image" && t.overlay > 0) {
      return <div style={{ position: "absolute", inset: 0, background: "rgba(5,8,14," + t.overlay + ")" }} />;
    }
    return null;
  }

  const now = Date.now();
  const preview = slide ? (
    slide.kind === "summary" ? (
      renderSummary(slide, outTheme)
    ) : (
      <div className="slide verse" style={slideBg(outTheme)}>
        {overlayEl(outTheme)}
        <span className="vlogo" style={{ position: "absolute", zIndex: 1 }}>AMC CHURCH</span>
        <div
          className={"vtxt " + sizeClass(slide.body)}
          style={{ color: outTheme.textColor, fontFamily: outTheme.font === "sans" ? "inherit" : undefined, position: "relative", zIndex: 1 }}
        >
          {slide.body}
        </div>
        <div className="vref" style={{ color: outTheme.accent, position: "relative", zIndex: 1 }}>
          {slide.title} · {slide.sub}
        </div>
      </div>
    )
  ) : (
    <div className="slide idle">
      <div className="spsub">Nothing on screen yet</div>
    </div>
  );

  return (
    <div className="console">
      <header className="top">
        <div className="brandblock">
          <span className="brand">AGENT HSP</span>
          <span className="tag">desktop · native</span>
        </div>
        <div className="group">
          <button className={"btn" + (view === "console" ? " on" : "")} onClick={() => setView("console")}>
            Console
          </button>
          <button className={"btn" + (view === "theme" ? " on" : "")} onClick={() => setView("theme")}>
            Theme
          </button>
          <button className={"btn" + (view === "downloads" ? " on" : "")} onClick={() => setView("downloads")}>
            Downloads
          </button>
        </div>
        {view === "console" && (
          <>
            <div className="group">
              <span className="grouplabel">Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="tiny.en">Whisper tiny.en (75 MB, fast)</option>
            <option value="base.en">Whisper base.en (142 MB, better)</option>
            <option value="small.en">Whisper small.en (466 MB, best)</option>
          </select>
          <button className="btn" onClick={loadModel}>
            Load model
          </button>
          <span className="chip">{modelStatus}</span>
          <span className="chip" title="Quote matching index">
            quotes: {quoteStatus}
          </span>
        </div>
        <div className="group">
          <span className="grouplabel">Input</span>
          <select value={micId} onChange={(e) => setMicId(e.target.value)}>
            <option value="">Default input</option>
            {mics.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="group grow" />
        <div className="group">
          <button className="btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
          <span className={"chip " + (listening ? "live" : "")}>{listening ? "LISTENING" : "IDLE"}</span>
          <span className="level">
            <span className="track">
              <span className="fill" style={{ width: micLevelPct + "%" }} />
            </span>
          </span>
          <button className="btn gold" onClick={toggleListen}>
            {listening ? "Stop" : "Listen"}
          </button>
            </div>
          </>
        )}
      </header>
      {view === "downloads" ? (
        <div className="downloads">          <div className="dl-section">
            <div className="tiny">Bible translations (XML files)</div>
            <p className="sub">
              Download a Bible in Zefania, OpenSong or OSIS XML format, then click Import to
              load it here. Bundled already: KJV, ASV, WEB, BBE. You are responsible for having
              the rights to use the files you import; copyrighted translations may not be
              redistributed with the app.
            </p>
            <div className="linkgrid">
              <div className="linkcard">
                <b>Zefania XML Bibles</b>
                <span className="sub">Large collection of translations in Zefania XML on SourceForge.</span>
                <button className="btn" onClick={() => openLink("https://sourceforge.net/projects/zefania-sharp/files/Bibles/")}>Open</button>
              </div>
              <div className="linkcard">
                <b>OpenSong Bibles</b>
                <span className="sub">Many translations in OpenSong format from the official site.</span>
                <button className="btn" onClick={() => openLink("https://opensong.org/downloads/")}>Open</button>
              </div>
              <div className="linkcard">
                <b>FreeShow scripture guide</b>
                <span className="sub">Explains formats and where to find Bible files.</span>
                <button className="btn" onClick={() => openLink("https://freeshow.app/docs/scripture")}>Open</button>
              </div>
              <div className="linkcard">
                <b>XML Bible toolkit</b>
                <span className="sub">Community-packaged XML files: ESV, NLT, AMP, NASB, NKJV, Message, NIV.</span>
                <button className="btn" onClick={() => openLink("https://www.garrybjr.com/media-tool-kit-xml-bibles")}>Open</button>
              </div>
            </div>
          </div>
          <div className="dl-section">
            <div className="tiny">Songs and lyrics</div>
            <div className="linkgrid">
              <div className="linkcard">
                <b>CCLI SongSelect</b>
                <span className="sub">The official licensed lyrics source for churches (subscription).</span>
                <button className="btn" onClick={() => openLink("https://songselect.ccli.com")}>Open</button>
              </div>
              <div className="linkcard">
                <b>OpenLyrics</b>
                <span className="sub">Open song format and community song files.</span>
                <button className="btn" onClick={() => openLink("https://openlyrics.org/")}>Open</button>
              </div>
            </div>
          </div>
          <div className="dl-section">
            <div className="tiny">Import here</div>
            <div className="rowbtns">
              <label className="btn gold">
                Import Bible or translation file (.xml / .json)
                <input
                  type="file"
                  accept=".xml,.json"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files && e.target.files[0];
                    if (f) void importFile(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            <div className="sub" id="importStatus">{micStatus}</div>
          </div>
        </div>
      ) : view === "theme" ? (
        <div className="downloads">
          <div className="dl-section">
            <div className="tiny">Background presets</div>
            <div className="swatches">
              {GRADIENTS.map((g, i) => (
                <div
                  key={i}
                  className={"sw" + (outTheme.bgKind === "gradient" && outTheme.gradient === g.css ? " on" : "")}
                  style={{ background: g.css }}
                  title={g.name}
                  onClick={() => setOutTheme({ ...outTheme, bgKind: "gradient", gradient: g.css })}
                />
              ))}
            </div>
            <label className="btn gold">
              Choose background image…
              <input
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files && e.target.files[0];
                  if (f) void applyImage(f);
                  e.target.value = "";
                }}
              />
            </label>
            <div className="sub">
              The theme auto-generates from your image: overlay strength adapts to its brightness, text stays readable, and the accent color picks up the image's dominant tone.
            </div>
          </div>
          <div className="dl-section">
            <div className="tiny">Style</div>
            <div className="row">
              <span className="grouplabel">Overlay</span>
              <input
                type="range"
                min="0"
                max="85"
                value={Math.round(outTheme.overlay * 100)}
                onChange={(e) => setOutTheme({ ...outTheme, overlay: parseInt(e.target.value, 10) / 100 })}
                style={{ width: 220 }}
              />
              <span className="sub">{Math.round(outTheme.overlay * 100)}%</span>
            </div>
            <div className="row">
              <span className="grouplabel">Text</span>
              <button
                className="btn"
                onClick={() =>
                  setOutTheme({ ...outTheme, textColor: outTheme.textColor === "#f3ecdc" ? "#ffffff" : "#f3ecdc" })
                }
              >
                {outTheme.textColor === "#f3ecdc" ? "Warm white" : "Pure white"}
              </button>
              <span className="grouplabel">Font</span>
              <button
                className="btn"
                onClick={() => setOutTheme({ ...outTheme, font: outTheme.font === "serif" ? "sans" : "serif" })}
              >
                {outTheme.font === "serif" ? "Serif" : "Sans"}
              </button>
              <button className="btn" onClick={() => setOutTheme(DEFAULT_THEME)}>
                Reset
              </button>
            </div>
          </div>
          <div className="dl-section">
            <div className="tiny">Live preview · exactly what the output window shows</div>
            <div className="preview">{preview}</div>
          </div>
        </div>
      ) : (
        <>
      <div className="statline">{micStatus || "Speak a reference. It shows instantly, holds 60 s, then the summary takes over. Say \u201Cnext verse\u201D to advance, \u201Cshow the verse again\u201D to bring it back."}</div>
      <div className="cols">
        <div className="pane col-left">
          <div className="rowsp">
            <div className="tiny">Transcript</div>
            <div className="tabs">
              <button
                className={"tab" + (transcriptView === "processed" ? " on" : "")}
                onClick={() => setTranscriptView("processed")}
              >
                Processed
              </button>
              <button
                className={"tab" + (transcriptView === "raw" ? " on" : "")}
                onClick={() => setTranscriptView("raw")}
              >
                Raw
              </button>
            </div>
          </div>
          <div className="transcript">
            {transcriptView === "processed" ? (
              <>
                {transcriptRef.current.slice(-30).map((l, i) => (
                  <div key={i} className={"tr" + (l.labels.length ? " on" : "")}>
                    {l.text}
                    {l.labels.map((lb, j) => (
                      <span key={j} className="chipRef">
                        {lb}
                      </span>
                    ))}
                  </div>
                ))}
                {partialRef.current.text && (
                  <div className="tr dim">{partialRef.current.text}…</div>
                )}
                {transcriptRef.current.length === 0 && !partialRef.current.text && (
                  <div className="sub dim">Speech appears here as it is heard.</div>
                )}
              </>
            ) : (
              <>
                {rawRef.current.slice(-50).map((t, i) => (
                  <div key={i} className={"tr" + (isJunk(t) ? " dim" : "")}>
                    {t}
                  </div>
                ))}
                {rawRef.current.length === 0 && (
                  <div className="sub dim">The unfiltered model output appears here.</div>
                )}
              </>
            )}
          </div>
          <div className="dimline">{diagRef.current || "\u00A0"}</div>
        </div>
        <div className="pane col-center">
          <div className="tiny">Output preview</div>
          <div className="preview">{preview}</div>
          <div className="tiny">Verses · instant show · 60 s hold · then summary</div>
          <div className="cards">
            {cardsRef.current.length === 0 && (
              <div className="sub dim">Detected verses appear here for a moment before they show.</div>
            )}
            {cardsRef.current.map((c) => {
              const pct = Math.max(
                0,
                Math.min(100, (100 * (now - (c.fireAt - FIRE_DELAY))) / FIRE_DELAY)
              );
              return (
                <div key={c.id} className="evcard">
                  <b>{c.label}</b>
                  <span className="chip gold" style={{ marginLeft: 8 }}>
                    {c.kind === "quote" ? "quote" : "reference"}
                  </span>
                  <div className="bar">
                    <i style={{ width: pct + "%" }} />
                  </div>
                  <span className="sub">{trimWords(c.hit.text, 14)}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="pane col-right">
          <div className="tiny">Translation</div>
          <select value={trId} onChange={(e) => changeTr(e.target.value)}>
            {translations.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <div className="rowbtns">
            <label className="btn">
              Import…
              <input
                type="file"
                accept=".json"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files && e.target.files[0];
                  if (f) void importFile(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          <div className="tiny">Quick verse</div>
          <input
            ref={inputRef}
            value={q}
            placeholder="john 3 16 · psalm 91 1-2"
            onChange={(e) => void onQuery(e.target.value, setQ, setHits)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && hits.length > 0) show(hits[0]);
            }}
          />
          <div className="hits">
            {hits.length === 0 && <div className="sub dim">No reference detected yet.</div>}
            {hits.map((h, i) => (
              <div key={h.label + i} className={"hit" + (i === 0 ? " first" : "")} onClick={() => show(h)}>
                <b>{h.label}</b>
                <span className="sub">{trimWords(h.text, 14)}</span>
              </div>
            ))}
          </div>
          <div className="tiny">History · click to show again</div>
          <div className="history">
            {historyRef.current.length === 0 && (
              <div className="sub dim">Shown verses collect here.</div>
            )}
            {historyRef.current
              .slice(-8)
              .reverse()
              .map((h, i) => (
                <div key={h.label + i} className="hit" onClick={() => void showVerse(h.hit)}>
                  <b>{h.label}</b>
                  <span className="sub">{h.hit.translation}</span>
                </div>
              ))}
          </div>
          <div className="tiny">Sermon outline</div>
          {(stRef.current.title || stRef.current.points.length > 0) && (
            <div className="notes">
              {stRef.current.title && <div className="noteline outlinetitle">{stRef.current.title}</div>}
              {stRef.current.points.map((p) => (
                <div key={p.num} className="noteline">
                  {p.num}. {p.text}
                </div>
              ))}
            </div>
          )}
          <div className="tiny">Sermon notes (auto)</div>
          <div className="notes">
            {stRef.current.notes.length === 0 && <div className="sub dim">Key lines and verses collect here.</div>}
            {stRef.current.notes.slice(-8).map((n, i) => (
              <div key={i} className="noteline">
                {n}
              </div>
            ))}
          </div>
          <div className="rowbtns">
            <button className="btn" onClick={copyNotes}>
              Copy notes
            </button>
            <button className="btn" onClick={() => void emitSummary()}>
              Summary now
            </button>
          </div>
        </div>
      </div>
        </>
      )}
    </div>
  );
}

function summaryDensity(slide: Slide): string {
  let data: SummaryData | null = null;
  try {
    data = JSON.parse(slide.body);
  } catch (e) {
    data = null;
  }
  if (!data) return "";
  let chars = 0;
  let count = 0;
  data.points.forEach((p) => {
    count += 1;
    chars += p.text.length + p.verses.length * 9;
  });
  if (count <= 2 && chars < 200) return "compact";
  if (count <= 3 && chars < 420) return "mid";
  return "dense";
}

function renderSummary(slide: Slide, theme: OutputTheme) {
  let data: SummaryData | null = null;
  try {
    data = JSON.parse(slide.body);
  } catch (e) {
    data = null;
  }
  const density = summaryDensity(slide);
  const txtColor = { color: theme.textColor, fontFamily: theme.font === "sans" ? "inherit" : undefined };
  if (data && data.points) {
    return (
      <div className={"slide summary " + density} style={slideBg(theme)}>
        {overlayEl(theme)}
        <div className="sumtitle" style={{ color: theme.accent, position: "relative", zIndex: 1 }}>{slide.title}</div>
        <ol className="points" style={{ position: "relative", zIndex: 1 }}>
          {data.points.map((p, i) => (
            <li key={i}>
              <div className="pointtext" style={txtColor}>{p.text}</div>
              {p.verses.length > 0 && (
                <ul className="subbullets">
                  {p.verses.map((v, j) => (
                    <li key={j} style={{ color: theme.accent }}>{v}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
        <div className="sumsub" style={{ position: "relative", zIndex: 1 }}>{slide.sub}</div>
      </div>
    );
  }
  return (
    <div className={"slide summary " + density} style={slideBg(theme)}>
      {overlayEl(theme)}
      <div className="sumtitle" style={{ color: theme.accent, position: "relative", zIndex: 1 }}>{slide.title}</div>
      <ul className="bullets" style={{ position: "relative", zIndex: 1 }}>
        {slide.body.split("\n").filter((b) => b.trim()).map((b, i) => (
          <li key={i} style={txtColor}>{b}</li>
        ))}
      </ul>
      <div className="sumsub" style={{ position: "relative", zIndex: 1 }}>{slide.sub}</div>
    </div>
  );
}

function slideBg(theme: OutputTheme): any {
  if (theme.bgKind === "image" && theme.image) {
    return {
      backgroundImage: "url(" + theme.image + ")",
      backgroundSize: "cover",
      backgroundPosition: "center",
    };
  }
  return { background: theme.gradient };
}

function overlayEl(theme: OutputTheme) {
  if (theme.bgKind === "image" && theme.overlay > 0) {
    return <div style={{ position: "absolute", inset: 0, background: "rgba(5,8,14," + theme.overlay + ")" }} />;
  }
  return null;
}

function sizeClass(text: string): string {
  if (text.length < 90) return "xl";
  if (text.length < 200) return "lg";
  return "md";
}
