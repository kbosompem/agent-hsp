import { ReactNode, useEffect, useRef, useState } from "react";
import {
  BookOpen, Check, Clapperboard, Copy, FolderOpen, Pause, Pencil, Play, RotateCw, Trash2, X, Download, ExternalLink, EyeOff, FileText, Hand, Image as ImageIcon, ListOrdered, Mic, MicOff, Minus,
  MonitorPlay, Palette, Plus, RotateCcw, Search, Settings2, Square, Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Toaster } from "@/components/ui/sonner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  Mode, PRESETS, UiTheme, applyMode, applyTheme, customThemes, loadTheme, removeCustomTheme, saveCustomTheme, savedMode, savedTheme, uniqueName,
} from "@/lib/uitheme";
import SlideView, { OutputTheme, Slide } from "./SlideView";
import Backgrounds from "./Backgrounds";
import CornerSettings from "./CornerSettings";
import AudioPlayer, { AudioControl } from "./AudioPlayer";
import MediaLibrary from "./MediaLibrary";
import Setup from "./Setup";
import ProjectorMenu from "./ProjectorMenu";
import AiSettings, { LlmSettings } from "./AiSettings";
import { AiLine, AiSummary, SUMMARY_SYSTEM, parseSummary, summaryMarkdown, summaryMessage, versesMarkdown } from "./lib/aisummary";
import { logEvent } from "./lib/log";
import { MediaFolder, MediaItem } from "./lib/media";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
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
  unlogVerse,
} from "./lib/sermon";
import Service, { ServiceNav } from "./Service";
import { PerSlide, groupVerses, parsePerSlide, slideHas } from "./lib/verses";
import { AgendaItem, ItemBackground, ItemSlide, Library, Song, emptyLibrary, parseLibrary } from "./lib/library";
import { contentWords, findLoaded, hasBookName, hasReferenceWords, hspCommand, isClearCommand, spokenNumber, readPast, readingOverlap, translationRequest } from "./lib/voice";

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

type TranslationInfo = { id: string; name: string; abbrev: string; edition: string; copyright: string; bundled: boolean };


