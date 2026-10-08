// Which OS the webview runs on, and the few things in the frontend that follow from it: the command
// modifier, how shortcuts are written, the state of the global hotkey (PLAN §12).
//
// The user agent answers first, synchronously, so that the first paint already has the right look;
// Rust's `platform_info` then settles it (and adds what the user agent cannot know: whether the
// hotkey could be registered, whether this is Wayland, which command starts a region read). Without
// that command (a browser, an older build) the user agent stays the answer.
//
// DOM-free apart from the `data-os` attribute and one key listener, and erasable TypeScript only: it
// runs under `node --test` as well.
import { DEFAULTS } from "./prefs.ts";

export type Os = "macos" | "windows" | "linux";
/** The speech and rendering engine: WKWebView and WebKitGTK are "webkit", WebView2 is "chromium". */
export type Engine = "webkit" | "chromium";

export type PlatformInfo = {
  os: Os;
  /** A Wayland session: apps cannot register global shortcuts there. */
  wayland: boolean;
  /** The region shortcut: whether Rust could register it, and its label, already formatted for the OS. */
  hotkey: { ok: boolean; label: string };
  /** The full command that a desktop shortcut (Wayland) has to run to start a region read. */
  command: string;
};

/** The command when Rust does not say: right for an installed binary on the PATH, wrong for an AppImage. */
export const READ_REGION_COMMAND = "wordstrobe --read-region";

export const osFromUserAgent = (ua: string): Os =>
  /Windows NT/i.test(ua) ? "windows" : /Linux|X11/.test(ua) ? "linux" : "macos";

