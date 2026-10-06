// Console look: light/dark mode and shadcn themes from tweakcn.com.
//
// A tweakcn theme is a set of CSS variables (--background, --primary, ...)
// for :root (light) and .dark. The operator can paste the CSS tweakcn shows
// under "Code", or a theme link (https://tweakcn.com/r/themes/<id>.json, the
// shadcn registry item). Either way we keep only the variable declarations
// and inject them in a <style> tag after index.css, so they override the
// defaults. Only affects the console, never the projector.

export type UiTheme = { name: string; light: Record<string, string>; dark: Record<string, string> };

const STYLE_ID = "ui-theme";
const KEY_THEME = "hsp-ui-theme";
const KEY_MODE = "hsp-ui-mode";

/** Built-in looks. "Default" uses index.css as is. */
export const PRESETS: UiTheme[] = [
  { name: "Default", light: {}, dark: {} },
  {
    name: "Midnight blue",
    light: {},
    dark: {
      "--background": "oklch(0.15 0.03 265)",
      "--card": "oklch(0.19 0.035 265)",
      "--popover": "oklch(0.21 0.035 265)",
      "--secondary": "oklch(0.25 0.04 265)",
      "--muted": "oklch(0.24 0.035 265)",
      "--border": "oklch(0.3 0.04 265)",
      "--input": "oklch(0.32 0.04 265)",
      "--primary": "oklch(0.72 0.15 250)",
      "--primary-foreground": "oklch(0.15 0.03 265)",
      "--ring": "oklch(0.72 0.15 250)",
      "--accent": "oklch(0.3 0.06 250)",
    },
  },
  {
    name: "Graphite",
    light: {
      "--primary": "oklch(0.3 0 0)",
      "--primary-foreground": "oklch(0.98 0 0)",
      "--ring": "oklch(0.3 0 0)",
      "--accent": "oklch(0.94 0 0)",
    },
    dark: {
      "--background": "oklch(0.14 0 0)",
      "--card": "oklch(0.18 0 0)",
      "--popover": "oklch(0.2 0 0)",
      "--secondary": "oklch(0.24 0 0)",
      "--muted": "oklch(0.23 0 0)",
      "--border": "oklch(0.28 0 0)",
      "--input": "oklch(0.3 0 0)",
      "--primary": "oklch(0.92 0 0)",
      "--primary-foreground": "oklch(0.15 0 0)",
      "--ring": "oklch(0.7 0 0)",
      "--accent": "oklch(0.27 0 0)",
      "--accent-foreground": "oklch(0.95 0 0)",
    },
  },
  {
    name: "Royal purple",
    light: { "--primary": "oklch(0.5 0.2 300)", "--primary-foreground": "oklch(0.98 0 0)", "--ring": "oklch(0.5 0.2 300)" },
    dark: {
      "--background": "oklch(0.15 0.025 300)",
      "--card": "oklch(0.19 0.03 300)",
      "--popover": "oklch(0.21 0.03 300)",
      "--secondary": "oklch(0.25 0.035 300)",
      "--muted": "oklch(0.24 0.03 300)",
      "--border": "oklch(0.3 0.035 300)",
      "--input": "oklch(0.32 0.035 300)",
      "--primary": "oklch(0.72 0.17 300)",
      "--primary-foreground": "oklch(0.15 0.03 300)",
      "--ring": "oklch(0.72 0.17 300)",
      "--accent": "oklch(0.3 0.06 300)",
    },
  },
];

/** Variable declarations inside the first `selector { ... }` block. */
function varsIn(css: string, selector: RegExp): Record<string, string> {
  const m = css.match(selector);
  if (!m) return {};
  const start = (m.index ?? 0) + m[0].length;
  let depth = 1;
  let i = start;
  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    i++;
  }
  const body = css.slice(start, i - 1);
  const out: Record<string, string> = {};
  for (const d of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);?/gi)) out[d[1]] = d[2].trim();
  return out;
}

