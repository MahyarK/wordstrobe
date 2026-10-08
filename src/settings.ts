// Settings window (PLAN §8): Permissions, General, Reading, Voice, About.
// Values live in settings.json (@tauri-apps/plugin-store), shared with Rust and the reader popup, so this
// file only ever sets the keys it edits and never rewrites the whole store.
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";
import { formatAccelerator, initPlatform, platform, spokenShortcut, type Os, type PlatformInfo } from "./os.ts";
import {
  LIMITS,
  PLACEMENTS,
  THEMES,
  VOICE_MODES,
  normalize,
  oneOf,
  readPrefs,
  type Prefs,
} from "./prefs.ts";
import { splitOrp } from "./text.ts";

/** Outside Tauri (plain browser via `npm run dev`) the page runs on an in-memory store with no-op invokes. */
const IN_TAURI = "__TAURI_INTERNALS__" in window;

// ---------------------------------------------------------------------------------------------
// Settings model: defaults, limits and validation are shared with the reader (prefs.ts)

type Settings = Prefs;

type NumKey = "wpm" | "fontSize" | "startDelay";
type BoolKey = "smartResume" | "contextLine" | "readAloud";

const NUMERIC: Record<NumKey, { min: number; max: number; step: number; format: (n: number) => string }> = {
  wpm: { ...LIMITS.wpm, format: String },
  fontSize: { ...LIMITS.fontSize, format: (n) => `${n} px` },
  startDelay: { ...LIMITS.startDelay, format: (n) => `${n} ms` },
};

// ---------------------------------------------------------------------------------------------
// Store access

interface Kv {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
}

async function openStore(): Promise<Kv> {
  if (!IN_TAURI) {
    const memory = new Map<string, unknown>();
    return {
      get: async (key) => memory.get(key),
      set: async (key, value) => void memory.set(key, structuredClone(value)),
      save: async () => {},
    };
  }
  // Same store instance as Rust and the reader (the plugin keeps one per file), so `get` always sees their writes.
  const store = await load("settings.json");
  return {
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
    save: () => store.save(),
  };
}

let kv: Kv;
const current: Settings = normalize({});

const readAll = (): Promise<Settings> => readPrefs((key) => kv.get(key));

// Writes are queued, so a slider drag becomes a few `set` calls and one `save`. `flush` is also awaited before
// every re-read, so the page never shows a stale value over one it has not written yet.
const queued = new Map<keyof Settings, unknown>();
let flushTimer: number | undefined;
let writing: Promise<void> = Promise.resolve();

function persist<K extends keyof Settings>(key: K, value: Settings[K], now: boolean): void {
  queued.set(key, value);
  window.clearTimeout(flushTimer);
  if (now) void flush();
  else flushTimer = window.setTimeout(() => void flush(), 150);
}

function flush(): Promise<void> {
  window.clearTimeout(flushTimer);
  writing = writing.then(async () => {
    const batch = [...queued];
    queued.clear();
    if (batch.length === 0) return;
    try {
      for (const [key, value] of batch) await kv.set(key, value);
      await kv.save();
      showError(null);
    } catch (e) {
      showError(`Could not save settings: ${String(e)}`);
    }
  });
  return writing;
}

// ---------------------------------------------------------------------------------------------
// DOM helpers

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing from settings.html`);
  return element as T;
}

function radios(name: string): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${name}"]`)];
}

function showError(message: string | null): void {
  const box = $("save-error");
  box.textContent = message ?? "";
  box.hidden = message === null;
}

/** Single setter used by every control: update state, refresh dependent UI, queue the write. */
function change<K extends keyof Settings>(key: K, value: Settings[K], now = true): void {
  current[key] = value;
  renderPreview();
  persist(key, value, now);
}

// ---------------------------------------------------------------------------------------------
// Controls

const numericControls = (Object.keys(NUMERIC) as NumKey[]).map((key) => ({
  key,
  range: $<HTMLInputElement>(`${key}-range`),
  out: document.getElementById(`${key}-out`),
  box: document.getElementById(key) as HTMLInputElement | null, // number box, only for wpm
}));