/** WebView2 says `Chrome/` and `Edg/`; WKWebView and WebKitGTK say neither. */
export const engineFromUserAgent = (ua: string): Engine => (/Chrome\/|Edg\//.test(ua) ? "chromium" : "webkit");

// ---------------------------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------------------------

/**
 * "Alt+Shift+R" as the OS writes it: "⌥⇧R" on macOS (modifiers in the Mac order), "Alt+Shift+R"
 * elsewhere (Ctrl, Alt, Shift, then Win or Super). `CmdOrCtrl` is ⌘ on macOS and Ctrl elsewhere.
 */
export function formatAccelerator(accelerator: string, os: Os): string {
  const held = { ctrl: false, alt: false, shift: false, meta: false };
  let key = "";
  for (const part of accelerator.split("+").map((p) => p.trim()).filter(Boolean)) {
    if (/^(ctrl|control)$/i.test(part)) held.ctrl = true;
    else if (/^(alt|option)$/i.test(part)) held.alt = true;
    else if (/^shift$/i.test(part)) held.shift = true;
    else if (/^(cmd|command|super|meta)$/i.test(part)) held.meta = true;
    else if (/^(cmdorctrl|commandorcontrol)$/i.test(part)) held[os === "macos" ? "meta" : "ctrl"] = true;
    else key ||= part;
  }
  if (key.length === 1) key = key.toUpperCase();
  if (os === "macos") return (held.ctrl ? "⌃" : "") + (held.alt ? "⌥" : "") + (held.shift ? "⇧" : "") + (held.meta ? "⌘" : "") + key;
  const names = [held.ctrl && "Ctrl", held.alt && "Alt", held.shift && "Shift", held.meta && (os === "windows" ? "Win" : "Super"), key];
  return names.filter(Boolean).join("+");
}

/** A shortcut label for a screen reader: "⌥⇧R" -> "Option Shift R", "Alt+Shift+R" -> "Alt Shift R". */
export function spokenShortcut(label: string): string {
  const names: Record<string, string> = { "⌃": "Control ", "⌥": "Option ", "⇧": "Shift ", "⌘": "Command " };
  return label.replace(/[⌃⌥⇧⌘]/g, (m) => names[m]!).replace(/\+/g, " ").trim();
}

/** The command modifier plus `key`, as printed on a keycap in the UI: "⌘C", "Ctrl C". */
export const keyHint = (os: Os, key: string): string => (os === "macos" ? `⌘${key}` : `Ctrl ${key}`);

/** The same for a tooltip: "⌘,", "Ctrl+,". */
export const keyChord = (os: Os, key: string): string => (os === "macos" ? `⌘${key}` : `Ctrl+${key}`);

type Mods = { metaKey: boolean; ctrlKey: boolean; altKey: boolean };

/**
 * The shortcut modifier of a key event: ⌘ on macOS, Ctrl elsewhere ("command"). Any other modifier
 * that makes a key something else than a plain key is "other": Ctrl on macOS, the Windows/Super key
 * elsewhere, and AltGr, which Windows reports as Ctrl+Alt and which types characters rather than
 * commands.
 */
export function modifier(os: Os, e: Mods): "command" | "other" | "none" {
  if (os === "macos") return e.metaKey ? "command" : e.ctrlKey ? "other" : "none";
  if (e.metaKey || (e.ctrlKey && e.altKey)) return "other";
  return e.ctrlKey ? "command" : "none";
}

type KeyEventLike = Mods & { key: string; code: string };

/**
 * A key the browser underneath handles by itself, which a popup or an overlay must not pass on: reload
 * (F5, Ctrl+R, Ctrl+Shift+R), print (Ctrl+P), find (Ctrl+F, Ctrl+G, F3), caret browsing (F7), view
 * source (Ctrl+U), save, open, history and downloads (Ctrl+S, O, H, J). Shift makes no difference.
 * WebView2 leaves all of these on and Tauri does not turn them off; WebKitGTK has none of its own, but
 * the answer is the same there. macOS has none either. The letter is the one the key stands for, as
 * the browser reads it: the printed one on a Latin layout, the physical key on any other.
 */
export function isBrowserShortcut(os: Os, e: KeyEventLike): boolean {
  if (os === "macos") return false;
  if (/^F(3|5|7)$/.test(e.key)) return true;
  if (modifier(os, e) !== "command") return false;
  const letter = /^[a-z]$/i.test(e.key) ? e.key : (/^Key([A-Z])$/.exec(e.code)?.[1] ?? "");
  return /^[fghjoprsu]$/i.test(letter);
}

/**
 * Once at startup of each page: in a packaged build (`packaged` is Vite's `import.meta.env.PROD`),
 * stops the browser's own shortcuts (`isBrowserShortcut`) from doing anything. The page's own keys are
 * not touched: this only cancels the default action, other listeners still see the event. A dev build
 * keeps them, for reloading and for DevTools.
 */
export function blockBrowserShortcuts(packaged: boolean): void {
  if (!packaged || typeof addEventListener === "undefined") return;
  addEventListener("keydown", (e) => isBrowserShortcut(platform().os, e) && e.preventDefault(), true);
}

// ---------------------------------------------------------------------------------------------
// Platform info
// ---------------------------------------------------------------------------------------------

/** What is known without asking Rust: the user agent's OS, the default hotkey, no Wayland. */
export function fallbackInfo(os: Os, accelerator: string = DEFAULTS.hotkeyRegion): PlatformInfo {
  return { os, wayland: false, hotkey: { ok: true, label: formatAccelerator(accelerator, os) }, command: READ_REGION_COMMAND };
}

/** Rust's answer, checked: anything that is not the contract is `undefined` (and the user agent stays). */
export function parsePlatformInfo(raw: unknown): PlatformInfo | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.os !== "macos" && r.os !== "windows" && r.os !== "linux") return undefined;
  const hk = r.hotkey as Record<string, unknown> | null | undefined;
  const hotkey =
    typeof hk === "object" && hk !== null && typeof hk.ok === "boolean" && typeof hk.label === "string" && hk.label !== ""
      ? { ok: hk.ok, label: hk.label }
      : fallbackInfo(r.os).hotkey;
  const command = typeof r.command === "string" && r.command.trim() !== "" ? r.command.trim() : READ_REGION_COMMAND;
  return { os: r.os, wayland: r.wayland === true, hotkey, command };
}

let info: PlatformInfo = fallbackInfo(osFromUserAgent(typeof navigator === "undefined" ? "" : navigator.userAgent));

/** The platform as far as it is known right now. */
export const platform = (): PlatformInfo => info;

export function setPlatform(next: PlatformInfo): void {
  info = next;
  if (typeof document !== "undefined") document.documentElement.dataset.os = next.os;
}

/**
 * Once at startup of each page: sets `data-os` on <html> from the user agent, tells `onChange` (so the
 * page can write its labels), then asks Rust and tells `onChange` again if that gave an answer.
 * `fromRust` is false for the first call. Never rejects.
 */
export async function initPlatform(
  invoke: ((command: string) => Promise<unknown>) | undefined,
  onChange: (info: PlatformInfo, fromRust: boolean) => void,
): Promise<void> {
  setPlatform(info);
  onChange(info, false);
  if (!invoke) return;
  try {
    const answer = parsePlatformInfo(await invoke("platform_info"));
    if (!answer) return;
    setPlatform(answer);
    onChange(answer, true);
  } catch {
    // Rust without the command: the user agent has to do
  }
}