/** Parse tweakcn's CSS (":root { ... } .dark { ... }"). */
export function parseThemeCss(css: string, name = "Custom"): UiTheme | null {
  const light = varsIn(css, /:root\s*\{/);
  const dark = varsIn(css, /\.dark\s*\{/);
  if (!Object.keys(light).length && !Object.keys(dark).length) return null;
  return { name, light, dark };
}

/** Parse a shadcn registry item (what a tweakcn theme link returns). */
export function parseRegistryTheme(json: any): UiTheme | null {
  const cv = json?.cssVars;
  if (!cv) return null;
  const pre = (o: Record<string, string> | undefined) =>
    Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k.startsWith("--") ? k : "--" + k, String(v)]));
  const shared = pre(cv.theme);
  return { name: json.title || json.name || "tweakcn theme", light: { ...shared, ...pre(cv.light) }, dark: { ...shared, ...pre(cv.dark) } };
}

/** Load a theme from a tweakcn link or pasted CSS / JSON. */
export async function loadTheme(input: string): Promise<UiTheme> {
  const t = await loadThemeRaw(input);
  const safe = sanitizeTheme(t);
  if (!Object.keys(safe.light).length && !Object.keys(safe.dark).length) throw new Error("No usable theme colours found.");
  return safe;
}

async function loadThemeRaw(input: string): Promise<UiTheme> {
  const s = input.trim();
  if (/^https?:\/\//.test(s)) {
    let url = s;
    // A theme page link -> its registry JSON.
    const page = s.match(/tweakcn\.com\/themes\/([^/?#]+)/);
    if (page) url = "https://tweakcn.com/r/themes/" + page[1] + ".json";
    const r = await fetch(url);
    if (!r.ok) throw new Error("Could not download the theme (" + r.status + ")");
    const t = parseRegistryTheme(await r.json());
    if (!t) throw new Error("That link is not a shadcn theme.");
    return t;
  }
  if (s.startsWith("{")) {
    const t = parseRegistryTheme(JSON.parse(s));
    if (t) return t;
  }
  const t = parseThemeCss(s);
  if (!t) throw new Error("No theme variables found. Paste the CSS from tweakcn's Code panel.");
  return t;
}

// Theme text comes from the internet or a paste, so only plain custom
// properties with simple values get through: no braces, semicolons, url(),
// @import or escapes that could break out of the declaration block.
const KEY_RE = /^--[a-z0-9-]{1,64}$/i;
const VALUE_RE = /^[a-z0-9#.,%()\s\/+*'"_-]{1,200}$/i;

function cleanVars(vars: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars || {})) {
    const val = String(v).trim();
    if (KEY_RE.test(k) && VALUE_RE.test(val) && !/url\s*\(|expression|import/i.test(val)) out[k] = val;
  }
  return out;
}

export function sanitizeTheme(t: UiTheme): UiTheme {
  return { name: String(t.name || "Custom").slice(0, 60), light: cleanVars(t.light), dark: cleanVars(t.dark) };
}

function block(sel: string, vars: Record<string, string>): string {
  const lines = Object.entries(vars).map(([k, v]) => "  " + k + ": " + v + ";");
  return lines.length ? sel + " {\n" + lines.join("\n") + "\n}\n" : "";
}

export function applyTheme(t: UiTheme) {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  const safe = sanitizeTheme(t);
  el.textContent = block(":root", safe.light) + block(".dark", safe.dark);
  try {
    localStorage.setItem(KEY_THEME, JSON.stringify(safe));
  } catch {
    /* storage full or blocked; the theme still applies for this session */
  }
}

export function savedTheme(): UiTheme {
  try {
    const s = localStorage.getItem(KEY_THEME);
    if (s) return sanitizeTheme(JSON.parse(s));
  } catch {
    /* ignore */
  }
  return PRESETS[0];
}

export type Mode = "dark" | "light";

export function applyMode(m: Mode) {
  document.documentElement.classList.toggle("dark", m === "dark");
  try {
    localStorage.setItem(KEY_MODE, m);
  } catch {
    /* ignore */
  }
}

export function savedMode(): Mode {
  try {
    // The old console stored its mode under "preso-theme".
    const m = localStorage.getItem(KEY_MODE) || localStorage.getItem("preso-theme");
    if (m === "light" || m === "dark") return m;
  } catch {
    /* ignore */
  }
  return "dark";
}
