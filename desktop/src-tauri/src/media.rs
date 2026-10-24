// The media library: audio and video for services, in five folders, added
// from the computer, downloaded from YouTube with yt-dlp, or fetched from
// ShemenMusic and songbook links (shemen.rs).
//
//   <app data>/media/<folder>/<id>.<ext>
//   <app data>/media/index.json      [{id, folder, kind, title, file, ...}]
//   <app data>/tools/yt-dlp          downloaded on first use, self-updating
//
// yt-dlp is not bundled: YouTube changes often and a frozen copy stops
// working within weeks, so the app fetches the current release and runs
// `yt-dlp -U` now and then. ffmpeg (needed to join HD video and sound) is
// used when installed; without it, videos download as a single file.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub const FOLDERS: [(&str, &str, &str); 5] = [
    ("general-video", "General video", "video"),
    ("song-video", "Song video (no lyrics)", "video"),
    ("song-audio", "Song audio", "audio"),
    ("instrumental-audio", "Instrumental audio", "audio"),
    ("instrumental-lyrics", "Instrumental with lyrics", "video"),
];

const AUDIO: &[&str] = &["mp3", "m4a", "aac", "wav", "ogg", "opus", "flac"];
const VIDEO: &[&str] = &["mp4", "m4v", "mov", "webm"];

#[derive(Serialize, Deserialize, Clone)]
pub struct MediaItem {
    pub id: String,
    pub folder: String,
    /// "audio" or "video".
    pub kind: String,
    pub title: String,
    /// File name inside media/<folder>/.
    pub file: String,
    #[serde(default)]
    pub duration_s: Option<f64>,
    /// YouTube video id, channel and link when downloaded from there.
    #[serde(default)]
    pub youtube_id: Option<String>,
    #[serde(default)]
    pub channel: Option<String>,
    /// The web address it was downloaded from (ShemenMusic, a songbook link).
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub added: u64,
    /// Absolute path, filled in when listed.
    #[serde(default, skip_deserializing)]
    pub path: String,
}

pub(crate) static INDEX_LOCK: Mutex<()> = Mutex::new(());
/// One yt-dlp install at a time; a second search waits for the first.
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn media_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?.join("media");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

pub(crate) fn folder_ok(f: &str) -> Result<(), String> {
    FOLDERS.iter().any(|x| x.0 == f).then_some(()).ok_or_else(|| "unknown folder".to_string())
}

pub(crate) fn load(d: &Path) -> Vec<MediaItem> {
    std::fs::read_to_string(d.join("index.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save(d: &Path, list: &[MediaItem]) -> Result<(), String> {
    let tmp = d.join("index.json.part");
    std::fs::write(&tmp, serde_json::to_string_pretty(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, d.join("index.json")).map_err(|e| e.to_string())
}

fn with_paths(d: &Path, list: Vec<MediaItem>) -> Vec<MediaItem> {
    list.into_iter()
        .filter(|m| d.join(&m.folder).join(&m.file).exists())
        .map(|mut m| {
            m.path = d.join(&m.folder).join(&m.file).to_string_lossy().to_string();
            m
        })
        .collect()
}

pub(crate) fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub(crate) fn new_id() -> String {
    format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0))
}

pub(crate) fn add(d: &Path, item: MediaItem) -> Result<Vec<MediaItem>, String> {
    let _g = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = load(d);
    list.push(item);
    save(d, &list)?;
    Ok(with_paths(d, list))
}

#[derive(Serialize)]
pub struct Folder {
    id: &'static str,
    name: &'static str,
    kind: &'static str,
}

#[tauri::command]
pub fn media_folders() -> Vec<Folder> {
    FOLDERS.iter().map(|f| Folder { id: f.0, name: f.1, kind: f.2 }).collect()
}

#[tauri::command]
pub fn list_media(app: AppHandle) -> Result<Vec<MediaItem>, String> {
    let d = media_dir(&app)?;
    let _g = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    Ok(with_paths(&d, load(&d)))
}

/// Copy files from the computer into a folder.
#[tauri::command]
pub fn import_media(app: AppHandle, paths: Vec<String>, folder: String) -> Result<Vec<MediaItem>, String> {
    folder_ok(&folder)?;
    let d = media_dir(&app)?;
    std::fs::create_dir_all(d.join(&folder)).map_err(|e| e.to_string())?;
    let mut list = Vec::new();
    for p in paths {
        let src = PathBuf::from(&p);
        let ext = src.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let kind = if AUDIO.contains(&ext.as_str()) {
            "audio"
        } else if VIDEO.contains(&ext.as_str()) {
            "video"
        } else {
            continue;
        };
        if !src.is_file() {
            continue;
        }
        let id = new_id();
        let file = format!("{}.{}", id, ext);
        let dest = d.join(&folder).join(&file);
        let tmp = dest.with_extension("part");
        std::fs::copy(&src, &tmp).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
        let title = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| file.clone());
        list = add(
            &d,
            MediaItem { id, folder: folder.clone(), kind: kind.into(), title, file, duration_s: None, youtube_id: None, channel: None, source_url: None, added: now(), path: String::new() },
        )?;
    }
    if list.is_empty() {
        return list_media(app);
    }
    Ok(list)
}

