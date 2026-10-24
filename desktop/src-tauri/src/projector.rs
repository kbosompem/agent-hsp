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
        let _ = w.close();
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

#[tauri::command]
pub fn list_displays(app: AppHandle) -> Result<Vec<Display>, String> {
    let primary = app.primary_monitor().ok().flatten();
    let here = app.get_webview_window(LABEL).and_then(|w| w.current_monitor().ok().flatten());
    Ok(displays(&app)?
        .iter()
        .enumerate()
        .map(|(i, m)| Display {
            index: i,
            name: m.name().cloned().unwrap_or_else(|| format!("Display {}", i + 1)),
            width: m.size().width,
            height: m.size().height,
            primary: primary.as_ref().map_or(false, |p| same(p, m)),
            projector: here.as_ref().map_or(false, |h| same(h, m)),
        })
        .collect())
}

/// Put the projector on display `index`, filling it, or as a window on it.
#[tauri::command]
pub async fn projector_to_display(app: AppHandle, index: usize, fill: bool) -> Result<(), String> {
    let all = displays(&app)?;
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
    projector_to_display(app, index, !FILLED.load(Ordering::SeqCst)).await
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
    let mut labels = Vec::new();
    for (i, m) in all.iter().enumerate() {
        let label = format!("identify-{}", i);
        if let Some(old) = app.get_webview_window(&label) {
            let _ = old.close();
            continue;
        }
        let s = m.scale_factor();
        let (w, h) = (420.0, 300.0);
        let x = m.position().x as f64 / s + (m.size().width as f64 / s - w) / 2.0;
        let y = m.position().y as f64 / s + (m.size().height as f64 / s - h) / 2.0;
        let name = m.name().cloned().unwrap_or_default();
        let url = format!("output.html?identify={}&name={}", i + 1, urlencode(&name));
        if WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
            .title("Display")
            .decorations(false)
            .always_on_top(true)
            .focused(false)
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
