// The projector window ("output"): find it, reopen it, and put it on a
// chosen display. It used to exist only from startup: once closed or lost
// behind a fullscreen Space it stayed gone until the app restarted.
//
// Commands that create windows are async: a window built in a synchronous
// command can deadlock on Windows.
//
// Full screen here is borderless and fills the display without a new macOS
// Space (simple fullscreen), so the projector cannot vanish into another Space.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "output";

/// The projector fills its display.
static FILLED: AtomicBool = AtomicBool::new(false);
/// Presses of "Which display is which?": each press's windows get their own labels.
static IDENTIFY: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn build(app: &AppHandle) -> Result<WebviewWindow, String> {
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("output.html".into()))
        .title("Agent HSP · Output")
        .inner_size(1280.0, 720.0)
        .min_inner_size(640.0, 360.0)
        .build()
        .map(|w| {
            keep_playing(&w);
            w
        })
        .map_err(|e| e.to_string())
}

/// WebKit refuses to start video in a window it thinks no one can see: one
/// behind the console, or on a display that is off. The projector's motion
/// background then sat on its first frame until someone clicked the projector.
/// Turning off occlusion detection (WebKit SPI, checked before use) keeps the
/// projector page "visible" so its muted video can always play.
pub fn keep_playing(w: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    let _ = w.with_webview(|pw| unsafe {
        use objc2::runtime::{AnyObject, Bool};
        use objc2::{msg_send, sel};
        let wk = pw.inner() as *mut AnyObject;
        if wk.is_null() {
            return;
        }
        let can: Bool = msg_send![wk, respondsToSelector: sel!(_setWindowOcclusionDetectionEnabled:)];
        if can.as_bool() {
            let _: () = msg_send![wk, _setWindowOcclusionDetectionEnabled: Bool::NO];
        }
    });
    #[cfg(not(target_os = "macos"))]
    let _ = w;
}

fn window(app: &AppHandle) -> Result<WebviewWindow, String> {
    match app.get_webview_window(LABEL) {
        Some(w) => Ok(w),
        None => build(app),
    }
}

fn front(w: &WebviewWindow) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

/// Bring the projector to the front, opening it if it was closed.
#[tauri::command]
pub async fn projector_show(app: AppHandle) -> Result<(), String> {
    front(&window(&app)?);
    Ok(())
}

/// Reload the projector page (it asks the console for the current slide) and
/// bring it to the front; open it if it was closed.
#[tauri::command]
pub async fn projector_reopen(app: AppHandle) -> Result<(), String> {
    let w = match app.get_webview_window(LABEL) {
        Some(w) => {
            let _ = w.eval("location.reload()");
            w
        }
        None => build(&app)?,
    };
    front(&w);
    Ok(())
}

#[tauri::command]
pub fn projector_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        unfill(&w);
        let _ = w.close();
    }
}

/// Leave simple fullscreen. It hides the Dock and menu bar app-wide and only
/// leaving it brings them back: closing a filled window left them hidden.
pub fn unfill(w: &WebviewWindow) {
    if FILLED.swap(false, Ordering::SeqCst) {
        let _ = w.set_simple_fullscreen(false);
    }
}

#[derive(Serialize)]
pub struct Display {
    index: usize,
    name: String,
    width: u32,
    height: u32,
    primary: bool,
    /// The projector window is on this display.
    projector: bool,
}

fn same(a: &Monitor, b: &Monitor) -> bool {
    a.position() == b.position() && a.size() == b.size()
}

fn displays(app: &AppHandle) -> Result<Vec<Monitor>, String> {
    app.available_monitors().map_err(|e| e.to_string())
}

