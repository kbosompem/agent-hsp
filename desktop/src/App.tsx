import { ReactNode, useEffect, useRef, useState } from "react";
import {
  BookOpen, Copy, Download, ExternalLink, EyeOff, FileText, Hand, Image as ImageIcon, ListOrdered, Mic, Minus,
  MonitorPlay, Palette, Plus, Radio, RotateCcw, Search, Settings2, Square, Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Toaster } from "@/components/ui/sonner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Mode, PRESETS, UiTheme, applyMode, applyTheme, loadTheme, savedMode, savedTheme } from "@/lib/uitheme";
import SlideView, { OutputTheme, Slide } from "./SlideView";
import Backgrounds from "./Backgrounds";
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
import Service, { ServiceNav } from "./Service";
import { AgendaItem, ItemSlide, Library, emptyLibrary, parseLibrary } from "./lib/library";
import { contentWords, findLoaded, hasReferenceWords, readPast, readingOverlap, translationRequest } from "./lib/voice";

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



const GRADIENTS: { name: string; css: string }[] = [
  { name: "Midnight Navy", css: "radial-gradient(120% 95% at 50% 0%, #24314e 0%, #101827 55%, #090d14 100%)" },
  { name: "Deep Gold", css: "radial-gradient(100% 120% at 50% 100%, #3a2f10 0%, #161207 60%, #0a0805 100%)" },
  { name: "Slate", css: "linear-gradient(180deg, #2a3548 0%, #10151f 100%)" },
  { name: "Purple Dawn", css: "linear-gradient(160deg, #2c2050 0%, #0b0f17 100%)" },
  { name: "Forest", css: "linear-gradient(170deg, #12301f 0%, #0a0d13 100%)" },
  { name: "Crimson Night", css: "linear-gradient(200deg, #3a1420 0%, #0c0a10 100%)" },
];

const LAST_SLIDE_KEY = "hsp-last-slide";

const DEFAULT_THEME: OutputTheme = {
  bgKind: "gradient",
  gradient: GRADIENTS[0].css,
  image: "",
  overlay: 0.45,
  textColor: "#f3ecdc",
  accent: "#e9c465",
  font: "serif",
  textScale: 1,
};

// VerseCast's value from real sermon audio; tune on our sermons (issue 15).
const QUOTE_THRESHOLD = 0.62;
// A spoken reference is skipped if shown this recently (or still on screen).
const REF_REPEAT_MS = 30000;
// A quote match is not repeated within this window.
const QUOTE_REPEAT_MS = 180000;

// A spoken reference has already been confirmed by two partials in a row, so
// it goes up at once. Quote matches are less certain and wait so the operator
// can skip them.
const REF_FIRE_DELAY = 0;
const FIRE_DELAY = 600;

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

// What the operator needs to know about transcription right now.
function sttHealth(
  listening: boolean,
  h: { lag: number; error: string; errorAt: number; aliveAt: number; okAt: number },
  now: number
): { label: string; cls: string; detail: string } {
  if (!listening) return { label: "IDLE", cls: "", detail: "Not listening" };
  if (h.error && h.errorAt > h.okAt) {
    return { label: "NOT TRANSCRIBING", cls: "bad", detail: h.error };
  }
  if (now - h.aliveAt > 6000) {
    const s = Math.round((now - h.aliveAt) / 1000);
    return { label: "NOT TRANSCRIBING", cls: "bad", detail: "The speech model has not answered for " + s + " s" };
  }
  if (h.lag > 3) {
    return { label: "BEHIND " + Math.round(h.lag) + " s", cls: "warn", detail: "Transcription trails live audio" };
  }
  return { label: "LISTENING", cls: "live", detail: "Transcription keeping up" };
}

