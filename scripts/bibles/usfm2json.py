#!/usr/bin/env python3
"""Convert a USFM Bible zip (eBible.org style) into the preso-core JSON format.

Output shape (same as desktop/crates/preso-core/assets/*.json):

    {"id": "bsb", "name": "Berean Standard Bible (BSB)",
     "books": [{"n": "Genesis", "c": [["verse 1", "verse 2", ...], ...]}, ...]}

Exactly 66 books in Protestant canonical order (Genesis..Revelation). Verse N
of a chapter is always at index N-1, because preso-core looks verses up by
position.

What is kept and what is dropped:
  * Kept: verse text, including words inside character styles (\\w, \\+w,
    \\it, \\bd, \\nd, \\wj, ...). Curly quotes are kept as they are.
  * Dropped: footnotes (\\f..\\f*), endnotes (\\fe..\\fe*), cross references
    (\\x..\\x*, \\rq..\\rq*), word attributes (the "|strong=..." part of \\w),
    headings (\\s#, \\ms#, \\mr, \\sr, \\r, \\d, \\sp, \\qa, \\cl, ...),
    book titles, introductions and other front matter, and books outside the
    66 (deuterocanon, glossary, front matter files).
  * Psalm superscriptions are kept out. Most translations put them in a \\d
    paragraph, which is dropped. Some (for example the LSV) print the title
    in capitals at the start of verse 1; that capitalised lead sentence is
    removed from Psalms verse 1 only.

Verse bridges (\\v 1-2): the whole text goes on the first verse and the other
verses in the bridge are left as empty strings. That keeps every later verse at
its proper index, and a range lookup such as "1-2" still reads the text exactly
once. Verses a translation omits (for example Matthew 17:21 in some modern
texts) are also left as empty strings for the same reason.

Usage:
    python3 scripts/bibles/usfm2json.py engbsb_usfm.zip --id bsb \\
        --name "Berean Standard Bible (BSB)" -o desktop/crates/preso-core/assets/bsb.json

Standard library only.
"""

import argparse
import json
import re
import sys
import zipfile

BOOKS = [
    ("GEN", "Genesis"), ("EXO", "Exodus"), ("LEV", "Leviticus"), ("NUM", "Numbers"),
    ("DEU", "Deuteronomy"), ("JOS", "Joshua"), ("JDG", "Judges"), ("RUT", "Ruth"),
    ("1SA", "1 Samuel"), ("2SA", "2 Samuel"), ("1KI", "1 Kings"), ("2KI", "2 Kings"),
    ("1CH", "1 Chronicles"), ("2CH", "2 Chronicles"), ("EZR", "Ezra"), ("NEH", "Nehemiah"),
    ("EST", "Esther"), ("JOB", "Job"), ("PSA", "Psalms"), ("PRO", "Proverbs"),
    ("ECC", "Ecclesiastes"), ("SNG", "Song of Solomon"), ("ISA", "Isaiah"),
    ("JER", "Jeremiah"), ("LAM", "Lamentations"), ("EZK", "Ezekiel"), ("DAN", "Daniel"),
    ("HOS", "Hosea"), ("JOL", "Joel"), ("AMO", "Amos"), ("OBA", "Obadiah"),
    ("JON", "Jonah"), ("MIC", "Micah"), ("NAM", "Nahum"), ("HAB", "Habakkuk"),
    ("ZEP", "Zephaniah"), ("HAG", "Haggai"), ("ZEC", "Zechariah"), ("MAL", "Malachi"),
    ("MAT", "Matthew"), ("MRK", "Mark"), ("LUK", "Luke"), ("JHN", "John"), ("ACT", "Acts"),
    ("ROM", "Romans"), ("1CO", "1 Corinthians"), ("2CO", "2 Corinthians"),
    ("GAL", "Galatians"), ("EPH", "Ephesians"), ("PHP", "Philippians"),
    ("COL", "Colossians"), ("1TH", "1 Thessalonians"), ("2TH", "2 Thessalonians"),
    ("1TI", "1 Timothy"), ("2TI", "2 Timothy"), ("TIT", "Titus"), ("PHM", "Philemon"),
    ("HEB", "Hebrews"), ("JAS", "James"), ("1PE", "1 Peter"), ("2PE", "2 Peter"),
    ("1JN", "1 John"), ("2JN", "2 John"), ("3JN", "3 John"), ("JUD", "Jude"),
    ("REV", "Revelation"),
]
BOOK_INDEX = {code: i for i, (code, _) in enumerate(BOOKS)}

