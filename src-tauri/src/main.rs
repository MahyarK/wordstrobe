// One file per OS, same free functions (PLAN §3). Other OSes fail to compile until their file exists.
#[cfg(target_os = "macos")]
#[path = "platform/macos.rs"]
mod platform;

use std::{
    fs,
    os::unix::fs::{DirBuilderExt, MetadataExt},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Condvar, Mutex,
    },
    time::{Duration, Instant, SystemTime},
};

use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Monitor, WebviewWindow, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_store::StoreExt;

const STORE: &str = "settings.json";
const DEFAULT_HOTKEY: &str = "Alt+Shift+R";
/// Gap between cursor and popup, and minimum distance to the work-area edge (logical points).
const GAP: f64 = 24.0;
const MARGIN: f64 = 8.0;
/// Bounds for a remembered reader size (logical points). The minimum matches `tauri.conf.json`.
const READER_MIN: (f64, f64) = (360.0, 140.0);
const READER_MAX: (f64, f64) = (4000.0, 4000.0);

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

/// A monitor as Tauri reports it. Positions and sizes are physical: points × this monitor's *own*
/// scale, so on mixed-DPI setups they are not comparable between monitors until divided by it.
#[derive(Clone, Copy)]
struct Screen {
    position: (i32, i32),
    size: (u32, u32),
    scale: f64,
    work_position: (i32, i32),
    work_size: (u32, u32),
}

impl Screen {
    fn new(monitor: &Monitor) -> Self {
        let (position, size, work) = (monitor.position(), monitor.size(), monitor.work_area());
        Screen {
            position: (position.x, position.y),
            size: (size.width, size.height),
            scale: monitor.scale_factor(),
            work_position: (work.position.x, work.position.y),
            work_size: (work.size.width, work.size.height),
        }
    }

    fn points(&self, position: (i32, i32), size: (u32, u32)) -> Rect {
        let s = self.scale;
        (
            f64::from(position.0) / s,
            f64::from(position.1) / s,
            f64::from(size.0) / s,
            f64::from(size.1) / s,
        )
    }

    /// The whole monitor, in global points.
    fn frame(&self) -> Rect {
        self.points(self.position, self.size)
    }

    /// Below the menu bar and beside the Dock, in global points.
    fn work_area(&self) -> Rect {
        self.points(self.work_position, self.work_size)
    }
}

/// The cursor in global points and the work area (also points) of the screen it is on. `cursor_px`
/// is what tao reports on macOS: physical px of the *primary* screen, so its scale gives points that
/// compare with every screen's frame (also with other scales). Outside every screen it is the
/// primary one, or else the first.
fn locate(
    cursor_px: (f64, f64),
    primary: Option<&Screen>,
    screens: &[Screen],
) -> Option<((f64, f64), Rect)> {
    let scale = primary.map_or(1.0, |s| s.scale);
    let cursor = (cursor_px.0 / scale, cursor_px.1 / scale);
    let screen = screens
        .iter()
        .find(|s| {
            let (x, y, w, h) = s.frame();
            (x..x + w).contains(&cursor.0) && (y..y + h).contains(&cursor.1)
        })
        .or(primary)
        .or(screens.first())?;
    Some((cursor, screen.work_area()))
}

/// Top-left of the popup for the placement `mode` ("center", otherwise near the cursor).
fn position_in(mode: &str, cursor: (f64, f64), size: (f64, f64), area: Rect) -> (f64, f64) {
    if mode == "center" {
        (
            area.0 + (area.2 - size.0) / 2.0,
            area.1 + (area.3 - size.1) / 2.0,
        )
    } else {
        place(cursor, size, area)
    }
}