/// What people call each display. On macOS the windowing library names them
/// "Monitor #41038" (the display's model number); the system's own name
/// ("Built-in Retina Display", "DELL U2720Q") comes from NSScreen, on the
/// main thread.
/// Call from an async command: waiting on the main thread from it would hang.
fn display_names(app: &AppHandle, all: &[Monitor]) -> Vec<String> {
    #[cfg(target_os = "macos")]
    let names = {
        let (tx, rx) = std::sync::mpsc::channel();
        let _ = app.run_on_main_thread(move || {
            let _ = tx.send(screen_names());
        });
        rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default()
    };
    #[cfg(not(target_os = "macos"))]
    let names: Vec<(u32, String)> = {
        let _ = app;
        Vec::new()
    };
    // Two displays of one model share a number: give each the next unused name.
    let mut used = vec![false; names.len()];
    all.iter()
        .enumerate()
        .map(|(i, m)| {
            let raw = m.name().cloned().unwrap_or_default();
            let model = raw.strip_prefix("Monitor #").and_then(|n| n.parse::<u32>().ok());
            match model {
                Some(model) => match names.iter().enumerate().position(|(k, (n, _))| *n == model && !used[k]) {
                    Some(k) => {
                        used[k] = true;
                        names[k].1.clone()
                    }
                    None => format!("Display {}", i + 1),
                },
                None if raw.is_empty() => format!("Display {}", i + 1),
                None => raw,
            }
        })
        .collect()
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGDisplayModelNumber(display: u32) -> u32;
}

/// (model number, localized name) for each screen. Main thread only.
#[cfg(target_os = "macos")]
fn screen_names() -> Vec<(u32, String)> {
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{msg_send, sel};
    let mut out = Vec::new();
    unsafe {
        let (Some(screen), Some(string)) = (AnyClass::get(c"NSScreen"), AnyClass::get(c"NSString")) else {
            return out;
        };
        let screens: *mut AnyObject = msg_send![screen, screens];
        if screens.is_null() {
            return out;
        }
        let key: *mut AnyObject = msg_send![string, stringWithUTF8String: c"NSScreenNumber".as_ptr()];
        let count: usize = msg_send![screens, count];
        for i in 0..count {
            let s: *mut AnyObject = msg_send![screens, objectAtIndex: i];
            let can: Bool = msg_send![s, respondsToSelector: sel!(localizedName)];
            if !can.as_bool() {
                continue;
            }
            let desc: *mut AnyObject = msg_send![s, deviceDescription];
            let num: *mut AnyObject = msg_send![desc, objectForKey: key];
            let name: *mut AnyObject = msg_send![s, localizedName];
            if num.is_null() || name.is_null() {
                continue;
            }
            let id: u32 = msg_send![num, unsignedIntValue];
            let utf8: *const std::ffi::c_char = msg_send![name, UTF8String];
            if !utf8.is_null() {
                out.push((CGDisplayModelNumber(id), std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned()));
            }
        }
    }
    out
}

#[tauri::command]
pub async fn list_displays(app: AppHandle) -> Result<Vec<Display>, String> {
    let primary = app.primary_monitor().ok().flatten();
    let here = app.get_webview_window(LABEL).and_then(|w| w.current_monitor().ok().flatten());
    let all = displays(&app)?;
    let names = display_names(&app, &all);
    Ok(all
        .iter()
        .zip(names)
        .enumerate()
        .map(|(i, (m, name))| Display {
            index: i,
            name,
            width: m.size().width,
            height: m.size().height,
            primary: primary.as_ref().map_or(false, |p| same(p, m)),
            projector: here.as_ref().map_or(false, |h| same(h, m)),
        })
        .collect())
}

/// Put the projector on display `index`, filling it, or as a window on it.
#[tauri::command]
pub async fn projector_to_display(app: AppHandle, index: usize, name: Option<String>, fill: bool) -> Result<(), String> {
    let all = displays(&app)?;
    // The list may have changed since the menu opened (a display plugged in).
    let by_name = |n: &String| all.iter().position(|m| m.name() == Some(n));
    let index = match &name {
        Some(n) if all.get(index).and_then(|m| m.name()) != Some(n) => by_name(n).ok_or("That display is no longer connected.")?,
        _ => index,
    };
    let m = all.get(index).ok_or("That display is no longer connected.")?;
    let w = window(&app)?;
    // Leave any fullscreen first, or the move is ignored.
    let _ = w.set_simple_fullscreen(false);
    let _ = w.set_fullscreen(false);
    FILLED.store(fill, Ordering::SeqCst);
    let p = m.position();
    if fill {
        let _ = w.set_position(PhysicalPosition::new(p.x, p.y));
        let _ = w.set_size(PhysicalSize::new(m.size().width, m.size().height));
        front(&w);
        // macOS moves the window to the display before it can fill it.
        std::thread::sleep(Duration::from_millis(150));
        w.set_simple_fullscreen(true).map_err(|e| e.to_string())?;
        // Keys go to the console, not the projector it may now sit beside.
        if let Some(c) = app.get_webview_window("console") {
            let _ = c.set_focus();
        }
    } else {
        let (mw, mh) = (m.size().width, m.size().height);
        let (ww, wh) = ((mw * 2 / 3).max(640), (mh * 2 / 3).max(360));
        let _ = w.set_size(PhysicalSize::new(ww, wh));
        let _ = w.set_position(PhysicalPosition::new(p.x + (mw.saturating_sub(ww) / 2) as i32, p.y + (mh.saturating_sub(wh) / 2) as i32));
        front(&w);
    }
    Ok(())
}

