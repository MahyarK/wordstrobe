// Run with: npm test   (Node >= 22.18 strips the types natively; excluded from tsconfig)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  READ_REGION_COMMAND,
  blockBrowserShortcuts,
  engineFromUserAgent,
  fallbackInfo,
  formatAccelerator,
  initPlatform,
  isBrowserShortcut,
  keyChord,
  keyHint,
  modifier,
  osFromUserAgent,
  parsePlatformInfo,
  platform,
  setPlatform,
  spokenShortcut,
  type PlatformInfo,
} from "./os.ts";

// What each webview really sends.
const UA = {
  wkwebview: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  webview2:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  webkitgtk: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  node: "Node.js/22",
};

test("osFromUserAgent: Windows NT is windows, Linux or X11 is linux, anything else is macos", () => {
  assert.equal(osFromUserAgent(UA.webview2), "windows");
  assert.equal(osFromUserAgent(UA.webkitgtk), "linux");
  assert.equal(osFromUserAgent("Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:1.0)"), "linux");
  assert.equal(osFromUserAgent(UA.wkwebview), "macos");
  assert.equal(osFromUserAgent(UA.macChrome), "macos");
  assert.equal(osFromUserAgent(UA.node), "macos");
  assert.equal(osFromUserAgent(""), "macos");
});

test("engineFromUserAgent: Chrome/ or Edg/ is chromium, the rest is webkit", () => {
  assert.equal(engineFromUserAgent(UA.webview2), "chromium");
  assert.equal(engineFromUserAgent(UA.macChrome), "chromium");
  assert.equal(engineFromUserAgent("Mozilla/5.0 Edg/126.0.0.0"), "chromium");
  assert.equal(engineFromUserAgent(UA.wkwebview), "webkit");
  assert.equal(engineFromUserAgent(UA.webkitgtk), "webkit");
  assert.equal(engineFromUserAgent(UA.node), "webkit");
});

test("formatAccelerator: glyphs in the Mac order on macOS, names elsewhere", () => {
  assert.equal(formatAccelerator("Alt+Shift+R", "macos"), "⌥⇧R");
  assert.equal(formatAccelerator("Alt+Shift+R", "windows"), "Alt+Shift+R");
  assert.equal(formatAccelerator("Alt+Shift+R", "linux"), "Alt+Shift+R");
  assert.equal(formatAccelerator("shift+alt+r", "windows"), "Alt+Shift+R"); // case and order do not matter
  assert.equal(formatAccelerator("Control+Option+Shift+Command+K", "macos"), "⌃⌥⇧⌘K");
  assert.equal(formatAccelerator("Ctrl+Alt+Shift+Super+K", "windows"), "Ctrl+Alt+Shift+Win+K");
  assert.equal(formatAccelerator("Ctrl+Alt+Shift+Super+K", "linux"), "Ctrl+Alt+Shift+Super+K");
  assert.equal(formatAccelerator("CmdOrCtrl+Shift+Space", "macos"), "⇧⌘Space");
  assert.equal(formatAccelerator("CmdOrCtrl+Shift+Space", "windows"), "Ctrl+Shift+Space");
  assert.equal(formatAccelerator("", "windows"), "");
});

test("spokenShortcut: glyphs and plus signs become words", () => {
  assert.equal(spokenShortcut("⌥⇧R"), "Option Shift R");
  assert.equal(spokenShortcut("Alt+Shift+R"), "Alt Shift R");
});

test("keyHint and keyChord follow the OS: ⌘ on macOS, Ctrl elsewhere", () => {
  assert.equal(keyHint("macos", "C"), "⌘C");
  assert.equal(keyHint("windows", "C"), "Ctrl C");
  assert.equal(keyHint("linux", "C"), "Ctrl C");
  assert.equal(keyChord("macos", ","), "⌘,");
  assert.equal(keyChord("windows", ","), "Ctrl+,");
  assert.equal(keyChord("linux", ","), "Ctrl+,");
});

