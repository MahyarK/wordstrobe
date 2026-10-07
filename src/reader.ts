// Wordstrobe reader popup (PLAN §5.4-5.6, §6, §8): RSVP player, text view and read-aloud.
//
// Events from Rust are untrusted-text carriers: everything OCR'd is written with textContent
// or text nodes, never as markup.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LazyStore } from "@tauri-apps/plugin-store";
import { Player } from "./player.ts";
import { DEFAULTS, LIMITS, normalize, readPrefs, type Prefs } from "./prefs.ts";
import { Speaker } from "./speech.ts";
import {
  DEFAULT_TIMING,
  factors,
  frames,
  hasPivot,
  inkLength,
  sentenceStartBefore,
  splitOrp,
  tokenize,
  toParagraphs,
  type OcrResult,
  type Token,
} from "./text.ts";

type Status = { state: "ocr" | "error"; message?: string };
type Load = OcrResult & { ms?: number; tables?: number; source?: string };
type State = "loading" | "ready" | "playing" | "paused" | "done" | "empty" | "error";
type View = "rsvp" | "text";

type Settings = Prefs;

const { min: WPM_MIN, max: WPM_MAX, step: WPM_STEP } = LIMITS.wpm;
const AVERAGE_WPM = 238; // the "saved vs" reference on the done screen

// Demo mode (plain browser via `npm run dev`): no IPC, no store, a built-in sample after 300 ms.
const TAURI = "__TAURI_INTERNALS__" in window;
const SAMPLE: Load = {
  lang: "en",
  paragraphs: [
    "Rapid serial visual presentation, or RSVP, shows words one at a time at a fixed spot on the screen. Because your eyes never have to move across the line, most of the time normally spent on tiny jumps and re-reads simply disappears.",
    "Try it at 350 words per minute, then press the up arrow to speed up. Press Space whenever you lose the thread: the sentence you were in appears under the word, and playback picks up from its start. Press S to hear the text read aloud, or T to see all of it at once.",
  ],
};

const win = TAURI ? getCurrentWebviewWindow() : undefined;
const store = TAURI ? new LazyStore("settings.json") : undefined;

// ---------------------------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $("app");
const stage = $("stage");
const wordEl = $("word");
const wordL = document.querySelector<HTMLElement>("#word .l")!;
const wordP = document.querySelector<HTMLElement>("#word .pivot")!;
const wordR = document.querySelector<HTMLElement>("#word .r")!;
const chunkEl = $("chunk");
const contextEl = $("context");
const messageEl = $("message");
const summaryEl = $("summary");
const textEl = $("text");
const statsEl = $("stats");
const toastEl = $("toast");
const barEl = document.querySelector<HTMLElement>("#bar i")!;
const speakBtn = $("btn-speak");
const mark = document.createElement("mark");

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

let state: State = "loading";
let view: View = "rsvp";
let settings: Settings = normalize();
let session = 0; // bumped by every load/status/close, so stale async work can tell it is stale
let dismissed = false; // closed with Esc while OCR was still running: the result must not play into a hidden window

let paragraphs: string[] = [];
let tokens: Token[] = [];
let tokenFactors: number[] = []; // per-token duration multipliers: the same for every Player of this text, whatever the wpm and chunk size
let lang = "en";
let player: Player | undefined;
let chunk = 1;
let shown = -1; // frame currently on screen

let raf = 0;
let startTimer = 0;
let closeTimer = 0;
let speechTimer = 0;
let toastTimer = 0;
let playingSince = 0;
let playedMs = 0;
let lastStats = "";

let speechOn = false;
let speechLive = false; // the speaker has an utterance chain going (it may be paused)
let speechRewind = false; // paused while speaking: the next play starts the sentence over (the Player does this for the schedule)

let spans: HTMLElement[] = []; // token index -> its word span in the text view
let lit: HTMLElement[] = [];
let textBuilt = false;

