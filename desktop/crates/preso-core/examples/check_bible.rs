// Check that a Bible file imports: prints its name, id, book count and a few
// verses.   cargo run -p preso-core --example check_bible -- path/to/bible.json
use preso_core::Engine;

fn main() {
    let path = std::env::args().nth(1).expect("path");
    let content = std::fs::read_to_string(&path).expect("read");
    let stem = std::path::Path::new(&path).file_stem().unwrap().to_string_lossy().to_string();
    let t = Engine::parse_translation_any(&content, &stem).expect("not a Bible file this app can read");
    let filled = t.books.iter().filter(|b| !b.chapters.is_empty()).count();
    println!("{} (id {}) · {} books", t.name, t.id, filled);
    for (b, c, v) in [(0usize, 1usize, 1usize), (18, 23, 1), (42, 3, 16), (44, 8, 28), (65, 22, 21)] {
        let text = t.books[b].chapters.get(c - 1).and_then(|ch| ch.get(v - 1)).cloned().unwrap_or_default();
        println!("  {} {}:{}  {}", t.books[b].name, c, v, text);
    }
}
