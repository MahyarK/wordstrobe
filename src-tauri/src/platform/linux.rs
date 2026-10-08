//! Linux half of the platform seam (PLAN §3, §12): region capture and OCR through the Tesseract CLI.
//!
//! - **Wayland** (`WAYLAND_DISPLAY` or `XDG_SESSION_TYPE=wayland`): the xdg-desktop-portal
//!   Screenshot portal with `interactive: true`, i.e. the desktop's own region picker (GNOME, KDE).
//!   Clients cannot grab the screen or position windows on Wayland, so the reader popup lands where
//!   the compositor puts it and `show_over_fullscreen` has nothing to do.
//! - **X11**: the freeze-frame overlay in `crate::overlay`.
//! - **OCR**: `tesseract <png> stdout -l <langs> --psm 3 tsv`, parsed into the same `lines` shape as
//!   the macOS helper's text path. The TypeScript side groups the lines into paragraphs and columns.

use std::{
    fs,
    os::unix::ffi::OsStringExt,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::{mpsc, Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, WebviewWindow};

use crate::words::join_words;

/// Tesseract needs a few hundred ms for a screenful, so this only guards against a hung process.
const OCR_TIMEOUT: Duration = Duration::from_secs(60);
/// A portal screenshot older than this was not made by our request, so it is left alone.
const PORTAL_FILE_MAX_AGE: Duration = Duration::from_secs(120);
const TESSERACT_MISSING: &str =
    "Install Tesseract OCR: sudo apt install tesseract-ocr (or your distribution's package)";
const PORTAL_MISSING: &str = "Install xdg-desktop-portal and your desktop's portal backend \
    (xdg-desktop-portal-gnome, xdg-desktop-portal-kde or xdg-desktop-portal-gtk)";

/// Tesseract language codes next to the ISO 639-1 code of the locale (and the BCP-47 tag we report).
const LANGUAGES: &[(&str, &str)] = &[
    ("af", "afr"), ("ar", "ara"), ("az", "aze"), ("be", "bel"), ("bg", "bul"), ("bn", "ben"),
    ("ca", "cat"), ("cs", "ces"), ("cy", "cym"), ("da", "dan"), ("de", "deu"), ("el", "ell"),
    ("en", "eng"), ("es", "spa"), ("et", "est"), ("eu", "eus"), ("fa", "fas"), ("fi", "fin"),
    ("fr", "fra"), ("ga", "gle"), ("gl", "glg"), ("he", "heb"), ("hi", "hin"), ("hr", "hrv"),
    ("hu", "hun"), ("hy", "hye"), ("id", "ind"), ("is", "isl"), ("it", "ita"), ("ja", "jpn"),
    ("ka", "kat"), ("kk", "kaz"), ("kn", "kan"), ("ko", "kor"), ("lt", "lit"), ("lv", "lav"),
    ("mk", "mkd"), ("ml", "mal"), ("mr", "mar"), ("ms", "msa"), ("nb", "nor"), ("nl", "nld"),
    ("nn", "nor"), ("no", "nor"), ("pl", "pol"), ("pt", "por"), ("ro", "ron"), ("ru", "rus"),
    ("sk", "slk"), ("sl", "slv"), ("sq", "sqi"), ("sr", "srp"), ("sv", "swe"), ("ta", "tam"),
    ("te", "tel"), ("th", "tha"), ("tr", "tur"), ("uk", "ukr"), ("ur", "urd"), ("uz", "uzb"),
    ("vi", "vie"), ("zh", "chi_sim"),
];

// ---------------------------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------------------------

/// Detects Tesseract and its languages once, in the background, so the first OCR does not pay for it.
pub fn setup(_app: &AppHandle) {
    eprintln!(
        "wordstrobe: linux session: {}",
        if is_wayland() {
            "wayland (screenshot portal)"
        } else {
            "x11 (built-in overlay)"
        }
    );
    std::thread::spawn(|| match engine() {
        Ok(e) => eprintln!(
            "wordstrobe: {} found, installed languages [{}], reading with {}",
            e.version,
            e.installed.join(" "),
            e.langs.join("+")
        ),
        Err(e) => eprintln!("wordstrobe: {e}"),
    });
}

/// No permission model: X11 and the portals ask for themselves.
pub fn has_capture_permission() -> bool {
    true
}

pub fn request_capture_permission() -> bool {
    true
}

pub fn open_privacy_settings() {}

/// The compositor (Wayland) or the window manager (X11) decides how an always-on-top window
/// stacks over full-screen apps; there is no portable knob.
pub fn show_over_fullscreen(_window: &WebviewWindow) {}

/// Blocking: call from a worker thread. `Ok(false)` = the user cancelled.
pub fn capture_region(app: &AppHandle, path: &Path) -> Result<bool, String> {
    if is_wayland() {
        capture_portal(path)
    } else {
        crate::overlay::select_region(app, path)
    }
}

pub fn is_wayland() -> bool {
    wayland_session(
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
    )
}

fn wayland_session(wayland_display: Option<&str>, session_type: Option<&str>) -> bool {
    wayland_display.is_some_and(|d| !d.is_empty())
        || session_type.is_some_and(|t| t.eq_ignore_ascii_case("wayland"))
}

// ---------------------------------------------------------------------------------------------
// Wayland capture: the Screenshot portal
// ---------------------------------------------------------------------------------------------

fn capture_portal(path: &Path) -> Result<bool, String> {
    let Some(uri) = tauri::async_runtime::block_on(portal_screenshot())? else {
        return Ok(false);
    };
    let source = file_uri_to_path(&uri)
        .ok_or_else(|| format!("the screenshot portal returned an unsupported location: {uri}"))?;
    fs::copy(&source, path)
        .map_err(|e| format!("cannot read the portal screenshot {}: {e}", source.display()))?;
    if source != path {
        discard_portal_file(&source);
    }
    Ok(true)
}

/// `Ok(None)` = the user cancelled the picker.
async fn portal_screenshot() -> Result<Option<String>, String> {
    use ashpd::{
        desktop::{screenshot::Screenshot, ResponseError},
        Error, PortalError,
    };
    let outcome = async {
        let request = Screenshot::request()
            .interactive(true)
            .modal(true)
            .send()
            .await?;
        let screenshot = request.response()?;
        Ok::<_, Error>(screenshot.uri().as_str().to_owned())
    }
    .await;
    match outcome {
        Ok(uri) => Ok(Some(uri)),
        Err(Error::Response(ResponseError::Cancelled) | Error::Portal(PortalError::Cancelled(_))) => {
            Ok(None)
        }
        Err(e @ (Error::PortalNotFound(_) | Error::Zbus(_))) => {
            Err(format!("Screenshot portal unavailable ({e}). {PORTAL_MISSING}"))
        }
        Err(e) => Err(format!("Screenshot portal failed: {e}")),
    }
}

/// The portal saves the picture in the user's Pictures folder. It was made for this one read and
/// must not linger there (PLAN §15), unless it is old enough to not be ours.
fn discard_portal_file(source: &Path) {
    let fresh = fs::metadata(source)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age < PORTAL_FILE_MAX_AGE);
    if fresh {
        let _ = fs::remove_file(source);
    }
}