export default function App() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<VerseHit[]>([]);
  const [slide, setSlide] = useState<Slide | null>(null);
  const [listening, setListening] = useState(false);
  const [modelStatus, setModelStatus] = useState("native whisper.cpp · model loaded");
  const [micStatus, setMicStatus] = useState("");
  const [micLevelPct, setMicLevelPct] = useState(0);
  // Transcription health (issue 2): lag behind live audio, last whisper error,
  // and when text or speech was last seen, so a stalled model is never silent.
  const healthRef = useRef({ lag: 0, error: "", errorAt: 0, aliveAt: 0, okAt: 0 });
  const [mics, setMics] = useState<string[]>([]);
  const [micId, setMicId] = useState("");
  // small.en finds the most verses in noisy-room tests; Macs run it on the GPU.
  // Windows runs whisper on the CPU, where base.en is the safer default.
  const [model, setModel] = useState(() => (/Mac/i.test(navigator.userAgent) ? "small.en" : "base.en"));
  const [mode, setMode] = useState<Mode>(savedMode);
  const [uiTheme, setUiTheme] = useState<UiTheme>(savedTheme);
  const [themeInput, setThemeInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [transcriptView, setTranscriptView] = useState<"processed" | "raw">("processed");
  const [view, setView] = useState<"console" | "service" | "theme" | "downloads">("console");
  const viewRef = useRef(view);
  viewRef.current = view;
  // Songs and agendas (lib/library.ts), saved to library.json in the app data folder.
  const [library, setLibraryState] = useState<Library>(emptyLibrary());
  const libLoaded = useRef(false);
  const navRef = useRef<ServiceNav | null>(null);
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
  const outThemeRef = useRef(outTheme);
  outThemeRef.current = outTheme;
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
  // Hold: the AI never changes the projector. Detected verses wait as cards
  // the operator can click. Blackout and Logo turn it on.
  const [held, setHeld] = useState(false);
  const holdRef = useRef(false);
  // The slide that was up before a blackout or logo, to bring back.
  const beforeCover = useRef<Slide | null>(null);
  // Hold as it was before the blackout or logo, restored when it is lifted.
  const holdBeforeCover = useRef(false);
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

  useEffect(() => applyMode(mode), [mode]);
  useEffect(() => applyTheme(uiTheme), [uiTheme]);

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
    // A single verse inside the range on screen: jump there and keep following.
    const seqr = seqRef.current;
    if (seqr && ref && ref.verse && !ref.end_verse) {
      const at = seqr.slides.findIndex(
        (s) => s.reference && s.reference.book === ref.book && s.reference.chapter === ref.chapter && s.reference.verse === ref.verse
      );
      if (at >= 0) {
        await showSeqSlide(at);
        setMicStatus("Following the reading: " + seqr.slides[at].label + " (" + (at + 1) + " of " + seqr.slides.length + ")");
        return;
      }
    }
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

  function setHold(on: boolean) {
    holdRef.current = on;
    setHeld(on);
    // Verses heard during Hold are stale; never flush them onto the screen.
    if (!on) cardsRef.current = cardsRef.current.filter((c) => c.status !== "pending");
    sync();
  }

  // Blackout ("blank") or logo. Pressing the same key again brings back the
  // slide that was up before, and releases Hold.
  async function cover(kind: "blank" | "logo") {
    const cur = slideRef.current;
    if (cur && cur.kind === kind) {
      const back = beforeCover.current;
      beforeCover.current = null;
      setHold(holdBeforeCover.current);
      if (back) {
        const s = await invoke<Slide>("show_slide", { kind: back.kind, title: back.title, body: back.body, sub: back.sub });
        setSlide(s);
        slideRef.current = s;
      }
      setMicStatus(holdBeforeCover.current ? "Back on screen. Hold is still on." : "Back on screen. AI can change the screen again.");
      return;
    }
    if (!cur || (cur.kind !== "blank" && cur.kind !== "logo")) {
      beforeCover.current = cur;
      holdBeforeCover.current = holdRef.current;
    }
    setHold(true);
    const s = await invoke<Slide>("show_slide", { kind, title: "", body: "", sub: "" });
    setSlide(s);
    slideRef.current = s;
    setMicStatus((kind === "blank" ? "Blackout" : "Logo") + " · Hold is on: detected verses wait for you.");
  }

  async function showCard(c: Card) {
    c.status = "done";
    cardsRef.current = cardsRef.current.filter((x) => x.id !== c.id);
    beforeCover.current = null;
    await showVerse(c.hit, c.trigger);
    sync();
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
      const now0 = Date.now();
      healthRef.current = { lag: 0, error: "", errorAt: 0, aliveAt: now0, okAt: now0 };
      const r = await invoke<string>("start_listening", { device: micId || null, model: model });
      listeningRef.current = true;
      // Model loading happens inside start_listening; start the stall clock after it.
      healthRef.current.aliveAt = Date.now();
      setListening(true);
      if (r === "already") setMicStatus("Already listening.");
      else setMicStatus("Listening natively · verses show instantly");
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
      listen<{ lag_s: number; ms: number; error: string | null }>("stt-health", (e) => {
        const h = healthRef.current;
        h.lag = e.payload.lag_s;
        h.aliveAt = Date.now();
        if (e.payload.error) {
          h.error = e.payload.error;
          h.errorAt = h.aliveAt;
        } else {
          h.okAt = h.aliveAt;
        }
      }),
      // The segmenter loop sends this every second between whisper calls; if it
      // stops, whisper is stuck or the thread has died.
      listen("stt-alive", () => {
        healthRef.current.aliveAt = Date.now();
      }),
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
      // A reopened projector window asks for what it should be showing.
      listen("output-ready", () => {
        void emit("output-theme", outThemeRef.current);
        const cur = slideRef.current;
        if (cur) void invoke("show_slide", { kind: cur.kind, title: cur.title, body: cur.body, sub: cur.sub });
      }),
    ];
    refreshMics();
    refreshTranslations();
    inputRef.current?.focus();
    return () => {
      subs.forEach((u) => u.then((f) => f()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Crash recovery (issue 14): remember the slide on screen, and put it back
  // if the console restarts within three hours.
  useEffect(() => {
    try {
      if (slide) localStorage.setItem(LAST_SLIDE_KEY, JSON.stringify({ slide, at: Date.now() }));
    } catch {
      /* storage blocked; recovery just will not happen */
    }
  }, [slide]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LAST_SLIDE_KEY);
      if (!raw) return;
      const { slide: last, at } = JSON.parse(raw) as { slide: Slide; at: number };
      if (!last || Date.now() - at > 3 * 3600 * 1000) return;
      void invoke<Slide>("show_slide", { kind: last.kind, title: last.title, body: last.body, sub: last.sub }).then((s) => {
        setSlide(s);
        slideRef.current = s;
        setMicStatus("Restored the slide that was on screen before the restart.");
      });
    } catch {
      /* nothing to restore */
    }
  }, []);

  useEffect(() => {
    invoke<string>("load_library")
      .then((j) => {
        setLibraryState(parseLibrary(j));
        libLoaded.current = true;
      })
      .catch((e) => {
        // Never overwrite a library we could not read.
        setMicStatus("Could not load the song library: " + String(e));
      });
  }, []);
  useEffect(() => {
    if (!libLoaded.current) return;
    const t = setTimeout(() => {
      invoke("save_library", { json: JSON.stringify(library) }).catch((e) =>
        setMicStatus("Could not save the song library: " + String(e))
      );
    }, 400);
    return () => clearTimeout(t);
  }, [library]);

  async function showItemSlide(it: ItemSlide) {
    beforeCover.current = null;
    seqRef.current = null;
    let s: Slide;
    if (it.hit) {
      const h = it.hit as VerseHit;
      s = await invoke<Slide>("show_verse", { hit: h });
      lastVerse.current = h;
      verseShownAt.current = Date.now();
    } else {
      s = await invoke<Slide>("show_slide", { kind: it.kind, title: it.title, body: it.body, sub: it.sub });
    }
    setSlide(s);
    slideRef.current = s;
  }

  async function scriptureSlides(reference: string): Promise<ItemSlide[]> {
    const found = await invoke<VerseHit[]>("lookup", { input: reference, translation: trIdRef.current });
    const h = found.find((x) => x.reference);
    const r = h?.reference;
    if (!h || !r) return [];
    let hits: VerseHit[] = [];
    if (r.verse != null && r.end_verse != null) {
      hits = await invoke<VerseHit[]>("verse_range", {
        book: r.book, chapter: r.chapter, from: r.verse, to: r.end_verse, translation: trIdRef.current,
      });
    } else if (r.verse != null) {
      hits = [h];
    } else {
      // A whole chapter: one slide per verse.
      for (let v = 1; v <= 200; v++) {
        const x = await invoke<VerseHit | null>("verse_at", { book: r.book, chapter: r.chapter, verse: v, translation: trIdRef.current });
        if (!x) break;
        hits.push(x);
      }
    }
    return hits.map((x) => ({ kind: "verse", title: x.label, body: x.text, sub: x.translation, label: x.label, hit: x }));
  }

  // Going live on an agenda item. Only a sermon lets the AI change the screen.
  function enterItem(it: AgendaItem) {
    if (it.kind === "sermon") {
      setHold(false);
      if (!listeningRef.current) void toggleListen();
      setMicStatus("Sermon: listening, verses go on screen as they are named.");
    } else {
      setHold(true);
    }
  }

  // Live keys. Ignored while typing in a field.
  //   B blackout · L logo · H hold · Esc clear to logo · Right/Left next/previous verse
  //   Enter shows the oldest waiting card
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === "b" || k === "B") void cover("blank");
    else if (k === "l" || k === "L") void cover("logo");
    else if (k === "Escape") {
      if (slideRef.current?.kind !== "logo") void cover("logo");
    } else if (k === "h" || k === "H") {
      setHold(!holdRef.current);
      setMicStatus(holdRef.current ? "Hold is on: detected verses wait for you." : "Hold off: verses show as they are heard.");
    } else if (k === "ArrowRight" || k === "PageDown") {
      if (viewRef.current === "service" && navRef.current) navRef.current.next();
      else void nextVerse();
    } else if (k === "ArrowLeft" || k === "PageUp") {
      if (viewRef.current === "service" && navRef.current) navRef.current.prev();
      else void prevVerse();
    }
    else if (k === "Enter") {
      const c = cardsRef.current.find((x) => x.status === "pending");
      if (c) void showCard(c);
    } else return;
    e.preventDefault();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // Keep the transcription status chip current even when nothing else changes.
  useEffect(() => {
    if (!listening) return;
    const t = setInterval(() => setForce((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [listening]);

  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      const due = holdRef.current
        ? []
        : cardsRef.current.filter((c) => c.status === "pending" && now >= c.fireAt);
      if (due.length) {
        due.forEach((c) => {
          c.status = "done";
          void showVerse(c.hit, c.trigger);
        });
        cardsRef.current = cardsRef.current.filter((c) => c.status !== "done");
        sync();
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

  // Quote matching must never interrupt scripture being read: not while a
  // range is up, and not when the line is the verse on screen read aloud.
  function readingInProgress(text: string): boolean {
    const onScreen = !!slideRef.current && slideRef.current.kind === "verse";
    if (!onScreen) return false;
    if (seqRef.current) return true;
    const cur = lastVerse.current;
    return !!cur && readingOverlap(text, cur.text) >= 0.3;
  }

  async function quoteCheck(text: string) {
    const idx = quoteIndexRef.current;
    if (!idx || quoteBusy.current) return;
    if (readingInProgress(text)) return;
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
            !(shownRef.current[label] && now - shownRef.current[label] < QUOTE_REPEAT_MS) &&
            !readingInProgress(text) &&
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
    // "Turn to Mark 2" opens the chapter for "verse 5 says" (lookup_live has
    // already moved the context) but puts nothing on screen: these were often
    // misheard or never read (issue 1).
    queueHits(found.filter((h) => !h.reference || h.reference.verse != null), line);
  }

  function queueHits(found: VerseHit[], line: TrLine) {
    const now = Date.now();
    for (const h of found) {
      const last = shownRef.current[h.label];
      if (last && now - last < REF_REPEAT_MS) continue;
      if (lastVerse.current && lastVerse.current.label === h.label && slideRef.current?.kind === "verse") continue;
      if (cardsRef.current.some((c) => c.label === h.label && c.status === "pending")) continue;
      shownRef.current[h.label] = now;
      line.labels.push(h.label);
      // Under Hold cards pile up; keep the newest few.
      if (cardsRef.current.length >= 8) cardsRef.current.shift();
      cardsRef.current.push({
        id: seq.current++,
        label: h.label,
        hit: h,
        trigger: line.text,
        kind: "ref",
        fireAt: now + REF_FIRE_DELAY,
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
    // Navigation phrases yield to a reference in the same sentence.
    const navOnly = !hasReferenceWords(norm);
    const nextPhrases = ["next verse", "next slide", "next one", "keep going"];
    if (navOnly && nextPhrases.some((p) => norm.includes(p))) {
      if (now - lastCmdAt.current < 1200) return true;
      lastCmdAt.current = now;
      void nextVerse();
      return true;
    }
    const prevPhrases = ["previous verse", "previous slide", "go back", "last verse", "back one"];
    if (navOnly && prevPhrases.some((p) => norm.includes(p))) {
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
    if (navOnly && reshowPhrases.some((p) => norm.includes(p))) {
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
    if (holdRef.current) return;
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
    if (!holdRef.current && matchCommand(text)) {
      sync();
      return;
    }
    if (!holdRef.current && tryCorrection(text)) {
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

  function bumpText(d: number) {
    setOutTheme((t) => ({ ...t, textScale: Math.min(2.2, Math.max(0.6, Math.round(((t.textScale ?? 1) + d) * 10) / 10)) }));
  }

  const now = Date.now();
  const preview = <SlideView slide={slide} theme={outTheme} idle="Nothing on screen" />;
  const hs = sttHealth(listening, healthRef.current, now);
  const textPct = Math.round((outTheme.textScale ?? 1) * 100);

  const coverButtons = (
    <div className="grid grid-cols-3 gap-2">
      <Button
        size="lg"
        variant={slide?.kind === "blank" ? "default" : "secondary"}
        onClick={() => void cover("blank")}
        title="B"
      >
        <EyeOff /> Blackout <Kbd>B</Kbd>
      </Button>
      <Button
        size="lg"
        variant={slide?.kind === "logo" ? "default" : "secondary"}
        onClick={() => void cover("logo")}
        title="L or Esc"
      >
        <ImageIcon /> Logo <Kbd>L</Kbd>
      </Button>
      <Button size="lg" variant={held ? "default" : "secondary"} onClick={() => setHold(!holdRef.current)} title="H">
        <Hand /> {held ? "Holding" : "Hold"} <Kbd>H</Kbd>
      </Button>
    </div>
  );

  const liveScreen = (
    <div className="relative">
      <div className="aspect-video w-full overflow-hidden rounded-lg border bg-black shadow-sm">
        <div className="relative h-full w-full">{preview}</div>
      </div>
      <Badge className="absolute left-2 top-2 bg-live text-live-foreground">LIVE</Badge>
      <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-black/50 p-0.5 text-white">
        <Button size="icon" variant="ghost" className="size-7 text-white hover:bg-white/15 hover:text-white" title="Smaller text" onClick={() => bumpText(-0.1)}>
          <Minus />
        </Button>
        <span className="w-10 text-center text-xs tabular-nums">{textPct}%</span>
        <Button size="icon" variant="ghost" className="size-7 text-white hover:bg-white/15 hover:text-white" title="Bigger text" onClick={() => bumpText(0.1)}>
          <Plus />
        </Button>
      </div>
    </div>
  );

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4">
          <div className="flex items-center gap-2 pr-2">
            <div className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
              <Radio className="size-4" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-wide">Agent HSP</div>
              <div className="text-[11px] text-muted-foreground">High Speed Projection</div>
            </div>
          </div>
          <Tabs value={view} onValueChange={(v) => setView(v as typeof view)}>
            <TabsList>
              <TabsTrigger value="console"><MonitorPlay /> Live</TabsTrigger>
              <TabsTrigger value="service"><ListOrdered /> Service</TabsTrigger>
              <TabsTrigger value="theme"><Palette /> Look</TabsTrigger>
              <TabsTrigger value="downloads"><BookOpen /> Bibles</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex-1" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className={cn(
                  "h-7 gap-1.5 px-2.5",
                  hs.cls === "live" && "border-live/50 text-live",
                  hs.cls === "warn" && "border-warning/60 text-warning",
                  hs.cls === "bad" && "border-destructive bg-destructive text-white"
                )}
              >
                <span className={cn("size-2 rounded-full bg-current", hs.cls === "live" && "animate-pulse")} />
                {hs.label}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{hs.detail}</TooltipContent>
          </Tooltip>
          <div className="flex h-7 w-24 items-center rounded-md border px-1.5" title="Input level">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-live transition-[width] duration-150" style={{ width: micLevelPct + "%" }} />
            </div>
          </div>
          <Button variant="outline" size="icon" onClick={() => setSettingsOpen(true)} title="Speech model, audio input and console look">
            <Settings2 />
          </Button>
          <Button onClick={toggleListen} className={cn("w-28", listening && "bg-destructive text-white hover:bg-destructive/90")}>
            {listening ? <><Square /> Stop</> : <><Mic /> Listen</>}
          </Button>
        </header>

        <div className="flex h-8 shrink-0 items-center border-b bg-muted/40 px-4 text-xs text-muted-foreground">
          <span className="truncate">
            {micStatus ||
              (view === "service"
                ? "Build the order of service, then run it: → or Page Down moves through every slide."
                : "Speak a reference and it shows at once. Say “next verse” to advance. B blackout · L logo · H hold.")}
          </span>
        </div>

        <main className="min-h-0 flex-1 p-3">
          {view === "service" ? (
            <Service
              library={library}
              setLibrary={setLibraryState}
              live={liveScreen}
              liveControls={coverButtons}
              theme={outTheme}
              showSlide={showItemSlide}
              scriptureSlides={scriptureSlides}
              onEnterItem={enterItem}
              registerNav={(n) => {
                navRef.current = n;
              }}
              setStatus={setMicStatus}
            />
          ) : view === "downloads" ? (
            <ScrollArea className="h-full">
              <div className="mx-auto flex max-w-4xl flex-col gap-4 p-1">
                <Panel title="Bible translations">
                  <p className="text-sm text-muted-foreground">
                    Bundled: KJV, ASV, WEB and BBE, which are public domain. Import any other translation as Zefania,
                    OpenSong or OSIS XML, or our JSON.
                  </p>
                  <div className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
                    <b>Copyrighted translations need a licence.</b> NLT, NIV, ESV, NASB, NKJV, AMP, The Message and most
                    modern translations are owned by their publishers. Import one only after your church has a licence
                    from the owner that covers projection (for example through the publisher or CCLI). Agent HSP does
                    not ship or download them.
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <LinkCard title="Zefania XML Bibles" sub="Public-domain and open translations in Zefania XML." onOpen={() => openLink("https://sourceforge.net/projects/zefania-sharp/files/Bibles/")} />
                    <LinkCard title="OpenSong Bibles" sub="Translations in OpenSong format." onOpen={() => openLink("https://opensong.org/downloads/")} />
                    <LinkCard title="Scripture formats guide" sub="Explains the file formats and where to find them." onOpen={() => openLink("https://freeshow.app/docs/scripture")} />
                  </div>
                  <div className="flex items-center gap-3">
                    <Button asChild>
                      <label>
                        <Upload /> Import translation (.xml / .json)
                        <input
                          type="file"
                          accept=".xml,.json"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files && e.target.files[0];
                            if (f) void importFile(f);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    </Button>
                    <span className="text-sm text-muted-foreground">Loaded: {translations.map((t) => t.name).join(", ")}</span>
                  </div>
                </Panel>
                <Panel title="Songs and lyrics">
                  <p className="text-sm text-muted-foreground">
                    Import songs on the Service page (VideoPsalm, OpenLyrics, OpenSong or plain text). Showing song
                    lyrics in church usually needs a CCLI licence.
                  </p>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <LinkCard title="CCLI SongSelect" sub="Licensed lyrics for churches (subscription)." onOpen={() => openLink("https://songselect.ccli.com")} />
                    <LinkCard title="OpenLyrics" sub="Open song format and community files." onOpen={() => openLink("https://openlyrics.org/")} />
                  </div>
                </Panel>
              </div>
            </ScrollArea>
          ) : view === "theme" ? (
            <div className="grid h-full min-h-0 grid-cols-[minmax(320px,420px)_1fr] gap-3">
              <ScrollArea className="h-full rounded-lg border bg-card">
                <div className="flex flex-col gap-5 p-4">
                  <Section label="Background">
                    <div className="grid grid-cols-6 gap-2">
                      {GRADIENTS.map((g, i) => (
                        <button
                          key={i}
                          title={g.name}
                          className={cn(
                            "aspect-video rounded-md border-2 border-transparent",
                            outTheme.bgKind === "gradient" && outTheme.gradient === g.css && "border-primary"
                          )}
                          style={{ background: g.css }}
                          onClick={() => setOutTheme({ ...outTheme, bgKind: "gradient", gradient: g.css })}
                        />
                      ))}
                    </div>
                    <Button variant="secondary" asChild>
                      <label>
                        <ImageIcon /> Use my own picture…
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files && e.target.files[0];
                            if (f) void applyImage(f);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      The text colour and dimming adjust to the picture so verses stay readable.
                    </p>
                  </Section>
                  <Backgrounds theme={outTheme} setTheme={setOutTheme} setStatus={setMicStatus} />
                  <Section label={"Dim the background · " + Math.round(outTheme.overlay * 100) + "%"}>
                    <Slider min={0} max={85} value={[Math.round(outTheme.overlay * 100)]} onValueChange={(v) => setOutTheme({ ...outTheme, overlay: v[0] / 100 })} />
                  </Section>
                  <Section label={"Text size · " + textPct + "%"}>
                    <Slider min={60} max={220} step={5} value={[textPct]} onValueChange={(v) => setOutTheme({ ...outTheme, textScale: v[0] / 100 })} />
                  </Section>
                  <Section label="Church name">
                    <Input value={outTheme.churchName ?? ""} placeholder="AMC CHURCH" onChange={(e) => setOutTheme({ ...outTheme, churchName: e.target.value })} />
                    <p className="text-xs text-muted-foreground">Shown in the corner of verses and on the logo screen.</p>
                  </Section>
                  <Section label="Lettering">
                    <div className="flex flex-wrap gap-2">
                      <ToggleGroup type="single" variant="outline" value={outTheme.font} onValueChange={(v) => v && setOutTheme({ ...outTheme, font: v as "serif" | "sans" })}>
                        <ToggleGroupItem value="serif" className="px-3 font-serif">Serif</ToggleGroupItem>
                        <ToggleGroupItem value="sans" className="px-3">Sans</ToggleGroupItem>
                      </ToggleGroup>
                      <ToggleGroup type="single" variant="outline" value={outTheme.textColor === "#ffffff" ? "white" : "warm"} onValueChange={(v) => v && setOutTheme({ ...outTheme, textColor: v === "white" ? "#ffffff" : "#f3ecdc" })}>
                        <ToggleGroupItem value="warm" className="px-3">Warm white</ToggleGroupItem>
                        <ToggleGroupItem value="white" className="px-3">Pure white</ToggleGroupItem>
                      </ToggleGroup>
                      <Button variant="ghost" onClick={() => setOutTheme(DEFAULT_THEME)}>
                        <RotateCcw /> Reset
                      </Button>
                    </div>
                  </Section>
                </div>
              </ScrollArea>
              <div className="flex min-h-0 flex-col gap-3 rounded-lg border bg-card p-4">
                <SectionLabel>Projector preview</SectionLabel>
                <div className="aspect-video w-full overflow-hidden rounded-lg border bg-black">
                  <div className="relative h-full w-full">
                    <SlideView
                      slide={slide && slide.kind !== "blank" ? slide : { kind: "verse", title: "John 3:16", body: "For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.", sub: "KJV" }}
                      theme={outTheme}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { kind: "text", title: "", body: "Way maker, miracle worker\nPromise keeper\nLight in the darkness", sub: "Way Maker" },
                    { kind: "logo", title: "", body: "", sub: "" },
                    { kind: "text", title: "Announcements", body: "Youth meeting on Friday at 7 pm", sub: "" },
                  ].map((sl, i) => (
                    <div key={i} className="aspect-video overflow-hidden rounded-md border bg-black">
                      <div className="relative h-full w-full">
                        <SlideView slide={sl} theme={outTheme} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="grid h-full min-h-0 grid-cols-[minmax(260px,1fr)_minmax(420px,2fr)_minmax(260px,1fr)] gap-3">
              {/* Transcript */}
              <div className="flex min-h-0 flex-col rounded-lg border bg-card">
                <div className="flex items-center justify-between border-b px-3 py-2">
                  <SectionLabel>Transcript</SectionLabel>
                  <ToggleGroup type="single" size="sm" variant="outline" value={transcriptView} onValueChange={(v) => v && setTranscriptView(v as "processed" | "raw")}>
                    <ToggleGroupItem value="processed" className="px-2 text-xs">Processed</ToggleGroupItem>
                    <ToggleGroupItem value="raw" className="px-2 text-xs">Raw</ToggleGroupItem>
                  </ToggleGroup>
                </div>
                <ScrollArea className="min-h-0 flex-1">
                  <div className="flex flex-col gap-1.5 p-3 text-sm leading-relaxed">
                    {transcriptView === "processed" ? (
                      <>
                        {transcriptRef.current.slice(-40).map((l, i) => (
                          <p key={i} className={cn("rounded-md px-2 py-1", l.labels.length ? "bg-accent text-accent-foreground" : "text-foreground/85")}>
                            {l.text}
                            {l.labels.map((lb, j) => (
                              <Badge key={j} variant="outline" className="ml-1.5 border-primary/50 text-primary">{lb}</Badge>
                            ))}
                          </p>
                        ))}
                        {partialRef.current.text && <p className="px-2 italic text-muted-foreground">{partialRef.current.text}…</p>}
                        {transcriptRef.current.length === 0 && !partialRef.current.text && (
                          <Empty>Speech appears here as it is heard.</Empty>
                        )}
                      </>
                    ) : (
                      <>
                        {rawRef.current.slice(-60).map((t, i) => (
                          <p key={i} className={cn("px-2 font-mono text-xs", isJunk(t) && "opacity-40")}>{t}</p>
                        ))}
                        {rawRef.current.length === 0 && <Empty>The unfiltered speech model output appears here.</Empty>}
                      </>
                    )}
                  </div>
                </ScrollArea>
                <div className="truncate border-t px-3 py-1.5 font-mono text-[11px] text-muted-foreground">{diagRef.current || " "}</div>
              </div>

              {/* Live */}
              <div className="flex min-h-0 flex-col gap-3">
                {liveScreen}
                {coverButtons}
                <div className="flex min-h-0 flex-1 flex-col rounded-lg border bg-card">
                  <div className="flex items-center justify-between border-b px-3 py-2">
                    <SectionLabel>{held ? "Waiting for you · click or press Enter to show" : "Detected verses"}</SectionLabel>
                    {held && <Badge className="bg-warning text-black">HOLD</Badge>}
                  </div>
                  <ScrollArea className="min-h-0 flex-1">
                    <div className="flex flex-col gap-2 p-3">
                      {cardsRef.current.length === 0 && (
                        <Empty>{held ? "Verses the preacher names will wait here." : "Verses go straight to the screen. Quote matches wait here for a moment first."}</Empty>
                      )}
                      {cardsRef.current.map((c) => {
                        const pct = c.kind === "quote" ? Math.max(0, Math.min(100, (100 * (now - (c.fireAt - FIRE_DELAY))) / FIRE_DELAY)) : 100;
                        return (
                          <button
                            key={c.id}
                            className={cn("rounded-md border bg-background p-2.5 text-left transition hover:border-primary", held && "border-dashed")}
                            title="Show now"
                            onClick={() => void showCard(c)}
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-semibold">{c.label}</span>
                              <Badge variant="secondary">{c.kind === "quote" ? "quote" : "reference"}</Badge>
                            </div>
                            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                              <div className="h-full bg-primary" style={{ width: pct + "%" }} />
                            </div>
                            <div className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{c.hit.text}</div>
                          </button>
                        );
                      })}
                    </div>
                  </ScrollArea>
                </div>
              </div>

              {/* Tools */}
              <ScrollArea className="h-full rounded-lg border bg-card">
                <div className="flex flex-col gap-5 p-3">
                  <Section label="Find a verse">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                      <Input
                        ref={inputRef}
                        className="pl-8"
                        value={q}
                        placeholder="john 3 16 · psalm 91 1-2"
                        onChange={(e) => void onQuery(e.target.value, setQ, setHits)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && hits.length > 0) show(hits[0]);
                        }}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      {hits.map((h, i) => (
                        <button key={h.label + i} className={cn("rounded-md border p-2 text-left text-sm hover:border-primary", i === 0 && "border-primary/60")} onClick={() => show(h)}>
                          <div className="font-semibold">{h.label}</div>
                          <div className="line-clamp-2 text-xs text-muted-foreground">{h.text}</div>
                        </button>
                      ))}
                    </div>
                  </Section>
                  <Section label="Translation">
                    <div className="flex gap-2">
                      <Select value={trId} onValueChange={changeTr}>
                        <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {translations.map((t) => (
                            <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button variant="outline" size="icon" title="Import a translation" onClick={() => setView("downloads")}>
                        <Upload />
                      </Button>
                    </div>
                  </Section>
                  <Section label="Shown recently">
                    {historyRef.current.length === 0 && <Empty>Verses shown appear here. Click to show again.</Empty>}
                    <div className="flex flex-wrap gap-1.5">
                      {historyRef.current.slice(-12).reverse().map((h, i) => (
                        <Button key={h.label + i} variant="outline" size="sm" onClick={() => void showVerse(h.hit)}>
                          {h.label}
                        </Button>
                      ))}
                    </div>
                  </Section>
                  <Section label="Sermon notes">
                    {stRef.current.title && <div className="text-sm font-semibold">{stRef.current.title}</div>}
                    {stRef.current.points.map((p) => (
                      <div key={p.num} className="text-sm">{p.num}. {p.text}</div>
                    ))}
                    {stRef.current.notes.length === 0 && <Empty>Key lines and verses collect here.</Empty>}
                    <div className="flex flex-col gap-1">
                      {stRef.current.notes.slice(-8).map((n, i) => (
                        <div key={i} className="border-l-2 border-primary/40 pl-2 text-xs text-muted-foreground">{n}</div>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={copyNotes}><Copy /> Copy notes</Button>
                      <Button variant="outline" size="sm" onClick={() => void emitSummary()} title="Puts the summary slide on the projector"><FileText /> Summary now</Button>
                    </div>
                  </Section>
                </div>
              </ScrollArea>
            </div>
          )}
        </main>

        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Settings</DialogTitle>
              <DialogDescription>Speech model, audio input and how the console looks.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-5">
              <Section label="Speech model">
                <div className="flex gap-2">
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tiny.en">Whisper tiny.en · 75 MB · fastest</SelectItem>
                      <SelectItem value="base.en">Whisper base.en · 142 MB · balanced</SelectItem>
                      <SelectItem value="small.en">Whisper small.en · 466 MB · most accurate</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="secondary" onClick={loadModel}><Download /> Load</Button>
                </div>
                <p className="text-xs text-muted-foreground">{modelStatus} · quote matching: {quoteStatus}</p>
              </Section>
              <Section label="Audio input">
                <Select value={micId || "__default"} onValueChange={(v) => setMicId(v === "__default" ? "" : v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default">System default input</SelectItem>
                    {mics.map((m) => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Use the sound desk feed if you have one. Changes apply the next time you press Listen.</p>
              </Section>
              <Section label="Console look">
                <div className="flex items-center justify-between">
                  <Label htmlFor="mode">Dark mode</Label>
                  <Switch id="mode" checked={mode === "dark"} onCheckedChange={(c) => setMode(c ? "dark" : "light")} />
                </div>
                <div className="flex flex-wrap gap-2">
                  {[...PRESETS, ...(uiTheme && !PRESETS.some((p) => p.name === uiTheme.name) ? [uiTheme] : [])].map((p) => (
                    <Button key={p.name} size="sm" variant={uiTheme?.name === p.name ? "default" : "outline"} onClick={() => setUiTheme(p)}>
                      {p.name}
                    </Button>
                  ))}
                </div>
                <Textarea
                  rows={3}
                  value={themeInput}
                  onChange={(e) => setThemeInput(e.target.value)}
                  placeholder="Paste a tweakcn.com theme link, or the CSS from its Code panel"
                  className="font-mono text-xs"
                />
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!themeInput.trim()}
                    onClick={() =>
                      void loadTheme(themeInput)
                        .then((t) => {
                          setUiTheme(t);
                          setThemeInput("");
                          toast.success("Theme applied: " + t.name);
                        })
                        .catch((e) => toast.error(String(e.message || e)))
                    }
                  >
                    <Palette /> Apply theme
                  </Button>
                  <Button size="sm" variant="link" onClick={() => openLink("https://tweakcn.com/editor/theme")}>Open tweakcn</Button>
                </div>
              </Section>
            </div>
          </DialogContent>
        </Dialog>
        <Toaster position="bottom-right" />
      </div>
    </TooltipProvider>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ml-1 rounded border border-current/30 px-1 font-mono text-[10px] opacity-70">{children}</kbd>;
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</div>;
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>{label}</SectionLabel>
      {children}
    </section>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-sm text-muted-foreground">{children}</p>;
}

function LinkCard({ title, sub, onOpen }: { title: string; sub: string; onOpen: () => void }) {
  return (
    <button className="flex flex-col gap-1 rounded-md border p-3 text-left hover:border-primary" onClick={onOpen}>
      <span className="flex items-center gap-1 text-sm font-semibold">
        {title} <ExternalLink className="size-3.5 opacity-60" />
      </span>
      <span className="text-xs text-muted-foreground">{sub}</span>
    </button>
  );
}