const speaker = new Speaker({
  word: onSpokenWord,
  end() {
    speechLive = false;
    if (state === "playing") finish();
  },
  base(voiceURI, wpm) {
    settings.voiceBaseWpm = { ...settings.voiceBaseWpm, [voiceURI]: wpm };
    persist("voiceBaseWpm", settings.voiceBaseWpm);
  },
  error(message) {
    speechLive = false;
    cancelSpeechRestart();
    setSpeech(false);
    toast(message);
    if (state === "playing" && player) {
      player.play(performance.now());
      loop();
    }
  },
});

// ---------------------------------------------------------------------------------------------
// Rust events. Registered synchronously, before anything awaits: events sent earlier are lost.
// ---------------------------------------------------------------------------------------------

const listening = win && [
  win.listen<Status>("reader:status", ({ payload }) => onStatus(payload)),
  win.listen<Load>("reader:load", ({ payload }) => void onLoad(payload)),
];
// Tells Rust that events sent from now on are delivered. Until Rust has that command the call just rejects.
void Promise.all(listening ?? []).then(() => invoke("reader_ready").catch(() => {}));
if (!TAURI) setTimeout(() => void onLoad(SAMPLE), 300);

/** Fire and forget: a failed write must not take the popup down. */
const persist = (key: string, value: unknown): void => void store?.set(key, value).catch(console.error);

const call = (cmd: string): void => {
  if (TAURI) invoke(cmd).catch(console.error);
  else console.info(`[demo] invoke ${cmd}`);
};

function onStatus(p: Status): void {
  session++;
  dismissed = false;
  stopAll();
  reset();
  if (p.state === "error") showMessage("error", p.message ?? "Something went wrong");
  focus();
}

async function onLoad(payload: Load): Promise<void> {
  if (dismissed) return;
  const id = ++session;
  stopAll();
  const s = await readSettings();
  if (id !== session) return; // a newer load, status or close came in while the store was read
  settings = s;
  applyAppearance();
  speaker.voices = s.voices;
  speaker.baseWpms = { ...s.voiceBaseWpm };

  reset();
  lang = payload.lang || "en";
  paragraphs = toParagraphs(payload);
  tokens = tokenize(paragraphs, lang);
  tokenFactors = factors(tokens, DEFAULT_TIMING);
  if (tokens.length === 0) {
    showMessage("empty", "No text found");
    closeTimer = window.setTimeout(close, 1500);
    return;
  }

  chunk = s.wordsPerFlash;
  player = makePlayer(chunk, s.wpm);
  app.toggleAttribute("data-chunk", chunk > 1);
  setSpeech(s.readAloud && speaker.supported);
  if (speechOn && s.voiceMode === "voice") setView("text");
  renderFrame(0);
  setState("ready");
  if ((payload.tables ?? 0) > 0) toast("Looks like a table. T shows the text.", 5000);
  focus();

  if (s.startDelay > 0) {
    app.style.setProperty("--delay", `${s.startDelay}ms`);
    startTimer = window.setTimeout(play, s.startDelay);
  } else play();
}

async function readSettings(): Promise<Settings> {
  if (store) return readPrefs((key) => store.get(key).catch(() => undefined));
  // Demo only: reader.html?wpm=900&startDelay=0&theme=dark&readAloud=1
  const raw: Record<string, unknown> = {};
  for (const [key, v] of new URLSearchParams(location.search)) {
    const kind = typeof (DEFAULTS as Record<string, unknown>)[key];
    if (kind === "number") raw[key] = Number(v);
    else if (kind === "boolean") raw[key] = v !== "0" && v !== "false";
    else if (kind === "string") raw[key] = v;
  }
  return normalize(raw);
}

