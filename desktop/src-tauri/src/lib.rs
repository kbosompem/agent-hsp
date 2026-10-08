use std::io::Read;
pub mod audio;
pub mod segmenter;
pub mod session;
pub mod deepgram;
pub mod bundle;
pub mod backgrounds;
pub mod media;
#[cfg(feature = "nemotron")]
pub mod nemotron;

use audio::ListenState;
use preso_core::{engine, Engine, LiveLookup, VerseHit};
use std::sync::Mutex;
use serde::Serialize;
use tauri::{Emitter, Manager};

#[tauri::command]
fn lookup(input: String, translation: Option<String>) -> Vec<VerseHit> {
    engine().lookup(&input, translation.as_deref())
}

/// Live-transcript lookup that follows the open passage ("verse 6 says...").
/// Final transcripts commit; partials only read the context.
#[tauri::command]
fn lookup_live(
    state: tauri::State<'_, Mutex<LiveLookup>>,
    input: String,
    translation: Option<String>,
    commit: bool,
) -> Vec<VerseHit> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    state.lock().unwrap().lookup(&input, translation.as_deref(), now, commit)
}

/// The console put a verse on screen without speech (search box, service
/// reading, history, voice command): make its chapter the open passage so
/// "verse 95" and "chapter 4 verse 5" follow it.
#[tauri::command]
fn set_live_context(state: tauri::State<'_, Mutex<LiveLookup>>, book: usize, chapter: usize) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    state.lock().unwrap().set_context(book, chapter, now);
}

#[tauri::command]
fn reset_live(state: tauri::State<'_, Mutex<LiveLookup>>) {
    state.lock().unwrap().reset();
}

#[tauri::command]
fn verse_at(
    book: usize,
    chapter: usize,
    verse: usize,
    translation: Option<String>,
) -> Option<VerseHit> {
    engine().verse_at(translation.as_deref(), book, chapter, verse)
}

#[tauri::command]
fn verse_range(
    book: usize,
    chapter: usize,
    from: usize,
    to: usize,
    translation: Option<String>,
) -> Vec<VerseHit> {
    engine().verse_range(translation.as_deref(), book, chapter, from, to)
}

#[derive(Serialize, Clone)]
struct TranslationInfo {
    id: String,
    name: String,
}

#[derive(Serialize)]
struct BookShape {
    name: String,
    /// Verses in each chapter.
    chapters: Vec<usize>,
}

/// Books with their chapter and verse counts, for the scripture pickers.
#[tauri::command]
fn bible_structure(translation: Option<String>) -> Vec<BookShape> {
    engine()
        .structure(translation.as_deref())
        .into_iter()
        .map(|(name, chapters)| BookShape { name, chapters })
        .collect()
}

/// Every translation with its short name, edition and copyright notice.
#[tauri::command]
fn list_translations() -> Vec<preso_core::TranslationMeta> {
    engine().translation_meta()
}

fn translations_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("translations");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Ids of imported translations are plain names ("nlt"); anything else is
/// refused before it becomes a file name.
fn safe_tr_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 40 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("bad translation id".into());
    }
    Ok(())
}

/// Edit an imported translation's details and save them with it.
#[tauri::command]
fn update_translation_info(
    app: tauri::AppHandle,
    id: String,
    name: String,
    abbrev: String,
    edition: String,
    copyright: String,
) -> Result<(), String> {
    safe_tr_id(&id)?;
    let json = engine()
        .set_translation_meta(&id, &name, &abbrev, &edition, &copyright)
        .ok_or("The bundled translations cannot be edited.")?;
    let path = translations_dir(&app)?.join(format!("{}.json", id));
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Remove an imported translation from the app and from disk.
#[tauri::command]
fn remove_translation(app: tauri::AppHandle, id: String) -> Result<(), String> {
    safe_tr_id(&id)?;
    if !engine().remove_translation(&id) {
        return Err("The bundled translations cannot be removed.".into());
    }
    let _ = std::fs::remove_file(translations_dir(&app)?.join(format!("{}.json", id)));
    Ok(())
}

#[tauri::command]
fn import_translation(
    app: tauri::AppHandle,
    content: String,
    filename: Option<String>,
) -> Result<TranslationInfo, String> {
    let stem = filename
        .as_deref()
        .map(|f| {
            std::path::Path::new(f)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "imported".to_string())
        })
        .unwrap_or_else(|| "imported".to_string());
    let t = Engine::parse_translation_any(&content, &stem)
        .ok_or("Could not read this Bible file. Supported: Zefania, OpenSong or OSIS XML, and JSON laid out by book, chapter and verse (for example {\"Genesis\": {\"1\": {\"1\": \"...\"}}}).")?;
    let json = serde_json::to_string(&t).map_err(|e| e.to_string())?;
    let (id, name) = engine().add_translation_json(&json)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("translations");
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join(format!("{}.json", id)), &json);
    Ok(TranslationInfo { id, name })
}

