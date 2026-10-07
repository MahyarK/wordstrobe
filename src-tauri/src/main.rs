// One file per OS, same free functions (PLAN §3). Other OSes fail to compile until their file exists.
#[cfg(target_os = "macos")]
#[path = "platform/macos.rs"]
mod platform;

use std::{
    fs,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, LogicalPosition, Manager, WebviewWindow, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_store::StoreExt;

const STORE: &str = "settings.json";
const DEFAULT_HOTKEY: &str = "Alt+Shift+R";
/// Gap between cursor and popup, and minimum distance to the work-area edge (logical points).
const GAP: f64 = 24.0;
const MARGIN: f64 = 8.0;

type Rect = (f64, f64, f64, f64); // x, y, width, height in logical points

// ---------------------------------------------------------------------------------------------
// Placement

/// Top-left of the popup: centered on the cursor, `GAP` below it, flipped above when it does not
/// fit below, then clamped into `area` (with `MARGIN`). If the popup is bigger than the area, the
/// top-left corner wins so the start of the text stays visible.
fn place(cursor: (f64, f64), size: (f64, f64), area: Rect) -> (f64, f64) {
    let ((cx, cy), (w, h), (ax, ay, aw, ah)) = (cursor, size, area);
    let below = cy + GAP;
    let y = if below + h <= ay + ah - MARGIN {
        below
    } else {
        cy - GAP - h
    };
    let clamp = |v: f64, lo: f64, hi: f64| v.min(hi).max(lo);
    (
        clamp(cx - w / 2.0, ax + MARGIN, ax + aw - w - MARGIN),
        clamp(y, ay + MARGIN, ay + ah - h - MARGIN),
    )
}

fn setting(app: &AppHandle, key: &str) -> Option<String> {
    app.store(STORE).ok()?.get(key)?.as_str().map(str::to_owned)
}

/// Where the reader goes, in logical points, or `None` to leave it where it is.
fn reader_position(app: &AppHandle, reader: &WebviewWindow) -> Option<(f64, f64)> {
    let mode = setting(app, "placement").unwrap_or_else(|| "cursor".into());
    if mode == "last" {
        return None;
    }
    let size = reader
        .outer_size()
        .ok()?
        .to_logical::<f64>(reader.scale_factor().ok()?);
    let primary = app.primary_monitor().ok()?;
    // ponytail: tao reports the macOS cursor in physical px of the *primary* monitor, so dividing by
    // its scale gives global points (also on mixed-DPI setups). Windows/Linux need their own math in M7.
    let scale = primary.as_ref().map_or(1.0, |m| m.scale_factor());
    let cursor = app.cursor_position().ok()?;
    let cursor = (cursor.x / scale, cursor.y / scale);

    // Monitor positions/sizes are physical = points × that monitor's own scale.
    let logical = |x: i32, y: i32, w: u32, h: u32, s: f64| -> Rect {
        (
            f64::from(x) / s,
            f64::from(y) / s,
            f64::from(w) / s,
            f64::from(h) / s,
        )
    };
    let monitors = app.available_monitors().ok()?;
    let monitor = monitors
        .iter()
        .find(|m| {
            let (p, s) = (m.position(), m.size());
            let (x, y, w, h) = logical(p.x, p.y, s.width, s.height, m.scale_factor());
            (x..x + w).contains(&cursor.0) && (y..y + h).contains(&cursor.1)
        })
        .or(primary.as_ref())
        .or(monitors.first())?;
    let (p, s) = (monitor.work_area().position, monitor.work_area().size);
    let area = logical(p.x, p.y, s.width, s.height, monitor.scale_factor());

    Some(if mode == "center" {
        (
            area.0 + (area.2 - size.width) / 2.0,
            area.1 + (area.3 - size.height) / 2.0,
        )
    } else {
        place(cursor, (size.width, size.height), area)
    })
}

// ---------------------------------------------------------------------------------------------
// Read flow (PLAN §4)

static BUSY: AtomicBool = AtomicBool::new(false);
static COUNTER: AtomicU64 = AtomicU64::new(0);
static READER_LOADED: AtomicBool = AtomicBool::new(false);

/// Held for the whole flow; dropping it (also when the thread panics) frees the hotkey again.
struct Busy;

impl Busy {
    fn take() -> Option<Busy> {
        (!BUSY.swap(true, Ordering::AcqRel)).then_some(Busy)
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::Release);
    }
}

fn capture_dir() -> PathBuf {
    std::env::temp_dir().join("wordstrobe")
}

