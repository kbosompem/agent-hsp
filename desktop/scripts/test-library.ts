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
