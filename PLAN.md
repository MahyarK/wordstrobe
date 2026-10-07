# Wordstrobe: Implementation Plan

> Press a shortcut, drag a box around any text on screen, and read it in a small popup that
> shows one word at a time (Rapid Serial Visual Presentation), with optional read-aloud.
> macOS first; Windows and Linux follow without a rewrite.

Status: **planning**. Every number in this document marked *measured* comes from the
experiments in [`spikes/`](spikes) on an Apple M3 Pro, macOS 26.6, Xcode 27.

---

## 0. TL;DR

| Decision | Choice | Why |
|---|---|---|
| App shell | **Tauri v2** (Rust core + system webview) | One codebase for macOS, Windows and Linux. ~10 MB bundle instead of ~150 MB for Electron. Native APIs reachable from Rust. |
| UI | **Vanilla TypeScript + CSS** (Vite) | Two tiny windows. A framework adds weight and nothing else. |
| Region selection (mac v1) | **`/usr/sbin/screencapture -i`** | The system's own screenshot crosshair: familiar, multi-monitor, Retina, Esc to cancel, Space for window mode. No code to write. |
| OCR (mac) | **Apple Vision** in a small long-lived **Swift sidecar** | Best on-device OCR on the Mac. The newer APIs are Swift-only, so Rust can't call them directly. |
| Text pipeline + RSVP engine | **Pure TypeScript** (`src/text.ts`) | Written once and shared by all platforms. Unit-testable with `node --test`. |
| Read aloud | **Web Speech API** inside the webview | *Measured:* fires per-word `boundary` events in WKWebView, so read-along sync needs zero native code. |
| Privacy | **Everything on-device** | Vision and system voices run locally. No network except an optional update check. |
| Latency target | **mouse-up → first word < 450 ms** | *Measured:* OCR ≈ 270–300 ms when warm. |

macOS v1.0 ≈ **10 dev-days** (M0–M4). Windows ≈ 4 days and Linux ≈ 5 days after the shared overlay (M6).

---

## 1. Product

### Core flow
1. Press **⌥⇧R** (configurable) from any app.
2. The crosshair appears. Drag a rectangle over text (or press Space and click a window).
3. A small popup appears **near the cursor** right away with a loading shimmer.
4. About 0.3 s later the first word appears. After a short start delay (600 ms) it plays at your WPM.
5. Press **Space** to pause, **←/→** to step, **S** to read aloud, **Esc** to close. Focus returns to the app you were in.

### Principles
- **Instant.** Everything is pre-warmed, and the popup shows before OCR finishes.
- **Private.** Screen pixels never leave the machine. Captures are deleted right after OCR.
- **Keyboard-first.** Every action has a key, and the mouse is optional.
- **Invisible until needed.** Menu-bar only, no Dock icon, zero CPU when idle.
- **Comprehension over raw speed.** Punctuation pauses, ramp-up, one-key rewind, and an instant full-text view.

### Non-goals (v1)
Accounts, cloud OCR, sync, plugin system, Mac App Store. The sandbox would block spawning `screencapture`.

---

## 2. Spike results (measured)

| Experiment | Result | Consequence |
|---|---|---|
| `RecognizeTextRequest` `.accurate`, 1600×1000 px region | **413–508 ms cold, ~300 ms warm** | Keep the OCR process alive and pre-warm it at launch. |
| `RecognizeTextRequest` `.fast` | **~35 ms** warm | Optional "quick mode". The accurate path stays the default. |
| `RecognizeDocumentsRequest` (macOS 26+) | **~270 ms** and returns **paragraphs** with lines already joined | Use it on macOS 26+. It's faster than accurate text and skips paragraph heuristics. |
| Web Speech in WKWebView | `boundary` events with `charIndex`, `charLength`, `elapsedTime` per word | Read-along sync works from the webview. `getVoices()` is empty until `voiceschanged` fires. |
| `screencapture` without Screen Recording permission | Exits 1, prints "could not create image from rect", **writes no file** | Always preflight permission. Otherwise "no permission" looks the same as "user pressed Esc". |
| SDK check | `RecognizeTextRequest` needs macOS 15. `RecognizeDocumentsRequest` needs macOS 26. AVSpeech `willSpeakRangeOfSpeechString` needs 10.14. | Min macOS **15**. Native TTS fallback available everywhere. |

