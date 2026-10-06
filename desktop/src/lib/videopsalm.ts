// VideoPsalm import. VideoPsalm writes "loose" JSON: unquoted keys and raw
// line breaks inside strings, e.g.
//   {Guid:"...",Verses:[{ID:2,
//   Text:"Line one
//   Line two"}],Text:"Song title"}
// A song's title is its Text; each entry in Verses is one slide. Lyrics carry
// inline markup such as <b>, <s1384> (font size) and </s>.
// Agenda files (.vpagd) are zip archives holding Song_N.json files.

import { Song, newId } from "./library";

/** Turn VideoPsalm's loose JSON into strict JSON and parse it. */
export function parseLooseJson(src: string): any {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"') {
      // Copy a string, escaping raw control characters.
      out += '"';
      i++;
      while (i < n && src[i] !== '"') {
        const d = src[i];
        if (d === "\\" && i + 1 < n) {
          out += d + src[i + 1];
          i += 2;
          continue;
        }
        if (d === "\n") out += "\\n";
        else if (d === "\r") out += "";
        else if (d === "\t") out += "\\t";
        else out += d;
        i++;
      }
      out += '"';
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      // A bare word: a key if a colon follows, else a literal (true/false/null).
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      let k = j;
      while (k < n && /\s/.test(src[k])) k++;
      out += src[k] === ":" ? JSON.stringify(word) : word;
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return JSON.parse(out);
}

/** Strip VideoPsalm's inline markup and tidy whitespace. */
export function cleanLyrics(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One VideoPsalm song object -> our Song. Null if it has no lyrics. */
export function songFromVideoPsalm(o: any): Song | null {
  if (!o || !Array.isArray(o.Verses)) return null;
  const sections = o.Verses.map((v: any) => cleanLyrics(String(v?.Text ?? "")))
    .filter((t: string) => t.length > 0)
    .map((t: string, i: number) => ({ tag: "V" + (i + 1), text: t }));
  if (!sections.length) return null;
  const title = cleanLyrics(String(o.Text ?? "")).split("\n")[0] || sections[0].text.split("\n")[0];
  return { id: newId(), title, author: o.Author ? String(o.Author) : undefined, sections, order: [], keepSlides: true };
}

/** A VideoPsalm JSON file: a single song, or a songbook with Songs: [...]. */
export function parseVideoPsalmJson(content: string): Song[] {
  let d: any;
  try {
    d = parseLooseJson(content.replace(/^﻿/, ""));
  } catch {
    return [];
  }
  const list: any[] = Array.isArray(d?.Songs) ? d.Songs : Array.isArray(d) ? d : [d];
  return list.map(songFromVideoPsalm).filter((s): s is Song => s !== null);
}

// ---------- zip (.vpagd) ----------

/** Read every entry of a zip archive (stored or deflate). Uses the browser's DecompressionStream. */
export async function unzip(buf: ArrayBuffer): Promise<{ name: string; data: Uint8Array }[]> {
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  // End of central directory record: scan back from the end.
  let eocd = -1;
  for (let p = buf.byteLength - 22; p >= Math.max(0, buf.byteLength - 66000); p--) {
    if (v.getUint32(p, true) === 0x06054b50) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out: { name: string; data: Uint8Array }[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nlen = v.getUint16(p + 28, true);
    const xlen = v.getUint16(p + 30, true);
    const clen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    const lnlen = v.getUint16(local + 26, true);
    const lxlen = v.getUint16(local + 28, true);
    const start = local + 30 + lnlen + lxlen;
    const raw = u8.subarray(start, start + csize);
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8) {
      const ds = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      out.push({ name, data: new Uint8Array(await new Response(ds).arrayBuffer()) });
    }
  }
  return out;
}

/** Songs from a VideoPsalm agenda (.vpagd), in agenda order (Song_0, Song_1, ...). */
export async function parseVideoPsalmAgenda(buf: ArrayBuffer): Promise<Song[]> {
  const entries = await unzip(buf);
  const dec = new TextDecoder();
  const songs = entries
    .filter((e) => /(^|\/)Song_\d+\.json$/i.test(e.name))
    .sort((a, b) => parseInt(a.name.match(/(\d+)\.json$/i)![1]) - parseInt(b.name.match(/(\d+)\.json$/i)![1]));
  const out: Song[] = [];
  for (const e of songs) out.push(...parseVideoPsalmJson(dec.decode(e.data)));
  return out;
}
