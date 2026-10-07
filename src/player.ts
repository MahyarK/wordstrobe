// Wordstrobe playback state machine (PLAN §5.4).
//
// Pure and DOM-free: callers pass timestamps in (performance.now() in the popup, a fake clock
// in the tests), so the timing is checkable under `node --test`. Only erasable TypeScript.
//
// The schedule is cumulative: frame `f` is due at `t0 + rel(f + 1)`, where `rel` is a prefix sum
// of the frame durations plus the start-up ramp. Nothing is ever accumulated tick by tick, so
// there is no drift however irregular the ticks are.
import {
  DEFAULT_TIMING,
  delays,
  rampFactor,
  sentenceStartBefore,
  type Timing,
  type Token,
} from "./text.ts";

/**
 * A tick later than this behind schedule is a stall (hidden window, long GC), not jitter. The
 * schedule then slips by the lag instead of racing through the missed frames.
 */
const STALL_MS = 250;

export type PlayerOptions = { timing?: Timing; smartResume?: boolean };

export class Player {
  readonly tokens: Token[];
  readonly frames: number[][];
  smartResume: boolean;
  /** Index of the frame that is on screen. */
  frame = 0;
  playing = false;
  done = false;

  private timing: Timing;
  private tokenFrame: number[] = [];
  private tokenDelay: number[] = []; // ms per token at the current wpm, without ramp
  private cum: number[] = []; // cum[f] = sum of the frame durations before frame f; length frames + 1
  // The current run: the schedule that started at frame `runStart` at time `t0`.
  private runStart = 0;
  private runRamp = 0;
  private t0 = 0;
  private extra: number[] = []; // extra[j] = ramp time added up to and including frame runStart + j
  private rewind = false; // true after pause(): the next play() may rewind to the sentence start

  constructor(tokens: Token[], frames: number[][], opts: PlayerOptions = {}) {
    this.tokens = tokens;
    this.frames = frames;
    this.timing = opts.timing ?? DEFAULT_TIMING;
    this.smartResume = opts.smartResume ?? true;
    frames.forEach((f, i) => f.forEach((t) => (this.tokenFrame[t] = i)));
    this.rebuild();
  }

  get wpm(): number {
    return this.timing.wpm;
  }

  /** Schedule length at the current wpm, without any ramp. */
  get totalMs(): number {
    return this.cum[this.frames.length]!;
  }

  frameOfToken(token: number): number {
    return this.tokenFrame[Math.min(Math.max(0, token), this.tokens.length - 1)] ?? 0;
  }

  /** Where smart resume would go from here: the start of the current sentence. */
  rewindFrame(): number {
    const first = this.frames[this.frame]?.[0];
    return first === undefined ? 0 : this.frameOfToken(sentenceStartBefore(this.tokens, first));
  }

  /**
   * The sentence start before (dir < 0) or after (dir > 0) frame `f`. Going back from the middle
   * of a sentence lands on its own start, from the start on the previous one. Going forward from
   * the last sentence lands on the last frame.
   */
  sentenceFrame(f: number, dir: number): number {
    const first = this.frames[f]?.[0] ?? 0;
    if (dir > 0) {
      for (let i = first + 1; i < this.tokens.length; i++) {
        if (this.tokens[i]!.sentenceStart) return this.tokenFrame[i]!;
      }
      return Math.max(0, this.frames.length - 1);
    }
    let start = sentenceStartBefore(this.tokens, first);
    if (start === first && first > 0) start = sentenceStartBefore(this.tokens, first - 1);
    return this.frameOfToken(start);
  }

  /** 0..1 position in the schedule (1 once done). */
  progress(): number {
    const total = this.totalMs;
    if (this.done) return 1;
    return total > 0 ? this.cum[this.frame]! / total : 0;
  }

  /** Time until the end: from the live schedule while playing (ramp included), else from the schedule sums. */
  remainingMs(now: number): number {
    if (this.playing) return Math.max(0, this.t0 + this.rel(this.frames.length) - now);
    return this.done ? 0 : this.totalMs - this.cum[this.frame]!;
  }

