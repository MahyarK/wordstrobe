//! Windows half of the platform seam (PLAN §3, §12): OCR through `Windows.Media.Ocr`, called
//! in-process via the `windows` crate. It reads with the OCR languages installed for the user
//! profile (Windows 10+). Region selection is the shared overlay (`crate::overlay`).
//!
//! Each line's text is built from its words (`crate::words`), not taken from `OcrLine::Text`.
//! Left out: `OcrResult::TextAngle` (rotated text is read as the engine reports it) and any
//! confidence, which WinRT OCR doesn't have (`c` is always 1.0).

use std::{
    path::Path,
    sync::{Once, OnceLock},
    time::Instant,
};

use serde_json::{json, Value};
use tauri::{AppHandle, WebviewWindow};
use windows::{
    core::{Result as WinResult, HSTRING},
    Graphics::Imaging::{
        BitmapAlphaMode, BitmapDecoder, BitmapInterpolationMode, BitmapPixelFormat,
        BitmapTransform, ColorManagementMode, ExifOrientationMode, SoftwareBitmap,
    },
    Media::Ocr::OcrEngine,
    Storage::{FileAccessMode, StorageFile},
    Win32::System::{
        Com::CoIncrementMTAUsage,
        WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
    },
};

use crate::words::join_words;

const NO_LANGUAGE: &str = "No OCR language is installed. Add one in Settings → Time & language → \
Language & region (a language with \"Optical character recognition\").";

/// Warms the OCR engine in the background so the first capture doesn't pay for creating it.
pub fn setup(_app: &AppHandle) {
    std::thread::spawn(|| match engine() {
        Ok(engine) => eprintln!("wordstrobe: Windows OCR ready ({})", language(engine)),
        Err(e) => eprintln!("wordstrobe: {e}"),
    });
}

/// Windows has no screen-capture permission.
pub fn has_capture_permission() -> bool {
    true
}

pub fn request_capture_permission() -> bool {
    true
}

pub fn open_privacy_settings() {}

/// `Ok(false)` = the user cancelled.
pub fn capture_region(app: &AppHandle, path: &Path) -> Result<bool, String> {
    crate::overlay::select_region(app, path)
}

pub fn show_over_fullscreen(_window: &WebviewWindow) {}

pub fn is_wayland() -> bool {
    false
}

/// Blocking: call from a worker thread. Returns `{lines, lang, ms}` (PLAN §3).
pub fn ocr(_app: &AppHandle, path: &Path) -> Result<Value, String> {
    read(path)
}

fn read(path: &Path) -> Result<Value, String> {
    let t0 = Instant::now();
    let engine = engine()?;
    let max = OcrEngine::MaxImageDimension().map_err(|e| format!("Windows OCR failed: {e}"))?;
    let bitmap = load(path, max).map_err(|e| format!("cannot read the captured image: {e}"))?;
    let lines = recognize(engine, &bitmap).map_err(|e| format!("Windows OCR failed: {e}"))?;
    Ok(json!({ "lines": lines, "lang": language(engine), "ms": t0.elapsed().as_millis() as u64 }))
}

/// WinRT must be initialised on every thread that calls it. A thread that already has an
/// apartment (`RPC_E_CHANGED_MODE`, e.g. a UI thread in an STA) is usable as it is, and then
/// there is nothing to undo.
struct Apartment(bool);

impl Apartment {
    fn enter() -> Self {
        Apartment(unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok())
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe { RoUninitialize() }
        }
    }
}

thread_local! { static APARTMENT: Apartment = Apartment::enter(); }

static ENGINE: OnceLock<OcrEngine> = OnceLock::new();
static MTA: Once = Once::new();

/// The engine is agile, so one instance serves every thread. A failure isn't cached: installing
/// a language fixes it without a restart. This is also where a thread joins the apartment: every
/// WinRT call in this file comes after it.
fn engine() -> Result<&'static OcrEngine, String> {
    // The engine lives in the process-wide MTA, which is otherwise torn down whenever the last
    // short-lived worker thread leaves it. Pinned for good.
    MTA.call_once(|| {
        let _ = unsafe { CoIncrementMTAUsage() };
    });
    APARTMENT.with(|_| ());
    if let Some(engine) = ENGINE.get() {
        return Ok(engine);
    }
    // `TryCreate…` yields null, surfaced as an error, when no installed OCR language matches.
    let created = OcrEngine::TryCreateFromUserProfileLanguages().map_err(|_| NO_LANGUAGE)?;
    Ok(ENGINE.get_or_init(|| created))
}

/// Size to hand to the engine: the image scaled down (aspect kept) to fit `max` on both sides.
fn fit(width: u32, height: u32, max: u32) -> (u32, u32) {
    let scale = (f64::from(max) / f64::from(width.max(height))).min(1.0);
    let side = |n: u32| ((f64::from(n) * scale).round() as u32).max(1);
    (side(width), side(height))
}