function applyAppearance(): void {
  const theme = settings.theme === "system" ? null : settings.theme;
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  app.style.setProperty("--fs", `${settings.fontSize}px`);
  app.dataset.context = settings.contextLine ? "on" : "off";
  // Makes the window's vibrancy follow the chosen theme too (null = follow the system).
  void win?.setTheme(theme).catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// State and rendering
// ---------------------------------------------------------------------------------------------

function setState(next: State): void {
  const now = performance.now();
  if (next === "playing" && state !== "playing") playingSince = now;
  if (next !== "playing" && state === "playing") {
    playedMs += now - playingSince;
    playingSince = 0;
  }
  state = next;
  app.dataset.state = next;
  if (next === "paused" && player) renderContext(player.frames[player.frame]!);
  if (next === "done") {
    const words = tokens.length;
    const saved = (words * 60_000) / AVERAGE_WPM - playedMs;
    summaryEl.textContent =
      `${words} words · ${mmss(playedMs)}` + (saved >= 1500 ? ` · saved ~${mmss(saved)} vs ${AVERAGE_WPM} wpm` : "");
  }
  updateStats();
}

/** Back to a blank loading popup: nothing of the previous text may flash when the window reappears. */
function reset(): void {
  player = undefined;
  tokens = [];
  tokenFactors = [];
  paragraphs = [];
  shown = -1;
  playedMs = 0;
  playingSince = 0;
  speechOn = false;
  speechLive = false;
  speechRewind = false;
  textBuilt = false;
  spans = [];
  lit = [];
  textEl.replaceChildren();
  contextEl.replaceChildren();
  messageEl.textContent = "";
  toastEl.textContent = "";
  clearTimeout(toastTimer);
  statsEl.textContent = lastStats = "";
  barEl.style.setProperty("--p", "0");
  setSpeech(false);
  setView("rsvp");
  state = "loading";
  app.dataset.state = "loading";
  app.toggleAttribute("data-chunk", false);
}

function showMessage(kind: "error" | "empty", text: string): void {
  messageEl.textContent = text;
  setState(kind);
}

function makePlayer(n: number, wpm: number): Player {
  return new Player(tokens, frames(tokens, n), {
    timing: { ...DEFAULT_TIMING, wpm },
    smartResume: settings.smartResume,
    factors: tokenFactors,
  });
}

/**
 * Three textContent writes per word (one in chunk mode), no measuring. A chunk, or a word shown
 * whole (no pivot), is as wide as its text: `--n`, its rough width in characters, lets the CSS
 * shrink the font so that it fits on one line instead of wrapping or running off the stage.
 */
function renderFrame(f: number): void {
  const p = player!;
  shown = f;
  const idx = p.frames[f]!;
  if (chunk > 1) {
    const text = idx.map((i) => tokens[i]!.text).join(" ");
    chunkEl.textContent = text;
    chunkEl.style.setProperty("--n", String(inkLength(text)));
  } else {
    const text = tokens[idx[0]!]!.text;
    const [l, pivot, r] = splitOrp(text);
    wordL.textContent = l;
    wordP.textContent = pivot;
    wordR.textContent = r;
    const whole = !hasPivot(text);
    wordEl.toggleAttribute("data-nopivot", whole);
    if (whole) wordEl.style.setProperty("--n", String(inkLength(text)));
  }
  if (view === "text") highlight(idx, "nearest");
  if (state === "paused") renderContext(idx);
  updateStats();
}

/** The sentence around the frame, with its words highlighted; long sentences are cut around them. */
function renderContext(idx: number[]): void {
  if (!settings.contextLine) return;
  const first = tokens[idx[0]!]!;
  const last = tokens[idx[idx.length - 1]!]!;
  const text = paragraphs[first.para]!;
  let a = tokens[sentenceStartBefore(tokens, idx[0]!)]!.start;
  let end = idx[idx.length - 1]!;
  while (end + 1 < tokens.length && !tokens[end + 1]!.sentenceStart) end++;
  let b = tokens[end]!.end;
  let before = "";
  let after = "";
  if (b - a > 170) {
    if (first.start - 70 > a) {
      const sp = text.indexOf(" ", first.start - 70);
      a = sp >= 0 && sp < first.start ? sp + 1 : first.start - 70;
      before = "…";
    }
    if (last.end + 90 < b) {
      const sp = text.lastIndexOf(" ", last.end + 90);
      b = sp > last.end ? sp : last.end + 90;
      after = "…";
    }
  }
  mark.textContent = text.slice(first.start, last.end);
  contextEl.replaceChildren(before + text.slice(a, first.start), mark, text.slice(last.end, b) + after);
}

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function updateStats(): void {
  if (!player) return;
  barEl.style.setProperty("--p", String(state === "done" ? 1 : player.progress()));
  let text: string;
  if (state === "done") text = view === "text" ? (summaryEl.textContent ?? "") : ""; // else the done panel shows it
  else if (state === "loading" || state === "error" || state === "empty") text = "";
  else {
    let left = player.remainingMs(performance.now());
    let pace = `${Math.round(player.wpm)} wpm`;
    if (speechOn) {
      // The voice sets the pace, so time left follows its speed rather than the schedule's.
      left *= player.wpm / Math.max(60, speaker.effectiveWpm);
      pace = speaker.capped
        ? `voice capped at ${Math.round(speaker.capWpm)} wpm`
        : `voice ~${Math.round(speaker.effectiveWpm / 10) * 10} wpm`;
    }
    text = `${pace} · ${mmss(left)} left`;
  }
  if (text !== lastStats) statsEl.textContent = lastStats = text;
}

function toast(text: string, ms = 1600): void {
  toastEl.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.textContent = ""), ms);
}

