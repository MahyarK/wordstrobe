// Wordstrobe text pipeline + RSVP timing engine (PLAN.md §5, §6).
//
// Pure functions only: no DOM, no timers, no module state. Runs in the webview and under
// `node --test` (Node >= 22.18 strips types natively), so only erasable TypeScript is used.

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/** One OCR line. Coordinates are normalized 0-1 with a top-left origin; `c` is the confidence. */
export type Line = { t: string; x: number; y: number; w: number; h: number; c: number };

export type OcrResult = { paragraphs?: string[]; lines?: Line[]; lang?: string };

/**
 * `start`/`end` are UTF-16 offsets of the source word inside `paragraphs[para]` (the strings
 * returned by `toParagraphs`), which is what speech `charIndex` reports. The parts of a split
 * long word all share the source word's range.
 */
export type Token = {
  text: string;
  para: number;
  start: number;
  end: number;
  sentenceStart: boolean;
  paraEnd: boolean;
};

export type Timing = {
  wpm: number;
  longWord: number;
  longWordCap: number;
  numberFactor: number;
  clause: number;
  sentence: number;
  paragraph: number;
  rampFrom: number;
  rampWords: number;
  resumeRampWords: number;
};

export const DEFAULT_TIMING: Timing = Object.freeze({
  wpm: 350,
  longWord: 0.04,
  longWordCap: 1.5,
  numberFactor: 1.3,
  clause: 1.6,
  sentence: 2.2,
  paragraph: 3.0,
  rampFrom: 1.6,
  rampWords: 8,
  resumeRampWords: 4,
});

// ---------------------------------------------------------------------------------------------
// Shared character classes
// ---------------------------------------------------------------------------------------------

const ALNUM = /[\p{L}\p{N}]/u;
/** Fallback when `Intl.Segmenter` is missing: a base character plus its combining marks. */
const GLYPH = /\P{M}\p{M}*|\p{M}+/gu;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
/** Scripts that are written without spaces between words (Korean uses spaces, so it is not here). */
const NO_SPACE_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const NO_SPACE_LANGS = new Set(["zh", "ja", "th", "lo", "km", "my"]);
// ponytail: a word in one of these scripts (right to left; Indic and related scripts with conjuncts
// or reordering vowels) gets no ORP pivot: `splitOrp` returns ["", word, ""]. Cutting it into spans
// would put its logical start on the wrong side of the pivot (RTL) or change the glyph shapes
// (Arabic joining, conjuncts). Proper RTL and conjunct-aware pivot rendering is a later improvement.
const NO_PIVOT_SCRIPT =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;
const GRAPHEMES =
  typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

/** User-perceived characters: flags, ZWJ emoji, base + marks, Hangul syllables and Indic conjuncts stay whole. */
function glyphs(s: string): string[] {
  if (PRINTABLE_ASCII.test(s)) return s.split("");
  if (!GRAPHEMES) return s.match(GLYPH) ?? [];
  return Array.from(GRAPHEMES.segment(s), (g) => g.segment);
}

function alnumCount(s: string): number {
  let n = 0;
  for (const g of glyphs(s)) if (ALNUM.test(g)) n++;
  return n;
}

// ---------------------------------------------------------------------------------------------
// Sentence / clause detection (shared by tokenize, delays, frames and the line grouper)
// ---------------------------------------------------------------------------------------------

// Closing quotes and brackets that may follow the terminator: `done."`  `(done.)`  `Go.”`
const CLOSER = /^[\p{Pe}\p{Pf}"']$/u; // all BMP, so one UTF-16 unit at a time is exact
const SENTENCE_END = /[.!?…。！？．‼؟۔।]$/u;
const CLAUSE_END = /[,;:–—，、；：]$/u;
// Deliberately tiny. "etc." and single-letter initials are ambiguous, so they count as sentence ends.
const ABBREVIATIONS = new Set(["e.g", "i.e", "mr", "mrs", "ms", "dr", "prof", "vs"]);

type EndKind = "sentence" | "clause" | "none";

function endKind(text: string): EndKind {
  // A loop instead of /[...]+$/u: that regex is quadratic on a long run of closers.
  let cut = text.length;
  while (cut > 0 && CLOSER.test(text[cut - 1]!)) cut--;
  const closers = text.slice(cut);
  const body = text.slice(0, cut);
  if (SENTENCE_END.test(body)) {
    if (body.endsWith(".")) {
      const word = body.slice(0, -1).replace(/^[^\p{L}]+/u, "").toLowerCase();
      if (ABBREVIATIONS.has(word)) return "none";
    }
    return "sentence";
  }
  if (CLAUSE_END.test(body) || /[)）]/u.test(closers)) return "clause";
  return "none";
}