/// Decodes the PNG to a BGRA bitmap that fits the engine's `max` dimension.
fn load(path: &Path, max: u32) -> WinResult<SoftwareBitmap> {
    // `StorageFile` only takes absolute paths with backslashes; `absolute` fixes both.
    let path = HSTRING::from(std::path::absolute(path)?.as_path());
    let file = StorageFile::GetFileFromPathAsync(&path)?.join()?;
    let stream = file.OpenAsync(FileAccessMode::Read)?.join()?;
    let decoder = BitmapDecoder::CreateAsync(&stream)?.join()?;
    let (width, height) = fit(decoder.PixelWidth()?, decoder.PixelHeight()?, max);
    let transform = BitmapTransform::new()?;
    transform.SetScaledWidth(width)?;
    transform.SetScaledHeight(height)?;
    transform.SetInterpolationMode(BitmapInterpolationMode::Fant)?;
    decoder
        .GetSoftwareBitmapTransformedAsync(
            BitmapPixelFormat::Bgra8,
            BitmapAlphaMode::Premultiplied,
            &transform,
            ExifOrientationMode::IgnoreExifOrientation,
            ColorManagementMode::DoNotColorManage,
        )?
        .join()
}

/// One entry per OCR line, its box the union of its words' boxes, normalized to the bitmap.
fn recognize(engine: &OcrEngine, bitmap: &SoftwareBitmap) -> WinResult<Vec<Value>> {
    let (width, height) = (
        f64::from(bitmap.PixelWidth()?),
        f64::from(bitmap.PixelHeight()?),
    );
    // 5 decimals (< 0.1 px on a 10000 px image); keeps f32 noise out of the JSON.
    let norm = |v: f32, size: f64| (f64::from(v) / size).clamp(0.0, 1.0);
    let round = |v: f64| (v * 1e5).round() / 1e5;
    let mut lines = Vec::new();
    for line in engine.RecognizeAsync(bitmap)?.join()?.Lines()? {
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        let mut words = Vec::new();
        for word in line.Words()? {
            words.push(word.Text()?.to_string());
            let r = word.BoundingRect()?;
            x0 = x0.min(norm(r.X, width));
            y0 = y0.min(norm(r.Y, height));
            x1 = x1.max(norm(r.X + r.Width, width));
            y1 = y1.max(norm(r.Y + r.Height, height));
        }
        // Not `OcrLine::Text`: it puts a space between the characters of Chinese and Japanese too.
        let text = join_words(&words);
        if text.trim().is_empty() || x0 > x1 {
            continue;
        }
        lines.push(json!({
            "t": text, "x": round(x0), "y": round(y0), "w": round(x1 - x0), "h": round(y1 - y0), "c": 1.0
        }));
    }
    Ok(lines)
}

/// Primary BCP-47 subtag of the engine's language ("en-US" → "en"), or "und".
fn language(engine: &OcrEngine) -> String {
    engine
        .RecognizerLanguage()
        .and_then(|language| language.LanguageTag())
        .map(|tag| tag.to_string())
        .ok()
        .and_then(|tag| tag.split('-').next().map(str::to_lowercase))
        .filter(|primary| !primary.is_empty())
        .unwrap_or_else(|| "und".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_only_shrinks_and_keeps_aspect() {
        assert_eq!(fit(900, 240, 10_000), (900, 240));
        assert_eq!(fit(20_000, 5_000, 10_000), (10_000, 2_500));
        assert_eq!(fit(100, 30_000, 10_000), (33, 10_000));
        assert_eq!(fit(1, 40_000, 10_000), (1, 10_000));
    }

    /// Needs an OCR language on the machine; CI adds `Language.OCR~~~en-US` and sets
    /// `WORDSTROBE_REQUIRE_OCR`, so a missing engine fails there instead of passing as a skip.
    #[test]
    fn reads_two_english_lines_in_order() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ocr-en.png");
        let skip = |why: String| {
            assert!(std::env::var_os("WORDSTROBE_REQUIRE_OCR").is_none(), "{why}");
            eprintln!("skipped: {why}");
        };
        let result = match engine() {
            Ok(engine) if language(engine) == "en" => read(&path).unwrap(),
            Ok(engine) => {
                return skip(format!("the OCR engine reads {:?}, not English", language(engine)))
            }
            Err(e) => return skip(format!("no OCR engine here ({e})")),
        };
        let lines = result["lines"].as_array().expect("lines");
        assert_eq!(result["lang"], "en");
        assert_eq!(lines.len(), 2, "{result}");
        let text = |i: usize| lines[i]["t"].as_str().unwrap().to_lowercase();
        assert!(text(0).contains("quick brown fox"), "{result}");
        assert!(text(1).contains("one word at a time"), "{result}");
        let num = |i: usize, k: &str| lines[i][k].as_f64().unwrap();
        for i in 0..2 {
            for k in ["x", "y", "w", "h"] {
                assert!(
                    (0.0..=1.0).contains(&num(i, k)),
                    "{k} of line {i}: {result}"
                );
            }
            assert!(num(i, "x") + num(i, "w") <= 1.0 && num(i, "y") + num(i, "h") <= 1.0);
            assert_eq!(num(i, "c"), 1.0);
        }
        assert!(
            num(0, "y") + num(0, "h") <= num(1, "y"),
            "lines overlap: {result}"
        );
    }
}