function renderNumeric(key: NumKey): void {
  const control = numericControls.find((c) => c.key === key)!;
  const value = current[key];
  control.range.value = String(value);
  if (control.out) control.out.textContent = NUMERIC[key].format(value);
  if (control.box && document.activeElement !== control.box) control.box.value = String(value);
}

for (const { key, range, box } of numericControls) {
  const { min, max, step } = NUMERIC[key];
  range.addEventListener("input", () => {
    change(key, Number(range.value), false);
    renderNumeric(key);
  });
  range.addEventListener("change", () => {
    change(key, Number(range.value), true);
    renderNumeric(key);
  });
  if (box) {
    // Typing previews live when the number is valid; the value is committed (snapped to the step) on blur/Enter.
    box.addEventListener("input", () => {
      const typed = Number(box.value);
      if (box.value !== "" && Number.isFinite(typed) && typed >= min && typed <= max) {
        change(key, Math.round(typed), false);
        range.value = String(typed);
      }
    });
    box.addEventListener("change", () => {
      const typed = Number(box.value);
      const value = box.value === "" || !Number.isFinite(typed) ? current[key] : typed;
      const snapped = Math.min(max, Math.max(min, Math.round(value / step) * step));
      change(key, snapped, true);
      box.value = String(snapped);
      range.value = String(snapped);
    });
  }
}

function bindSwitch(key: BoolKey): HTMLInputElement {
  const input = $<HTMLInputElement>(key);
  input.addEventListener("change", () => change(key, input.checked));
  return input;
}
const switches = (["smartResume", "contextLine", "readAloud"] as const).map((key) => [key, bindSwitch(key)] as const);

const placementSelect = $<HTMLSelectElement>("placement");
placementSelect.addEventListener("change", () => change("placement", oneOf(placementSelect.value, PLACEMENTS, "cursor")));

for (const input of radios("wordsPerFlash")) {
  input.addEventListener("change", () => {
    if (input.checked) change("wordsPerFlash", input.value === "3" ? 3 : input.value === "2" ? 2 : 1);
  });
}
for (const input of radios("theme")) {
  input.addEventListener("change", () => {
    if (input.checked) change("theme", oneOf(input.value, THEMES, "system"));
  });
}
for (const input of radios("voiceMode")) {
  input.addEventListener("change", () => {
    if (input.checked) change("voiceMode", oneOf(input.value, VOICE_MODES, "along"));
  });
}

// ---------------------------------------------------------------------------------------------
// Platform: the shortcut row, and the words that name the machine

const hotkeyKeys = $("hotkey");
const hotkeyNote = $("hotkey-note");
const hotkeyNoteText = $("hotkey-note-text");
const hotkeyCmd = $("hotkey-cmd");
const hotkeyCopy = $("hotkey-copy");
let rustPlatform = false; // platform_info has answered: its hotkey label is the registered one

const WAYLAND_NOTE =
  "Wayland doesn't let apps register global shortcuts. Add a custom shortcut in your desktop's keyboard settings that runs:";
const TAKEN_NOTE =
  "Another app is using this shortcut, so Wordstrobe could not register it. Free it there and restart Wordstrobe.";

/** What the shortcut row shows: Rust's label once known (it is the one that was registered), else the stored accelerator. */
function renderHotkey(): void {
  const { os, wayland, hotkey } = platform();
  const label = rustPlatform ? hotkey.label : formatAccelerator(current.hotkeyRegion, os);
  // One keycap with the glyphs on macOS ("⌥⇧R"), one per key elsewhere ("Alt" "Shift" "R").
  const caps = os === "macos" ? [label] : label.split("+");
  hotkeyKeys.replaceChildren(
    ...caps.map((cap) => {
      const kbd = document.createElement("kbd");
      kbd.textContent = cap;
      return kbd;
    }),
  );
  hotkeyKeys.setAttribute("aria-label", spokenShortcut(label));
  const broken = rustPlatform && !hotkey.ok;
  hotkeyKeys.dataset.ok = String(!broken);
  hotkeyNote.hidden = !broken;
  hotkeyCmd.hidden = !(broken && wayland);
  hotkeyNoteText.textContent = broken ? (wayland ? WAYLAND_NOTE : TAKEN_NOTE) : "";
}