  play(now: number): void {
    if (this.playing) return;
    if (this.frames.length === 0) {
      this.done = true;
      return;
    }
    if (this.done) {
      this.frame = 0;
      this.done = false;
    } else if (this.rewind && this.smartResume) {
      this.frame = this.rewindFrame();
    }
    this.rewind = false;
    this.playing = true;
    this.startRun(this.frame, now);
  }

  /** `smart = false` makes the next play() continue from this frame instead of the sentence start. */
  pause(now: number, smart = true): void {
    if (!this.playing) return;
    this.tick(now); // settle first, so the frame at pause time is the one the schedule says
    if (!this.playing) return; // that tick finished the text
    this.playing = false;
    this.rewind = smart;
  }

  /**
   * Returns the frame to show at `now`. It advances at most one frame per call: a late tick shows
   * the next frame (late) rather than jumping over several, and the following ticks catch up
   * because the schedule is anchored to `t0`, not to when frames were actually shown.
   */
  tick(now: number): number {
    if (!this.playing) return this.frame;
    const end = this.t0 + this.rel(this.frame + 1);
    if (now < end) return this.frame;
    const lag = now - end;
    if (lag > STALL_MS) this.t0 += lag;
    if (this.frame + 1 >= this.frames.length) {
      this.playing = false;
      this.done = true;
    } else this.frame++;
    return this.frame;
  }

  /** Jump to `frame` (clamped). Keeps playing if it was playing, with the resume ramp. Never rewinds. */
  seek(frame: number, now: number): void {
    if (this.frames.length === 0) return;
    this.frame = Math.min(Math.max(0, Math.floor(frame) || 0), this.frames.length - 1);
    this.done = false;
    this.rewind = false;
    if (this.playing) this.startRun(this.frame, now);
  }

  /** Changes the speed; the rest of the schedule is rescaled and the current frame keeps its progress. */
  setWpm(wpm: number, now: number): void {
    if (wpm === this.timing.wpm) return;
    let frac = 0; // how far into the current frame we are
    if (this.playing) {
      this.tick(now);
      if (this.playing) {
        const a = this.rel(this.frame);
        const b = this.rel(this.frame + 1);
        frac = b > a ? Math.min(1, Math.max(0, (now - this.t0 - a) / (b - a))) : 0;
      }
    }
    this.timing = { ...this.timing, wpm };
    this.rebuild();
    if (this.playing) {
      this.extra = this.rampExtra(this.runStart, this.runRamp);
      const a = this.rel(this.frame);
      this.t0 = now - (a + frac * (this.rel(this.frame + 1) - a));
    }
  }

  private rebuild(): void {
    this.tokenDelay = delays(this.tokens, this.timing);
    this.cum = [0];
    this.frames.forEach((f, i) => {
      this.cum.push(this.cum[i]! + f.reduce((sum, t) => sum + this.tokenDelay[t]!, 0));
    });
  }

  private startRun(frame: number, now: number): void {
    this.runStart = frame;
    this.runRamp = frame === 0 ? this.timing.rampWords : this.timing.resumeRampWords;
    this.extra = this.rampExtra(frame, this.runRamp);
    this.t0 = now;
  }

  /** Cumulative extra time the ramp adds, frame by frame from `from`, until the ramp is over. */
  private rampExtra(from: number, words: number): number[] {
    const out: number[] = [];
    let k = 0;
    let acc = 0;
    for (let f = from; f < this.frames.length && k < words; f++) {
      for (const t of this.frames[f]!) {
        acc += this.tokenDelay[t]! * (rampFactor(k++, words, this.timing.rampFrom) - 1);
      }
      out.push(acc);
    }
    return out;
  }

  /** Start of frame `f` in the current run, in ms after `t0` (`frames.length` = the end). */
  private rel(f: number): number {
    const j = f - this.runStart;
    const ramp = j <= 0 || this.extra.length === 0 ? 0 : this.extra[Math.min(j, this.extra.length) - 1]!;
    return this.cum[f]! - this.cum[this.runStart]! + ramp;
  }
}