---

## 3. Architecture

```
                 ┌───────────────── Wordstrobe.app — Tauri v2, menu-bar only (Accessory policy) ────────────────┐
  ⌥⇧R ─────────▶ │  Rust core  (src-tauri/src)                                                                  │
  (global        │   • tray menu, global shortcuts, single-instance, settings store                             │
   shortcut)     │   • flow: preflight → capture → show popup → OCR → emit text                                 │
                 │        │ spawn per capture                       │ JSON lines over stdin/stdout (long-lived) │
                 │        ▼                                         ▼                                           │
                 │   /usr/sbin/screencapture -i -x tmp.png  wordstrobe-ocr (Swift: Vision OCR + NaturalLanguage)│
                 │                                                  │ { paragraphs | lines, lang, ms }          │
                 │                                                  ▼ event "reader:load"                       │
                 │  ┌────────── reader window (hidden, pre-created) ──────────┐  ┌──── settings window ────┐    │
                 │  │ text.ts: lines→paragraphs → cleanup → tokenize →        │  │ prefs, hotkeys,         │    │
                 │  │          ORP + timing schedule                          │  │ permissions, voices,    │    │
                 │  │ reader.ts: rAF player, keys, Web Speech read-along      │  │ stats, about/update     │    │
                 │  └─────────────────────────────────────────────────────────┘  └─────────────────────────┘    │
                 └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Responsibilities
| Layer | Owns | Does **not** own |
|---|---|---|
| Rust core | OS integration: hotkeys, tray, capture, OCR process, windows, permissions, placement | Any text logic |
| Swift sidecar (mac) | Vision OCR, language detection, `--selftest` | Capture, UI |
| `text.ts` (pure) | Paragraph grouping, cleanup, tokenization, ORP, timing | DOM, IPC |
| `reader.ts` | Playback loop, rendering, keys, speech | OCR, capture |

### Platform seam
Each OS gets one file under `src-tauri/src/platform/` with the same three free functions,
chosen by `#[cfg(target_os = …)]`. There's no trait because there's never more than one
implementation per build:

```rust
pub fn has_capture_permission() -> bool;
pub fn capture_region() -> Result<Option<Capture>>;   // None = user cancelled
pub fn ocr(capture: &Capture) -> Result<OcrResult>;   // { paragraphs?, lines?, lang }
```

### Why a sidecar rather than in-process
- `RecognizeTextRequest` and `RecognizeDocumentsRequest` are **Swift structs**. `objc2` can't call them, so they need Swift.
- Crash isolation: if Vision crashes, the helper respawns and the app stays up.
- Linking Swift into Rust (`swift-rs`) costs build complexity and buys about 1 ms of IPC. Not worth it.

### IPC contracts
**Rust ⇄ `wordstrobe-ocr`** (one JSON object per line):
```jsonc
→ {"id":7,"path":"/…/wordstrobe/7.png","langs":[],"fast":false}
← {"id":7,"paragraphs":["Rapid serial visual …"],"lang":"en","ms":271}     // macOS 26+
← {"id":7,"lines":[{"t":"Rapid serial","x":0.04,"y":0.06,"w":0.5,"h":0.03,"c":0.98}],"lang":"en","ms":300} // macOS 15–25
← {"id":7,"error":"…"}
```
On start, the helper OCRs a blank 64×64 image to pre-warm Vision, then prints `{"ready":true}`.

**Rust → reader window** (Tauri events):
```ts
"reader:status" { state: "ocr" | "error", message?: string }
"reader:load"   { paragraphs?: string[], lines?: Line[], lang: string, source: "region" | "selection" | "clipboard" | "drop", ocrMs?: number }
```
The reader talks back only through Tauri's own window, clipboard and store APIs, which are scoped by capabilities.

---

## 4. Core flow (macOS) and latency budget

```
hotkey ─▶ busy? ─yes─▶ ignore
            │no
            ▼
 has_capture_permission()? ─no─▶ open Settings › Permissions (request · open System Settings · relaunch)
            │yes
            ▼
 spawn `screencapture -i -x $TMPDIR/wordstrobe/<n>.png` ─▶ wait
            │
   file missing? ─yes─▶ cancelled → done (silent)
            │no
            ▼
 cursor_position() → place & show reader (shimmer) ─▶ emit reader:status{ocr}
            ▼
 helper.ocr(path) ─▶ delete file (always, also on error) ─▶ emit reader:load / reader:status{error}
```

