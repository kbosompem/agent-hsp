use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{OnceLock, RwLock};

const BOOK_ALIASES: [&[&str]; 66] = [
    &["genesis", "gen", "ge"],
    &["exodus", "exo", "ex"],
    &["leviticus", "lev", "lv"],
    &["numbers", "num", "nm"],
    &["deuteronomy", "deut", "dt"],
    &["joshua", "josh", "jos"],
    &["judges", "judg"],
    &["ruth", "rth"],
    &["1 samuel", "first samuel", "one samuel", "1sam", "i samuel", "1sa", "1 sm"],
    &["2 samuel", "second samuel", "two samuel", "2sam", "ii samuel", "2sa", "2 sm"],
    &["1 kings", "first kings", "one kings", "1kings", "i kings", "1 kgs", "1kg"],
    &["2 kings", "second kings", "two kings", "2kings", "ii kings", "2 kgs", "2kg"],
    &["1 chronicles", "first chronicles", "one chronicles", "1chron", "i chronicles", "1 chron", "1chr"],
    &["2 chronicles", "second chronicles", "two chronicles", "2chron", "ii chronicles", "2 chron", "2chr"],
    &["ezra", "ezr"],
    &["nehemiah", "neh"],
    &["esther", "esth", "est"],
    &["job"],
    &["psalms", "psalm", "ps", "psa"],
    &["proverbs", "prov", "prv"],
    &["ecclesiastes", "eccl", "eccles", "ec", "ecclesiast", "ecclesiastics", "ecclesiates"],
    &["song of solomon", "song of songs", "songs", "sos", "canticles", "song"],
    &["isaiah", "isa"],
    &["jeremiah", "jer"],
    &["lamentations", "lam"],
    &["ezekiel", "ezek", "eze"],
    &["daniel", "dan"],
    &["hosea", "hos"],
    &["joel"],
    &["amos"],
    &["obadiah", "obad", "ob"],
    &["jonah", "jon"],
    &["micah", "mic"],
    &["nahum", "nah"],
    &["habakkuk", "hab", "habakuk", "habbakuk", "habbakkuk"],
    &["zephaniah", "zeph", "zephania", "zephenia"],
    &["haggai", "hag"],
    &["zechariah", "zech", "zec"],
    &["malachi", "mal"],
    &["matthew", "matt", "mat", "mt"],
    &["mark", "mrk", "mk"],
    &["luke", "luk", "lk"],
    &["john", "jn", "joh"],
    &["acts", "act"],
    &["romans", "rom", "roms", "rm"],
    &["1 corinthians", "first corinthians", "one corinthians", "1cor", "i corinthians", "1 cor"],
    &["2 corinthians", "second corinthians", "two corinthians", "2cor", "ii corinthians", "2 cor"],
    &["galatians", "gal"],
    &["ephesians", "eph"],
    &["philippians", "phil", "php", "phillipians", "philipians"],
    &["colossians", "col"],
    &["1 thessalonians", "first thessalonians", "one thessalonians", "1thess", "i thessalonians", "1 thess"],
    &["2 thessalonians", "second thessalonians", "two thessalonians", "2thess", "ii thessalonians", "2 thess"],
    &["1 timothy", "first timothy", "one timothy", "1tim", "i timothy", "1 tim"],
    &["2 timothy", "second timothy", "two timothy", "2tim", "ii timothy", "2 tim"],
    &["titus", "tit"],
    &["philemon", "philem", "phlm"],
    &["hebrews", "heb"],
    &["james", "jas", "jm"],
    &["1 peter", "first peter", "one peter", "1pet", "i peter", "1 pet", "1 pt"],
    &["2 peter", "second peter", "two peter", "2pet", "ii peter", "2 pet", "2 pt"],
    &["1 john", "first john", "one john", "1john", "i john", "1 jn"],
    &["2 john", "second john", "two john", "2john", "ii john"],
    &["3 john", "third john", "three john", "3john", "iii john"],
    &["jude", "jud"],
    &["revelation", "rev", "revelations"],
];

const VERSE_WORDS: [&str; 4] = ["verse", "verses", "vs", "v"];
const CHAPTER_WORDS: [&str; 4] = ["chapter", "chapters", "chap", "ch"];
const RANGE_WORDS: [&str; 8] = ["to", "two", "too", "thru", "through", "until", "till", "and"];

const STOPWORDS: &[&str] = &[
    "that", "this", "with", "have", "from", "they", "will", "would", "there", "their",
    "about", "which", "when", "what", "been", "were", "said", "then", "them", "than",
    "some", "come", "over", "into", "only", "also", "back", "like", "make", "made",
    "much", "many", "most", "next", "name", "book", "going", "because", "people",
    "before", "after", "again", "where", "these", "those", "still", "under", "never",
    "every", "shall", "unto", "thee", "thou", "hath", "mine", "your", "yours", "ours",
    "him", "her", "she", "his", "you", "are", "was", "the", "and", "for", "not", "but",
    "all", "out", "who", "has", "had", "did", "does", "its", "our", "two", "one",
    "chapter", "verse", "today", "truth", "world", "heart", "soul", "life", "love",
    // one letter from a book name, common in sermons: "point number one" is not Numbers 1
    "number", "numbered", "palm", "king", "games", "arts", "part", "parts",
];

#[derive(Deserialize, Serialize, Clone)]
pub struct RawBook {
    #[serde(rename = "n")]
    pub name: String,
    #[serde(rename = "c")]
    pub chapters: Vec<Vec<String>>,
}

#[derive(Clone, Serialize)]
pub struct Translation {
    pub id: String,
    pub name: String,
    pub books: Vec<RawBook>,
}

#[derive(Clone)]
struct AliasEntry {
    tokens: Vec<String>,
    book: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct BibleRef {
    pub book: usize,
    pub chapter: usize,
    pub verse: Option<usize>,
    pub end_verse: Option<usize>,
    #[serde(skip)]
    pub pos: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VerseHit {
    pub label: String,
    pub text: String,
    pub reference: Option<BibleRef>,
    pub translation: String,
}

pub struct Engine {
    translations: RwLock<Vec<Translation>>,
    aliases: Vec<AliasEntry>,
}

#[derive(Debug)]
struct ParsedRef {
    chapter: usize,
    verse: Option<usize>,
    end_verse: Option<usize>,
    end: usize,
}

const KJV_JSON: &str = include_str!("../kjv.json");
const ASV_JSON: &str = include_str!("../assets/asv.json");
const WEB_JSON: &str = include_str!("../assets/web.json");
const BBE_JSON: &str = include_str!("../assets/bbe.json");
// Built from eBible.org USFM with scripts/bibles/usfm2json.py. Licences and
// attribution: assets/BIBLES.md.
const BSB_JSON: &str = include_str!("../assets/bsb.json");
const LSV_JSON: &str = include_str!("../assets/lsv.json");
const FBV_JSON: &str = include_str!("../assets/fbv.json");

static ENGINE: OnceLock<Engine> = OnceLock::new();

pub fn init_engine(dir: Option<&Path>) {
    let _ = ENGINE.set(Engine::load(dir));
}

pub fn engine() -> &'static Engine {
    if ENGINE.get().is_none() {
        let _ = ENGINE.set(Engine::load(None));
    }
    ENGINE.get().unwrap()
}

impl Engine {
    fn parse_translation(json: &str, fallback_id: &str, fallback_name: &str) -> Option<Translation> {
        let v: serde_json::Value = serde_json::from_str(json).ok()?;
        let books: Vec<RawBook> = serde_json::from_value(v.get("books")?.clone()).ok()?;
        if books.len() != 66 {
            return None;
        }
        let id = v
            .get("id")
            .and_then(|x| x.as_str())
            .unwrap_or(fallback_id)
            .to_lowercase();
        let name = v
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or(fallback_name)
            .to_string();
        Some(Translation { id, name, books })
    }