hotkeyCopy.addEventListener("click", async () => {
  const text = hotkeyCmd.querySelector("code")!.textContent ?? "";
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The async API can be refused; a hidden textarea and execCommand still works.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  hotkeyCopy.textContent = "Copied";
  window.setTimeout(() => (hotkeyCopy.textContent = "Copy"), 1500);
});

const DEVICE: Record<Os, string> = { macos: "Mac", windows: "PC", linux: "computer" };

function applyPlatform(_info: PlatformInfo, fromRust: boolean): void {
  rustPlatform ||= fromRust;
  $("device").textContent = DEVICE[platform().os];
  renderHotkey();
  renderVoiceHelp();
}

// Preview: one sample word with the pivot letter in red, at the chosen size and theme (PLAN §5.2).
const SAMPLE_WORD = "Wordstrobe";
const preview = $("preview");
{
  const [left, pivot, right] = splitOrp(SAMPLE_WORD);
  $("pv-l").textContent = left;
  $("pv-p").textContent = pivot;
  $("pv-r").textContent = right;
}

function renderPreview(): void {
  preview.style.fontSize = `${current.fontSize}px`;
  preview.dataset.theme = current.theme;
  preview.setAttribute("aria-label", `Preview of the reading display: the word ${SAMPLE_WORD} at ${current.fontSize} pixels`);
}

/** Push `current` into every control. Programmatic changes fire no input/change events, so nothing is written. */
function render(): void {
  for (const { key } of numericControls) renderNumeric(key);
  for (const [key, input] of switches) input.checked = current[key];
  placementSelect.value = current.placement;
  for (const input of radios("wordsPerFlash")) input.checked = input.value === String(current.wordsPerFlash);
  for (const input of radios("theme")) input.checked = input.value === current.theme;
  for (const input of radios("voiceMode")) input.checked = input.value === current.voiceMode;
  renderHotkey();
  renderPreview();
  renderVoiceSaved();
}

// ---------------------------------------------------------------------------------------------
// Voice

const voiceSelect = $<HTMLSelectElement>("voice");
const voiceTest = $<HTMLButtonElement>("voice-test");
const voiceMessage = $("voice-msg");
const synth: SpeechSynthesis | undefined = "speechSynthesis" in window ? window.speechSynthesis : undefined;

const systemLang = langPrefix(navigator.language || "en");
let voiceList: SpeechSynthesisVoice[] = [];
let voiceSignature = "";
let selectedUri = ""; // what the picker shows; "" = Automatic

function langPrefix(lang: string): string {
  return lang.split(/[-_]/)[0]!.toLowerCase();
}

function langName(prefix: string): string {
  try {
    const name = new Intl.DisplayNames([navigator.language || "en"], { type: "language" }).of(prefix) ?? prefix;
    return name.charAt(0).toLocaleUpperCase() + name.slice(1);
  } catch {
    return prefix;
  }
}

const findVoice = (uri: string): SpeechSynthesisVoice | undefined => voiceList.find((v) => v.voiceURI === uri);

function buildVoiceOptions(): void {
  const groups = new Map<string, SpeechSynthesisVoice[]>();
  for (const voice of voiceList) {
    const prefix = langPrefix(voice.lang);
    groups.set(prefix, [...(groups.get(prefix) ?? []), voice]);
  }
  const ordered = [...groups.keys()]
    .map((prefix) => ({ prefix, label: langName(prefix) }))
    .sort((a, b) => Number(b.prefix === systemLang) - Number(a.prefix === systemLang) || a.label.localeCompare(b.label));

  const options: (HTMLOptionElement | HTMLOptGroupElement)[] = [new Option("Automatic (best match)", "")];
  for (const { prefix, label } of ordered) {
    const group = document.createElement("optgroup");
    group.label = label;
    const voices = groups.get(prefix)!.sort((a, b) => a.name.localeCompare(b.name) || a.lang.localeCompare(b.lang));
    for (const voice of voices) group.append(new Option(`${voice.name} (${voice.lang})`, voice.voiceURI));
    options.push(group);
  }
  voiceSelect.replaceChildren(...options);
  syncVoiceSelect();
}