/// Where the reader goes, in logical points, or `None` to leave it where it is.
fn reader_position(app: &AppHandle, reader: &WebviewWindow) -> Option<(f64, f64)> {
    let mode = setting(app, "placement").unwrap_or_else(|| "cursor".into());
    if mode == "last" {
        return None;
    }
    // The *current* size: the user may have resized the popup, or restored a remembered size.
    let size = reader
        .outer_size()
        .ok()?
        .to_logical::<f64>(reader.scale_factor().ok()?);
    // ponytail: tao reports the macOS cursor in physical px of the *primary* monitor. Windows/Linux need their own math in M7.
    let cursor = app.cursor_position().ok()?;
    let primary = app.primary_monitor().ok()?.map(|m| Screen::new(&m));
    let screens: Vec<Screen> = app
        .available_monitors()
        .ok()?
        .iter()
        .map(Screen::new)
        .collect();
    let (cursor, area) = locate((cursor.x, cursor.y), primary.as_ref(), &screens)?;
    Some(position_in(&mode, cursor, (size.width, size.height), area))
}

// ---------------------------------------------------------------------------------------------
// Reader size (PLAN §8: "the size is remembered")

/// `None` for anything that is not a usable size; otherwise clamped to the sane range.
fn clamp_size(w: f64, h: f64) -> Option<(f64, f64)> {
    (w.is_finite() && h.is_finite()).then(|| {
        (
            w.clamp(READER_MIN.0, READER_MAX.0).round(),
            h.clamp(READER_MIN.1, READER_MAX.1).round(),
        )
    })
}

fn saved_reader_size(app: &AppHandle) -> Option<(f64, f64)> {
    let value = app.store(STORE).ok()?.get("readerSize")?;
    clamp_size(value.get("w")?.as_f64()?, value.get("h")?.as_f64()?)
}

/// Saves the size the user gives the visible reader by dragging its edge.
fn remember_reader_size(app: &AppHandle, reader: &WebviewWindow) {
    let (app, target) = (app.clone(), reader.clone());
    reader.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Resized(_)) || !target.is_visible().unwrap_or(false) {
            return;
        }
        // Asked here (the main thread, where this runs) rather than taken from the event, so size
        // and scale factor always belong together, also while the window moves between displays.
        let size = target.inner_size().ok().zip(target.scale_factor().ok());
        let size = size.map(|(size, scale)| size.to_logical::<f64>(scale));
        if let Some(size) = size.and_then(|s| clamp_size(s.width, s.height)) {
            save_reader_size_soon(&app, size);
        }
    });
}

static SIZE_LATEST: Mutex<Option<(f64, f64)>> = Mutex::new(None);
static SIZE_SAVE_PENDING: AtomicBool = AtomicBool::new(false);

/// A drag-resize sends a stream of events: keep the latest size and write it once shortly after,
/// so the file is written at most every 500 ms and always ends up with the final size.
fn save_reader_size_soon(app: &AppHandle, size: (f64, f64)) {
    *SIZE_LATEST.lock().unwrap() = Some(size);
    if SIZE_SAVE_PENDING.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        // Cleared before reading, so an event that comes in after the read starts a new round.
        SIZE_SAVE_PENDING.store(false, Ordering::Release);
        let latest = SIZE_LATEST.lock().unwrap().take();
        if let (Some((w, h)), Ok(store)) = (latest, app.store(STORE)) {
            store.set("readerSize", json!({ "w": w, "h": h }));
        }
    });
}

// ---------------------------------------------------------------------------------------------
// Read flow (PLAN §4)

static BUSY: AtomicBool = AtomicBool::new(false);
static COUNTER: AtomicU64 = AtomicU64::new(0);
/// Set by the `reader_ready` command once the reader page has registered its event listeners.
/// A finished page load is not enough: events sent before the listeners exist are lost.
static READER_READY: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());

fn set_reader_ready(ready: bool) {
    *READER_READY.0.lock().unwrap() = ready;
    READER_READY.1.notify_all();
}

/// Waits (up to `timeout`) for `reader_ready`.
fn wait_reader_ready(timeout: Duration) -> bool {
    let (lock, condvar) = &READER_READY;
    let ready = condvar
        .wait_timeout_while(lock.lock().unwrap(), timeout, |ready| !*ready)
        .unwrap();
    *ready.0
}

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

/// `file`: the `--read-image` test entry (debug builds only), which skips the capture and leaves the file alone.
fn start_read(app: &AppHandle, file: Option<PathBuf>) {
    let Some(busy) = Busy::take() else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        let _busy = busy;
        read(&app, file);
    });
}

