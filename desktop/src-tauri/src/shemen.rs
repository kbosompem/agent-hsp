// Church music sources beside YouTube:
//
//   ShemenMusic  shemenmusic.com, a WordPress site whose "station" posts each
//                carry a backing track (meta.stream) and the lyrics (content).
//                The public REST API lists them; we keep a copy in
//                <app data>/media/shemen.json so the tab opens instantly.
//   Songbook     a JSON file of songs with lyrics and a link to each backing
//                track (made from the church's PDF songbook), kept in
//                <app data>/media/songbook.json.
//
// fetch_audio downloads one track from a web address (MediaFire pages are
// followed to their file) into a media folder, one download at a time.

use crate::media::{add, folder_ok, load, media_dir, new_id, now, MediaItem, FOLDERS, INDEX_LOCK};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

const SHEMEN_API: &str = "https://shemenmusic.com/three/wp-json/wp/v2/station";
// The site's firewall refuses requests that do not look like a browser.
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

/// One track download at a time, so "Get all" does not open sixty connections.
static DOWNLOAD_LOCK: Mutex<()> = Mutex::new(());

fn get(url: &str) -> Result<ureq::Response, String> {
    ureq::get(url)
        .set("User-Agent", UA)
        .set("Accept", "application/json, text/html;q=0.9, */*;q=0.8")
        .timeout(std::time::Duration::from_secs(60))
        .call()
        .map_err(|e| e.to_string())
}

/// ShemenMusic's tracks: [{id, title, url, duration_s, lyrics_html, link}].
/// Uses the saved copy unless `refresh` is set or there is none yet.
#[tauri::command]
pub async fn shemen_catalog(app: AppHandle, refresh: bool) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cache = media_dir(&app)?.join("shemen.json");
        if !refresh {
            if let Some(v) = std::fs::read_to_string(&cache).ok().and_then(|s| serde_json::from_str(&s).ok()) {
                return Ok(v);
            }
        }
        let v = fetch_catalog()?;
        let tmp = cache.with_extension("part");
        std::fs::write(&tmp, v.to_string()).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &cache).map_err(|e| e.to_string())?;
        Ok(v)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Every ShemenMusic track that has a sound file, from the public API.
fn fetch_catalog() -> Result<serde_json::Value, String> {
    let mut out = Vec::new();
    let mut page = 1;
    loop {
        let url = format!("{}?per_page=100&page={}&_fields=id,title,link,content,meta.stream,meta.duration", SHEMEN_API, page);
        let resp = get(&url).map_err(|e| format!("Could not reach ShemenMusic: {}", e))?;
        let pages: u32 = resp.header("X-WP-TotalPages").and_then(|s| s.parse().ok()).unwrap_or(1);
        let v: serde_json::Value = serde_json::from_reader(resp.into_reader()).map_err(|e| e.to_string())?;
        for p in v.as_array().cloned().unwrap_or_default() {
            let stream = p["meta"]["stream"].as_str().unwrap_or("");
            if stream.is_empty() {
                continue;
            }
            out.push(serde_json::json!({
                "id": p["id"],
                "title": p["title"]["rendered"],
                "url": stream,
                "duration_s": p["meta"]["duration"].as_f64().map(|ms| ms / 1000.0),
                "lyrics_html": p["content"]["rendered"],
                "link": p["link"],
            }));
        }
        if page >= pages || page >= 50 {
            break;
        }
        page += 1;
    }
    Ok(serde_json::Value::Array(out))
}

/// The saved songbook, or "" when none has been opened.
#[tauri::command]
pub fn load_songbook(app: AppHandle) -> Result<String, String> {
    let p = media_dir(&app)?.join("songbook.json");
    Ok(std::fs::read_to_string(p).unwrap_or_default())
}

/// Read a songbook file, check it, and keep a copy. Returns its text.
#[tauri::command]
pub fn import_songbook(app: AppHandle, path: String) -> Result<String, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|_| "This is not a songbook file.".to_string())?;
    if v["format"] != "agenthsp-songbook" || !v["songs"].is_array() {
        return Err("This is not a songbook file.".into());
    }
    let p = media_dir(&app)?.join("songbook.json");
    std::fs::write(&p, &text).map_err(|e| e.to_string())?;
    Ok(text)
}

/// A MediaFire share page links to the file itself; other addresses are used as they are.
fn direct_url(url: &str) -> Result<String, String> {
    if !url.contains("mediafire.com/file/") {
        return Ok(url.to_string());
    }
    // Over plain http MediaFire serves a page without the file link.
    let page = get(&url.replacen("http://", "https://", 1))?.into_string().map_err(|e| e.to_string())?;
    let at = page.find("href=\"https://download").ok_or("MediaFire did not offer the file (it may have been removed).")?;
    let rest = &page[at + 6..];
    let end = rest.find('"').ok_or("MediaFire page not understood")?;
    Ok(rest[..end].replace("&amp;", "&"))
}