// ---------------------------------------------------------------------------------------------
// Text view
// ---------------------------------------------------------------------------------------------

function setView(next: View): void {
  view = next;
  app.dataset.view = next;
  if (next === "text" && player) {
    buildText();
    highlight(player.frames[Math.max(0, shown)]!, "center");
  }
  updateStats();
}

/** Built on first use: one span per source word (the parts of a split long word share one). */
function buildText(): void {
  if (textBuilt) return;
  textBuilt = true;
  spans = new Array<HTMLElement>(tokens.length);
  let p: HTMLElement | undefined;
  let para = -1;
  let at = 0;
  let prev: Token | undefined;
  const root = document.createDocumentFragment();
  tokens.forEach((t, i) => {
    if (t.para !== para) {
      para = t.para;
      at = 0;
      prev = undefined;
      p = root.appendChild(document.createElement("p"));
      p.dir = "auto"; // Arabic and Hebrew paragraphs read right to left
    }
    if (prev && prev.start === t.start) {
      spans[i] = spans[i - 1]!;
      return;
    }
    const text = paragraphs[para]!;
    if (t.start > at) p!.append(text.slice(at, t.start));
    const span = p!.appendChild(document.createElement("span"));
    span.className = "w";
    span.dataset.i = String(i);
    span.textContent = text.slice(t.start, t.end);
    spans[i] = span;
    at = t.end;
    prev = t;
  });
  textEl.replaceChildren(root);
}

function highlight(idx: number[], scroll: ScrollLogicalPosition): void {
  if (!textBuilt) return;
  for (const el of lit) el.classList.remove("cur");
  lit = idx.map((i) => spans[i]!);
  for (const el of lit) el.classList.add("cur");
  lit[0]?.scrollIntoView({ block: scroll });
}

// ---------------------------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------------------------