/// `file:///home/me/Pictures/Screenshot%20from%202026.png` -> the local path. Only `file:` URIs
/// without a remote host.
fn file_uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let path = if rest.starts_with('/') {
        rest
    } else {
        let (host, path) = rest.split_at(rest.find('/')?);
        if !host.eq_ignore_ascii_case("localhost") {
            return None;
        }
        path
    };
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let escaped = (bytes[i] == b'%')
            .then(|| bytes.get(i + 1..i + 3))
            .flatten()
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match escaped {
            Some(byte) => {
                out.push(byte);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    Some(PathBuf::from(std::ffi::OsString::from_vec(out)))
}

// ---------------------------------------------------------------------------------------------
// OCR: Tesseract
// ---------------------------------------------------------------------------------------------

/// What `setup` found, cached for the life of the process once Tesseract exists.
struct Engine {
    version: String,
    /// Every language `tesseract --list-langs` reports, minus `osd`.
    installed: Vec<String>,
    /// The ones used for reading, in `-l` order.
    langs: Vec<String>,
}

static ENGINE: Mutex<Option<Arc<Engine>>> = Mutex::new(None);

/// Detects once. While Tesseract is missing the detection repeats on every call, so installing it
/// while the app runs works without a restart.
fn engine() -> Result<Arc<Engine>, String> {
    let mut slot = ENGINE.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(engine) = slot.as_ref() {
        return Ok(Arc::clone(engine));
    }
    let engine = Arc::new(detect()?);
    *slot = Some(Arc::clone(&engine));
    Ok(engine)
}

fn detect() -> Result<Engine, String> {
    let version = tesseract_output(&["--version"])?
        .lines()
        .next()
        .unwrap_or("tesseract")
        .trim()
        .to_string();
    let installed = parse_list_langs(&tesseract_output(&["--list-langs"])?);
    let locale = locale_language(&[
        std::env::var("LC_ALL").ok().as_deref(),
        std::env::var("LC_MESSAGES").ok().as_deref(),
        std::env::var("LANG").ok().as_deref(),
    ]);
    let langs = choose_langs(&installed, locale.as_deref());
    Ok(Engine {
        version,
        installed,
        langs,
    })
}

/// stdout and stderr together: Tesseract 4 printed `--version` to stderr.
fn tesseract_output(args: &[&str]) -> Result<String, String> {
    let output = Command::new("tesseract")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(spawn_error)?;
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok(text)
}

fn spawn_error(e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        TESSERACT_MISSING.to_string()
    } else {
        format!("cannot run tesseract: {e}")
    }
}