// ---------------------------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------------------------

const LIGATURES = /[ﬀ-ﬆ]/g; // ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ
// `[^\S\n]*` (not `\s*`) before the newline keeps the match linear on long runs of blank lines.
const DEHYPHENATE = /(\p{L})[-‐][^\S\n]*\n\s*(\p{Ll})/gu;

// Standalone fragments (<= 2 chars, no letter or digit) that are real text and survive cleanup:
// dashes, & + = %, sentence/clause punctuation, quotes, brackets, currency, CJK punctuation.
// Everything else (bullets, | » « · ■ ▪ → > * # ~ © emoji ...) is UI chrome and is dropped.
const KEEP_SYMBOLS =
  /^[\p{Pd}&+=%.,;:!?…¿¡\p{Ps}\p{Pe}\p{Sc}°§¶"'“”‘’„、。，：；！？]+$/u;
// Punctuation that a typesetter (French "Quoi ?") or the OCR left floating: glue it to the word before.
const FLOATING_CLOSER = /^[.,;:!?…)\]}]+$/;
const DASH_ONLY = /^\p{Pd}+$/u;

type Fragment = { text: string; dash: boolean };

// Windows OCR and Tesseract put a space between every Han/kana character; Chinese and Japanese don't
// use spaces, so a space between two of them is removed (Korean, which does use spaces, is untouched).
const CJK = "\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\u3000-\\u303F\\uFF00-\\uFFEF";
const CJK_GAP = new RegExp(`(?<=[${CJK}])[^\\S\\n]+(?=[${CJK}])`, "gu");

export function cleanup(text: string): string {
  const s = text
    .replace(/\r\n?/g, "\n")
    .replace(CJK_GAP, "")
    .replace(LIGATURES, (c) => c.normalize("NFKC"))
    .replace(/­\s*\n\s*/g, "") // soft hyphen at a line break: join
    .replace(/­/g, "")
    .replace(DEHYPHENATE, "$1$2");

  const out: string[] = [];
  for (const line of s.split("\n")) {
    const row: Fragment[] = [];
    for (const frag of line.split(/\s+/)) {
      if (frag === "") continue;
      if (Array.from(frag).length > 2 || ALNUM.test(frag)) {
        row.push({ text: frag, dash: false });
      } else if (FLOATING_CLOSER.test(frag)) {
        const prev = row[row.length - 1];
        if (prev) {
          prev.text += frag;
          prev.dash = false;
        } else if (out.length > 0) out[out.length - 1] += frag;
        else row.push({ text: frag, dash: false });
      } else if (DASH_ONLY.test(frag)) {
        row.push({ text: frag, dash: true });
      } else if (KEEP_SYMBOLS.test(frag)) {
        row.push({ text: frag, dash: false });
      } // else: UI chrome, dropped
    }
    // A dash at the start or end of a line is a list bullet, not a dash between words.
    while (row.length > 0 && row[0]!.dash) row.shift();
    while (row.length > 0 && row[row.length - 1]!.dash) row.pop();
    for (const f of row) out.push(f.text);
  }
  return out.join(" ");
}

// ---------------------------------------------------------------------------------------------
// Lines -> paragraphs
// ---------------------------------------------------------------------------------------------

