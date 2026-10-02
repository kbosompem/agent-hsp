// Tests for src/lib/voice.ts.
//   npx esbuild scripts/test-voice.ts --bundle --platform=node --outfile=/tmp/tv.js && node /tmp/tv.js
import { contentWords, findLoaded, readPast, translationRequest } from "../src/lib/voice";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? "ok   " : "FAIL ") + name + (ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
}

const M5 = [
  "And seeing the multitudes, he went up into a mountain: and when he was set, his disciples came unto him:",
  "And he opened his mouth, and taught them, saying,",
  "Blessed are the poor in spirit: for theirs is the kingdom of heaven.",
  "Blessed are they that mourn: for they shall be comforted.",
  "Blessed are the meek: for they shall inherit the earth.",
];
const heard = (s: string) => contentWords(s);

// reading in KJV
check("not yet: verse 1 half read", readPast(heard("and seeing the multitudes he went up into a mountain"), M5[0], M5[1]), false);
check("not yet: beatitude 4 opening", readPast(heard("blessed are they that mourn"), M5[3], M5[4]), false);
check("not yet: started verse 1", readPast(heard("and seeing the multitudes he went up"), M5[0], M5[1]), false);
check("done: read verse 1", readPast(heard("and seeing the multitudes he went up into a mountain and when he was set his disciples came unto him"), M5[0], M5[1]), true);
check("done: started verse 2", readPast(heard("he opened his mouth and taught them"), M5[0], M5[1]), true);
check("beatitude 3 not done by 'blessed are'", readPast(heard("blessed are the poor"), M5[2], M5[3]), false);
check("beatitude 3 done", readPast(heard("blessed are the poor in spirit for theirs is the kingdom of heaven"), M5[2], M5[3]), true);
check("beatitude 3 -> next by 'they that mourn'", readPast(heard("blessed are those who mourn"), M5[2], M5[3]), true);
// reading from a modern translation while KJV is on screen
check("NIV reading of 5:5", readPast(heard("blessed are the meek for they will inherit the earth"), M5[4], null), true);
// Known limit: a heavy rewording shares too few words ("crowds"/"multitudes",
// "sat down"/"was set"). The app waits; the operator presses Space or the
// preacher says "next verse".
check("NIV reading of 5:1 (known limit: waits)", readPast(heard("now when jesus saw the crowds he went up on a mountainside and sat down his disciples came to him"), M5[0], M5[1]), false);
// talking about the verse is not reading it
check("comment is not reading", readPast(heard("you see the meek are people who are gentle"), M5[4], null), false);

// translation requests
check("show nlt", translationRequest("Show NLT."), { code: "nlt", name: "New Living Translation" });
check("N.L.T.", translationRequest("Can we see it in the N.L.T.?"), { code: "nlt", name: "New Living Translation" });
check("american standard version", translationRequest("American Standard Version."), { code: "asv", name: "American Standard Version" });
check("new american standard", translationRequest("let's read the New American Standard"), { code: "nasb", name: "New American Standard Bible" });
check("amplified", translationRequest("The amplified version says"), { code: "amp", name: "Amplified Bible" });
check("amplified alone", translationRequest("Amplified."), { code: "amp", name: "Amplified Bible" });
check("read it in the niv", translationRequest("read it in the NIV please"), { code: "niv", name: "New International Version" });
check("king james mention in passing", translationRequest("when King James commissioned the translators in sixteen eleven they met at Hampton Court"), null);
check("message is not The Message", translationRequest("the message of the cross is foolishness"), null);
check("message bible", translationRequest("show it in the Message Bible"), { code: "msg", name: "The Message" });

check("in the niv it says is commentary", translationRequest("In the NIV it says that he went up"), null);
check("from the king james commentary", translationRequest("from the King James we learn that"), null);
check("amp it up", translationRequest("let's amp it up church"), null);
check("let's N.L.T.", translationRequest("let's see the N.L.T."), { code: "nlt", name: "New Living Translation" });
check("I N.I.V.", translationRequest("can I see the N.I.V. please"), { code: "niv", name: "New International Version" });
check("nirv not niv", translationRequest("show the new international reader's version"), { code: "nirv", name: "New International Reader's Version" });
check("new king james not king james", translationRequest("read it in the new king james"), { code: "nkjv", name: "New King James Version" });
check("loved vs love", readPast(heard("for god so love the world that he gave his only begotten son"), "For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.", null), false);
check("loved vs love, finished", readPast(heard("for god so love the world he gave his only son whoever believes in him shall not perish but have eternal life"), "For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.", null), true);

const loaded = [
  { id: "kjv", name: "King James Version" },
  { id: "asv", name: "American Standard Version (1901)" },
  { id: "nasb95", name: "New American Standard Bible 1995" },
  { id: "imported", name: "New Living Translation" },
];
check("find asv not nasb", findLoaded("asv", loaded)?.id, "asv");
check("find nasb by name", findLoaded("nasb", loaded)?.id, "nasb95");
check("find nlt by name", findLoaded("nlt", loaded)?.id, "imported");
check("amp not loaded", findLoaded("amp", loaded), undefined);

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
