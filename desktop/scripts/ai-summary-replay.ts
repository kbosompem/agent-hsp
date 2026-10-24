// Replay a recorded sermon (fixtures/real/<slug>) through the console's AI
// summary prompt, as if live: one update every STEP_MIN minutes of sermon,
// then the final pass. Prints how the summary grows and, at the end, the
// hand-written reference summary from the labels.
//   npx esbuild scripts/ai-summary-replay.ts --bundle --platform=node --outfile=/tmp/ai-replay.js
//   LLM_PROTOCOL=openai LLM_BASE=https://api.z.ai/api/paas/v4 LLM_MODEL=glm-5.3-flash LLM_KEY=... \
//     node /tmp/ai-replay.js ../fixtures/real 20111129-can-do-man-2
// "Shown" verses are the labelled explicit references at the moment they were spoken.
// FINAL_ONLY=1 skips the live updates and runs only the final pass.
import { readFileSync } from "fs";
import { AiLine, AiSummary, AiVerse, SUMMARY_SYSTEM, parseSummary, summaryMessage } from "../src/lib/aisummary";

const STEP_MIN = Number(process.env.STEP_MIN || 5);
const [dir, slug] = process.argv.slice(2);
const ref = JSON.parse(readFileSync(`${dir}/${slug}.ref.json`, "utf8"));
const labels = JSON.parse(readFileSync(`${dir}/labels/${slug}.labels.json`, "utf8"));

const lines: AiLine[] = ref.transcription.map((s: any) => ({ at: s.offsets.to, text: s.text.trim() })).filter((l: AiLine) => l.text);
const verses: AiVerse[] = [];
for (const r of labels.refs) {
  if (r.kind !== "explicit" || verses.some((v) => v.label === r.label)) continue;
  verses.push({ at: r.spoken_end_s * 1000, label: r.label, text: r.heard || "", translation: "-" });
}
verses.sort((a, b) => a.at - b.at);

async function complete(system: string, user: string): Promise<string> {
  const base = process.env.LLM_BASE!.replace(/\/$/, "");
  const key = process.env.LLM_KEY || "";
  const model = process.env.LLM_MODEL!;
  if (process.env.LLM_PROTOCOL === "anthropic") {
    const r = await fetch(base.replace(/\/v1$/, "") + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 2000, system, messages: [{ role: "user", content: user }] }),
    });
    const v: any = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(v).slice(0, 300));
    return v.content.map((p: any) => p.text || "").join("");
  }
  const r = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: "Bearer " + key } : {}) },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      ...(/api\.z\.ai|bigmodel\.cn/.test(base) ? { reasoning_effort: "low", response_format: { type: "json_object" } } : {}),
    }),
  });
  const v: any = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(v).slice(0, 300));
  return v.choices[0].message.content || "";
}

function print(s: AiSummary) {
  console.log("  " + (s.title || "(no title)") + (s.big_idea ? " · " + s.big_idea : ""));
  s.points.forEach((p, i) => console.log(`   ${i + 1}. ${p.point}${p.verses.length ? "  [" + p.verses.join(", ") + "]" : ""}`));
}

async function main() {
  const end = lines[lines.length - 1].at;
  let prev: AiSummary | null = null;
  for (let t = process.env.FINAL_ONLY ? end : STEP_MIN * 60000; ; t += STEP_MIN * 60000) {
    const final = t >= end;
    const upTo = final ? end : t;
    const ls = lines.filter((l) => l.at <= upTo);
    const vs = verses.filter((v) => v.at <= upTo);
    const t0 = Date.now();
    const reply = await complete(SUMMARY_SYSTEM, summaryMessage(ls, vs, 0, final));
    const got = parseSummary(reply, vs.map((v) => v.label));
    console.log(`${final ? "FINAL" : Math.round(upTo / 60000) + " min"} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    if (!got) console.log("  NOT A SUMMARY: " + reply.slice(0, 300));
    else {
      print(got);
      prev = got;
    }
    if (final) break;
  }
  console.log("REFERENCE");
  print({ title: labels.summary.title, big_idea: labels.summary.big_idea, points: labels.summary.points.map((p: any) => ({ point: p.text, detail: "", verses: p.verses })) });
}

void main();