    fn base() -> Vec<Translation> {
        let mut out = Vec::new();
        if let Some(t) = Self::parse_translation(KJV_JSON, "kjv", "King James Version") {
            out.push(t);
        }
        if let Some(t) = Self::parse_translation(ASV_JSON, "asv", "American Standard Version") {
            out.push(t);
        }
        if let Some(t) = Self::parse_translation(WEB_JSON, "web", "World English Bible") {
            out.push(t);
        }
        if let Some(t) = Self::parse_translation(BBE_JSON, "bbe", "Bible in Basic English") {
            out.push(t);
        }
        if let Some(t) = Self::parse_translation(BSB_JSON, "bsb", "Berean Standard Bible (BSB)") {
            out.push(t);
        }
        if let Some(t) = Self::parse_translation(LSV_JSON, "lsv", "Literal Standard Version (LSV)") {
            out.push(t);
        }
        if let Some(t) = Self::parse_translation(FBV_JSON, "fbv", "Free Bible Version (FBV)") {
            out.push(t);
        }
        out
    }

    pub fn load(dir: Option<&Path>) -> Engine {
        let mut translations = Engine::base();
        if let Some(d) = dir {
            let _ = std::fs::create_dir_all(d);
            if let Ok(entries) = std::fs::read_dir(d) {
                for e in entries.flatten() {
                    let p = e.path();
                    if p.extension().map(|x| x == "json").unwrap_or(false) {
                        if let Ok(content) = std::fs::read_to_string(&p) {
                            if let Some(t) =
                                Self::parse_translation(&content, "imported", "Imported")
                            {
                                if !translations.iter().any(|x| x.id == t.id) {
                                    translations.push(t);
                                }
                            }
                        }
                    }
                }
            }
        }
        let mut aliases: Vec<AliasEntry> = Vec::new();
        {
            let trs = &translations;
            for (b, book) in trs[0].books.iter().enumerate() {
                let mut names: Vec<String> = BOOK_ALIASES[b].iter().map(|s| s.to_string()).collect();
                let full = book.name.to_lowercase();
                if !names.contains(&full) {
                    names.insert(0, full);
                }
                for n in names {
                    aliases.push(AliasEntry {
                        tokens: n.split(' ').map(|s| s.to_string()).collect(),
                        book: b,
                    });
                }
            }
        }
        aliases.sort_by(|a, b| b.tokens.len().cmp(&a.tokens.len()));
        Engine {
            translations: RwLock::new(translations),
            aliases,
        }
    }

    pub fn list_translations(&self) -> Vec<(String, String)> {
        self.translations
            .read()
            .unwrap()
            .iter()
            .map(|t| (t.id.clone(), t.name.clone()))
            .collect()
    }

    pub fn tr_index(&self, id: Option<&str>) -> usize {
        let trs = self.translations.read().unwrap();
        match id {
            Some(id) if !id.is_empty() => {
                trs.iter().position(|t| t.id == id).unwrap_or(0)
            }
            _ => 0,
        }
    }

    pub fn add_translation_json(&self, json: &str) -> Result<(String, String), String> {
        let t = Self::parse_translation(json, "imported", "Imported")
            .ok_or("Not a valid translation file: expected {\"id\", \"name\", \"books\"} with 66 books.")?;
        let mut trs = self.translations.write().unwrap();
        let id = t.id.clone();
        let name = t.name.clone();
        if let Some(pos) = trs.iter().position(|x| x.id == id) {
            trs[pos] = t;
        } else {
            trs.push(t);
        }
        Ok((id, name))
    }

    pub fn parse_translation_any(content: &str, fallback_name: &str) -> Option<Translation> {
        let trimmed = content.trim_start();
        if trimmed.starts_with('{') {
            return Self::parse_translation(content, "imported", fallback_name);
        }
        Self::parse_translation_xml(content, fallback_name)
    }

    pub fn parse_translation_xml(xml: &str, fallback_name: &str) -> Option<Translation> {
        let doc = roxmltree::Document::parse(xml).ok()?;
        let root = doc.root_element();
        let mut books: Vec<Option<Vec<Vec<String>>>> = vec![None; 66];
        let mut name = fallback_name.to_string();
        let tag = root.tag_name().name().to_string();
        if tag == "XMLBIBLE" {
            if let Some(bn) = root.attribute("biblename") {
                if !bn.trim().is_empty() {
                    name = bn.trim().to_string();
                }
            }
            for book_el in root
                .children()
                .filter(|n| n.tag_name().name() == "BIBLEBOOK")
            {
                let bnum: usize = match book_el.attribute("bnumber").and_then(|v| v.parse().ok()) {
                    Some(n) => n,
                    None => continue,
                };
                if bnum < 1 || bnum > 66 {
                    continue;
                }
                let mut chapters: Vec<Vec<String>> = Vec::new();
                for ch in book_el
                    .children()
                    .filter(|n| n.tag_name().name() == "CHAPTER")
                {
                    let cnum: usize = match ch.attribute("cnumber").and_then(|v| v.parse().ok()) {
                        Some(n) => n,
                        None => continue,
                    };
                    if cnum < 1 {
                        continue;
                    }
                    let mut verses: Vec<(usize, String)> = Vec::new();
                    for vs in ch.children().filter(|n| n.tag_name().name() == "VERS") {
                        let vnum: usize = match vs.attribute("vnumber").and_then(|v| v.parse().ok()) {
                            Some(n) => n,
                            None => continue,
                        };
                        let text: String = vs
                            .descendants()
                            .filter(|n| n.is_text())
                            .map(|n| n.text().unwrap_or(""))
                            .collect::<String>()
                            .split_whitespace()
                            .collect::<Vec<_>>()
                            .join(" ");
                        if !text.is_empty() {
                            verses.push((vnum, text));
                        }
                    }
                    verses.sort_by_key(|x| x.0);
                    while chapters.len() < cnum {
                        chapters.push(Vec::new());
                    }
                    chapters[cnum - 1] = verses.into_iter().map(|x| x.1).collect();
                }
                if !chapters.is_empty() {
                    books[bnum - 1] = Some(chapters);
                }
            }
        } else if tag == "bible" {
            if let Some(t) = root.attribute("translation") {
                if !t.trim().is_empty() {
                    name = t.trim().to_string();
                }
            }
            for b_el in root.children().filter(|n| n.tag_name().name() == "b") {
                let bname = match b_el.attribute("n") {
                    Some(n) => n,
                    None => continue,
                };
                let bidx = match book_index_by_name(bname) {
                    Some(x) => x,
                    None => continue,
                };
                let cnum: usize = match b_el.attribute("c").and_then(|v| v.parse().ok()) {
                    Some(n) => n,
                    None => continue,
                };
                if cnum < 1 {
                    continue;
                }
                let mut verses: Vec<(usize, String)> = Vec::new();
                for vs in b_el.children().filter(|n| n.tag_name().name() == "v") {
                    let vnum: usize = match vs.attribute("n").and_then(|v| v.parse().ok()) {
                        Some(n) => n,
                        None => continue,
                    };
                    let text: String = vs
                        .descendants()
                        .filter(|n| n.is_text())
                        .map(|n| n.text().unwrap_or(""))
                        .collect::<String>()
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ");
                    if !text.is_empty() {
                        verses.push((vnum, text));
                    }
                }
                verses.sort_by_key(|x| x.0);
                let slot = &mut books[bidx];
                let chs = slot.get_or_insert_with(Vec::new);
                while chs.len() < cnum {
                    chs.push(Vec::new());
                }
                chs[cnum - 1] = verses.into_iter().map(|x| x.1).collect();
            }
        } else if tag == "osis" || tag == "osisText" {
            for v_el in doc.descendants().filter(|n| n.tag_name().name() == "verse") {
                let osis_id = v_el
                    .attribute("osisID")
                    .or_else(|| v_el.attribute("osisid"))
                    .unwrap_or("");
                let parts: Vec<&str> = osis_id.split('.').collect();
                if parts.len() < 3 {
                    continue;
                }
                let bidx = match OSIS_IDS.iter().position(|x| *x == parts[0]) {
                    Some(x) => x,
                    None => continue,
                };
                let cnum: usize = parts[1].parse().ok()?;
                let vnum: usize = parts[2].parse().ok()?;
                let text: String = v_el
                    .descendants()
                    .filter(|n| n.is_text())
                    .map(|n| n.text().unwrap_or(""))
                    .collect::<String>()
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                if text.is_empty() || cnum < 1 || vnum < 1 {
                    continue;
                }
                let slot = &mut books[bidx];
                let chs = slot.get_or_insert_with(Vec::new);
                while chs.len() < cnum {
                    chs.push(Vec::new());
                }
                let verses = &mut chs[cnum - 1];
                while verses.len() < vnum {
                    verses.push(String::new());
                }
                verses[vnum - 1] = text;
            }
        } else {
            return None;
        }
        let mut final_books: Vec<RawBook> = Vec::with_capacity(66);
        let mut found = 0usize;
        for (b, slot) in books.into_iter().enumerate() {
            let chapters = slot.unwrap_or_default();
            if chapters.iter().any(|c| !c.is_empty()) {
                found += 1;
            }
            final_books.push(RawBook {
                name: BOOK_NAMES[b].to_string(),
                chapters: chapters,
            });
        }
        if found == 0 {
            return None;
        }
        let id: String = name
            .to_lowercase()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect();
        let id = if id.is_empty() {
            "imported".to_string()
        } else {
            id
        };
        Some(Translation {
            id: id,
            name: name,
            books: final_books,
        })
    }