#[tauri::command]
pub fn delete_media(app: AppHandle, id: String) -> Result<Vec<MediaItem>, String> {
    let d = media_dir(&app)?;
    let _g = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = load(&d);
    if let Some(m) = list.iter().find(|m| m.id == id) {
        if FOLDERS.iter().any(|f| f.0 == m.folder) && !m.file.contains('/') && !m.file.contains('\\') && !m.file.starts_with('.') {
            let _ = std::fs::remove_file(d.join(&m.folder).join(&m.file));
        }
    }
    list.retain(|m| m.id != id);
    save(&d, &list)?;
    Ok(with_paths(&d, list))
}

#[tauri::command]
pub fn rename_media(app: AppHandle, id: String, title: String) -> Result<Vec<MediaItem>, String> {
    let d = media_dir(&app)?;
    let _g = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = load(&d);
    if let Some(m) = list.iter_mut().find(|m| m.id == id) {
        m.title = title.trim().chars().take(200).collect();
    }
    save(&d, &list)?;
    Ok(with_paths(&d, list))
}

// ------------------------------------------------------------------ yt-dlp

fn tools_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?.join("tools");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn ytdlp_asset() -> &'static str {
    if cfg!(target_os = "windows") {
        "yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else {
        "yt-dlp"
    }
}

/// Our copy of yt-dlp, downloaded from its GitHub releases the first time,
/// and updated with `-U` at most once a day.
fn ytdlp(app: &AppHandle) -> Result<PathBuf, String> {
    let _install = INSTALL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tools_dir(app)?;
    let exe = dir.join(if cfg!(target_os = "windows") { "yt-dlp.exe" } else { "yt-dlp" });
    // A copy that does not run (an interrupted download) is replaced.
    if exe.exists() && !Command::new(&exe).arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().map_or(false, |s| s.success()) {
        let _ = std::fs::remove_file(&exe);
    }
    if !exe.exists() {
        let _ = app.emit("media-progress", serde_json::json!({ "id": "", "status": "Getting the YouTube downloader (yt-dlp)…" }));
        let url = format!("https://github.com/yt-dlp/yt-dlp/releases/latest/download/{}", ytdlp_asset());
        let resp = ureq::get(&url).call().map_err(|e| format!("Could not download yt-dlp: {}", e))?;
        let tmp = exe.with_extension("part");
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        std::io::copy(&mut resp.into_reader(), &mut f).map_err(|e| e.to_string())?;
        drop(f);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, &exe).map_err(|e| e.to_string())?;
        // Downloaded executables are quarantined on macOS; ours is fetched by the app itself.
        #[cfg(target_os = "macos")]
        let _ = Command::new("/usr/bin/xattr").args(["-d", "com.apple.quarantine"]).arg(&exe).status();
        let _ = std::fs::write(dir.join("yt-dlp.checked"), now().to_string());
    } else {
        let checked: u64 = std::fs::read_to_string(dir.join("yt-dlp.checked")).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        if now() - checked > 86_400 {
            let _ = std::fs::write(dir.join("yt-dlp.checked"), now().to_string());
            let exe2 = exe.clone();
            std::thread::spawn(move || {
                let _ = Command::new(&exe2).arg("-U").stdout(Stdio::null()).stderr(Stdio::null()).status();
            });
        }
    }
    Ok(exe)
}

