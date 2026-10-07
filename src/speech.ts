// Read aloud on the Web Speech API (PLAN §6): per-paragraph utterances, word boundaries mapped
// back to tokens, and a voice speed that calibrates itself while it speaks.
import { BASE_WPM } from "./prefs.ts";
import { tokenAtChar, type Token } from "./text.ts";

/** Words per minute a voice speaks at rate 1, until it has been measured. */
export const DEFAULT_BASE_WPM = 200;
const MIN_RATE = 0.5;
const MAX_RATE = 2;
// PLAN §6 caps the voice at twice its normal speed ("voice capped at N wpm"), the point where it
// stops being intelligible. Counted in speed, not in `rate`, see CURVE.
const MAX_SPEEDUP = 2;

// WebKit's `utterance.rate` is nowhere near linear: measured in WKWebView on macOS 26 with
// Samantha, Daniel and Anna (28 silent words each), rate 1.5 speaks 2.5x as fast as rate 1 and
// rate 2 speaks 4.2x as fast, while rate 0.5 only slows down to 0.78x. The three voices agree
// within 5 %. [rate, speed relative to rate 1], piecewise linear in between.
// ponytail: other engines (WebView2, speech-dispatcher) get this curve until M7/M8 measure theirs;
// the calibration below corrects a wrong curve over a few utterances.
const CURVE: [number, number][] = [
  [0.5, 0.775],
  [1, 1],
  [1.5, 2.55],
  [2, 4.2],
];

/** Speed of a voice at `rate`, relative to rate 1. */
export function speedAt(rate: number): number {
  return interpolate(CURVE, rate, 0, 1);
}

/** The rate that makes a voice `speed` times as fast as at rate 1 (clamped to what the engine allows). */
export function rateFor(speed: number): number {
  return interpolate(CURVE, speed, 1, 0);
}

function interpolate(points: [number, number][], x: number, from: 0 | 1, to: 0 | 1): number {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (x <= first[from]) return first[to];
  if (x >= last[from]) return last[to];
  const i = points.findIndex((p) => p[from] >= x);
  const [a, b] = [points[i - 1]!, points[i]!];
  return a[to] + ((b[to] - a[to]) * (x - a[from])) / (b[from] - a[from]);
}

// Self-calibration (replaces the plan's blocking 30-word calibration run). A voice speaks at
// `baseWpm * speedAt(rate)`; every utterance times its boundary events and nudges `baseWpm`
// toward what it saw. A sample counts only with this many words over this long.
const MIN_SAMPLE_WORDS = 8;
const MIN_SAMPLE_MS = 2500;
const SMOOTHING = 0.3;
// A voice with no saved base speed is restarted once, mid-sentence, when its first sample says
// the guess was off by more than this, so the first listen is already at the right speed.
const RETUNE = 0.15;
// A voice that is listed but not installed accepts speak() and then says nothing, with no error.
const START_TIMEOUT_MS = 5000;

export type SpeechText = { paragraphs: string[]; tokens: Token[]; lang: string };

export type SpeakerHooks = {
  /** A word is being spoken: index into `tokens`. */
  word(token: number): void;
  /** All paragraphs have been spoken. */
  end(): void;
  /** The measured base speed of a voice changed: persist it. */
  base(voiceURI: string, wpm: number): void;
  error(message: string): void;
};

export const langPrefix = (lang: string): string => lang.split(/[-_]/)[0]!.toLowerCase();

// ---------------------------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------------------------

let known: SpeechSynthesisVoice[] = [];
if (typeof speechSynthesis !== "undefined") {
  speechSynthesis.addEventListener("voiceschanged", () => (known = speechSynthesis.getVoices()));
  // The popup is created at app launch, long before anyone presses S: the first load takes ~2 s.
  known = speechSynthesis.getVoices();
}

/**
 * `getVoices()` is empty until `voiceschanged` fires (verified in WKWebView; the first call is
 * also what starts the load). Resolves with whatever exists after `timeoutMs`, possibly nothing.
 */
export function loadVoices(timeoutMs = 2000): Promise<SpeechSynthesisVoice[]> {
  if (known.length === 0) known = speechSynthesis.getVoices();
  if (known.length > 0) return Promise.resolve(known);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      speechSynthesis.removeEventListener("voiceschanged", done);
      resolve((known = speechSynthesis.getVoices()));
    };
    const timer = setTimeout(done, timeoutMs);
    speechSynthesis.addEventListener("voiceschanged", done);
  });
}

