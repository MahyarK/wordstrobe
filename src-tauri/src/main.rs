// A release build on Windows is a GUI program: without this the NSIS-installed exe opens a console
// window on every launch, and closing that window kills the app. Debug builds keep the console, which
// is where the CI end-to-end run reads stderr.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Wordstrobe: tray, global hotkey and the read flow (PLAN §3, §4). All OS-specific work sits
//! behind the platform seam: one file per OS in `platform/`, selected below, exporting exactly these
//! free functions. There is no trait because a build never has more than one implementation.
//!
//! ```ignore
//! pub fn setup(app: &AppHandle);                 // manage state, start helpers (macOS: the OCR helper)
//! pub fn has_capture_permission() -> bool;       // Windows/Linux: true
//! pub fn request_capture_permission() -> bool;   // Windows/Linux: true
//! pub fn open_privacy_settings();                // Windows/Linux: no-op
//! /// Lets the user drag a region and writes a PNG of it to `path`. `Ok(false)` = cancelled.
//! /// Blocking: runs on the worker thread of the read flow, never on the main thread.
//! pub fn capture_region(app: &AppHandle, path: &Path) -> Result<bool, String>;
//! pub fn show_over_fullscreen(window: &WebviewWindow); // keep the popup above full-screen apps (Windows/Linux: no-op)
//! /// OCR of the PNG at `path`: `{ paragraphs?: [..], lines?: [..], lang, ms }` (PLAN §3). Blocking, worker thread.
//! pub fn ocr(app: &AppHandle, path: &Path) -> Result<serde_json::Value, String>;
//! pub fn is_wayland() -> bool;                   // false except in Linux Wayland sessions
//! ```
//!
//! Windows and Linux X11 capture with the freeze-frame overlay (`overlay.rs`, from `capture_region`);
//! macOS uses the system's `screencapture -i`.
#[cfg_attr(target_os = "macos", path = "platform/macos.rs")]
#[cfg_attr(windows, path = "platform/windows.rs")]
#[cfg_attr(target_os = "linux", path = "platform/linux.rs")]
mod platform;

#[cfg(not(target_os = "macos"))]
mod overlay;
// Joining the words of an OCR line (Windows and Linux); also built for tests, so they run on macOS.
#[cfg(any(test, not(target_os = "macos")))]
mod words;
// The overlay's pure geometry builds everywhere, so its tests also run on macOS.
#[cfg(any(test, not(target_os = "macos")))]
mod region;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Condvar, Mutex,
    },
    time::{Duration, Instant, SystemTime},
};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt};

use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Monitor, PhysicalPosition, Position,
    WebviewWindow, WindowEvent,
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

/// A monitor as Tauri reports it, physical px. On Windows and Linux X11 they are px of the virtual
/// desktop, comparable between monitors. On macOS they are points × this monitor's *own* scale, so on
/// mixed-DPI setups they are not comparable between monitors until divided by it.
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

    /// The whole monitor, in global points (macOS).
    fn frame(&self) -> Rect {
        self.points(self.position, self.size)
    }

    /// Below the menu bar and beside the Dock, in global points (macOS).
    fn work_area(&self) -> Rect {
        self.points(self.work_position, self.work_size)
    }

    /// Whether `point` (physical px of the virtual desktop) is on this monitor.
    fn contains_px(&self, (x, y): (f64, f64)) -> bool {
        let span = |start: i32, len: u32| f64::from(start)..f64::from(start) + f64::from(len);
        span(self.position.0, self.size.0).contains(&x)
            && span(self.position.1, self.size.1).contains(&y)
    }
}

/// macOS: the cursor in global points and the work area (also points) of the screen it is on.
/// `cursor_px` is what tao reports there: physical px of the *primary* screen, so its scale gives
/// points that compare with every screen's frame (also with other scales). Outside every screen it
/// is the primary one, or else the first.
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