function syncVoiceSelect(): void {
  voiceSelect.value = findVoice(selectedUri) ? selectedUri : "";
  renderVoiceSaved();
}

function renderVoiceSaved(): void {
  const saved = Object.entries(current.voices);
  const names = saved.map(([prefix, uri]) => {
    const voice = findVoice(uri);
    return `${langName(prefix)} → ${voice ? voice.name : voiceList.length ? "not installed" : "…"}`;
  });
  $("voice-saved").textContent = names.length ? `Saved voices: ${names.join(" · ")}` : "No voice saved yet: the best match for the text's language is used.";
}

voiceSelect.addEventListener("change", () => {
  const voice = findVoice(voiceSelect.value);
  const voices = { ...current.voices };
  if (voice) {
    voices[langPrefix(voice.lang)] = voice.voiceURI;
  } else {
    // Automatic: forget the saved voice of the language the picker was showing (the system language when it was empty).
    const shown = findVoice(selectedUri);
    delete voices[shown ? langPrefix(shown.lang) : systemLang];
  }
  selectedUri = voice ? voice.voiceURI : "";
  change("voices", voices);
  renderVoiceSaved();
});

const SAMPLES: Record<string, string> = {
  en: "This is how Wordstrobe sounds when it reads to you.",
  de: "So klingt Wordstrobe, wenn es dir vorliest.",
  nl: "Zo klinkt Wordstrobe wanneer het je voorleest.",
  fr: "Voici comment Wordstrobe vous lit le texte.",
  es: "Así suena Wordstrobe cuando te lee el texto.",
  it: "Ecco come suona Wordstrobe quando ti legge il testo.",
  pt: "É assim que o Wordstrobe soa quando lê o texto para você.",
  zh: "这就是 Wordstrobe 朗读时的声音。",
  ja: "これが Wordstrobe の読み上げの声です。",
};

let activeTest: SpeechSynthesisUtterance | null = null;

function setTesting(utterance: SpeechSynthesisUtterance | null): void {
  activeTest = utterance;
  voiceTest.textContent = utterance ? "Stop" : "Test voice";
}

voiceTest.addEventListener("click", () => {
  if (!synth) return;
  if (activeTest) {
    synth.cancel();
    setTesting(null);
    return;
  }
  const voice = findVoice(selectedUri);
  const utterance = new SpeechSynthesisUtterance(SAMPLES[voice ? langPrefix(voice.lang) : systemLang] ?? SAMPLES.en);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else {
    utterance.lang = navigator.language || "en";
  }
  // A cancelled utterance reports its end late; only the current one may reset the button.
  const done = () => {
    if (activeTest === utterance) setTesting(null);
  };
  utterance.onend = done;
  utterance.onerror = done;
  setTesting(utterance);
  synth.speak(utterance);
});

function setVoiceMessage(text: string): void {
  voiceMessage.textContent = text;
}

const NO_VOICES: Record<Os, string> = {
  macos: "No voices found. Add voices in System Settings › Accessibility › Spoken Content, then reopen this window.",
  windows: "No voices found. Add voices in Settings › Time & language › Speech, then reopen this window.",
  linux: "No voices found. Install speech-dispatcher and a speech engine such as espeak-ng, then restart Wordstrobe.",
};
let noVoices = false; // the wait for the engine's voices is over and it listed none

/** The text depends on the OS, which may be settled after the wait is over. */
function renderVoiceHelp(): void {
  if (noVoices) setVoiceMessage(NO_VOICES[platform().os]);
}