// WKWebView on macOS lists 68 voices, every one with default = true: the novelty ones (Albert,
// Bad News, Zarvox, ...) and the robotic Fred/Ralph are the legacy "speech.synthesis.voice"
// family, while real voices say how good they are in their URI (com.apple.voice.premium.en-US.Zoe,
// ...enhanced..., ...compact..., ...super-compact...). Names are checked too for other platforms.
const LEGACY = /^com\.apple\.speech\.synthesis\.voice\./;

function score(v: SpeechSynthesisVoice): number {
  const id = `${v.voiceURI} ${v.name}`;
  let s = /premium/i.test(id) ? 4 : /enhanced/i.test(id) ? 3 : /super-compact/i.test(id) ? 0 : 1;
  if (!v.localService) s -= 20; // a network voice would send the text off the machine (PLAN §15)
  if (LEGACY.test(v.voiceURI)) s -= 10;
  return s;
}

/**
 * The saved voice for the language (`stored[langPrefix]` = voiceURI), else the best local voice
 * for it (Premium, then Enhanced, then any local one), else the system default.
 */
export function pickVoice(
  lang: string,
  voices: SpeechSynthesisVoice[],
  stored: Record<string, string> = {},
): SpeechSynthesisVoice | undefined {
  const prefix = langPrefix(lang || "en");
  const saved = voices.find((v) => v.voiceURI === stored[prefix]);
  if (saved) return saved;
  let best: SpeechSynthesisVoice | undefined;
  for (const v of voices) {
    if (langPrefix(v.lang) !== prefix) continue;
    if (!best || score(v) > score(best)) best = v;
  }
  return best ?? voices.find((v) => v.default) ?? voices[0];
}

// ---------------------------------------------------------------------------------------------
// Speaker
// ---------------------------------------------------------------------------------------------

export class Speaker {
  readonly supported = typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";
  /** Settings the owner refreshes on every load: voice per language prefix, measured base wpm per voice. */
  voices: Record<string, string> = {};
  baseWpms: Record<string, number> = {};

  voice: SpeechSynthesisVoice | undefined;
  /** Speed of the voice at rate 1, in words per minute. */
  baseWpm = DEFAULT_BASE_WPM;
  /** The `utterance.rate` of the current utterance. */
  rate = 1;

  private hooks: SpeakerHooks;
  private text: SpeechText | undefined;
  private target = 350;
  private key = "";
  private calibrated = false;
  private paused = false;
  private sample: { n: number; t0: number; last: number } | undefined;
  private watchdog = 0;
  /** Arms the start watchdog again for the current utterance, if it has not said a word yet (see resume()). */
  private rearm: (() => void) | undefined;
  /** Bumped by every start/stop; events of an older generation are stale (cancel() delivers them late). */
  private gen = 0;

  constructor(hooks: SpeakerHooks) {
    this.hooks = hooks;
  }

  /** The fastest target the voice is allowed to reach. */
  get capWpm(): number {
    return this.baseWpm * MAX_SPEEDUP;
  }

  get capped(): boolean {
    return this.target > this.capWpm + 0.5;
  }

  /** What the listener actually gets. */
  get effectiveWpm(): number {
    return this.baseWpm * speedAt(this.rate);
  }

  /** Speaks from token `from` to the end, one utterance per paragraph. Replaces any current speech. */
  async start(text: SpeechText, from: number, wpm: number): Promise<void> {
    const gen = this.halt();
    this.paused = false;
    if (!this.supported) return this.hooks.error("Read aloud is not available here");
    const voices = await loadVoices();
    if (gen !== this.gen) return;

    this.text = text;
    this.target = wpm;
    this.voice = pickVoice(text.lang, voices, this.voices);
    this.key = this.voice?.voiceURI ?? `default:${langPrefix(text.lang)}`;
    this.calibrated = this.baseWpms[this.key] !== undefined;
    this.baseWpm = this.baseWpms[this.key] ?? DEFAULT_BASE_WPM;

    const token = text.tokens[from];
    if (!token) return this.hooks.end();
    this.speak(token.para, token.start, gen);
  }

  pause(): void {
    if (!this.supported) return;
    this.paused = true;
    speechSynthesis.pause();
    this.commit(); // time spent paused would ruin the sample
  }