/// ffmpeg from the usual install places (apps started from the Dock do not
/// see the shell's PATH) or the app's tools folder.
fn ffmpeg(app: &AppHandle) -> Option<PathBuf> {
    let name = if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" };
    let mut dirs: Vec<PathBuf> = vec![];
    if let Ok(t) = tools_dir(app) {
        dirs.push(t);
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        dirs.push(PathBuf::from(d));
    }
    if let Some(p) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&p));
    }
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

#[derive(Serialize)]
pub struct YtResult {
    id: String,
    title: String,
    channel: String,
    duration_s: Option<f64>,
    thumbnail: String,
}

/// Search YouTube (via yt-dlp, no API key). Up to 24 results.
#[tauri::command]
pub async fn youtube_search(app: AppHandle, query: String) -> Result<Vec<YtResult>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(vec![]);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let exe = ytdlp(&app)?;
        let out = Command::new(exe)
            .args(["--flat-playlist", "-J", "--no-warnings", "--ignore-config"])
            .arg(format!("ytsearch24:{}", q))
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("search failed").to_string());
        }
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
        let entries = v["entries"].as_array().cloned().unwrap_or_default();
        Ok(entries
            .iter()
            .filter_map(|e| {
                let id = e["id"].as_str()?.to_string();
                if id.len() != 11 {
                    return None; // channels and playlists
                }
                // Live streams never finish downloading.
                if e["live_status"].as_str().map_or(false, |s| s == "is_live" || s == "is_upcoming") || e["duration"].is_null() {
                    return None;
                }
                Some(YtResult {
                    thumbnail: format!("https://i.ytimg.com/vi/{}/mqdefault.jpg", id),
                    title: e["title"].as_str().unwrap_or("").to_string(),
                    channel: e["channel"].as_str().or_else(|| e["uploader"].as_str()).unwrap_or("").to_string(),
                    duration_s: e["duration"].as_f64(),
                    id,
                })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stream addresses for previewing a search result before downloading it.
/// `hls` is YouTube's HLS stream, picture and sound together, which WebKit
/// (macOS) plays natively; the separate picture (H.264 up to 720p) and sound
/// files are for WebView2 (Windows), which has no HLS and plays them, while
/// WebKit stalls on them. YouTube's own embedded player refuses pages without
/// a web address, which the app's pages lack.
#[derive(Serialize)]
pub struct YtPreview {
    hls: Option<String>,
    video: Option<String>,
    audio: Option<String>,
}

#[tauri::command]
pub async fn youtube_preview_url(app: AppHandle, video_id: String) -> Result<YtPreview, String> {
    if video_id.len() != 11 || !video_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("bad video id".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let exe = ytdlp(&app)?;
        let out = Command::new(exe)
            .args(["-J", "--no-warnings", "--ignore-config", "--no-playlist", "-f"])
            .arg("bv*[height<=720][vcodec^=avc1][protocol=https]+ba[ext=m4a][protocol=https]/bv*[height<=720][protocol=https]+ba[protocol=https]")
            .arg(format!("https://www.youtube.com/watch?v={}", video_id))
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("preview failed").to_string());
        }
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
        let hls = v["formats"]
            .as_array()
            .and_then(|fs| fs.iter().find_map(|f| f["manifest_url"].as_str().filter(|u| u.contains(".m3u8") || u.contains("hls"))))
            .map(str::to_string);
        let picked = v["requested_formats"].as_array().cloned().unwrap_or_default();
        let url = |want_video: bool| {
            picked
                .iter()
                .find(|f| (f["vcodec"].as_str().unwrap_or("none") != "none") == want_video)
                .and_then(|f| f["url"].as_str())
                .map(str::to_string)
        };
        let p = YtPreview { hls, video: url(true), audio: url(false) };
        if p.hls.is_none() && p.video.is_none() {
            return Err("YouTube gave no playable stream for this video.".into());
        }
        Ok(p)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Download a YouTube video into a folder: video folders get MP4 up to
/// 1080p (720p-ish single file without ffmpeg), audio folders get M4A.
/// Reports "media-progress" {id, percent, status} and "media-done" {id, ok, error}.
#[tauri::command]
pub fn youtube_download(app: AppHandle, video_id: String, folder: String, title: String, channel: String) -> Result<(), String> {
    folder_ok(&folder)?;
    if video_id.len() != 11 || !video_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("not a YouTube video id".into());
    }
    let kind = FOLDERS.iter().find(|f| f.0 == folder).map(|f| f.2).unwrap_or("video");
    std::thread::spawn(move || {
        let done = |ok: bool, error: Option<String>| {
            if let Some(e) = &error {
                crate::log::error(&format!("YouTube download failed ({}): {}", video_id, e));
            }
            let _ = app.emit("media-done", serde_json::json!({ "id": video_id, "ok": ok, "error": error }));
        };
        let run = || -> Result<(), String> {
            let exe = ytdlp(&app)?;
            let d = media_dir(&app)?;
            let dir = d.join(&folder);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let id = new_id();
            let ff = ffmpeg(&app);
            let mut cmd = Command::new(exe);
            cmd.args(["--no-playlist", "--no-warnings", "--ignore-config", "--newline", "--no-mtime", "--match-filter", "!is_live"])
                .args(["--progress-template", "download:%(progress._percent_str)s"])
                .args(["-o", &format!("{}.%(ext)s", id)])
                .current_dir(&dir);
            if kind == "audio" {
                // Native M4A audio needs no conversion.
                cmd.args(["-f", "ba[ext=m4a]/ba"]);
            } else if let Some(ff) = &ff {
                // H.264 first: every computer plays it; AV1 and VP9 only as a fallback.
                cmd.args(["-f", "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b[ext=mp4]/b"])
                    .args(["--merge-output-format", "mp4", "--ffmpeg-location"])
                    .arg(ff);
            } else {
                cmd.args(["-f", "b[ext=mp4]/b"]);
            }
            cmd.arg(format!("https://www.youtube.com/watch?v={}", video_id));
            let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
            let stdout = child.stdout.take().unwrap();
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(p) = line.trim().trim_end_matches('%').trim().parse::<f64>().ok() {
                    let _ = app.emit("media-progress", serde_json::json!({ "id": video_id, "percent": p }));
                }
            }
            let mut err = String::new();
            if let Some(mut e) = child.stderr.take() {
                let _ = std::io::Read::read_to_string(&mut e, &mut err);
            }
            let status = child.wait().map_err(|e| e.to_string())?;
            if !status.success() {
                return Err(err.lines().filter(|l| l.contains("ERROR")).last().unwrap_or("download failed").to_string());
            }
            let file = std::fs::read_dir(&dir)
                .map_err(|e| e.to_string())?
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .find(|n| n.starts_with(&format!("{}.", id)) && !n.ends_with(".part") && !n.contains(".f"))
                .ok_or("the download finished but no file was found")?;
            add(
                &d,
                MediaItem {
                    id,
                    folder: folder.clone(),
                    kind: kind.into(),
                    title: if title.trim().is_empty() { video_id.clone() } else { title.trim().to_string() },
                    file,
                    duration_s: None,
                    youtube_id: Some(video_id.clone()),
                    channel: (!channel.is_empty()).then(|| channel.clone()),
                    source_url: None,
                    added: now(),
                    path: String::new(),
                },
            )?;
            Ok(())
        };
        match run() {
            Ok(()) => done(true, None),
            Err(e) => done(false, Some(e)),
        }
    });
    Ok(())
}

/// Whether HD video downloads are possible (ffmpeg found).
/// Get yt-dlp now (first-run setup) instead of on the first YouTube search.
#[tauri::command]
pub async fn install_ytdlp(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ytdlp(&app).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| {
            crate::log::error(&format!("yt-dlp install failed: {}", e));
            e
        })
}

#[tauri::command]
pub fn media_tools(app: AppHandle) -> serde_json::Value {
    serde_json::json!({ "ffmpeg": ffmpeg(&app).is_some() })
}
