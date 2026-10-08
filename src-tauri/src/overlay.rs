//! The freeze-frame region overlay (PLAN §11 M6) for Windows and Linux X11; macOS keeps `screencapture -i`.
//!
//! `select_region` captures every monitor, opens one borderless window per monitor that shows its
//! frozen frame, and returns the part the user dragged over. The page (`src/overlay.ts`) fetches its
//! frame from the `overlay` URI scheme and reports back through `overlay_ready` / `overlay_select`.
//! Geometry and pixel work are in `region.rs`.

use std::{
    collections::HashSet,
    fs,
    io::BufWriter,
    path::Path,
    sync::{
        mpsc::{self, Receiver},
        Arc, Mutex, MutexGuard, PoisonError,
    },
    time::{Duration, Instant},
};

use tauri::{
    http::{header, Request, Response, StatusCode},
    window::Color,
    AppHandle, Manager, PhysicalPosition, PhysicalSize, State, UriSchemeContext, UriSchemeResponder,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry,
};
use xcap::{
    image::{
        codecs::png::{CompressionType, FilterType, PngEncoder},
        ExtendedColorType, ImageEncoder,
    },
    Monitor,
};

use crate::region::{self, Px, Selection};

/// The `overlay` URI scheme the frames are served from (also named in the CSP of `tauri.<os>.conf.json`).
pub const SCHEME: &str = "overlay";
/// How long the user has to drag before the overlay gives up.
const SELECT_TIMEOUT: Duration = Duration::from_secs(120);
/// How long the pages get to load their frame. A page that never reports back would otherwise hide
/// nothing and trap nobody, but the hotkey would stay busy until `SELECT_TIMEOUT`.
const READY_TIMEOUT: Duration = Duration::from_secs(10);
const LABEL: &str = "overlay-";

/// One monitor as it looked when the hotkey was pressed: a BMP (`region::rgba_to_bmp`), which is both
/// what the page displays and the original pixels the crop is taken from.
struct Frame {
    size: (u32, u32),
    bmp: Vec<u8>,
}

enum Event {
    /// The page of this monitor has its frame decoded.
    Ready(usize),
    /// A selection, or `None` = cancelled (Esc, right click, a page that could not load, or the
    /// window being closed by the OS).
    Done(Option<Selection>),
}

struct Session {
    frames: Vec<Arc<Frame>>,
    events: mpsc::Sender<Event>,
}

/// Managed state: the running selection, if any. The hotkey's busy guard allows only one at a time.
#[derive(Default)]
pub struct Overlay(Mutex<Option<Session>>);

impl Overlay {
    fn session(&self) -> MutexGuard<'_, Option<Session>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn frame(&self, monitor: usize) -> Option<Arc<Frame>> {
        self.session().as_ref()?.frames.get(monitor).cloned()
    }

    fn send(&self, event: Event) {
        if let Some(session) = self.session().as_ref() {
            let _ = session.events.send(event);
        }
    }
}

/// Which monitor an overlay window belongs to, from its label (`overlay-<i>`).
fn monitor_of(window: &WebviewWindow) -> Option<usize> {
    window.label().strip_prefix(LABEL)?.parse().ok()
}

/// The page's frame is loaded and decoded.
#[tauri::command]
pub fn overlay_ready(window: WebviewWindow, overlay: State<Overlay>) {
    if let Some(monitor) = monitor_of(&window) {
        overlay.send(Event::Ready(monitor));
    }
}

/// The drag the user made on this page, or `None` to cancel. CSS px, see `region::Selection`.
#[tauri::command]
pub fn overlay_select(window: WebviewWindow, overlay: State<Overlay>, selection: Option<Selection>) {
    let monitor = monitor_of(&window);
    if monitor.is_some() && selection.is_none_or(|s| Some(s.monitor) == monitor) {
        overlay.send(Event::Done(selection));
    }
}