const MIN_CONFIDENCE = 0.3; // lines below this are dropped
const MIN_GUTTER = 0.05; // a column gap is wider than 5 % of the capture width
const SPAN_TOLERANCE = 0.2; // up to 20 % of lines (headings, footers) may cross a column gap
const GAP_FACTOR = 0.75; // vertical gap that starts a paragraph, in median line heights
const INDENT_CHANGE = 0.02; // x shift (of the capture width) that signals a new paragraph
const SHORT_LINE = 0.6; // a line shorter than this share of the median width ends a paragraph
const BINS = 400;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** True when two lines sit on the same visual row (they overlap vertically by over half a line). */
function sameRow(a: Line, b: Line): boolean {
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlap > 0.5 * Math.min(a.h, b.h);
}

/** Top to bottom, then left to right; lines on the same row are ordered by x. */
function sortReading(lines: Line[]): Line[] {
  const byY = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: Line[] = [];
  let row: Line[] = [];
  const flush = () => {
    row.sort((a, b) => a.x - b.x);
    out.push(...row);
    row = [];
  };
  for (const l of byY) {
    if (row.length > 0 && !sameRow(row[0]!, l)) flush();
    row.push(l);
  }
  flush();
  return out;
}

/** Horizontal gaps (x ranges) between columns. Edge margins never count. */
function findGutters(lines: Line[]): [number, number][] {
  if (lines.length < 2) return [];
  const cover = new Array<number>(BINS).fill(0);
  for (const l of lines) {
    const a = Math.max(0, Math.floor(l.x * BINS + 1e-9));
    const b = Math.min(BINS - 1, Math.ceil((l.x + l.w) * BINS - 1e-9) - 1);
    for (let i = a; i <= b; i++) cover[i]! += 1;
  }
  const tolerance = Math.floor(lines.length * SPAN_TOLERANCE);
  const gutters: [number, number][] = [];
  let i = 0;
  while (i < BINS) {
    if (cover[i]! > tolerance) {
      i++;
      continue;
    }
    let j = i;
    while (j < BINS && cover[j]! <= tolerance) j++;
    if (i > 0 && j < BINS && j - i > MIN_GUTTER * BINS) gutters.push([i / BINS, j / BINS]);
    i = j;
  }
  return gutters;
}

/** A line that crosses the middle of a gutter (full-width heading, footer, ...) belongs to no column. */
function spansGutter(l: Line, gutters: [number, number][]): boolean {
  return gutters.some(([a, b]) => {
    const q = (b - a) / 4;
    return l.x < b - q && l.x + l.w > a + q;
  });
}

/**
 * Splits a run of non-spanning lines into columns. Columns must share rows with each other: chat
 * bubbles aligned left and right alternate in time and never sit side by side, so they stay one
 * top-to-bottom block.
 */
function splitColumns(band: Line[], gutters: [number, number][]): Line[][] {
  const mids = gutters.map(([a, b]) => (a + b) / 2);
  const slots: Line[][] = Array.from({ length: mids.length + 1 }, () => []);
  for (const l of band) {
    const cx = l.x + l.w / 2;
    let k = 0;
    while (k < mids.length && cx > mids[k]!) k++;
    slots[k]!.push(l);
  }
  const cols = slots.filter((s) => s.length > 0);
  const sideBySide = cols.filter((col) => {
    const shared = col.filter((l) => cols.some((o) => o !== col && o.some((m) => sameRow(l, m))));
    return col.length >= 2 && shared.length >= col.length / 2;
  });
  return sideBySide.length >= 2 ? cols : [band];
}

/** Reading blocks: each is a single column of lines in reading order. */
function readingBlocks(lines: Line[]): Line[][] {
  const sorted = sortReading(lines);
  const gutters = findGutters(sorted);
  if (gutters.length === 0) return [sorted];
  const blocks: Line[][] = [];
  let run: Line[] = [];
  let spanning = false;
  const flush = () => {
    if (run.length > 0) blocks.push(...(spanning ? [run] : splitColumns(run, gutters)));
    run = [];
  };
  for (const l of sorted) {
    const s = spansGutter(l, gutters);
    if (s !== spanning) {
      flush();
      spanning = s;
    }
    run.push(l);
  }
  flush();
  return blocks;
}