| Step | Budget | Basis |
|---|---|---|
| hotkey → crosshair | < 100 ms | spawning `screencapture` ≈ 40 ms (*measured*, process start) |
| mouse-up → PNG on disk | < 80 ms | measure in M1. Fall back to `-t tiff` (no compression) if over budget. |
| popup visible | < 50 ms | pre-created hidden webview, just `show()` |
| OCR | ≤ 300 ms | *measured*: 270 ms (documents), 300 ms (accurate, warm) |
| text pipeline + first frame | < 20 ms | pure TS, O(n) |
| **mouse-up → first word on screen** | **< 450 ms p50** | Playback then starts after the 600 ms start delay, which is a setting. |

---

## 5. RSVP engine spec (`src/text.ts`)

### 5.1 Text pipeline
1. **Lines → paragraphs** (only when OCR returns `lines`):
   - Sort by `y`, then `x`.
   - Detect columns from a big horizontal gap in the x-histogram and read each column in turn.
   - Start a new paragraph when the vertical gap is more than 0.75 × line height, when the indent changes, or when the previous line is short and ends a sentence.
2. **Cleanup:**
   - Join hyphenated line breaks: `/(\p{L})-\s*\n\s*(\p{Ll})/u → $1$2`.
   - NFKC-normalize ligatures only (`ﬁ ﬂ`) and collapse whitespace.
   - Drop pure-symbol fragments (UI chrome, bullets, ≤ 2 non-alphanumeric chars) and lines with confidence < 0.3.
3. **Tokenize:**
   - Split on whitespace. Punctuation stays attached to its word.
   - For no-space scripts (`zh ja th lo km my`), use `Intl.Segmenter(lang, {granularity: "word"})` and merge non-word segments into the previous token. It's built into every webview, so no dictionary ships with the app.
   - Each token stores `{text, start, end, para, sentenceStart}`. The character offsets map speech `charIndex` → token.
   - Words longer than 13 letters are split into ≤ 9-letter parts with a trailing `-`.

### 5.2 Optimal Recognition Point (ORP)
The pivot letter (red) always sits at the same x position, so the eye never moves.

| letters (ignoring surrounding punctuation) | 1 | 2–5 | 6–9 | 10–13 | 14+ |
|---|---|---|---|---|---|
| pivot index (0-based) | 0 | 1 | 2 | 3 | 4 |

Rendering is CSS only, with no measuring or reflow: `grid-template-columns: 2fr auto 3fr`, holding
`<span class=l>` (right-aligned), `<b class=pivot>` and `<span class=r>` (left-aligned). The pivot
column sits at about 40 % of the width. Thin guide ticks sit above and below the pivot.

### 5.3 Timing (defaults; every multiplier is a setting)
```
base = 60_000 / wpm                                   // default 350 wpm, range 100–1200
ms   = base
     × min(1.5, 1 + 0.04 × max(0, letters − 6))       // long words
     × 1.3   if has digit or is ALL-CAPS (≥ 2 letters) // numbers, acronyms
     × 1.6   if ends with , ; : – — )                  // clause pause
     × 2.2   if ends with . ! ? …                      // sentence pause
     × 3.0   if paragraph end (+ blank frame)          // paragraph pause
     × ramp  1.6 → 1.0 linearly over the first 8 words, and over 4 words after every resume
```
Chunk mode (2–3 words per flash) uses the sum of the multipliers and centers the chunk without an ORP.
"Time left" = the remaining sum of the schedule.

### 5.4 Player (`reader.ts`)
- Precompute `durations[]` and cumulative `ends[]`. A single `requestAnimationFrame` loop compares
  `performance.now() − t0` against `ends[i]`. There's no drift and no `setInterval`, and word swaps
  land on frame boundaries (60 Hz and 120 Hz ProMotion).
- Pausing records elapsed time. With "Smart resume" (default on), resuming rewinds to the start of the sentence.
- No work at all while hidden or paused. The loop stops.