fn read(app: &AppHandle, file: Option<PathBuf>) {
    // `mouse_up`: when the user let go of the mouse, as far as that can be told (see `capture`).
    let (path, source, mouse_up) = match file {
        Some(path) => (path, "file", Instant::now()),
        None => {
            if !platform::has_capture_permission() {
                show_window(app, "settings");
                return;
            }
            match capture() {
                Ok(Some((path, mouse_up))) => (path, "region", mouse_up),
                Ok(None) => return, // Esc: cancelled, stay silent
                Err(e) => {
                    eprintln!("wordstrobe: capture failed: {e}");
                    return;
                }
            }
        }
    };

    // The request goes out first; showing the popup (it may wait for the page and makes main-thread
    // round trips) runs next to the OCR instead of before it.
    let (result, ocr_ms) = std::thread::scope(|scope| {
        let ui = scope.spawn(|| open_reader(app));
        let started = Instant::now();
        let result = platform::ocr(app, &path);
        let ocr_ms = started.elapsed().as_millis();
        if source == "region" {
            let _ = fs::remove_file(&path); // always, also after an error
        }
        let _ = ui.join(); // `reader:status` and the show must be done before `reader:load`
        (result, ocr_ms)
    });

    // Esc while OCR was running: nobody is looking, and the next show starts with a new status event.
    let visible = app
        .get_webview_window("reader")
        .and_then(|reader| reader.is_visible().ok())
        .unwrap_or(false);
    if !visible {
        eprintln!("wordstrobe: reader closed during OCR ({ocr_ms} ms), dropping the result");
        return;
    }

    match result {
        Ok(mut payload) => {
            if let Some(object) = payload.as_object_mut() {
                object.remove("id");
                object.insert("source".into(), source.into());
            }
            let text = log_text(source, &payload);
            let total_ms = mouse_up.elapsed().as_millis();
            emit(app, "reader:load", payload);
            eprintln!(
                "wordstrobe: ocr {ocr_ms} ms, mouse-up→reader:load {total_ms} ms, emitted reader:load{text}"
            );
        }
        Err(message) => {
            eprintln!("wordstrobe: ocr failed after {ocr_ms} ms: {message}");
            emit(
                app,
                "reader:status",
                json!({ "state": "error", "message": message }),
            );
        }
    }
}

/// Captured text is only logged for the test entry, never for real captures (PLAN §15).
#[cfg(debug_assertions)]
fn log_text(source: &str, payload: &Value) -> String {
    if source == "file" {
        format!(": {payload}")
    } else {
        String::new()
    }
}

#[cfg(not(debug_assertions))]
fn log_text(_source: &str, _payload: &Value) -> String {
    String::new()
}

/// `$TMPDIR/wordstrobe` must be a real directory of ours that nobody else can enter. `create` alone
/// is not enough: when the path already exists it keeps its owner and mode, and a symlink is followed.
fn private_dir(dir: &Path) -> Result<(), String> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let meta =
        fs::symlink_metadata(dir).map_err(|e| format!("cannot inspect {}: {e}", dir.display()))?;
    // SAFETY: no arguments, cannot fail.
    check_private(dir, &meta, unsafe { libc::geteuid() })
}

fn check_private(dir: &Path, meta: &fs::Metadata, uid: u32) -> Result<(), String> {
    let shown = dir.display();
    if !meta.file_type().is_dir() {
        Err(format!(
            "{shown} is not a real directory (a symlink or file?)"
        ))
    } else if meta.uid() != uid {
        Err(format!("{shown} belongs to another user"))
    } else if meta.mode() & 0o077 != 0 {
        Err(format!(
            "{shown} is accessible to others (mode {:o})",
            meta.mode() & 0o7777
        ))
    } else {
        Ok(())
    }
}