function startsParagraph(prev: Line, line: Line, medH: number, medW: number): boolean {
  if (sameRow(prev, line)) return false;
  if (line.y - (prev.y + prev.h) > GAP_FACTOR * medH) return true;
  if (endKind(prev.t.trim()) !== "sentence") return false;
  return Math.abs(line.x - prev.x) > INDENT_CHANGE || prev.w < SHORT_LINE * medW;
}

/** Lines of one column -> paragraph strings (joined with "\n"; `cleanup` de-hyphenates and flattens). */
function groupParagraphs(block: Line[]): string[] {
  const medH = median(block.map((l) => l.h));
  const medW = median(block.map((l) => l.w));
  const paras: string[] = [];
  let cur: string[] = [];
  block.forEach((line, i) => {
    if (i > 0 && startsParagraph(block[i - 1]!, line, medH, medW)) {
      paras.push(cur.join("\n"));
      cur = [];
    }
    cur.push(line.t);
  });
  if (cur.length > 0) paras.push(cur.join("\n"));
  return paras;
}

function linesToParagraphs(lines: Line[]): string[] {
  const kept = lines.filter((l) => l.c >= MIN_CONFIDENCE && l.t.trim() !== "");
  return readingBlocks(kept).flatMap(groupParagraphs);
}

/** Cleaned paragraphs: taken as-is from OCR (macOS 26+) or grouped from lines. Empties are dropped. */
export function toParagraphs(r: OcrResult): string[] {
  const clean = (ps: string[]) => ps.map(cleanup).filter((p) => p !== "");
  const direct = r.paragraphs ? clean(r.paragraphs) : [];
  if (direct.length > 0 || !r.lines) return direct;
  return clean(linesToParagraphs(r.lines));
}

// ---------------------------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------------------------

const LONG_WORD_LETTERS = 13; // longer words are split
const MAX_PART_LETTERS = 9;
const OPENING_PUNCTUATION = /^[\p{Ps}\p{Pi}]/u;

type Piece = { text: string; start: number; end: number };

function makeSegmenter(lang: string | undefined): Intl.Segmenter | undefined {
  if (typeof Intl.Segmenter !== "function") return undefined;
  try {
    return new Intl.Segmenter(lang, { granularity: "word" });
  } catch {
    return new Intl.Segmenter(undefined, { granularity: "word" });
  }
}

/**
 * Segments one whitespace-free string. Punctuation joins the previous word; opening punctuation
 * (「 ( “) joins the next one, so a quote never trails the word before it.
 */
function segmentWord(seg: Intl.Segmenter, word: string, base: number): Piece[] {
  const out: Piece[] = [];
  let prefix: Piece | undefined;
  for (const s of seg.segment(word)) {
    const start = base + s.index;
    const end = start + s.segment.length;
    if (s.isWordLike) {
      out.push({ text: (prefix?.text ?? "") + s.segment, start: prefix?.start ?? start, end });
      prefix = undefined;
    } else if (prefix || out.length === 0 || OPENING_PUNCTUATION.test(s.segment)) {
      prefix = { text: (prefix?.text ?? "") + s.segment, start: prefix?.start ?? start, end };
    } else {
      const prev = out[out.length - 1]!;
      prev.text += s.segment;
      prev.end = end;
    }
  }
  if (prefix) {
    const prev = out[out.length - 1];
    if (prev) {
      prev.text += prefix.text;
      prev.end = prefix.end;
    } else out.push(prefix);
  }
  return out;
}

/** > 13 letters: balanced parts of <= 9 letters, every part but the last ending in "-". */
function splitLong(text: string): string[] {
  if (text.length <= LONG_WORD_LETTERS) return [text]; // cannot hold more letters than UTF-16 units
  const gs = glyphs(text);
  let total = 0;
  for (const g of gs) if (ALNUM.test(g)) total++;
  if (total <= LONG_WORD_LETTERS) return [text];

  const parts = Math.ceil(total / MAX_PART_LETTERS);
  const base = Math.floor(total / parts);
  const extra = total % parts;
  const out: string[] = [];
  let cur = "";
  let count = 0;
  let target = base + (extra > 0 ? 1 : 0);
  for (const g of gs) {
    cur += g;
    if (ALNUM.test(g) && ++count === target && out.length < parts - 1) {
      out.push(cur + "-");
      cur = "";
      count = 0;
      target = base + (out.length < extra ? 1 : 0);
    }
  }
  out.push(cur); // the last part also carries any trailing punctuation
  return out;
}