    pub fn parse_refs(&self, text: &str) -> Vec<BibleRef> {
        let trs = self.translations.read().unwrap();
        let books = &trs[0].books;
        parse_refs_impl(text, books, &self.aliases)
    }

    fn valid_ref(
        &self,
        tr: usize,
        book: usize,
        chapter: usize,
        verse: Option<usize>,
        end_verse: Option<usize>,
    ) -> Option<BibleRef> {
        let trs = self.translations.read().unwrap();
        if tr >= trs.len() {
            return None;
        }
        let chapters = &trs[tr].books[book].chapters;
        if chapter < 1 || chapter > chapters.len() {
            return None;
        }
        let vc = chapters[chapter - 1].len();
        let mut v = None;
        let mut ev = None;
        if let Some(vv) = verse {
            if vv < 1 || vv > vc {
                return None;
            }
            v = Some(vv);
            if let Some(e) = end_verse {
                if e > vv && e <= vc {
                    ev = Some(e);
                }
            }
        }
        Some(BibleRef {
            book,
            chapter,
            verse: v,
            end_verse: ev,
            pos: 0,
        })
    }

    pub fn ref_label(&self, tr: usize, r: &BibleRef) -> String {
        let trs = self.translations.read().unwrap();
        ref_label_books(&trs[tr].books, r)
    }

    pub fn get_verse(&self, tr: usize, r: &BibleRef) -> String {
        let trs = self.translations.read().unwrap();
        get_verse_books(&trs[tr].books, r)
    }

    pub fn lookup(&self, input: &str, tr_id: Option<&str>) -> Vec<VerseHit> {
        let tr = self.tr_index(tr_id);
        let mut refs = self.parse_refs(input);
        if refs.is_empty() {
            let corrected = self.correct_book_names(input);
            if corrected != input {
                refs = self.parse_refs(&corrected);
            }
        }
        let trs = self.translations.read().unwrap();
        let books = &trs[tr].books;
        refs.into_iter()
            .filter_map(|r| {
                self.valid_ref(tr, r.book, r.chapter, r.verse, r.end_verse)?;
                Some(VerseHit {
                    label: ref_label_books(books, &r),
                    text: get_verse_books(books, &r),
                    reference: Some(r),
                    translation: trs[tr].name.clone(),
                })
            })
            .collect()
    }

    /// One hit spanning verses v..=e, labelled "Book C:V-E".
    pub fn verse_range_hit(&self, tr_id: Option<&str>, book: usize, chapter: usize, v: usize, e: usize) -> Option<VerseHit> {
        let tr = self.tr_index(tr_id);
        let r = self.valid_ref(tr, book, chapter, Some(v), Some(e))?;
        let trs = self.translations.read().unwrap();
        let books = &trs[tr].books;
        Some(VerseHit {
            label: ref_label_books(books, &r),
            text: get_verse_books(books, &r),
            reference: Some(r),
            translation: trs[tr].name.clone(),
        })
    }

    pub fn verse_at(
        &self,
        tr_id: Option<&str>,
        book: usize,
        chapter: usize,
        verse: usize,
    ) -> Option<VerseHit> {
        let tr = self.tr_index(tr_id);
        let r = self.valid_ref(tr, book, chapter, Some(verse), None)?;
        let trs = self.translations.read().unwrap();
        let books = &trs[tr].books;
        Some(VerseHit {
            label: ref_label_books(books, &r),
            text: get_verse_books(books, &r),
            reference: Some(r),
            translation: trs[tr].name.clone(),
        })
    }

    pub fn verse_range(
        &self,
        tr_id: Option<&str>,
        book: usize,
        chapter: usize,
        from: usize,
        to: usize,
    ) -> Vec<VerseHit> {
        let tr = self.tr_index(tr_id);
        let mut out = Vec::new();
        if let Some(r) = self.valid_ref(tr, book, chapter, Some(from), Some(to)) {
            let end = r.end_verse.unwrap_or(from);
            let trs = self.translations.read().unwrap();
            let books = &trs[tr].books;
            for v in from..=end {
                if let Some(r2) = self.valid_ref(tr, book, chapter, Some(v), None) {
                    out.push(VerseHit {
                        label: ref_label_books(books, &r2),
                        text: get_verse_books(books, &r2),
                        reference: Some(r2),
                        translation: trs[tr].name.clone(),
                    });
                }
            }
        }
        out
    }

    pub fn correct_book_names(&self, input: &str) -> String {
        let norm = normalize(input);
        let tokens: Vec<&str> = norm.split(' ').filter(|s| !s.is_empty()).collect();
        let singles: Vec<String> = {
            let mut seen = HashSet::new();
            self.aliases
                .iter()
                .filter(|a| a.tokens.len() == 1 && a.tokens[0].len() >= 4)
                .map(|a| a.tokens[0].clone())
                .filter(|a| seen.insert(a.clone()))
                .collect()
        };
        for i in 0..tokens.len() {
            let t = tokens[i];
            if t.len() < 4 || STOPWORDS.contains(&t) {
                continue;
            }
            let limit = (t.len() / 4).max(1);
            let mut best: Option<(String, usize)> = None;
            for alias in &singles {
                let d = damerau(t, alias);
                if d <= limit && (best.is_none() || d < best.as_ref().unwrap().1) {
                    best = Some((alias.clone(), d));
                }
            }
            if let Some((rep, _)) = best {
                let mut cand = tokens.clone();
                cand[i] = rep.as_str();
                let cand_text = cand.join(" ");
                if !self.parse_refs(&cand_text).is_empty() {
                    return cand_text;
                }
            }
        }
        input.to_string()
    }
}

fn ref_label_books(books: &[RawBook], r: &BibleRef) -> String {
    let mut name = books[r.book].name.clone();
    if name == "Psalms" {
        name = "Psalm".to_string();
    }
    if books[r.book].chapters.len() == 1 {
        return match r.verse {
            None => name,
            Some(v) => match r.end_verse {
                Some(e) => format!("{} {}-{}", name, v, e),
                None => format!("{} {}", name, v),
            },
        };
    }
    match r.verse {
        None => format!("{} {}", name, r.chapter),
        Some(v) => match r.end_verse {
            Some(e) => format!("{} {}:{}-{}", name, r.chapter, v, e),
            None => format!("{} {}:{}", name, r.chapter, v),
        },
    }
}

fn get_verse_books(books: &[RawBook], r: &BibleRef) -> String {
    let ch = &books[r.book].chapters[r.chapter - 1];
    match r.verse {
        None => ch[0].clone(),
        Some(v) => {
            let end = r.end_verse.unwrap_or(v);
            let hi = std::cmp::min(end, ch.len());
            let parts: Vec<&str> = (v..=hi).map(|i| ch[i - 1].as_str()).collect();
            parts.join(" ")
        }
    }
}

fn damerau(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (la, lb) = (a.len(), b.len());
    let mut d = vec![vec![0usize; lb + 1]; la + 1];
    for i in 0..=la {
        d[i][0] = i;
    }
    for j in 0..=lb {
        d[0][j] = j;
    }
    for i in 1..=la {
        for j in 1..=lb {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            d[i][j] = std::cmp::min(
                std::cmp::min(d[i - 1][j] + 1, d[i][j - 1] + 1),
                d[i - 1][j - 1] + cost,
            );
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d[i][j] = std::cmp::min(d[i][j], d[i - 2][j - 2] + 1);
            }
        }
    }
    d[la][lb]
}