/// Windows and Linux X11: tao reports the cursor and every monitor in physical px of the virtual
/// desktop, and each monitor has its own scale. So the monitor under the cursor is found in physical
/// px, the popup is placed in that monitor's own logical space (`size` is logical), and the result is
/// converted back to physical px of the desktop, which is what `set_position(Physical)` takes. Outside
/// every monitor it is the primary one, or else the first.
fn desktop_position(
    mode: &str,
    cursor_px: (f64, f64),
    size: (f64, f64),
    primary: Option<&Screen>,
    screens: &[Screen],
) -> Option<(i32, i32)> {
    let screen = screens
        .iter()
        .find(|s| s.contains_px(cursor_px))
        .or(primary)
        .or(screens.first())?;
    let (ox, oy) = (f64::from(screen.position.0), f64::from(screen.position.1));
    let scale = screen.scale;
    // Physical px of the desktop -> logical px from this monitor's top-left corner.
    let logical = |(x, y): (f64, f64)| ((x - ox) / scale, (y - oy) / scale);
    let (wx, wy) = logical((
        f64::from(screen.work_position.0),
        f64::from(screen.work_position.1),
    ));
    let area = (
        wx,
        wy,
        f64::from(screen.work_size.0) / scale,
        f64::from(screen.work_size.1) / scale,
    );
    let (x, y) = position_in(mode, logical(cursor_px), size, area);
    Some((
        (ox + x * scale).round() as i32,
        (oy + y * scale).round() as i32,
    ))
}

/// Where the reader goes, or `None` to leave it where it is: logical points on macOS (the global
/// points model), physical desktop px elsewhere (see `desktop_position`).
fn reader_position(app: &AppHandle, reader: &WebviewWindow) -> Option<Position> {
    let mode = setting(app, "placement").unwrap_or_else(|| "cursor".into());
    if mode == "last" {
        return None;
    }
    // The *current* size: the user may have resized the popup, or restored a remembered size.
    let size = reader
        .outer_size()
        .ok()?
        .to_logical::<f64>(reader.scale_factor().ok()?);
    let size = (size.width, size.height);
    let cursor = app.cursor_position().ok()?;
    let cursor = (cursor.x, cursor.y);
    let primary = app.primary_monitor().ok()?.map(|m| Screen::new(&m));
    let screens: Vec<Screen> = app
        .available_monitors()
        .ok()?
        .iter()
        .map(Screen::new)
        .collect();
    if cfg!(target_os = "macos") {
        let (cursor, area) = locate(cursor, primary.as_ref(), &screens)?;
        let (x, y) = position_in(&mode, cursor, size, area);
        Some(LogicalPosition::new(x, y).into())
    } else {
        let (x, y) = desktop_position(&mode, cursor, size, primary.as_ref(), &screens)?;
        Some(PhysicalPosition::new(x, y).into())
    }
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

/// Where captures live, always inside a directory only this user can enter (see `private_dir`).
/// macOS: `$TMPDIR` is per user already. Windows: so is `%TEMP%`.
#[cfg(not(target_os = "linux"))]
fn capture_dir() -> PathBuf {
    std::env::temp_dir().join("wordstrobe")
}

/// Linux: `/tmp` is shared, and another user who creates `/tmp/wordstrobe` first would make
/// `private_dir` refuse it for good. So it is `$XDG_RUNTIME_DIR` (per user, mode 0700 by the XDG
/// spec) or else a directory named after the uid.
#[cfg(target_os = "linux")]
fn capture_dir() -> PathBuf {
    // SAFETY: no arguments, cannot fail.
    let uid = unsafe { libc::geteuid() };
    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
    linux_capture_dir(runtime_dir, &std::env::temp_dir(), uid)
}

/// The spec requires `$XDG_RUNTIME_DIR` to be absolute; anything else (unset, empty, relative) is ignored.
#[cfg(any(test, target_os = "linux"))]
fn linux_capture_dir(runtime_dir: Option<PathBuf>, tmp: &Path, uid: u32) -> PathBuf {
    match runtime_dir.filter(|dir| dir.is_absolute()) {
        Some(dir) => dir.join("wordstrobe"),
        None => tmp.join(format!("wordstrobe-{uid}")),
    }
}

/// `file`: the `--read-image` test entry (debug builds only), which skips the capture and leaves the file alone.
/// `None` = the user's capture: the hotkey, the tray item or `--read-region`.
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
                eprintln!("wordstrobe: no permission to capture the screen, opening Settings");
                show_window(app, "settings");
                return;
            }
            match capture(app) {
                Ok(Some((path, mouse_up))) => (path, "region", mouse_up),
                Ok(None) => return, // Esc: cancelled, stay silent
                Err(e) => {
                    // stderr is invisible in an installed app: the user sees this like an OCR error.
                    eprintln!("wordstrobe: capture failed: {e}");
                    open_reader(app, json!({ "state": "error", "message": e }));
                    return;
                }
            }
        }
    };

    // The request goes out first; showing the popup (it may wait for the page and makes main-thread
    // round trips) runs next to the OCR instead of before it.
    let (result, ocr_ms) = std::thread::scope(|scope| {
        let ui = scope.spawn(|| open_reader(app, json!({ "state": "ocr" })));
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

/// The capture directory must be a real directory of ours that nobody else can enter. `create` alone
/// is not enough: when the path already exists it keeps its owner and mode, and a symlink is followed.
#[cfg(unix)]
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

#[cfg(unix)]
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

/// Windows: `%TEMP%` is per user and only that user (and SYSTEM) can enter it, so there is nothing to check.
#[cfg(not(unix))]
fn private_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))
}

