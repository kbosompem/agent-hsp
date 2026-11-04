//! The preacher's books: Dag Heward-Mills's books, which preachers in his
//! churches quote ("Daddy says...", "as Bishop wrote in Loyalty and
//! Disloyalty") and preach from. The user imports them (the EPUBs from
//! dagbooks.org); they are never bundled with the app.
//!
//! Two searches. A quoted sentence is found by its word pairs, as recite.rs
//! finds a recited verse, and offered to the operator with the book's name.
//! And the chapters closest to the sermon so far, by the verses he used and
//! the words he used, give the AI summary the book's own outline (chapter
//! title, headings, numbered points, verses) to check its points against.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

use super::{engine, recite};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Book {
    pub id: String,
    pub title: String,
    pub chapters: Vec<Chapter>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Chapter {
    pub title: String,
    /// Section headings and numbered points, in order.
    pub heads: Vec<String>,
    /// Bible references in order of first use ("Genesis 27:5-14").
    pub refs: Vec<String>,
    pub paras: Vec<Para>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Para {
    pub text: String,
    /// A Bible passage the book quotes, not the author's own words.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub scripture: bool,
    /// Its class in the EPUB, while the chapter is put together.
    #[serde(skip)]
    pub class: String,
}

/// A piece of a book's text before it is split into chapters.
#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Head(String),
    Para(String, Style),
    /// The end of one file of an EPUB.
    Break,
}

#[derive(Serialize, Clone, Debug)]
pub struct BookInfo {
    pub id: String,
    pub title: String,
    pub chapters: usize,
}

/// A sentence the preacher quoted from a book.
#[derive(Serialize, Clone, Debug)]
pub struct BookQuote {
    pub book: String,
    pub chapter: String,
    /// The sentences he quoted, as the book has them.
    pub text: String,
    /// Which passage: the same one heard again is the same quote.
    pub passage: u32,
    /// Word pairs in a row that matched, and their weight.
    pub run: usize,
    pub weight: f32,
}

/// A chapter close to the sermon, for the AI summary.
#[derive(Serialize, Clone, Debug)]
pub struct Outline {
    pub book: String,
    pub chapter: String,
    pub heads: Vec<String>,
    pub refs: Vec<String>,
    pub score: f32,
    /// The two parts of the score: shared verses and shared words.
    pub verses: f32,
    pub words: f32,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct ImportReport {
    pub added: Vec<String>,
    pub skipped: Vec<String>,
    pub total: usize,
}

// ---------------------------------------------------------------- reading

/// How a paragraph is set: its class, and whether nearly all of it is bold
/// or italic (from <b> and <i> tags or the book's CSS). Dag Heward-Mills's
/// EPUBs mark headings either by class ("SUB-TITLE-", "MAIN-POINT") or only
/// by style (a bold centered paragraph), and quoted scripture by class
/// ("BIBLE-VERSE") or as italic paragraphs above the reference.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Style {
    pub class: String,
    pub bold: bool,
    pub italic: bool,
    pub scripture: bool,
}

/// CSS class -> (bold, italic).
pub type Css = HashMap<String, (bool, bool)>;

/// Add the bold and italic classes of a stylesheet to `into`.
pub fn parse_css(css: &str, into: &mut Css) {
    let mut s = String::new();
    let mut rest = css;
    while let Some(i) = rest.find("/*") {
        s.push_str(&rest[..i]);
        rest = rest[i..].find("*/").map(|e| &rest[i + e + 2..]).unwrap_or("");
    }
    s.push_str(rest);
    for rule in s.split('}') {
        let Some((sel, decl)) = rule.split_once('{') else { continue };
        let (bold, italic) = decl_flags(decl);
        if !bold && !italic {
            continue;
        }
        for one in sel.split(',') {
            // The element styled is the last one in the selector: "p.sgc-5".
            let last = one.split_whitespace().last().unwrap_or("");
            for class in last.split('.').skip(1) {
                let class = class.split(':').next().unwrap_or("").to_ascii_lowercase();
                if class.is_empty() {
                    continue;
                }
                let e = into.entry(class).or_default();
                e.0 |= bold;
                e.1 |= italic;
            }
        }
    }
}

/// Whether CSS declarations ("font-weight: bold; ...") make text bold, italic.
fn decl_flags(decl: &str) -> (bool, bool) {
    let d = decl.to_ascii_lowercase().replace([' ', '\t', '\n'], "");
    let bold = ["font-weight:bold", "font-weight:600", "font-weight:700", "font-weight:800", "font-weight:900"]
        .iter()
        .any(|k| d.contains(k));
    (bold, d.contains("font-style:italic") || d.contains("font-style:oblique"))
}

struct Frame {
    head: bool,
    style: Style,
}

/// Text blocks of an XHTML file: headings (h1 to h6, or a paragraph whose
/// class names a heading) and styled paragraphs, with entities decoded.
/// `css` holds the book's stylesheets; a <style> in the file adds to it.
pub fn html_blocks(html: &str, css: &Css) -> Vec<Block> {
    let mut css = css.clone();
    let mut out = Vec::new();
    let mut buf = String::new();
    // Characters of the open block, and how many of them are bold, italic.
    let (mut chars, mut bold_chars, mut italic_chars) = (0usize, 0usize, 0usize);
    let mut stack: Vec<Frame> = Vec::new();
    // Open inline elements that set bold or italic: (name, bold, italic).
    let mut inline: Vec<(String, bool, bool)> = Vec::new();
    let mut skip = 0usize;
    let mut in_style = false;
    let mut style_buf = String::new();
    let flush = |buf: &mut String, top: Option<&Frame>, counts: &mut (usize, usize, usize), out: &mut Vec<Block>| {
        let t = clean_space(buf);
        buf.clear();
        let (n, b, i) = *counts;
        *counts = (0, 0, 0);
        if t.is_empty() {
            return;
        }
        let (head, mut style) = top.map(|f| (f.head, f.style.clone())).unwrap_or_default();
        if n > 0 {
            style.bold |= b * 10 >= n * 9;
            style.italic |= i * 10 >= n * 9;
        }
        out.push(if head { Block::Head(t) } else { Block::Para(t, style) });
    };
    let mut rest = html;
    while let Some(lt) = rest.find('<') {
        let text = &rest[..lt];
        if in_style {
            style_buf.push_str(text);
        } else if skip == 0 && !text.is_empty() {
            let t = decode_entities(text);
            let n = t.chars().filter(|c| !c.is_whitespace() && *c != '\u{a0}').count();
            let top_b = stack.last().is_some_and(|f| f.style.bold);
            let top_i = stack.last().is_some_and(|f| f.style.italic);
            chars += n;
            if top_b || inline.iter().any(|x| x.1) {
                bold_chars += n;
            }
            if top_i || inline.iter().any(|x| x.2) {
                italic_chars += n;
            }
            buf.push_str(&t);
        }
        let after = &rest[lt + 1..];
        if after.starts_with("!--") {
            rest = after.find("-->").map(|e| &after[e + 3..]).unwrap_or("");
            continue;
        }
        let Some(gt) = after.find('>') else { break };
        let tag = &after[..gt];
        rest = &after[gt + 1..];
        let closing = tag.starts_with('/');
        let self_closing = tag.ends_with('/');
        let name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == ':')
            .collect::<String>()
            .to_ascii_lowercase();
        let name = name.rsplit(':').next().unwrap_or("").to_string();
        if name == "style" {
            if closing {
                parse_css(&style_buf, &mut css);
                style_buf.clear();
                in_style = false;
            } else if !self_closing {
                in_style = true;
            }
            continue;
        }
        if matches!(name.as_str(), "script" | "head") {
            if closing {
                skip = skip.saturating_sub(1);
            } else if !self_closing {
                skip += 1;
            }
            continue;
        }
        if skip > 0 {
            continue;
        }
        let mut counts = (chars, bold_chars, italic_chars);
        match name.as_str() {
            "br" => buf.push(' '),
            "b" | "strong" | "i" | "em" | "span" => {
                if closing {
                    if let Some(at) = inline.iter().rposition(|x| x.0 == name) {
                        inline.remove(at);
                    }
                } else if !self_closing {
                    let (sb, si) = decl_flags(&attr(tag, "style"));
                    let (mut b, mut i) = (name == "b" || name == "strong" || sb, name == "i" || name == "em" || si);
                    for c in attr(tag, "class").to_ascii_lowercase().split_whitespace() {
                        if let Some(&(cb, ci)) = css.get(c) {
                            b |= cb;
                            i |= ci;
                        }
                    }
                    inline.push((name.clone(), b, i));
                }
            }
            "p" | "div" | "li" | "blockquote" | "section" | "tr" | "td" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "dt"
            | "dd" | "figcaption" | "body" => {
                flush(&mut buf, stack.last(), &mut counts, &mut out);
                if closing {
                    stack.pop();
                    inline.clear();
                } else if !self_closing {
                    let class = attr(tag, "class").to_ascii_lowercase();
                    let tokens: Vec<&str> = class.split_whitespace().collect();
                    let has = |keys: &[&str]| tokens.iter().any(|c| keys.iter().any(|k| c.contains(k)));
                    let scripture = has(&["verse", "bible", "scripture"]);
                    let head_class = !scripture
                        && has(&["head", "title", "point", "chapter"])
                        && !tokens.iter().any(|c| ["text", "body", "para"].iter().any(|k| c.contains(k)));
                    let head = name.starts_with('h') && name != "body" || (name == "p" || name == "div") && head_class;
                    let parent = stack.last().map(|f| f.style.clone()).unwrap_or_default();
                    // Books styled inline ("margin:0pt 14.15pt ...") tell a
                    // verse from his text only by that: it counts as the class.
                    let inline_style = attr(tag, "style");
                    let (sb, si) = decl_flags(&inline_style);
                    let key = if inline_style.is_empty() { class.clone() } else { format!("{}|{}", class, inline_style.to_ascii_lowercase()) };
                    let mut style = Style {
                        class: key,
                        bold: parent.bold || sb,
                        italic: parent.italic || si,
                        scripture: parent.scripture || scripture,
                    };
                    for c in &tokens {
                        if let Some(&(b, i)) = css.get(*c) {
                            style.bold |= b;
                            style.italic |= i;
                        }
                    }
                    stack.push(Frame { head, style });
                }
            }
            _ => {}
        }
        (chars, bold_chars, italic_chars) = counts;
    }
    if skip == 0 {
        buf.push_str(&decode_entities(rest));
    }
    let mut counts = (chars, bold_chars, italic_chars);
    flush(&mut buf, stack.last(), &mut counts, &mut out);
    out
}