const BOOK_NAMES: [&str; 66] = [
    "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy", "Joshua", "Judges", "Ruth",
    "1 Samuel", "2 Samuel", "1 Kings", "2 Kings", "1 Chronicles", "2 Chronicles", "Ezra",
    "Nehemiah", "Esther", "Job", "Psalms", "Proverbs", "Ecclesiastes", "Song of Solomon",
    "Isaiah", "Jeremiah", "Lamentations", "Ezekiel", "Daniel", "Hosea", "Joel", "Amos",
    "Obadiah", "Jonah", "Micah", "Nahum", "Habakkuk", "Zephaniah", "Haggai", "Zechariah",
    "Malachi", "Matthew", "Mark", "Luke", "John", "Acts", "Romans", "1 Corinthians",
    "2 Corinthians", "Galatians", "Ephesians", "Philippians", "Colossians",
    "1 Thessalonians", "2 Thessalonians", "1 Timothy", "2 Timothy", "Titus", "Philemon",
    "Hebrews", "James", "1 Peter", "2 Peter", "1 John", "2 John", "3 John", "Jude",
    "Revelation",
];

const OSIS_IDS: [&str; 66] = [
    "Gen", "Exod", "Lev", "Num", "Deut", "Josh", "Judg", "Ruth", "1Sam", "2Sam", "1Kgs",
    "2Kgs", "1Chr", "2Chr", "Ezra", "Neh", "Esth", "Job", "Ps", "Prov", "Eccl", "Song",
    "Isa", "Jer", "Lam", "Ezek", "Dan", "Hos", "Joel", "Amos", "Obad", "Jonah", "Mic",
    "Nah", "Hab", "Zeph", "Hag", "Zech", "Mal", "Matt", "Mark", "Luke", "John", "Acts",
    "Rom", "1Cor", "2Cor", "Gal", "Eph", "Phil", "Col", "1Thess", "2Thess", "1Tim",
    "2Tim", "Titus", "Phlm", "Heb", "Jas", "1Pet", "2Pet", "1John", "2John", "3John",
    "Jude", "Rev",
];

fn normalize_book_name(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

fn book_index_by_name(name: &str) -> Option<usize> {
    static MAP: OnceLock<std::collections::HashMap<String, usize>> = OnceLock::new();
    let map = MAP.get_or_init(|| {
        let mut m = std::collections::HashMap::new();
        for (b, aliases) in BOOK_ALIASES.iter().enumerate() {
            for a in aliases.iter() {
                m.insert(normalize_book_name(a), b);
            }
        }
        m
    });
    map.get(&normalize_book_name(name)).copied()
}

fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_space = true;
    for ch in text.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            last_space = false;
        } else if !last_space {
            out.push(' ');
            last_space = true;
        }
    }
    out.trim().to_string()
}

fn word_value(w: &str) -> Option<usize> {
    Some(match w {
        "first" => 1, "second" => 2, "third" => 3, "fourth" => 4, "fifth" => 5,
        "sixth" => 6, "seventh" => 7, "eighth" => 8, "ninth" => 9, "twelfth" => 12,
        "one" => 1, "two" => 2, "three" => 3, "four" => 4, "five" => 5,
        "six" => 6, "seven" => 7, "eight" => 8, "nine" => 9,
        "ten" => 10, "eleven" => 11, "twelve" => 12, "thirteen" => 13, "fourteen" => 14,
        "fifteen" => 15, "sixteen" => 16, "seventeen" => 17, "eighteen" => 18, "nineteen" => 19,
        "twenty" => 20, "thirty" => 30, "forty" => 40, "fifty" => 50,
        "sixty" => 60, "seventy" => 70, "eighty" => 80, "ninety" => 90,
        "hundred" | "hundreds" => 100,
        _ => return None,
    })
}

fn word_to_number(w: &str) -> Option<usize> {
    if w.is_empty() {
        return None;
    }
    if let Ok(n) = w.parse::<usize>() {
        return Some(n);
    }
    let l = w.len();
    if l > 2 && (w.ends_with("st") || w.ends_with("nd") || w.ends_with("rd") || w.ends_with("th")) {
        if let Ok(n) = w[..l - 2].parse::<usize>() {
            return Some(n);
        }
    }
    if let Some(v) = word_value(w) {
        return Some(v);
    }
    if l > 4 && w.ends_with("ieth") {
        if let Some(v) = word_value(&format!("{}y", &w[..l - 4])) {
            return Some(v);
        }
    }
    if l > 2 && w.ends_with("th") {
        if let Some(v) = word_value(&w[..l - 2]) {
            return Some(v);
        }
    }
    None
}

fn parse_num_seq(tokens: &[&str], i: usize) -> Option<(usize, usize)> {
    let mut cur = 0usize;
    let mut len = 0usize;
    while len < 4 && i + len < tokens.len() {
        let w = tokens[i + len];
        if w == "and" {
            if len == 0 {
                break;
            }
            if let Some(nx) = tokens.get(i + len + 1) {
                if word_to_number(nx).is_some() {
                    len += 1;
                    continue;
                }
            }
            break;
        }
        let n = match word_to_number(w) {
            Some(n) => n,
            None => break,
        };
        if n == 100 {
            cur = if cur == 0 { 1 } else { cur } * 100;
        } else if cur == 0 {
            cur = n;
        } else if cur % 10 == 0 && n < 10 {
            cur += n;
        } else if cur % 100 == 0 {
            cur += n;
        } else {
            break;
        }
        len += 1;
        if cur > 999 {
            break;
        }
    }
    if len == 0 || cur == 0 {
        None
    } else {
        Some((cur, len))
    }
}

fn match_book(tokens: &[&str], i: usize, aliases: &[AliasEntry]) -> Option<(usize, usize)> {
    for e in aliases {
        let l = e.tokens.len();
        if i + l > tokens.len() {
            continue;
        }
        if e.tokens
            .iter()
            .zip(tokens[i..i + l].iter())
            .all(|(a, b)| a == b)
        {
            return Some((e.book, l));
        }
    }
    None
}

/// One spoken digit: "one".."nine" or "1".."9"; "o", "oh", "zero" or "0"
/// only inside a run ("one o seven").
fn single_digit(w: &str, first: bool) -> Option<usize> {
    match w {
        "o" | "oh" | "zero" | "0" if !first => Some(0),
        _ if w.len() == 1 && w.as_bytes()[0].is_ascii_digit() && w != "0" => w.parse().ok(),
        "one" => Some(1), "two" => Some(2), "three" => Some(3), "four" => Some(4), "five" => Some(5),
        "six" => Some(6), "seven" => Some(7), "eight" => Some(8), "nine" => Some(9),
        _ => None,
    }
}

/// Chapters read digit by digit: "Psalm one one nine" is Psalm 119 and
/// "Psalm one o seven" is 107. Three digits always join; two join only when
/// "verse" follows ("Psalm one one verse 5" is 11:5, "John three one" stays
/// 3:1). Returns (chapter, tokens used) when the chapter exists (`max_ch`).
fn digit_run_chapter(tokens: &[&str], k: usize, max_ch: usize) -> Option<(usize, usize)> {
    let mut digits = Vec::new();
    while digits.len() < 3 {
        match tokens.get(k + digits.len()).and_then(|w| single_digit(w, digits.is_empty())) {
            Some(d) => digits.push(d),
            None => break,
        }
    }
    let joins = digits.len() == 3
        || (digits.len() == 2 && VERSE_WORDS.contains(&tokens.get(k + 2).copied().unwrap_or("")));
    if !joins {
        return None;
    }
    let n = digits.iter().fold(0, |a, d| a * 10 + d);
    (n >= 1 && n <= max_ch).then_some((n, digits.len()))
}

