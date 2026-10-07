// Run with: npm test   (Node >= 22.18 strips the types natively; excluded from tsconfig)
// speech.ts only touches the Web Speech API inside methods, so a scripted speechSynthesis on
// globalThis is enough to drive a Speaker here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BASE_WPM, Speaker, pickVoice, rateFor, speedAt } from "./speech.ts";
import { tokenize } from "./text.ts";

const approx = (actual: number, expected: number, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`);

// ---------------------------------------------------------------------------------------------
// rate curve
// ---------------------------------------------------------------------------------------------

test("speedAt: the measured WebKit curve, flat outside its ends", () => {
  approx(speedAt(1), 1);
  approx(speedAt(0.5), 0.775);
  approx(speedAt(1.5), 2.55);
  approx(speedAt(2), 4.2);
  approx(speedAt(0.1), 0.775);
  approx(speedAt(10), 4.2);
  assert.ok(Math.abs(speedAt(1.2) - 1.62) < 0.05); // measured 1.61
  assert.ok(Math.abs(speedAt(1.8) - 3.57) < 0.1); // measured 3.64
});

test("rateFor inverts speedAt and stays inside the engine's range", () => {
  for (const r of [0.5, 0.7, 1, 1.1, 1.3, 1.5, 1.77, 2]) approx(rateFor(speedAt(r)), r, 1e-9);
  approx(rateFor(0.1), 0.5);
  approx(rateFor(99), 2);
  let last = 0;
  for (let s = 0.8; s <= 4.2; s += 0.1) {
    const r = rateFor(s);
    assert.ok(r >= last);
    last = r;
  }
});

// ---------------------------------------------------------------------------------------------
// pickVoice
// ---------------------------------------------------------------------------------------------

const voice = (name: string, lang: string, voiceURI: string, o: Partial<SpeechSynthesisVoice> = {}) =>
  ({ name, lang, voiceURI, localService: true, default: true, ...o }) as SpeechSynthesisVoice;

// What WKWebView on macOS 26 lists: every voice says default = true.
const macVoices = [
  voice("Albert", "en-US", "com.apple.speech.synthesis.voice.Albert"),
  voice("Fred", "en-US", "com.apple.speech.synthesis.voice.Fred"),
  voice("Samantha", "en-US", "com.apple.voice.compact.en-US.Samantha"),
  voice("Daniel", "en-GB", "com.apple.voice.super-compact.en-GB.Daniel"),
  voice("Anna", "de-DE", "com.apple.voice.compact.de-DE.Anna"),
  voice("Tingting", "zh-CN", "com.apple.voice.super-compact.zh-CN.Tingting"),
];

test("pickVoice: a real voice beats novelty and legacy voices that claim to be the default", () => {
  assert.equal(pickVoice("en", macVoices)?.name, "Samantha");
  assert.equal(pickVoice("en-US", macVoices)?.name, "Samantha");
  assert.equal(pickVoice("en_GB", macVoices)?.name, "Samantha"); // same language prefix: quality decides
  assert.equal(pickVoice("de", macVoices)?.name, "Anna");
  assert.equal(pickVoice("zh-Hans", macVoices)?.name, "Tingting");
});

test("pickVoice: Premium, then Enhanced, then compact, then super-compact; local over remote", () => {
  const list = [
    voice("Daniel", "en-GB", "com.apple.voice.super-compact.en-GB.Daniel"),
    voice("Samantha", "en-US", "com.apple.voice.compact.en-US.Samantha"),
    voice("Ava (Enhanced)", "en-US", "com.apple.voice.enhanced.en-US.Ava"),
  ];
  assert.equal(pickVoice("en", list)?.name, "Ava (Enhanced)");
  assert.equal(pickVoice("en", [...list, voice("Zoe (Premium)", "en-US", "com.apple.voice.premium.en-US.Zoe")])?.name, "Zoe (Premium)");
  const remote = [voice("Remote Premium", "en-US", "r", { localService: false }), voice("Local", "en-US", "l")];
  assert.equal(pickVoice("en", remote)?.name, "Local");
});

test("pickVoice: the saved voice for the language wins; unknown ids and languages fall back", () => {
  assert.equal(pickVoice("en", macVoices, { en: "com.apple.voice.super-compact.en-GB.Daniel" })?.name, "Daniel");
  assert.equal(pickVoice("en", macVoices, { de: "com.apple.voice.compact.de-DE.Anna" })?.name, "Samantha");
  assert.equal(pickVoice("en", macVoices, { en: "gone" })?.name, "Samantha");
  assert.ok(pickVoice("sv", macVoices)); // no Swedish voice: the first default one
  assert.equal(pickVoice("en", []), undefined);
});

// ---------------------------------------------------------------------------------------------
// Speaker, against a scripted speechSynthesis
// ---------------------------------------------------------------------------------------------

type Utterance = {
  text: string;
  rate: number;
  voice?: SpeechSynthesisVoice;
  lang: string;
  onstart?: () => void;
  onboundary?: (e: { name: string; charIndex: number }) => void;
  onend?: () => void;
  onerror?: (e: { error: string }) => void;
};

const g = globalThis as Record<string, unknown>;
let clock = 0;
let spoken: Utterance[] = [];
let synthState = { paused: false, cancels: 0, pauses: 0, resumes: 0 };

function install(voices: SpeechSynthesisVoice[] = [macVoices[2]!]): void {
  clock = 0;
  spoken = [];
  synthState = { paused: false, cancels: 0, pauses: 0, resumes: 0 };
  g.window = { setTimeout: () => 0 }; // the start watchdog never fires here
  Object.defineProperty(performance, "now", { value: () => clock, configurable: true });
  g.SpeechSynthesisUtterance = class {
    text: string;
    rate = 1;
    lang = "";
    constructor(text: string) {
      this.text = text;
    }
  };
  g.speechSynthesis = {
    getVoices: () => voices,
    addEventListener() {},
    removeEventListener() {},
    get paused() {
      return synthState.paused;
    },
    speak: (u: Utterance) => spoken.push(u),
    cancel: () => synthState.cancels++,
    pause: () => {
      synthState.paused = true;
      synthState.pauses++;
    },
    resume: () => {
      synthState.paused = false;
      synthState.resumes++;
    },
  };
}

function setup(paragraphs: string[], base: Record<string, number> = {}) {
  install();
  const tokens = tokenize(paragraphs, "en");
  const log = { words: [] as number[], ends: 0, bases: [] as [string, number][], errors: [] as string[] };
  const speaker = new Speaker({
    word: (t) => log.words.push(t),
    end: () => log.ends++,
    base: (uri, wpm) => log.bases.push([uri, wpm]),
    error: (m) => log.errors.push(m),
  });
  speaker.baseWpms = { ...base };
  return { speaker, tokens, text: { paragraphs, tokens, lang: "en" }, log };
}

/** Fires a word boundary at the token's own offset, `ms` after the previous event. */
const boundary = (u: Utterance, charIndex: number, ms = 0) => {
  clock += ms;
  u.onboundary?.({ name: "word", charIndex });
};

test("Speaker: starts mid-paragraph at the token's offset and maps boundaries back to tokens", async () => {
  const { speaker, tokens, text, log } = setup(["One two three four.", "Five six."]);
  await speaker.start(text, 2, 200); // "three"
  assert.equal(spoken.length, 1);
  const u = spoken[0]!;
  assert.equal(u.text, "three four.");
  assert.equal(u.voice?.name, "Samantha");
  boundary(u, 0);
  boundary(u, 6); // "four." is token 3
  assert.deepEqual(log.words, [2, 3]);
  u.onboundary?.({ name: "sentence", charIndex: 0 }); // not a word
  assert.deepEqual(log.words, [2, 3]);
});

test("Speaker: one utterance per paragraph, chained on end, then the end hook", async () => {
  const { speaker, text, log } = setup(["One two.", "Three four."]);
  await speaker.start(text, 0, 200);
  assert.equal(spoken.length, 1);
  spoken[0]!.onend?.();
  assert.equal(spoken.length, 2);
  assert.equal(spoken[1]!.text, "Three four.");
  boundary(spoken[1]!, 6);
  assert.deepEqual(log.words, [3]);
  assert.equal(log.ends, 0);
  spoken[1]!.onend?.();
  assert.equal(log.ends, 1);
  assert.equal(spoken.length, 2);
});

test("Speaker: events of a cancelled utterance are ignored", async () => {
  const { speaker, text, log } = setup(["One two.", "Three four."]);
  await speaker.start(text, 0, 200);
  const old = spoken[0]!;
  await speaker.start(text, 2, 200); // a seek: cancel + new utterance
  assert.equal(spoken.length, 2);
  old.onboundary?.({ name: "word", charIndex: 4 });
  old.onend?.(); // WebKit delivers these late, after the cancel
  old.onerror?.({ error: "canceled" });
  assert.equal(spoken.length, 2); // did not advance to a paragraph
  assert.deepEqual(log.words, []);
  assert.deepEqual(log.errors, []);
  speaker.stop();
  spoken[1]!.onend?.();
  assert.equal(log.ends, 0);
  assert.equal(spoken.length, 2);
});

test("Speaker: a stale event handed to the next utterance (offset past its end, or backwards) is ignored", async () => {
  const { speaker, text, log } = setup(["One two three four five."]);
  await speaker.start(text, 2, 200); // "three four five."
  const u = spoken[0]!;
  assert.equal(u.text, "three four five.");
  boundary(u, 99); // from the cancelled utterance: beyond this text
  assert.deepEqual(log.words, []);
  boundary(u, 6); // "four"
  boundary(u, 0); // goes backwards
  boundary(u, 11); // "five."
  assert.deepEqual(log.words, [3, 4]);
});

test("Speaker: a real error is reported, canceled/interrupted are not", async () => {
  const { speaker, text, log } = setup(["One two."]);
  await speaker.start(text, 0, 200);
  spoken[0]!.onerror?.({ error: "interrupted" });
  assert.deepEqual(log.errors, []);
  spoken[0]!.onerror?.({ error: "synthesis-failed" });
  assert.equal(log.errors.length, 1);
});

test("Speaker: rate follows the target through the curve, and the cap is twice the base speed", async () => {
  const uri = "com.apple.voice.compact.en-US.Samantha";
  const { speaker, text } = setup(["One two three."], { [uri]: 200 });
  await speaker.start(text, 0, 200);
  approx(spoken[0]!.rate, 1);
  assert.equal(speaker.capped, false);

  await speaker.start(text, 0, 350); // 1.75x
  approx(speedAt(spoken[1]!.rate), 1.75, 1e-6);
  approx(speaker.effectiveWpm, 350, 1e-6);

  await speaker.start(text, 0, 1000); // far above the cap: 2x the base speed
  approx(speedAt(spoken[2]!.rate), 2, 1e-6);
  assert.equal(speaker.capped, true);
  approx(speaker.capWpm, 400);
  approx(speaker.effectiveWpm, 400, 1e-6);

  await speaker.start(text, 0, 100); // below the slowest rate: floor
  approx(spoken[3]!.rate, 0.5);
  approx(speaker.effectiveWpm, 155, 1e-6);
});

test("Speaker: an unmeasured voice uses the default base speed", async () => {
  const { speaker, text } = setup(["One two."]);
  await speaker.start(text, 0, 200);
  assert.equal(speaker.baseWpm, DEFAULT_BASE_WPM);
});

test("Speaker: calibrates from boundary timing, persists it, and corrects an unmeasured voice mid-sentence", async () => {
  const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
  const { speaker, text, log } = setup([words]);
  const offsets = [...words.matchAll(/\S+/g)].map((m) => m.index!);
  await speaker.start(text, 0, 400); // 2x the guessed base of 200
  const first = spoken[0]!;
  // The voice really speaks at 300 wpm at rate 1, so at this rate every word takes:
  const per = 60000 / (300 * speedAt(first.rate));
  for (let i = 0; i < offsets.length && spoken.length === 1; i++) boundary(first, offsets[i]!, i === 0 ? 0 : per);
  assert.equal(spoken.length, 2, "restarted once with the measured speed");
  assert.equal(log.bases.length, 1);
  const [uri, wpm] = log.bases[0]!;
  assert.equal(uri, "com.apple.voice.compact.en-US.Samantha");
  assert.ok(Math.abs(wpm - 300) <= 3, `base ${wpm}`);
  // The restart continues from the word that was being spoken, at the new rate.
  const resumedAt = log.words[log.words.length - 1]!;
  assert.equal(spoken[1]!.text, words.slice(offsets[resumedAt]!));
  approx(speedAt(spoken[1]!.rate), 400 / speaker.baseWpm, 1e-6);
  assert.ok(spoken[1]!.rate < first.rate);
  // Calibrated now: a further wildly different sample does not restart again.
  const second = spoken[1]!;
  for (let i = 0; i < 12; i++) boundary(second, 0, 5000);
  assert.equal(spoken.length, 2);
});

test("Speaker: pausing drops the timing sample, and a pause before the voice is ready still pauses", async () => {
  const { speaker, text } = setup(["One two three."]);
  const pending = speaker.start(text, 0, 200);
  speaker.pause(); // while the voices are still loading
  await pending;
  assert.equal(spoken.length, 1);
  assert.equal(synthState.paused, true, "re-paused right after speak()");
  speaker.resume();
  assert.equal(synthState.paused, false);
});

test("Speaker: stop() while voices are loading means nothing is spoken", async () => {
  const { speaker, text } = setup(["One two three."]);
  const pending = speaker.start(text, 0, 200);
  speaker.stop();
  await pending;
  assert.equal(spoken.length, 0);
});