fn attr(tag: &str, name: &str) -> String {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name) {
        let at = from + i;
        let before_ok = at > 0 && lower.as_bytes()[at - 1].is_ascii_whitespace();
        // Same byte offsets: ASCII lowercasing keeps lengths.
        let rest = tag[at + name.len()..].trim_start();
        if before_ok && rest.starts_with('=') {
            let v = rest[1..].trim_start();
            let q = v.chars().next().unwrap_or(' ');
            if q == '"' || q == '\'' {
                return v[1..].split(q).next().unwrap_or("").to_string();
            }
            return v.split_whitespace().next().unwrap_or("").to_string();
        }
        from = at + name.len();
    }
    String::new()
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let end = after.find(';').filter(|&e| e <= 10);
        let Some(e) = end else {
            out.push('&');
            rest = after;
            continue;
        };
        let ent = &after[..e];
        let ch = if let Some(n) = ent.strip_prefix("#x").or_else(|| ent.strip_prefix("#X")) {
            u32::from_str_radix(n, 16).ok().and_then(char::from_u32)
        } else if let Some(n) = ent.strip_prefix('#') {
            n.parse::<u32>().ok().and_then(char::from_u32)
        } else {
            match ent {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "rsquo" | "lsquo" => Some('\''),
                "ldquo" | "rdquo" => Some('"'),
                "nbsp" | "ensp" | "emsp" | "thinsp" => Some(' '),
                "mdash" => Some('—'),
                "ndash" => Some('–'),
                "hellip" => Some('…'),
                _ => None,
            }
        };
        match ch {
            Some(c) => out.push(c),
            None => {
                out.push('&');
                out.push_str(ent);
                out.push(';');
            }
        }
        rest = &after[e + 1..];
    }
    out.push_str(rest);
    out
}

fn clean_space(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// "CHAPTER 3", "Chapter Three: Labour for a Blessing": the title after the
/// number (possibly empty), or None for any other line.
fn chapter_heading(s: &str) -> Option<String> {
    let t = s.trim();
    if t.split_whitespace().count() > 14 {
        return None;
    }
    let lower = t.to_lowercase();
    let rest = lower.strip_prefix("chapter")?;
    if !rest.starts_with(|c: char| c.is_whitespace()) {
        return None;
    }
    let rest_t = rest.trim_start();
    let num: String = rest_t.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    const WORDS: &[&str] = &[
        "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
        "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty",
    ];
    let roman = !num.is_empty() && num.chars().all(|c| "ivxl".contains(c));
    let ok = num.chars().all(|c| c.is_ascii_digit()) && !num.is_empty() || roman || WORDS.iter().any(|w| num.starts_with(w));
    if !ok {
        return None;
    }
    // Number words run on ("twenty-one"): skip to the first separator.
    let skip = t.len() - rest_t.len() + num.len();
    let tail = t[skip.min(t.len())..].trim_start_matches(|c: char| c.is_ascii_alphanumeric() || c == '-');
    Some(tail.trim_start_matches(|c: char| c.is_whitespace() || ":.-–—".contains(c)).trim().to_string())
}

/// "Genesis 27:5-14" alone on a line: the reference under a quoted passage.
fn is_ref_line(t: &str) -> bool {
    let t = t.trim().trim_matches(|c: char| "()[].".contains(c));
    let w: Vec<&str> = t.split_whitespace().collect();
    if w.is_empty() || w.len() > 7 || t.len() > 60 {
        return false;
    }
    let last = w[w.len() - 1];
    if !last.contains(':') || !last.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        return false;
    }
    !engine().parse_refs(t).is_empty()
}

fn word_count(s: &str) -> usize {
    s.split_whitespace().count()
}

/// "1. What are you working for?": a numbered point.
fn numbered(t: &str) -> bool {
    let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
    (1..=2).contains(&digits) && t[digits..].starts_with(['.', ')']) && t[digits + 1..].starts_with(' ') && word_count(t) <= 30
}

/// A short line that reads as a heading in plain text: few words, most of
/// them capitalized, no closing period.
fn looks_like_heading(t: &str) -> bool {
    let w: Vec<&str> = t.split_whitespace().collect();
    if w.is_empty() || w.len() > 12 || t.ends_with('.') || t.ends_with(',') || t.ends_with(';') {
        return false;
    }
    let caps = w.iter().filter(|x| x.chars().next().is_some_and(|c| c.is_uppercase())).count();
    caps * 2 >= w.len() + 1
}