/// `Ok(None)` = cancelled. Otherwise the PNG and the moment of the mouse-up.
fn capture(app: &AppHandle) -> Result<Option<(PathBuf, Instant)>, String> {
    let dir = capture_dir();
    private_dir(&dir)?;
    let path = dir.join(format!("{}.png", COUNTER.fetch_add(1, Ordering::Relaxed)));
    if !platform::capture_region(app, &path)? {
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

/// Announces `status` (`reader:status`: `ocr` while reading, or `error` with its message) to the
/// reader, which resets itself on any status, and then shows it. The status always comes first, so a
/// show never exposes the previous text.
fn open_reader(app: &AppHandle, status: Value) {
    let Some(reader) = app.get_webview_window("reader") else {
        return;
    };
    // Right after launch the hidden page may not have its listeners yet, and events sent before are lost.
    if !wait_reader_ready(Duration::from_secs(3)) {
        eprintln!("wordstrobe: reader did not report ready within 3 s, showing it anyway");
    }
    emit(app, "reader:status", status);
    if let Some(position) = reader_position(app, &reader) {
        let _ = reader.set_position(position);
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

/// `--read-region`: start the read flow as if the hotkey was pressed. On Wayland, where no app can
/// grab a global hotkey, this is what the user binds a desktop shortcut to. Same effect as the
/// hotkey, so it is safe to accept in release builds (unlike `--read-image`).
fn read_region_arg(args: &[String]) -> bool {
    args.iter().any(|a| a == "--read-region")
}

/// A second launch forwards its arguments to the running instance.
#[cfg_attr(not(debug_assertions), allow(unused_variables))]
fn second_launch(app: &AppHandle, argv: &[String], cwd: &str) {
    #[cfg(debug_assertions)]
    if let Some(path) = read_image_arg(argv, Path::new(cwd)) {
        return start_read(app, Some(path));
    }
    if read_region_arg(argv) {
        return start_read(app, None);
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

/// What the UI needs to know about the OS:
/// `{ os: "macos" | "windows" | "linux", wayland, hotkey: { ok, label }, command }`.
/// `ok`: whether the hotkey configured at launch is registered (the tray shows the same `label`).
/// `command`: what a desktop shortcut must run to start a capture (see `shortcut_command`).
#[tauri::command]
fn platform_info(app: AppHandle) -> Value {
    json!({
        "os": std::env::consts::OS,
        "wayland": platform::is_wayland(),
        "hotkey": { "ok": HOTKEY_OK.load(Ordering::Acquire), "label": hotkey_label(&app) },
        "command": read_region_command(),
    })
}

/// The command a desktop shortcut runs (on Wayland, where no app can grab a hotkey): this program
/// with `--read-region`. A running instance takes the capture over, see `second_launch`.
fn read_region_command() -> String {
    // Inside an AppImage `current_exe` is a temporary mount that is gone after the next start; the
    // file the user runs is `$APPIMAGE`.
    let appimage = std::env::var("APPIMAGE").ok().filter(|_| cfg!(target_os = "linux"));
    let exe = std::env::current_exe().ok();
    shortcut_command(appimage.as_deref(), exe.as_deref().and_then(Path::to_str))
}

fn shortcut_command(appimage: Option<&str>, exe: Option<&str>) -> String {
    let program = appimage
        .filter(|path| !path.is_empty())
        .or(exe)
        .unwrap_or("wordstrobe");
    // Shortcut dialogs split the command at spaces.
    if program.contains(char::is_whitespace) {
        format!("\"{program}\" --read-region")
    } else {
        format!("{program} --read-region")
    }
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

/// "Alt+Shift+R" as shown to the user. On macOS that is ⌃⌥⇧⌘ in the order of its menus, then the
/// key; elsewhere the usual "Ctrl+Alt+Shift+Win+R" (`os` is `std::env::consts::OS`).
fn shortcut_label(shortcut: &Shortcut, os: &str) -> String {
    let held = [
        (Modifiers::CONTROL, "Ctrl", "⌃"),
        (Modifiers::ALT, "Alt", "⌥"),
        (Modifiers::SHIFT, "Shift", "⇧"),
        (Modifiers::SUPER, if os == "windows" { "Win" } else { "Super" }, "⌘"),
    ]
    .into_iter()
    .filter(|&(modifier, ..)| shortcut.mods.contains(modifier));
    let key = shortcut.key.to_string(); // "KeyR", "Digit1", "Space", "F5", ...
    let key = key
        .strip_prefix("Key")
        .or_else(|| key.strip_prefix("Digit"))
        .unwrap_or(&key);
    if os == "macos" {
        held.map(|(.., glyph)| glyph).chain([key]).collect()
    } else {
        held.map(|(_, name, _)| name).chain([key]).collect::<Vec<_>>().join("+")
    }
}

fn hotkey_setting(app: &AppHandle) -> String {
    setting(app, "hotkeyRegion").unwrap_or_else(|| DEFAULT_HOTKEY.into())
}

/// The configured hotkey for display; the raw setting when it is not a valid shortcut.
fn hotkey_label(app: &AppHandle) -> String {
    let key = hotkey_setting(app);
    match key.parse::<Shortcut>() {
        Ok(shortcut) => shortcut_label(&shortcut, std::env::consts::OS),
        Err(_) => key,
    }
}

static HOTKEY_OK: AtomicBool = AtomicBool::new(false);

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    // Built once at startup, like the registration: a hotkey changed in Settings applies after a relaunch.
    let read = if HOTKEY_OK.load(Ordering::Acquire) {
        format!("Read Region  {}", hotkey_label(app))
    } else {
        "Read Region".into()
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
    // tray.png is a black template image that macOS recolors for the menu bar; on a dark Windows or
    // Linux panel it would be invisible, so there the (colored) app icon is used.
    let icon = match app.default_window_icon() {
        Some(icon) if !cfg!(target_os = "macos") => icon.clone(),
        _ => tauri::include_image!("icons/tray.png"),
    };
    TrayIconBuilder::new()
        .icon(icon)
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
    // No app can grab a global hotkey on Wayland (an X11 grab through XWayland only sees keys while an
    // X11 window has the focus), so it is not tried: the user binds `--read-region` to a desktop shortcut.
    if platform::is_wayland() {
        eprintln!("wordstrobe: no global hotkey on Wayland, bind a desktop shortcut to `wordstrobe --read-region`");
        return;
    }
    let result = key
        .parse::<Shortcut>()
        .map_err(|e| e.to_string())
        .and_then(|shortcut| {
            app.global_shortcut()
                .register(shortcut)
                .map_err(|e| e.to_string())
        });
    match result {
        Ok(()) => HOTKEY_OK.store(true, Ordering::Release),
        Err(e) => {
            eprintln!("wordstrobe: cannot register hotkey {key:?}: {e}");
            show_window(app, "settings");
        }
    }
}

fn main() {
    let builder = tauri::Builder::default()
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
            platform_info,
            relaunch,
            reader_ready,
            close_reader,
            open_settings,
            #[cfg(not(target_os = "macos"))]
            overlay::overlay_ready,
            #[cfg(not(target_os = "macos"))]
            overlay::overlay_select,
        ]);
    // The frozen frames of the region overlay are served from memory (see overlay.rs).
    #[cfg(not(target_os = "macos"))]
    let builder = builder.register_asynchronous_uri_scheme_protocol(overlay::SCHEME, overlay::protocol);
    builder
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

            #[cfg(not(target_os = "macos"))]
            app.manage(overlay::Overlay::default());
            platform::setup(handle);
            register_hotkey(handle); // before the tray, which shows the hotkey only when it works
            build_tray(handle)?;

            let args: Vec<String> = std::env::args().collect();
            #[cfg(debug_assertions)]
            {
                let cwd = std::env::current_dir().unwrap_or_default();
                if let Some(path) = read_image_arg(&args, &cwd) {
                    start_read(handle, Some(path));
                    return Ok(());
                }
            }
            if read_region_arg(&args) {
                start_read(handle, None);
                return Ok(());
            }
            if !platform::has_capture_permission() {
                show_window(handle, "settings"); // first run (PLAN §8)
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Wordstrobe")
        .run(|app, event| {
            // `open`/Finder on the running app sends a reopen event, not a second launch.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_window(app, "settings");
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
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

    // A 150 % laptop (2880×1800 px, 60 px taskbar) with a 100 % external monitor to its right
    // (1920×1080, 40 px taskbar), as tao reports them on Windows: physical px of the virtual desktop.
    // The cursor at (3500, 500) is on the external monitor; the macOS math (divide by the primary's
    // scale) would turn it into (2333, 333), which is on no monitor at all.
    fn laptop() -> Screen {
        Screen {
            position: (0, 0),
            size: (2880, 1800),
            scale: 1.5,
            work_position: (0, 0),
            work_size: (2880, 1740),
        }
    }

    fn external_right() -> Screen {
        Screen {
            position: (2880, 0),
            size: (1920, 1080),
            scale: 1.0,
            work_position: (2880, 0),
            work_size: (1920, 1040),
        }
    }

    /// 1920×1080 at 100 % to the left of the laptop, lower than it.
    fn external_left() -> Screen {
        Screen {
            position: (-1920, 120),
            size: (1920, 1080),
            scale: 1.0,
            work_position: (-1920, 120),
            work_size: (1920, 1040),
        }
    }

    /// 2560×1440 at 125 % to the left of the laptop and higher than it (negative y as well).
    fn external_left_125() -> Screen {
        Screen {
            position: (-2560, -200),
            size: (2560, 1440),
            scale: 1.25,
            work_position: (-2560, -200),
            work_size: (2560, 1400),
        }
    }

    fn on_desktop(mode: &str, cursor: (f64, f64), screens: &[Screen]) -> Option<(i32, i32)> {
        desktop_position(mode, cursor, SIZE, screens.first(), screens)
    }

    #[test]
    fn windows_cursor_on_a_100_percent_monitor_next_to_a_150_percent_primary() {
        let screens = [laptop(), external_right()];
        // 620 × 500 logical px into the external monitor: x centered (360), y 24 below the cursor.
        assert_eq!(on_desktop("cursor", (3500.0, 500.0), &screens), Some((2880 + 360, 524)));
        // Near its bottom edge the popup flips above the cursor, in that monitor's own px.
        assert_eq!(on_desktop("cursor", (3500.0, 1030.0), &screens), Some((3240, 1030 - 24 - 190)));
        // Clamped by the monitor's right edge (4800 - 520 - 8), not the laptop's scale.
        assert_eq!(on_desktop("cursor", (4790.0, 500.0), &screens), Some((4800 - 520 - 8, 524)));
    }

    #[test]
    fn windows_cursor_on_the_150_percent_primary_places_in_its_logical_space() {
        // 1000 × 600 logical px in: x 740, y 624 logical = (1110, 936) physical.
        assert_eq!(
            on_desktop("cursor", (1500.0, 900.0), &[laptop(), external_right()]),
            Some((1110, 936))
        );
    }

    #[test]
    fn windows_monitors_left_of_the_primary_have_negative_origins() {
        let screens = [laptop(), external_left()];
        // 920 × 180 logical px into the left monitor (at y = 120): x 660, y 204.
        assert_eq!(on_desktop("cursor", (-1000.0, 300.0), &screens), Some((-1920 + 660, 120 + 204)));
        // 125 %: the cursor is 1968 × 240 logical px in; x is clamped (2048 - 520 - 8 = 1520),
        // y is 24 below the cursor (264); both go back through the 1.25 scale.
        assert_eq!(
            on_desktop("cursor", (-100.0, 100.0), &[laptop(), external_left_125()]),
            Some((-2560 + 1900, -200 + 330))
        );
    }

    #[test]
    fn windows_center_mode_centers_in_the_work_area_of_the_cursor_monitor() {
        let screens = [laptop(), external_right()];
        // (1920 - 520) / 2 = 700, (1040 - 190) / 2 = 425
        assert_eq!(on_desktop("center", (3500.0, 500.0), &screens), Some((2880 + 700, 425)));
        // The laptop: (1920 - 520) / 2 = 700 and (1160 - 190) / 2 = 485 logical px, at 1.5.
        assert_eq!(on_desktop("center", (100.0, 100.0), &screens), Some((1050, 728)));
    }

    #[test]
    fn windows_monitor_seams_belong_to_the_right_hand_monitor() {
        let (laptop, external) = (laptop(), external_right());
        assert!(laptop.contains_px((2879.5, 500.0)) && !external.contains_px((2879.5, 500.0)));
        assert!(!laptop.contains_px((2880.0, 500.0)) && external.contains_px((2880.0, 500.0)));
        assert!(external.contains_px((4799.5, 1079.5)) && !external.contains_px((4800.0, 500.0)));
        assert!(!external.contains_px((3000.0, 1080.0)));
    }

    #[test]
    fn windows_cursor_outside_every_monitor_falls_back_to_the_primary() {
        // Below the external monitor (it ends at y = 1080) and right of the laptop: 2000 × 1000 logical
        // px on the laptop, so x is clamped to 1392 and y flips above the cursor (786).
        let screens = [laptop(), external_right()];
        assert_eq!(on_desktop("cursor", (3000.0, 1500.0), &screens), Some((2088, 1179)));
    }

    #[test]
    fn without_a_primary_the_first_monitor_is_used_and_without_monitors_there_is_no_answer() {
        let screens = [external_right(), laptop()];
        let first = desktop_position("cursor", (-5.0, -5.0), SIZE, None, &screens);
        assert_eq!(first, Some((2880 + 8, 19))); // x held back by the margin, y 24 below the cursor
        assert_eq!(desktop_position("cursor", (5.0, 5.0), SIZE, None, &[]), None);
    }

    #[cfg(unix)] // Unix path semantics: on Windows "/run/user/1000" isn't absolute
    #[test]
    fn linux_captures_go_to_the_per_user_runtime_dir() {
        let tmp = Path::new("/tmp");
        let dir = |runtime: Option<&str>| linux_capture_dir(runtime.map(PathBuf::from), tmp, 1000);
        assert_eq!(dir(Some("/run/user/1000")), Path::new("/run/user/1000/wordstrobe"));
        // Unset, empty or relative: the shared temp dir, but under a name that only this user shares.
        assert_eq!(dir(None), Path::new("/tmp/wordstrobe-1000"));
        assert_eq!(dir(Some("")), Path::new("/tmp/wordstrobe-1000"));
        assert_eq!(dir(Some("run/user/1000")), Path::new("/tmp/wordstrobe-1000"));
    }

    #[test]
    fn the_shortcut_command_prefers_the_appimage_and_quotes_spaces() {
        let exe = Some("/usr/bin/wordstrobe");
        assert_eq!(shortcut_command(None, exe), "/usr/bin/wordstrobe --read-region");
        assert_eq!(
            shortcut_command(Some("/home/me/Apps/Wordstrobe.AppImage"), Some("/tmp/.mount_x/usr/bin/wordstrobe")),
            "/home/me/Apps/Wordstrobe.AppImage --read-region"
        );
        assert_eq!(shortcut_command(Some(""), exe), "/usr/bin/wordstrobe --read-region");
        assert_eq!(
            shortcut_command(None, Some(r"C:\Program Files\Wordstrobe\wordstrobe.exe")),
            r#""C:\Program Files\Wordstrobe\wordstrobe.exe" --read-region"#
        );
        assert_eq!(
            shortcut_command(Some("/home/me/My Apps/W.AppImage"), exe),
            r#""/home/me/My Apps/W.AppImage" --read-region"#
        );
        assert_eq!(shortcut_command(None, None), "wordstrobe --read-region");
    }

    #[test]
    fn remembered_sizes_are_clamped_and_rounded() {
        assert_eq!(clamp_size(600.4, 250.6), Some((600.0, 251.0)));
        assert_eq!(clamp_size(10.0, 10.0), Some(READER_MIN));
        assert_eq!(clamp_size(1e9, 1e9), Some(READER_MAX));
        assert_eq!(clamp_size(f64::NAN, 200.0), None);
        assert_eq!(clamp_size(400.0, f64::INFINITY), None);
    }

    fn label(shortcut: &str, os: &str) -> String {
        shortcut_label(&shortcut.parse().unwrap(), os)
    }

    #[test]
    fn tray_label_shows_the_configured_hotkey() {
        assert_eq!(label(DEFAULT_HOTKEY, "macos"), "⌥⇧R");
        assert_eq!(label("Cmd+Ctrl+Space", "macos"), "⌃⌘Space");
        assert_eq!(label("Ctrl+Alt+Shift+Cmd+F5", "macos"), "⌃⌥⇧⌘F5");
        assert_eq!(label("F5", "macos"), "F5");
    }

    #[test]
    fn other_systems_spell_the_modifiers_out() {
        assert_eq!(label(DEFAULT_HOTKEY, "windows"), "Alt+Shift+R");
        assert_eq!(label("Ctrl+Alt+Shift+R", "linux"), "Ctrl+Alt+Shift+R");
        assert_eq!(label("Cmd+Ctrl+Space", "windows"), "Ctrl+Win+Space");
        assert_eq!(label("Super+Digit1", "linux"), "Super+1");
        assert_eq!(label("F5", "linux"), "F5");
    }

    #[test]
    fn cmd_or_ctrl_is_the_command_key_on_macos_and_control_elsewhere() {
        let expected = if cfg!(target_os = "macos") { "⇧⌘1" } else { "Ctrl+Shift+1" };
        assert_eq!(label("CmdOrCtrl+Shift+Digit1", std::env::consts::OS), expected);
    }

    #[test]
    fn read_region_is_recognised_among_other_arguments() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(read_region_arg(&args(&["wordstrobe", "--read-region"])));
        assert!(!read_region_arg(&args(&["wordstrobe"])));
        assert!(!read_region_arg(&args(&["wordstrobe", "--read-regions", "read-region"])));
    }

    /// A fresh path in the temp dir, removed again at the end of the test that asked for it.
    #[cfg(unix)]
    struct Scratch(PathBuf);

    #[cfg(unix)]
    impl Scratch {
        fn new(name: &str) -> Scratch {
            let path =
                std::env::temp_dir().join(format!("wordstrobe-test-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            let _ = fs::remove_file(&path);
            Scratch(path)
        }
    }

    #[cfg(unix)]
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
            let _ = fs::remove_file(&self.0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn capture_dir_is_created_private_and_accepted_again() {
        let dir = Scratch::new("fresh");
        assert_eq!(private_dir(&dir.0), Ok(()));
        assert_eq!(fs::metadata(&dir.0).unwrap().mode() & 0o777, 0o700);
        assert_eq!(private_dir(&dir.0), Ok(()));
    }

    #[cfg(unix)]
    #[test]
    fn capture_dir_that_others_can_enter_is_refused() {
        let dir = Scratch::new("loose");
        fs::create_dir(&dir.0).unwrap();
        fs::set_permissions(&dir.0, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        assert!(private_dir(&dir.0)
            .unwrap_err()
            .contains("accessible to others"));
    }

    #[cfg(unix)]
    #[test]
    fn capture_dir_that_is_a_symlink_is_refused() {
        let (target, link) = (Scratch::new("target"), Scratch::new("link"));
        private_dir(&target.0).unwrap();
        std::os::unix::fs::symlink(&target.0, &link.0).unwrap();
        assert!(private_dir(&link.0)
            .unwrap_err()
            .contains("not a real directory"));
    }

    #[cfg(unix)]
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