/// `overlay://localhost/<monitor>` (`http://overlay.localhost/<monitor>` on Windows): the frozen frame.
/// Only the overlay pages may ask: it is a picture of the whole screen.
pub fn protocol(ctx: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    let from_overlay = ctx.webview_label().starts_with(LABEL);
    let monitor = request.uri().path().trim_start_matches('/').parse::<usize>().ok();
    // Off the main thread: copying 30 MB must not stall the event loop.
    std::thread::spawn(move || {
        let frame = monitor
            .filter(|_| from_overlay)
            .and_then(|monitor| app.state::<Overlay>().frame(monitor));
        let response = match frame {
            Some(frame) => Response::builder()
                .header(header::CONTENT_TYPE, "image/bmp")
                .header(header::CACHE_CONTROL, "no-store")
                .body(frame.bmp.clone()),
            None => Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()),
        };
        responder.respond(response.expect("static response"));
    });
}

/// Blocking: call from a worker thread, never the main one. `Ok(false)` = cancelled or timed out.
/// On success a PNG of the selected pixels is at `path`.
pub fn select_region(app: &AppHandle, path: &Path) -> Result<bool, String> {
    let started = Instant::now();
    let (rects, frames) = capture_all()?;
    eprintln!("wordstrobe: overlay: captured {} monitor(s) in {} ms", frames.len(), started.elapsed().as_millis());

    let (events, inbox) = mpsc::channel();
    *app.state::<Overlay>().session() =
        Some(Session { frames: frames.clone(), events: events.clone() });
    let cleanup = Cleanup(app);

    let windows = rects
        .iter()
        .enumerate()
        .map(|(i, &rect)| open_window(app, i, rect, &events))
        .collect::<Result<Vec<_>, _>>()?;
    wait_until_loaded(&inbox, windows.len())?;
    eprintln!("wordstrobe: overlay: shown after {} ms", started.elapsed().as_millis());

    // Everything appears at once, and the monitor with the cursor gets the keyboard (Esc).
    let cursor = app.cursor_position().map_or((0.0, 0.0), |p| (p.x, p.y));
    let active = region::monitor_at(cursor, &rects);
    for window in windows.iter().enumerate().filter(|&(i, _)| i != active).map(|(_, w)| w) {
        let _ = window.show();
    }
    let _ = windows[active].show();
    let _ = windows[active].set_focus();

    let selection = wait_for_selection(&inbox);
    drop(cleanup); // the overlay goes away on mouse-up, before the PNG is written
    let Some(selection) = selection else {
        return Ok(false);
    };

    let frame = frames.get(selection.monitor).ok_or("selection on an unknown monitor")?;
    let Some(rect) = region::crop_rect(&selection, frame.size) else {
        return Ok(false);
    };
    write_png(path, &region::crop_bmp(&frame.bmp, frame.size.0, rect), (rect.2, rect.3))?;
    Ok(true)
}

/// Closes the overlay windows and drops the frames however `select_region` is left (also on a panic).
struct Cleanup<'a>(&'a AppHandle);

impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        *self.0.state::<Overlay>().session() = None;
        for (label, window) in self.0.webview_windows() {
            if label.starts_with(LABEL) {
                let _ = window.destroy();
            }
        }
    }
}

/// Every monitor's rectangle and frozen frame, in the same order.
fn capture_all() -> Result<(Vec<Px>, Vec<Arc<Frame>>), String> {
    let monitors = Monitor::all().map_err(|e| format!("cannot list monitors: {e}"))?;
    // ponytail: one monitor after the other. ~20-90 ms each (xcap, measured on macOS); parallel capture
    // needs `Send` monitors, which xcap does not promise on Windows.
    let captured: Vec<(Px, Frame)> = monitors
        .iter()
        .enumerate()
        .filter_map(|(i, monitor)| match capture(monitor) {
            Ok(captured) => Some(captured),
            Err(e) => {
                eprintln!("wordstrobe: overlay: cannot capture monitor {i}: {e}");
                None
            }
        })
        .collect();
    if captured.is_empty() {
        return Err("no monitor could be captured".into());
    }
    Ok(captured.into_iter().map(|(rect, frame)| (rect, Arc::new(frame))).unzip())
}

fn capture(monitor: &Monitor) -> Result<(Px, Frame), String> {
    let e = |e: xcap::XCapError| e.to_string();
    let image = monitor.capture_image().map_err(e)?;
    let (w, h) = (image.width(), image.height());
    // xcap divides X11 coordinates (only those) by Xft.dpi / 96, see `region::physical_origin`.
    let divided = cfg!(target_os = "linux");
    let scale = if divided { monitor.scale_factor().map_err(e)? } else { 1.0 };
    let x = region::physical_origin(monitor.x().map_err(e)?, scale, divided);
    let y = region::physical_origin(monitor.y().map_err(e)?, scale, divided);
    Ok(((x, y, w, h), Frame { size: (w, h), bmp: region::rgba_to_bmp(w, h, image.into_raw()) }))
}

