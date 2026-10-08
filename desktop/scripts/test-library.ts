// Song parsing and slide splitting. Run:
//   npx esbuild scripts/test-library.ts --bundle --platform=node --outfile=/tmp/tl.js && node /tmp/tl.js
import { parsePlainSong, parseSongFile, songSlides, textSlides, sectionTag } from "../src/lib/library";
let fail = 0;
const eq = (a: unknown, b: unknown, m: string) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log("FAIL", m, JSON.stringify(a), "!=", JSON.stringify(b)); } };
eq(sectionTag("Verse 1"), "V1", "verse 1");
eq(sectionTag("[Chorus]"), "C", "chorus");
eq(sectionTag("Bridge:"), "B", "bridge");
eq(sectionTag("Amazing grace how sweet"), null, "lyric line");
const s = parsePlainSong("Amazing Grace\n\n[Verse 1]\nAmazing grace\nhow sweet the sound\n\n[Chorus]\nMy chains are gone\n\n[Verse 2]\nTwas grace\n");
eq(s.title, "Amazing Grace", "title");
eq(s.sections.map((x) => x.tag), ["V1", "C", "V2"], "tags");
eq(s.sections[0].text, "Amazing grace\nhow sweet the sound", "v1 text");
const n = parsePlainSong("Way Maker\n\nYou are here\nmoving in our midst\n\nWay maker\nmiracle worker\n");
eq(n.sections.map((x) => x.tag), ["V1", "V2"], "no headings -> blank-line sections");
const long = parsePlainSong("T\n[Verse 1]\n1\n2\n3\n4\n5\n6\n7\n");
eq(songSlides(long).map((x) => x.body.split("\n").length), [4, 3], "split 7 lines into 4+3");
const ord = { ...s, order: ["V1", "C", "V2", "C"] };
eq(songSlides(ord).map((x) => x.label), ["Verse 1", "Chorus", "Verse 2", "Chorus"], "order");
eq(parseSongFile("a.txt", "One\n[Verse 1]\nx\n---\nTwo\n[Verse 1]\ny\n").map((x) => x.title), ["One", "Two"], "multi-song file");
eq(textSlides({ id: "1", kind: "text", title: "Announcements", body: "Youth meeting Friday\n\nBaby dedication next week" }).length, 2, "text slides");
console.log(fail ? fail + " failed" : "all passed");

// VideoPsalm loose JSON: bare keys, raw line breaks in strings, inline markup.
import { parseVideoPsalmJson } from "../src/lib/videopsalm";
const vp = parseVideoPsalmJson('{Guid:"x",Verses:[{\nText:"<s1384>OFFERING TIME\n</s>Text to give"},{ID:2,\nText:"Line two"}],\nText:"Offering Time"}');
eq(vp.map((s) => [s.title, s.sections.map((x) => x.text)]), [["Offering Time", ["OFFERING TIME\nText to give", "Line two"]]], "videopsalm song");
eq(songSlides(vp[0]).length, 2, "videopsalm verses stay one slide each");
eq(parseVideoPsalmJson('{Text:"Book",Songs:[{Verses:[{Text:"a"}],Text:"S1"},{Verses:[{Text:"b"}],Text:"S2"}]}').map((s) => s.title), ["S1", "S2"], "videopsalm songbook");
console.log(fail ? fail + " failed" : "videopsalm passed");

