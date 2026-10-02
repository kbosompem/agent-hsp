#!/usr/bin/env python3
"""Build the sermon results page from fixtures/real/report.json.

  python3 scripts/latency-fixture/report_page.py OUT.html
"""
import html, json, os, re, statistics, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
REAL = os.path.join(ROOT, "fixtures", "real")


def esc(s):
    return html.escape(str(s or ""))


def who_when(source):
    m = re.match(r"(\d{4})(\d{2})(\d{2}) (.*)\.(mp3|wma)$", source)
    if not m:
        return source, "", ""
    y, mo, d, rest, _ = m.groups()
    rest = re.sub(r"^\[[A-Z]+\]\s*", "", rest)
    m2 = re.match(r"(.*?)\s*-\s*((?:Rev|Pastor|Lady|Br)\b.*)$", rest)
    if m2:
        title, preacher = m2.group(1), m2.group(2)
    elif " - " in rest:
        title, preacher = rest.rsplit(" - ", 1)
    else:
        title, preacher = rest, ""
    preacher = re.sub(r"\s*-\s*BU$", "", preacher) or "Preacher not named"
    months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
    return title.strip(), preacher.strip(), f"{int(d)} {months[int(mo) - 1]} {y}"


def mmss(t):
    t = int(t)
    return f"{t // 60}:{t % 60:02d}"


def slide(kind, title, points, sub=""):
    pts = "".join(
        f'<li><span class="pt">{esc(p.get("text"))}</span>'
        + (f'<span class="vs">{esc(" · ".join(p.get("verses", [])))}</span>' if p.get("verses") else "")
        + "</li>"
        for p in points[:5]
    ) or '<li class="empty">No summary slide would be shown.</li>'
    return f"""<figure class="slide-wrap">
  <figcaption><span class="kind">{esc(kind)}</span>{f'<span class="sub">{esc(sub)}</span>' if sub else ''}</figcaption>
  <div class="slide"><div class="s-title">{esc(title)}</div><ol>{pts}</ol></div>
</figure>"""