/// A hidden window on `rect` whose page loads frame `index`. It is shown once every page is ready.
/// When the OS closes it (Alt+F4, the window manager's close) the selection ends as cancelled:
/// nobody else would end it, and the other monitors would stay covered until the timeout.
fn open_window(
    app: &AppHandle,
    index: usize,
    rect: Px,
    events: &mpsc::Sender<Event>,
) -> Result<WebviewWindow, String> {
    let url = WebviewUrl::App(format!("overlay.html?m={index}").into());
    // WebView2 windows that share a user-data folder need identical browser arguments, or creating
    // them fails: take the ones of the configured windows (tauri.conf.json). Windows only.
    let args = app.config().app.windows.first().and_then(|w| w.additional_browser_args.as_deref());
    // Resizable while it is moved: a fixed-size window may refuse the new size on some platforms.
    let mut builder = WebviewWindowBuilder::new(app, format!("{LABEL}{index}"), url);
    if let Some(args) = args {
        builder = builder.additional_browser_args(args);
    }
    let window = builder
        .title("Wordstrobe")
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .background_color(Color(0, 0, 0, 255))
        .build()
        .map_err(|e| format!("cannot open the overlay: {e}"))?;
    let (x, y, w, h) = rect;
    // Twice: the first move can change the scale factor of the window (mixed-DPI desktops) and with
    // it the size that was just set.
    for _ in 0..2 {
        let _ = window.set_position(PhysicalPosition::new(x, y));
        let _ = window.set_size(PhysicalSize::new(w, h));
    }
    let _ = window.set_resizable(false);
    // Bound to this selection's own channel, not to whatever session is current: the `Destroyed` of
    // a window that `Cleanup` closed must never cancel the next selection.
    let events = events.clone();
    window.on_window_event(move |event| {
        if ends_selection(event) {
            let _ = events.send(Event::Done(None));
        }
    });
    Ok(window)
}

/// The OS asked to close the overlay window, or it is gone already.
fn ends_selection(event: &WindowEvent) -> bool {
    matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed)
}

fn wait_until_loaded(inbox: &Receiver<Event>, pages: usize) -> Result<(), String> {
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut ready = HashSet::new();
    while ready.len() < pages {
        match inbox.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Event::Ready(monitor)) => {
                ready.insert(monitor);
            }
            Ok(Event::Done(_)) => return Err("an overlay page failed to load its frame".into()),
            Err(_) => return Err(format!("{} of {pages} overlay pages loaded in time", ready.len())),
        }
    }
    Ok(())
}

fn wait_for_selection(inbox: &Receiver<Event>) -> Option<Selection> {
    let deadline = Instant::now() + SELECT_TIMEOUT;
    loop {
        match inbox.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Event::Done(selection)) => return selection,
            Ok(Event::Ready(_)) => {}
            Err(_) => return None,
        }
    }
}

fn write_png(path: &Path, rgb: &[u8], (w, h): (u32, u32)) -> Result<(), String> {
    let file = fs::File::create(path).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    PngEncoder::new_with_quality(BufWriter::new(file), CompressionType::Fast, FilterType::Sub)
        .write_image(rgb, w, h, ExtendedColorType::Rgb8)
        .map_err(|e| {
            let _ = fs::remove_file(path); // no half-written capture is left behind
            format!("cannot encode the selection: {e}")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_closed_window_ends_the_selection_but_focus_and_moves_do_not() {
        assert!(ends_selection(&WindowEvent::Destroyed));
        assert!(!ends_selection(&WindowEvent::Focused(false)));
        assert!(!ends_selection(&WindowEvent::Moved(PhysicalPosition::new(0, 0))));
        assert!(!ends_selection(&WindowEvent::Resized(PhysicalSize::new(1, 1))));
    }

    #[test]
    fn a_cancel_from_the_close_handler_wakes_the_waiting_selection() {
        let (events, inbox) = mpsc::channel();
        events.send(Event::Ready(0)).unwrap();
        events.send(Event::Done(None)).unwrap();
        assert_eq!(wait_for_selection(&inbox), None);
    }
}
