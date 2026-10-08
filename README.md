# Wordstrobe

Read any text on your screen faster. Press a shortcut, drag a box around text like a screenshot,
and a small popup flashes it one word at a time (Rapid Serial Visual Presentation), with optional
read-aloud. Everything runs on-device.

**Status:** v0.1 for macOS 15 or later (Apple Silicon and Intel). See [PLAN.md](PLAN.md) for the architecture, specs,
milestones and the cross-platform roadmap.

## Install

1. Download `Wordstrobe_<version>_universal.dmg` from [Releases](https://github.com/MahyarK/wordstrobe/releases/latest).
2. Open it and drag **Wordstrobe** to **Applications**.
3. Open Wordstrobe from Applications. The app isn't notarized yet, so macOS blocks the first launch:
   click **Done**, then go to **System Settings → Privacy & Security**, scroll down and click **Open Anyway**.
   Or, in Terminal:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Wordstrobe.app
   ```
4. Wordstrobe lives in the menu bar (no Dock icon) and opens **Settings** on first launch. Under
   **Permissions**, click **Request**, turn Wordstrobe on in **Privacy & Security → Screen & System Audio
   Recording**, then click **Relaunch**.

Updating: quit Wordstrobe from its menu bar icon, replace the app in Applications, and grant Screen Recording
again (toggle it off and on). Unsigned builds lose the grant on every update until the app is signed.

## Use

Press **⌥⇧R** and drag over any text. The popup appears near the cursor and starts after a short delay.

| Key | Action | Key | Action |
|---|---|---|---|
| Space / click | play / pause | ↑ / ↓ | ±25 wpm |
| ← / → | previous / next word | 1 / 2 / 3 | words per flash |
| ⌥← / ⌥→ | previous / next sentence | S | read aloud |
| R | restart | T | full text (click a word to jump) |
| ⌘C | copy the text | ⌘, | settings |
| Esc | close | | |

## Build

Needs Xcode 26 or later (the OCR helper uses the macOS 26 SDK), Rust and Node 22.18 or later.

```bash
npm install
```

```bash
npm run tauri dev
```

`npm test` runs the TypeScript tests, `cargo test --manifest-path src-tauri/Cargo.toml` the Rust ones, and
`src-tauri/binaries/wordstrobe-ocr-aarch64-apple-darwin --selftest` the OCR checks. A universal DMG:

```bash
npm run tauri build -- --target universal-apple-darwin --bundles dmg
```

## Spikes

The numbers in the plan come from these. Both need macOS 26 and Xcode:

```bash
swiftc -O -o /tmp/ocr_latency spikes/ocr_latency.swift && /tmp/ocr_latency
```

```bash
swiftc -O -o /tmp/webspeech spikes/webspeech_boundary.swift && /tmp/webspeech
```