/// `Ok(None)` = cancelled. Otherwise the PNG and the moment of the mouse-up.
fn capture() -> Result<Option<(PathBuf, Instant)>, String> {
    let dir = capture_dir();
    private_dir(&dir)?;
    let path = dir.join(format!("{}.png", COUNTER.fetch_add(1, Ordering::Relaxed)));
    if !platform::capture_region(&path)? {
        return Ok(None);
    }
    let (now, wall) = (Instant::now(), SystemTime::now());
    // screencapture only touches the file once the selection is made, so its birth time stands in for
    // the mouse-up (the crosshair time must not count) and its mtime for "PNG on disk". Unverifiable
    // from here; if birth→mtime shows up in seconds, screencapture creates the file earlier.
    let times = fs::metadata(&path)
        .ok()
        .and_then(|m| Some((m.created().ok()?, m.modified().ok()?)));
    let Some((born, written)) = times else {
        return Ok(Some((path, now)));
    };
    let ago = |t: SystemTime| wall.duration_since(t).unwrap_or_default();
    eprintln!(
        "wordstrobe: capture: mouse-up→png {} ms, png on disk {} ms ago",
        written.duration_since(born).unwrap_or_default().as_millis(),
        ago(written).as_millis()
    );
    Ok(Some((path, now.checked_sub(ago(born)).unwrap_or(now))))
}

fn emit(app: &AppHandle, event: &str, payload: Value) {
    // `emit_to` with a label reaches listeners registered via `getCurrentWebviewWindow().listen`.
    let _ = app.emit_to("reader", event, payload);
}