/// Blocks of `pdftotext` output (plain mode): its lines are wrapped, so a
/// paragraph ends at a blank line, or at a short line that ends a sentence.
pub fn text_blocks(text: &str) -> Vec<Block> {
    let lines: Vec<&str> = text.split(['\n', '\x0c']).map(|l| l.trim()).collect();
    let mut lens: Vec<usize> = lines.iter().map(|l| l.chars().count()).filter(|&n| n > 20).collect();
    lens.sort_unstable();
    let width = lens.get(lens.len() * 9 / 10).copied().unwrap_or(70).max(30);
    let mut out = Vec::new();
    let mut buf: Vec<&str> = Vec::new();
    let flush = |buf: &mut Vec<&str>, out: &mut Vec<Block>| {
        if !buf.is_empty() {
            out.push(Block::Para(buf.join(" "), Style::default()));
            buf.clear();
        }
    };
    let mut want_title = false;
    // A chapter title wrapped onto a second line ("...with Blessed" / "People").
    let mut title_cont = false;
    for l in lines {
        if title_cont && !l.is_empty() {
            title_cont = false;
            if word_count(l) <= 4 && looks_like_heading(l) {
                if let Some(Block::Head(t)) = out.last_mut() {
                    t.push(' ');
                    t.push_str(l);
                    continue;
                }
            }
        }
        if l.is_empty() {
            flush(&mut buf, &mut out);
            continue;
        }
        if l.chars().all(|c| c.is_ascii_digit()) {
            continue; // a page number
        }
        if chapter_heading(l).is_some() && word_count(l) <= 10 {
            flush(&mut buf, &mut out);
            out.push(Block::Head(l.to_string()));
            want_title = chapter_heading(l).is_some_and(|t| t.is_empty());
            continue;
        }
        if want_title {
            want_title = false;
            if word_count(l) <= 14 {
                out.push(Block::Head(l.to_string()));
                title_cont = true;
                continue;
            }
        }
        // A numbered point or a reference is a line of its own.
        if numbered(l) || is_ref_line(l) {
            flush(&mut buf, &mut out);
            buf.push(l);
            if is_ref_line(l) || l.ends_with(['.', '!', '?', ':']) {
                flush(&mut buf, &mut out);
            }
            continue;
        }
        if buf.is_empty() && looks_like_heading(l) && l.chars().count() < width * 2 / 3 {
            out.push(Block::Head(l.to_string()));
            continue;
        }
        buf.push(l);
        let ends = l.ends_with(['.', '!', '?', ':', '"', '”', '’', ')']);
        if ends && l.chars().count() * 4 < width * 3 {
            flush(&mut buf, &mut out);
        }
    }
    flush(&mut buf, &mut out);
    out
}

const FRONT_MATTER: &[&str] = &[
    "contents", "copyright", "dedication", "acknowledg", "other books", "about the author", "books by", "title page",
];
/// Chapters with fewer words than this are contents pages and the like.
const MIN_CHAPTER_WORDS: usize = 80;

/// Split blocks into chapters: at "CHAPTER n" headings when the book has
/// them (anything before the first is front matter), otherwise at each file.
pub fn assemble(id: &str, title: &str, blocks: Vec<Block>) -> Book {
    let text_of = |b: &Block| match b {
        Block::Head(t) | Block::Para(t, _) => Some(t.clone()),
        Block::Break => None,
    };
    let has_chapters = blocks.iter().filter_map(text_of).filter(|t| chapter_heading(t).is_some()).count() >= 2;
    let mut chapters: Vec<Chapter> = Vec::new();
    let mut cur: Option<Chapter> = if has_chapters { None } else { Some(Chapter::default()) };
    let mut want_title = !has_chapters;
    for (i, b) in blocks.iter().enumerate() {
        if *b == Block::Break {
            if !has_chapters {
                chapters.extend(cur.take());
                cur = Some(Chapter::default());
                want_title = true;
            }
            continue;
        }
        let t = text_of(b).unwrap_or_default();
        let style = match b {
            Block::Para(_, s) => s.clone(),
            _ => Style::default(),
        };
        // A short bold paragraph is a heading, unless it is the verse above
        // a reference.
        let next_is_ref = matches!(blocks.get(i + 1), Some(Block::Para(n, _)) if is_ref_line(n));
        let styled_head = style.bold
            && !style.italic
            && !style.scripture
            && word_count(&t) <= 14
            && !t.ends_with(['.', ',', ';'])
            && !next_is_ref
            && !is_ref_line(&t);
        let head = matches!(b, Block::Head(_)) || styled_head;
        if has_chapters {
            if let Some(rest) = chapter_heading(&t) {
                chapters.extend(cur.take());
                want_title = rest.is_empty();
                cur = Some(Chapter { title: rest, ..Default::default() });
                continue;
            }
        }
        let Some(c) = cur.as_mut() else { continue };
        if want_title && (head || looks_like_heading(&t)) {
            // "Chapter 3" over the title, in a file of its own.
            match chapter_heading(&t) {
                Some(rest) if rest.is_empty() => continue,
                Some(rest) => c.title = rest,
                None => c.title = t,
            }
            want_title = false;
            continue;
        }
        want_title = false;
        if head && !numbered(&t) {
            c.heads.push(t);
        } else {
            if numbered(&t) {
                c.heads.push(t.clone());
            }
            c.paras.push(Para { text: t, scripture: style.scripture, class: style.class });
        }
    }
    chapters.extend(cur.take());
    for c in chapters.iter_mut() {
        finish_chapter(c);
    }
    chapters.retain(|c| {
        let words: usize = c.paras.iter().map(|p| word_count(&p.text)).sum();
        let t = c.title.to_lowercase();
        words >= MIN_CHAPTER_WORDS && !FRONT_MATTER.iter().any(|f| t.contains(f))
    });
    Book { id: id.to_string(), title: clean_space(title), chapters }
}

/// Paragraphs of one quoted passage above a reference, at most.
const MAX_VERSE_PARAS: usize = 12;

/// Mark quoted scripture: the paragraph above a reference line, and the
/// paragraphs before it set the same way when that is not how the chapter's
/// own text is set (a passage of several verses). Then list the chapter's
/// references and cap its headings.
fn finish_chapter(c: &mut Chapter) {
    let eng = engine();
    // The class most of the chapter's words are set in: the author's own text.
    let mut by_class: HashMap<&str, usize> = HashMap::new();
    for p in &c.paras {
        *by_class.entry(p.class.as_str()).or_default() += word_count(&p.text);
    }
    let body = by_class.into_iter().max_by_key(|x| x.1).map(|x| x.0.to_string()).unwrap_or_default();
    for i in 0..c.paras.len() {
        if !is_ref_line(&c.paras[i].text) {
            continue;
        }
        c.paras[i].scripture = true;
        if i == 0 {
            continue;
        }
        // A numbered point set like the verse under it is still his.
        if numbered(&c.paras[i - 1].text) {
            continue;
        }
        c.paras[i - 1].scripture = true;
        let class = c.paras[i - 1].class.clone();
        if class == body {
            continue;
        }
        let mut j = i - 1;
        while j > 0
            && i - j < MAX_VERSE_PARAS
            && c.paras[j - 1].class == class
            && !is_ref_line(&c.paras[j - 1].text)
            && !numbered(&c.paras[j - 1].text)
        {
            j -= 1;
            c.paras[j].scripture = true;
        }
    }
    let mut seen = HashSet::new();
    for p in &c.paras {
        for r in eng.parse_refs(&p.text) {
            if r.verse.is_none() {
                continue;
            }
            let label = eng.ref_label(0, &r);
            if seen.insert(label.clone()) {
                c.refs.push(label);
            }
        }
    }
    c.heads.dedup();
    c.heads.truncate(60);
}

/// One book from an EPUB: the files in the order of its spine.
pub fn epub_book<R: Read + Seek>(zip: &mut zip::ZipArchive<R>, fallback_id: &str) -> Option<Book> {
    let read = |zip: &mut zip::ZipArchive<R>, name: &str| -> Option<String> {
        let f = zip.by_name(name).ok()?;
        let mut s = String::new();
        f.take(MAX_ENTRY).read_to_string(&mut s).ok()?;
        Some(s)
    };
    let container = read(zip, "META-INF/container.xml")?;
    let opf_path = attr_in(&container, "rootfile", "full-path")?;
    let opf = read(zip, &opf_path)?;
    let base = opf_path.rsplit_once('/').map(|(d, _)| format!("{}/", d)).unwrap_or_default();
    let doc = roxmltree::Document::parse(&opf).ok()?;
    let title = doc
        .descendants()
        .find(|n| n.tag_name().name() == "title")
        .and_then(|n| n.text())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback_id.to_string());
    let manifest: HashMap<String, String> = doc
        .descendants()
        .filter(|n| n.tag_name().name() == "item")
        .filter_map(|n| Some((n.attribute("id")?.to_string(), n.attribute("href")?.to_string())))
        .collect();
    let spine: Vec<String> = doc
        .descendants()
        .filter(|n| n.tag_name().name() == "itemref")
        .filter_map(|n| manifest.get(n.attribute("idref")?).cloned())
        .collect();
    // The book's stylesheets: which classes are bold or italic.
    let mut css = Css::new();
    let mut sheets: Vec<&String> = manifest.values().filter(|h| h.to_ascii_lowercase().ends_with(".css")).collect();
    sheets.sort();
    for href in sheets {
        if let Some(sheet) = read(zip, &format!("{}{}", base, percent_decode(href))) {
            parse_css(&sheet, &mut css);
        }
    }
    let mut blocks = Vec::new();
    for href in spine {
        let path = format!("{}{}", base, percent_decode(href.split('#').next().unwrap_or("")));
        if let Some(html) = read(zip, &path) {
            blocks.extend(html_blocks(&html, &css));
            blocks.push(Block::Break);
        }
    }
    let book = assemble(&slug(&title), &title, blocks);
    (!book.chapters.is_empty()).then_some(book)
}

