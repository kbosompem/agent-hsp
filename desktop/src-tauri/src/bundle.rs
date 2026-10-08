// Exporting and importing a service (an agenda) in two forms:
//
// - .hspservice: the console's service JSON on its own. Songs are referred to
//   by id and backgrounds by their path in the app data folder
//   ("backgrounds/<file>"), so it only opens fully on the computer that made
//   it. For backups and copies.
// - .hspbundle: a zip of that JSON (with every song in full) plus the media
//   files under media/, for moving a service to another computer.
//
// The console builds the JSON; Rust only writes and reads files and copies
// media in and out of the app data folder.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const MANIFEST: &str = "service.json";

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// "backgrounds/<file>" with a plain file name, or None. Only media the app
/// itself manages can go in or out of a bundle.
fn safe_media(rel: &str) -> Option<(&'static str, String)> {
    let (dir, file) = rel.split_once('/')?;
    let dir = match dir {
        "backgrounds" => "backgrounds",
        _ => return None,
    };
    let ok = !file.is_empty()
        && file.len() <= 120
        && !file.starts_with('.')
        && file.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    ok.then(|| (dir, file.to_string()))
}

/// Absolute path of a media file in the app data folder, for the console to
/// show it (asset protocol). Errors if it is not a managed media path.
#[tauri::command]
pub fn media_path(app: AppHandle, rel: String) -> Result<String, String> {
    let (dir, file) = safe_media(&rel).ok_or("not a media path")?;
    let p = data_dir(&app)?.join(dir).join(file);
    if !p.exists() {
        return Err(format!("{} is not on this computer", rel));
    }
    Ok(p.to_string_lossy().to_string())
}

/// Write `manifest` (the service JSON) to `path`; for a bundle, zip it with
/// the listed media files.
#[tauri::command]
pub fn export_service(app: AppHandle, path: String, manifest: String, media: Vec<String>, bundle: bool) -> Result<(), String> {
    export_to(&data_dir(&app)?, &path, &manifest, &media, bundle)
}

fn export_to(root: &Path, path: &str, manifest: &str, media: &[String], bundle: bool) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(manifest).map_err(|e| format!("not JSON: {}", e))?;
    if !bundle {
        return std::fs::write(path, manifest).map_err(|e| e.to_string());
    }
    let tmp = PathBuf::from(format!("{}.part", path));
    {
        let f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut z = zip::ZipWriter::new(f);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        z.start_file(MANIFEST, opts).map_err(|e| e.to_string())?;
        z.write_all(manifest.as_bytes()).map_err(|e| e.to_string())?;
        // Video and photos are already compressed.
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for rel in media {
            let Some((dir, file)) = safe_media(rel) else { continue };
            let src = root.join(dir).join(&file);
            let Ok(bytes) = std::fs::read(&src) else { continue };
            z.start_file(format!("media/{}/{}", dir, file), stored).map_err(|e| e.to_string())?;
            z.write_all(&bytes).map_err(|e| e.to_string())?;
        }
        z.finish().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Read a .hspservice or .hspbundle. A bundle's media goes into the app data
/// folder (existing files are kept). Returns the service JSON.
#[tauri::command]
pub fn import_service(app: AppHandle, path: String) -> Result<String, String> {
    import_from(&data_dir(&app)?, &path)
}

fn import_from(root: &Path, path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if !bytes.starts_with(b"PK") {
        let s = String::from_utf8(bytes).map_err(|_| "This is not an Agent HSP service file.")?;
        serde_json::from_str::<serde_json::Value>(&s).map_err(|_| "This is not an Agent HSP service file.")?;
        return Ok(s);
    }
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let mut manifest = None;
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().to_string();
        if name == MANIFEST {
            let mut s = String::new();
            f.read_to_string(&mut s).map_err(|e| e.to_string())?;
            manifest = Some(s);
        } else if let Some(rel) = name.strip_prefix("media/") {
            let Some((dir, file)) = safe_media(rel) else { continue };
            let dest_dir = root.join(dir);
            std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
            let dest = dest_dir.join(&file);
            if dest.exists() {
                continue;
            }
            let mut out = Vec::new();
            // Cap one file at 200 MB.
            (&mut f).take(200 * 1024 * 1024).read_to_end(&mut out).map_err(|e| e.to_string())?;
            write_atomic(&dest, &out)?;
        }
    }
    manifest.ok_or_else(|| "This bundle has no service in it.".to_string())
}

fn write_atomic(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = dest.with_extension("part");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_round_trip_carries_media() {
        let base = std::env::temp_dir().join(format!("agenthsp-bundle-test-{}", std::process::id()));
        let (a, b) = (base.join("a"), base.join("b"));
        std::fs::create_dir_all(a.join("backgrounds")).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("backgrounds/pexels-video-1.mp4"), b"fake video").unwrap();
        let manifest = r#"{"format":"agent-hsp-service","agenda":{"items":[]}}"#;
        let out = base.join("Sunday.hspbundle");
        let media = vec!["backgrounds/pexels-video-1.mp4".to_string(), "../library.json".to_string()];
        export_to(&a, out.to_str().unwrap(), manifest, &media, true).unwrap();
        assert_eq!(import_from(&b, out.to_str().unwrap()).unwrap(), manifest);
        assert_eq!(std::fs::read(b.join("backgrounds/pexels-video-1.mp4")).unwrap(), b"fake video");
        // The plain file is just the JSON.
        let plain = base.join("Sunday.hspservice");
        export_to(&a, plain.to_str().unwrap(), manifest, &media, false).unwrap();
        assert_eq!(import_from(&b, plain.to_str().unwrap()).unwrap(), manifest);
        assert!(import_from(&b, a.join("backgrounds/pexels-video-1.mp4").to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn only_managed_media_paths() {
        assert_eq!(safe_media("backgrounds/pexels-video-123.mp4"), Some(("backgrounds", "pexels-video-123.mp4".into())));
        assert_eq!(safe_media("backgrounds/../library.json"), None);
        assert_eq!(safe_media("models/x.bin"), None);
        assert_eq!(safe_media("backgrounds/.hidden"), None);
        assert_eq!(safe_media("backgrounds/a/b.jpg"), None);
    }
}