/// Double-click on the projector: fill its display, or go back to a window.
#[tauri::command]
pub async fn projector_toggle_fill(app: AppHandle) -> Result<(), String> {
    let w = window(&app)?;
    let here = w.current_monitor().ok().flatten().ok_or("The projector is not on a display.")?;
    let index = displays(&app)?.iter().position(|m| same(m, &here)).unwrap_or(0);
    projector_to_display(app, index, None, !FILLED.load(Ordering::SeqCst)).await
}

/// The projector page could not start its motion background: under macOS
/// Low Power Mode WebKit refuses to start any video, muted or not, without a
/// user action, so it sat on its first frame until someone clicked the
/// projector. A script the app runs in the page counts as a user action, so
/// the page asks for this and its "hsp-play" handler starts the videos.
#[tauri::command]
pub fn projector_play(app: AppHandle) -> Result<(), String> {
    let w = app.get_webview_window(LABEL).ok_or("no projector")?;
    w.eval("window.dispatchEvent(new Event('hsp-play'))").map_err(|e| e.to_string())
}

/// Show a large number on every display for a few seconds.
#[tauri::command]
pub async fn identify_displays(app: AppHandle) -> Result<(), String> {
    let all = displays(&app)?;
    let names = display_names(&app, &all);
    let gen = IDENTIFY.fetch_add(1, Ordering::SeqCst) + 1;
    // A second press replaces the numbers still showing from the first. (It
    // used to skip them, and the first press's timer then left them alone, so
    // they stayed on screen for good.)
    identify_close(app.clone());
    // Never cover a projector that is showing the service.
    let live = if FILLED.load(Ordering::SeqCst) { app.get_webview_window(LABEL).and_then(|w| w.current_monitor().ok().flatten()) } else { None };
    let mut labels = Vec::new();
    for (i, (m, name)) in all.iter().zip(names).enumerate() {
        if live.as_ref().map_or(false, |l| same(l, m)) {
            continue;
        }
        let label = format!("identify-{}-{}", gen, i);
        let s = m.scale_factor();
        let (w, h) = (420.0, 300.0);
        let x = m.position().x as f64 / s + (m.size().width as f64 / s - w) / 2.0;
        let y = m.position().y as f64 / s + (m.size().height as f64 / s - h) / 2.0;
        let url = format!("output.html?identify={}&name={}", i + 1, urlencode(&name));
        if WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
            .title("Display")
            .decorations(false)
            .always_on_top(true)
            .focused(false)
            // The click that closes it must reach the page, not just focus it.
            .accept_first_mouse(true)
            .resizable(false)
            .inner_size(w, h)
            .position(x, y)
            .build()
            .is_ok()
        {
            labels.push(label);
        }
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(4));
        for l in labels {
            if let Some(w) = app.get_webview_window(&l) {
                let _ = w.close();
            }
        }
    });
    Ok(())
}

/// Close every "which display is which?" number: a click on any one of them
/// closes them all.
#[tauri::command]
pub fn identify_close(app: AppHandle) {
    for (l, w) in app.webview_windows() {
        if l.starts_with("identify-") {
            let _ = w.close();
        }
    }
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect()
}

/// Tell the console when the projector window goes away.
pub fn on_closed(app: &AppHandle) {
    FILLED.store(false, Ordering::SeqCst);
    let _ = app.emit("projector-closed", ());
}