/// Download a track (following a MediaFire page to its file) into `dir` as
/// <id>.<ext>. Returns the file name.
fn download(url: &str, dir: &std::path::Path, id: &str, mut progress: impl FnMut(i64)) -> Result<String, String> {
    let file_url = direct_url(url)?;
    let resp = get(&file_url)?;
    let total: f64 = resp.header("Content-Length").and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let ctype = resp.content_type().to_string();
    let path_ext = file_url.split(['?', '#']).next().unwrap_or("").rsplit('.').next().unwrap_or("").to_lowercase();
    let ext = if ["mp3", "m4a", "aac", "wav", "ogg", "opus", "flac"].contains(&path_ext.as_str()) {
        path_ext
    } else if ctype.contains("mp4") || ctype.contains("m4a") {
        "m4a".to_string()
    } else if ctype.starts_with("text/") {
        return Err("the link gave a web page, not a sound file".into());
    } else {
        "mp3".to_string()
    };
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file = format!("{}.{}", id, ext);
    let tmp = dir.join(format!("{}.part", id));
    let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 64 * 1024];
    let (mut got, mut last) = (0f64, -1i64);
    loop {
        let n = match std::io::Read::read(&mut reader, &mut buf) {
            Ok(n) => n,
            Err(e) => {
                drop(f);
                let _ = std::fs::remove_file(&tmp);
                return Err(e.to_string());
            }
        };
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut f, &buf[..n]).map_err(|e| e.to_string())?;
        got += n as f64;
        if total > 0.0 {
            let pct = (got / total * 100.0) as i64;
            if pct != last {
                last = pct;
                progress(pct);
            }
        }
    }
    drop(f);
    if got < 10_000.0 {
        let _ = std::fs::remove_file(&tmp);
        return Err("the download was empty".into());
    }
    std::fs::rename(&tmp, dir.join(&file)).map_err(|e| e.to_string())?;
    Ok(file)
}

/// Download a track into a folder. Reports "media-progress" {id: key, percent}
/// and "media-done" {id: key, ok, error}. Already downloaded (same address): done at once.
#[tauri::command]
pub fn fetch_audio(app: AppHandle, key: String, url: String, folder: String, title: String) -> Result<(), String> {
    folder_ok(&folder)?;
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("not a web address".into());
    }
    let kind = FOLDERS.iter().find(|f| f.0 == folder).map(|f| f.2).unwrap_or("audio");
    std::thread::spawn(move || {
        let run = || -> Result<(), String> {
            let _slot = DOWNLOAD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let d = media_dir(&app)?;
            {
                let _g = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
                if load(&d).iter().any(|m| m.source_url.as_deref() == Some(url.as_str()) && d.join(&m.folder).join(&m.file).exists()) {
                    return Ok(());
                }
            }
            let dir = d.join(&folder);
            let id = new_id();
            let file = download(&url, &dir, &id, |pct| {
                let _ = app.emit("media-progress", serde_json::json!({ "id": key, "percent": pct }));
            })?;
            add(
                &d,
                MediaItem {
                    id,
                    folder: folder.clone(),
                    kind: kind.into(),
                    title: title.trim().chars().take(200).collect(),
                    file,
                    duration_s: None,
                    youtube_id: None,
                    channel: None,
                    source_url: Some(url.clone()),
                    added: now(),
                    path: String::new(),
                },
            )?;
            Ok(())
        };
        let r = run();
        let _ = app.emit("media-done", serde_json::json!({ "id": key, "ok": r.is_ok(), "error": r.err() }));
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Network tests against the real sites: cargo test shemen -- --ignored
    #[test]
    #[ignore]
    fn shemen_catalog_has_tracks_and_lyrics() {
        let v = fetch_catalog().unwrap();
        let a = v.as_array().unwrap();
        assert!(a.len() > 400, "only {} tracks", a.len());
        let with_lyrics = a.iter().filter(|t| t["lyrics_html"].as_str().map_or(false, |s| s.len() > 100)).count();
        assert!(with_lyrics > 300, "only {} with lyrics", with_lyrics);
        println!("{} tracks, {} with lyrics", a.len(), with_lyrics);
    }

    #[test]
    #[ignore]
    fn downloads_mediafire_and_direct_tracks() {
        let dir = std::env::temp_dir().join(format!("hsp-shemen-test-{}", new_id()));
        for (url, ext) in [
            ("http://www.mediafire.com/file/qvvoo5ivx2yodat/Arise.mp3/file", "mp3"),
            ("https://www.mediafire.com/file/1noo04q7xs5z6xl/BlessedBeTheName.m4a/file", "m4a"),
        ] {
            let mut last = 0;
            let f = download(url, &dir, &new_id(), |p| last = p).unwrap();
            assert!(f.ends_with(ext), "{}", f);
            assert_eq!(last, 100);
            let len = std::fs::metadata(dir.join(&f)).unwrap().len();
            println!("{} -> {} ({} bytes)", url, f, len);
            assert!(len > 500_000);
        }
        let first = fetch_catalog().unwrap()[0]["url"].as_str().unwrap().to_string();
        let f = download(&first, &dir, "direct", |_| {}).unwrap();
        println!("{} -> {}", first, f);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