/// Announces the OCR to the reader (which resets itself on that status) and then shows it. The
/// status always comes first, so a show never exposes the previous text.
fn open_reader(app: &AppHandle) {
    let Some(reader) = app.get_webview_window("reader") else {
        return;
    };
    // Right after launch the hidden page may not have its listeners yet, and events sent before are lost.
    if !wait_reader_ready(Duration::from_secs(3)) {
        eprintln!("wordstrobe: reader did not report ready within 3 s, showing it anyway");
    }
    emit(app, "reader:status", json!({ "state": "ocr" }));
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

/// `--read-image <path>` (relative paths resolve against the launching shell's cwd). Debug builds
/// only: in a release build any same-user process could otherwise make the app OCR and display an
/// arbitrary readable file, directly or through the single-instance socket.
#[cfg(debug_assertions)]
fn read_image_arg(args: &[String], cwd: &Path) -> Option<PathBuf> {
    let i = args.iter().position(|a| a == "--read-image")?;
    Some(cwd.join(args.get(i + 1)?))
}

/// A second launch forwards its arguments to the running instance.
#[cfg_attr(not(debug_assertions), allow(unused_variables))]
fn second_launch(app: &AppHandle, argv: &[String], cwd: &str) {
    #[cfg(debug_assertions)]
    if let Some(path) = read_image_arg(argv, Path::new(cwd)) {
        return start_read(app, Some(path));
    }
    show_window(app, "settings");
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

/// Invoked by the reader page once its `reader:*` listeners are registered (see `src/reader.ts`).
#[tauri::command]
fn reader_ready(window: WebviewWindow) {
    if window.label() == "reader" {
        eprintln!("wordstrobe: reader listeners registered");
        set_reader_ready(true);
    }
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

/// "Alt+Shift+R" as shown in macOS menus: ⌃⌥⇧⌘ in that order, then the key.
fn shortcut_label(shortcut: &Shortcut) -> String {
    let mut label: String = [
        (Modifiers::CONTROL, '⌃'),
        (Modifiers::ALT, '⌥'),
        (Modifiers::SHIFT, '⇧'),
        (Modifiers::SUPER, '⌘'),
    ]
    .iter()
    .filter(|(modifier, _)| shortcut.mods.contains(*modifier))
    .map(|&(_, glyph)| glyph)
    .collect();
    let key = shortcut.key.to_string(); // "KeyR", "Digit1", "Space", "F5", ...
    label.push_str(
        key.strip_prefix("Key")
            .or_else(|| key.strip_prefix("Digit"))
            .unwrap_or(&key),
    );
    label
}

fn hotkey_setting(app: &AppHandle) -> String {
    setting(app, "hotkeyRegion").unwrap_or_else(|| DEFAULT_HOTKEY.into())
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    // Built once at startup, like the registration: a hotkey changed in Settings applies after a relaunch.
    let read = match hotkey_setting(app).parse::<Shortcut>() {
        Ok(shortcut) => format!("Read Region  {}", shortcut_label(&shortcut)),
        Err(_) => "Read Region".into(),
    };
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "read", read, true, None::<&str>)?,
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
    let key = hotkey_setting(app);
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
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            second_launch(app, &argv, &cwd)
        }))
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
        // A (re)loading reader page has no listeners yet; it reports back through `reader_ready`.
        .on_page_load(|webview, payload| {
            if webview.label() == "reader"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                set_reader_ready(false);
            }
        })
        .invoke_handler(tauri::generate_handler![
            permission_status,
            request_permission,
            open_privacy_settings,
            relaunch,
            reader_ready,
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

            if let Some(reader) = handle.get_webview_window("reader") {
                if let Some((w, h)) = saved_reader_size(handle) {
                    let _ = reader.set_size(LogicalSize::new(w, h));
                }
                platform::show_over_fullscreen(&reader);
                remember_reader_size(handle, &reader);
            }

            app.manage(platform::Ocr::default());
            platform::start_helper(handle);
            build_tray(handle)?;
            register_hotkey(handle);

            #[cfg(debug_assertions)]
            {
                let args: Vec<String> = std::env::args().collect();
                let cwd = std::env::current_dir().unwrap_or_default();
                if let Some(path) = read_image_arg(&args, &cwd) {
                    start_read(handle, Some(path));
                    return Ok(());
                }
            }
            if !platform::has_capture_permission() {
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

    // This Mac, as Tauri reports it at runtime: the built-in 1800×1169 pt display (scale 2, 39 pt menu
    // bar) with two 1920×1080 displays (scale 1, 30 pt menu bar) to its right at x = 1800 and
    // x = 3720, all three top-aligned at y = 0. Positions/sizes are physical px of each display's own scale.
    fn builtin() -> Screen {
        Screen {
            position: (0, 0),
            size: (3600, 2338),
            scale: 2.0,
            work_position: (0, 78),
            work_size: (3600, 2260),
        }
    }

    fn external(x: i32) -> Screen {
        Screen {
            position: (x, 0),
            size: (1920, 1080),
            scale: 1.0,
            work_position: (x, 30),
            work_size: (1920, 1050),
        }
    }

    /// Where `locate` puts a cursor that is at `points` (global, top-left origin). tao reports
    /// that in physical px of the primary display, which is points × 2 here.
    fn locate_here(points: (f64, f64)) -> ((f64, f64), Rect) {
        let screens = [builtin(), external(1800), external(3720)];
        locate(
            (points.0 * 2.0, points.1 * 2.0),
            Some(&screens[0]),
            &screens,
        )
        .unwrap()
    }

    const BUILTIN_AREA: Rect = (0.0, 39.0, 1800.0, 1130.0);
    const LEFT_AREA: Rect = (1800.0, 30.0, 1920.0, 1050.0);
    const RIGHT_AREA: Rect = (3720.0, 30.0, 1920.0, 1050.0);

    #[test]
    fn cursor_on_the_builtin_display() {
        assert_eq!(locate_here((900.0, 600.0)), ((900.0, 600.0), BUILTIN_AREA));
    }

    #[test]
    fn cursor_on_an_external_display_next_to_a_retina_primary() {
        // A real sample: the cursor was at (2610.28, 850.39) pt, on the first external display.
        // Compared in raw physical px (5220, 1700) it would not even be on any display but the third.
        let (cursor, area) = locate_here((2610.28125, 850.390625));
        assert_eq!(cursor, (2610.28125, 850.390625));
        assert_eq!(area, LEFT_AREA);
        assert_eq!(
            place(cursor, SIZE, area),
            (2610.28125 - 260.0, 850.390625 + 24.0)
        );
        assert_eq!(locate_here((4000.0, 100.0)).1, RIGHT_AREA);
    }

    #[test]
    fn display_seams_belong_to_the_right_hand_display() {
        assert_eq!(locate_here((1799.5, 500.0)).1, BUILTIN_AREA);
        assert_eq!(locate_here((1800.0, 500.0)).1, LEFT_AREA);
        assert_eq!(locate_here((3719.5, 500.0)).1, LEFT_AREA);
        assert_eq!(locate_here((3720.0, 500.0)).1, RIGHT_AREA);
    }

    #[test]
    fn cursor_outside_every_display_falls_back_to_the_primary() {
        // Below the external displays (they end at y = 1080) and left of the built-in one.
        assert_eq!(locate_here((2000.0, 1100.0)).1, BUILTIN_AREA);
        assert_eq!(locate_here((-50.0, 100.0)).1, BUILTIN_AREA);
    }

    #[test]
    fn without_a_primary_the_first_display_is_used_and_without_displays_there_is_no_answer() {
        let screens = [external(1800), external(3720)];
        assert_eq!(locate((10.0, 10.0), None, &screens).unwrap().1, LEFT_AREA);
        assert!(locate((10.0, 10.0), None, &[]).is_none());
    }

    #[test]
    fn popup_near_the_bottom_of_an_external_display_flips_above_the_cursor() {
        let (cursor, area) = locate_here((4000.0, 1050.0));
        assert_eq!(place(cursor, SIZE, area), (3740.0, 1050.0 - 24.0 - 190.0));
    }

    #[test]
    fn center_mode_centers_in_the_work_area_of_the_cursor_display() {
        let (cursor, area) = locate_here((900.0, 600.0));
        assert_eq!(
            position_in("center", cursor, SIZE, area),
            (640.0, 39.0 + (1130.0 - 190.0) / 2.0)
        );
        assert_eq!(
            position_in("cursor", cursor, SIZE, area),
            place(cursor, SIZE, area)
        );
    }

    #[test]
    fn remembered_sizes_are_clamped_and_rounded() {
        assert_eq!(clamp_size(600.4, 250.6), Some((600.0, 251.0)));
        assert_eq!(clamp_size(10.0, 10.0), Some(READER_MIN));
        assert_eq!(clamp_size(1e9, 1e9), Some(READER_MAX));
        assert_eq!(clamp_size(f64::NAN, 200.0), None);
        assert_eq!(clamp_size(400.0, f64::INFINITY), None);
    }

    fn label(shortcut: &str) -> String {
        shortcut_label(&shortcut.parse().unwrap())
    }

    #[test]
    fn tray_label_shows_the_configured_hotkey() {
        assert_eq!(label(DEFAULT_HOTKEY), "⌥⇧R");
        assert_eq!(label("Cmd+Ctrl+Space"), "⌃⌘Space");
        assert_eq!(label("CmdOrCtrl+Shift+Digit1"), "⇧⌘1");
        assert_eq!(label("Ctrl+Alt+Shift+Cmd+F5"), "⌃⌥⇧⌘F5");
        assert_eq!(label("F5"), "F5");
    }

    /// A fresh path in the temp dir, removed again at the end of the test that asked for it.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Scratch {
            let path =
                std::env::temp_dir().join(format!("wordstrobe-test-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            let _ = fs::remove_file(&path);
            Scratch(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
            let _ = fs::remove_file(&self.0);
        }
    }

    #[test]
    fn capture_dir_is_created_private_and_accepted_again() {
        let dir = Scratch::new("fresh");
        assert_eq!(private_dir(&dir.0), Ok(()));
        assert_eq!(fs::metadata(&dir.0).unwrap().mode() & 0o777, 0o700);
        assert_eq!(private_dir(&dir.0), Ok(()));
    }

    #[test]
    fn capture_dir_that_others_can_enter_is_refused() {
        let dir = Scratch::new("loose");
        fs::create_dir(&dir.0).unwrap();
        fs::set_permissions(&dir.0, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        assert!(private_dir(&dir.0)
            .unwrap_err()
            .contains("accessible to others"));
    }

    #[test]
    fn capture_dir_that_is_a_symlink_is_refused() {
        let (target, link) = (Scratch::new("target"), Scratch::new("link"));
        private_dir(&target.0).unwrap();
        std::os::unix::fs::symlink(&target.0, &link.0).unwrap();
        assert!(private_dir(&link.0)
            .unwrap_err()
            .contains("not a real directory"));
    }

    #[test]
    fn capture_dir_of_another_user_is_refused() {
        let dir = Scratch::new("foreign");
        private_dir(&dir.0).unwrap();
        let meta = fs::symlink_metadata(&dir.0).unwrap();
        assert!(check_private(&dir.0, &meta, meta.uid() + 1)
            .unwrap_err()
            .contains("another user"));
    }
}