# Paragraph markers whose text is not verse text. Their content runs until the
# next marker that is not a character style (another paragraph marker, \v, \c).
SKIP_PARA = {
    "id", "ide", "h", "toc1", "toc2", "toc3", "toca1", "toca2", "toca3", "rem",
    "sts", "usfm", "mt", "mt1", "mt2", "mt3", "mt4", "mte", "mte1", "mte2",
    "imt", "imt1", "imt2", "imt3", "is", "is1", "is2", "ip", "ipi", "im", "imi",
    "ipq", "imq", "ipr", "iq", "iq1", "iq2", "iq3", "ib", "ili", "ili1", "ili2",
    "iot", "io", "io1", "io2", "io3", "iex", "imte", "ie",
    "ms", "ms1", "ms2", "ms3", "mr", "s", "s1", "s2", "s3", "s4", "sr", "r",
    "d", "sp", "sd", "sd1", "sd2", "qa", "cl", "cd", "cp", "lit",
}
# Character-level spans removed together with their content (closed by "\name*").
SKIP_SPAN = {"f", "fe", "ef", "x", "ex", "rq", "fig", "ca", "va", "vp", "cat"}

# A marker, plus the single space that ends an opening marker. That space is
# part of the marker in USFM ("\\w Lord" is the word "Lord"), not text.
TOKEN = re.compile(r"\\(\+?[A-Za-z]+[0-9]*)(?:(\*)|[ \t\r\n]?)")
NOTE = "\x00"  # placeholder where a footnote or cross reference was removed


HEBREW_LETTER = re.compile(
    r"\[(?:ALEPH-BET|ALEPH|BETH|GIMEL|DALETH|HE|WAW|ZAYIN|HETH|TETH|YOD|KAPH|LAMED|"
    r"MEM|NUN|SAMEKH|AYIN|PE|TSADE|QOF|RESH|SHIN|TAW)\]"
)


def clean(text):
    # Acrostic letter tags ("[ALEPH]") are headings, not verse text.
    text = HEBREW_LETTER.sub(" ", text)
    # "||" marks a poetic line break in the LSV; a plain-text slide has none.
    text = text.replace("||", " ")
    # A removed note before punctuation should not leave a space behind:
    # "shelters \f..\f*—one" becomes "shelters—one".
    text = re.sub(r"\s*" + NOTE + r"+\s*(?=[,.;:!?’”)\]—…])", "", text)
    text = text.replace(NOTE, " ")
    return " ".join(text.split())


def strip_word_attrs(text):
    # "\w grace|strong="G5485"\w*" leaves "grace|strong="G5485"" between the
    # markers; drop everything from "|" to the end of that span.
    return re.sub(r"\|[^\\]*", "", text)


CAPS_WORD = re.compile(r"^[^a-z]*[A-Z][^a-z]*$")


def strip_caps_superscription(text):
    """Remove a leading ALL-CAPS title sentence such as
    'A PSALM OF DAVID. YHWH is my shepherd' -> 'YHWH is my shepherd'."""
    words = text.split(" ")
    cut = 0
    for i, w in enumerate(words):
        if not CAPS_WORD.match(w):
            break
        if re.search(r"[.:?!][”’]?$", w):
            cut = i + 1
    title = {re.sub(r"\W", "", w) for w in words[:cut]} - {"O", "YHWH", "YAH", "GOD", "LORD", ""}
    if cut >= 2 and cut < len(words) and title:
        return " ".join(words[cut:])
    return text