fn parse_ref_after_book(tokens: &[&str], j: usize, max_ch: usize) -> Option<ParsedRef> {
    let mut k = j;
    if CHAPTER_WORDS.contains(&tokens.get(k).copied().unwrap_or("")) {
        k += 1;
        // "Mark chapter number 2"
        if matches!(tokens.get(k).copied(), Some("number") | Some("no")) {
            k += 1;
        }
    }
    let (chapter, chlen) = match digit_run_chapter(tokens, k, max_ch) {
        Some(x) => x,
        None => parse_num_seq(tokens, k)?,
    };
    k += chlen;
    if tokens.get(k) == Some(&"and")
        && VERSE_WORDS.contains(&tokens.get(k + 1).copied().unwrap_or(""))
    {
        k += 1;
    }
    let mut verse: Option<usize> = None;
    let mut end_verse: Option<usize> = None;
    if VERSE_WORDS.contains(&tokens.get(k).copied().unwrap_or("")) {
        if let Some((v, l)) = parse_num_seq(tokens, k + 1) {
            verse = Some(v);
            k += 1 + l;
        }
    } else if let Some((v, l)) = parse_num_seq(tokens, k) {
        verse = Some(v);
        k += l;
    }
    if let Some(v) = verse {
        let mut lk = k;
        if RANGE_WORDS.contains(&tokens.get(lk).copied().unwrap_or(""))
            && VERSE_WORDS.contains(&tokens.get(lk + 1).copied().unwrap_or(""))
        {
            lk += 1;
        }
        if RANGE_WORDS.contains(&tokens.get(lk).copied().unwrap_or(""))
            && !VERSE_WORDS.contains(&tokens.get(lk + 1).copied().unwrap_or(""))
        {
            if let Some((e, l)) = parse_num_seq(tokens, lk + 1) {
                if e > v {
                    end_verse = Some(e);
                    k = lk + 1 + l;
                }
            }
        } else if end_verse.is_none() {
            if let Some((e, l)) = parse_num_seq(tokens, k) {
                if e > v {
                    end_verse = Some(e);
                    k += l;
                }
            }
        }
    }
    Some(ParsedRef {
        chapter,
        verse,
        end_verse,
        end: k,
    })
}

fn parse_refs_impl(
    text: &str,
    books: &[RawBook],
    aliases: &[AliasEntry],
) -> Vec<BibleRef> {
    let norm = normalize(text);
    if norm.is_empty() {
        return Vec::new();
    }
    let owned = rewrite_tokens(&norm);
    let tokens: Vec<&str> = owned.iter().map(|s| s.as_str()).collect();
    let mut refs: Vec<BibleRef> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    macro_rules! push {
        ($r:expr, $pos:expr) => {
            if let Some(r) = $r {
                let key = format!("{}:{}:{:?}:{:?}", r.book, r.chapter, r.verse, r.end_verse);
                if seen.insert(key) {
                    let mut rr = r;
                    rr.pos = $pos;
                    refs.push(rr);
                }
            }
        };
    }
    let mut i = 0usize;
    while i < tokens.len() {
        if let Some((book, mlen)) = match_book(&tokens, i, aliases) {
            if let Some(p) = parse_ref_after_book(&tokens, i + mlen, books[book].chapters.len()) {
                let r = valid_ref_books(books, book, p.chapter, p.verse, p.end_verse).or_else(|| {
                    if p.verse.is_none() {
                        split_glued(books, book, p.chapter)
                    } else {
                        None
                    }
                });
                push!(r, i);
                i = std::cmp::max(p.end, i + mlen);
                continue;
            }
            if books[book].chapters.len() == 1 {
                let k2 = i + mlen;
                let (vv, used) =
                    if VERSE_WORDS.contains(&tokens.get(k2).copied().unwrap_or("")) {
                        match parse_num_seq(&tokens, k2 + 1) {
                            Some((v, l)) => (Some(v), 1 + l),
                            None => (None, 0),
                        }
                    } else {
                        match parse_num_seq(&tokens, k2) {
                            Some((v, l)) => (Some(v), l),
                            None => (None, 0),
                        }
                    };
                if let Some(v) = vv {
                    push!(valid_ref_books(books, book, 1, Some(v), None), i);
                    i = k2 + used;
                    continue;
                }
            }
            i += mlen;
            continue;
        }
        if tokens[i] == "book" && tokens.get(i + 1) == Some(&"of") {
            if let Some((book, mlen)) = match_book(&tokens, i + 2, aliases) {
                if let Some(p) = parse_ref_after_book(&tokens, i + 2 + mlen, books[book].chapters.len()) {
                    push!(
                        valid_ref_books(books, book, p.chapter, p.verse, p.end_verse),
                        i
                    );
                    i = std::cmp::max(p.end, i + 2 + mlen);
                    continue;
                }
            }
        }
        i += 1;
    }
    for ci in 0..tokens.len() {
        if tokens[ci] != "chapter" && tokens[ci] != "chapters" {
            continue;
        }
        let (chap, mut book_at) = if ci > 0 {
            match word_to_number(tokens[ci - 1]) {
                Some(n) => (n, ci + 1),
                None => match parse_num_seq(&tokens, ci + 1) {
                    Some((v, l)) if tokens.get(ci + 1 + l) == Some(&"of") => (v, ci + 2 + l),
                    _ => continue,
                },
            }
        } else {
            continue;
        };
        if tokens.get(book_at) == Some(&"of") {
            book_at += 1;
        }
        let (book, mlen) = match match_book(&tokens, book_at, aliases) {
            Some(x) => x,
            None => continue,
        };
        let after = book_at + mlen;
        let vv = if VERSE_WORDS.contains(&tokens.get(after).copied().unwrap_or("")) {
            parse_num_seq(&tokens, after + 1).map(|(v, _)| v)
        } else {
            parse_num_seq(&tokens, after).map(|(v, _)| v)
        };
        push!(valid_ref_books(books, book, chap, vv, None), ci.saturating_sub(2));
    }
    refs.sort_by_key(|r| r.pos);
    refs
}

/// Undo transcription habits before matching: "1st John" means First John,
/// and "Micah 6a" is "Micah six eight" with the eight heard as "a".
fn rewrite_tokens(norm: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in norm.split(' ') {
        // "verse number 16", "chapter number 2"
        if t == "number"
            && out
                .last()
                .map_or(false, |p| VERSE_WORDS.contains(&p.as_str()) || CHAPTER_WORDS.contains(&p.as_str()))
        {
            continue;
        }
        match t {
            "1st" => out.push("first".into()),
            "2nd" => out.push("second".into()),
            "3rd" => out.push("third".into()),
            _ => {
                let b = t.as_bytes();
                if b.len() >= 2
                    && b.len() <= 4
                    && b[b.len() - 1] == b'a'
                    && b[..b.len() - 1].iter().all(|c| c.is_ascii_digit())
                {
                    out.push(t[..t.len() - 1].to_string());
                    out.push("8".into());
                } else {
                    out.push(t.to_string());
                }
            }
        }
    }
    out
}

/// Whisper often writes "Philippians 4 13" as "Philippians 413". When the
/// number is not a real chapter, split it into chapter and verse, but only
/// when exactly one split is a real verse ("Genesis 111" stays unresolved).
fn split_glued(books: &[RawBook], book: usize, n: usize) -> Option<BibleRef> {
    let s = n.to_string();
    if s.len() < 3 {
        return None;
    }
    let mut found = None;
    for k in 1..s.len() {
        if s[k..].starts_with('0') {
            continue;
        }
        let c: usize = s[..k].parse().ok()?;
        let v: usize = s[k..].parse().ok()?;
        if let Some(r) = valid_ref_books(books, book, c, Some(v), None) {
            if found.is_some() {
                return None;
            }
            found = Some(r);
        }
    }
    found
}