test("modifier: ⌘ is the command key on macOS, Ctrl elsewhere, and the other one is ignored", () => {
  const e = (o: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({ metaKey: false, ctrlKey: false, altKey: false, ...o });
  assert.equal(modifier("macos", e()), "none");
  assert.equal(modifier("macos", e({ metaKey: true })), "command");
  assert.equal(modifier("macos", e({ metaKey: true, ctrlKey: true })), "command");
  assert.equal(modifier("macos", e({ metaKey: true, altKey: true })), "command");
  assert.equal(modifier("macos", e({ ctrlKey: true })), "other");
  for (const os of ["windows", "linux"] as const) {
    assert.equal(modifier(os, e()), "none", os);
    assert.equal(modifier(os, e({ altKey: true })), "none", os); // Alt+arrows stay the sentence keys
    assert.equal(modifier(os, e({ ctrlKey: true })), "command", os);
    assert.equal(modifier(os, e({ metaKey: true })), "other", os); // the Windows/Super key is not Ctrl
    assert.equal(modifier(os, e({ ctrlKey: true, altKey: true })), "other", os); // AltGr types characters
  }
});

test("parsePlatformInfo: the contract passes, anything else is undefined, a bad hotkey falls back", () => {
  const ok = { os: "windows", wayland: false, hotkey: { ok: true, label: "Alt+Shift+R" }, command: "wordstrobe --read-region" };
  assert.deepEqual(parsePlatformInfo(ok), ok);
  assert.deepEqual(parsePlatformInfo({ os: "linux", wayland: true, hotkey: { ok: false, label: "Alt+Shift+R" }, command: "/opt/ws.AppImage --read-region" }), {
    os: "linux",
    wayland: true,
    hotkey: { ok: false, label: "Alt+Shift+R" },
    command: "/opt/ws.AppImage --read-region",
  });
  assert.deepEqual(parsePlatformInfo({ os: "macos", wayland: false, hotkey: { ok: true, label: "⌥⇧R" } })?.hotkey, { ok: true, label: "⌥⇧R" });
  for (const bad of [undefined, null, 7, "linux", [], {}, { os: "beos" }, { os: 1 }]) assert.equal(parsePlatformInfo(bad), undefined, JSON.stringify(bad));
  // The OS is right but the hotkey is not: default label, working
  for (const hotkey of [undefined, null, "x", {}, { ok: "yes", label: "A" }, { ok: true, label: "" }, { ok: true }]) {
    assert.deepEqual(parsePlatformInfo({ os: "windows", hotkey })?.hotkey, { ok: true, label: "Alt+Shift+R" }, JSON.stringify(hotkey));
  }
  assert.equal(parsePlatformInfo({ os: "linux", wayland: "yes", hotkey: { ok: true, label: "A" } })?.wayland, false);
});

test("parsePlatformInfo: the command is Rust's (trimmed); without one, an older backend's, it is the plain binary", () => {
  const info = (command?: unknown) => parsePlatformInfo({ os: "linux", wayland: true, hotkey: { ok: false, label: "Alt+Shift+R" }, command })?.command;
  assert.equal(info("'/home/me/Apps/Wordstrobe.AppImage' --read-region"), "'/home/me/Apps/Wordstrobe.AppImage' --read-region");
  assert.equal(info("  wordstrobe --read-region \n"), "wordstrobe --read-region");
  for (const bad of [undefined, null, "", "   ", 7, {}, ["x"]]) assert.equal(info(bad), READ_REGION_COMMAND, JSON.stringify(bad));
  assert.equal(READ_REGION_COMMAND, "wordstrobe --read-region");
});

test("fallbackInfo: the stored accelerator in the OS's words, no Wayland", () => {
  assert.deepEqual(fallbackInfo("macos"), { os: "macos", wayland: false, hotkey: { ok: true, label: "⌥⇧R" }, command: READ_REGION_COMMAND });
  assert.deepEqual(fallbackInfo("linux"), { os: "linux", wayland: false, hotkey: { ok: true, label: "Alt+Shift+R" }, command: READ_REGION_COMMAND });
  assert.equal(fallbackInfo("windows", "Ctrl+K").hotkey.label, "Ctrl+K");
});

// A key event as the webview delivers it (CDP and the browsers agree on key/code).
const ev = (key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}, code?: string) => ({
  key,
  code: code ?? (key.length === 1 ? (/\d/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`) : key),
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});
const ctrl = { ctrlKey: true };

test("isBrowserShortcut: reload, print, find, view source and friends are the browser's, with or without Shift", () => {
  for (const os of ["windows", "linux"] as const) {
    for (const key of ["F5", "F3", "F7"]) {
      assert.ok(isBrowserShortcut(os, ev(key)), `${os} ${key}`);
      assert.ok(isBrowserShortcut(os, ev(key, { shiftKey: true })), `${os} Shift+${key}`);
      assert.ok(isBrowserShortcut(os, ev(key, ctrl)), `${os} Ctrl+${key}`);
    }
    for (const letter of "fghjoprsu") {
      assert.ok(isBrowserShortcut(os, ev(letter, ctrl)), `${os} Ctrl+${letter}`);
      assert.ok(isBrowserShortcut(os, ev(letter.toUpperCase(), { ctrlKey: true, shiftKey: true })), `${os} Ctrl+Shift+${letter}`);
    }
  }
});

test("isBrowserShortcut: the app's keys and text editing are not", () => {
  for (const os of ["windows", "linux"] as const) {
    for (const k of [ev("c", ctrl), ev("C", { ctrlKey: true, shiftKey: true }), ev(",", ctrl, "Comma"), ev("a", ctrl), ev("v", ctrl), ev("x", ctrl), ev("z", ctrl)]) {
      assert.ok(!isBrowserShortcut(os, k), `${os} ${k.key}`);
    }
    for (const k of [ev(" "), ev("r"), ev("p"), ev("s"), ev("f"), ev("u"), ev("Escape"), ev("F1"), ev("F4"), ev("ArrowLeft", { altKey: true }), ev("1"), ev("5")]) {
      assert.ok(!isBrowserShortcut(os, k), `${os} ${k.key} alone`); // the reader's own R, S, 1-3 stay
    }
    assert.ok(!isBrowserShortcut(os, ev("p", { ctrlKey: true, altKey: true })), `${os} AltGr+P types a character`);
    assert.ok(!isBrowserShortcut(os, ev("r", { metaKey: true })), `${os} Win+R is the OS's`);
  }
});

test("isBrowserShortcut: on a non-Latin layout the physical key counts, like the browser's own", () => {
  assert.ok(isBrowserShortcut("windows", ev("к", ctrl, "KeyR"))); // Russian: Ctrl+К still reloads
  assert.ok(isBrowserShortcut("linux", ev("з", { ctrlKey: true, shiftKey: true }, "KeyP")));
  assert.ok(!isBrowserShortcut("windows", ev("с", ctrl, "KeyC")));
  assert.ok(!isBrowserShortcut("windows", ev("Dead", ctrl, "BracketLeft")));
});

test("isBrowserShortcut: nothing on macOS", () => {
  for (const k of [ev("F5"), ev("r", { metaKey: true }), ev("p", { metaKey: true }), ev("r", ctrl), ev("F3")]) assert.ok(!isBrowserShortcut("macos", k), k.key);
});

test("blockBrowserShortcuts: a packaged build cancels the default action of browser keys, nothing else", () => {
  const g = globalThis as Record<string, unknown>;
  const listeners: { type: string; fn: (e: unknown) => void; capture: unknown }[] = [];
  g.addEventListener = (type: string, fn: (e: unknown) => void, capture: unknown) => listeners.push({ type, fn, capture });
  const press = (k: ReturnType<typeof ev>) => {
    let prevented = false;
    for (const l of listeners) l.fn({ ...k, preventDefault: () => (prevented = true) });
    return prevented;
  };
  try {
    blockBrowserShortcuts(false); // a dev build keeps reload and DevTools
    assert.equal(listeners.length, 0);

    blockBrowserShortcuts(true);
    assert.deepEqual(listeners.map((l) => [l.type, l.capture]), [["keydown", true]]);
    setPlatform(fallbackInfo("windows"));
    assert.ok(press(ev("F5")));
    assert.ok(press(ev("R", { ctrlKey: true, shiftKey: true })));
    assert.ok(press(ev("p", ctrl)));
    assert.ok(!press(ev(" ")));
    assert.ok(!press(ev("c", ctrl)));
    assert.ok(!press(ev(",", ctrl, "Comma")));
    setPlatform(fallbackInfo("macos")); // the OS Rust reports decides, not the user agent
    assert.ok(!press(ev("F5")));
    assert.ok(!press(ev("r", { metaKey: true })));
  } finally {
    delete g.addEventListener;
    setPlatform(fallbackInfo("macos"));
  }
});

test("initPlatform: the user agent's OS first (data-os set), then Rust's answer", async () => {
  const g = globalThis as Record<string, unknown>;
  const html = { dataset: {} as Record<string, string> };
  g.document = { documentElement: html };
  try {
    const seen: [PlatformInfo, boolean][] = [];
    setPlatform(fallbackInfo("windows"));
    const answer = { os: "linux", wayland: true, hotkey: { ok: false, label: "Alt+Shift+R" }, command: "/opt/ws.AppImage --read-region" };
    await initPlatform(async (cmd) => (cmd === "platform_info" ? answer : undefined), (i, fromRust) => {
      seen.push([i, fromRust]);
      // data-os already has the value this call is about
      assert.equal(html.dataset.os, i.os);
    });
    assert.deepEqual(seen.map(([i, r]) => [i.os, r]), [["windows", false], ["linux", true]]);
    assert.deepEqual(platform(), answer);
    assert.equal(html.dataset.os, "linux");
  } finally {
    delete g.document;
  }
});

test("initPlatform: without the command, or with a wrong answer, the user agent stays", async () => {
  const seen: boolean[] = [];
  setPlatform(fallbackInfo("windows"));
  await initPlatform(() => Promise.reject(new Error("command platform_info not found")), (_i, fromRust) => seen.push(fromRust));
  assert.deepEqual(seen, [false]);
  assert.equal(platform().os, "windows");

  await initPlatform(async () => ({ os: "plan9" }), (_i, fromRust) => seen.push(fromRust));
  assert.deepEqual(seen, [false, false]);
  assert.equal(platform().os, "windows");

  await initPlatform(undefined, (_i, fromRust) => seen.push(fromRust)); // a plain browser
  assert.deepEqual(seen, [false, false, false]);
  setPlatform(fallbackInfo("macos"));
});