/// `file`: the `--read-image` test entry, which skips the capture and leaves the file alone.
fn start_read(app: &AppHandle, file: Option<PathBuf>) {
    let Some(busy) = Busy::take() else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        let _busy = busy;
        read(&app, file);
    });
}

fn read(app: &AppHandle, file: Option<PathBuf>) {
    let (path, source) = match file {
        Some(path) => (path, "file"),
        None => {
            if !platform::has_capture_permission() {
                show_window(app, "settings");
                return;
            }
            let started = Instant::now();
            match capture() {
                Ok(Some(path)) => {
                    eprintln!("wordstrobe: capture {} ms", started.elapsed().as_millis());
                    (path, "region")
                }
                Ok(None) => return, // Esc: cancelled, stay silent
                Err(e) => {
                    eprintln!("wordstrobe: capture failed: {e}");
                    return;
                }
            }
        }
    };

    show_reader(app);
    emit(app, "reader:status", json!({ "state": "ocr" }));

    let started = Instant::now();
    let result = platform::ocr(app, &path);
    if source == "region" {
        let _ = fs::remove_file(&path);
    }

    match result {
        Ok(mut payload) => {
            if let Some(object) = payload.as_object_mut() {
                object.remove("id");
                object.insert("source".into(), source.into());
            }
            // Captured text is only logged for the test entry, never for real captures (PLAN §15).
            let text = if source == "file" {
                format!(": {payload}")
            } else {
                String::new()
            };
            eprintln!(
                "wordstrobe: ocr {} ms, emitted reader:load{text}",
                started.elapsed().as_millis()
            );
            emit(app, "reader:load", payload);
        }
        Err(message) => {
            eprintln!("wordstrobe: ocr failed: {message}");
            emit(
                app,
                "reader:status",
                json!({ "state": "error", "message": message }),
            );
        }
    }
}

/// `Ok(None)` = cancelled.
fn capture() -> Result<Option<PathBuf>, String> {
    let dir = capture_dir();
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)
        .map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.png", COUNTER.fetch_add(1, Ordering::Relaxed)));
    Ok(platform::capture_region(&path)?.then_some(path))
}

fn emit(app: &AppHandle, event: &str, payload: Value) {
    // `emit_to` with a label reaches listeners registered via `getCurrentWebviewWindow().listen`.
    let _ = app.emit_to("reader", event, payload);
}

fn show_reader(app: &AppHandle) {
    let Some(reader) = app.get_webview_window("reader") else {
        return;
    };
    // Right after launch the hidden page may still be loading, and events sent before that are lost.
    for _ in 0..150 {
        if READER_LOADED.load(Ordering::Acquire) {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if let Some((x, y)) = reader_position(app, &reader) {
        let _ = reader.set_position(LogicalPosition::new(x, y));
    }
    let _ = reader.show();
    let _ = reader.set_focus();
}

fn show_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// `--read-image <path>` (relative paths resolve against the launching shell's cwd).
fn read_image_arg(args: &[String], cwd: &Path) -> Option<PathBuf> {
    let i = args.iter().position(|a| a == "--read-image")?;
    Some(cwd.join(args.get(i + 1)?))
}

// ---------------------------------------------------------------------------------------------
// Commands. Tauri v2 lets every window invoke app commands unless an app permission manifest
// (`build.rs` + `AppManifest::commands`) restricts them; we don't build one, so the per-window
// capabilities only gate plugin/core permissions.

#[tauri::command]
fn permission_status() -> bool {
    platform::has_capture_permission()
}

#[tauri::command]
fn request_permission() -> bool {
    platform::request_capture_permission()
}

#[tauri::command]
async fn open_privacy_settings() {
    platform::open_privacy_settings();
}

#[tauri::command]
fn relaunch(app: AppHandle) {
    app.restart();
}

#[tauri::command]
fn close_reader(app: AppHandle) {
    if let Some(reader) = app.get_webview_window("reader") {
        let _ = reader.hide();
    }
    // Accessory app: hiding it hands focus back to the app that was active before the popup.
    // Skipped while Settings is open, since that would hide Settings too.
    #[cfg(target_os = "macos")]
    {
        let settings_open = app
            .get_webview_window("settings")
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false);
        if !settings_open {
            let _ = app.hide();
        }
    }
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    show_window(&app, "settings");
}

// ---------------------------------------------------------------------------------------------
// Setup

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    // ponytail: the shortcut is hardcoded in the label; once the hotkey is user-configurable it can go stale.
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "read", "Read Region  ⌥⇧R", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?,
            &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
        ],
    )?;
    TrayIconBuilder::new()
        .icon(tauri::include_image!("icons/tray.png"))
        .icon_as_template(true)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "read" => start_read(app, None),
            "settings" => show_window(app, "settings"),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn register_hotkey(app: &AppHandle) {
    let key = setting(app, "hotkeyRegion").unwrap_or_else(|| DEFAULT_HOTKEY.into());
    let result = key
        .parse::<Shortcut>()
        .map_err(|e| e.to_string())
        .and_then(|shortcut| {
            app.global_shortcut()
                .register(shortcut)
                .map_err(|e| e.to_string())
        });
    if let Err(e) = result {
        eprintln!("wordstrobe: cannot register hotkey {key:?}: {e}");
        show_window(app, "settings");
    }
}