  resume(): void {
    if (!this.supported) return;
    this.paused = false;
    speechSynthesis.resume();
    this.rearm?.(); // the watchdog skips a paused speaker, so it may have lapsed meanwhile
  }

  stop(): void {
    this.halt();
    this.paused = false;
  }

  private halt(): number {
    this.commit();
    clearTimeout(this.watchdog);
    this.rearm = undefined;
    if (this.supported) {
      speechSynthesis.cancel();
      if (speechSynthesis.paused) speechSynthesis.resume(); // cancel() leaves a paused synth paused
    }
    return ++this.gen;
  }

  private speak(para: number, from: number, gen: number): void {
    const text = this.text!;
    while (para < text.paragraphs.length && text.paragraphs[para]!.slice(from).trim() === "") {
      para++;
      from = 0;
    }
    if (para >= text.paragraphs.length) {
      this.commit();
      return this.hooks.end();
    }

    this.rate = Math.min(MAX_RATE, Math.max(MIN_RATE, rateFor(Math.min(MAX_SPEEDUP, this.target / this.baseWpm))));
    const u = new SpeechSynthesisUtterance(text.paragraphs[para]!.slice(from));
    if (this.voice) u.voice = this.voice;
    u.lang = this.voice?.lang ?? text.lang;
    u.rate = this.rate;
    let started = false;
    const arm = () => {
      clearTimeout(this.watchdog);
      this.watchdog = window.setTimeout(() => {
        if (gen !== this.gen || started || this.paused) return; // resume() arms it again
        this.stop();
        this.hooks.error("The voice did not start");
      }, START_TIMEOUT_MS);
    };
    const heard = () => {
      started = true;
      clearTimeout(this.watchdog);
    };
    this.rearm = () => {
      if (!started) arm();
    };
    arm();
    u.onstart = () => {
      if (gen === this.gen) heard();
    };
    let lastChar = -1;
    u.onboundary = (e) => {
      if (gen === this.gen) heard();
      if (gen !== this.gen || e.name !== "word") return;
      // WKWebView sometimes delivers the last event of a cancelled utterance to the next one (seen
      // in Japanese after a restart): its offset is past the end of the new text or goes backwards.
      if (e.charIndex >= u.text.length || e.charIndex < lastChar) return;
      lastChar = e.charIndex;
      const token = tokenAtChar(text.tokens, para, from + e.charIndex);
      if (token >= 0) this.hooks.word(token);
      this.observe(token);
    };
    u.onend = () => {
      if (gen !== this.gen) return;
      heard();
      this.commit();
      this.speak(para + 1, 0, gen);
    };
    u.onerror = (e) => {
      if (gen !== this.gen) return;
      heard();
      if (e.error === "canceled" || e.error === "interrupted") return;
      this.hooks.error(`Speech failed (${e.error})`);
    };
    speechSynthesis.speak(u);
    if (this.paused) speechSynthesis.pause(); // paused while the voices were loading
  }

  private observe(token: number): void {
    const now = performance.now();
    const s = (this.sample ??= { n: 0, t0: now, last: now });
    s.n++;
    s.last = now;
    if (this.calibrated || s.n < MIN_SAMPLE_WORDS || now - s.t0 < MIN_SAMPLE_MS) return;
    const before = this.baseWpm;
    this.commit();
    const t = this.text!.tokens[token];
    if (t && Math.abs(this.baseWpm / before - 1) > RETUNE) {
      const gen = ++this.gen; // the old utterance's events are stale from here on
      speechSynthesis.cancel();
      this.speak(t.para, t.start, gen); // same word, new rate
    }
  }

  /** Folds the timing sample into `baseWpm` and reports it. */
  private commit(): void {
    const s = this.sample;
    this.sample = undefined;
    if (!s || s.n < MIN_SAMPLE_WORDS || s.last - s.t0 < MIN_SAMPLE_MS) return;
    const estimate = Math.min(BASE_WPM.max, Math.max(BASE_WPM.min, ((s.n - 1) * 60_000) / (s.last - s.t0) / speedAt(this.rate)));
    this.baseWpm = this.calibrated ? this.baseWpm * (1 - SMOOTHING) + estimate * SMOOTHING : estimate;
    this.calibrated = true;
    this.baseWpms[this.key] = Math.round(this.baseWpm);
    this.hooks.base(this.key, this.baseWpms[this.key]!);
  }
}
