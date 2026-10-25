//! Recited verses: the verse a preacher is quoting, found by its words.
//!
//! The console's first quote matcher compared the meaning of each line with
//! every verse (sentence embeddings). On 21 recorded sermons it put up 1,026
//! verses, 802 of them wrong: "When Jesus comes into your life" became
//! Romans 2:16. Words are stricter. Every pair of neighbouring words in the
//! KJV, BSB and WEB is indexed, weighted by how rare the pair is in the
//! Bible; a verse matches when at least half of its weighted pairs were just
//! spoken, with enough of them that a few shared words ("praise the Lord")
//! cannot do it alone. On the same sermons: 384 verses, 28 wrong, and
//! more of the marked recitations caught (69 against 61). Paraphrase that
//! keeps few of the verse's words is still missed.

use std::collections::HashMap;
use std::sync::OnceLock;

use super::{engine, VerseHit};

/// Translations whose wording is indexed: the KJV most preachers recite, and
/// two modern ones close to NIV and NKJV phrasing (both public domain).
const INDEXED: [&str; 3] = ["kjv", "bsb", "web"];
/// Share of the verse's weighted word pairs that must have been spoken.
const MIN_SHARE: f32 = 0.5;
/// And their total weight: two or three rare pairs are not a recitation.
const MIN_WEIGHT: f32 = 25.0;
/// A third of a long verse is enough when its wording is rare: "treasures of
/// darkness and hidden riches of secret places" (Isaiah 45:3, 2026-10-25).
/// On the fixtures: 17 more recitations caught, 9 more verses not in the keys.
const PART_SHARE: f32 = 0.3;
const PART_WEIGHT: f32 = 60.0;
/// Pairs in more verses than this ("of the", "and he") only find candidates
/// through rarer pairs; they still count toward a candidate's share.
const COMMON_PAIR: usize = 1500;
/// Candidates scored in full, by their weight of rare pairs.
const CANDIDATES: usize = 8;

struct Entry {
    book: usize,
    chapter: usize,
    verse: usize,
    /// Distinct word pairs.
    pairs: Vec<u64>,
    /// Weight of all the verse's pairs, repeats included.
    total: f32,
}

pub struct Recitations {
    entries: Vec<Entry>,
    /// Pair -> entries containing it.
    index: HashMap<u64, Vec<u32>>,
    weight: HashMap<u64, f32>,
}

/// Where a recited verse was found.
pub struct Recital {
    pub hit: VerseHit,
    /// Share of the verse's weighted word pairs that were spoken.
    pub share: f32,
    pub weight: f32,
}

static RECITATIONS: OnceLock<Recitations> = OnceLock::new();

/// Build the index now (it takes about a second), so the first recitation
/// is not delayed. Safe to call from any thread, more than once.
pub fn warm() {
    recitations();
}

fn recitations() -> &'static Recitations {
    RECITATIONS.get_or_init(Recitations::build)
}

/// The verse the end of `text` recites, in translation `tr_id`, if any.
/// Pass the last 30 seconds or so of finished transcript.
pub fn recited(text: &str, tr_id: Option<&str>) -> Option<Recital> {
    let r = recitations();
    let (i, share, weight) = r.best(text)?;
    let whole = share >= MIN_SHARE && weight >= MIN_WEIGHT;
    let part = share >= PART_SHARE && weight >= PART_WEIGHT;
    if !whole && !part {
        return None;
    }
    let e = &r.entries[i];
    let hit = engine().verse_at(tr_id, e.book, e.chapter, e.verse)?;
    Some(Recital { hit, share, weight })
}

/// Old forms said either way: "thee" and "you" count as the same word.
fn modern(w: &str) -> &str {
    match w {
        "thee" | "thou" | "ye" => "you",
        "thy" | "thine" => "your",
        "hath" => "has",
        "doth" => "does",
        "art" => "are",
        "shalt" => "shall",
        "wilt" => "will",
        "hast" => "have",
        "unto" => "to",
        "saith" => "say",
        "spake" => "spoke",
        "shew" => "show",
        "didst" => "did",
        "canst" => "can",
        "couldest" => "could",
        "wouldest" => "would",
        "shouldest" => "should",
        "mayest" => "may",
        "hadst" => "had",
        "wast" => "was",
        "cometh" => "come",
        "goeth" => "go",
        "giveth" => "give",
        _ => w,
    }
}

/// "speaketh", "speaks" and "speaking" all become "speak".
fn stem(w: &str) -> String {
    let w = modern(w);
    for suf in ["eth", "est", "ing", "ed", "es", "s"] {
        if w.len() > suf.len() + 2 && w.ends_with(suf) {
            return w[..w.len() - suf.len()].to_string();
        }
    }
    w.to_string()
}

