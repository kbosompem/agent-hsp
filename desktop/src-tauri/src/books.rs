//! The preacher's books (preso-core books.rs), kept in the app data folder
//! as one JSON file per book. Imported by the user, never bundled.
use preso_core::books;
use tauri::Manager;

fn books_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("books");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Load the imported books at startup (off the main thread).
pub fn load(app: &tauri::AppHandle) {
    if let Ok(dir) = books_dir(app) {
        std::thread::spawn(move || books::load_dir(&dir));
    }
}

/// Import the books at `path`: an EPUB, a PDF, a zip of them (dagbooks.org's
/// "Download All Books") or a folder.
#[tauri::command]
pub async fn import_books(app: tauri::AppHandle, path: String) -> Result<books::ImportReport, String> {
    let dir = books_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || books::import(std::path::Path::new(&path), &dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn list_books() -> Vec<books::BookInfo> {
    books::info()
}

/// Remove one book, or every book when `id` is null.
#[tauri::command]
pub async fn remove_books(app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    let dir = books_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || books::remove(&dir, id.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// The book passage the end of `text` quotes, if any.
#[tauri::command]
pub async fn book_quote(text: String) -> Option<books::BookQuote> {
    tauri::async_runtime::spawn_blocking(move || books::quoted(&text)).await.ok().flatten()
}

/// The chapters closest to the sermon so far, for the AI summary.
#[tauri::command]
pub async fn book_chapters(text: String, refs: Vec<String>) -> Vec<books::Outline> {
    tauri::async_runtime::spawn_blocking(move || books::related(&text, &refs, 2)).await.unwrap_or_default()
}
