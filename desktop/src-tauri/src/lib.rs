mod audio;

use audio::ListenState;
use preso_core::{engine, Engine, VerseHit};
use serde::Serialize;
use tauri::{Emitter, Manager};

#[tauri::command]
fn lookup(input: String, translation: Option<String>) -> Vec<VerseHit> {
    engine().lookup(&input, translation.as_deref())
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

#[tauri::command]
fn list_translations() -> Vec<TranslationInfo> {
    engine()
        .list_translations()
        .into_iter()
        .map(|(id, name)| TranslationInfo { id, name })
        .collect()
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
        .ok_or("Could not read this file. Supported: our JSON, Zefania XML, OpenSong XML, OSIS XML.")?;
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
    slide
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ListenState::new())
        .setup(|app| {
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
            verse_at,
            verse_range,
            list_translations,
            import_translation,
            open_url,
            show_verse,
            show_slide,
            audio::list_audio_inputs,
            audio::ensure_model,
            audio::start_listening,
            audio::stop_listening
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