def main():
    out = sys.argv[1]
    report = [e for e in json.load(open(os.path.join(REAL, "report.json"))) if "score" in e]
    tot = lambda key, f: sum(f(e[key]) for e in report if key in e)
    exp = tot("score", lambda s: s["scored"])
    fb, fa = tot("score", lambda s: s["found"]), tot("after", lambda s: s["found"])
    wb, wa = tot("score", lambda s: len(s["wrong"])), tot("after", lambda s: len(s["wrong"]))
    hours = sum(e["duration_s"] for e in report) / 3600
    kinds = {k: sum(e["kinds"][k] for e in report) for k in ["explicit", "chapter", "followup", "quote"]}
    delays = [h["delay"] for e in report for h in e["after"]["hits"]]
    stream = [e for e in report if "stream" in e]
    sdel = [h["delay"] for e in stream for h in e["stream"]["hits"]]
    sfound = sum(e["stream"]["found"] for e in stream)
    sexp = sum(e["stream"]["scored"] for e in stream)
    swrong = sum(len(e["stream"]["wrong"]) for e in stream)

    rows, details = [], []
    for e in sorted(report, key=lambda e: e["slug"]):
        title, preacher, date = who_when(e["source"])
        s, a = e["score"], e["after"]
        pct = lambda f, n: f"{round(100 * f / n)}%" if n else "–"
        rows.append(f"""<tr>
  <td><a href="#{esc(e['slug'])}">{esc(title)}</a><div class="meta">{esc(preacher)} · {esc(date)}</div></td>
  <td class="n">{round(e['duration_s'] / 60)}</td>
  <td class="n">{s['scored']}</td>
  <td class="n">{s['found']} <span class="arrow">→</span> <b>{a['found']}</b> <span class="pct">{pct(a['found'], a['scored'])}</span></td>
  <td class="n">{len(s['wrong'])} <span class="arrow">→</span> <b>{len(a['wrong'])}</b></td>
  <td class="n">{e['kinds']['followup']}</td>
</tr>""")
        rp = e.get("after_replay") or {}
        slides = rp.get("slides", [])
        last = slides[-1] if slides else {"title": "", "points": []}
        llm = e.get("llm")
        ref = e["labels"].get("summary", {})
        missed = "".join(
            f'<li><span class="t">{mmss(m["at"])}</span><b>{esc(m["label"])}</b> <q>{esc(m["heard"])}</q>{('<em>' + esc(m.get('note')) + '</em>') if m.get('note') else ''}</li>'
            for m in a["missed"]
        ) or "<li class='none'>None.</li>"
        wrong = "".join(
            f'<li><span class="t">{mmss(w["at"])}</span><b>{esc(w["label"])}</b> <q>{esc(w["trigger"])}</q></li>' for w in a["wrong"]
        ) or "<li class='none'>None.</li>"
        details.append(f"""<section class="sermon" id="{esc(e['slug'])}">
  <header>
    <h3>{esc(title)}</h3>
    <p class="meta">{esc(preacher)} · {esc(date)} · {round(e['duration_s'] / 60)} min · {e['kinds']['explicit']} full references, {e['kinds']['followup']} follow-ups, {e['kinds']['quote']} unnamed quotes</p>
  </header>
  <div class="slides">
    {slide("The app today", last.get("title", ""), last.get("points", []), f"{len(slides)} summary slides during the sermon")}
    {slide("Local AI draft", llm["title"], llm["points"], f"Llama 3.2 3B on this Mac · {llm['_seconds']:.0f} s") if llm else '<figure class="slide-wrap pending"><figcaption><span class="kind">Local AI draft</span></figcaption><div class="slide"><div class="s-title">Not run yet</div></div></figure>'}
    {slide("Reference", ref.get("title", ""), ref.get("points", []), "written from the full transcript")}
  </div>
  {f'<p class="bigidea"><span>Big idea, AI draft:</span> {esc(llm["big_idea"])}</p>' if llm else ''}
  {f'<p class="bigidea"><span>Big idea, reference:</span> {esc(ref.get("big_idea"))}</p>' if ref.get("big_idea") else ''}
  <div class="lists">
    <div><h4>Missed ({len(a['missed'])})</h4><ul>{missed}</ul></div>
    <div><h4>Wrong verse shown ({len(a['wrong'])})</h4><ul>{wrong}</ul></div>
  </div>
</section>""")

    med = statistics.median(delays) if delays else 0
    smed = statistics.median(sdel) if sdel else None
    ww = [who_when(e["source"]) for e in report]
    years = sorted(w[2][-4:] for w in ww if w[2])
    preachers = {re.sub(r"^(Rev\.?|Pastor|Lady Pastor|Br\.?)\s+", "", w[1]).split()[0] for w in ww if w[1] and w[1] != "Preacher not named"}
    vals = dict(
        span=f"{years[0]} to {years[-1]}" if years else "",
        npreachers=len(preachers) or "several",
        n=len(report), hours=f"{hours:.1f}", exp=exp, fb=fb, fa=fa, wb=wb, wa=wa,
        pb=round(100 * fb / exp) if exp else 0, pa=round(100 * fa / exp) if exp else 0,
        kinds_explicit=kinds["explicit"], kinds_chapter=kinds["chapter"], kinds_followup=kinds["followup"], kinds_quote=kinds["quote"],
        med=f"{med:.1f}",
        stream_line=(f"In live mode on 15-minute excerpts from {len(stream)} sermons, the app caught {sfound} of {sexp} full references, showed {swrong} wrong verses, and the median delay from the preacher finishing the reference to the verse on screen was <b>{smed:.1f} s</b>." if stream and smed is not None else "These numbers come from the app's final transcripts. Live-mode timing (early transcripts every half second) was not measured on these recordings in this round; on synthetic sermons it puts a verse on screen about 1.4 s after it is spoken."),
        rows="\n".join(rows), details="\n".join(details),
        findings=open(os.path.join(os.path.dirname(__file__), "findings.html")).read(),
    )
    page = TEMPLATE
    for k, v in vals.items():
        page = page.replace("{{" + k + "}}", str(v))
    open(out, "w").write(page)


TEMPLATE = open(os.path.join(os.path.dirname(__file__), "report_template.html")).read()

if __name__ == "__main__":
    main()