/// Songs and service agendas, kept as one JSON document in the app data
/// folder. The console owns the shape; Rust only stores it.
fn library_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("library.json"))
}

#[tauri::command]
fn load_library(app: tauri::AppHandle) -> Result<String, String> {
    let p = library_path(&app)?;
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Write to a temporary file and rename, so a crash mid-save never leaves a
/// half-written library. The previous version is kept as library.bak.json.
#[tauri::command]
fn save_library(app: tauri::AppHandle, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("not JSON: {}", e))?;
    let p = library_path(&app)?;
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, &json).map_err(|e| e.to_string())?;
    if p.exists() {
        let _ = std::fs::copy(&p, p.with_file_name("library.bak.json"));
    }
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// Download a stock background (from the curated list in
/// public/backgrounds/manifest.json) into the app data folder once, and return
/// its local path for the asset protocol. Only Pexels hosts are allowed.
#[tauri::command]
async fn fetch_background(app: tauri::AppHandle, id: String, url: String, video: bool) -> Result<String, String> {
    let host_ok = url.starts_with("https://images.pexels.com/") || url.starts_with("https://videos.pexels.com/");
    if !host_ok {
        return Err("not an allowed background source".into());
    }
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("bad background id".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("backgrounds");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.{}", id, if video { "mp4" } else { "jpg" }));
    if path.exists() {
        return Ok(path.to_string_lossy().to_string());
    }
    let tmp = path.with_extension("part");
    let p2 = path.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let resp = ureq::get(&url).call().map_err(|e| e.to_string())?;
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        std::io::copy(&mut resp.into_reader().take(60 * 1024 * 1024), &mut f).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &p2).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&url).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
    }
}

#[derive(Serialize, Clone, Debug)]
struct Slide {
    kind: String,
    title: String,
    body: String,
    sub: String,
}

#[tauri::command]
fn show_verse(app: tauri::AppHandle, hit: VerseHit) -> Slide {
    let slide = Slide {
        kind: "verse".to_string(),
        title: hit.label.clone(),
        body: hit.text.clone(),
        sub: hit.translation.clone(),
    };
    let _ = app.emit("slide", &slide);
    session::slide(&slide.kind, &slide.title, &slide.body, &slide.sub);
    slide
}

#[tauri::command]
fn show_slide(
    app: tauri::AppHandle,
    kind: String,
    title: String,
    body: String,
    sub: String,
) -> Slide {
    let slide = Slide {
        kind,
        title,
        body,
        sub,
    };
    let _ = app.emit("slide", &slide);
    session::slide(&slide.kind, &slide.title, &slide.body, &slide.sub);
    slide
}

/// The app was called "AMC Preso" (bundle id com.amcpreso.desktop) before
/// it became Agent HSP. Move its data (speech models, imported translations)
/// to the new location once, so nothing has to be downloaded again.
fn migrate_old_app_data(app: &tauri::AppHandle) {
    let Ok(new_dir) = app.path().app_data_dir() else { return };
    let Some(parent) = new_dir.parent() else { return };
    let old_dir = parent.join("com.amcpreso.desktop");
    if old_dir.is_dir() && !new_dir.exists() {
        let _ = std::fs::rename(&old_dir, &new_dir);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ListenState::new())
        .manage(Mutex::new(LiveLookup::new()))
        .setup(|app| {
            migrate_old_app_data(app.handle());
            let dir = app
                .path()
                .app_data_dir()
                .map(|p| p.join("translations"))
                .ok();
            preso_core::init_engine(dir.as_deref());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            lookup,
            lookup_live,
            reset_live,
            set_live_context,
            verse_at,
            verse_range,
            list_translations,
            bible_structure,
            update_translation_info,
            remove_translation,
            import_translation,
            open_url,
            show_verse,
            show_slide,
            load_library,
            save_library,
            fetch_background,
            bundle::export_service,
            bundle::import_service,
            bundle::media_path,
            backgrounds::list_user_backgrounds,
            media::media_folders,
            media::list_media,
            media::import_media,
            media::delete_media,
            media::rename_media,
            media::youtube_search,
            media::youtube_download,
            media::media_tools,
            backgrounds::import_user_backgrounds,
            backgrounds::delete_user_background,
            deepgram::set_deepgram_key,
            deepgram::has_deepgram_key,
            audio::list_audio_inputs,
            audio::ensure_model,
            audio::start_listening,
            audio::stop_listening,
            audio::last_session,
            audio::open_session_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
