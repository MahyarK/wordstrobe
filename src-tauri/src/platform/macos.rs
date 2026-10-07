//! macOS half of the platform seam (PLAN §3): permission FFI, `screencapture`, and the client for
//! the long-lived Vision helper `wordstrobe-ocr` (JSON lines over stdin/stdout, PLAN §3 IPC).

use std::{
    collections::HashMap,
    path::Path,
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Mutex,
    },
    time::Duration,
};

use serde_json::{json, Value};
use tauri::{async_runtime::Receiver, AppHandle, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const OCR_TIMEOUT: Duration = Duration::from_secs(10);
const RESPAWN_DELAY: Duration = Duration::from_secs(1);

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
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
pub fn capture_region(path: &Path) -> Result<bool, String> {
    Command::new("/usr/sbin/screencapture")
        .args(["-i", "-x"])
        .arg(path)
        .status()
        .map_err(|e| format!("cannot run screencapture: {e}"))?;
    Ok(path.exists())
}

type Reply = Result<Value, String>;

/// Managed state: the helper process and the requests waiting for an answer.
#[derive(Default)]
pub struct Ocr {
    child: Mutex<Option<CommandChild>>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Reply>>>,
    next_id: AtomicU64,
}

/// Spawns the helper now and keeps it alive: when it exits, pending requests fail and it is
/// respawned after a second. Requires `app.manage(Ocr::default())` first.
pub fn start_helper(app: &AppHandle) {
    let app = app.clone();
    // Spawned here, not in the thread, so `child` is set before the first request can be sent.
    let mut rx = spawn_helper(&app);
    std::thread::spawn(move || loop {
        if let Some(rx) = rx.take() {
            tauri::async_runtime::block_on(pump(&app, rx));
        }
        let ocr = app.state::<Ocr>();
        *ocr.child.lock().unwrap() = None;
        for (_, tx) in ocr.pending.lock().unwrap().drain() {
            let _ = tx.send(Err("OCR helper exited".into()));
        }
        std::thread::sleep(RESPAWN_DELAY);
        rx = spawn_helper(&app);
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
            *app.state::<Ocr>().child.lock().unwrap() = Some(child);
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
                eprintln!("wordstrobe: OCR helper terminated (code {:?})", p.code);
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
    if value.get("ready").is_some() {
        eprintln!("wordstrobe: OCR helper ready");
        return;
    }
    // No numeric id = a malformed-request error; an unknown id = it already timed out.
    let Some(id) = value.get("id").and_then(Value::as_u64) else {
        eprintln!("wordstrobe: helper reply without id: {value}");
        return;
    };
    let tx = app.state::<Ocr>().pending.lock().unwrap().remove(&id);
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
    let sent = match state.child.lock().unwrap().as_mut() {
        Some(child) => child
            .write(format!("{request}\n").as_bytes())
            .map_err(|e| e.to_string()),
        None => Err("OCR helper is not running".to_string()),
    };
    let reply = sent.and_then(|()| match rx.recv_timeout(OCR_TIMEOUT) {
        Ok(reply) => reply,
        Err(_) => {
            // A hung helper would time out every later request too: kill it, `start_helper` respawns.
            if let Some(child) = state.child.lock().unwrap().take() {
                let _ = child.kill();
            }
            Err("OCR timed out".to_string())
        }
    });
    state.pending.lock().unwrap().remove(&id);
    reply
}
