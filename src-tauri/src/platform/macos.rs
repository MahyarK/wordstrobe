//! macOS half of the platform seam (contract: top of `main.rs`): permission FFI, `screencapture`, and
//! the client for the long-lived Vision helper `wordstrobe-ocr` (JSON lines over stdin/stdout, PLAN §3 IPC).

use std::{
    collections::HashMap,
    path::Path,
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc, Mutex,
    },
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tauri::{async_runtime::Receiver, AppHandle, Manager, WebviewWindow};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

/// Generous on purpose: a full-screen capture of a 5K display takes 3-4 s on an M3 Pro and slower or
/// Intel Macs need longer. A timeout kills the helper, which then has to cold-start again.
const OCR_TIMEOUT: Duration = Duration::from_secs(30);
/// Delay before respawning a helper that exited: doubles with every exit that was not preceded by
/// healthy service, up to the cap.
const RESPAWN_MIN: Duration = Duration::from_secs(1);
const RESPAWN_MAX: Duration = Duration::from_secs(60);
/// A helper that has been ready this long counts as healthy even if nobody asked it anything.
const STABLE_AFTER: Duration = Duration::from_secs(30);

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// Manages the helper client and starts the helper.
pub fn setup(app: &AppHandle) {
    app.manage(Ocr::default());
    start_helper(app);
}

pub fn has_capture_permission() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

/// Shows the system prompt the first time. The grant only takes effect after a relaunch.
pub fn request_capture_permission() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}

pub fn open_privacy_settings() {
    let url = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
    let _ = Command::new("/usr/bin/open").arg(url).status();
}

/// Runs the system crosshair. `Ok(false)` = the user cancelled: `screencapture` writes no file
/// then (and, without permission, exits 1 the same way, hence the preflight in the caller).
pub fn capture_region(_app: &AppHandle, path: &Path) -> Result<bool, String> {
    Command::new("/usr/sbin/screencapture")
        .args(["-i", "-x"])
        .arg(path)
        .status()
        .map_err(|e| format!("cannot run screencapture: {e}"))?;
    Ok(path.exists())
}

/// Shows the reader over full-screen apps too (PLAN §8): `FullScreenAuxiliary` next to the
/// `CanJoinAllSpaces` that `visibleOnAllWorkspaces` already set. Main thread only (setup).
pub fn show_over_fullscreen(window: &WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior as Behavior};
    let Ok(ptr) = window.ns_window() else {
        eprintln!("wordstrobe: reader has no NSWindow");
        return;
    };
    // SAFETY: tao owns this live NSWindow for as long as the window exists, and we are on the main thread.
    let ns_window = unsafe { &*ptr.cast::<NSWindow>() };
    ns_window.setCollectionBehavior(ns_window.collectionBehavior() | Behavior::FullScreenAuxiliary);
    let now = ns_window.collectionBehavior();
    eprintln!(
        "wordstrobe: reader collection behavior {:#x} (all spaces: {}, full-screen auxiliary: {})",
        now.0,
        now.contains(Behavior::CanJoinAllSpaces),
        now.contains(Behavior::FullScreenAuxiliary)
    );
}

pub fn is_wayland() -> bool {
    false
}

type Reply = Result<Value, String>;

/// Managed state: the helper process and the requests waiting for an answer.
#[derive(Default)]
struct Ocr {
    child: Mutex<Option<CommandChild>>,
    /// Pid of `child` (0 = none), set together with it. Cached because `CommandChild::pid` (like
    /// `kill`) locks inside `shared_child`, which blocks for as long as a stopped helper is waited on.
    pid: AtomicU32,
    pending: Mutex<HashMap<u64, mpsc::Sender<Reply>>>,
    next_id: AtomicU64,
    /// When the current helper said it was ready, and whether it has answered a request since.
    /// Both feed the respawn backoff.
    ready_at: Mutex<Option<Instant>>,
    answered: AtomicBool,
}

impl Ocr {
    fn set_child(&self, child: Option<CommandChild>) {
        let mut slot = self.child.lock().unwrap();
        // First time `pid()` is asked: right after the spawn nothing waits on the child with the lock held yet.
        self.pid.store(
            child.as_ref().map_or(0, CommandChild::pid),
            Ordering::Release,
        );
        *slot = child;
    }
}

/// Respawn delay: starts at `RESPAWN_MIN`, doubles per helper exit up to `RESPAWN_MAX`, and starts
/// over after a helper that served well.
struct Backoff(Duration);

impl Backoff {
    fn new() -> Self {
        Backoff(RESPAWN_MIN)
    }

    fn next(&mut self, healthy: bool) -> Duration {
        if healthy {
            self.0 = RESPAWN_MIN;
        }
        let delay = self.0;
        self.0 = (self.0 * 2).min(RESPAWN_MAX);
        delay
    }
}

/// Spawns the helper now and keeps it alive: when it exits, pending requests fail and it is
/// respawned after a delay that grows while it keeps dying. Requires `app.manage(Ocr::default())` first.
fn start_helper(app: &AppHandle) {
    let app = app.clone();
    // Spawned here, not in the thread, so `child` is set before the first request can be sent.
    let mut rx = spawn_helper(&app);
    std::thread::spawn(move || {
        let mut backoff = Backoff::new();
        loop {
            if let Some(rx) = rx.take() {
                tauri::async_runtime::block_on(pump(&app, rx));
            }
            let ocr = app.state::<Ocr>();
            ocr.set_child(None);
            for (_, tx) in ocr.pending.lock().unwrap().drain() {
                let _ = tx.send(Err("OCR helper exited".into()));
            }
            let ready_for = ocr.ready_at.lock().unwrap().take().map(|t| t.elapsed());
            let answered = ocr.answered.swap(false, Ordering::AcqRel);
            let healthy = answered || ready_for.is_some_and(|d| d >= STABLE_AFTER);
            let delay = backoff.next(healthy);
            eprintln!("wordstrobe: respawning OCR helper in {} s", delay.as_secs());
            std::thread::sleep(delay);
            rx = spawn_helper(&app);
        }
    });
}