fn words(text: &str) -> Vec<String> {
    let lower = text.to_lowercase().replace(['\'', '’'], "");
    lower
        .split(|c: char| !c.is_ascii_lowercase())
        .filter(|w| !w.is_empty())
        .map(stem)
        .collect()
}

fn pair_key(a: &str, b: &str) -> u64 {
    // FNV-1a over "a b".
    let mut h: u64 = 0xcbf29ce484222325;
    for byte in a.bytes().chain(std::iter::once(b' ')).chain(b.bytes()) {
        h ^= byte as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn pairs(w: &[String]) -> Vec<u64> {
    w.windows(2).map(|p| pair_key(&p[0], &p[1])).collect()
}

impl Recitations {
    fn build() -> Recitations {
        let eng = engine();
        let trs = eng.translations.read().unwrap();
        let mut entries = Vec::new();
        let mut index: HashMap<u64, Vec<u32>> = HashMap::new();
        let mut all_pairs: Vec<Vec<u64>> = Vec::new();
        for id in INDEXED {
            let Some(tr) = trs.iter().find(|t| t.id == id) else { continue };
            for (b, book) in tr.books.iter().enumerate() {
                for (c, chapter) in book.chapters.iter().enumerate() {
                    for (v, text) in chapter.iter().enumerate() {
                        if text.is_empty() {
                            continue;
                        }
                        let p = pairs(&words(text));
                        let mut distinct = p.clone();
                        distinct.sort_unstable();
                        distinct.dedup();
                        let n = entries.len() as u32;
                        for &k in &distinct {
                            index.entry(k).or_default().push(n);
                        }
                        entries.push(Entry { book: b, chapter: c + 1, verse: v + 1, pairs: distinct, total: 0.0 });
                        all_pairs.push(p);
                    }
                }
            }
        }
        let n = entries.len() as f32;
        let weight: HashMap<u64, f32> = index.iter().map(|(&k, v)| (k, (n / (1.0 + v.len() as f32)).ln())).collect();
        for (e, p) in entries.iter_mut().zip(&all_pairs) {
            e.total = p.iter().map(|k| weight.get(k).copied().unwrap_or(0.0)).sum();
        }
        Recitations { entries, index, weight }
    }

    /// Best entry for `text`: (entry, share, weight).
    fn best(&self, text: &str) -> Option<(usize, f32, f32)> {
        let mut spoken = pairs(&words(text));
        spoken.sort_unstable();
        spoken.dedup();
        let mut cand: HashMap<u32, f32> = HashMap::new();
        for k in &spoken {
            if let Some(list) = self.index.get(k) {
                if list.len() < COMMON_PAIR {
                    let w = self.weight[k];
                    for &e in list {
                        *cand.entry(e).or_default() += w;
                    }
                }
            }
        }
        let mut ranked: Vec<(u32, f32)> = cand.into_iter().collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
        ranked
            .into_iter()
            .take(CANDIDATES)
            .filter_map(|(i, _)| {
                let e = &self.entries[i as usize];
                if e.total <= 0.0 {
                    return None;
                }
                let got: f32 = e.pairs.iter().filter(|k| spoken.binary_search(k).is_ok()).map(|k| self.weight[k]).sum();
                Some((i as usize, got / e.total, got))
            })
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn label(text: &str) -> Option<String> {
        recited(text, None).map(|r| r.hit.label)
    }

    #[test]
    fn kjv_recitation_from_the_2026_10_25_service() {
        assert_eq!(
            label("pray in tongues the bible say that he that speaketh in unknown tongue, speaketh not unto men but unto God. For no man understandeth him."),
            Some("1 Corinthians 14:2".into())
        );
    }

    #[test]
    fn modern_wording_and_misheard_words() {
        assert_eq!(
            label("That says the Lord your redeemer. The holy one of Israel. I am the Lord your God who teaches you to profit. Who leads you by the way you should go."),
            Some("Isaiah 48:17".into())
        );
    }

    #[test]
    fn rare_part_of_a_long_verse() {
        assert_eq!(
            label("Reveal treasures, treasures that are hidden in darkness. In the name of Jesus. Hidden riches of secret places. Treasures of darkness and hidden riches of secret places."),
            Some("Isaiah 45:3".into())
        );
    }

    #[test]
    fn ordinary_preaching_is_not_a_verse() {
        assert_eq!(label("When Jesus comes into your life, everything changes. Amen."), None);
        assert_eq!(label("Praise the Lord. Hallelujah. Praise the Lord, praise Jesus. Amen."), None);
    }
}