export function tokenize(paragraphs: string[], lang?: string): Token[] {
  const noSpaceLang = lang !== undefined && NO_SPACE_LANGS.has(lang.split(/[-_]/)[0]!.toLowerCase());
  let segmenter: Intl.Segmenter | undefined;
  const tokens: Token[] = [];

  paragraphs.forEach((text, para) => {
    const first = tokens.length;
    for (const m of text.matchAll(/\S+/gu)) {
      const word = m[0];
      const start = m.index ?? 0;
      let pieces: Piece[] = [{ text: word, start, end: start + word.length }];
      // Only tokens that actually contain such a script need a dictionary segmenter; "3.14" and
      // "state-of-the-art" inside Chinese text stay whole.
      if (NO_SPACE_SCRIPT.test(word) && (noSpaceLang || Array.from(word).length > 3)) {
        segmenter ??= makeSegmenter(lang);
        if (segmenter) pieces = segmentWord(segmenter, word, start);
      }
      for (const piece of pieces) {
        for (const part of splitLong(piece.text)) {
          tokens.push({
            text: part,
            para,
            start: piece.start,
            end: piece.end,
            sentenceStart: false,
            paraEnd: false,
          });
        }
      }
    }
    for (let i = first; i < tokens.length; i++) {
      tokens[i]!.sentenceStart = i === first || endKind(tokens[i - 1]!.text) === "sentence";
    }
    if (tokens.length > first) tokens[tokens.length - 1]!.paraEnd = true;
  });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// ORP (optimal recognition point)
// ---------------------------------------------------------------------------------------------

function pivotOffset(letters: number): number {
  if (letters <= 1) return 0;
  if (letters <= 5) return 1;
  if (letters <= 9) return 2;
  if (letters <= 13) return 3;
  return 4;
}

/**
 * UTF-16 range `[from, to)` of the pivot glyph in `word`. The length is measured from the first to
 * the last letter/digit, so leading and trailing punctuation is ignored. A pivot that would land on
 * interior punctuation ("e.g.") moves to the next letter. A word with no letter or digit pivots on
 * its first glyph. Glyphs are grapheme clusters (a flag, a ZWJ family or a Devanagari conjunct is
 * one glyph), and a word in a `NO_PIVOT_SCRIPT` is one pivot as a whole.
 */
function pivotRange(word: string): [number, number] {
  if (!hasPivot(word)) return [0, word.length];
  const gs = glyphs(word);
  let first = -1;
  let last = -1;
  gs.forEach((g, i) => {
    if (ALNUM.test(g)) {
      if (first < 0) first = i;
      last = i;
    }
  });
  let p = 0;
  if (first >= 0) {
    p = first + pivotOffset(last - first + 1);
    while (p < last && !ALNUM.test(gs[p]!)) p++;
  }
  let from = 0;
  for (let i = 0; i < p; i++) from += gs[i]!.length;
  return [from, from + (gs[p]?.length ?? 0)];
}

/**
 * False for a word that is shown whole and centered, without a pivot (PLAN §5.2): `splitOrp` then
 * returns `["", word, ""]`, and the renderer must not paint that "pivot" red or put it in the 40 % column.
 */
export function hasPivot(word: string): boolean {
  return !NO_PIVOT_SCRIPT.test(word);
}

/** Index of the pivot glyph in `word` as a UTF-16 offset (so `word.slice(i)` starts at the pivot). */
export function orp(word: string): number {
  return pivotRange(word)[0];
}

/** `[before, pivot, after]`; the three parts always join back into `word`. */
export function splitOrp(word: string): [string, string, string] {
  const [from, to] = pivotRange(word);
  return [word.slice(0, from), word.slice(from, to), word.slice(to)];
}

const CAPITAL = /\p{Lu}/gu;
const FULL_WIDTH = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/**
 * A rough width of `text` on one line, in lower-case characters: a capital counts 1.5 and a
 * full-width character (CJK, Hangul) 1.8, which is how much wider they are in the UI fonts. The
 * renderer passes it to the CSS, which shrinks the type until that many characters fit the stage.
 */
export function inkLength(text: string): number {
  return text.length + 0.5 * (text.match(CAPITAL)?.length ?? 0) + 0.8 * (text.match(FULL_WIDTH)?.length ?? 0);
}

// ---------------------------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------------------------

function isNumberOrAcronym(text: string): boolean {
  if (/\p{Nd}/u.test(text)) return true;
  let upper = 0;
  for (const ch of text) {
    if (/\p{Ll}/u.test(ch)) return false;
    if (/\p{Lu}/u.test(ch)) upper++;
  }
  return upper >= 2;
}

/**
 * How many base words (one word = `60000 / wpm` ms) each token lasts: the long-word, number,
 * clause, sentence and paragraph multipliers. Independent of `t.wpm`, and the expensive part (a
 * grapheme segmenter per non-ASCII token), so compute it once per text and rescale with
 * `delays`/`baseMs` when the speed changes.
 */
export function factors(tokens: Token[], t: Timing = DEFAULT_TIMING): number[] {
  return tokens.map((tok) => {
    let f = Math.min(t.longWordCap, 1 + t.longWord * Math.max(0, alnumCount(tok.text) - 6));
    if (isNumberOrAcronym(tok.text)) f *= t.numberFactor;
    if (tok.paraEnd) f *= t.paragraph;
    else {
      const kind = endKind(tok.text);
      if (kind === "sentence") f *= t.sentence;
      else if (kind === "clause") f *= t.clause;
    }
    return f;
  });
}

/** Milliseconds a base word lasts at `wpm`. */
export const baseMs = (wpm: number): number => 60_000 / Math.max(1, wpm);

/** Milliseconds each token stays on screen, without the start-up ramp. */
export function delays(tokens: Token[], t: Timing = DEFAULT_TIMING): number[] {
  const base = baseMs(t.wpm);
  return factors(tokens, t).map((f) => base * f);
}

/** Slow-down multiplier for the k-th word since a (re)start: `rampFrom` down to 1, linearly. */
export function rampFactor(k: number, rampWords: number, rampFrom: number): number {
  if (!(rampWords > 0) || k >= rampWords) return 1;
  return rampFrom + ((1 - rampFrom) * Math.max(0, k)) / rampWords;
}

// ---------------------------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------------------------

/**
 * Token indices per flash (chunk mode), up to `n` words. A frame never crosses a paragraph end
 * and ends after sentence-ending punctuation.
 */
export function frames(tokens: Token[], n: number): number[][] {
  const size = Math.max(1, Math.floor(n) || 1);
  const out: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    cur.push(i);
    const next = tokens[i + 1];
    if (cur.length >= size || tokens[i]!.paraEnd || !next || next.sentenceStart) {
      out.push(cur);
      cur = [];
    }
  }
  return out;
}

/**
 * Maps a speech `charIndex` (UTF-16 offset in `paragraphs[para]`) to a token index: the token
 * covering it (the first part of a split long word), else the last token starting before it.
 * Returns -1 when no token of that paragraph starts at or before `charIndex`.
 */
export function tokenAtChar(tokens: Token[], para: number, charIndex: number): number {
  // Binary search for the last token with (para, start) <= (para, charIndex).
  let lo = 0;
  let hi = tokens.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = tokens[mid]!;
    if (t.para < para || (t.para === para && t.start <= charIndex)) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0 || tokens[found]!.para !== para) return -1;
  const t = tokens[found]!;
  if (charIndex >= t.end) return found; // between words
  while (found > 0 && tokens[found - 1]!.para === para && tokens[found - 1]!.start === t.start) found--;
  return found;
}

/** Index of the sentence start at or before token `i` (0 when there is none). */
export function sentenceStartBefore(tokens: Token[], i: number): number {
  let k = Math.min(Math.max(0, Math.floor(i) || 0), tokens.length - 1);
  while (k > 0 && !tokens[k]!.sentenceStart) k--;
  return Math.max(0, k);
}