/** One rAF loop, running only while the schedule is playing. */
function loop(): void {
  if (raf || !player?.playing) return;
  const tick = (t: number) => {
    raf = 0;
    const p = player;
    if (!p || state !== "playing") return;
    const f = p.tick(t);
    if (f !== shown) renderFrame(f);
    if (p.done) finish();
    else raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

function play(): void {
  const p = player;
  if (!p) return;
  clearTimeout(startTimer);
  const now = performance.now();
  if (state === "done") p.seek(0, now);
  setState("playing");
  if (speechOn) {
    const from = speechRewind && settings.smartResume ? p.rewindFrame() : p.frame;
    speechRewind = false;
    if (speechLive && from === p.frame) {
      speaker.resume();
      return;
    }
    p.seek(from, now);
    renderFrame(from);
    speakFrom();
  } else {
    p.play(now);
    if (p.frame !== shown) renderFrame(p.frame); // smart resume may have rewound
    updateStats();
    loop();
  }
}

function pause(): void {
  const p = player;
  if (!p || state !== "playing") return;
  cancelAnimationFrame(raf);
  raf = 0;
  cancelSpeechRestart(); // a restart still pending would speak into the pause
  if (speechOn) {
    speaker.pause();
    speechRewind = true;
  } else p.pause(performance.now());
  setState("paused");
  if (p.frame !== shown) renderFrame(p.frame);
}

function togglePlay(): void {
  if (state === "playing") pause();
  else if (state === "ready" || state === "paused" || state === "done") play();
}

function finish(): void {
  cancelAnimationFrame(raf);
  raf = 0;
  cancelSpeechRestart();
  speechLive = false;
  setState("done");
}

function stopAll(): void {
  clearTimeout(startTimer);
  clearTimeout(closeTimer);
  cancelSpeechRestart();
  cancelAnimationFrame(raf);
  raf = 0;
  speaker.stop();
  speechLive = false;
  player?.pause(performance.now(), false);
}

function close(): void {
  session++;
  dismissed = true;
  stopAll();
  reset();
  call("close_reader");
}

/** Moves to `frame` (user navigation: arrows, wheel, click in the text view, restart). */
function seek(frame: number): void {
  const p = player;
  if (!p) return;
  clearTimeout(startTimer);
  p.seek(frame, performance.now());
  if (state === "ready" || state === "done") setState("paused");
  renderFrame(p.frame);
  speechRewind = false;
  if (speechOn) {
    // Speech cannot jump: drop it, and start again from the new word once the user stops scrubbing.
    speaker.stop();
    speechLive = false;
    restartSpeechSoon(180);
  }
}

function seekAndPlay(token: number): void {
  if (!player) return;
  seek(player.frameOfToken(token));
  if (state !== "playing") play();
}

function setWpm(wpm: number): void {
  const p = player;
  if (!p) return;
  wpm = Math.min(WPM_MAX, Math.max(WPM_MIN, wpm));
  if (wpm === p.wpm) return;
  p.setWpm(wpm, performance.now());
  settings.wpm = wpm;
  persist("wpm", wpm);
  updateStats();
  if (speechOn && speechLive) {
    // The rate of a running utterance cannot change: restart it at the same word with the new one.
    speaker.stop();
    speechLive = false;
    restartSpeechSoon(250);
  }
}

function setChunk(n: number): void {
  const p = player;
  if (!p || n === chunk) return;
  // A speech restart that is pending (after a seek) stays armed: it looks at `player` when it fires.
  const token = p.frames[p.frame]![0]!;
  const wasPlaying = p.playing;
  const now = performance.now();
  chunk = n;
  app.toggleAttribute("data-chunk", n > 1);
  const next = makePlayer(n, p.wpm);
  next.seek(next.frameOfToken(token), now);
  player = next;
  if (wasPlaying) next.play(now);
  renderFrame(next.frame);
}

function restart(): void {
  seek(0); // while playing this keeps playing (and restarts the speech) from the top
  if (state !== "playing") play();
}

// ---------------------------------------------------------------------------------------------
// Read aloud
// ---------------------------------------------------------------------------------------------

function setSpeech(on: boolean): void {
  speechOn = on;
  speakBtn.setAttribute("aria-pressed", String(on));
}

/** Starts the voice at the frame on screen (its first word), at the current speed. */
function speakFrom(): void {
  const p = player;
  if (!p) return;
  cancelSpeechRestart();
  speechLive = true;
  void speaker.start({ paragraphs, tokens, lang }, p.frames[p.frame]![0]!, p.wpm);
}

/**
 * The voice cannot change position or speed in place, so after a seek or a speed change it is
 * restarted from the frame on screen once the user pauses for `ms`. One handle for all of it: the
 * timer is cancelled by everything that takes the voice or the playback out of the picture, and
 * when it fires it looks at the *current* player and state, never at what was true when it was set
 * (the chunk size, and with it the whole frame layout, may have changed meanwhile).
 */
function restartSpeechSoon(ms: number): void {
  cancelSpeechRestart();
  if (state !== "playing") return;
  speechTimer = window.setTimeout(() => {
    speechTimer = 0;
    if (player && state === "playing" && speechOn && !document.hidden) speakFrom();
  }, ms);
}

function cancelSpeechRestart(): void {
  clearTimeout(speechTimer);
  speechTimer = 0;
}

/** The voice drives the display: show the frame that holds the spoken word, right in the event. */
function onSpokenWord(token: number): void {
  const p = player;
  if (!p || state === "done") return;
  const f = p.frameOfToken(token);
  if (f === shown) return;
  p.seek(f, performance.now());
  renderFrame(f);
}

function toggleSpeech(): void {
  const p = player;
  if (!p) return;
  if (!speaker.supported) return toast("Read aloud is not available here");
  const now = performance.now();
  cancelSpeechRestart();
  if (speechOn) {
    speaker.stop();
    speechLive = false;
    setSpeech(false);
    if (state === "playing") {
      p.play(now);
      loop();
    }
  } else {
    setSpeech(true);
    if (settings.voiceMode === "voice") setView("text");
    if (state === "playing") {
      // Hand the schedule over to the voice, starting at the word on screen.
      cancelAnimationFrame(raf);
      raf = 0;
      p.pause(now, false);
      speakFrom();
    }
  }
  updateStats();
}

// ---------------------------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------------------------

async function copyAll(): Promise<void> {
  if (tokens.length === 0) return;
  const text = paragraphs.join("\n\n");
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // WKWebView can refuse the async API; a hidden textarea and execCommand still works.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("Copied");
}

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

/**
 * The Latin letter or digit a key stands for. The printed one when it is Latin; otherwise (Cyrillic,
 * Greek, Arabic, Hebrew layouts, AZERTY's unshifted digit row) the physical key's name, so that S, T,
 * R and 1-3 work wherever the key sits on a QWERTY keyboard. Dvorak and the like keep what is printed.
 */
function keyName(e: KeyboardEvent): string {
  if (/^[a-z0-9]$/i.test(e.key)) return e.key.toLowerCase();
  if (e.altKey || e.shiftKey) return e.key; // "ß", "!": what these typed, not a letter or a digit
  const physical = /^(?:Key([A-Z])|Digit(\d))$/.exec(e.code);
  return physical ? (physical[1] ?? physical[2]!).toLowerCase() : e.key;
}

function openSettings(): void {
  pause(); // like the button: the window that opens must not be read to
  call("open_settings");
}

function onKey(e: KeyboardEvent): void {
  if (e.metaKey) {
    if (e.key === "," || e.code === "Comma") openSettings();
    else if (keyName(e) === "c") void copyAll();
    else return;
    e.preventDefault();
    return;
  }
  if (e.ctrlKey) return;
  if (e.key === "Escape") return close();
  const p = player;
  if (!p || state === "loading" || state === "error" || state === "empty") return;

  const key = keyName(e); // " " and the arrows are not letters: they come back as e.key
  switch (key) {
    case " ":
      if (!e.repeat) togglePlay();
      break;
    case "ArrowLeft":
    case "ArrowRight": {
      const dir = e.key === "ArrowLeft" ? -1 : 1;
      seek(e.altKey ? p.sentenceFrame(p.frame, dir) : p.frame + dir);
      break;
    }
    case "ArrowUp":
    case "ArrowDown":
      setWpm(p.wpm + (e.key === "ArrowUp" ? WPM_STEP : -WPM_STEP));
      break;
    case "1":
    case "2":
    case "3":
      if (!e.repeat) setChunk(Number(key));
      break;
    default:
      if (e.altKey || e.repeat) return;
      if (key === "s") toggleSpeech();
      else if (key === "t") setView(view === "text" ? "rsvp" : "text");
      else if (key === "r") restart();
      else return;
  }
  e.preventDefault();
}

addEventListener("keydown", onKey);

let wheel = 0;
addEventListener(
  "wheel",
  (e) => {
    if (view !== "rsvp" || !player || (state !== "playing" && state !== "paused" && state !== "ready")) return;
    e.preventDefault();
    wheel += e.deltaY || e.deltaX;
    const n = Math.max(-6, Math.min(6, Math.trunc(wheel / 24)));
    if (n === 0) return;
    wheel -= n * 24;
    seek(player.frame + n);
  },
  { passive: false },
);

// Tauri's drag.js (injected for data-tauri-drag-region) turns a double press on a drag region into
// "toggle maximize": on mousedown elsewhere, on mouseup on macOS. A popup that maximizes is not
// wanted, and this window has no permission for it anyway, so the call would only be rejected.
// Those two events never get past the capture phase: drag.js listens on `document`, below this.
// Single presses, which start the drag, are left alone. So is everything drag.js ignores already:
// buttons (their own mousedown handler keeps them from taking focus) and the opted-out regions
// (the stage and the text view).
for (const type of ["mousedown", "mouseup"]) {
  addEventListener(
    type,
    (e) => {
      if ((e as MouseEvent).detail < 2 || !(e.target instanceof Element)) return;
      // null = a button without the attribute, undefined = nothing: neither is a drag region
      const region = e.target.closest("button, [data-tauri-drag-region]")?.getAttribute("data-tauri-drag-region");
      if (region != null && region !== "false") e.stopImmediatePropagation();
    },
    true,
  );
}

// The stage is both "click toggles play" and "drag moves the window". data-tauri-drag-region
// cannot do both (it starts a native drag on mousedown, so the click never arrives), which is
// why the stage opts out of it in the HTML. Here a press that travels more than 4 px starts the
// drag and anything shorter is a click. The rest of the popup (padding, footer) uses the attribute.
let press: { x: number; y: number } | undefined;
let dragged = false;
stage.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  press = { x: e.screenX, y: e.screenY };
  dragged = false;
});
addEventListener("mousemove", (e) => {
  if (!press) return;
  if (!(e.buttons & 1)) press = undefined;
  else if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
    press = undefined;
    dragged = true;
    void win?.startDragging().catch(() => {});
  }
});
addEventListener("mouseup", () => (press = undefined));
stage.addEventListener("click", (e) => {
  if (dragged) dragged = false;
  else if (!(e.target as Element).closest("button")) togglePlay();
});

