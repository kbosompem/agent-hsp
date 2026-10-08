// The church's own backgrounds: pictures and videos the operator adds. Files
// are copied into <app data>/backgrounds/ as "user-<id>.<ext>" (next to the
// downloaded stock ones, so the asset protocol and service bundles treat them
// the same) and listed in backgrounds/user.json.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone)]
pub struct UserBackground {
    pub id: String,
    /// "image" or "video".
    pub kind: String,
    /// Original file name, without the extension.
    pub title: String,
    /// File name inside backgrounds/.
    pub file: String,
    /// Absolute path, for the asset protocol (filled in when listed).
    #[serde(default, skip_deserializing)]
    pub path: String,
}

const IMAGE: &[&str] = &["jpg", "jpeg", "png", "webp", "gif"];
const VIDEO: &[&str] = &["mp4", "m4v", "mov", "webm"];
const MAX_BYTES: u64 = 1024 * 1024 * 1024;

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?.join("backgrounds");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn load(d: &Path) -> Vec<UserBackground> {
    std::fs::read_to_string(d.join("user.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(d: &Path, list: &[UserBackground]) -> Result<(), String> {
    let tmp = d.join("user.json.part");
    std::fs::write(&tmp, serde_json::to_string_pretty(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, d.join("user.json")).map_err(|e| e.to_string())
}

fn with_paths(d: &Path, list: Vec<UserBackground>) -> Vec<UserBackground> {
    list.into_iter()
        .filter(|b| d.join(&b.file).exists())
        .map(|mut b| {
            b.path = d.join(&b.file).to_string_lossy().to_string();
            b
        })
        .collect()
}

#[tauri::command]
pub fn list_user_backgrounds(app: AppHandle) -> Result<Vec<UserBackground>, String> {
    let d = dir(&app)?;
    Ok(with_paths(&d, load(&d)))
}

/// Copy the chosen files in. Unsupported or oversized files are skipped.
#[tauri::command]
pub fn import_user_backgrounds(app: AppHandle, paths: Vec<String>) -> Result<Vec<UserBackground>, String> {
    let d = dir(&app)?;
    let mut list = load(&d);
    for p in paths {
        let src = PathBuf::from(&p);
        let ext = src.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let kind = if IMAGE.contains(&ext.as_str()) {
            "image"
        } else if VIDEO.contains(&ext.as_str()) {
            "video"
        } else {
            continue;
        };
        if std::fs::metadata(&src).map(|m| !m.is_file() || m.len() > MAX_BYTES).unwrap_or(true) {
            continue;
        }
        let id = format!(
            "{:x}{:04x}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0),
            list.len()
        );
        let file = format!("user-{}.{}", id, ext);
        let tmp = d.join(format!("{}.part", file));
        std::fs::copy(&src, &tmp).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, d.join(&file)).map_err(|e| e.to_string())?;
        let title = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| file.clone());
        list.push(UserBackground { id, kind: kind.into(), title, file, path: String::new() });
    }
    save(&d, &list)?;
    Ok(with_paths(&d, list))
}

#[tauri::command]
pub fn delete_user_background(app: AppHandle, id: String) -> Result<Vec<UserBackground>, String> {
    let d = dir(&app)?;
    let mut list = load(&d);
    if let Some(b) = list.iter().find(|b| b.id == id) {
        // Only our own "user-…" files.
        if b.file.starts_with("user-") && !b.file.contains('/') && !b.file.contains('\\') {
            let _ = std::fs::remove_file(d.join(&b.file));
        }
    }
    list.retain(|b| b.id != id);
    save(&d, &list)?;
    Ok(with_paths(&d, list))
}
