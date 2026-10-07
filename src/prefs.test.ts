// Run with: npm test   (Node >= 22.18 strips the types natively; excluded from tsconfig)
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, LIMITS, PREF_KEYS, normalize, readPrefs } from "./prefs.ts";

test("normalize: an empty or unknown store gives the defaults (as a fresh object)", () => {
  assert.deepEqual(normalize({}), DEFAULTS);
  assert.deepEqual(normalize({ nothing: 1, wpm: undefined }), DEFAULTS);
  assert.notEqual(normalize({}).voices, DEFAULTS.voices);
  assert.equal("readerSize" in normalize({}), false);
});

test("normalize: valid values pass through untouched", () => {
  const full = {
    wpm: 600,
    wordsPerFlash: 3,
    fontSize: 60,
    theme: "dark",
    startDelay: 1500,
    smartResume: false,
    contextLine: false,
    placement: "center",
    readAloud: true,
    voiceMode: "voice",
    voices: { en: "com.apple.voice.premium.en-US.Zoe" },
    voiceBaseWpm: { "com.apple.voice.premium.en-US.Zoe": 212 },
    hotkeyRegion: "Alt+Shift+X",
    readerSize: { w: 600, h: 220 },
  };
  assert.deepEqual(normalize(full), full);
  assert.deepEqual(normalize(normalize(full)), full); // idempotent
});

test("normalize: numbers are rounded and clamped to the limits the Settings sliders have", () => {
  assert.equal(normalize({ wpm: 99 }).wpm, LIMITS.wpm.min);
  assert.equal(normalize({ wpm: 5000 }).wpm, LIMITS.wpm.max);
  assert.equal(normalize({ wpm: 350.6 }).wpm, 351);
  assert.equal(normalize({ fontSize: 16 }).fontSize, 28); // the reader used to accept 16-120
  assert.equal(normalize({ fontSize: 120 }).fontSize, 72);
  assert.equal(normalize({ startDelay: 5000 }).startDelay, 2000); // ... and 0-5000
  assert.equal(normalize({ startDelay: -5 }).startDelay, 0);
  assert.equal(normalize({ startDelay: 0 }).startDelay, 0, "0 is a valid start delay");
});

test("normalize: anything that is not a finite number falls back to the default, not to a bound", () => {
  for (const bad of [NaN, Infinity, -Infinity, "350", null, undefined, true, {}, [], [350]]) {
    const n = normalize({ wpm: bad, fontSize: bad, startDelay: bad });
    assert.equal(n.wpm, DEFAULTS.wpm, String(bad));
    assert.equal(n.fontSize, DEFAULTS.fontSize, String(bad));
    assert.equal(n.startDelay, DEFAULTS.startDelay, String(bad));
  }
});

test("normalize: wordsPerFlash is exactly 1, 2 or 3 (2.5 is not 3: the two pages used to disagree)", () => {
  assert.equal(normalize({ wordsPerFlash: 2 }).wordsPerFlash, 2);
  assert.equal(normalize({ wordsPerFlash: 3 }).wordsPerFlash, 3);
  for (const bad of [2.5, 0, 4, -1, "3", NaN, null]) assert.equal(normalize({ wordsPerFlash: bad }).wordsPerFlash, 1, String(bad));
});

test("normalize: enums and booleans accept only their own values", () => {
  assert.equal(normalize({ theme: "sepia" }).theme, "system");
  assert.equal(normalize({ placement: "left" }).placement, "cursor");
  assert.equal(normalize({ voiceMode: "both" }).voiceMode, "along");
  assert.equal(normalize({ smartResume: 0 }).smartResume, true);
  assert.equal(normalize({ contextLine: "false" }).contextLine, true);
  assert.equal(normalize({ readAloud: 1 }).readAloud, false);
  assert.equal(normalize({ hotkeyRegion: "" }).hotkeyRegion, DEFAULTS.hotkeyRegion);
  assert.equal(normalize({ hotkeyRegion: 7 }).hotkeyRegion, DEFAULTS.hotkeyRegion);
});

test("normalize: voices keeps only non-empty string ids, and only from a plain object", () => {
  assert.deepEqual(normalize({ voices: { en: "a", de: "", fr: 3, nl: null, es: ["x"] } }).voices, { en: "a" });
  for (const bad of ["en", 5, null, ["a"], true]) assert.deepEqual(normalize({ voices: bad }).voices, {}, String(bad));
});

test("normalize: voiceBaseWpm keeps only plausible finite numbers (a NaN rate would reach the speech engine)", () => {
  const out = normalize({
    voiceBaseWpm: { ok: 212, low: 59, high: 601, edgeLo: 60, edgeHi: 600, nan: NaN, inf: Infinity, str: "200", nul: null, obj: {} },
  }).voiceBaseWpm;
  assert.deepEqual(out, { ok: 212, edgeLo: 60, edgeHi: 600 });
  for (const bad of ["200", 200, null, [200], true]) assert.deepEqual(normalize({ voiceBaseWpm: bad }).voiceBaseWpm, {}, String(bad));
  // JSON has no NaN: a store written by a broken build holds null, which is dropped as well
  assert.deepEqual(normalize(JSON.parse('{"voiceBaseWpm":{"a":null,"b":150}}')).voiceBaseWpm, { b: 150 });
});

test("normalize: readerSize passes through when it is a positive {w, h}, and is dropped otherwise", () => {
  assert.deepEqual(normalize({ readerSize: { w: 520, h: 190, extra: 1 } }).readerSize, { w: 520, h: 190 });
  assert.deepEqual(normalize({ readerSize: { w: 520.5, h: 190.25 } }).readerSize, { w: 520.5, h: 190.25 });
  for (const bad of [{ w: 0, h: 190 }, { w: -1, h: 190 }, { w: "520", h: 190 }, { w: 520 }, { w: NaN, h: 190 }, [520, 190], 520, null, "x"]) {
    assert.equal("readerSize" in normalize({ readerSize: bad }), false, JSON.stringify(bad));
  }
});

test("normalize: no store content can make it throw", () => {
  const junk = [null, undefined, NaN, "", "x", 0, -1, 1e308, true, [], [[]], {}, { a: { b: 1 } }, () => 1, Symbol.iterator];
  const raw: Record<string, unknown> = {};
  for (const key of PREF_KEYS) for (const value of junk) assert.doesNotThrow(() => normalize({ ...raw, [key]: value }), `${key}=${String(value)}`);
  assert.doesNotThrow(() => normalize(JSON.parse('{"__proto__":{"x":1},"voices":{"__proto__":"x"}}')));
});

test("readPrefs: asks the store for every key once, in parallel, and normalizes the answers", async () => {
  const asked: string[] = [];
  const store: Record<string, unknown> = { wpm: 800, fontSize: 500, voices: { en: "v" }, theme: "dark" };
  const prefs = await readPrefs(async (key) => {
    asked.push(key);
    return store[key];
  });
  assert.deepEqual([...asked].sort(), [...PREF_KEYS].sort());
  assert.equal(prefs.wpm, 800);
  assert.equal(prefs.fontSize, 72);
  assert.equal(prefs.theme, "dark");
  assert.deepEqual(prefs.voices, { en: "v" });
  assert.equal(prefs.startDelay, DEFAULTS.startDelay);
});