### 5.5 Popup states
`loading` (shimmer) → `ready` (first word, start-delay countdown dot) → `playing` ⇄ `paused`
(the context sentence fades in under the word, with the current word highlighted) → `done`
(*642 words · 1:51 · saved ~0:52 vs 238 wpm* · **Replay** · **Copy** · **Text view**).
Errors: *No text found* (auto-closes after 1.5 s) and *Permission needed* (button opens Settings).

### 5.6 Controls
| Key | Action | Key | Action |
|---|---|---|---|
| Space / click | play / pause | ↑ / ↓ | ±25 wpm |
| ← / → (hold = scrub) | prev / next word | 1 / 2 / 3 | words per flash |
| ⌥← / ⌥→ | prev / next sentence | S | read aloud on/off |
| R | restart | T | text view (click a word to jump) |
| ⌘C | copy extracted text | ⌘, | settings |
| scroll wheel | scrub | Esc | close and refocus the previous app |

---

## 6. Read aloud

- **Engine:** Web Speech API (`speechSynthesis`) in the webview. It uses system voices, works offline, and its boundary events were *measured* working in WKWebView.
- **One utterance per paragraph.** This avoids long-utterance cut-offs and keeps seeking cheap.
- **Modes** (setting, toggled with S):
  - **Read-along** (default when on): the voice drives the display. Each `boundary.charIndex` → token → render. The displayed WPM is the voice's effective rate.
  - **Voice only:** text view with the spoken word highlighted, no flashing.
- **Rate:**
  - `utterance.rate = targetWpm / voiceBaseWpm`.
  - `voiceBaseWpm` is calibrated once per voice: speak a fixed 30-word passage at rate 1 and volume 0, time the boundaries, and cache the result in the store. This is the calibration knob, because voices differ by about ±30 %.
  - The rate is clamped to ≤ 2.0 for intelligibility. When the target is above that, the UI says "voice capped at N wpm".
- **Seek / pause:** `pause()` / `resume()`. Any seek calls `cancel()` and speaks again from the token's offset.
- **Voice choice:** the best-quality local voice matching the detected `lang`. The picker in Settings is filtered by language. Voices are loaded after `voiceschanged`.
- **Fallback** if Web Speech hides Premium or Personal Voices, or misbehaves on a future macOS: `AVSpeechSynthesizer` in the Swift helper, streaming `{"ev":"word","loc":…,"len":…}` lines through `willSpeakRangeOfSpeechString`. The event shape is the same, so the reader doesn't change.

---

## 7. OCR (`src-tauri/helper/wordstrobe-ocr.swift`)

- Long-lived process, spawned at app start through the Tauri shell plugin (`externalBin`). It pre-warms, respawns on exit, and has one request in flight (the busy guard).
- **macOS 26+:** `RecognizeDocumentsRequest` → `document.paragraphs[].transcript`. Detected tables and lists are flagged so the reader can suggest Text view instead of RSVP.
- **macOS 15–25:** `RecognizeTextRequest` (`.accurate`, `usesLanguageCorrection`, `automaticallyDetectsLanguage`) → `lines` with normalized boxes and confidence. `text.ts` groups them into paragraphs.
- `NLLanguageRecognizer.dominantLanguage` → `lang` (BCP-47) for the tokenizer and voice.
- Settings: OCR languages (auto or pinned list), quality (`accurate`, or `fast` at ~35 ms).
- `wordstrobe-ocr --selftest`:
  - Renders known passages (Latin, German umlauts, Chinese; dark-on-light and light-on-dark; 11–28 px).
  - OCRs them and asserts ≥ 98 % character accuracy.
  - Prints latencies.
  - Runs in CI and grows out of `spikes/ocr_latency.swift`.

---

## 8. UI spec

### Reader popup
- 520×190 pt default; resizable, and the size is remembered.
- Borderless, rounded 14 pt, `hudWindow` vibrancy, follows light/dark, always on top, visible on all Spaces.
- Draggable anywhere (`data-tauri-drag-region`).
- Hover reveals a top-right cluster: 🔊 · ⚙ · ✕. At the bottom: a 2 px progress bar plus `350 wpm · 1:12 left`.
- **Placement** (setting):
  - **Near selection** (default): centered on the cursor at mouse-up, 24 pt below, flipped above when there's no room, clamped to the work area of the monitor under the cursor.
  - Screen center.
  - Last position.