def parse_book(src, code):
    chapters = []  # list of dict verse->text
    verse_text = None  # list collecting pieces for the current verse
    cur = None  # (chapter_dict, verse_number)
    skip_para = False
    span_stack = []  # open skipped spans
    word_span = 0  # depth of \w / \+w spans (attribute stripping)

    def flush():
        nonlocal verse_text
        if cur is not None and verse_text is not None:
            ch, v = cur
            ch[v] = ch.get(v, "") + "".join(verse_text)
        verse_text = None

    pos = 0
    pieces = []
    for m in TOKEN.finditer(src):
        pieces.append(("text", src[pos:m.start()]))
        pieces.append(("mark", m.group(1), m.group(2) == "*"))
        pos = m.end()
    pieces.append(("text", src[pos:]))

    i = 0
    while i < len(pieces):
        p = pieces[i]
        i += 1
        if p[0] == "text":
            t = p[1]
            if span_stack or skip_para or verse_text is None:
                continue
            if word_span:
                t = strip_word_attrs(t)
            verse_text.append(t)
            continue
        name, closing = p[1], p[2]
        base = name.lstrip("+")
        if span_stack:
            # Inside a footnote / cross reference: only watch for its close.
            if closing and base == span_stack[-1]:
                span_stack.pop()
                if not span_stack and verse_text is not None and not skip_para:
                    verse_text.append(NOTE)
            elif not closing and base in SKIP_SPAN:
                span_stack.append(base)
            continue
        if base in SKIP_SPAN and not closing:
            span_stack.append(base)
            continue
        if base == "c" and not closing:
            flush()
            # Chapter number is the first word of the following text.
            nxt = pieces[i][1] if i < len(pieces) and pieces[i][0] == "text" else ""
            mm = re.match(r"\s*(\d+)", nxt)
            if not mm:
                raise ValueError(f"{code}: bad \\c marker near {nxt[:20]!r}")
            n = int(mm.group(1))
            while len(chapters) < n:
                chapters.append({})
            cur = None
            skip_para = False
            pieces[i] = ("text", "")
            continue
        if base == "v" and not closing:
            flush()
            nxt = pieces[i][1] if i < len(pieces) and pieces[i][0] == "text" else ""
            mm = re.match(r"\s*(\d+)[a-z]?(?:\s*[-–,]\s*(\d+)[a-z]?)?\s?", nxt)
            if not mm or not chapters:
                raise ValueError(f"{code}: bad \\v marker near {nxt[:20]!r}")
            v = int(mm.group(1))
            end = int(mm.group(2)) if mm.group(2) else v
            ch = chapters[-1]
            # Bridge: text goes on the first verse, the rest stay empty.
            for extra in range(v + 1, end + 1):
                ch.setdefault(extra, "")
            cur = (ch, v)
            verse_text = []
            skip_para = False
            pieces[i] = ("text", nxt[mm.end():])
            continue
        if base in ("w", "+w") or name in ("w", "+w"):
            word_span += -1 if closing else 1
            word_span = max(word_span, 0)
            continue
        if closing:
            continue  # end of a kept character style (\it*, \bd*, \wj*, ...)
        # Opening marker that is not a span we drop.
        if name.startswith("+"):
            continue  # nested character style: keep its text
        if base in SKIP_PARA:
            skip_para = True
        elif is_paragraph(base):
            skip_para = False
            if verse_text is not None:
                verse_text.append(" ")
        # Any other opening character style (\it, \bd, \nd, \wj, \add, \qs...)
        # keeps its text.
    flush()

    out = []
    for ch in chapters:
        if not ch:
            out.append([])
            continue
        n = max(ch)
        out.append([clean(ch.get(v, "")) for v in range(1, n + 1)])
    return out


PARA = re.compile(
    r"^(p|m|po|pr|cls|pmo|pm|pmc|pmr|pi\d?|mi|nb|pc|ph\d?|b|q\d?|qr|qc|qm\d?|qd|"
    r"li\d?|lh|lf|lim\d?|tr|th\d?|thr\d?|tc\d?|tcr\d?)$"
)


def is_paragraph(name):
    return bool(PARA.match(name))


def convert(zip_path, tid, name):
    books = [None] * 66
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            if not info.filename.lower().endswith((".usfm", ".sfm")):
                continue
            src = z.read(info).decode("utf-8-sig")
            mm = re.search(r"\\id\s+([0-9A-Z]{3})", src)
            if not mm or mm.group(1) not in BOOK_INDEX:
                continue  # front matter, deuterocanon, glossary...
            code = mm.group(1)
            chapters = parse_book(src, code)
            if code == "PSA":
                for ch in chapters:
                    if ch and ch[0]:
                        ch[0] = strip_caps_superscription(ch[0])
            books[BOOK_INDEX[code]] = {"n": BOOKS[BOOK_INDEX[code]][1], "c": chapters}
    missing = [BOOKS[i][0] for i, b in enumerate(books) if b is None]
    if missing:
        raise SystemExit(f"missing books: {', '.join(missing)}")
    return {"id": tid, "name": name, "books": books}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("zip", help="USFM zip, e.g. engbsb_usfm.zip from eBible.org")
    ap.add_argument("--id", required=True, help="translation id, e.g. bsb")
    ap.add_argument("--name", required=True, help='display name, e.g. "Berean Standard Bible (BSB)"')
    ap.add_argument("-o", "--out", required=True, help="output JSON path")
    a = ap.parse_args()
    data = convert(a.zip, a.id.lower(), a.name)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    verses = sum(len(c) for b in data["books"] for c in b["c"])
    empty = sum(1 for b in data["books"] for c in b["c"] for v in c if not v)
    print(f"{a.out}: 66 books, {verses} verse slots, {empty} empty", file=sys.stderr)


if __name__ == "__main__":
    main()