fn valid_ref_books(
    books: &[RawBook],
    book: usize,
    chapter: usize,
    verse: Option<usize>,
    end_verse: Option<usize>,
) -> Option<BibleRef> {
    if book >= books.len() {
        return None;
    }
    let chapters = &books[book].chapters;
    if chapter < 1 || chapter > chapters.len() {
        return None;
    }
    let vc = chapters[chapter - 1].len();
    let mut v = None;
    let mut ev = None;
    if let Some(vv) = verse {
        if vv < 1 || vv > vc {
            return None;
        }
        v = Some(vv);
        if let Some(e) = end_verse {
            if e > vv && e <= vc {
                ev = Some(e);
            }
        }
    }
    Some(BibleRef {
        book,
        chapter,
        verse: v,
        end_verse: ev,
        pos: 0,
    })
}

/// Follows the passage the preacher has open, so "verse 6 says..." shows
/// verse 6 of that chapter, including when the chapter was named in the
/// previous sentence ("First Corinthians chapter 13. ... Verse 1.").
///
/// Call with `commit: true` for final transcripts, which move the context;
/// partials pass `commit: false` and only read it.
pub struct LiveLookup {
    ctx: Option<(usize, usize, f64)>,
    /// Last words of the previous final, for a book named at the end of one
    /// sentence and its chapter at the start of the next ("Because Daniel..."
    /// / "Chapter 11, I believe, and verse 32").
    tail: Vec<String>,
    tail_labels: Vec<String>,
    tail_at: f64,
}

const TAIL_WORDS: usize = 4;
/// The carried-over tail only joins sentences this close together.
const TAIL_TTL_S: f64 = 30.0;

/// An open passage is forgotten after this long without a mention.
const CONTEXT_TTL_S: f64 = 600.0;

impl LiveLookup {
    pub fn new() -> LiveLookup {
        LiveLookup { ctx: None, tail: Vec::new(), tail_labels: Vec::new(), tail_at: 0.0 }
    }

    pub fn reset(&mut self) {
        self.ctx = None;
        self.tail.clear();
        self.tail_labels.clear();
    }

    pub fn lookup(&mut self, text: &str, tr_id: Option<&str>, now_s: f64, commit: bool) -> Vec<VerseHit> {
        let eng = engine();
        let mut hits = self.resolve(text, tr_id, now_s, eng.lookup(text, tr_id));
        // "... First" / "John four four": the speech engine split a numbered
        // book across two transcripts. When the previous one ended on an
        // ordinal and this one opens with a reference, the joined reading
        // (1 John 4:4) wins over the bare one (John 4:4).
        let tail_ordinal = self.tail.last().map_or(false, |w| {
            // Words only: "...verse 1" / "John 3 16" must not become 1 John.
            matches!(w.as_str(), "first" | "second" | "third")
        });
        if tail_ordinal
            && now_s - self.tail_at <= TAIL_TTL_S
            && hits.first().and_then(|h| h.reference.as_ref()).map_or(false, |r| r.pos == 0)
        {
            let joined = format!("{} {}", self.tail.join(" "), text);
            let n = self.tail.len();
            let numbered: Vec<VerseHit> = eng
                .lookup(&joined, tr_id)
                .into_iter()
                .filter(|h| h.reference.as_ref().map_or(false, |r| r.pos == n - 1))
                .collect();
            if let Some(first) = numbered.first() {
                if Some(&first.label) != hits.first().map(|h| &h.label) {
                    let rest: Vec<VerseHit> = hits.into_iter().skip(1).collect();
                    let mut joined_hits = self.resolve(&joined, tr_id, now_s, vec![first.clone()]);
                    joined_hits.extend(rest);
                    hits = joined_hits;
                }
            }
        }
        if hits.is_empty() && !self.tail.is_empty() && now_s - self.tail_at <= TAIL_TTL_S {
            // Retry with the end of the previous sentence in front; keep only
            // references that start in that carried-over tail and were not
            // already shown from it.
            let joined = format!("{} {}", self.tail.join(" "), text);
            let n = self.tail.len();
            let carried: Vec<VerseHit> = eng
                .lookup(&joined, tr_id)
                .into_iter()
                .filter(|h| h.reference.as_ref().map_or(false, |r| r.pos < n))
                .filter(|h| !self.tail_labels.contains(&h.label))
                .collect();
            if !carried.is_empty() {
                hits = self.resolve(&joined, tr_id, now_s, carried);
            }
        }
        if commit {
            let toks = rewrite_tokens(&normalize(text));
            self.tail = toks[toks.len().saturating_sub(TAIL_WORDS)..].to_vec();
            self.tail_labels = hits.iter().map(|h| h.label.clone()).collect();
            self.tail_at = now_s;
            if let Some(r) = hits.last().and_then(|h| h.reference.clone()) {
                self.ctx = Some((r.book, r.chapter, now_s));
            }
        }
        hits
    }

    /// Add follow-up verses ("verse 21 says") to the parsed hits, in the
    /// chapter opened earlier in `text` or in the remembered context.
    fn resolve(&self, text: &str, tr_id: Option<&str>, now_s: f64, mut hits: Vec<VerseHit>) -> Vec<VerseHit> {
        let eng = engine();
        let owned = rewrite_tokens(&normalize(text));
        let tokens: Vec<&str> = owned.iter().map(|s| s.as_str()).collect();
        let refs: Vec<BibleRef> = hits.iter().filter_map(|h| h.reference.clone()).collect();
        let ctx = self.ctx.filter(|c| now_s - c.2 <= CONTEXT_TTL_S).map(|c| (c.0, c.1));
        let mut resolved_chapters: Vec<(usize, usize)> = Vec::new();
        let mut i = 0;
        while i < tokens.len() {
            if tokens[i] == "verse" || tokens[i] == "verses" {
                if let Some((v, len)) = parse_num_seq(&tokens, i + 1) {
                    // "John 3 verse 16": the parser already has this verse.
                    let owned_by_ref = refs.iter().any(|r| r.verse.is_some() && r.pos <= i && i - r.pos <= 6);
                    let open = refs.iter().filter(|r| r.pos < i).last().map(|r| (r.book, r.chapter)).or(ctx);
                    if let (false, Some((b, c))) = (owned_by_ref, open) {
                        let k = i + 1 + len;
                        let end = if RANGE_WORDS.contains(&tokens.get(k).copied().unwrap_or("")) {
                            parse_num_seq(&tokens, k + 1).map(|(e, _)| e)
                        } else {
                            None
                        };
                        let h = match end {
                            Some(e) if e > v => eng.verse_range_hit(tr_id, b, c, v, e),
                            _ => None,
                        }
                        .or_else(|| eng.verse_at(tr_id, b, c, v));
                        if let Some(h) = h {
                            if !hits.iter().any(|x| x.label == h.label) {
                                hits.push(h);
                            }
                            resolved_chapters.push((b, c));
                        }
                    }
                    i += 1 + len;
                    continue;
                }
            }
            i += 1;
        }
        // "Jeremiah chapter 2 ... verse 21": show the verse, not the chapter too.
        hits.retain(|h| {
            h.reference.as_ref().map_or(true, |r| r.verse.is_some() || !resolved_chapters.contains(&(r.book, r.chapter)))
        });
        hits
    }
}

impl Default for LiveLookup {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refs(text: &str) -> Vec<String> {
        engine()
            .parse_refs(text)
            .iter()
            .map(|r| engine().ref_label(0, r))
            .collect()
    }

    #[test]
    fn kjv_loads() {
        assert_eq!(engine().list_translations().len(), 7);
        assert_eq!(engine().list_translations()[0].0, "kjv");
        assert_eq!(
            engine().get_verse(0, &BibleRef { book: 18, chapter: 23, verse: Some(1), end_verse: None, pos: 0 }),
            "The LORD is my shepherd; I shall not want."
        );
        assert!(engine().get_verse(1, &BibleRef { book: 18, chapter: 23, verse: Some(1), end_verse: None, pos: 0 }).len() > 10);
    }

    #[test]
    fn digits_form() {
        assert_eq!(refs("Turn with me to John 3:16"), vec!["John 3:16"]);
    }

    #[test]
    fn chapter_verse_words() {
        assert_eq!(refs("in John chapter three verse sixteen"), vec!["John 3:16"]);
    }

    #[test]
    fn nth_chapter_of() {
        assert_eq!(
            refs("as we read in the third chapter of John, verse sixteen"),
            vec!["John 3:16"]
        );
    }