/// Blocking: call from a worker thread.
pub fn ocr(_app: &AppHandle, path: &Path) -> Result<Value, String> {
    let started = Instant::now();
    let engine = engine()?;
    let tsv = run_tesseract(path, &engine.langs.join("+"))?;
    let lines = parse_tsv(&tsv, png_size(path))?;
    Ok(json!({
        "lines": lines,
        "lang": language_tag(&engine.langs),
        "ms": started.elapsed().as_millis() as u64,
    }))
}

fn run_tesseract(path: &Path, langs: &str) -> Result<String, String> {
    let mut command = Command::new("tesseract");
    command
        .arg(path)
        .args(["stdout", "-l", langs, "--psm", "3", "tsv"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Tesseract's OpenMP threads spin-wait against each other: measured 1.5 s -> 0.35 s for a
    // 1600x1000 page on two cores. One thread per request is also what a one-shot process wants.
    if std::env::var_os("OMP_THREAD_LIMIT").is_none() {
        command.env("OMP_THREAD_LIMIT", "1");
    }
    let child = command.spawn().map_err(spawn_error)?;
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let output = match rx.recv_timeout(OCR_TIMEOUT) {
        Ok(output) => output.map_err(|e| format!("tesseract failed: {e}"))?,
        Err(_) => {
            // SAFETY: plain syscall on our own child; the waiting thread reaps it.
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
            return Err("OCR timed out".to_string());
        }
    };
    if !output.status.success() {
        return Err(failure_message(output.status, &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn failure_message(status: ExitStatus, stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let mut tail: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).rev().take(2).collect();
    tail.reverse();
    let detail = if tail.is_empty() { "no message".to_string() } else { tail.join(" / ") };
    format!("tesseract exited with {status}: {detail}")
}

/// Width and height from the PNG header (signature, then the IHDR chunk), for output that has no
/// page row.
fn png_size(path: &Path) -> Option<(u32, u32)> {
    use std::io::Read;
    let mut header = [0u8; 24];
    fs::File::open(path).ok()?.read_exact(&mut header).ok()?;
    if &header[..8] != b"\x89PNG\r\n\x1a\n" || &header[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(header[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(header[20..24].try_into().ok()?);
    Some((width, height))
}

// ---------------------------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------------------------

/// The first line is a heading (`List of available languages in "/usr/…" (3):`), then one code per line.
fn parse_list_langs(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("List of") && *l != "osd")
        .filter(|l| l.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        .map(str::to_string)
        .collect()
}

/// The language part of the first locale variable that is set (`LC_ALL`, `LC_MESSAGES`, `LANG`, in
/// that precedence), e.g. `de_DE.UTF-8` -> `de`, `zh_TW.UTF-8` -> `zh-TW`. `C` and `POSIX` have none.
fn locale_language(vars: &[Option<&str>]) -> Option<String> {
    let value = vars.iter().flatten().find(|v| !v.is_empty())?;
    let value = value.split(['.', '@']).next()?;
    if value == "C" || value == "POSIX" {
        return None;
    }
    Some(value.replace('_', "-"))
}

/// The Tesseract model for a locale like `de`, `pt-BR` or `zh-TW`.
fn tesseract_code(locale: &str) -> Option<&'static str> {
    let mut parts = locale.split('-');
    let language = parts.next()?.to_ascii_lowercase();
    if language == "zh" {
        let traditional = parts.any(|p| matches!(p, "TW" | "HK" | "MO" | "Hant"));
        return Some(if traditional { "chi_tra" } else { "chi_sim" });
    }
    LANGUAGES.iter().find(|(iso, _)| *iso == language).map(|(_, tess)| *tess)
}

/// English, plus the locale's language when its model is installed. Falls back to whatever is
/// installed so that a system with only `deu` still reads.
fn choose_langs(installed: &[String], locale: Option<&str>) -> Vec<String> {
    let has = |code: &str| installed.iter().any(|l| l == code);
    let mut langs = Vec::new();
    if has("eng") || installed.is_empty() {
        langs.push("eng".to_string());
    }
    if let Some(code) = locale.and_then(tesseract_code) {
        if has(code) && !langs.iter().any(|l| l == code) {
            langs.push(code.to_string());
        }
    }
    if langs.is_empty() {
        langs.extend(installed.first().cloned());
    }
    langs
}

/// BCP-47 primary subtag of the one language in use, `und` when there are several (the reader
/// copes with `und`).
fn language_tag(langs: &[String]) -> &'static str {
    match langs {
        [only] => LANGUAGES
            .iter()
            .find(|(_, tess)| tess == only)
            .map_or("und", |(iso, _)| match *iso {
                "nn" | "no" => "nb",
                other => other,
            }),
        [] => "und",
        _ => match langs.iter().all(|l| l.starts_with("chi_")) {
            true => "zh",
            false => "und",
        },
    }
}

// ---------------------------------------------------------------------------------------------
// TSV -> lines
// ---------------------------------------------------------------------------------------------

/// One OCR line, in the shape of the macOS helper: coordinates normalized 0-1, top-left origin.
#[derive(Debug, PartialEq, Serialize)]
struct Line {
    t: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    c: f64,
}

struct Group {
    key: [i64; 4], // page, block, paragraph, line
    words: Vec<String>,
    left: i64,
    top: i64,
    right: i64,
    bottom: i64,
    confidence: f64,
}

/// Parses `tesseract … tsv` output (columns `level page block par line word left top width height
/// conf text`) into one entry per recognized line. The image size comes from the level-1 row, else
/// from `fallback_size`.
fn parse_tsv(tsv: &str, fallback_size: Option<(u32, u32)>) -> Result<Vec<Line>, String> {
    let mut page = None;
    let mut groups: Vec<Group> = Vec::new();
    for row in tsv.lines() {
        let fields: Vec<&str> = row.trim_end_matches('\r').splitn(12, '\t').collect();
        if fields.len() < 11 {
            continue;
        }
        // The header row and any stray message fail here.
        let Ok(level) = fields[0].trim().parse::<u8>() else {
            continue;
        };
        let int = |i: usize| fields[i].trim().parse::<i64>().ok();
        match level {
            1 => {
                if let (Some(w), Some(h)) = (int(8), int(9)) {
                    if w > 0 && h > 0 {
                        page = Some((w as f64, h as f64));
                    }
                }
            }
            5 => {
                let (Some(p), Some(b), Some(par), Some(l)) = (int(1), int(2), int(3), int(4)) else {
                    continue;
                };
                let (Some(left), Some(top), Some(w), Some(h)) = (int(6), int(7), int(8), int(9)) else {
                    continue;
                };
                let Ok(confidence) = fields[10].trim().parse::<f64>() else {
                    continue;
                };
                let text = fields.get(11).map_or("", |t| t.trim());
                if confidence < 0.0 || text.is_empty() {
                    continue;
                }
                let key = [p, b, par, l];
                if groups.last().is_none_or(|g| g.key != key) {
                    groups.push(Group {
                        key,
                        words: Vec::new(),
                        left,
                        top,
                        right: left + w,
                        bottom: top + h,
                        confidence: 0.0,
                    });
                }
                let group = groups.last_mut().expect("pushed above");
                group.words.push(text.to_string());
                group.left = group.left.min(left);
                group.top = group.top.min(top);
                group.right = group.right.max(left + w);
                group.bottom = group.bottom.max(top + h);
                group.confidence += confidence;
            }
            _ => {}
        }
    }
    let (width, height) = page
        .or_else(|| fallback_size.map(|(w, h)| (f64::from(w), f64::from(h))))
        .ok_or("tesseract output has no page size")?;
    let unit = |v: f64| (v.clamp(0.0, 1.0) * 10_000.0).round() / 10_000.0;
    Ok(groups
        .into_iter()
        .map(|g| Line {
            x: unit(g.left as f64 / width),
            y: unit(g.top as f64 / height),
            w: unit((g.right - g.left) as f64 / width),
            h: unit((g.bottom - g.top) as f64 / height),
            c: (g.confidence / g.words.len() as f64 / 100.0 * 1000.0).round() / 1000.0,
            t: join_words(&g.words),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const EN: &str = include_str!("../../tests/fixtures/tesseract-en.tsv");
    const DE: &str = include_str!("../../tests/fixtures/tesseract-de.tsv");

    fn texts(lines: &[Line]) -> Vec<&str> {
        lines.iter().map(|l| l.t.as_str()).collect()
    }

    #[test]
    fn english_sample_becomes_lines() {
        let lines = parse_tsv(EN, None).unwrap();
        assert_eq!(
            texts(&lines),
            [
                "Rapid serial visual presentation shows words one at a time at a fixed",
                "focal point, removing the eye movements that dominate normal reading",
                "Press Space to pause, use the arrow keys to step, and press Escape to",
                "close.",
            ]
        );
        for line in &lines {
            assert!((0.0..=1.0).contains(&line.x) && (0.0..=1.0).contains(&line.y));
            assert!(line.x + line.w <= 1.0 && line.y + line.h <= 1.0, "{line:?}");
            assert!(line.c > 0.75 && line.c <= 1.0, "{line:?}");
        }
        // Reading order and layout: stacked lines, left aligned, the last one the shortest.
        assert!(lines.windows(2).all(|pair| pair[0].y < pair[1].y));
        assert!((lines[0].x - lines[1].x).abs() < 0.01);
        assert!(lines[0].w > 0.8 && lines[3].w < 0.1);
    }

    #[test]
    fn box_is_the_union_of_the_word_boxes_normalized_to_the_page() {
        // Page 1000 x 500; words at (100,50)-(200,80) and (210,45)-(400,90).
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n\
1\t1\t0\t0\t0\t0\t0\t0\t1000\t500\t-1\t\n\
5\t1\t1\t1\t1\t1\t100\t50\t100\t30\t90.0\tHello\n\
5\t1\t1\t1\t1\t2\t210\t45\t190\t45\t70.0\tworld\n";
        let lines = parse_tsv(tsv, None).unwrap();
        assert_eq!(
            lines,
            [Line { t: "Hello world".into(), x: 0.1, y: 0.09, w: 0.3, h: 0.09, c: 0.8 }]
        );
    }

    #[test]
    fn unicode_words_survive() {
        let lines = parse_tsv(DE, None).unwrap();
        let all = texts(&lines).join(" ");
        for word in ["Würde", "unantastbar.", "schützen", "Verpflichtung", "Größere"] {
            assert!(all.contains(word), "{word} missing from {all}");
        }
    }

    #[test]
    fn rows_without_a_word_are_ignored() {
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n\
1\t1\t0\t0\t0\t0\t0\t0\t200\t100\t-1\t\n\
5\t1\t1\t1\t1\t1\t10\t10\t30\t12\t-1\tghost\n\
5\t1\t1\t1\t1\t2\t50\t10\t30\t12\t95\t \n\
5\t1\t1\t1\t1\t3\t90\t10\t30\t12\t95\t\n\
5\t1\t1\t1\t2\t1\t10\t40\t30\t12\t80\tkept\r\n";
        let lines = parse_tsv(tsv, None).unwrap();
        assert_eq!(texts(&lines), ["kept"]);
    }

    #[test]
    fn empty_page_has_no_lines() {
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n\
1\t1\t0\t0\t0\t0\t0\t0\t640\t480\t-1\t\n";
        assert!(parse_tsv(tsv, None).unwrap().is_empty());
    }

    #[test]
    fn page_size_falls_back_to_the_image() {
        let tsv = "5\t1\t1\t1\t1\t1\t100\t100\t100\t50\t90\tword\n";
        assert!(parse_tsv(tsv, None).is_err());
        let lines = parse_tsv(tsv, Some((1000, 500))).unwrap();
        assert_eq!((lines[0].x, lines[0].y, lines[0].w, lines[0].h), (0.1, 0.2, 0.1, 0.1));
    }

    #[test]
    fn list_langs_output_is_parsed() {
        let out = "List of available languages in \"/usr/share/tesseract-ocr/5/tessdata/\" (3):\ndeu\neng\nosd\n";
        assert_eq!(parse_list_langs(out), ["deu", "eng"]);
        assert!(parse_list_langs("").is_empty());
    }

    #[test]
    fn locale_picks_the_language() {
        assert_eq!(locale_language(&[None, None, Some("de_DE.UTF-8")]).as_deref(), Some("de-DE"));
        assert_eq!(locale_language(&[Some("zh_TW.UTF-8"), None, Some("de_DE")]).as_deref(), Some("zh-TW"));
        assert_eq!(locale_language(&[Some(""), None, Some("fr_FR@euro")]).as_deref(), Some("fr-FR"));
        assert_eq!(locale_language(&[Some("C"), None, Some("de_DE")]), None);
        assert_eq!(locale_language(&[None, None, Some("C.UTF-8")]), None);
        assert_eq!(locale_language(&[None, None, None]), None);
    }

    #[test]
    fn languages_follow_the_locale_and_what_is_installed() {
        let both: Vec<String> = ["deu", "eng"].map(String::from).into();
        let eng_only: Vec<String> = vec!["eng".into()];
        let deu_only: Vec<String> = vec!["deu".into()];
        assert_eq!(choose_langs(&both, Some("de-DE")), ["eng", "deu"]);
        assert_eq!(choose_langs(&both, Some("en-US")), ["eng"]);
        assert_eq!(choose_langs(&both, None), ["eng"]);
        assert_eq!(choose_langs(&eng_only, Some("de-DE")), ["eng"]);
        assert_eq!(choose_langs(&deu_only, Some("fr-FR")), ["deu"]);
        assert_eq!(choose_langs(&[], Some("de-DE")), ["eng"]);
        let chinese: Vec<String> = ["chi_tra", "eng"].map(String::from).into();
        assert_eq!(choose_langs(&chinese, Some("zh-TW")), ["eng", "chi_tra"]);
        assert_eq!(choose_langs(&chinese, Some("zh-CN")), ["eng"]);
    }

    #[test]
    fn reported_language_is_bcp47_or_und() {
        let langs = |codes: &[&str]| codes.iter().map(|c| c.to_string()).collect::<Vec<_>>();
        assert_eq!(language_tag(&langs(&["eng"])), "en");
        assert_eq!(language_tag(&langs(&["deu"])), "de");
        assert_eq!(language_tag(&langs(&["chi_sim"])), "zh");
        assert_eq!(language_tag(&langs(&["eng", "deu"])), "und");
        assert_eq!(language_tag(&langs(&["nor"])), "nb");
        assert_eq!(language_tag(&langs(&["xyz"])), "und");
    }

    #[test]
    fn wayland_is_detected_from_either_variable() {
        assert!(wayland_session(Some("wayland-0"), None));
        assert!(wayland_session(None, Some("wayland")));
        assert!(wayland_session(Some(""), Some("Wayland")));
        assert!(!wayland_session(None, Some("x11")));
        assert!(!wayland_session(Some(""), None));
    }

    #[test]
    fn portal_uris_become_paths() {
        let path = |u: &str| file_uri_to_path(u).map(|p| p.to_string_lossy().into_owned());
        assert_eq!(
            path("file:///home/me/Pictures/Screenshot%20from%202026-10-08.png").as_deref(),
            Some("/home/me/Pictures/Screenshot from 2026-10-08.png")
        );
        assert_eq!(path("file://localhost/tmp/a.png").as_deref(), Some("/tmp/a.png"));
        assert_eq!(path("file:///tmp/100%.png").as_deref(), Some("/tmp/100%.png"));
        assert_eq!(path("file://remote/tmp/a.png"), None);
        assert_eq!(path("https://example.com/a.png"), None);
    }
}