fn attr_in(xml: &str, tag: &str, name: &str) -> Option<String> {
    // "<rootfile " and not "<rootfiles>".
    let open = format!("<{}", tag);
    let mut from = 0;
    while let Some(i) = xml[from..].find(&open).map(|i| i + from) {
        from = i + open.len();
        if !xml[from..].starts_with(|c: char| c.is_whitespace()) {
            continue;
        }
        let end = xml[i..].find('>')? + i;
        let v = attr(&xml[i..end], name);
        return (!v.is_empty()).then_some(v);
    }
    None
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// A file-name-safe id from a title: "Loyalty and Disloyalty" -> "loyalty-and-disloyalty".
pub fn slug(title: &str) -> String {
    let s: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let s = s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    let s: String = s.chars().take(60).collect();
    if s.is_empty() { "book".into() } else { s }
}

/// The largest file read out of an archive.
const MAX_ENTRY: u64 = 150 * 1024 * 1024;

/// pdftotext from Poppler, where Homebrew and Linux put it. PDFs are read
/// only when it is installed; the dagbooks.org EPUBs need nothing.
fn pdftotext() -> Option<PathBuf> {
    ["/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext", "/usr/bin/pdftotext"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
}

fn pdf_book(path: &Path) -> Result<Book, String> {
    let tool = pdftotext().ok_or("PDF books need pdftotext (brew install poppler); EPUBs need nothing")?;
    let out = std::process::Command::new(tool)
        .args(["-enc", "UTF-8"])
        .arg(path)
        .arg("-")
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("pdftotext could not read it".into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    // The title is the first line of an ebook PDF.
    let first = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let title = if (1..=14).contains(&word_count(first)) { first.to_string() } else { stem };
    let book = assemble(&slug(&title), &title, text_blocks(&text));
    if book.chapters.is_empty() {
        return Err("no chapters found".into());
    }
    Ok(book)
}

/// Books in `path`: an EPUB, a PDF, a zip of them (dagbooks.org's "Download
/// All"), or a folder of any of these.
pub fn read_books(path: &Path, report: &mut ImportReport) -> Vec<Book> {
    let mut books = Vec::new();
    let name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let lower = name.to_lowercase();
    if path.is_dir() {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(path)
            .map(|d| d.filter_map(|e| e.ok()).map(|e| e.path()).collect())
            .unwrap_or_default();
        entries.sort();
        for p in entries {
            let n = p.file_name().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
            if n.starts_with('.') {
                continue;
            }
            if p.is_dir() || n.ends_with(".epub") || n.ends_with(".pdf") || n.ends_with(".zip") {
                books.extend(read_books(&p, report));
            }
        }
    } else if lower.ends_with(".pdf") {
        match pdf_book(path) {
            Ok(b) => books.push(b),
            Err(e) => report.skipped.push(format!("{}: {}", name, e)),
        }
    } else if lower.ends_with(".epub") || lower.ends_with(".zip") {
        let Ok(f) = std::fs::File::open(path) else {
            report.skipped.push(format!("{}: could not open", name));
            return books;
        };
        match zip::ZipArchive::new(std::io::BufReader::new(f)) {
            Ok(mut z) => books.extend(zip_books(&mut z, &name, report)),
            Err(_) => report.skipped.push(format!("{}: not an EPUB or zip file", name)),
        }
    }
    books
}

fn zip_books<R: Read + Seek>(z: &mut zip::ZipArchive<R>, name: &str, report: &mut ImportReport) -> Vec<Book> {
    if z.by_name("META-INF/container.xml").is_ok() {
        let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
        return match epub_book(z, &slug(stem)) {
            Some(b) => vec![b],
            None => {
                report.skipped.push(format!("{}: no chapters found", name));
                vec![]
            }
        };
    }
    let mut books = Vec::new();
    let names: Vec<String> = z.file_names().map(String::from).collect();
    for n in names {
        let lower = n.to_lowercase();
        let short = n.rsplit('/').next().unwrap_or(&n).to_string();
        if n.starts_with("__MACOSX") || short.starts_with('.') {
            continue;
        }
        if !(lower.ends_with(".epub") || lower.ends_with(".pdf")) {
            continue;
        }
        let mut bytes = Vec::new();
        let ok = z.by_name(&n).ok().and_then(|f| f.take(MAX_ENTRY).read_to_end(&mut bytes).ok()).is_some();
        if !ok {
            report.skipped.push(format!("{}: could not read", short));
            continue;
        }
        if lower.ends_with(".pdf") {
            let tmp = std::env::temp_dir().join(format!("hsp-book-{}.pdf", std::process::id()));
            let got = std::fs::write(&tmp, &bytes).map_err(|e| e.to_string()).and_then(|_| pdf_book(&tmp));
            let _ = std::fs::remove_file(&tmp);
            match got {
                Ok(b) => books.push(b),
                Err(e) => report.skipped.push(format!("{}: {}", short, e)),
            }
            continue;
        }
        match zip::ZipArchive::new(std::io::Cursor::new(bytes)) {
            Ok(mut inner) => books.extend(zip_books(&mut inner, &short, report)),
            Err(_) => report.skipped.push(format!("{}: not an EPUB", short)),
        }
    }
    books
}

// ---------------------------------------------------------------- storage

/// Import the books in `path` into `dir` (one JSON file per book, replacing
/// a book of the same title), then reload the index.
pub fn import(path: &Path, dir: &Path) -> Result<ImportReport, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut report = ImportReport::default();
    let books = read_books(path, &mut report);
    if books.is_empty() && report.skipped.is_empty() {
        return Err("No EPUB or PDF books found there.".into());
    }
    for b in books {
        let json = serde_json::to_string(&b).map_err(|e| e.to_string())?;
        let p = dir.join(format!("{}.json", b.id));
        let tmp = p.with_extension("part");
        std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
        report.added.push(b.title);
    }
    load_dir(dir);
    report.total = info().len();
    Ok(report)
}

/// Load every imported book in `dir` and index them (a second or two for a
/// hundred books: call it off the main thread).
pub fn load_dir(dir: &Path) {
    let mut books: Vec<Book> = std::fs::read_dir(dir)
        .map(|d| {
            d.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "json"))
                .filter_map(|p| serde_json::from_str::<Book>(&std::fs::read_to_string(p).ok()?).ok())
                .collect()
        })
        .unwrap_or_default();
    books.sort_by(|a, b| a.title.cmp(&b.title));
    set_books(books);
}