textEl.addEventListener("click", (e) => {
  const word = (e.target as Element).closest<HTMLElement>(".w");
  if (word) seekAndPlay(Number(word.dataset.i));
});

// Buttons never take focus, so Space and the arrows always reach the document.
document.querySelectorAll("button").forEach((b) => b.addEventListener("mousedown", (e) => e.preventDefault()));
speakBtn.addEventListener("click", toggleSpeech);
$("btn-settings").addEventListener("click", openSettings);
$("btn-close").addEventListener("click", close);
$("replay").addEventListener("click", restart);
$("copy").addEventListener("click", () => void copyAll());
$("textview").addEventListener("click", () => setView("text"));

// Nothing may keep running in a window nobody sees.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pause();
  else dismissed = false; // the window is being shown again
});

// A failure must not leave the popup silently stuck on the shimmer.
function fail(message: string): void {
  console.error(message);
  session++;
  stopAll();
  showMessage("error", message);
}
addEventListener("error", (e) => fail(e.message));
addEventListener("unhandledrejection", (e) => {
  const message = String(e.reason?.message ?? e.reason);
  // Tauri's IPC refuses a command this window has no permission for ("... not allowed. Permissions
  // associated with this command: ..." / "... not allowed by ACL"). That is a missing capability,
  // never a reason to stop the text that is being read.
  if (/\bnot allowed\b/i.test(message)) {
    e.preventDefault();
    console.warn(message);
  } else fail(message);
});