fn main() {
    tauri::Builder::default()
        // Must stay first. A second launch forwards its args here instead of starting another app.
        .plugin(tauri_plugin_single_instance::init(
            |app, argv, cwd| match read_image_arg(&argv, Path::new(&cwd)) {
                Some(path) => start_read(app, Some(path)),
                None => show_window(app, "settings"),
            },
        ))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                // ponytail: one shortcut only, so the handler doesn't look at which one fired; M5 must.
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        start_read(app, None);
                    }
                })
                .build(),
        )
        .on_page_load(|webview, payload| {
            if webview.label() == "reader"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                READER_LOADED.store(true, Ordering::Release);
            }
        })
        .invoke_handler(tauri::generate_handler![
            permission_status,
            request_permission,
            open_privacy_settings,
            relaunch,
            close_reader,
            open_settings,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let handle = app.handle();
            // Leftovers of a crashed run: captures must never outlive the flow that made them.
            let _ = fs::remove_dir_all(capture_dir());

            // Both windows are only ever hidden, never destroyed, so they stay pre-warmed.
            for label in ["reader", "settings"] {
                if let Some(window) = handle.get_webview_window(label) {
                    let target = window.clone();
                    window.on_window_event(move |event| {
                        if let WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = target.hide();
                        }
                    });
                }
            }

            app.manage(platform::Ocr::default());
            platform::start_helper(handle);
            build_tray(handle)?;
            register_hotkey(handle);

            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir().unwrap_or_default();
            if let Some(path) = read_image_arg(&args, &cwd) {
                start_read(handle, Some(path));
            } else if !platform::has_capture_permission() {
                show_window(handle, "settings"); // first run (PLAN §8)
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Wordstrobe");
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = (0.0, 25.0, 1440.0, 875.0); // below a 25 pt menu bar
    const SIZE: (f64, f64) = (520.0, 190.0);

    #[test]
    fn below_the_cursor_and_centered() {
        assert_eq!(place((700.0, 400.0), SIZE, AREA), (440.0, 424.0));
    }

    #[test]
    fn flips_above_when_there_is_no_room_below() {
        // 800 + 24 + 190 > 900 - 8, so the bottom edge goes 24 pt above the cursor.
        assert_eq!(place((700.0, 800.0), SIZE, AREA), (440.0, 586.0));
    }

    #[test]
    fn clamps_left_and_right() {
        assert_eq!(place((10.0, 400.0), SIZE, AREA).0, 8.0);
        assert_eq!(place((1435.0, 400.0), SIZE, AREA).0, 1440.0 - 520.0 - 8.0);
    }

    #[test]
    fn clamps_top_when_the_popup_fits_neither_side() {
        let (_, y) = place((700.0, 450.0), (520.0, 800.0), AREA);
        assert_eq!(y, 25.0 + 8.0); // above would start at -374
    }

    #[test]
    fn clamps_bottom_when_the_cursor_is_outside_the_work_area() {
        // e.g. over the Dock: below doesn't fit, and "above the cursor" still overflows the area's bottom
        let (_, y) = place((700.0, 1000.0), SIZE, AREA);
        assert_eq!(y, 25.0 + 875.0 - 190.0 - 8.0);
    }

    #[test]
    fn small_monitor_pins_top_left_with_margin() {
        let area = (100.0, 30.0, 300.0, 150.0); // smaller than the popup in both directions
        assert_eq!(place((250.0, 100.0), SIZE, area), (108.0, 38.0));
    }

    #[test]
    fn second_monitor_to_the_left_has_negative_origin() {
        let area = (-1920.0, 0.0, 1920.0, 1080.0);
        assert_eq!(place((-960.0, 500.0), SIZE, area), (-1220.0, 524.0));
    }
}
