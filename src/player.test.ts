// Run with: npm test   (Node >= 22.18 strips the types natively; excluded from tsconfig)
import { test } from "node:test";
import assert from "node:assert/strict";
import { Player } from "./player.ts";
import { DEFAULT_TIMING, delays, frames, rampFactor, tokenize, type Timing, type Token } from "./text.ts";

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

const approx = (actual: number, expected: number, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
/** Deterministic noise in [0, 1), so the "jitter" runs are repeatable. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const NO_RAMP: Timing = { ...DEFAULT_TIMING, rampWords: 0, resumeRampWords: 0 };
const at = (wpm: number, t: Timing = DEFAULT_TIMING): Timing => ({ ...t, wpm });

/** `n` plain words that each last exactly 60000 / wpm ms: no punctuation, no paragraph end, no long-word factor. */
const plain = (n: number): Token[] =>
  Array.from({ length: n }, (_, i) => ({
    text: "one",
    para: 0,
    start: i * 4,
    end: i * 4 + 3,
    sentenceStart: i === 0,
    paraEnd: false,
  }));

/** ~300 words: sentences of 12 words, 5 paragraphs, some long words, numbers and commas. */
function article(words = 300): string[] {
  const vocab = ["reading", "faster", "needs", "practice", "unbelievable", "and", "3.14", "NASA", "the", "eye", "moves", "less"];
  const paras: string[] = [];
  for (let i = 0; i < words; i += words / 5) {
    const out: string[] = [];
    for (let j = 0; j < words / 5; j++) {
      const w = vocab[(i + j) % vocab.length]!;
      out.push(j % 12 === 11 ? `${w}.` : j % 5 === 4 ? `${w},` : w);
    }
    paras.push(out.join(" "));
  }
  return paras;
}

/** Everything the schedule says should happen, computed without the Player. */
function expectedEnds(player: Player, timing: Timing, rampWords: number): number[] {
  const d = delays(player.tokens, timing);
  const ends: number[] = [];
  let t = 0;
  let k = 0;
  for (const f of player.frames) {
    for (const i of f) t += d[i]! * rampFactor(k++, rampWords, timing.rampFrom);
    ends.push(t);
  }
  return ends;
}

/** Ticks every `dt` ms (plus jitter) from a play() at t = 0 until done. */
function simulate(player: Player, dt: number, jitter = 0, seed = 1) {
  const rand = rng(seed);
  player.play(0);
  const shown: number[] = [player.frame];
  const firstSeen: number[] = [0];
  let now = 0;
  while (!player.done) {
    now += dt + rand() * jitter;
    const f = player.tick(now);
    if (f !== shown[shown.length - 1]) {
      shown.push(f);
      firstSeen.push(now);
    }
    assert.ok(now < 3_600_000, "never finished");
  }
  return { shown, firstSeen, finishedAt: now };
}

// ---------------------------------------------------------------------------------------------
// Timing accuracy
// ---------------------------------------------------------------------------------------------

for (const hz of [60, 120]) {
  test(`300 words at 1000 wpm, ${hz} Hz ticks: every frame once, in order, on schedule`, () => {
    const tokens = tokenize(article(300));
    assert.equal(tokens.length, 300);
    const timing = at(1000);
    const player = new Player(tokens, frames(tokens, 1), { timing });
    const dt = 1000 / hz;
    const { shown, firstSeen, finishedAt } = simulate(player, dt);

    assert.deepEqual(shown, tokens.map((_, i) => i));

    const ends = expectedEnds(player, timing, timing.rampWords);
    const total = ends[ends.length - 1]!;
    assert.ok(Math.abs(finishedAt - total) / total < 0.03, `${finishedAt} vs ${total}`);
    // No drift: frame f appears within one tick of the end of frame f - 1, at every point of the run.
    firstSeen.forEach((t, f) => {
      if (f > 0) assert.ok(t - ends[f - 1]! >= -1e-6 && t - ends[f - 1]! < dt + 1e-6, `frame ${f}`);
    });
  });
}

test("irregular ticks (jitter up to 12 ms, 60 Hz base): still every frame exactly once, in order", () => {
  const tokens = tokenize(article(300));
  const timing = at(1000);
  const player = new Player(tokens, frames(tokens, 1), { timing });
  const { shown, finishedAt } = simulate(player, 1000 / 60, 12, 42);
  assert.deepEqual(shown, tokens.map((_, i) => i));
  const total = expectedEnds(player, timing, timing.rampWords).at(-1)!;
  assert.ok(Math.abs(finishedAt - total) / total < 0.03, `${finishedAt} vs ${total}`);
});

test("chunk mode: durations are the summed word delays, ramp counted per word", () => {
  const tokens = tokenize(article(300));
  const timing = at(600);
  for (const n of [2, 3]) {
    const player = new Player(tokens, frames(tokens, n), { timing });
    const { shown, finishedAt } = simulate(player, 1000 / 60);
    assert.deepEqual(shown, player.frames.map((_, i) => i));
    const total = expectedEnds(player, timing, timing.rampWords).at(-1)!;
    assert.ok(finishedAt >= total && finishedAt - total < 1000 / 60 + 1e-6, `${n}: ${finishedAt} vs ${total}`);
    approx(player.totalMs, sum(delays(tokens, timing)), 1e-6);
  }
});

test("a late tick shows the next frame, never several", () => {
  const tokens = plain(20);
  const player = new Player(tokens, frames(tokens, 1), { timing: at(1000, NO_RAMP) }); // 60 ms per word
  player.play(0);
  assert.equal(player.tick(30), 0);
  assert.equal(player.tick(200), 1); // due 140 ms ago: the next frame, not frame 3
  assert.equal(player.tick(201), 2); // catches up one frame per tick, on the original schedule
  assert.equal(player.tick(202), 3); // frame 3 was due at 180
  assert.equal(player.tick(203), 3); // frame 3 ends at 240
  assert.equal(player.tick(240), 4);
});

test("a long stall slips the schedule instead of fast-forwarding", () => {
  const tokens = plain(20);
  const player = new Player(tokens, frames(tokens, 1), { timing: at(1000, NO_RAMP) });
  player.play(0);
  assert.equal(player.tick(5000), 1);
  assert.equal(player.tick(5059), 1); // frame 1 gets its whole 60 ms, counted from the stall's end
  assert.equal(player.tick(5060), 2);
});

// ---------------------------------------------------------------------------------------------
// Ramp
// ---------------------------------------------------------------------------------------------

test("ramp: the first word is 1.6x as long and the ramp tapers off over 8 words", () => {
  const tokens = plain(30);
  const player = new Player(tokens, frames(tokens, 1), { timing: at(1000) }); // base 60 ms
  player.play(0);
  assert.equal(player.tick(95), 0);
  assert.equal(player.tick(96), 1); // 60 x 1.6
  const second = 60 * rampFactor(1, 8, 1.6);
  assert.equal(player.tick(96 + second - 1), 1);
  assert.equal(player.tick(96 + second), 2);
  // after the ramp the pace is flat: expected total = 30 words x 60 ms + the ramp's extra time
  let extra = 0;
  for (let k = 0; k < 8; k++) extra += 60 * (rampFactor(k, 8, 1.6) - 1);
  approx(player.remainingMs(0), 30 * 60 + extra, 1e-6);
});

test("resume ramp: a 4-word ramp after pause/resume and after seek, 8 words only at the very start", () => {
  const tokens = plain(40);
  const player = new Player(tokens, frames(tokens, 1), { timing: at(1000), smartResume: false });
  player.play(0);
  player.seek(20, 1000);
  assert.equal(player.tick(1000 + 95), 20);
  assert.equal(player.tick(1000 + 96), 21); // 60 x 1.6 again
  let extra = 0;
  for (let k = 0; k < 4; k++) extra += 60 * (rampFactor(k, 4, 1.6) - 1);
  approx(player.remainingMs(1000), 20 * 60 + extra, 1e-6);

  player.pause(1100);
  player.play(2000);
  assert.equal(player.tick(2000 + 95), player.frame);
  const f = player.frame;
  assert.equal(player.tick(2000 + 96), f + 1);
});

test("ramp can be switched off", () => {
  const tokens = plain(10);
  const player = new Player(tokens, frames(tokens, 1), { timing: at(1000, NO_RAMP) });
  player.play(0);
  assert.equal(player.tick(59), 0);
  assert.equal(player.tick(60), 1);
  approx(player.remainingMs(60), 9 * 60);
});

// ---------------------------------------------------------------------------------------------
// Pause, smart resume, seek
// ---------------------------------------------------------------------------------------------

const sentences = tokenize(["One two three. Four five six seven. Eight nine ten."]); // starts at 0, 3, 7

test("pause then resume rewinds to the start of the sentence", () => {
  const player = new Player(sentences, frames(sentences, 1), { timing: at(1000, NO_RAMP) });
  player.play(0);
  let now = 0;
  while (player.frame < 5) player.tick((now += 5)); // "six"
  player.pause(now);
  assert.equal(player.playing, false);
  assert.equal(player.frame, 5);
  assert.equal(player.rewindFrame(), 3);
  player.play(now + 5000);
  assert.equal(player.playing, true);
  assert.equal(player.frame, 3); // "Four"
});

test("pause and resume does not rewind when smart resume is off, when already at a sentence start, or after a seek", () => {
  const timing = at(1000, NO_RAMP);
  const off = new Player(sentences, frames(sentences, 1), { timing, smartResume: false });
  off.play(0);
  off.seek(5, 0);
  off.pause(10);
  off.play(20);
  assert.equal(off.frame, 5);

  const on = new Player(sentences, frames(sentences, 1), { timing });
  on.play(0);
  on.seek(3, 0);
  on.pause(10);
  on.play(20);
  assert.equal(on.frame, 3);

  on.pause(30);
  on.seek(5, 40); // the user chose this spot
  on.play(50);
  assert.equal(on.frame, 5);
});

test("a second pause is a no-op and play() while playing keeps the run", () => {
  const player = new Player(sentences, frames(sentences, 1), { timing: at(1000, NO_RAMP) });
  player.play(0);
  assert.equal(player.tick(60), 1);
  player.play(500); // ignored: no new run
  assert.equal(player.tick(120), 2);
  player.pause(130);
  player.pause(9999);
  assert.equal(player.playing, false);
});

test("pause settles the schedule first", () => {
  const player = new Player(sentences, frames(sentences, 1), { timing: at(1000, NO_RAMP) });
  player.play(0);
  player.pause(70); // frame 1 was due at 60
  assert.equal(player.frame, 1);
});

test("seek: paused it only moves, playing it restarts the run, and it clamps", () => {
  const tokens = plain(50);
  const player = new Player(tokens, frames(tokens, 1), { timing: at(1000, NO_RAMP) });
  player.seek(7, 0);
  assert.equal(player.frame, 7);
  assert.equal(player.playing, false);
  assert.equal(player.tick(10_000), 7);

  player.play(100);
  assert.equal(player.tick(160), 8);
  player.seek(30, 170);
  assert.equal(player.frame, 30);
  assert.equal(player.playing, true);
  assert.equal(player.tick(170 + 59), 30); // full duration counted from the seek
  assert.equal(player.tick(170 + 60), 31);

  player.seek(-5, 500);
  assert.equal(player.frame, 0);
  player.seek(1e9, 500);
  assert.equal(player.frame, 49);
  player.seek(NaN, 500);
  assert.equal(player.frame, 0);
});

test("sentenceFrame: back goes to the own start first, then to the previous one", () => {
  const player = new Player(sentences, frames(sentences, 1));
  assert.equal(player.sentenceFrame(5, -1), 3);
  assert.equal(player.sentenceFrame(3, -1), 0);
  assert.equal(player.sentenceFrame(0, -1), 0);
  assert.equal(player.sentenceFrame(1, -1), 0);
  assert.equal(player.sentenceFrame(0, 1), 3);
  assert.equal(player.sentenceFrame(5, 1), 7);
  assert.equal(player.sentenceFrame(8, 1), 9); // last sentence: the last frame
  const chunks = new Player(sentences, frames(sentences, 3));
  assert.deepEqual(chunks.frames, [[0, 1, 2], [3, 4, 5], [6], [7, 8, 9]]);
  assert.equal(chunks.sentenceFrame(1, -1), 0); // frame 1 starts "Four five six seven.": back goes to the previous sentence
  assert.equal(chunks.sentenceFrame(2, -1), 1); // frame 2 is "seven.", in the middle of that sentence
});

test("frameOfToken maps tokens to the frame that contains them", () => {
  const tokens = tokenize(["a b c d e f g"]);
  const player = new Player(tokens, frames(tokens, 3));
  assert.deepEqual([0, 1, 2, 3, 6].map((t) => player.frameOfToken(t)), [0, 0, 0, 1, 2]);
  assert.equal(player.frameOfToken(99), 2);
  assert.equal(player.frameOfToken(-1), 0);
});

// ---------------------------------------------------------------------------------------------
// setWpm
// ---------------------------------------------------------------------------------------------

test("setWpm rescales the stored factors: nothing is looked at again, and a new Player can reuse them", () => {
  // Reading `text` is what the factor computation does to every token (alnumCount, endKind, ...).
  let reads = 0;
  const base = tokenize(["Überraschungsmomente, schön. Noch ein Satz mit 3 Zahlen.", "Zweiter Absatz."], "de");
  const tokens = base.map((t) => ({
    ...t,
    get text() {
      reads++;
      return t.text;
    },
  }));
  const player = new Player(tokens, frames(tokens, 1), { timing: at(300, NO_RAMP) });
  const built = reads;
  assert.ok(built >= tokens.length);
  for (const wpm of [100, 250, 500, 1200, 300]) player.setWpm(wpm, 0);
  assert.equal(reads, built, "setWpm must not touch the tokens");
  approx(player.totalMs, sum(delays(base, at(300, NO_RAMP))));

  // chunk change: a second Player over the same text, handed the factors
  const next = new Player(tokens, frames(tokens, 3), { timing: at(player.wpm, NO_RAMP), factors: player.factors });
  assert.equal(reads, built, "reusing the factors must not touch the tokens either");
  approx(next.totalMs, sum(delays(base, at(300, NO_RAMP))));
  assert.equal(next.factors, player.factors);
});

test("a chunk-size change keeps the position: the first token of the old frame lands in the new layout's frame", () => {
  const tokens = tokenize(article(300), "en");
  for (const [from, to] of [[1, 3], [3, 1], [2, 3], [3, 2], [1, 2]] as const) {
    const old = new Player(tokens, frames(tokens, from));
    for (const f of [0, 1, 7, old.frames.length >> 1, old.frames.length - 1]) {
      const token = old.frames[f]![0]!;
      const next = new Player(tokens, frames(tokens, to));
      const g = next.frameOfToken(token);
      assert.ok(next.frames[g]!.includes(token), `${from}->${to} frame ${f}`);
      assert.ok(g < next.frames.length); // a frame index of the old layout would not be: that was the bug
    }
  }
});

test("setWpm mid-play rescales the rest of the schedule and keeps the progress inside the frame", () => {
  const tokens = plain(100);
  const player = new Player(tokens, frames(tokens, 1), { timing: at(600, NO_RAMP) }); // 100 ms per word
  player.play(0);
  let now = 0;
  while (player.frame < 10) player.tick((now += 10));
  assert.equal(now, 1000);
  approx(player.remainingMs(1000), 9000);

  player.setWpm(1200, 1050); // halfway through frame 10 (1000..1100), which now lasts 50 ms
  assert.equal(player.wpm, 1200);
  assert.equal(player.tick(1074), 10);
  assert.equal(player.tick(1075), 11);
  approx(player.remainingMs(1075), 89 * 50);

  player.setWpm(300, 1100); // frame 11 started at 1075, 25 of its 50 ms are done: half of 200 ms left
  assert.equal(player.tick(1199), 11);
  assert.equal(player.tick(1200), 12);
});

test("setWpm keeps a running ramp going", () => {
  const tokens = plain(40);
  const player = new Player(tokens, frames(tokens, 1), { timing: at(1000) });
  player.play(0);
  player.setWpm(500, 10); // 120 ms per word now; frame 0 lasted 96 ms and is 10/96 of the way through
  const end = 10 + 1.6 * 120 * (1 - 10 / 96); // 182: the rest of the frame at the new speed
  assert.equal(player.tick(end - 0.1), 0);
  assert.equal(player.tick(end + 0.1), 1);
  let extra = 0; // the ramp's extra time for words 1..7, now at 120 ms per word
  for (let k = 1; k < 8; k++) extra += 120 * (rampFactor(k, 8, 1.6) - 1);
  approx(player.remainingMs(end), 39 * 120 + extra, 1e-6);
});

test("setWpm while paused rescales the remaining time and the next run uses it", () => {
  const tokens = plain(10);
  const player = new Player(tokens, frames(tokens, 1), { timing: at(600, NO_RAMP) });
  player.seek(4, 0);
  approx(player.remainingMs(0), 600);
  player.setWpm(1200, 0);
  approx(player.remainingMs(0), 300);
  player.play(0);
  assert.equal(player.tick(49), 4);
  assert.equal(player.tick(50), 5);
});

// ---------------------------------------------------------------------------------------------
// done, remaining, progress
// ---------------------------------------------------------------------------------------------

test("done: stays on the last frame, reports no time left, and play() starts over", () => {
  const tokens = plain(3);
  const player = new Player(tokens, frames(tokens, 1), { timing: at(1000, NO_RAMP) });
  player.play(0);
  assert.equal(player.progress(), 0);
  assert.equal(player.tick(60), 1);
  assert.equal(player.tick(120), 2);
  assert.equal(player.done, false);
  approx(player.progress(), 120 / 180);
  assert.equal(player.tick(179), 2);
  assert.equal(player.done, false);
  assert.equal(player.tick(180), 2);
  assert.equal(player.done, true);
  assert.equal(player.playing, false);
  assert.equal(player.remainingMs(180), 0);
  assert.equal(player.progress(), 1);
  assert.equal(player.tick(1000), 2);

  player.seek(1, 2000); // seeking leaves the done state
  assert.equal(player.done, false);
  player.seek(2, 2000);
  player.play(2000);
  player.tick(2060);
  assert.equal(player.done, true);

  player.play(3000); // restart from the top
  assert.equal(player.done, false);
  assert.equal(player.frame, 0);
  assert.equal(player.playing, true);
});

test("remainingMs while paused is the schedule from the current frame; while playing it follows the clock", () => {
  const tokens = plain(10);
  const player = new Player(tokens, frames(tokens, 1), { timing: at(1000, NO_RAMP) });
  approx(player.remainingMs(0), 600);
  player.play(0);
  approx(player.remainingMs(0), 600);
  approx(player.remainingMs(250), 350);
  assert.equal(player.remainingMs(10_000), 0);
  assert.equal(player.totalMs, 600);
});

test("empty text: play() finishes at once", () => {
  const player = new Player([], []);
  player.play(0);
  assert.equal(player.done, true);
  assert.equal(player.playing, false);
  assert.equal(player.tick(100), 0);
  assert.equal(player.remainingMs(0), 0);
  assert.equal(player.progress(), 1);
  player.seek(3, 0);
  assert.equal(player.frame, 0);
});