type Card = {
  id: number;
  label: string;
  hit: VerseHit;
  trigger: string;
  kind: "ref" | "quote";
  fireAt: number;
  status: "pending" | "done";
  // A partial misheard this verse moments ago; this card takes its place.
  replaces?: string;
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

// A recited verse is looked for in the last RECITE_WORDS words heard within
// RECITE_WINDOW_MS: long enough for a whole verse, short enough that words
// from before a pause do not bring back a verse said minutes ago.
const RECITE_WORDS = 35;
const RECITE_WINDOW_MS = 30000;
// A spoken reference is skipped if shown this recently (or still on screen).
const REF_REPEAT_MS = 30000;
// A quote match is not repeated within this window.
const QUOTE_REPEAT_MS = 180000;

// A spoken reference goes up at once (speed matters more than the odd wrong
// verse, which a later partial can swap out). Quote matches are less certain
// and wait so the operator can skip them.
const REF_FIRE_DELAY = 0;
// How long after a partial puts a verse up a later partial may swap it.
const SWAP_MS = 1500;
// With Deepgram, "Still listening?" comes up after this much listening, and
// listening stops if no one answers within STILL_WAIT_MS.
const STILL_EVERY_MS = 60 * 60 * 1000;
const STILL_WAIT_MS = 5 * 60 * 1000;
// A verse taken down with "HSP" stays off the screen this long.
const BLOCK_MS = 60000;
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
const TENS_WORDS = new Set(["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred"]);

// Trim the unfinished end of a partial transcript. "John 3 1" may be "John 3 16"
// half-spoken, and "Proverbs 3 verses 5 and" may be the start of "5 and 6".
// Drops a trailing number ("thirty two" whole, never leaving "thirty"), then
// any trailing "<number> <range word>".
function settleTail(text: string): string {
  const words = text.trim().split(/\s+/);
  const bare = (w: string) => w.replace(/^[,.:;-]+/, "").replace(/[.,!?:;-]+$/, "").toLowerCase();
  const dropNumber = () => {
    words.pop();
    while (words.length && TENS_WORDS.has(bare(words[words.length - 1]))) words.pop();
  };
  if (words.length && isNumberWord(words[words.length - 1])) dropNumber();
  while (words.length >= 2 && RANGE_WORDS.has(bare(words[words.length - 1])) && isNumberWord(words[words.length - 2])) {
    words.pop();
    dropNumber();
  }
  return words.join(" ");
}

/** The live AI summary under Sermon notes. */
function AiNotes({
  ai,
  model,
  listening,
  onShow,
  onRefresh,
}: {
  ai: { summary: AiSummary | null; at: number; busy: boolean; error: string };
  model: string;
  listening: boolean;
  onShow: (label: string) => void;
  onRefresh: () => void;
}) {
  const s = ai.summary;
  const ago = ai.at ? Math.round((Date.now() - ai.at) / 60000) : -1;
  const status = ai.busy
    ? "Updating…"
    : ai.error
      ? "Last update failed: " + ai.error
      : ago < 0
        ? listening
          ? "The first summary comes after a minute or two of preaching."
          : "Starts when you press Listen."
        : "Updated " + (ago < 1 ? "just now" : ago + " min ago") + " · " + model;
  return (
    <div className="flex flex-col gap-2">
      {s?.title && <div className="text-sm font-semibold">{s.title}</div>}
      {s?.big_idea && <div className="text-xs text-muted-foreground">{s.big_idea}</div>}
      {s && s.points.length > 0 && (
        <ol className="flex flex-col gap-2">
          {s.points.map((p, i) => (
            <li key={i} className="text-sm">
              <div>{i + 1}. {p.point}</div>
              {p.detail && <div className="pl-4 text-xs text-muted-foreground">{p.detail}</div>}
              {p.verses.length > 0 && (
                <div className="flex flex-wrap gap-1 pl-4 pt-1">
                  {p.verses.map((v) => (
                    <Button key={v} variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => onShow(v)} title="Show this verse">
                      {v}
                    </Button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      <div className={cn("text-xs", ai.error ? "text-destructive" : "text-muted-foreground")}>{status}</div>
      {listening && (
        <Button variant="ghost" size="sm" className="self-start" disabled={ai.busy} onClick={onRefresh}>
          Update now
        </Button>
      )}
    </div>
  );
}

/** 4:59 from milliseconds. */
function clockLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

// What the operator needs to know about transcription right now.
function sttHealth(
  listening: boolean,
  h: { lag: number; error: string; errorAt: number; aliveAt: number; okAt: number },
  now: number,
  inputLost: { name: string; since: number } | null
): { label: string; cls: string; detail: string } {
  if (!listening) return { label: "IDLE", cls: "", detail: "Not listening" };
  if (inputLost) return { label: "NO SOUND", cls: "bad", detail: "Nothing is arriving from " + inputLost.name };
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
  const [modelStatus, setModelStatus] = useState("");
  const [micStatus, setMicStatus] = useState("");
  const [micLevelPct, setMicLevelPct] = useState(0);
  // The input device stopped sending sound (unplugged, USB dropout) while
  // listening; capture reconnects by itself when it is back.
  const [inputLost, setInputLost] = useState<{ name: string; since: number } | null>(null);
  // Transcription health (issue 2): lag behind live audio, last whisper error,
  // and when text or speech was last seen, so a stalled model is never silent.
  const healthRef = useRef({ lag: 0, error: "", errorAt: 0, aliveAt: 0, okAt: 0 });
  const [mics, setMics] = useState<string[]>([]);
  const [micId, setMicId] = useState("");
  // small.en finds the most verses in noisy-room tests; Macs run it on the GPU.
  // Windows runs whisper on the CPU, where base.en is the safer default.
  const [model, setModel] = useState(() => {
    try {
      const saved = localStorage.getItem("hsp-model");
      if (saved) return saved;
    } catch {
      /* ignore */
    }
    return /Mac/i.test(navigator.userAgent) ? "small.en" : "base.en";
  });
  // Deepgram and Nemotron stream: their partials only grow (see onPartial).
  const streamingRef = useRef(false);
  streamingRef.current = model === "deepgram" || model.startsWith("nemotron");
  useEffect(() => {
    try {
      localStorage.setItem("hsp-model", model);
    } catch {
      /* ignore */
    }
    setModelStatus("");
  }, [model]);
  const [mode, setMode] = useState<Mode>(savedMode);
  const [uiTheme, setUiTheme] = useState<UiTheme>(savedTheme);
  const [themeInput, setThemeInput] = useState("");
  // How many verses of a range go on one slide ("fit": as many as stay readable).
  const [perSlide, setPerSlide] = useState<PerSlide>(() => {
    try {
      return parsePerSlide(localStorage.getItem("hsp-verses-per-slide"));
    } catch {
      return "fit";
    }
  });
  const [trLabel, setTrLabel] = useState<"abbrev" | "name">(() => {
    try {
      return localStorage.getItem("hsp-translation-label") === "name" ? "name" : "abbrev";
    } catch {
      return "abbrev";
    }
  });
  const trLabelRef = useRef(trLabel);
  trLabelRef.current = trLabel;
  useEffect(() => {
    try {
      localStorage.setItem("hsp-translation-label", trLabel);
    } catch {
      /* ignore */
    }
  }, [trLabel]);
  const [editTr, setEditTr] = useState<TranslationInfo | null>(null);
  const perSlideRef = useRef(perSlide);
  perSlideRef.current = perSlide;
  useEffect(() => {
    try {
      localStorage.setItem("hsp-verses-per-slide", String(perSlide));
    } catch {
      /* ignore */
    }
  }, [perSlide]);
  const [themeName, setThemeName] = useState("");
  const [myThemes, setMyThemes] = useState<UiTheme[]>(() => {
    // A theme applied before themes were saved: keep it in the list.
    const cur = savedTheme();
    const list = customThemes();
    if (!PRESETS.some((p) => p.name === cur.name) && !list.some((t) => t.name === cur.name)) return saveCustomTheme(cur).list;
    return list;
  });
  const [setupOpen, setSetupOpen] = useState(false);
  // Speech engines compiled into this build (Nemotron is optional).
  const [engines, setEngines] = useState({ nemotron: true });
  useEffect(() => {
    invoke<{ nemotron: boolean }>("speech_engines")
      .then((e) => {
        setEngines(e);
        if (!e.nemotron) setModel((m) => (m.startsWith("nemotron") ? (/Mac/i.test(navigator.userAgent) ? "small.en" : "base.en") : m));
      })
      .catch((e) => logEvent("error", "speech_engines: " + String(e)));
  }, []);
  const [dgKey, setDgKey] = useState("");
  const [dgKeySaved, setDgKeySaved] = useState(false);
  const [dgReplacing, setDgReplacing] = useState(false);
  useEffect(() => {
    invoke<boolean>("has_deepgram_key").then(setDgKeySaved).catch(() => setDgKeySaved(false));
    invoke<LlmSettings>("llm_settings").then(setLlm).catch(() => {});
  }, []);
  const [transcriptView, setTranscriptView] = useState<"processed" | "raw">("processed");
  const [view, setView] = useState<"console" | "service" | "media" | "theme" | "downloads" | "settings">("console");
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [mediaFolders, setMediaFolders] = useState<MediaFolder[]>([]);
  const audioRef = useRef<AudioControl>(null);
  // The sound of a video on the projector. The projector and previews play it
  // muted and follow this copy's clock ("video-sync"), because macOS only
  // lets a window play sound after someone clicks in it, and nobody clicks
  // the projector.
  const videoSound = useRef<HTMLVideoElement>(null);
  // YouTube downloads in progress: video id -> percent.
  const [ytProgress, setYtProgress] = useState<Record<string, number>>({});
  const mediaRef = useRef<MediaItem[]>([]);
  mediaRef.current = media;
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
  const [itemBg, setItemBg] = useState<ItemBackground | null>(null);
  const outThemeRef = useRef(outTheme);
  outThemeRef.current = outTheme;
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
  // Finished lines of the last RECITE_WINDOW_MS, for recited verses.
  const recentRef = useRef<{ at: number; text: string }[]>([]);
  const quoteBusy = useRef(false);
  const slideRef = useRef<Slide | null>(null);
  const lastVerse = useRef<VerseHit | null>(null);
  const verseShownAt = useRef(0);
  const seq = useRef(1);
  const shownRef = useRef<Record<string, number>>({});
  // The last swap (misheard verse taken down for the one shown in its place),
  // so a final that brings the misheard verse back swaps back.
  const swapRef = useRef<{ from: string; to: string; at: number } | null>(null);
  const lastCmdAt = useRef(0);
  // Hold: the AI never changes the projector. Detected verses wait as cards
  // the operator can click. Blackout and Logo turn it on.
  const [held, setHeld] = useState(false);
  const holdRef = useRef(false);
  // The slide that was up before a blackout or logo, to bring back.
  const beforeCover = useRef<Slide | null>(null);
  // Hold as it was before the blackout or logo, restored when it is lifted.
  const holdBeforeCover = useRef(false);
  // The last verse put up and what was on screen before it, so "HSP" (or U)
  // can take a wrong verse down; and verses taken down that way, which are
  // kept off the screen for a minute so they do not bounce straight back.
  const undoRef = useRef<{ before: Slide | null; label: string; at: number } | null>(null);
  const blockedRef = useRef<Record<string, number>>({});
  const hspSegRef = useRef(-1);
  // Every verse shown while listening, for the session summary.
  const shownLogRef = useRef<{ at: number; label: string; translation: string; text: string }[]>([]);
  const sessionRef = useRef<{ dir: string; name: string; startedAt: number } | null>(null);
  // The AI summary: every final line of the service (the transcript list
  // above keeps only the last 200), the latest summary, and its status.
  const aiLinesRef = useRef<AiLine[]>([]);
  const aiRef = useRef<{ summary: AiSummary | null; at: number; words: number; busy: boolean; error: string }>({
    summary: null,
    at: 0,
    words: 0,
    busy: false,
    error: "",
  });
  const [llm, setLlm] = useState<LlmSettings | null>(null);
  const llmRef = useRef<LlmSettings | null>(null);
  llmRef.current = llm;
  const [continuePrompt, setContinuePrompt] = useState<{ dir: string; name: string; age_s: number; audio_s: number } | null>(null);
  // Deepgram bills by the minute: every hour of listening asks "Still
  // listening?" and stops at the deadline (ms) unless someone answers.
  const [stillPrompt, setStillPrompt] = useState<number | null>(null);
  // The projector window exists (it starts open; closing it is reported).
  const [projectorOpen, setProjectorOpen] = useState(true);
  const stillRef = useRef<number | null>(null);
  stillRef.current = stillPrompt;
  const askedAtRef = useRef(0);
  const lastTrAt = useRef(0);
  const diagRef = useRef("");
  const listeningRef = useRef(false);
  // Streaming partials: live text of the segment still being spoken, the
  // labels the previous partial saw, labels already fired from partials, and
  // labels swapped out as mishearings (its partials may not bring them back).
  const partialRef = useRef<{ seg: number; text: string; labels: Set<string>; fired: string[]; out: Set<string> }>({
    seg: -1,
    text: "",
    labels: new Set(),
    fired: [],
    out: new Set(),
  });
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
  }, [outTheme]);
  // The projector uses the live service item's own background, if it has one.
  const liveTheme: OutputTheme = itemBg ? { ...outTheme, ...itemBg } : outTheme;
  const liveThemeRef = useRef(liveTheme);
  liveThemeRef.current = liveTheme;
  useEffect(() => {
    void emit("output-theme", liveTheme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outTheme, itemBg]);

  function addNote(bullet: string) {
    addSermonNote(stRef.current, bullet);
  }

  async function showVerse(hit: VerseHit, trigger?: string) {
    let h = hit;
    undoRef.current = { before: slideRef.current, label: h.label, at: Date.now() };
    const ref = h.reference;
    // A single verse inside the range on screen: jump there and keep following.
    const seqr = seqRef.current;
    if (seqr && ref && ref.verse && !ref.end_verse) {
      const at = seqr.slides.findIndex((s) => slideHas(s, ref.book, ref.chapter, ref.verse!));
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
      const groups = groupVerses(slides, perSlideRef.current) as VerseHit[];
      if (groups.length > 1) {
        seqRef.current = { slides: groups, idx: 0 };
        await showSeqSlide(0);
        return;
      }
      // The whole range fits on one slide.
      if (groups.length === 1) h = groups[0];
    }
    seqRef.current = null;
    const s = await invoke<Slide>("show_verse", { hit: forScreen(h) });
    setSlide(s);
    slideRef.current = s;
    lastVerse.current = h;
    openPassage(h);
    verseShownAt.current = Date.now();
    if (listeningRef.current) {
      shownLogRef.current.push({ at: Date.now(), label: h.label, translation: h.translation, text: h.text });
    }
    const lastHist = historyRef.current[historyRef.current.length - 1];
    if (!lastHist || lastHist.label !== h.label) {
      historyRef.current.push({ label: h.label, hit: h });
      if (historyRef.current.length > 12) historyRef.current.shift();
    }
    logVerse(stRef.current, h.label, h.text, trigger);
  }

  /** A later partial heard the reference differently: put the new verse up in
   *  place of the misheard one, which leaves undo, history and the summary. */
  async function swapVerse(hit: VerseHit, replaced: string, trigger: string) {
    const u = undoRef.current;
    const shown = showVerse(hit, trigger);
    // showVerse sets its undo entry before its first await.
    const mine = undoRef.current;
    if (u && u.label === replaced && mine) mine.before = u.before;
    swapRef.current = { from: replaced, to: hit.label, at: Date.now() };
    await shown;
    const i = historyRef.current.map((x) => x.label).lastIndexOf(replaced);
    if (i >= 0 && i < historyRef.current.length - 1) historyRef.current.splice(i, 1);
    delete shownRef.current[replaced];
    unlogVerse(stRef.current, replaced);
    setMicStatus("Swapped " + replaced + " for " + hit.label);
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
    const s = await invoke<Slide>("show_verse", { hit: forScreen(h) });
    setSlide(s);
    slideRef.current = s;
    lastVerse.current = h;
    openPassage(h);
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

  function dropPending() {
    cardsRef.current = cardsRef.current.filter((c) => c.status !== "pending");
    sync();
  }

  /** "Clear the screen": the Logo screen, with no text. L brings back what was up. */
  async function clearScreen() {
    dropPending();
    seqRef.current = null;
    const cur = slideRef.current;
    if (cur && cur.kind !== "blank" && cur.kind !== "logo") {
      beforeCover.current = cur;
      holdBeforeCover.current = holdRef.current;
    }
    const s = await invoke<Slide>("show_slide", { kind: "logo", title: "", body: "", sub: "" });
    setSlide(s);
    slideRef.current = s;
    setMicStatus("Screen cleared. Press L to bring the slide back.");
  }

  /** "HSP" / U: the last verse was wrong. Put back what was on screen before it. */
  async function undoLast() {
    const u = undoRef.current;
    dropPending();
    seqRef.current = null;
    if (!u || Date.now() - u.at > 120000) {
      await clearScreen();
      return;
    }
    undoRef.current = null;
    blockedRef.current[u.label] = Date.now();
    const b = u.before;
    if (b && b.kind !== "blank") {
      const s = await invoke<Slide>("show_slide", { kind: b.kind, title: b.title, body: b.body, sub: b.sub });
      setSlide(s);
      slideRef.current = s;
    } else {
      const s = await invoke<Slide>("show_slide", { kind: "logo", title: "", body: "", sub: "" });
      setSlide(s);
      slideRef.current = s;
    }
    setMicStatus("Took down " + u.label + ". It stays off for a minute unless you show it yourself.");
  }

  /** What to do with the words after "HSP". */
  async function handleHsp(rest: string, seg: number) {
    hspSegRef.current = seg;
    const norm = rest.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    if (!norm) return void undoLast();
    if (isClearCommand(norm) || /^(?:clear|blank|off|down|logo)\b/.test(norm)) return void clearScreen();
    if (/^(?:black ?out|blackout)\b/.test(norm)) return void cover("blank");
    if (/^(?:wrong|no|not that|undo|back)\b/.test(norm)) return void undoLast();
    lastCmdAt.current = 0;
    if (matchCommand(norm)) return;
    // "HSP, John 3:16": show exactly that, even if it was taken down earlier.
    const found = await invoke<VerseHit[]>("lookup_live", { input: rest, translation: trIdRef.current, commit: true }).catch(() => []);
    const hit = found.find((h) => h.reference && h.reference.verse != null);
    if (hit) {
      delete blockedRef.current[hit.label];
      seqRef.current = null;
      await showVerse(hit, "");
      return;
    }
    void undoLast();
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

  /** The verse as the room sees it: the translation by short name ("NLT") or full name, per the Look page. */
  function forScreen(h: VerseHit): VerseHit {
    const t = translationsRef.current.find((x) => x.name === h.translation || x.id === h.translation);
    if (!t) return h;
    return { ...h, translation: trLabelRef.current === "abbrev" && t.abbrev ? t.abbrev : t.name };
  }

  /** Tell the parser which chapter is on screen, however it got there. */
  function openPassage(h: VerseHit) {
    const r = h.reference;
    if (r) void invoke("set_live_context", { book: r.book, chapter: r.chapter }).catch(() => {});
  }

  /** Verse `verse` of `chapter` in the book on screen (or the open passage). */
  async function showInBook(chapter: number, verse: number, what: string) {
    const ref = lastVerse.current?.reference;
    if (!ref) {
      setMicStatus("Show a verse first, then " + what + ".");
      return;
    }
    const hit = await invoke<VerseHit | null>("verse_at", { book: ref.book, chapter, verse, translation: trIdRef.current });
    if (hit) {
      seqRef.current = null;
      await showVerse(hit, "");
      setMicStatus(hit.label);
    } else {
      setMicStatus("There is no " + (verse > 1 ? "verse " + verse + " in " : "") + "chapter " + chapter + " there.");
    }
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
    const ai = aiRef.current.summary;
    const data: SummaryData =
      ai && ai.points.length ? { points: ai.points.slice(0, 4).map((p) => ({ text: p.point, verses: p.verses.slice(0, 4) })) } : buildSummary();
    if (!data.points.length) {
      setMicStatus("Nothing to summarize yet.");
      return;
    }
    const s = await invoke<Slide>("show_slide", {
      kind: "summary",
      title: ai?.title || sermonTitle(),
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

  /** Folder name for a new session from local time: 2026-10-11_10-02. */
  function sessionName(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "_" + p(d.getHours()) + "-" + p(d.getMinutes());
  }

  /** Ask the AI for the summary of `lines` so far. Returns null on failure. */
  async function aiSummarize(lines: AiLine[], verses: typeof shownLogRef.current, startedAt: number, final: boolean) {
    const reply = await invoke<string>("llm_complete", {
      system: SUMMARY_SYSTEM,
      user: summaryMessage(lines, verses, startedAt, final),
      maxTokens: 4000,
      json: true,
    });
    const got = parseSummary(reply, verses.map((v) => v.label));
    if (!got) throw new Error("The AI's reply was not a summary: " + reply.slice(0, 120));
    return got;
  }

  /** Refresh the live summary (every 90 s while listening, or "Update now"). */
  async function refreshAi() {
    const a = aiRef.current;
    if (a.busy || !llmRef.current?.enabled || !aiLinesRef.current.length) return;
    a.busy = true;
    sync();
    const words = aiLinesRef.current.reduce((n, l) => n + l.text.split(/\s+/).length, 0);
    try {
      const started = sessionRef.current?.startedAt ?? aiLinesRef.current[0].at;
      const got = await aiSummarize(aiLinesRef.current, shownLogRef.current, started, false);
      // A new service started while it was thinking: drop the answer.
      if (aiRef.current !== a) return;
      // An empty outline never replaces a real one.
      if (got.points.length || !a.summary?.points.length) a.summary = got;
      a.error = "";
    } catch (e) {
      a.error = String(e).replace(/^Error:\s*/, "");
      logEvent("error", "ai summary: " + a.error);
    } finally {
      a.busy = false;
      a.at = Date.now();
      a.words = words;
      sync();
    }
  }

  /** The heading line of the session files: date and time, speech model. */
  function sessionHeading(): string {
    const started = sessionRef.current?.startedAt ?? Date.now();
    return new Date(started).toLocaleString() + " · speech model: " + model;
  }

  /** summary.md for the session folder, written at Stop. */
  function sessionSummary(): string {
    const ai = aiRef.current.summary;
    if (ai && ai.points.length) return summaryMarkdown(ai, sessionHeading(), llmRef.current?.model || "AI");
    const st = stRef.current;
    const started = sessionRef.current?.startedAt ?? Date.now();
    const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const lines: string[] = [];
    const guess = titleFor(st, transcriptRef.current.map((l) => l.text));
    const title = st.title || (guess && guess !== "Sermon summary" ? guess : "Service " + new Date(started).toLocaleDateString());
    lines.push("# " + title);
    lines.push("");
    lines.push(new Date(started).toLocaleString() + " · speech model: " + model);
    lines.push("");
    if (st.points.length) {
      lines.push("## Outline", "");
      st.points.forEach((p) => lines.push(p.num + ". " + p.text));
      lines.push("");
    }
    lines.push("## Verses shown", "");
    if (!shownLogRef.current.length) lines.push("None.");
    shownLogRef.current.forEach((v) => lines.push("- " + clock(v.at) + " · **" + v.label + "** (" + v.translation + ") " + v.text));
    lines.push("");
    if (st.notes.length) {
      lines.push("## Key lines", "");
      st.notes.forEach((n) => lines.push("- " + n));
      lines.push("");
    }
    lines.push("Files in this folder: audio.m4a (the recording; audio.wav on Windows), transcript.txt (raw transcript with times), summary.md (this file).");
    return lines.join("\n") + "\n";
  }

  /** Stop listening and save the session. `why` says it stopped by itself. */
  async function stopListening(why?: string) {
    if (!listeningRef.current) return;
    listeningRef.current = false;
    setListening(false);
    setInputLost(null);
    setStillPrompt(null);
    const dir = await invoke<string | null>("stop_listening", { summary: sessionSummary() }).catch(() => null);
    if (dir) {
      const heading = sessionHeading();
      const verses = shownLogRef.current.slice();
      void invoke("save_session_file", { dir, name: "verses.md", content: versesMarkdown(verses, heading) }).catch((e) =>
        logEvent("error", "verses.md: " + e)
      );
      // One last pass over the whole sermon for the saved summary.
      const lines = aiLinesRef.current.slice();
      if (llmRef.current?.enabled && lines.length) {
        const by = llmRef.current.model;
        const started = sessionRef.current?.startedAt ?? lines[0].at;
        void aiSummarize(lines, verses, started, true)
          .then((got) => {
            // summary.md already has the live summary; keep it over an empty one.
            if (!got.points.length) throw new Error("the AI found no sermon points");
            return invoke("save_session_file", { dir, name: "summary.md", content: summaryMarkdown(got, heading, by) });
          })
          .then(() => toast.success("AI summary saved with the recording"))
          .catch((e) => {
            logEvent("error", "final ai summary: " + e);
            toast.error("The final AI summary failed; summary.md has the last live one. " + String(e).replace(/^Error:\s*/, ""));
          });
      }
    }
    const said = why ? why + " Stopped listening to save Deepgram charges." : "Stopped.";
    if (dir) {
      setMicStatus(said + " Saved the recording, transcript and summary.");
      const open = { label: "Open folder", onClick: () => void invoke("open_session_folder", { dir }) };
      if (why) toast.warning(said + " Press Listen to continue the same service.", { action: open, duration: Infinity });
      else toast.success("Session saved: audio, transcript and summary", { action: open });
    } else {
      setMicStatus(said);
    }
  }
  const stopRef = useRef(stopListening);
  stopRef.current = stopListening;

  async function toggleListen() {
    if (listeningRef.current) {
      await stopListening();
      return;
    }
    // A recent session: ask whether this is the same service.
    const last = await invoke<{ dir: string; name: string; age_s: number; audio_s: number } | null>("last_session").catch(() => null);
    if (last && last.age_s < 8 * 3600 && last.audio_s > 5) {
      setContinuePrompt(last);
      return;
    }
    await startListening(null);
  }

  /** Start listening into a new session, or continue `continueDir`. */
  async function startListening(continueDir: string | null) {
    setContinuePrompt(null);
    if (!continueDir) {
      // A new service: start its notes and verse list fresh.
      stRef.current = newSermonState();
      shownLogRef.current = [];
      aiLinesRef.current = [];
      aiRef.current = { summary: null, at: 0, words: 0, busy: false, error: "" };
      transcriptRef.current = [];
      rawRef.current = [];
    }
    try {
      await invoke("reset_live");
      // Keep the passage already on screen as the open one.
      if (lastVerse.current) openPassage(lastVerse.current);
      const now0 = Date.now();
      healthRef.current = { lag: 0, error: "", errorAt: 0, aliveAt: now0, okAt: now0 };
      const name = sessionName();
      const r = await invoke<string>("start_listening", {
        device: micId || null,
        model: model,
        sessionName: name,
        continueSession: continueDir,
      });
      listeningRef.current = true;
      askedAtRef.current = Date.now();
      if (!continueDir || !sessionRef.current) sessionRef.current = { dir: continueDir ?? "", name, startedAt: now0 };
      // Model loading happens inside start_listening; start the stall clock after it.
      healthRef.current.aliveAt = Date.now();
      setListening(true);
      setInputLost(null);
      if (r === "already") setMicStatus("Already listening.");
      else setMicStatus(continueDir ? "Listening · continuing the same service recording." : "Listening · recording a new service.");
    } catch (e: any) {
      setMicStatus(String(e).replace(/^Error:\s*/, ""));
    }
  }

  async function show(h: VerseHit) {
    await showVerse(h, "");
  }

  /** Show a verse by its label, e.g. from the AI summary. */
  async function showLabel(label: string) {
    const known = historyRef.current.find((h) => h.label === label)?.hit;
    const hit =
      known ??
      (await invoke<VerseHit[]>("lookup_live", { input: label, translation: trIdRef.current, commit: false }).catch(() => []))[0];
    if (hit) await showVerse(hit, "");
  }

  function copyNotes() {
    const ai = aiRef.current.summary;
    if (ai && ai.points.length) {
      const md = summaryMarkdown(ai, sessionHeading(), llmRef.current?.model || "AI").replace(/\nFiles in this folder:.*\n$/, "\n");
      navigator.clipboard
        .writeText(md)
        .then(() => setMicStatus("AI summary copied to clipboard."))
        .catch(() => setMicStatus("Copy failed."));
      return;
    }
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
        } else if (p.status === "error") {
          setModelStatus("error: " + (p.error || "download failed"));
          logEvent("error", "model: " + (p.error || "download failed"));
        } else if (p.status) {
          setModelStatus(p.status);
        }
      }),
      listen<string>("model-ready", (e) => setModelStatus("ready · " + e.payload + " (native)")),
      listen<string>("listen-status", (e) => {
        setMicStatus(e.payload);
        logEvent("info", "listen: " + e.payload);
      }),
      listen<string>("input-lost", (e) => {
        setInputLost({ name: e.payload, since: Date.now() });
        logEvent("error", "input lost: no sound from " + e.payload);
      }),
      listen<string>("input-restored", (e) => {
        setInputLost(null);
        logEvent("info", "input back: " + e.payload);
      }),
      // Deepgram heard no one for five minutes.
      listen<string>("idle-stop", (e) => {
        logEvent("info", "listen: idle stop: " + e.payload);
        void stopRef.current(e.payload);
      }),
      listen<string>("session-dir", (e) => {
        if (sessionRef.current) sessionRef.current.dir = e.payload;
      }),
      listen<string>("projector-key", (e) => keyRef.current(new KeyboardEvent("keydown", { key: e.payload }))),
      listen("projector-closed", () => {
        setProjectorOpen(false);
        logEvent("info", "projector window closed");
      }),
      // A reopened projector window asks for what it should be showing.
      listen("output-ready", () => {
        setProjectorOpen(true);
        void emit("output-theme", liveThemeRef.current);
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
    invoke<MediaItem[]>("list_media").then(setMedia).catch(() => {});
    invoke<MediaFolder[]>("media_folders").then(setMediaFolders).catch(() => {});
    // Downloads finish on whatever page you are on.
    const subs = [
      listen<{ id: string; percent?: number; status?: string }>("media-progress", (e) => {
        if (e.payload.id && e.payload.percent != null) setYtProgress((p) => ({ ...p, [e.payload.id]: e.payload.percent! }));
        if (e.payload.status) toast.message(e.payload.status);
      }),
      listen<{ id: string; ok: boolean; error?: string }>("media-done", (e) => {
        setYtProgress((p) => {
          const n = { ...p };
          delete n[e.payload.id];
          return n;
        });
        if (e.payload.ok) {
          // ShemenMusic and songbook tracks (keyed by address) show their progress in the list instead.
          if (!e.payload.id.startsWith("http")) toast.success("Downloaded to the media library.");
          void invoke<MediaItem[]>("list_media").then(setMedia);
        } else {
          toast.error("Download failed: " + (e.payload.error || "unknown error"));
        }
      }),
    ];
    return () => subs.forEach((u) => u.then((f) => f()));
  }, []);

  /** Put a library video on the projector (with sound there). */
  /** Start the console's copy of a video's sound. Call it straight from a click or key press. */
  function startVideoSound(src: string) {
    const v = videoSound.current;
    if (!v) return;
    if (v.getAttribute("src") !== src) {
      v.src = src;
      v.currentTime = 0;
    }
    void v.play().catch((e) => setMicStatus("Could not play the video's sound: " + String(e?.name || e)));
  }

  async function showVideo(m: MediaItem) {
    beforeCover.current = null;
    seqRef.current = null;
    const src = convertFileSrc(m.path);
    startVideoSound(src);
    const s = await invoke<Slide>("show_slide", { kind: "video", title: m.title, body: src, sub: "" });
    setSlide(s);
    slideRef.current = s;
    setMicStatus("Video: " + m.title);
  }

  // Keep the video's sound with what is on screen, and tell every copy where it is.
  useEffect(() => {
    const v = videoSound.current;
    if (!v) return;
    if (slide?.kind !== "video") {
      if (v.getAttribute("src")) {
        v.pause();
        v.removeAttribute("src");
        v.load();
      }
      return;
    }
    if (v.getAttribute("src") !== slide.body) startVideoSound(slide.body);
    const t = window.setInterval(() => {
      void emit("video-sync", { src: slide.body, t: v.currentTime, playing: !v.paused && !v.ended });
    }, 250);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slide]);

  /** Add songs from ShemenMusic or the songbook, skipping any already added from the same place. */
  function addSongs(songs: Song[]) {
    setLibraryState((l) => {
      const have = new Set(l.songs.map((s) => s.source).filter(Boolean));
      return { ...l, songs: [...l.songs, ...songs.filter((s) => !s.source || !have.has(s.source))] };
    });
  }

  /** Add a media item to the open service. */
  function addMediaToService(m: MediaItem) {
    setLibraryState((l) => {
      const a = l.agendas.find((x) => x.id === l.currentAgendaId);
      if (!a) {
        toast.error("Open or create a service on the Service page first.");
        return l;
      }
      const it: AgendaItem = { id: Math.random().toString(36).slice(2, 10), kind: m.kind === "video" ? "video" : "audio", title: m.title, mediaId: m.id };
      toast.success("Added “" + m.title + "” to " + a.name + ".");
      return { ...l, agendas: l.agendas.map((x) => (x.id === a.id ? { ...x, items: [...x.items, it] } : x)) };
    });
  }

  useEffect(() => {
    invoke<string>("load_library")
      .then((j) => {
        const lib = parseLibrary(j);
        setLibraryState(lib);
        libLoaded.current = true;
        // First run: offer the downloads. An existing install (it has songs) is marked done quietly.
        try {
          if (!localStorage.getItem("hsp-setup-done")) {
            if (!lib.songs.length) setSetupOpen(true);
            else localStorage.setItem("hsp-setup-done", "1");
          }
        } catch {
          /* ignore */
        }
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
    if (it.kind === "video") startVideoSound(it.body);
    beforeCover.current = null;
    seqRef.current = null;
    let s: Slide;
    if (it.hit) {
      const h = it.hit as VerseHit;
      s = await invoke<Slide>("show_verse", { hit: forScreen(h) });
      lastVerse.current = h;
      openPassage(h);
    openPassage(h);
      verseShownAt.current = Date.now();
    } else {
      s = await invoke<Slide>("show_slide", { kind: it.kind, title: it.title, body: it.body, sub: it.sub });
    }
    setSlide(s);
    slideRef.current = s;
  }

  async function scriptureSlides(reference: string, translation?: string, per?: PerSlide): Promise<ItemSlide[]> {
    const tr = translation || trIdRef.current;
    const found = await invoke<VerseHit[]>("lookup", { input: reference, translation: tr });
    const h = found.find((x) => x.reference);
    const r = h?.reference;
    if (!h || !r) return [];
    let hits: VerseHit[] = [];
    if (r.verse != null && r.end_verse != null) {
      hits = await invoke<VerseHit[]>("verse_range", {
        book: r.book, chapter: r.chapter, from: r.verse, to: r.end_verse, translation: tr,
      });
    } else if (r.verse != null) {
      hits = [h];
    } else {
      // A whole chapter: one slide per verse.
      for (let v = 1; v <= 200; v++) {
        const x = await invoke<VerseHit | null>("verse_at", { book: r.book, chapter: r.chapter, verse: v, translation: tr });
        if (!x) break;
        hits.push(x);
      }
    }
    const groups = groupVerses(hits, per ?? perSlideRef.current) as VerseHit[];
    return groups.map((x) => ({ kind: "verse", title: x.label, body: x.text, sub: x.translation, label: x.label, hit: x }));
  }

  // Going live on an agenda item. Only a sermon lets the AI change the screen.
  function enterItem(it: AgendaItem) {
    setItemBg(it.bg ?? null);
    itemAudio(it);
    if (it.kind === "sermon") {
      setHold(false);
      // Mid-service: continue this service's recording without asking.
      if (!listeningRef.current) {
        const dir = sessionRef.current?.dir;
        if (dir && Date.now() - sessionRef.current!.startedAt < 6 * 3600 * 1000) void startListening(dir);
        else void toggleListen();
      }
      setMicStatus("Sermon: listening, verses go on screen as they are named.");
    } else {
      setHold(true);
    }
  }

  /** An item's sound: an audio item plays its track; any item may start (or stop) background audio.
   *  Runs on going live, and again when the live item's audio is changed. */
  function itemAudio(it: AgendaItem) {
    const find = (id?: string) => mediaRef.current.find((m) => m.id === id);
    if (it.kind === "audio") {
      const m = find(it.mediaId);
      if (m) audioRef.current?.play(m, { loop: !!it.bgLoop });
    }
    // A video has its own sound: fade background audio unless the item chose some.
    if (it.kind === "video" && !it.bgAudioId) audioRef.current?.fadeOut(2);
    if (it.bgAudioId === "__stop") audioRef.current?.fadeOut(3);
    else if (it.bgAudioId) {
      const m = find(it.bgAudioId);
      if (m) audioRef.current?.play(m, { loop: it.bgLoop !== false });
    }
  }

  // Live keys. Ignored while typing in a field.
  //   B blackout · L logo · H hold · P projector to the front · Esc clear to logo · Right/Left next/previous verse
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
    } else if (k === "u" || k === "U") {
      void undoLast();
    } else if (k === "p" || k === "P") {
      void invoke("projector_show").catch((err) => toast.error(String(err)));
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
    if (!listening || model !== "deepgram") return;
    const t = setInterval(() => {
      const now = Date.now();
      const deadline = stillRef.current;
      if (deadline === null && now - askedAtRef.current >= STILL_EVERY_MS) setStillPrompt(now + STILL_WAIT_MS);
      else if (deadline !== null && now >= deadline) void stopRef.current("No one answered \u201cStill listening?\u201d.");
    }, 1000);
    return () => clearInterval(t);
  }, [listening, model]);

  // The live AI summary: every 90 s, once at least 40 new words have come in.
  useEffect(() => {
    if (!listening || !llm?.enabled) return;
    const t = setInterval(() => {
      const a = aiRef.current;
      const words = aiLinesRef.current.reduce((n, l) => n + l.text.split(/\s+/).length, 0);
      if (!a.busy && Date.now() - a.at >= 90000 && words - a.words >= 40) void refreshAi();
    }, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening, llm?.enabled]);

  function keepListening() {
    askedAtRef.current = Date.now();
    setStillPrompt(null);
  }

  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      const due = holdRef.current
        ? []
        : cardsRef.current.filter((c) => c.status === "pending" && now >= c.fireAt);
      if (due.length) {
        due.forEach((c) => {
          c.status = "done";
          const sw = swapRef.current;
          if (c.replaces && lastVerse.current?.label === c.replaces) void swapVerse(c.hit, c.replaces, c.trigger);
          // The final heard the swapped-out verse after all: swap back.
          else if (sw && c.label === sw.from && lastVerse.current?.label === sw.to && Date.now() - sw.at < 10000)
            void swapVerse(c.hit, sw.to, c.trigger);
          else void showVerse(c.hit, c.trigger);
        });
        cardsRef.current = cardsRef.current.filter((c) => c.status !== "done");
        sync();
      }
    }, 200);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Quote matching must never interrupt scripture being read: not while a
  // range is up, and not when the line is the verse on screen read aloud.
  function readingInProgress(text: string): boolean {
    const onScreen = !!slideRef.current && slideRef.current.kind === "verse";
    if (!onScreen) return false;
    if (seqRef.current) return true;
    const cur = lastVerse.current;
    return !!cur && readingOverlap(text, cur.text) >= 0.3;
  }

  // A verse recited word for word (preso-core recite.rs): the last few
  // lines together, since a verse often spans two of them.
  async function quoteCheck(text: string) {
    const at = Date.now();
    const recent = recentRef.current.filter((l) => at - l.at <= RECITE_WINDOW_MS);
    recent.push({ at, text });
    recentRef.current = recent;
    if (quoteBusy.current || readingInProgress(text)) return;
    const words = recent.map((l) => l.text).join(" ").split(/\s+/).filter(Boolean);
    if (words.length < 6) return;
    quoteBusy.current = true;
    try {
      const hit = await invoke<VerseHit | null>("recite", {
        text: words.slice(-RECITE_WORDS).join(" "),
        translation: trIdRef.current,
      });
      const now = Date.now();
      const label = hit?.label;
      if (
        hit &&
        label &&
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
    } catch (e) {
      console.error(e);
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

  function queueHits(found: VerseHit[], line: TrLine, replaces?: VerseHit) {
    const now = Date.now();
    for (const h of found) {
      const last = shownRef.current[h.label];
      if (last && now - last < REF_REPEAT_MS) continue;
      if (blockedRef.current[h.label] && now - blockedRef.current[h.label] < BLOCK_MS) continue;
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
        replaces: replaces && h.reference?.book === replaces.reference?.book ? replaces.label : undefined,
      });
      if (replaces && h.reference?.book === replaces.reference?.book) replaces = undefined;
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
    if (listeningRef.current) aiLinesRef.current.push({ at: Date.now(), text: cleaned });
    if (transcriptRef.current.length > 200) transcriptRef.current.shift();
    noteFromLine(stRef.current, cleaned);
    sync();
    void detect(cleaned, line);
    void quoteCheck(cleaned);
  }

  function matchCommand(text: string): boolean {
    const norm = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    const now = Date.now();
    const once = () => {
      if (now - lastCmdAt.current < 1200) return false;
      lastCmdAt.current = now;
      return true;
    };
    const cur = lastVerse.current?.reference;
    // "jump to verse 15", "go to verse fifteen"
    const jumpVerse = norm.match(/(?:jump|go|skip|turn|move|fast forward)\s+(?:back\s+)?to\s+(?:verse|vs|v)\s+([a-z0-9 ]+)/);
    // "jump to chapter 2", "go to chapter four verse five"
    const jumpChapter = norm.match(/(?:jump|go|skip|turn|move)\s+(?:back\s+)?to\s+chapter\s+([a-z0-9 ]+?)(?:\s+(?:verse|vs|v|versus)\s+([a-z0-9 ]+))?$/);
    if (jumpChapter && cur && !hasBookName(norm)) {
      const c = spokenNumber(jumpChapter[1]);
      const v = jumpChapter[2] ? spokenNumber(jumpChapter[2]) : 1;
      if (c && v) {
        if (once()) void showInBook(c, v, "jump to a chapter");
        return true;
      }
    }
    if (jumpVerse && cur) {
      const v = spokenNumber(jumpVerse[1]);
      if (v) {
        if (once()) void showInBook(cur.chapter, v, "jump to a verse");
        return true;
      }
    }
    // "next chapter", "previous chapter"
    if (cur && /\b(?:next|following) chapter\b/.test(norm) && !hasBookName(norm)) {
      if (once()) void showInBook(cur.chapter + 1, 1, "move to the next chapter");
      return true;
    }
    if (cur && /\b(?:previous|last) chapter\b/.test(norm) && !hasBookName(norm)) {
      if (once()) void showInBook(Math.max(1, cur.chapter - 1), 1, "go back a chapter");
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
    // "Next." on its own (or "okay next", "next please").
    const bareNext = /^(?:ok(?:ay)? |and |the )?next(?: please| one)?$/.test(norm);
    if (navOnly && (bareNext || nextPhrases.some((p) => norm.includes(p)))) {
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

  // A partial is the segment so far, updated while the speaker is still
  // talking. With Deepgram and Nemotron, which only extend what they heard, a
  // chapter:verse hit fires from the first partial that has it (settleTail
  // keeps "John 3 1" on the way to "John 3 16" from firing). Whisper
  // re-transcribes the whole segment every half second and invents references
  // from half-heard audio, so there a hit must appear in two partials in a row
  // (on the latency fixtures one partial gave 57 wrong verses instead of 12).
  // If a later partial, moments after, no longer says the verse on screen and
  // names a new one in the same book, the new one replaces it. Commands and
  // corrections wait for the final transcript.
  async function onPartial(text: string, ms: number, seg: number) {
    const p = partialRef.current;
    if (seg !== p.seg) {
      partialRef.current = { seg, text: "", labels: new Set(), fired: [], out: new Set() };
    }
    const cleaned = cleanText(text);
    partialRef.current.text = cleaned;
    // A bare "HSP" acts on the first partial: speed matters most here.
    const hsp = hspCommand(cleaned);
    if (hsp !== null && hspSegRef.current !== seg) {
      if (hsp === "") {
        hspSegRef.current = seg;
        void undoLast();
      }
      return;
    }
    if (hsp !== null) return;
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
    const said = new Set(found.filter((h) => h.reference && h.reference.verse != null).map((h) => h.label));
    const before = cur.labels;
    cur.labels = said;
    const fresh = found.filter((h) => said.has(h.label) && !cur.out.has(h.label) && (streamingRef.current || before.has(h.label)));
    if (!fresh.length) return;
    // Only within one book: "verse thirty" becoming "verse thirty two" is a
    // mishearing; a new book is a new reference (or context that moved).
    const live = slideRef.current?.kind === "verse" ? lastVerse.current : null;
    const replaces =
      live && cur.fired.includes(live.label) && !said.has(live.label) && Date.now() - verseShownAt.current <= SWAP_MS
        ? live
        : undefined;
    const line: TrLine = { text: cleaned, labels: [] };
    queueHits(fresh, line, replaces);
    if (replaces && cardsRef.current.some((c) => c.replaces === replaces.label && c.status === "pending")) {
      cur.out.add(replaces.label);
      cur.fired = cur.fired.filter((l) => l !== replaces.label);
    }
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
        to: last.end_verse ?? last.verse,
        translation: id,
      });
      const groups = groupVerses(slides, perSlideRef.current) as VerseHit[];
      if (groups.length && !superseded()) {
        seqRef.current = { slides: groups, idx: Math.min(seqr.idx, groups.length - 1) };
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
    partialRef.current = { seg: -1, text: "", labels: new Set(), fired: [], out: new Set() };
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
    // "HSP ..." works even under Hold: it is how the pulpit corrects the screen.
    const hsp = hspCommand(text);
    if (hsp !== null) {
      // The bare "HSP" of this sentence already acted on its partial.
      if (!(hspSegRef.current === seg && hsp === "")) void handleHsp(hsp, seg);
      sync();
      return;
    }
    // "Clear the screen" / "clear the board" / "take it down".
    const normT = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    if (isClearCommand(normT)) {
      void clearScreen();
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
  const preview = <SlideView slide={slide} theme={liveTheme} idle="Nothing on screen" />;
  const hs = sttHealth(listening, healthRef.current, now, inputLost);
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
      {slide?.kind === "video" && (
        <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-black/60 p-0.5 text-white">
          {(["play", "pause", "restart"] as const).map((a) => (
            <Button
              key={a}
              size="icon"
              variant="ghost"
              className="size-7 text-white hover:bg-white/15 hover:text-white"
              title={a === "play" ? "Play" : a === "pause" ? "Pause" : "Restart"}
              onClick={() => {
                const v = videoSound.current;
                if (!v) return;
                if (a === "pause") v.pause();
                else {
                  if (a === "restart") v.currentTime = 0;
                  void v.play().catch(() => {});
                }
              }}
            >
              {a === "play" ? <Play /> : a === "pause" ? <Pause /> : <RotateCw />}
            </Button>
          ))}
        </div>
      )}
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
            <img src="/logo.svg" alt="" className="size-9" />
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-wide">Agent HSP</div>
              <div className="text-[11px] text-muted-foreground">High Speed Projection</div>
            </div>
          </div>
          <Tabs value={view} onValueChange={(v) => setView(v as typeof view)}>
            <TabsList>
              <TabsTrigger value="console"><MonitorPlay /> Live</TabsTrigger>
              <TabsTrigger value="service"><ListOrdered /> Service</TabsTrigger>
              <TabsTrigger value="media"><Clapperboard /> Media</TabsTrigger>
              <TabsTrigger value="theme"><Palette /> Look</TabsTrigger>
              <TabsTrigger value="downloads"><BookOpen /> Bibles</TabsTrigger>
              <TabsTrigger value="settings"><Settings2 /> Settings</TabsTrigger>
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
          <ProjectorMenu open={projectorOpen} />
          <Button onClick={toggleListen} className={cn("w-28", listening && "bg-destructive text-white hover:bg-destructive/90")}>
            {listening ? <><Square /> Stop</> : <><Mic /> Listen</>}
          </Button>
        </header>

        {listening && inputLost && (
          <div role="alert" className="flex shrink-0 items-center gap-2 bg-destructive px-4 py-2 text-sm font-medium text-white">
            <MicOff className="size-4 shrink-0" />
            No sound from {inputLost.name} since {new Date(inputLost.since).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Check its
            cable and power. Listening carries on by itself when it is back.
          </div>
        )}
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
              setTheme={setOutTheme}
              showSlide={showItemSlide}
              scriptureSlides={scriptureSlides}
              translations={translations}
              translation={trId}
              perSlide={perSlide}
              media={media}
              onEnterItem={enterItem}
              onItemAudio={itemAudio}
              registerNav={(n) => {
                navRef.current = n;
              }}
              setStatus={setMicStatus}
            />
          ) : view === "media" ? (
            <MediaLibrary
              media={media}
              setMedia={setMedia}
              folders={mediaFolders}
              onPlayAudio={(m) => audioRef.current?.play(m)}
              onShowVideo={(m) => void showVideo(m)}
              onAddToService={addMediaToService}
              progress={ytProgress}
              setProgress={setYtProgress}
              songs={library.songs}
              onAddSongs={addSongs}
            />
          ) : view === "downloads" ? (
            <ScrollArea className="h-full">
              <div className="mx-auto flex max-w-4xl flex-col gap-4 p-1">
                <Panel title="Bible translations">
                  <p className="text-sm text-muted-foreground">
                    Bundled, free to use: KJV, ASV, WEB, BBE and the Berean Standard Bible (public domain), plus the
                    Literal Standard Version and Free Bible Version (CC BY-SA 4.0). Import any other translation as
                    Zefania, OpenSong or OSIS XML, or our JSON.
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
                    <span className="text-sm text-muted-foreground">{translations.length} translations loaded.</span>
                  </div>
                </Panel>
                <Panel title="Your translations">
                  <div className="divide-y rounded-md border">
                    {translations.map((t) => (
                      <div key={t.id} className="flex items-start gap-3 p-3">
                        <Badge variant="outline" className="mt-0.5 w-14 justify-center font-mono">{t.abbrev || t.id.toUpperCase()}</Badge>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium">
                            {t.name}
                            {t.edition && <span className="font-normal text-muted-foreground"> · {t.edition}</span>}
                          </div>
                          <div className="line-clamp-2 text-xs text-muted-foreground">
                            {t.copyright || (t.bundled ? "" : "No copyright notice yet. Add the publisher's notice with Edit.")}
                          </div>
                        </div>
                        {t.bundled ? (
                          <Badge variant="secondary">Bundled</Badge>
                        ) : (
                          <Button size="sm" variant="outline" onClick={() => setEditTr({ ...t })}>
                            <Pencil /> Edit
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Slides show the short name after the reference (JOHN 3:16 · NLT), as most publishers ask. Switch to full names on the Look page.
                  </p>
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
          ) : view === "settings" ? (
            <ScrollArea className="h-full">
              <div className="mx-auto grid max-w-6xl items-start gap-4 p-1 lg:grid-cols-2">
                <div className="flex flex-col gap-4">
                  <div className="rounded-lg border bg-card p-4">
                  <Section label="App look (this console)">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="mode">Dark mode</Label>
                      <Switch id="mode" checked={mode === "dark"} onCheckedChange={(c) => setMode(c ? "dark" : "light")} />
                    </div>
                    <div className="text-xs text-muted-foreground">Built in</div>
                    <div className="flex flex-wrap gap-2">
                      {PRESETS.map((p) => (
                        <Button key={p.name} size="sm" variant={uiTheme?.name === p.name ? "default" : "outline"} onClick={() => setUiTheme(p)}>
                          {p.name}
                        </Button>
                      ))}
                    </div>
                    <div className="text-xs text-muted-foreground">Your themes</div>
                    <div className="flex flex-wrap gap-2">
                      {myThemes.length === 0 && <span className="text-xs text-muted-foreground">None yet. Themes you add below are kept here.</span>}
                      {myThemes.map((p) => (
                        <div key={p.name} className="flex items-center">
                          <Button
                            size="sm"
                            variant={uiTheme?.name === p.name ? "default" : "outline"}
                            className="rounded-r-none"
                            onClick={() => setUiTheme(p)}
                          >
                            <ThemeDots t={p} /> {p.name}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-l-none border-l-0 px-2"
                            title={"Remove " + p.name}
                            onClick={() => {
                              setMyThemes(removeCustomTheme(p.name));
                              if (uiTheme?.name === p.name) setUiTheme(PRESETS[0]);
                            }}
                          >
                            <X />
                          </Button>
                        </div>
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
                      <Input
                        className="h-8 flex-1 text-xs"
                        placeholder="Name (optional)"
                        value={themeName}
                        onChange={(e) => setThemeName(e.target.value)}
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!themeInput.trim()}
                        onClick={() =>
                          void loadTheme(themeInput)
                            .then((t) => {
                              const taken = PRESETS.map((p) => p.name);
                              const wanted = themeName.trim() || (t.name && t.name !== "Custom" ? t.name : uniqueName("Custom", [...taken, ...myThemes.map((m) => m.name)]));
                              const { theme, list } = saveCustomTheme({ ...t, name: wanted });
                              setMyThemes(list);
                              setUiTheme(theme);
                              setThemeInput("");
                              setThemeName("");
                              toast.success("Saved and applied: " + theme.name);
                            })
                            .catch((e) => toast.error(String(e.message || e)))
                        }
                      >
                        <Palette /> Save and apply
                      </Button>
                      <Button size="sm" variant="link" onClick={() => openLink("https://tweakcn.com/editor/theme")}>Open tweakcn</Button>
                    </div>
                  </Section>
                  </div>
                  <div className="rounded-lg border bg-card p-4">
                  <Section label="Speech model">
                    <div className="flex gap-2">
                      <Select value={model} onValueChange={setModel}>
                        <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectLabel>Best · verses in about a second</SelectLabel>
                            {engines.nemotron && <SelectItem value="nemotron-160">Nemotron · on this computer, free, offline</SelectItem>}
                            <SelectItem value="deepgram">Deepgram · online, paid, needs good internet</SelectItem>
                          </SelectGroup>
                          <SelectSeparator />
                          <SelectGroup>
                            <SelectLabel>Better · 2 to 3 seconds</SelectLabel>
                            <SelectItem value="small.en">Whisper small · most accurate Whisper</SelectItem>
                            {engines.nemotron && <SelectItem value="nemotron-560">Nemotron light · for slower computers</SelectItem>}
                          </SelectGroup>
                          <SelectSeparator />
                          <SelectGroup>
                            <SelectLabel>Good · older or slower computers</SelectLabel>
                            <SelectItem value="base.en">Whisper base · balanced</SelectItem>
                            <SelectItem value="tiny.en">Whisper tiny · lightest</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <Button variant="secondary" onClick={loadModel}><Download /> Load</Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {modelStatus || (model === "deepgram" ? "Online: nothing to download." : "Press Load once to download or check the model.")}
                    </p>
                    {model === "deepgram" && (
                      <div className="flex flex-col gap-1.5">
                        {dgKeySaved && !dgReplacing ? (
                          <div className="flex items-center gap-2 rounded-md border border-live/40 bg-live/10 px-3 py-2 text-sm">
                            <Check className="size-4 text-live" />
                            <span className="flex-1">Deepgram key saved on this computer. Nothing more to do.</span>
                            <Button size="sm" variant="ghost" onClick={() => setDgReplacing(true)}>Replace</Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                void invoke("set_deepgram_key", { key: "" }).then(() => {
                                  setDgKeySaved(false);
                                  toast.success("Deepgram key removed.");
                                })
                              }
                            >
                              Remove
                            </Button>
                          </div>
                        ) : (
                          <div className="flex gap-2">
                            <Input
                              type="password"
                              autoComplete="off"
                              placeholder="Paste your Deepgram API key"
                              value={dgKey}
                              onChange={(e) => setDgKey(e.target.value)}
                            />
                            <Button
                              variant="secondary"
                              disabled={!dgKey.trim()}
                              onClick={() =>
                                void invoke("set_deepgram_key", { key: dgKey })
                                  .then(() => {
                                    setDgKey("");
                                    setDgKeySaved(true);
                                    setDgReplacing(false);
                                    toast.success("Deepgram key saved on this computer.");
                                  })
                                  .catch((e) => toast.error(String(e)))
                              }
                            >
                              Save key
                            </Button>
                            {dgReplacing && <Button variant="ghost" onClick={() => setDgReplacing(false)}>Cancel</Button>}
                          </div>
                        )}
                        <p className="text-xs text-muted-foreground">
                          Sermon audio is sent to Deepgram while listening. About $0.50 per hour of listening.
                        </p>
                      </div>
                    )}
                  </Section>
                  </div>
                  <div className="rounded-lg border bg-card p-4">
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
                  </div>
                </div>
                <div className="flex flex-col gap-4">
                  <div className="rounded-lg border bg-card p-4">
                  <Section label="AI summary">
                    <AiSettings onChange={setLlm} />
                  </Section>
                  </div>
                  <div className="rounded-lg border bg-card p-4">
                  <Section label="Recordings">
                    <div className="flex items-center gap-2">
                      <Button variant="outline" onClick={() => void invoke("open_session_folder", { dir: null })}>
                        <FolderOpen /> Open recordings folder
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Every time you press Listen, the service is recorded. Stop saves the recording (audio.m4a), transcript.txt, summary.md and
                      verses.md in a folder named by date and time.
                    </p>
                  </Section>
                  </div>
                  <div className="rounded-lg border bg-card p-4">
                  <Section label="Setup and problems">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="outline" onClick={() => setSetupOpen(true)}>
                        <Download /> Run setup again
                      </Button>
                      <Button variant="outline" onClick={() => void invoke("open_log_folder").catch((e) => toast.error(String(e)))}>
                        <FolderOpen /> Open log folder
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Errors are written to agent-hsp.log in the log folder. Send that file when reporting a problem.
                    </p>
                  </Section>
                  </div>
                </div>
              </div>
            </ScrollArea>
          ) : view === "theme" ? (
            <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)] grid-cols-[minmax(320px,420px)_1fr] gap-3">
              <ScrollArea className="h-full rounded-lg border bg-card">
                <Accordion type="multiple" defaultValue={["background", "stock"]} className="px-4">
                  <AccordionItem value="background">
                    <AccordionTrigger>Background colour</AccordionTrigger>
                    <AccordionContent className="flex flex-col gap-3">
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
                    <p className="text-xs text-muted-foreground">
                      To use your own pictures or videos, open "Photos and motion" below and choose My photos or My motion.
                    </p>
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="stock">
                    <AccordionTrigger>Photos and motion</AccordionTrigger>
                    <AccordionContent className="flex flex-col gap-3">
                      <Backgrounds theme={outTheme} setTheme={setOutTheme} setStatus={setMicStatus} />
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="text">
                    <AccordionTrigger>Text and dimming</AccordionTrigger>
                    <AccordionContent className="flex flex-col gap-4">
                      <Section label={"Dim the background · " + Math.round(outTheme.overlay * 100) + "%"}>
                    <Slider min={0} max={85} value={[Math.round(outTheme.overlay * 100)]} onValueChange={(v) => setOutTheme({ ...outTheme, overlay: v[0] / 100 })} />
                      </Section>
                      <Section label={"Text size · " + textPct + "%"}>
                    <Slider min={60} max={220} step={5} value={[textPct]} onValueChange={(v) => setOutTheme({ ...outTheme, textScale: v[0] / 100 })} />
                      </Section>
                      <Section label="Translation on slides">
                        <ToggleGroup type="single" variant="outline" value={trLabel} onValueChange={(v) => v && setTrLabel(v as "abbrev" | "name")}>
                          <ToggleGroupItem value="abbrev" className="px-3">Short (NLT)</ToggleGroupItem>
                          <ToggleGroupItem value="name" className="px-3">Full name</ToggleGroupItem>
                        </ToggleGroup>
                      </Section>
                      <Section label="Verses per slide">
                        <ToggleGroup
                          type="single"
                          variant="outline"
                          value={String(perSlide)}
                          onValueChange={(v) => v && setPerSlide(parsePerSlide(v))}
                        >
                          <ToggleGroupItem value="fit" className="px-3">As many as fit</ToggleGroupItem>
                          <ToggleGroupItem value="1" className="px-3">1</ToggleGroupItem>
                          <ToggleGroupItem value="2" className="px-3">2</ToggleGroupItem>
                          <ToggleGroupItem value="3" className="px-3">3</ToggleGroupItem>
                        </ToggleGroup>
                        <p className="text-xs text-muted-foreground">
                          For ranges like John 3:16-17. "As many as fit" keeps short ranges on one slide and splits long passages.
                        </p>
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
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="logos">
                    <AccordionTrigger>Church name and corner logos</AccordionTrigger>
                    <AccordionContent className="flex flex-col gap-4">
                      <Section label="Church name">
                    <Input value={outTheme.churchName ?? ""} placeholder="AMC CHURCH" onChange={(e) => setOutTheme({ ...outTheme, churchName: e.target.value })} />
                    <p className="text-xs text-muted-foreground">Shown on the Logo screen when it has no picture.</p>
                      </Section>
                      <CornerSettings theme={outTheme} setTheme={setOutTheme} />
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
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
                        <SlideView slide={sl} theme={outTheme} still />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)] grid-cols-[minmax(260px,1fr)_minmax(420px,2fr)_minmax(260px,1fr)] gap-3">
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
                            <SelectItem key={t.id} value={t.id}>{t.abbrev && t.abbrev !== t.name ? t.abbrev + " · " + t.name : t.name}</SelectItem>
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
                    {llm?.enabled ? (
                      <AiNotes ai={aiRef.current} model={llm.model} listening={listening} onShow={(l) => void showLabel(l)} onRefresh={() => void refreshAi()} />
                    ) : (
                      <>
                        {stRef.current.title && <div className="text-sm font-semibold">{stRef.current.title}</div>}
                        {stRef.current.points.map((p) => (
                          <div key={p.num} className="text-sm">{p.num}. {p.text}</div>
                        ))}
                        {stRef.current.notes.length === 0 && <Empty>Key lines and verses collect here. Turn on the AI summary in Settings for a real outline.</Empty>}
                        <div className="flex flex-col gap-1">
                          {stRef.current.notes.slice(-8).map((n, i) => (
                            <div key={i} className="border-l-2 border-primary/40 pl-2 text-xs text-muted-foreground">{n}</div>
                          ))}
                        </div>
                      </>
                    )}
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
        <AudioPlayer ref={audioRef} onStatus={setMicStatus} />
        <video ref={videoSound} className="hidden" playsInline preload="auto" />

        <Dialog open={!!editTr} onOpenChange={(o) => !o && setEditTr(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Translation details</DialogTitle>
              <DialogDescription>How this translation is named on slides and in the Bibles list.</DialogDescription>
            </DialogHeader>
            {editTr && (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-[120px_1fr] items-center gap-2">
                  <Label>Short name</Label>
                  <Input value={editTr.abbrev} placeholder="NLT" onChange={(e) => setEditTr({ ...editTr, abbrev: e.target.value })} />
                  <Label>Full name</Label>
                  <Input value={editTr.name} placeholder="New Living Translation" onChange={(e) => setEditTr({ ...editTr, name: e.target.value })} />
                  <Label>Edition</Label>
                  <Input value={editTr.edition} placeholder="2004, second edition 2015" onChange={(e) => setEditTr({ ...editTr, edition: e.target.value })} />
                </div>
                <Label>Copyright notice</Label>
                <Textarea
                  rows={4}
                  value={editTr.copyright}
                  placeholder="Holy Bible, New Living Translation, copyright © 1996, 2004, 2015 by Tyndale House Foundation. Used by permission of Tyndale House Publishers."
                  onChange={(e) => setEditTr({ ...editTr, copyright: e.target.value })}
                />
                <div className="flex items-center justify-between gap-2">
                  <Button
                    variant="ghost"
                    className="text-destructive"
                    onClick={() =>
                      void invoke("remove_translation", { id: editTr.id })
                        .then(() => {
                          toast.success("Removed " + editTr.name);
                          if (trIdRef.current === editTr.id) changeTr("kjv");
                          setEditTr(null);
                          void refreshTranslations();
                        })
                        .catch((e) => toast.error(String(e)))
                    }
                  >
                    <Trash2 /> Remove translation
                  </Button>
                  <Button
                    onClick={() =>
                      void invoke("update_translation_info", {
                        id: editTr.id,
                        name: editTr.name,
                        abbrev: editTr.abbrev,
                        edition: editTr.edition,
                        copyright: editTr.copyright,
                      })
                        .then(() => {
                          toast.success("Saved " + (editTr.abbrev || editTr.name));
                          setEditTr(null);
                          void refreshTranslations();
                        })
                        .catch((e) => toast.error(String(e)))
                    }
                  >
                    Save
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
        <Dialog open={stillPrompt !== null} onOpenChange={(o) => !o && keepListening()}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Still listening?</DialogTitle>
              <DialogDescription>
                Deepgram charges for every minute it listens. Listening stops in{" "}
                {stillPrompt !== null && clockLeft(stillPrompt - Date.now())} unless you keep it going. The recording so far is saved
                either way.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Button size="lg" onClick={keepListening}>
                Keep listening
              </Button>
              <Button size="lg" variant="secondary" onClick={() => void stopListening()}>
                Stop now
              </Button>
            </div>
          </DialogContent>
        </Dialog>
        <Dialog open={!!continuePrompt} onOpenChange={(o) => !o && setContinuePrompt(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Same service, or a new one?</DialogTitle>
              <DialogDescription>
                {continuePrompt &&
                  "The last recording (" + continuePrompt.name.replace("_", " at ").replace(/-(\d\d)$/, ":$1") + ", " +
                    Math.round(continuePrompt.audio_s / 60) + " min) ended " +
                    (continuePrompt.age_s < 120 ? "just now" : Math.round(continuePrompt.age_s / 60) + " min ago") + "."}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Button size="lg" onClick={() => continuePrompt && void startListening(continuePrompt.dir)}>
                Continue the same service
              </Button>
              <Button size="lg" variant="secondary" onClick={() => void startListening(null)}>
                Start a new service
              </Button>
              <p className="text-xs text-muted-foreground">
                Continuing adds to the same recording, transcript and summary. A new service gets its own folder.
              </p>
            </div>
          </DialogContent>
        </Dialog>
        <Setup
          open={setupOpen}
          onClose={() => {
            setSetupOpen(false);
            try {
              localStorage.setItem("hsp-setup-done", "1");
            } catch {
              /* ignore */
            }
          }}
          nemotron={engines.nemotron}
          whisperModel={/Mac/i.test(navigator.userAgent) ? "small.en" : "base.en"}
          onAddSongs={addSongs}
          onModel={setModel}
        />
        <Toaster position="bottom-right" />
      </div>
    </TooltipProvider>
  );
}

/** Three colour dots from a theme, so saved themes are recognisable. */
function ThemeDots({ t }: { t: UiTheme }) {
  const v = (k: string) => t.dark[k] || t.light[k];
  const cols = [v("--primary"), v("--background"), v("--accent")].filter(Boolean) as string[];
  if (!cols.length) return null;
  return (
    <span className="flex -space-x-1">
      {cols.map((c, i) => (
        <span key={i} className="size-3 rounded-full border border-black/20" style={{ background: c }} />
      ))}
    </span>
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

