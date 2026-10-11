// The app's error log: <app data>/logs/agent-hsp.log, plain text, one line
// per event with a UTC time. The core writes its own errors (and panics) here;
// the console sends its errors through `log_event`. When the file passes
// MAX_BYTES it moves to agent-hsp.old.log, so the log never grows past twice that.
//
// Settings has "Open log folder" so an operator can send the file without
// finding it by hand.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const MAX_BYTES: u64 = 2 * 1024 * 1024;

static PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Call once at startup: picks the file and catches panics into it.
pub fn init(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir().map(|d| d.join("logs")) else { return };
    let _ = std::fs::create_dir_all(&dir);
    *PATH.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir.join("agent-hsp.log"));
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write("PANIC", &info.to_string());
        prev(info);
    }));
    write(
        "INFO",
        &format!(
            "Agent HSP {} started on {} {} (Nemotron {})",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
            if cfg!(feature = "nemotron") { "included" } else { "not included" }
        ),
    );
}

/// "2026-10-11 14:03:22" (UTC) without a date library.
fn stamp() -> String {
    let s = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (days, rem) = (s / 86_400, s % 86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, m, d, rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Append one line. Never fails loudly: a log that cannot be written is skipped.
pub fn write(level: &str, msg: &str) {
    let guard = PATH.lock().unwrap_or_else(|e| e.into_inner());
    let Some(path) = guard.as_ref() else { return };
    if std::fs::metadata(path).map_or(false, |m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(path, path.with_file_name("agent-hsp.old.log"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{} {:5} {}", stamp(), level, msg.replace('\n', "\n    "));
    }
    drop(guard);
    if cfg!(debug_assertions) {
        eprintln!("{} {}", level, msg);
    }
}

pub fn error(msg: &str) {
    write("ERROR", msg);
}

pub fn info(msg: &str) {
    write("INFO", msg);
}

/// The console's errors (failed commands, uncaught exceptions, error toasts).
#[tauri::command]
pub fn log_event(level: String, message: String) {
    let level = match level.as_str() {
        "error" => "ERROR",
        "warn" => "WARN",
        _ => "INFO",
    };
    write(level, &format!("[ui] {}", message.chars().take(4000).collect::<String>()));
}

/// Show the log folder in Finder / Explorer.
#[tauri::command]
pub fn open_log_folder(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("logs");
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&dir).spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(&dir).spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let r = std::process::Command::new("xdg-open").arg(&dir).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn stamp_is_a_date() {
        let s = super::stamp();
        assert_eq!(s.len(), 19);
        assert!(s.starts_with("20"), "{}", s);
    }
}