- **Over full-screen apps:** `visibleOnAllWorkspaces` + always-on-top. If that isn't enough, also set `NSWindowCollectionBehavior.fullScreenAuxiliary` via `objc2` (~5 lines). Verify in M2.
- Esc → `hide()`. Because the app is an Accessory app, macOS hands focus back to the previous app.

### Menu-bar (tray) menu
`Read Region ⌥⇧R` · `Read Selection ⌥⇧S` · `Read Clipboard ⌥⇧V` · `Read Last Region Again` (M6) ·
— · `Recent ▸` (when history is on) · `Settings…` · `Check for Updates` · `Quit`

### Settings window (single page, sectioned)
- **Permissions:** status dots, Request, Open System Settings, Relaunch. This section sits on top and is shown on first run.
- **General:** hotkey recorders, launch at login, popup placement, start delay.
- **Reading:** WPM, words per flash, ramp-up, smart resume, punctuation pauses, long-word split, font, size, theme, pivot color, context line.
- **Voice:** read-aloud default, mode, voice per language, calibrate.
- **OCR:** languages, quality.
- **Privacy:** history on/off (off by default), clear history, update check on/off.
- **Stats:** words read, average WPM, time saved.
- **About:** version, update.

### First run
A Settings window opens on Permissions with a short explanation. After the grant, the app relaunches.
Then a **"Try it"** sample paragraph appears in the window, so the first capture isn't a mystery.

---

## 9. Permissions (macOS)

| Permission | Needed for | API | Notes |
|---|---|---|---|
| Screen Recording | every region capture | `CGPreflightScreenCaptureAccess()` / `CGRequestScreenCaptureAccess()` (3-line `extern "C"`) | The grant applies only after a **relaunch**. Deep link: `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture` |
| Accessibility | "Read selection" only (M5) | `AXIsProcessTrustedWithOptions(prompt)` | Requested only when the feature is first used. |

Dev gotchas:
- During `tauri dev`, the binary is unbundled and launched from a terminal, so TCC attributes it to the **terminal app**. Give your terminal Screen Recording.
- Bundled builds keep their grant only with a **stable code signature**. Sign local builds with your Apple Development identity (`APPLE_SIGNING_IDENTITY`), or the grant is lost on every rebuild.

---

## 10. Repository layout

```
wordstrobe/
├── PLAN.md · README.md
├── spikes/                       # measured experiments behind this plan
├── package.json                  # vite, @tauri-apps/cli, @tauri-apps/api, plugin JS bindings
├── src/                          # webview: vanilla TS, no framework
│   ├── reader.html · reader.ts · reader.css
│   ├── settings.html · settings.ts
│   ├── text.ts                   # pure: paragraphs, cleanup, tokenize, ORP, timing
│   └── text.test.ts              # node --test (Node ≥ 22.18 strips TS types natively)
├── src-tauri/
│   ├── Cargo.toml · tauri.conf.json · capabilities/{reader,settings}.json
│   ├── src/main.rs               # tray, hotkeys, windows, flow
│   ├── src/platform/macos.rs     # screencapture, permission FFI, helper client
│   └── helper/wordstrobe-ocr.swift     # Vision OCR daemon + --selftest
└── .github/workflows/{ci,release}.yml
```
Tauri plugins, each added in the milestone that first needs it: `global-shortcut`, `shell` (sidecar
only), `store`, `single-instance` (M0–M2), `autostart`, `updater`, `process` (M4), `clipboard-manager`,
`deep-link` (M5). No other runtime dependencies are planned.

---

## 11. Milestones

### M0 — Skeleton · 0.5 d
- `create-tauri-app` (vanilla-ts), menu-bar-only (`ActivationPolicy::Accessory`), tray with Quit, single-instance.
- CI on a macOS runner: `cargo clippy -D warnings`, `cargo test`, `node --test`, helper build.
- ✅ The app launches into the menu bar with no Dock icon. CI is green.

### M1 — Capture → OCR · 2 d
- Global hotkey ⌥⇧R with a busy guard.
- Permission preflight plus the Settings › Permissions panel (request, deep link, relaunch).
- Capture with `screencapture -i -x` into `$TMPDIR/wordstrobe/` (mode 0700). A missing file means cancelled. The file is always deleted after OCR.
- `wordstrobe-ocr` helper:
  - JSON-lines loop.
  - Documents path (26+) and text path (15–25).
  - Language detection, pre-warm, `--selftest`.
  - Universal build (`swiftc` arm64 + x86_64 → `lipo`) into `src-tauri/binaries/wordstrobe-ocr-universal-apple-darwin` via `beforeBuildCommand`.