/** `getVoices()` is empty until `voiceschanged` fires (also in WKWebView), so poll briefly and keep listening. */
function loadVoices(): boolean {
  const list = synth?.getVoices() ?? [];
  if (list.length === 0) return false;
  noVoices = false;
  const signature = list.map((v) => v.voiceURI).join("\n");
  if (signature !== voiceSignature) {
    voiceSignature = signature;
    voiceList = [...list];
    buildVoiceOptions();
  }
  voiceSelect.disabled = false;
  setVoiceMessage(`${list.length} voices installed.`);
  return true;
}

function initVoices(): void {
  if (!synth) {
    setVoiceMessage("Speech synthesis is not available in this window.");
    voiceTest.disabled = true;
    return;
  }
  synth.addEventListener("voiceschanged", () => void loadVoices());
  if (loadVoices()) return;
  const started = Date.now();
  const timer = window.setInterval(() => {
    if (loadVoices()) {
      window.clearInterval(timer);
    } else if (Date.now() - started > 4000) {
      window.clearInterval(timer);
      noVoices = true;
      renderVoiceHelp();
    }
  }, 250);
}

// ---------------------------------------------------------------------------------------------
// Permissions (unchanged behaviour: poll while visible, request, open System Settings, relaunch)

const call = <T>(command: string): Promise<T | undefined> => (IN_TAURI ? invoke<T>(command) : Promise.resolve(undefined));

const dot = $("dot");
const state = $("state");

/** Screen Recording is a macOS permission: nothing to ask elsewhere (and no such command in Rust). */
async function refreshPermission(): Promise<void> {
  if (platform().os !== "macos") return;
  const granted = (await call<boolean>("permission_status")) === true;
  const text = granted ? "Granted" : "Not granted";
  dot.dataset.ok = String(granted);
  if (state.textContent !== text) state.textContent = text;
}

$("request").addEventListener("click", async () => {
  await call("request_permission");
  await refreshPermission();
});
$("open").addEventListener("click", () => void call("open_privacy_settings"));
$("relaunch").addEventListener("click", () => void call("relaunch"));

// ---------------------------------------------------------------------------------------------
// Start-up and refresh

let voicesJson = "{}";

/** Re-read everything, e.g. after the reader changed `wpm` with ↑/↓ while this window was in the background. */
async function refresh(): Promise<void> {
  await flush();
  const fresh = await readAll();
  Object.assign(current, fresh);
  const json = JSON.stringify(current.voices);
  if (json !== voicesJson) {
    voicesJson = json;
    selectedUri = current.voices[systemLang] ?? "";
  }
  render();
  syncVoiceSelect();
  loadVoices(); // voices may have been installed meanwhile
  if (IN_TAURI) void initPlatform((command) => invoke(command), applyPlatform); // so may the shortcut have been freed
}

async function main(): Promise<void> {
  $("demo-note").hidden = IN_TAURI;
  void initPlatform(IN_TAURI ? (command) => invoke(command) : undefined, applyPlatform); // sets <html data-os> before anything awaits
  kv = await openStore();
  Object.assign(current, await readAll());
  voicesJson = JSON.stringify(current.voices);
  selectedUri = current.voices[systemLang] ?? "";
  render();
  initVoices();

  getVersionText().then((v) => ($("version").textContent = `Version ${v}`));

  // Poll the permission while the window is showing, so the dot flips right after the grant in System Settings.
  setInterval(() => {
    if (!document.hidden) void refreshPermission();
  }, 2000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      void flush();
      synth?.cancel();
      setTesting(null);
    } else {
      void refreshPermission();
      void refresh();
    }
  });
  window.addEventListener("focus", () => void refresh());
  window.addEventListener("pagehide", () => void flush());
  void refreshPermission();
}

async function getVersionText(): Promise<string> {
  if (!IN_TAURI) return "dev (demo)";
  try {
    return await getVersion();
  } catch {
    return "unknown";
  }
}

main().catch((e) => showError(`Settings could not start: ${String(e)}`));
