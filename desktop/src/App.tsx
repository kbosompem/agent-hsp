import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
  fireAt: number;
  status: "pending" | "done";
};

type TrLine = { text: string; labels: string[] };

type SummaryData = { points: { text: string; verses: string[] }[] };

type SermonPoint = { num: number; text: string };

const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

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

function cleanText(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trimWords(text: string, n: number): string {
  const w = text.trim().split(/\s+/);
  return w.slice(0, n).join(" ") + (w.length > n ? "…" : "");
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
  const [model, setModel] = useState("tiny.en");
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("preso-theme") as "dark" | "light") || "dark"
  );
  const [transcriptView, setTranscriptView] = useState<"processed" | "raw">("processed");
  const [view, setView] = useState<"console" | "downloads">("console");
  const [trId, setTrId] = useState("kjv");
  const [translations, setTranslations] = useState<TranslationInfo[]>([]);
  const [, setForce] = useState(0);

  const trIdRef = useRef("kjv");
  const translationsRef = useRef<TranslationInfo[]>([]);
  const historyRef = useRef<{ label: string; hit: VerseHit }[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const transcriptRef = useRef<TrLine[]>([]);
  const rawRef = useRef<string[]>([]);
  const cardsRef = useRef<Card[]>([]);
  const notesRef = useRef<string[]>([]);
  const verseLogRef = useRef<{ label: string; line: string; pointNum: number | null }[]>([]);
  const sermonRef = useRef<{ title: string | null; points: SermonPoint[] }>({
    title: null,
    points: [],
  });
  const slideRef = useRef<Slide | null>(null);
  const lastVerse = useRef<VerseHit | null>(null);
  const verseShownAt = useRef(0);
  const seq = useRef(1);
  const shownRef = useRef<Record<string, number>>({});
  const lastCmdAt = useRef(0);
  const diagRef = useRef("");
  const listeningRef = useRef(false);
  const dirtyRef = useRef(false);
  const seqRef = useRef<{ slides: VerseHit[]; idx: number } | null>(null);

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

  function addNote(bullet: string) {
    const b = bullet.trim();
    if (!b) return;
    const last = notesRef.current[notesRef.current.length - 1];
    if (last === b) return;
    notesRef.current.push(b);
    if (notesRef.current.length > 30) notesRef.current.shift();
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
    if (trigger !== undefined) {
      verseLogRef.current.push({
        label: h.label,
        line: trigger,
        pointNum: sermonRef.current.points.length
          ? sermonRef.current.points[sermonRef.current.points.length - 1].num
          : null,
      });
      if (verseLogRef.current.length > 24) verseLogRef.current.shift();
    }
    addNote(h.label + " — " + trimWords(h.text, 12));
  }

  async function showSeqSlide(idx: number) {
    const seqr = seqRef.current;
    if (!seqr) return;
    seqr.idx = Math.max(0, Math.min(idx, seqr.slides.length - 1));
    const h = seqr.slides[seqr.idx];
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
    const tm = text.match(
      /title\s+(?:of\s+(?:my|the|his|her)\s+(?:message|sermon|teaching)\s+)?(?:is|:)\s+(.+)/i
    );
    if (tm) {
      const t = cleanText(tm[1]).replace(/[.!]+$/, "");
      if (t.length >= 3) {
        sermonRef.current.title = t.split(/\s+/).slice(0, 12).join(" ");
        setMicStatus("Sermon title set: " + sermonRef.current.title);
        sync();
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
      const existing = sermonRef.current.points.findIndex((p) => p.num === pt.num);
      if (existing >= 0) sermonRef.current.points[existing] = pt;
      else sermonRef.current.points.push(pt);
      sermonRef.current.points.sort((a, b) => a.num - b.num);
      setMicStatus("Point " + pt.num + " registered: " + pt.text);
      sync();
    }
  }

  function buildSummary(): SummaryData {
    const srm = sermonRef.current;
    if (srm.points.length > 0) {
      return {
        points: srm.points.slice(0, 4).map((p) => ({
          text: p.text,
          verses: verseLogRef.current
            .filter((v) => v.pointNum === p.num)
            .map((v) => v.label)
            .slice(0, 4),
        })),
      };
    }
    const log = verseLogRef.current.slice(-14);
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

  function sermonTitle(): string {
    if (sermonRef.current.title) return sermonRef.current.title;
    const lines = transcriptRef.current.slice(-80);
    for (const l of lines) {
      const m = l.text.match(/(?:this morning|today|the message|the theme|the title|we are (?:looking|talking)|preaching)[^.]{0,90}/i);
      if (m) return trimWords(m[0], 10);
    }
    return "Sermon summary";
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
      const r = await invoke<string>("start_listening", { device: micId || null, model: model });
      listeningRef.current = true;
      setListening(true);
      if (r === "already") setMicStatus("Already listening.");
      else setMicStatus("Listening natively · verse shows instantly, holds 60 s");
    } catch (e: any) {
      setMicStatus(String(e).replace(/^Error:\s*/, ""));
    }
  }

  async function show(h: VerseHit) {
    await showVerse(h, "");
  }

  function copyNotes() {
    const srm = sermonRef.current;
    let out = "";
    if (srm.title) out += "Title: " + srm.title + "\n\n";
    if (srm.points.length) {
      out +=
        "Outline\n" +
        srm.points
          .map((p) => {
            const vs = verseLogRef.current.filter((v) => v.pointNum === p.num).map((v) => v.label);
            return p.num + ". " + p.text + (vs.length ? "\n   " + vs.join(" · ") : "");
          })
          .join("\n") +
        "\n\n";
    }
    out += notesRef.current.map((n, i) => (i + 1) + ". " + n).join("\n");
    navigator.clipboard
      .writeText(out)
      .then(() => setMicStatus("Notes and outline copied to clipboard."))
      .catch(() => setMicStatus("Copy failed."));
  }

  useEffect(() => {
    const subs = [
      listen<{ text: string; ms: number }>("transcript", (e) => onTranscript(e.payload.text, e.payload.ms)),
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

  async function detect(text: string, line: TrLine) {
    let found: VerseHit[] = [];
    try {
      found = await invoke<VerseHit[]>("lookup", { input: text, translation: trIdRef.current });
    } catch (e) {
      console.error(e);
      return;
    }
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
        fireAt: now + FIRE_DELAY,
        status: "pending",
      });
    }
    if (found.length) sync();
  }

  function commitLine(text: string) {
    const cleaned = cleanText(text);
    if (!cleaned || isJunk(cleaned)) return;
    extractSermonStructure(cleaned);
    const line: TrLine = { text: cleaned, labels: [] };
    transcriptRef.current.push(line);
    if (transcriptRef.current.length > 200) transcriptRef.current.shift();
    const words = cleaned.split(/\s+/);
    if (words.length >= 14 && /god|jesus|lord|christ|love|faith|grace|cross|spirit|pray|mercy/i.test(cleaned)) {
      addNote(trimWords(cleaned, 14));
    }
    sync();
    void detect(cleaned, line);
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
    const trMatch = norm.match(/(?:show|read|display) (?:it|that|this) in ([a-z ]{2,20})/);
    if (trMatch) {
      const wanted = trMatch[1].trim();
      const tr = translationsRef.current.find(
        (t) => t.id === wanted || t.name.toLowerCase().includes(wanted) || wanted.includes(t.id)
      );
      if (tr) {
        if (now - lastCmdAt.current < 1500) return true;
        lastCmdAt.current = now;
        setTrId(tr.id);
        trIdRef.current = tr.id;
        const ref = lastVerse.current?.reference;
        if (ref) {
          invoke<VerseHit | null>("verse_at", {
            book: ref.book,
            chapter: ref.chapter,
            verse: ref.verse || 1,
            translation: tr.id,
          }).then((hit) => {
            if (hit) {
              seqRef.current = null;
              void showVerse(hit);
            }
          });
        }
        setMicStatus("Translation: " + tr.name);
      } else {
        setMicStatus("Translation \"" + wanted + "\" is not loaded. Import it in Quick verse.");
      }
      return true;
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

  function onTranscript(text: string, ms: number) {
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
    commitLine(text);
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

  const now = Date.now();
  const preview = slide ? (
    slide.kind === "summary" ? (
      renderSummary(slide)
    ) : (
      <div className="slide verse">
        <span className="vlogo">AMC CHURCH</span>
        <div className={"vtxt " + sizeClass(slide.body)}>{slide.body}</div>
        <div className="vref">
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
          <span className="brand">AMC PRESO</span>
          <span className="tag">desktop · native</span>
        </div>
        <div className="group">
          <button
            className={"btn" + (view === "console" ? " on" : "")}
            onClick={() => setView("console")}
          >
            Console
          </button>
          <button
            className={"btn" + (view === "downloads" ? " on" : "")}
            onClick={() => setView("downloads")}
          >
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
          </select>
          <button className="btn" onClick={loadModel}>
            Load model
          </button>
          <span className="chip">{modelStatus}</span>
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
        <div className="downloads">
          <div className="dl-section">
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
                {transcriptRef.current.length === 0 && (
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
          {(sermonRef.current.title || sermonRef.current.points.length > 0) && (
            <div className="notes">
              {sermonRef.current.title && <div className="noteline outlinetitle">{sermonRef.current.title}</div>}
              {sermonRef.current.points.map((p) => (
                <div key={p.num} className="noteline">
                  {p.num}. {p.text}
                </div>
              ))}
            </div>
          )}
          <div className="tiny">Sermon notes (auto)</div>
          <div className="notes">
            {notesRef.current.length === 0 && <div className="sub dim">Key lines and verses collect here.</div>}
            {notesRef.current.slice(-8).map((n, i) => (
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

function renderSummary(slide: Slide) {
  let data: SummaryData | null = null;
  try {
    data = JSON.parse(slide.body);
  } catch (e) {
    data = null;
  }
  const density = summaryDensity(slide);
  if (data && data.points) {
    return (
      <div className={"slide summary " + density}>
        <div className="sumtitle">{slide.title}</div>
        <ol className="points">
          {data.points.map((p, i) => (
            <li key={i}>
              <div className="pointtext">{p.text}</div>
              {p.verses.length > 0 && (
                <ul className="subbullets">
                  {p.verses.map((v, j) => (
                    <li key={j}>{v}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
        <div className="sumsub">{slide.sub}</div>
      </div>
    );
  }
  return (
    <div className={"slide summary " + density}>
      <div className="sumtitle">{slide.title}</div>
      <ul className="bullets">
        {slide.body.split("\n").filter((b) => b.trim()).map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>
      <div className="sumsub">{slide.sub}</div>
    </div>
  );
}

function sizeClass(text: string): string {
  if (text.length < 90) return "xl";
  if (text.length < 200) return "lg";
  return "md";
}