- ✅ Hotkey → drag → text in the log, < 450 ms p50 from mouse-up. Esc cancels silently. A denied permission opens the panel. The selftest passes in CI.

### M2 — RSVP reader · 3 d → **v0.1 (internal)**
- `text.ts` plus tests (§5).
- Hidden pre-created popup: shimmer, placement, vibrancy, drag, remembered size.
- rAF player, all §5.6 controls, progress and time left, context line, text view, done screen.
- Settings basics: WPM, chunk, font size, theme, start delay, placement.
- ✅ A 300-word capture plays within ±3 % of the scheduled duration. No dropped or doubled words at 1000 wpm on 60 Hz and 120 Hz displays. The popup shows over a full-screen app.

### M3 — Read aloud · 1.5 d → **v0.2**
- Web Speech per paragraph, read-along and voice-only modes, voice picker, calibration, pause/seek, rate cap.
- ✅ The highlighted word changes within one frame of each boundary event. Seeking restarts speech at the new word. Verified in English plus one more language (German or Chinese).

### M4 — Ship macOS v1.0 · 2–3 d
- Full settings (hotkey recorder, launch at login, OCR options, timing multipliers), stats, first-run flow, app icon.
- Developer ID signing, notarization, universal DMG.
- `tauri-plugin-updater` against GitHub Releases (`latest.json`, signed).
- Release workflow on `v*` tags (`tauri-apps/tauri-action`).
- ✅ On a fresh Mac: DMG opens with no Gatekeeper warning → grant permission → first read in under 1 min. Auto-update from v1.0.0 to v1.0.1 works. Idle CPU is 0 %, idle RSS ≤ 120 MB (measured and recorded).

### M5 — More inputs · 2 d → v1.1
- **Read Selection ⌥⇧S:** read `AXSelectedText` from the focused element. Fallback: synthesize ⌘C and restore the clipboard. Exact text, no OCR.
- **Read Clipboard ⌥⇧V**, and drop text or images onto the popup or tray.
- `wordstrobe://read?text=…` URL scheme (Raycast, Alfred, Shortcuts) and a macOS Services menu entry, "Read with Wordstrobe".
- Opt-in local history (last 50).

### M6 — Shared region overlay · 3 d (needed for Windows and X11)
- Freeze-frame overlay:
  - Capture every display (`xcap`).
  - Show one borderless full-screen window per display with the frozen image.
  - Drag a rectangle with a magnifier and live dimensions. Mouse-up confirms, Esc cancels.
- It returns the **rect**. The popup anchors to the selection, and **Read Last Region Again** re-captures that rect without drawing.
- macOS keeps `screencapture -i` by default (setting: "System picker / Built-in overlay").

### M7 — Windows · 3–4 d · M8 — Linux · 4–5 d
See §12.

### M9+ — Smart features
See §13.

---

## 12. Cross-platform plan

