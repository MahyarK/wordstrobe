// Run with: npm test   (Node >= 22.18 strips the types natively; excluded from tsconfig)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  engineFromUserAgent,
  fallbackInfo,
  formatAccelerator,
  initPlatform,
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
  const ok = { os: "windows", wayland: false, hotkey: { ok: true, label: "Alt+Shift+R" } };
  assert.deepEqual(parsePlatformInfo(ok), ok);
  assert.deepEqual(parsePlatformInfo({ os: "linux", wayland: true, hotkey: { ok: false, label: "Alt+Shift+R" } }), {
    os: "linux",
    wayland: true,
    hotkey: { ok: false, label: "Alt+Shift+R" },
  });
  assert.deepEqual(parsePlatformInfo({ os: "macos", wayland: false, hotkey: { ok: true, label: "⌥⇧R" } })?.hotkey, { ok: true, label: "⌥⇧R" });
  for (const bad of [undefined, null, 7, "linux", [], {}, { os: "beos" }, { os: 1 }]) assert.equal(parsePlatformInfo(bad), undefined, JSON.stringify(bad));
  // The OS is right but the hotkey is not: default label, working
  for (const hotkey of [undefined, null, "x", {}, { ok: "yes", label: "A" }, { ok: true, label: "" }, { ok: true }]) {
    assert.deepEqual(parsePlatformInfo({ os: "windows", hotkey })?.hotkey, { ok: true, label: "Alt+Shift+R" }, JSON.stringify(hotkey));
  }
  assert.equal(parsePlatformInfo({ os: "linux", wayland: "yes", hotkey: { ok: true, label: "A" } })?.wayland, false);
});

test("fallbackInfo: the stored accelerator in the OS's words, no Wayland", () => {
  assert.deepEqual(fallbackInfo("macos"), { os: "macos", wayland: false, hotkey: { ok: true, label: "⌥⇧R" } });
  assert.deepEqual(fallbackInfo("linux"), { os: "linux", wayland: false, hotkey: { ok: true, label: "Alt+Shift+R" } });
  assert.equal(fallbackInfo("windows", "Ctrl+K").hotkey.label, "Ctrl+K");
});

test("initPlatform: the user agent's OS first (data-os set), then Rust's answer", async () => {
  const g = globalThis as Record<string, unknown>;
  const html = { dataset: {} as Record<string, string> };
  g.document = { documentElement: html };
  try {
    const seen: [PlatformInfo, boolean][] = [];
    setPlatform(fallbackInfo("windows"));
    const answer = { os: "linux", wayland: true, hotkey: { ok: false, label: "Alt+Shift+R" } };
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