    #[test]
    fn spoken_numbers() {
        assert_eq!(refs("Paul writes in Romans five verse eight"), vec!["Romans 5:8"]);
    }

    #[test]
    fn chapter_only() {
        assert_eq!(refs("Turn to Psalms twenty three"), vec!["Psalm 23"]);
    }

    #[test]
    fn chapter_read_digit_by_digit() {
        assert_eq!(refs("Psalm one one nine verse five"), vec!["Psalm 119:5"]);
        assert_eq!(refs("turn to Psalm 1 1 9 verse 105"), vec!["Psalm 119:105"]);
        assert_eq!(refs("Psalm one o seven verse twenty"), vec!["Psalm 107:20"]);
        assert_eq!(refs("Psalm one oh seven twenty"), vec!["Psalm 107:20"]);
        assert_eq!(refs("Psalm one one verse five"), vec!["Psalm 11:5"]);
        // Two digits without "verse" stay chapter and verse.
        assert_eq!(refs("John three one"), vec!["John 3:1"]);
        assert_eq!(refs("Psalm one one"), vec!["Psalm 1:1"]);
        // A run that is not a real chapter falls back to the normal reading
        // (here the existing range rule: John 1:1-9).
        assert_eq!(refs("John one one nine"), vec!["John 1:1-9"]);
    }

    #[test]
    fn numbered_book_split_across_transcripts() {
        let mut live = LiveLookup::new();
        live.lookup("and the Bible says in First", None, 10.0, true);
        let h = live.lookup("John four four, greater is he", None, 12.0, true);
        assert_eq!(h.iter().map(|x| x.label.clone()).collect::<Vec<_>>(), vec!["1 John 4:4"]);
        let mut live = LiveLookup::new();
        live.lookup("we read in Second", None, 10.0, true);
        let h = live.lookup("Kings chapter nine verse thirty", None, 12.0, true);
        assert_eq!(h.iter().map(|x| x.label.clone()).collect::<Vec<_>>(), vec!["2 Kings 9:30"]);
        // A plain number at the end of the last sentence does not count.
        let mut live = LiveLookup::new();
        live.lookup("Romans 8 verse 1", None, 10.0, true);
        let h = live.lookup("John 3 16 says", None, 12.0, true);
        assert_eq!(h.iter().map(|x| x.label.clone()).collect::<Vec<_>>(), vec!["John 3:16"]);
        // Too long ago: no join.
        let mut live = LiveLookup::new();
        live.lookup("this is the first", None, 10.0, true);
        let h = live.lookup("John four four", None, 100.0, true);
        assert_eq!(h.iter().map(|x| x.label.clone()).collect::<Vec<_>>(), vec!["John 4:4"]);
    }

    #[test]
    fn glued_chapter_verse() {
        assert_eq!(refs("remember Philippians 413 and keep walking"), vec!["Philippians 4:13"]);
        assert_eq!(refs("John 316"), vec!["John 3:16"]);
        assert_eq!(refs("Psalm 1191"), vec!["Psalm 119:1"]);
        // ambiguous: 1:11 or 11:1
        assert!(refs("Genesis 111").is_empty());
        // a real chapter is never split
        assert_eq!(refs("Psalm 119"), vec!["Psalm 119"]);
    }

    #[test]
    fn transcription_habits() {
        assert_eq!(refs("1st Corinthians 13 verse 4"), vec!["1 Corinthians 13:4"]);
        assert_eq!(refs("2nd Timothy 3, 16."), vec!["2 Timothy 3:16"]);
        assert_eq!(refs("John writes in 1st John 1.9"), vec!["1 John 1:9"]);
        assert_eq!(refs("the preacher in Ecclesiast 3 1 says"), vec!["Ecclesiastes 3:1"]);
        assert_eq!(refs("And Micah 6a asks what does the Lord require"), vec!["Micah 6:8"]);
        assert_eq!(refs("Turn to Jeremiah 2911 for I know"), vec!["Jeremiah 29:11"]);
    }

    #[test]
    fn number_is_not_numbers() {
        assert!(refs("What is point number one? Then now").is_empty());
        assert!(engine().lookup("What is point number one? Then now", None).is_empty());
        assert_eq!(refs("The Gospel according to St. Mark chapter number 2"), vec!["Mark 2"]);
    }

    fn live(l: &mut LiveLookup, text: &str, t: f64) -> Vec<String> {
        l.lookup(text, None, t, true).into_iter().map(|h| h.label).collect()
    }

    #[test]
    fn followup_verse_in_same_sentence() {
        let mut l = LiveLookup::new();
        assert_eq!(live(&mut l, "Jeremiah chapter 2. Are you there? Verse 21 says that", 0.0), vec!["Jeremiah 2:21"]);
        assert_eq!(live(&mut l, "Luke chapter 8. From verse 18. This is about the parable", 5.0), vec!["Luke 8:18"]);
        assert_eq!(live(&mut l, "Isaiah chapter 42 verse number 16.", 9.0), vec!["Isaiah 42:16"]);
    }

    #[test]
    fn followup_verse_across_sentences() {
        let mut l = LiveLookup::new();
        assert_eq!(live(&mut l, "First Corinthians chapter 13.", 0.0), vec!["1 Corinthians 13"]);
        assert_eq!(live(&mut l, "Verse 1.", 3.0), vec!["1 Corinthians 13:1"]);
        assert_eq!(live(&mut l, "and verse 6 now says", 40.0), vec!["1 Corinthians 13:6"]);
        assert_eq!(live(&mut l, "verses 4 to 7", 60.0), vec!["1 Corinthians 13:4-7"]);
    }

    #[test]
    fn followup_needs_open_passage_and_expires() {
        let mut l = LiveLookup::new();
        assert!(live(&mut l, "verse 6 says", 0.0).is_empty());
        live(&mut l, "Mark chapter 2", 10.0);
        assert!(live(&mut l, "verse 6 says", 10.0 + 700.0).is_empty());
    }

    #[test]
    fn book_at_end_of_previous_sentence() {
        let mut l = LiveLookup::new();
        assert!(live(&mut l, "And along greener pastures, you must know God. Because Daniel...", 0.0).is_empty());
        assert_eq!(live(&mut l, "Chapter 11, I believe, and verse 32. The B part says that", 5.0), vec!["Daniel 11:32"]);
        // a reference already shown from the previous sentence is not repeated
        live(&mut l, "turn to Romans 8", 10.0);
        assert!(live(&mut l, "and he said it is good", 12.0).is_empty());
    }

    #[test]
    fn explicit_verse_is_not_doubled() {
        let mut l = LiveLookup::new();
        assert_eq!(live(&mut l, "John chapter 3 verse 16", 0.0), vec!["John 3:16"]);
    }

    #[test]
    fn partials_do_not_move_context() {
        let mut l = LiveLookup::new();
        live(&mut l, "Mark chapter 2", 0.0);
        let p: Vec<String> = l.lookup("Romans 8", None, 1.0, false).into_iter().map(|h| h.label).collect();
        assert_eq!(p, vec!["Romans 8"]);
        assert_eq!(live(&mut l, "verse 5", 2.0), vec!["Mark 2:5"]);
    }

    #[test]
    fn genesis_two_two() {
        assert_eq!(refs("genesis 2 2"), vec!["Genesis 2:2"]);
    }

    #[test]
    fn range_with_to() {
        assert_eq!(refs("john 3 verse 1 to 5"), vec!["John 3:1-5"]);
    }

    #[test]
    fn range_homophone_two() {
        assert_eq!(refs("john 3 verse 1 two 5"), vec!["John 3:1-5"]);
    }

    #[test]
    fn range_bare_numbers() {
        assert_eq!(refs("psalm 91 1-2"), vec!["Psalm 91:1-2"]);
    }

    #[test]
    fn range_second_verse_word() {
        assert_eq!(refs("Psalms 91 verses 1 to 5"), vec!["Psalm 91:1-5"]);
    }

    #[test]
    fn single_chapter_book() {
        assert_eq!(refs("Jude verse three says"), vec!["Jude 3"]);
    }

    #[test]
    fn book_of_form() {
        assert_eq!(refs("the book of James chapter one"), vec!["James 1"]);
    }