/// Remove one imported book, or all of them when `id` is None.
pub fn remove(dir: &Path, id: Option<&str>) -> Result<(), String> {
    if let Some(id) = id {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err("bad book id".into());
        }
        let _ = std::fs::remove_file(dir.join(format!("{}.json", id)));
    } else if let Ok(d) = std::fs::read_dir(dir) {
        for e in d.filter_map(|e| e.ok()) {
            if e.path().extension().is_some_and(|x| x == "json") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    load_dir(dir);
    Ok(())
}

pub fn info() -> Vec<BookInfo> {
    let lib = library();
    lib.books.iter().map(|b| BookInfo { id: b.id.clone(), title: b.title.clone(), chapters: b.chapters.len() }).collect()
}

// ---------------------------------------------------------------- index

/// Words that make a word pair too common to find a passage by.
const STOP: &[&str] = &[
    "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "by", "for", "with", "from", "as", "is", "are",
    "was", "were", "be", "been", "it", "this", "that", "i", "you", "he", "she", "we", "they", "me", "him", "her", "us",
    "them", "my", "your", "his", "our", "their", "will", "would", "can", "not", "no", "so", "do", "did", "have", "has",
    "had", "what", "who", "if", "there", "all", "one", "said", "say",
];
/// Extra words that say nothing about which chapter a sermon is near.
const FILLER: &[&str] = &[
    "amen", "hallelujah", "know", "going", "come", "go", "people", "thing", "things", "want", "get", "got", "like",
    "just", "very", "now", "today", "see", "let", "make", "made", "because", "about", "into", "when", "then", "than",
    "also", "even", "more", "many", "much", "some", "every", "other", "out", "up", "down", "way", "time", "day",
    "man", "men", "life", "god", "lord", "jesus", "christ", "church", "bible", "book", "chapter", "verse",
];
const MAX_POINTS_SHOWN: usize = 25;

/// A passage that can be quoted: a paragraph, or a chapter title or
/// heading ("If You Are Too Busy to Pray Then You Are Too Busy" is a
/// chapter of How to Pray, and the line preachers repeat).
struct Passage {
    book: u16,
    chapter: u16,
    part: Part,
}

#[derive(Clone, Copy)]
enum Part {
    Title,
    Head(u32),
    Para(u32),
}

#[derive(Default)]
pub struct Library {
    books: Vec<Book>,
    passages: Vec<Passage>,
    /// Sorted (pair, passage) postings.
    keys: Vec<u64>,
    vals: Vec<u32>,
    stop: HashSet<String>,
    /// Chapters in book order: (book, chapter).
    chapters: Vec<(u16, u16)>,
    /// (Bible book, chapter) -> (chapter index, first verse, last verse).
    verse_index: HashMap<(usize, usize), Vec<(u32, usize, usize)>>,
    ref_idf: HashMap<(usize, usize), f32>,
    ref_norm: Vec<f32>,
    /// Term -> (chapter index, normalized tf-idf weight).
    terms: HashMap<String, Vec<(u32, f32)>>,
    idf: HashMap<String, f32>,
}

static LIBRARY: RwLock<Option<Arc<Library>>> = RwLock::new(None);

fn library() -> Arc<Library> {
    if let Some(l) = LIBRARY.read().unwrap().as_ref() {
        return l.clone();
    }
    Arc::new(Library::default())
}

pub fn set_books(books: Vec<Book>) {
    let lib = Arc::new(Library::build(books));
    *LIBRARY.write().unwrap() = Some(lib);
}

fn stems(list: &[&str]) -> HashSet<String> {
    list.iter().map(|w| recite::stem(w)).collect()
}

/// Content words of `text`, stemmed: what a sermon and a chapter share.
fn terms_of(text: &str, skip: &HashSet<String>) -> HashMap<String, f32> {
    let mut tf: HashMap<String, f32> = HashMap::new();
    for w in recite::words(text) {
        if w.len() > 2 && !skip.contains(&w) {
            *tf.entry(w).or_default() += 1.0;
        }
    }
    tf
}

impl Library {
    fn build(books: Vec<Book>) -> Library {
        let stop = stems(STOP);
        let mut postings: Vec<(u64, u32)> = Vec::new();
        let mut passages = Vec::new();
        let mut chapters = Vec::new();
        let mut verse_index: HashMap<(usize, usize), Vec<(u32, usize, usize)>> = HashMap::new();
        let eng = engine();
        let mut skip_terms = stems(recite::QUOTE_STOP);
        skip_terms.extend(stems(FILLER));
        skip_terms.extend(stop.iter().cloned());
        let mut ch_tf: Vec<HashMap<String, f32>> = Vec::new();
        for (bi, b) in books.iter().enumerate() {
            for (ci, c) in b.chapters.iter().enumerate() {
                let chi = chapters.len() as u32;
                chapters.push((bi as u16, ci as u16));
                for label in &c.refs {
                    if let Some(r) = eng.parse_refs(label).into_iter().next() {
                        let v = r.verse.unwrap_or(0);
                        verse_index.entry((r.book, r.chapter)).or_default().push((chi, v, r.end_verse.unwrap_or(v)));
                    }
                }
                let mut tf = terms_of(&c.title, &skip_terms);
                for v in tf.values_mut() {
                    *v *= 3.0;
                }
                for h in &c.heads {
                    for (t, n) in terms_of(h, &skip_terms) {
                        *tf.entry(t).or_default() += 2.0 * n;
                    }
                }
                let mut parts: Vec<(Part, &str)> = vec![(Part::Title, c.title.as_str())];
                // Numbered points are paragraphs too: index them once.
                parts.extend(c.heads.iter().enumerate().filter(|(_, h)| !numbered(h)).map(|(i, h)| (Part::Head(i as u32), h.as_str())));
                for (pi, p) in c.paras.iter().enumerate() {
                    if !p.scripture {
                        for (t, n) in terms_of(&p.text, &skip_terms) {
                            *tf.entry(t).or_default() += n;
                        }
                        parts.push((Part::Para(pi as u32), p.text.as_str()));
                    }
                }
                for (part, text) in parts {
                    let n = passages.len() as u32;
                    passages.push(Passage { book: bi as u16, chapter: ci as u16, part });
                    let mut ks = index_pairs(text, &stop);
                    ks.sort_unstable();
                    ks.dedup();
                    postings.extend(ks.into_iter().map(|k| (k, n)));
                }
                ch_tf.push(tf);
            }
        }
        postings.sort_unstable();
        let (keys, vals) = postings.into_iter().unzip();
        // tf-idf vectors of the chapters, normalized.
        let n = ch_tf.len().max(1) as f32;
        let mut df: HashMap<&str, usize> = HashMap::new();
        for tf in &ch_tf {
            for t in tf.keys() {
                *df.entry(t.as_str()).or_default() += 1;
            }
        }
        let idf: HashMap<String, f32> = df.iter().map(|(t, &d)| (t.to_string(), (n / d as f32).ln() + 0.1)).collect();
        let mut terms: HashMap<String, Vec<(u32, f32)>> = HashMap::new();
        for (chi, tf) in ch_tf.iter().enumerate() {
            let w: Vec<(&String, f32)> = tf.iter().map(|(t, &c)| (t, (1.0 + c.ln()) * idf[t])).collect();
            let norm = w.iter().map(|(_, x)| x * x).sum::<f32>().sqrt().max(1e-6);
            for (t, x) in w {
                terms.entry(t.clone()).or_default().push((chi as u32, x / norm));
            }
        }
        // How rare each Bible chapter is among the books' chapters, and the
        // length of each chapter's verse vector, for a cosine over verses.
        let nch = chapters.len().max(1) as f32;
        let ref_idf: HashMap<(usize, usize), f32> = verse_index
            .iter()
            .map(|(k, list)| {
                let mut chs: Vec<u32> = list.iter().map(|x| x.0).collect();
                chs.dedup();
                (*k, (nch / chs.len() as f32).ln().max(0.1))
            })
            .collect();
        let mut ref_norm = vec![0f32; chapters.len()];
        for (k, list) in &verse_index {
            for &(ch, _, _) in list {
                ref_norm[ch as usize] += ref_idf[k] * ref_idf[k];
            }
        }
        for x in ref_norm.iter_mut() {
            *x = x.sqrt();
        }
        Library { books, passages, keys, vals, stop, chapters, verse_index, ref_idf, ref_norm, terms, idf }
    }

    fn postings(&self, k: u64) -> &[u32] {
        let a = self.keys.partition_point(|&x| x < k);
        let b = self.keys.partition_point(|&x| x <= k);
        &self.vals[a..b]
    }

    /// How rare a pair is, from 1 (in one passage) to 0 (in half of them),
    /// so the thresholds mean "this many rare pairs" for any number of books.
    fn weight(&self, k: u64) -> f32 {
        let df = self.postings(k).len();
        if df == 0 {
            return 0.0;
        }
        let n = self.passages.len() as f32;
        let top = (n / 2.0).ln().max(0.5);
        ((n / (1.0 + df as f32)).ln() / top).clamp(0.0, 1.0)
    }

    fn passage(&self, p: &Passage) -> (&Book, &Chapter, &str) {
        let b = &self.books[p.book as usize];
        let c = &b.chapters[p.chapter as usize];
        let text = match p.part {
            Part::Title => c.title.as_str(),
            Part::Head(i) => c.heads[i as usize].as_str(),
            Part::Para(i) => c.paras[i as usize].text.as_str(),
        };
        (b, c, text)
    }
}

/// Word pairs of `text` that are not two stop words, in order.
fn index_pairs(text: &str, stop: &HashSet<String>) -> Vec<u64> {
    let w = recite::words(text);
    w.windows(2).filter(|p| !(stop.contains(&p[0]) && stop.contains(&p[1]))).map(|p| recite::pair_key(&p[0], &p[1])).collect()
}

// ---------------------------------------------------------------- quotes

/// Spoken words that say a book is being quoted: "Daddy says", "Bishop
/// always says", "the Prophet said", "in his book".
pub fn cued(text: &str) -> bool {
    let t = format!(" {} ", text.to_lowercase().replace(|c: char| !c.is_ascii_alphanumeric(), " ").split_whitespace().collect::<Vec<_>>().join(" "));
    // Not "the book" or "this book": the book of life, the book of Acts.
    const CUES: [&str; 10] =
        [" daddy ", " papa ", " bishop ", " the prophet ", " dag ", " heward ", " his book ", " he wrote ", " he writes ", " man of god "];
    CUES.iter().any(|c| t.contains(c))
}

/// With a cue, this many word pairs in a row (about six words) is a quote.
const CUE_RUN: usize = 5;
const CUE_WEIGHT: f32 = 4.0;
/// Without one, the run must be long: ten words or more said as written.
const RUN: usize = 9;
const WEIGHT: f32 = 7.5;
/// Pairs in more passages than this only find candidates through rarer ones.
const COMMON_PAIR: usize = 1500;
const CANDIDATES: usize = 8;
/// Pairs missed in a row inside a run, and at most one miss per this many
/// pairs found (the first miss is free).
const MAX_GAP: usize = 2;
const MISS_RATIO: usize = 3;
/// Longest quote put on a slide.
const MAX_QUOTE_WORDS: usize = 80;

/// The passage of an imported book that the end of `text` quotes, if any.
/// Pass the last 30 seconds or so of finished transcript.
pub fn quoted(text: &str) -> Option<BookQuote> {
    let lib = library();
    if lib.passages.is_empty() {
        return None;
    }
    // A verse he recited is not a book quote, even if a book quotes it too.
    if recite::recited(text, None).is_some() {
        return None;
    }
    let spoken = index_pairs(text, &lib.stop);
    let mut distinct = spoken.clone();
    distinct.sort_unstable();
    distinct.dedup();
    let mut cand: HashMap<u32, f32> = HashMap::new();
    for &k in &distinct {
        let list = lib.postings(k);
        if !list.is_empty() && list.len() < COMMON_PAIR {
            let w = lib.weight(k);
            for &p in list {
                *cand.entry(p).or_default() += w;
            }
        }
    }
    let mut ranked: Vec<(u32, f32)> = cand.into_iter().collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    let cue = cued(text);
    // The longest run wins; on a tie, the passage more of which was said
    // (a chapter title over a paragraph that repeats it).
    let mut best: Option<(u32, usize, f32, f32)> = None;
    for (pi, _) in ranked.into_iter().take(CANDIDATES) {
        let (_, _, text) = lib.passage(&lib.passages[pi as usize]);
        let mut have = index_pairs(text, &lib.stop);
        have.sort_unstable();
        have.dedup();
        let (run, weight) = longest_run(&spoken, &have, &lib);
        let share = run as f32 / have.len().max(1) as f32;
        if best.map_or(true, |(_, r, w, sh)| (run, weight, share) > (r, w, sh)) {
            best = Some((pi, run, weight, share));
        }
    }
    let (pi, run, weight, _) = best?;
    let ok = if cue { run >= CUE_RUN && weight >= CUE_WEIGHT } else { run >= RUN && weight >= WEIGHT };
    if !ok {
        return None;
    }
    let (b, c, text) = lib.passage(&lib.passages[pi as usize]);
    let text_out = quoted_sentences(text, &spoken, &lib);
    // The book quoting a verse in the author's own paragraph: still a verse.
    if recite::recited(&text_out, None).is_some_and(|r| r.share >= 0.5) {
        return None;
    }
    Some(BookQuote { book: b.title.clone(), chapter: c.title.clone(), text: text_out, passage: pi, run, weight })
}

/// The longest stretch of spoken pairs found in the passage, allowing a
/// changed word here and there ("how the heavenly father" for "how our
/// heavenly father": two pairs missed in a row) as long as most pairs match:
/// (distinct pairs found, their weight). A pair
/// said again counts once: "In your time. In your time. In your time."
/// repeated seven times matched a book on 2013-07-09.
fn longest_run(spoken: &[u64], have: &[u64], lib: &Library) -> (usize, f32) {
    let mut best = (0usize, 0f32);
    let mut cur = (0usize, 0f32);
    let mut seen: HashSet<u64> = HashSet::new();
    // Misses in a row, and in the whole run.
    let (mut gap, mut misses) = (0usize, 0usize);
    for &k in spoken {
        if have.binary_search(&k).is_ok() {
            if seen.insert(k) {
                cur.0 += 1;
                cur.1 += lib.weight(k);
            }
            gap = 0;
            if cur > best {
                best = cur;
            }
        } else if cur.0 > 0 && gap < MAX_GAP && (misses + 1) * MISS_RATIO <= cur.0 + MISS_RATIO {
            gap += 1;
            misses += 1;
        } else {
            cur = (0, 0.0);
            seen.clear();
            gap = 0;
            misses = 0;
        }
    }
    best
}

/// The passage's sentences that hold the spoken pairs, from the first such
/// sentence to the last (at most MAX_QUOTE_WORDS words).
fn quoted_sentences(text: &str, spoken: &[u64], lib: &Library) -> String {
    let mut said: Vec<u64> = spoken.to_vec();
    said.sort_unstable();
    let sentences = split_sentences(text);
    let hits: Vec<usize> = sentences
        .iter()
        .map(|s| index_pairs(s, &lib.stop).iter().filter(|k| said.binary_search(k).is_ok()).count())
        .collect();
    let Some(first) = hits.iter().position(|&h| h >= 2) else { return trim_words(text, MAX_QUOTE_WORDS) };
    let last = hits.iter().rposition(|&h| h >= 2).unwrap_or(first);
    trim_words(&sentences[first..=last].join(" "), MAX_QUOTE_WORDS)
}

fn split_sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = text.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        cur.push(c);
        let end = matches!(c, '.' | '!' | '?') && chars.get(i + 1).map_or(true, |n| n.is_whitespace() || "\"”’'".contains(*n));
        let close = "\"”’'".contains(c) && i > 0 && matches!(chars[i - 1], '.' | '!' | '?');
        if (end && !chars.get(i + 1).is_some_and(|n| "\"”’'".contains(*n))) || close {
            out.push(cur.trim().to_string());
            cur.clear();
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

fn trim_words(text: &str, n: usize) -> String {
    let w: Vec<&str> = text.split_whitespace().collect();
    if w.len() <= n {
        return text.to_string();
    }
    w[..n].join(" ") + "…"
}

// ---------------------------------------------------------------- chapters

/// In the verse cosine, a verse of the same Bible chapter that is not the
/// same verse counts this much of a shared verse.
const SAME_CHAPTER: f32 = 0.3;
/// Both scores are cosines (0 to 1); the verse one counts this much.
const VERSE_WEIGHT: f32 = 0.5;
/// A chapter goes to the AI when its score is at least MIN_SCORE and its
/// words alone at least MIN_WORDS, or its score at least STRONG_SCORE. On
/// 22 recorded sermons the chapters a sermon was preached from scored 0.32
/// to 0.66 (Backsliding, Those Who Leave You, Those Who Honour You), with
/// words 0.21 to 0.29; the best chapter of the others 0.20 to 0.37, with
/// words mostly under 0.15.
pub const MIN_SCORE: f32 = 0.3;
const MIN_WORDS: f32 = 0.2;
const STRONG_SCORE: f32 = 0.45;

/// The `n` chapters closest to a sermon whose transcript is `text` and which
/// used the verses `refs` ("Romans 4:21"), best first, above MIN_SCORE.
pub fn related(text: &str, refs: &[String], n: usize) -> Vec<Outline> {
    related_above(text, refs, n, MIN_SCORE)
        .into_iter()
        .filter(|o| o.words >= MIN_WORDS || o.score >= STRONG_SCORE)
        .collect()
}

/// The same, with no minimum score: for measuring (examples/books.rs).
pub fn related_scored(text: &str, refs: &[String], n: usize) -> Vec<Outline> {
    related_above(text, refs, n, 0.0)
}

fn related_above(text: &str, refs: &[String], n: usize, min: f32) -> Vec<Outline> {
    let lib = library();
    if lib.chapters.is_empty() {
        return Vec::new();
    }
    let eng = engine();
    // A cosine between the sermon's verses and each chapter's, weighted by
    // how rare each Bible chapter is in the books: a chapter that lists a
    // hundred verses no longer matches every sermon.
    let rare = (lib.chapters.len() as f32).ln();
    let mut dot = vec![0f32; lib.chapters.len()];
    let mut norm = 0f32;
    let mut seen = HashSet::new();
    for label in refs {
        let Some(r) = eng.parse_refs(label).into_iter().next() else { continue };
        if !seen.insert((r.book, r.chapter, r.verse)) {
            continue;
        }
        let idf = lib.ref_idf.get(&(r.book, r.chapter)).copied().unwrap_or(rare);
        norm += idf * idf;
        let Some(list) = lib.verse_index.get(&(r.book, r.chapter)) else { continue };
        let v = r.verse.unwrap_or(0);
        let mut best: HashMap<u32, f32> = HashMap::new();
        for &(ch, a, b) in list {
            let s = if v > 0 && a <= v && v <= b { 1.0 } else { SAME_CHAPTER };
            let e = best.entry(ch).or_default();
            *e = e.max(s * idf * idf);
        }
        for (ch, s) in best {
            dot[ch as usize] += s;
        }
    }
    let norm = norm.sqrt().max(1e-6);
    let verse_score: Vec<f32> = dot.iter().zip(&lib.ref_norm).map(|(d, n)| d / (norm * n.max(1e-6))).collect();
    let mut skip_terms = stems(recite::QUOTE_STOP);
    skip_terms.extend(stems(FILLER));
    skip_terms.extend(lib.stop.iter().cloned());
    let q: Vec<(String, f32)> = terms_of(text, &skip_terms)
        .into_iter()
        .filter_map(|(t, c)| lib.idf.get(&t).map(|idf| (t, (1.0 + c.ln()) * idf)))
        .collect();
    let qn = q.iter().map(|(_, x)| x * x).sum::<f32>().sqrt().max(1e-6);
    let mut word_score = vec![0f32; lib.chapters.len()];
    for (t, x) in &q {
        if let Some(list) = lib.terms.get(t) {
            for &(ch, w) in list {
                word_score[ch as usize] += w * x / qn;
            }
        }
    }
    let mut ranked: Vec<(usize, f32)> =
        (0..lib.chapters.len()).map(|i| (i, word_score[i] + VERSE_WEIGHT * verse_score[i])).collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    ranked
        .into_iter()
        .take(n)
        .filter(|&(_, s)| s >= min)
        .map(|(i, s)| {
            let (bi, ci) = lib.chapters[i];
            let b = &lib.books[bi as usize];
            let c = &b.chapters[ci as usize];
            Outline {
                book: b.title.clone(),
                chapter: c.title.clone(),
                heads: c.heads.iter().take(MAX_POINTS_SHOWN).cloned().collect(),
                refs: c.refs.iter().take(40).cloned().collect(),
                score: s,
                verses: VERSE_WEIGHT * verse_score[i],
                words: word_score[i],
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const CH1: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>ch1</title><style>p{}</style></head>
<body><h1 class="chapter">CHAPTER 1</h1><h2>Labour to be Blessed!</h2>
<p class="scripture">There is one alone, and there is not a second; yea, he hath neither child nor brother: yet is there no end of all his labour; neither is his eye satisfied with riches.</p>
<p class="ref">Ecclesiastes 4:8</p>
<p>Solomon, the wisest man to ever live, made an observation that we must consider deeply. He wondered why people were working endlessly &amp; why they were so bent on fighting, labouring, suffering, working and sweating in this world.</p>
<p>1. What are you in school for?</p>
<p>2. What are you working for?</p>
<h3>Fight for a Blessing</h3>
<p>Your vision must be to obtain a blessing rather than to obtain riches. Instead of fighting for money, fight for a blessing. A blessing is what will change your life. Jacob and Esau wrestled over a blessing. Jacob and Esau did not fight over money.</p>
<p>If you are too busy to pray, you are busier than God intended you to be. Prayerlessness is the mother of many backslidings, and every backslider stopped praying long before he stopped coming to church.</p>
</body></html>"#;
    const CH2: &str = r#"<html><body><h1>CHAPTER 2</h1><h2>Labour Not to be Rich</h2>
<p>Labour not to be rich: cease from thine own wisdom.</p><p>Proverbs 23:4</p>
<p>It is amazing that there is a scripture that says we should not labour to be rich. Riches have wings and fly away like an eagle towards heaven. The man who labours for riches will find that his treasure is never enough for him, because riches cannot satisfy a soul that was made for blessings.</p>
<p>So many people go on and on working for money that they will never use. They build houses they cannot live in and buy cars they cannot drive, and still they want more and more of the same things.</p>
</body></html>"#;

    fn epub() -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            z.start_file("mimetype", o).unwrap();
            z.write_all(b"application/epub+zip").unwrap();
            z.start_file("META-INF/container.xml", o).unwrap();
            z.write_all(br#"<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#).unwrap();
            z.start_file("OEBPS/content.opf", o).unwrap();
            z.write_all(br#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Labour to be Blessed</dc:title></metadata><manifest><item id="toc" href="Text/toc.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="Text/chapter%201.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="toc"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>"#).unwrap();
            z.start_file("OEBPS/Text/toc.xhtml", o).unwrap();
            z.write_all(b"<html><body><h1>Contents</h1><p>Chapter 1 Labour to be Blessed!</p><p>Chapter 2 Labour Not to be Rich</p></body></html>").unwrap();
            z.start_file("OEBPS/Text/chapter 1.xhtml", o).unwrap();
            z.write_all(CH1.as_bytes()).unwrap();
            z.start_file("OEBPS/Text/ch2.xhtml", o).unwrap();
            z.write_all(CH2.as_bytes()).unwrap();
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    fn book() -> Book {
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(epub())).unwrap();
        epub_book(&mut z, "x").unwrap()
    }

    #[test]
    fn epub_chapters_headings_points_and_verses() {
        let b = book();
        assert_eq!(b.title, "Labour to be Blessed");
        assert_eq!(b.id, "labour-to-be-blessed");
        assert_eq!(b.chapters.len(), 2, "{:?}", b.chapters.iter().map(|c| &c.title).collect::<Vec<_>>());
        let c = &b.chapters[0];
        assert_eq!(c.title, "Labour to be Blessed!");
        assert_eq!(c.heads, vec!["1. What are you in school for?", "2. What are you working for?", "Fight for a Blessing"]);
        assert_eq!(c.refs, vec!["Ecclesiastes 4:8"]);
        // The verse above the reference is the Bible's words, not his.
        assert!(c.paras[0].scripture && c.paras[1].scripture && !c.paras[2].scripture);
        assert!(c.paras[2].text.contains("endlessly & why"));
        assert_eq!(b.chapters[1].refs, vec!["Proverbs 23:4"]);
    }

    #[test]
    fn styled_headings_and_scripture_from_real_epubs() {
        // Backsliding: headings are bold paragraphs (by CSS class or <b>),
        // the verse an italic paragraph above its reference.
        let sigil = r#"<html><head><style type="text/css">
  p.sgc-5 {font-weight: bold; text-align: center}
  p.sgc-6 {font-style: italic; font-weight: bold}
  p.sgc-7 {font-style: italic; font-weight: bold; text-align: right}
</style></head><body>
<h1 class="sgc-3"><a href="../Text/TOC.xhtml"><span class="c6">Chapter 3</span></a></h1>
<h2 class="sgc-4"><span>Principal Causes of Backsliding</span></h2>
<h1 id="heading_id_4" title="Chapter 3: Principal Causes of Backsliding"></h1>
<p>&nbsp;I know that there are many causes of backsliding, but in this chapter, I will try to give you the predominant causes, as the Lord has shown me, and many of them are found in the parable of the sower.</p>
<p class="sgc-5">&nbsp;Shallowness</p>
<p class="sgc-6">... and these have NO ROOT, which for a while believe...</p>
<p class="sgc-7">Luke 8:13&nbsp;</p>
<p>The parable of the sower gives various reasons why some of the seeds could not grow. &nbsp;Some seeds could not grow because they fell on rocky soil.</p>
<p class="sgc-2">&nbsp;<b>Everyone Will Be Tested</b></p>
<p>A time of testing will surely come for every Christian. &nbsp;If you are <i>shallow</i>, in the time of testing, you will fall. <b>They have no convictions of their own.</b></p>
</body></html>"#;
        let b = assemble("b", "Backsliding", html_blocks(sigil, &Css::new()));
        let c = &b.chapters[0];
        assert_eq!(c.title, "Principal Causes of Backsliding");
        assert_eq!(c.heads, vec!["Shallowness", "Everyone Will Be Tested"]);
        assert_eq!(c.refs, vec!["Luke 8:13"]);
        let scr: Vec<bool> = c.paras.iter().map(|p| p.scripture).collect();
        assert_eq!(scr, vec![false, true, true, false, false]);
        // Tasters and Partakers: classes say what each paragraph is, and a
        // passage of several verses sits above one reference.
        let classed = r#"<html><body>
<h3 class="CHAPTER-TITLE-NO-LINES" title="CHAPTER 2: What it Means to Become a Partaker">CHAPTER 2</h3>
<h2 class="CHAPTER-TITLE-NO-LINES">What it Means to Become a Partaker</h2>
<p class="DROP-CAP">To become a partaker is to become many things. In this chapter, you will discover many things that you can go deeper into and become a partaker of, and there is no need to be a taster only.</p>
<p class="MAIN-POINT">1.	It means to become a partaker of Christ.</p>
<p class="BODY-TEXT">Perhaps, the most important thing is for you to become a partaker of Christ. You must not only taste of the Lord to see that He is good. You must partake of Christ and go deeper.</p>
<p class="BODY-TEXT">This know also, that in the last days perilous times shall come, said the apostle, and so they did.</p>
<p class="BIBLE-VERSE-PLAIN">For the wrath of God is revealed from heaven against all ungodliness and unrighteousness of men;</p>
<p class="BIBLE-VERSE-PLAIN">Because that which may be known of God is manifest in them; for God hath shewed it unto them.</p>
<p class="Bible-Ref-Plain">Romans 1:18-19</p>
<p class="SUB-TITLE-">Six Ways to Partake</p>
</body></html>"#;
        let b = assemble("t", "Tasters", html_blocks(classed, &Css::new()));
        let c = &b.chapters[0];
        assert_eq!(c.title, "What it Means to Become a Partaker");
        assert_eq!(c.heads, vec!["1. It means to become a partaker of Christ.", "Six Ways to Partake"]);
        let scr: Vec<bool> = c.paras.iter().map(|p| p.scripture).collect();
        assert_eq!(scr, vec![false, false, false, false, true, true, true]);
        // A stylesheet's bold classes.
        let mut css = Css::new();
        parse_css("/* x */ p.p8, span.big { font-weight: 700 } .p9 {font-style:italic} p.p11 {text-align: justify}", &mut css);
        assert_eq!(css.get("p8"), Some(&(true, false)));
        assert_eq!(css.get("big"), Some(&(true, false)));
        assert_eq!(css.get("p9"), Some(&(false, true)));
        assert_eq!(css.get("p11"), None);
    }

    #[test]
    fn plain_text_from_a_pdf() {
        let text = "Labour to be blessed\nDAG HEWARD-MILLS\n\nContents\nCHAPTER 1: Labour to be Blessed!\nCHAPTER 2: Labour Not to be Rich\n\nCHAPTER 1\n\nLabour to be Blessed!\nThere is one alone, and there is not a second; yea, he hath\nneither child nor brother: yet is there no end of all his labour.\nEcclesiastes 4:8\nSolomon, the wisest man to ever live, made an observation that we\nmust consider deeply. He wondered why people were working\nendlessly and fighting and labouring and suffering and sweating in this world and\nwhy they never asked what it was all for, and what they were building.\n1. What are you in school for?\n2. What are you working for?\nThese are also questions that come into my mind whenever I see\npeople struggling, hustling, working and suffering in our dark and\ndifficult world. Many people achieve their goals several times over.\n\x0cCHAPTER 2\n\nLabour Not to be Rich\nIt is amazing that there is a scripture that says we should not labour\nto be rich. Riches have wings and fly away like an eagle towards heaven and\nthe man who labours for riches will find that his treasure is never enough\nfor him, because riches cannot satisfy a soul that was made for blessings, and so\nhe goes on and on working for money that he will never use in this life.\nThey build houses they cannot live in and buy cars they cannot drive, and still\nthey want more and more of the same things, and they never stop to ask why.\n";
        let b = assemble("t", "Labour to be blessed", text_blocks(text));
        let titles: Vec<&str> = b.chapters.iter().map(|c| c.title.as_str()).collect();
        assert_eq!(titles, vec!["Labour to be Blessed!", "Labour Not to be Rich"]);
        let c = &b.chapters[0];
        assert_eq!(c.refs, vec!["Ecclesiastes 4:8"]);
        assert!(c.paras[0].scripture);
        assert_eq!(c.heads, vec!["1. What are you in school for?", "2. What are you working for?"]);
    }

    #[test]
    fn quotes_and_related_chapters() {
        set_books(vec![book()]);
        // Cued and loose: "Bishop always says".
        let q = quoted("And Bishop always says that if you are too busy to pray, then you are busier than God intended you to be. You have to make time.").unwrap();
        assert_eq!(q.book, "Labour to be Blessed");
        assert!(q.text.starts_with("If you are too busy to pray"), "{}", q.text);
        // Uncued, the same few words are not enough...
        assert!(quoted("if you are too busy to pray then you are busier").is_none());
        // ...but a long run said as written is.
        assert!(quoted("instead of fighting for money, fight for a blessing. a blessing is what will change your life").is_some());
        // A verse the book quotes is the Bible's, not the book's.
        assert!(quoted("Daddy says, labour not to be rich, cease from thine own wisdom.").is_none());
        // Ordinary preaching.
        assert!(quoted("Praise the Lord. Today we are going to talk about money and riches and blessing.").is_none());
        // A phrase said over and over is not a long quote.
        assert!(quoted("fight for a blessing, fight for a blessing, fight for a blessing, fight for a blessing, fight for a blessing").is_none());
        let r = related_above("we will talk about labour for riches, riches have wings, labour not to be rich", &["Proverbs 23:4".into()], 2, 0.0);
        assert_eq!(r[0].chapter, "Labour Not to be Rich");
        set_books(Vec::new());
    }

    #[test]
    fn chapter_headings() {
        assert_eq!(chapter_heading("CHAPTER 3"), Some("".into()));
        assert_eq!(chapter_heading("Chapter Three: Labour for a Blessing"), Some("Labour for a Blessing".into()));
        assert_eq!(chapter_heading("CHAPTER 12: Labour for Exemption from Evil"), Some("Labour for Exemption from Evil".into()));
        assert_eq!(chapter_heading("Chapters of life"), None);
        assert_eq!(chapter_heading("Chapter by chapter we read"), None);
    }

    #[test]
    fn cues() {
        assert!(cued("Daddy says that loyalty is"));
        assert!(cued("as the Prophet said"));
        assert!(!cued("the prophets that make my people err"));
        assert!(!cued("he said that"));
    }
}