fn spawn_helper(app: &AppHandle) -> Option<Receiver<CommandEvent>> {
    // Raw output = arbitrary chunks, so `pump` always has to split on '\n' itself.
    let spawned = app
        .shell()
        .sidecar("wordstrobe-ocr")
        .map(|cmd| cmd.set_raw_out(true))
        .and_then(|cmd| cmd.spawn());
    match spawned {
        Ok((rx, child)) => {
            app.state::<Ocr>().set_child(Some(child));
            Some(rx)
        }
        Err(e) => {
            eprintln!("wordstrobe: cannot start OCR helper: {e}");
            None
        }
    }
}

/// Reads helper events until it terminates.
async fn pump(app: &AppHandle, mut rx: Receiver<CommandEvent>) {
    let mut buf: Vec<u8> = Vec::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(chunk) => {
                buf.extend_from_slice(&chunk);
                while let Some(i) = buf.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = buf.drain(..=i).collect();
                    handle_line(app, &line);
                }
            }
            CommandEvent::Stderr(chunk) => eprint!("{}", String::from_utf8_lossy(&chunk)),
            CommandEvent::Error(e) => eprintln!("wordstrobe: OCR helper error: {e}"),
            CommandEvent::Terminated(p) => {
                eprintln!(
                    "wordstrobe: OCR helper terminated (code {:?}, signal {:?})",
                    p.code, p.signal
                );
                return;
            }
            _ => {}
        }
    }
}

fn handle_line(app: &AppHandle, line: &[u8]) {
    if line.iter().all(u8::is_ascii_whitespace) {
        return;
    }
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        eprintln!(
            "wordstrobe: unparsable helper line: {}",
            String::from_utf8_lossy(line)
        );
        return;
    };
    let state = app.state::<Ocr>();
    if value.get("ready").is_some() {
        eprintln!("wordstrobe: OCR helper ready");
        *state.ready_at.lock().unwrap() = Some(Instant::now());
        return;
    }
    // No numeric id = a malformed-request error; an unknown id = it already timed out.
    let Some(id) = value.get("id").and_then(Value::as_u64) else {
        eprintln!("wordstrobe: helper reply without id: {value}");
        return;
    };
    state.answered.store(true, Ordering::Release);
    let tx = state.pending.lock().unwrap().remove(&id);
    if let Some(tx) = tx {
        let _ = tx.send(match value.get("error").and_then(Value::as_str) {
            Some(e) => Err(e.to_string()),
            None => Ok(value),
        });
    }
}

/// Blocking: call from a worker thread. Returns the helper's JSON object as-is.
pub fn ocr(app: &AppHandle, path: &Path) -> Reply {
    let state = app.state::<Ocr>();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    state.pending.lock().unwrap().insert(id, tx);

    let request = json!({ "id": id, "path": path.to_string_lossy(), "langs": [], "fast": false });
    // The pid is read under the same lock as the write: a timeout must only kill the helper this
    // request went to, not a replacement that has been spawned since.
    let sent = match state.child.lock().unwrap().as_mut() {
        Some(child) => child
            .write(format!("{request}\n").as_bytes())
            .map(|()| state.pid.load(Ordering::Acquire))
            .map_err(|e| e.to_string()),
        None => Err("OCR helper is not running".to_string()),
    };
    let reply = sent.and_then(|pid| match rx.recv_timeout(OCR_TIMEOUT) {
        Ok(reply) => reply,
        Err(_) => {
            // A hung helper would time out every later request too: kill it, `start_helper` respawns.
            kill_helper(&state, pid);
            Err("OCR timed out".to_string())
        }
    });
    state.pending.lock().unwrap().remove(&id);
    reply
}

/// SIGKILL straight to the pid. `CommandChild::kill` cannot be used: on macOS `waitid` also returns
/// for a *stopped* child, after which `shared_child` sits in `waitpid` holding the lock that `kill`
/// (and even `pid()`) needs, so killing a stopped helper would block forever.
fn kill_helper(state: &Ocr, pid: u32) {
    // Its own statement, so the mutex guard is gone before the kill. The child is dropped below,
    // which closes the helper's stdin, and later requests fail fast instead of writing to it.
    let child = {
        let mut slot = state.child.lock().unwrap();
        if state.pid.load(Ordering::Acquire) == pid {
            state.pid.store(0, Ordering::Release);
            slot.take()
        } else {
            None
        }
    };
    if child.is_none() {
        return; // already exited and replaced
    }
    // SAFETY: plain syscall. The pid is that of our own, not yet cleaned up child.
    if unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) } != 0 {
        eprintln!(
            "wordstrobe: cannot kill OCR helper {pid}: {}",
            std::io::Error::last_os_error()
        );
    }
    drop(child);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(backoff: &mut Backoff, healthy: bool) -> u64 {
        backoff.next(healthy).as_secs()
    }

    #[test]
    fn backoff_doubles_up_to_the_cap() {
        let mut b = Backoff::new();
        let delays: Vec<u64> = (0..9).map(|_| secs(&mut b, false)).collect();
        assert_eq!(delays, [1, 2, 4, 8, 16, 32, 60, 60, 60]);
    }

    #[test]
    fn backoff_starts_over_after_a_healthy_helper() {
        let mut b = Backoff::new();
        for _ in 0..5 {
            secs(&mut b, false);
        }
        assert_eq!(secs(&mut b, true), 1);
        assert_eq!(secs(&mut b, false), 2);
    }
}