    #[test]
    fn two_refs() {
        assert_eq!(
            refs("compare John 3:16 with Romans 5:8"),
            vec!["John 3:16", "Romans 5:8"]
        );
    }

    #[test]
    fn no_false_positive_baptist() {
        assert!(refs("John the Baptist was preaching").is_empty());
    }

    #[test]
    fn no_false_positive_numbers() {
        assert!(refs("we had about sixteen people and three cars").is_empty());
    }

    #[test]
    fn verse_text() {
        let r = engine().parse_refs("John 3:16").remove(0);
        assert!(engine().get_verse(0, &r).starts_with("For God so loved the world"));
    }

    #[test]
    fn other_translation() {
        let hits = engine().lookup("John 3:16", Some("web"));
        assert_eq!(hits[0].translation, "World English Bible");
    }

    fn tr_ref(book: usize, chapter: usize, verse: usize) -> BibleRef {
        BibleRef { book, chapter, verse: Some(verse), end_verse: None, pos: 0 }
    }

    #[test]
    fn bundled_modern_translations_listed() {
        let ids: Vec<String> = engine().list_translations().into_iter().map(|(id, _)| id).collect();
        assert_eq!(ids, vec!["kjv", "asv", "web", "bbe", "bsb", "lsv", "fbv"]);
        let names: Vec<String> = engine().list_translations().into_iter().map(|(_, n)| n).collect();
        assert!(names.contains(&"Berean Standard Bible (BSB)".to_string()));
        assert!(names.contains(&"Literal Standard Version (LSV)".to_string()));
        assert!(names.contains(&"Free Bible Version (FBV)".to_string()));
        // KJV stays the default when no translation is asked for.
        assert_eq!(engine().tr_index(None), 0);
        assert_eq!(engine().lookup("John 3:16", None)[0].translation, "King James Version");
    }

    #[test]
    fn modern_translations_spot_check() {
        let e = engine();
        let cases: [(&str, [&str; 4]); 3] = [
            ("bsb", ["For God so loved the world", "The LORD is my shepherd", "God works all things together for the good", "In the beginning God created the heavens and the earth"]),
            ("lsv", ["for God so loved the world", "YHWH [is] my shepherd", "all things work together for good", "In [the] beginning God created the heavens and the earth"]),
            ("fbv", ["For God loved the world", "the Lord is my shepherd", "God works for the good", "In the beginning God created the heavens and the earth"]),
        ];
        for (id, want) in cases {
            let tr = e.tr_index(Some(id));
            assert_ne!(tr, 0, "{id} not loaded");
            let refs = [tr_ref(42, 3, 16), tr_ref(18, 23, 1), tr_ref(44, 8, 28), tr_ref(0, 1, 1)];
            for (r, w) in refs.iter().zip(want) {
                let text = e.get_verse(tr, r);
                assert!(text.contains(w), "{id} {:?}: {text}", (r.book, r.chapter, r.verse));
                assert!(!text.contains('\\') && !text.contains('|') && !text.contains("strong="), "{id}: markup left in {text}");
                assert_eq!(text, text.split_whitespace().collect::<Vec<_>>().join(" "));
            }
            // Psalm superscriptions are kept out of verse 1.
            let ps3 = e.get_verse(tr, &tr_ref(18, 3, 1));
            assert!(!ps3.to_lowercase().contains("absalom"), "{id}: {ps3}");
        }
    }

    #[test]
    fn modern_translations_versification_matches_kjv() {
        let e = engine();
        let trs = e.translations.read().unwrap();
        let kjv = &trs[0];
        for id in ["bsb", "lsv", "fbv"] {
            let t = trs.iter().find(|t| t.id == id).unwrap();
            assert_eq!(t.books.len(), 66);
            let mut total = 0usize;
            let mut empty = 0usize;
            for (b, (kb, tb)) in kjv.books.iter().zip(&t.books).enumerate() {
                assert_eq!(kb.name, tb.name, "{id} book {b}");
                assert_eq!(kb.chapters.len(), tb.chapters.len(), "{id} {} chapters", tb.name);
                let kv: usize = kb.chapters.iter().map(|c| c.len()).sum();
                let tv: usize = tb.chapters.iter().map(|c| c.len()).sum();
                // Versification differs in a handful of places (3 John 14-15, Revelation 12:18).
                assert!(kv.abs_diff(tv) <= 2, "{id} {}: {tv} verses vs KJV {kv}", tb.name);
                total += tv;
                empty += tb.chapters.iter().flatten().filter(|v| v.is_empty()).count();
            }
            assert!(total.abs_diff(31102) <= 5, "{id}: {total} verses");
            // Only verses the translation leaves out (e.g. Matthew 17:21) may be empty.
            assert!(empty <= 20, "{id}: {empty} empty verses");
        }
    }

    #[test]
    fn modern_translations_lookup_by_id() {
        let e = engine();
        for (id, name) in [
            ("bsb", "Berean Standard Bible (BSB)"),
            ("lsv", "Literal Standard Version (LSV)"),
            ("fbv", "Free Bible Version (FBV)"),
        ] {
            let hits = e.lookup("Romans 8:28", Some(id));
            assert_eq!(hits.len(), 1, "{id}");
            assert_eq!(hits[0].label, "Romans 8:28");
            assert_eq!(hits[0].translation, name);
            assert!(hits[0].text.len() > 40);
            // Verses after a gap keep their own numbers: Matthew 17:22 is still 17:22.
            let m = e.lookup("Matthew 17:22", Some(id));
            assert!(m[0].text.contains("Galilee"), "{id}: {}", m[0].text);
        }
    }

    #[test]
    fn number_words() {
        assert_eq!(word_to_number("sixteenth"), Some(16));
        assert_eq!(parse_num_seq(&["twenty", "third"], 0), Some((23, 2)));
        assert_eq!(
            parse_num_seq(&["one", "hundred", "nineteen"], 0),
            Some((119, 3))
        );
    }

    #[test]
    fn corrects_misheard_book() {
        let hits = engine().lookup("micha chapter 3 verse 5", None);
        assert_eq!(hits[0].label, "Micah 3:5");
    }

    #[test]
    fn corrects_deuteronomy() {
        let hits = engine().lookup("duetronomy chapter 1 verse 1", None);
        assert_eq!(hits[0].label, "Deuteronomy 1:1");
    }

    #[test]
    fn damerau_basics() {
        assert_eq!(damerau("micha", "micah"), 1);
        assert_eq!(damerau("deuteronomy", "deuteronomy"), 0);
    }

    #[test]
    fn parses_zefania_xml() {
        let xml = r#"<?xml version="1.0"?><XMLBIBLE biblename="Test Version"><BIBLEBOOK bnumber="43" bname="John"><CHAPTER cnumber="3"><VERS vnumber="16">For God so loved the world.</VERS><VERS vnumber="17">For God sent not his Son.</VERS></CHAPTER></BIBLEBOOK></XMLBIBLE>"#;
        let t = Engine::parse_translation_xml(xml, "Imported").unwrap();
        assert_eq!(t.name, "Test Version");
        assert_eq!(t.books[42].name, "John");
        assert_eq!(t.books[42].chapters[2].len(), 2);
    }

    #[test]
    fn parses_opensong_xml() {
        let xml = r#"<bible translation="OSV"><b n="John" c="3"><v n="1">There was a man of the Pharisees.</v><v n="2">The same came to Jesus by night.</v></b></bible>"#;
        let t = Engine::parse_translation_xml(xml, "Imported").unwrap();
        assert_eq!(t.books[42].name, "John");
        assert_eq!(t.books[42].chapters[2][0], "There was a man of the Pharisees.");
    }

    #[test]
    fn parses_osis_xml() {
        let xml = r#"<osis><osisText><div type="book" osisID="John"><chapter osisID="John.3"><verse osisID="John.3.16">For God so loved the world.</verse><verse osisID="John.3.17">For God sent not his Son.</verse></chapter></div></osisText></osis>"#;
        let t = Engine::parse_translation_xml(xml, "Imported").unwrap();
        assert_eq!(t.books[42].chapters[2].len(), 17);
        assert!(t.books[42].chapters[2][15].starts_with("For God so loved"));
    }
}