| Concern | macOS | Windows | Linux X11 | Linux Wayland |
|---|---|---|---|---|
| Global hotkey | `global-shortcut` plugin (Carbon, no permission) | same (`RegisterHotKey`) | same (X grab) | **GlobalShortcuts portal** (`ashpd`; KDE, GNOME ≥ 48, Hyprland). Fallback: bind a desktop shortcut to `wordstrobe --read-region`, which single-instance forwards to the running app. |
| Region select | `screencapture -i` (or the M6 overlay) | M6 overlay | M6 overlay | **Screenshot portal** `interactive: true` (the desktop's own picker) |
| OCR | Vision via Swift sidecar | **`Windows.Media.Ocr`** in-process via `windows-rs` (Win10+, installed language packs) | **Tesseract** CLI, TSV output → `lines` | same |
| Read aloud | Web Speech ✔ *measured* | Web Speech in WebView2 (spike in M7, same as `spikes/webspeech_boundary`) | WebKitGTK speech is unreliable → **speech-dispatcher** with SSML `<mark/>` per word. Fallback: timing estimated from character count. | same |
| Read selection | AX API | UI Automation `TextPattern`, fallback Ctrl+C | **primary selection** via `arboard`, free and needs no permission | same (`wlr`/`ext` primary-selection protocol) |
| Popup placement | full control | full control | full control | **The compositor decides.** Clients can't position windows, so the popup lands in the center. |
| Packaging | notarized DMG, updater | NSIS installer, Azure Trusted Signing, updater | AppImage + .deb/.rpm (Depends: `webkit2gtk-4.1`, `tesseract-ocr`) | Flatpak later (it needs portals anyway) |

The shared TypeScript (`text.ts`, the reader, settings) doesn't change. Each port is one `platform/<os>.rs` plus packaging.

---

## 13. Further features (prioritized backlog)

| Feature | Value | Effort | When |
|---|---|---|---|
| Read selection / clipboard / drop (no OCR, exact text) | ★★★ | S | M5 |
| Text view with a moving highlight ("guided reading": the non-RSVP mode for dense text, code and tables) | ★★★ | S | M2 |
| Read last region again (rect memory) | ★★ | S | M6 |
| URL scheme, Services menu, Raycast/Alfred | ★★ | S | M5 |
| **Summarize first** via **Apple Foundation Models** (on-device LLM, macOS 26 with Apple Intelligence): TL;DR above the RSVP, or a "key sentences only" mode | ★★★ | M | v1.2 |
| **Translate, then read** via Apple's on-device Translation framework | ★★ | M | v1.2 |
| **Follow mode:** watch a region and flash new text as it appears (subtitles, chat, logs) | ★★ | M | v1.3 |
| Readability fonts (Atkinson Hyperlegible, OpenDyslexic), pivot color and guide styles, high-contrast theme | ★★ | S | v1.1 |
| Speed trainer: suggests +25 wpm after rewind-free sessions; weekly chart | ★ | S | v1.3 |
| Import PDF, EPUB, or a URL (PDFKit; Readability.js in the webview) | ★★ | M | later |
| Scrolling capture (auto-scroll and stitch long pages) | ★ | L | later |
| Comprehension check (on-device LLM writes 2 questions) | ★ | S | later |
| Links and QR codes found in a capture → clickable list | ★ | S | later |
| Accounts, sync, cloud OCR, plugin system | — | — | **never** (YAGNI; conflicts with privacy) |

---

## 14. Optimizations

1. **Pre-warm everything at launch.** Start the helper and run one blank OCR, which saves 100–200 ms of Vision cold start (*measured* 413–508 → ~300 ms). Create the reader webview hidden, so showing it is ~free.
2. **Show, then fill.** The popup appears at mouse-up and OCR lands about 300 ms later, so most of the latency is hidden.
3. **Best request per OS.** On macOS 26+, the documents request is faster than accurate text, and its paragraphs skip the heuristics.
4. **Quick mode.** `.fast` OCR (~35 ms, *measured*) as an opt-in for large or simple captures. The selftest quantifies how much accuracy it loses.
5. **Drift-free player.** Precomputed schedule, a single rAF loop, swaps aligned to frames, no allocations per frame, three `textContent` writes per word, and a fixed grid with no layout shift.
6. **Idle means nothing runs.** No timers while hidden, and the helper blocks on reading stdin. If idle RSS ever matters, add an option to stop the helper after 10 min idle at the cost of a ~500 ms cold start.
7. **Small.** Vanilla TS, only the needed plugins, target DMG < 15 MB. Long text: tokenizing is O(n) (10k words < 10 ms), and the text view uses `content-visibility: auto` instead of a virtual list.
8. **Capture I/O.** If PNG compression shows up in `capture_ms`, switch to `-t tiff`. Measure it in M1 before changing anything.

---

## 15. Privacy & security

- **On-device only.** Vision OCR and system voices. The only network call is the update check, which can be switched off. No analytics.
- **Captures** go to `$TMPDIR/wordstrobe/` (0700) and are deleted right after OCR, including on errors. They're never logged. Text lives in memory unless history is switched on (opt-in, local).
- **Tauri capabilities, least privilege per window:**
  - The reader gets event listen, hide/drag, clipboard write, and store read.
  - Settings gets store read/write, global shortcuts, and autostart.
  - The shell scope allows **only** the `wordstrobe-ocr` sidecar. `screencapture` is spawned from Rust and never exposed to JS.
- Strict CSP and no remote content.
- Hardened runtime with no extra entitlements. Not sandboxed: Mac App Store distribution would need a ScreenCaptureKit rewrite of capture.
- LLM features (backlog) are opt-in, and **on-device Foundation Models first**. Any cloud option would be a separate, explicit opt-in with a warning.

---

## 16. Testing & QA

- **Unit** (`node --test src/`, `text.ts`):
  - ORP table and delay multipliers.
  - Ramp and smart resume.
  - De-hyphenation.
  - Paragraph grouping from recorded OCR `lines` fixtures (single column, two columns, chat UI, code).
  - CJK segmentation.
  - `charIndex` → token mapping.
  - Total duration ±1 %.
- **OCR:** `wordstrobe-ocr --selftest` in CI checks character accuracy and latency.
- **Rust:** tests for popup placement and clamp math (multi-monitor, flip above).
- **Manual release checklist:**
  - Multi-monitor with mixed DPI; full-screen app Space; Stage Manager.
  - Light and dark mode.
  - Permission denied → granted → relaunch.
  - Esc mid-selection; empty region; 5k-word region.
  - Hotkey conflict; sleep/wake (hotkeys survive); `kill` the helper (it respawns).
- **Perf:** a debug log of `capture_ms`, `ocr_ms`, and `first_word_ms`, checked against §4 at every release.

---

## 17. Build & release

- **Toolchain:** Rust stable, Node ≥ 22.18, Xcode CLT (`swiftc`), `@tauri-apps/cli` v2.
- **Dev:** `npm run tauri dev`. `beforeDevCommand` builds the helper for the host architecture, then starts Vite.
- **Release:** a `v*` tag triggers GitHub Actions `tauri-apps/tauri-action` → `--target universal-apple-darwin` → sign (Developer ID Application) → notarize (App Store Connect API key) → GitHub Release with the DMG and the signed updater `latest.json`.
- **Secrets:** `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- **Costs:** Apple Developer Program $99/yr (needed for notarization). Windows code signing (Azure Trusted Signing, ~$10/mo) from M7.
- **Later:** a Homebrew cask (`brew install --cask wordstrobe`).

---

## 18. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A macOS update changes how `screencapture -i` behaves or prompts | M | M | The M6 overlay is a drop-in replacement. Smoke-test each macOS beta. |
| Newer macOS versions periodically ask again for screen-recording consent | M | L | Clear onboarding copy. Nothing technical to do. |
| WKWebView speech hides Premium/Personal voices, or boundary events regress | M | M | AVSpeech fallback in the helper with the same event shape (§6). |
| RSVP hurts comprehension on dense text | H | M | Moderate default of 350 wpm, punctuation pauses, smart resume, context line, one-key text view, table/code detection. |
| OCR errors on tiny or low-contrast text | M | M | Retina capture, accurate level, language correction. Text view lets you verify. The selftest covers the worst cases. |
| Popup hidden behind full-screen apps | M | L | `fullScreenAuxiliary` collection behavior (verify in M2). |
| Wayland limits (hotkeys, overlay, positioning) | H | M | Portals plus the CLI fallback. Center placement is accepted. |
| WebKitGTK speech missing | H | L | speech-dispatcher on Linux. |
| Debug builds lose the TCC grant | H | L (dev only) | Stable signing identity; grant the terminal during `tauri dev`. |

---

## 19. Decisions defaulted (change any by editing this file)

1. **Name:** **Wordstrobe**, bundle id `com.mahyark.wordstrobe`. As of 2026-10-07, `wordstrobe.com` and `wordstrobe.app` were unregistered, and there were no App Store or GitHub matches. A USPTO/EUIPO trademark search is still to do before M4.
2. **Hotkeys:** ⌥⇧R region · ⌥⇧S selection · ⌥⇧V clipboard. Avoids ⌘⇧2–5 (system screenshots, Xcode).
3. **Minimum macOS 15** (Sequoia); macOS 26 gets better paragraphs.
4. **Universal binary** (Apple Silicon + Intel) for v1. macOS 26 is the last release with Intel support, so Intel can be dropped in 2027.
5. **Distribution:** direct download (DMG plus auto-update), not the Mac App Store.
6. **LLM features:** on-device Apple Foundation Models only, unless a cloud option is explicitly wanted later.
7. **License / pricing:** undecided. It doesn't affect M0–M3.