// Service files: export for this computer vs bundle, and merging on import.
import { buildServiceFile, mergeServiceFile, parseServiceFile, themeMedia } from "../src/lib/serviceFile";
{
  const lib0 = { version: 1 as const, songs: [{ id: "s1", title: "Way Maker", sections: [{ tag: "V1", text: "a" }], order: [] }, { id: "s2", title: "Amazing Grace", sections: [{ tag: "V1", text: "b" }], order: [] }], agendas: [] as any[], currentAgendaId: null };
  const agenda = { id: "a1", name: "Sunday", date: "2026-10-11", items: [{ id: "i1", kind: "song" as const, title: "Way Maker", songId: "s1" }, { id: "i2", kind: "scripture" as const, title: "Reading", reference: "John 3:16" }] };
  const theme: any = { bgKind: "video", gradient: "", image: "", video: "asset://x/y.mp4", overlay: 0.4, textColor: "#fff", accent: "#ff0", font: "serif", bgId: "pexels-video-1" };
  const local = buildServiceFile(agenda, lib0, theme, false);
  eq([local.file.kind, local.file.songs.length, local.media, local.file.theme?.video, local.file.theme?.bgMedia], ["local", 0, ["backgrounds/pexels-video-1.mp4"], "", "backgrounds/pexels-video-1.mp4"], "local export");
  const bundle = buildServiceFile(agenda, lib0, theme, true);
  eq(bundle.file.songs.map((s) => s.title), ["Way Maker"], "bundle carries its songs");
  // Another computer: has a different "Way Maker"? match by title; empty library gets the song added.
  const other = { version: 1 as const, songs: [] as any[], agendas: [] as any[], currentAgendaId: null };
  const m = mergeServiceFile(other, parseServiceFile(JSON.stringify(bundle.file)));
  eq([m.library.songs.length, m.missing, m.library.agendas[0].name, m.library.currentAgendaId === m.agendaId], [1, [], "Sunday", true], "bundle import adds songs");
  const m2 = mergeServiceFile(m.library, parseServiceFile(JSON.stringify(bundle.file)));
  eq([m2.library.songs.length, m2.library.agendas[0].name], [1, "Sunday (imported)"], "no duplicate songs; name kept unique");
  const m3 = mergeServiceFile(other, parseServiceFile(JSON.stringify(local.file)));
  eq(m3.missing, ["Way Maker"], "local file on another computer reports missing songs");
  let threw = false;
  try { parseServiceFile('{"hello":1}'); } catch { threw = true; }
  eq(threw, true, "rejects other JSON");
  console.log(fail ? fail + " failed" : "service files passed");
}
{
  const base: any = { bgKind: "image", gradient: "", image: "", overlay: 0, textColor: "", accent: "", font: "serif" };
  eq([themeMedia({ ...base, bgFile: "user-abc.jpg" }), themeMedia({ ...base, bgFile: "../library.json" }), themeMedia({ ...base, bgFile: ".hidden" })], ["backgrounds/user-abc.jpg", null, null], "themeMedia only plain names");
  console.log(fail ? fail + " failed" : "media names passed");
}

// Verses per slide.
import { groupVerses, combine, slideHas } from "../src/lib/verses";
{
  const v = (n: number, len = 100) => ({ label: "John 3:" + n, text: "x".repeat(len), translation: "KJV", reference: { book: 42, chapter: 3, verse: n, end_verse: null } });
  const two = groupVerses([v(16), v(17)], "fit");
  eq([two.length, two[0].label, two[0].reference?.end_verse, two[0].text.startsWith("¹⁶")], [1, "John 3:16-17", 17, true], "John 3:16-17 on one slide");
  eq(groupVerses([v(1), v(2), v(3), v(4), v(5)], "fit").map((h) => h.label), ["John 3:1-3", "John 3:4-5"], "fit splits by length");
  eq(groupVerses([v(1, 400), v(2)], "fit").map((h) => h.label), ["John 3:1", "John 3:2"], "a long verse stands alone");
  eq(groupVerses([v(1), v(2), v(3)], 1).length, 3, "one per slide");
  eq(groupVerses([v(1), v(2), v(3)], 2).map((h) => h.label), ["John 3:1-2", "John 3:3"], "two per slide");
  eq([slideHas(combine([v(16), v(17)]), 42, 3, 17), slideHas(combine([v(16), v(17)]), 42, 3, 18)], [true, false], "slideHas");
  console.log(fail ? fail + " failed" : "verses per slide passed");
}
