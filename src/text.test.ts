// Run with: npm test   (Node >= 22.18 strips the types natively; excluded from tsconfig)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_TIMING,
  cleanup,
  delays,
  frames,
  orp,
  rampFactor,
  sentenceStartBefore,
  splitOrp,
  tokenAtChar,
  tokenize,
  toParagraphs,
  type Line,
  type OcrResult,
  type Timing,
  type Token,
} from "./text.ts";

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

const tok = (text: string, o: Partial<Token> = {}): Token => ({
  text,
  para: 0,
  start: 0,
  end: text.length,
  sentenceStart: false,
  paraEnd: false,
  ...o,
});
const texts = (ts: Token[]) => ts.map((t) => t.text);
const approx = (actual: number, expected: number, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const rounded = (xs: number[]) => xs.map((x) => Math.round(x));
/** A 0.03-high OCR line. */
const line = (t: string, x: number, y: number, w: number, c = 0.95): Line => ({ t, x, y, w, h: 0.03, c });
const words = (n: number, w: string) => Array.from({ length: n }, () => w).join(" ");
const at300: Timing = { ...DEFAULT_TIMING, wpm: 300 }; // 200 ms per plain word
/** Milliseconds `fn` takes (wall clock). */
const timed = (fn: () => void): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};
/** UTF-16 offsets where a user-perceived character starts, plus the end of the string. */
const graphemeBoundaries = (s: string): Set<number> =>
  new Set([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map((g) => g.index).concat(s.length));
/** A recorded OCR helper response (`src/fixtures/*.json`). */
const fixture = (name: string): OcrResult =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

// ---------------------------------------------------------------------------------------------
// ORP
// ---------------------------------------------------------------------------------------------

test("orp: pivot table by letter count", () => {
  const expected = [0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4]; // 1..20 letters
  expected.forEach((p, i) => assert.equal(orp("x".repeat(i + 1)), p, `${i + 1} letters`));
});

test("orp: leading and trailing punctuation is ignored and offsets the index", () => {
  assert.equal(orp("Hello"), 1);
  assert.equal(orp("“Hello"), 2);
  assert.deepEqual(splitOrp("“Hello"), ["“H", "e", "llo"]);
  assert.equal(orp("Hello,”"), 1);
  assert.deepEqual(splitOrp("(a)"), ["(", "a", ")"]);
  // 13 letters inside quotes and a comma: pivot is letter index 3 ("r" of "extraordinary")
  assert.deepEqual(splitOrp("“extraordinary,”"), ["“ext", "r", "aordinary,”"]);
  assert.deepEqual(splitOrp("....Hi"), ["....H", "i", ""]);
});

test("orp: a split part ignores its trailing hyphen", () => {
  assert.equal(orp("extraord-"), 2);
  assert.deepEqual(splitOrp("extraord-"), ["ex", "t", "raord-"]);
});

test("orp: interior punctuation counts toward the length but never holds the pivot", () => {
  assert.deepEqual(splitOrp("don't"), ["d", "o", "n't"]);
  assert.deepEqual(splitOrp("e.g."), ["e.", "g", "."]); // pivot would be "." -> next letter
});

test("orp: words without letters or digits, and the empty string", () => {
  assert.equal(orp("—"), 0);
  assert.equal(orp("..."), 0);
  assert.equal(orp(""), 0);
  assert.deepEqual(splitOrp("—"), ["", "—", ""]);
  assert.deepEqual(splitOrp(""), ["", "", ""]);
});

test("orp: code points, so emoji and CJK do not break it", () => {
  assert.deepEqual(splitOrp("😀"), ["", "😀", ""]);
  assert.deepEqual(splitOrp("hi😀"), ["h", "i", "😀"]); // emoji is not a letter
  assert.deepEqual(splitOrp("你好"), ["你", "好", ""]);
  // three astral-plane Han characters: letter index 1, which is UTF-16 offset 2
  assert.equal(orp("\u{20000}\u{20001}\u{20002}"), 2);
  assert.deepEqual(splitOrp("\u{20000}\u{20001}\u{20002}"), ["\u{20000}", "\u{20001}", "\u{20002}"]);
  // a decomposed é (e + combining acute) is one letter
  assert.deepEqual(splitOrp("cafés"), ["c", "a", "fés"]);
});

test("splitOrp is consistent with orp", () => {
  const samples = ["a", "to", "Hello", "“Hello”", "reader", "transmission", "extraordinary", "e.g.", "—", "你好吗", "naïve", "x".repeat(30)];
  for (const w of samples) {
    const [l, p, r] = splitOrp(w);
    assert.equal(l + p + r, w);
    assert.equal(l.length, orp(w));
    assert.equal(w.slice(orp(w), orp(w) + p.length), p);
  }
});

const FAMILY = "👨‍👩‍👧‍👦"; // man + woman + girl + boy joined by ZWJs: 7 code points, 11 UTF-16 units, one glyph
const US_FLAG = "🇺🇸"; // two regional indicators: one glyph
const DEVANAGARI = "क्षत्रिय"; // kshatriya: the conjunct क्ष (क + virama + ष) is one glyph
const ARABIC = "مرحبا";
const HEBREW = "שלום";

test("orp: a flag or a ZWJ family is one glyph, never cut in the middle", () => {
  assert.deepEqual(splitOrp(US_FLAG), ["", US_FLAG, ""]);
  assert.equal(orp(US_FLAG), 0);
  assert.deepEqual(splitOrp(FAMILY), ["", FAMILY, ""]);
  assert.deepEqual(splitOrp("👍🏽"), ["", "👍🏽", ""]); // emoji + skin tone
  assert.deepEqual(splitOrp("hi" + US_FLAG), ["h", "i", US_FLAG]);
  assert.deepEqual(splitOrp("Hi" + FAMILY), ["H", "i", FAMILY]);
  assert.deepEqual(splitOrp(US_FLAG + "🇩🇪"), ["", US_FLAG, "🇩🇪"]); // no letters: the first glyph pivots
  assert.deepEqual(splitOrp(FAMILY + "ab"), [FAMILY + "a", "b", ""]); // the emoji counts as a glyph, not as a letter
  assert.equal(orp(FAMILY + "ab"), FAMILY.length + 1); // a UTF-16 offset
});

test("orp: Hangul written as separate jamo is one letter per syllable", () => {
  const nfd = "한국어".normalize("NFD");
  assert.equal(nfd.length, 8); // 3 + 3 + 2 jamo
  assert.deepEqual(splitOrp(nfd), ["한".normalize("NFD"), "국".normalize("NFD"), "어".normalize("NFD")]);
});

test("orp: Arabic and Hebrew get no pivot (right-to-left, joining letters)", () => {
  for (const w of [ARABIC, "مرحبا،", "(مرحبا)", "«" + ARABIC + "»", "ا", HEBREW, "שלום.", "אב"]) {
    assert.deepEqual(splitOrp(w), ["", w, ""], w);
    assert.equal(orp(w), 0, w);
  }
  assert.deepEqual(splitOrp("iPhoneمرحبا"), ["", "iPhoneمرحبا", ""]); // one Arabic letter is enough
});

test("orp: Devanagari and other Indic scripts with conjuncts get no pivot", () => {
  for (const w of [DEVANAGARI, "नमस्ते", "বাংলা", "ਪੰਜਾਬੀ", "ગુજરાતી", "தமிழ்", "తెలుగు", "ಕನ್ನಡ", "മലയാളം", "සිංහල", "ខ្មែរ", "မြန်မာ", "བོད་ཡིག"]) {
    assert.deepEqual(splitOrp(w), ["", w, ""], w);
    assert.equal(orp(w), 0, w);
  }
});

test("orp: scripts that split safely keep their pivot (Latin, Greek, Cyrillic, CJK, Korean, Thai)", () => {
  assert.deepEqual(splitOrp("Привет"), ["Пр", "и", "вет"]);
  assert.deepEqual(splitOrp("αβγδε"), ["α", "β", "γδε"]);
  assert.deepEqual(splitOrp("안녕하세요"), ["안", "녕", "하세요"]);
  assert.deepEqual(splitOrp("สวัสดี"), ["ส", "วั", "สดี"]); // Thai: the vowel mark stays with its consonant
});

test("splitOrp: always joins back into the word, with the pivot on a grapheme boundary", () => {
  const samples = [
    "a", "to", "Hello", "“Hello”", "e.g.", "—", "", "x".repeat(30), "cafe\u0301s", "naïve",
    US_FLAG, "hi" + US_FLAG, FAMILY, "Hi" + FAMILY + "!", "😀😀", "👍🏽ok", "한국어".normalize("NFD"),
    "你好吗", "\u{20000}\u{20001}\u{20002}", "e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301", "\u0301x",
    ARABIC, HEBREW, DEVANAGARI, "مرحبا،", "(שלום)",
  ];
  for (const w of samples) {
    const [l, p, r] = splitOrp(w);
    assert.equal(l + p + r, w, JSON.stringify(w));
    assert.equal(l.length, orp(w), JSON.stringify(w));
    const cuts = graphemeBoundaries(w);
    assert.ok(cuts.has(l.length) && cuts.has(l.length + p.length), `cluster cut in ${JSON.stringify(w)}`);
    if (w !== "") assert.ok(p !== "", JSON.stringify(w));
  }
});

// ---------------------------------------------------------------------------------------------
// delays and ramp
// ---------------------------------------------------------------------------------------------

test("DEFAULT_TIMING matches PLAN §5.3", () => {
  assert.deepEqual(
    { ...DEFAULT_TIMING },
    { wpm: 350, longWord: 0.04, longWordCap: 1.5, numberFactor: 1.3, clause: 1.6, sentence: 2.2, paragraph: 3.0, rampFrom: 1.6, rampWords: 8, resumeRampWords: 4 },
  );
});

test("delays: plain words use the base interval", () => {
  assert.deepEqual(delays([tok("alpha"), tok("a"), tok("reader")], at300), [200, 200, 200]);
  approx(delays([tok("alpha")])[0]!, 60000 / 350);
  assert.deepEqual(delays([]), []);
});

test("delays: long words stretch by 4 % per letter over 6, capped at 1.5", () => {
  const [nine, ten, huge] = delays([tok("elephants"), tok("encyclopedia"), tok("internationalization")], at300) as [number, number, number];
  approx(nine, 200 * 1.12); // 9 letters
  approx(ten, 200 * 1.24); // 12 letters
  approx(huge, 200 * 1.5); // 20 letters would be 1.56 -> capped
});

test("delays: the long-word factor counts glyphs, not code points", () => {
  const [conjuncts, flags, plain] = delays([tok("क्ष".repeat(10)), tok(US_FLAG.repeat(12)), tok("a".repeat(10))], at300) as [number, number, number];
  approx(conjuncts, 200 * 1.16); // 10 glyphs (20 letter code points would hit the 1.5 cap)
  approx(flags, 200); // flags are not letters
  approx(plain, 200 * 1.16);
});

test("delays: digits and ALL-CAPS get the number factor", () => {
  const d = delays([tok("2024"), tok("NASA"), tok("A3"), tok("A"), tok("I"), tok("NASA's"), tok("Hello"), tok("OK")], at300);
  assert.deepEqual(rounded(d), [260, 260, 260, 200, 200, 200, 200, 260]);
});

test("delays: clause, sentence and paragraph pauses", () => {
  const d = rounded(delays(
    [
      tok("alpha,"), tok("alpha;"), tok("alpha:"), tok("alpha—"), tok("alpha–"), tok("(alpha)"), // clause
      tok("alpha."), tok("alpha!"), tok("alpha?"), tok("alpha…"), tok("alpha.”"), tok("(alpha.)"), // sentence
      tok("alpha-"), tok("e.g."), tok("Dr."), // none (hyphenated part, abbreviations)
    ],
    at300,
  ));
  assert.deepEqual(d.slice(0, 6), Array(6).fill(320));
  assert.deepEqual(d.slice(6, 12), Array(6).fill(440));
  assert.deepEqual(d.slice(12), [200, 200, 200]);
});

test("delays: paragraph end beats sentence and clause", () => {
  const d = delays([tok("alpha", { paraEnd: true }), tok("alpha.", { paraEnd: true }), tok("alpha,", { paraEnd: true })], at300);
  assert.deepEqual(d, [600, 600, 600]);
});

test("delays: multipliers multiply", () => {
  const [a, b, c] = delays([tok("NASA,"), tok("internationalization."), tok("2024.", { paraEnd: true })], at300) as [number, number, number];
  approx(a, 200 * 1.3 * 1.6);
  approx(b, 200 * 1.5 * 2.2);
  approx(c, 200 * 1.3 * 3);
});

test("delays: wpm and every multiplier come from the Timing argument", () => {
  const t: Timing = { ...DEFAULT_TIMING, wpm: 600, sentence: 4, paragraph: 5 };
  assert.deepEqual(delays([tok("alpha"), tok("alpha."), tok("alpha", { paraEnd: true })], t), [100, 400, 500]);
});

test("delays: tokenizer output end to end", () => {
  const d = delays(tokenize(["Hello, world."]), at300);
  assert.deepEqual(rounded(d), [320, 600]); // clause pause; final word is also the paragraph end
});

test("delays: 300 plain 5-letter words at 300 wpm take one minute (±1 %)", () => {
  const tokens = tokenize([words(300, "alpha")]);
  assert.equal(tokens.length, 300);
  const total = sum(delays(tokens, at300));
  assert.ok(Math.abs(total - 60_000) <= 600, `total ${total} ms`);
});

test("rampFactor: endpoints, midpoint, clamping", () => {
  assert.equal(rampFactor(0, 8, 1.6), 1.6);
  approx(rampFactor(4, 8, 1.6), 1.3);
  approx(rampFactor(2, 8, 1.6), 1.45);
  assert.equal(rampFactor(8, 8, 1.6), 1);
  assert.equal(rampFactor(500, 8, 1.6), 1);
  assert.equal(rampFactor(-3, 8, 1.6), 1.6);
  assert.equal(rampFactor(0, 0, 1.6), 1); // ramp disabled
  approx(rampFactor(2, 4, 2), 1.5); // the resume ramp uses the same formula
  let prev = Infinity;
  for (let k = 0; k <= 10; k++) {
    const f = rampFactor(k, 8, 1.6);
    assert.ok(f <= prev && f >= 1);
    prev = f;
  }
});

// ---------------------------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------------------------

test("cleanup: de-hyphenates across line breaks when the next line is lowercase", () => {
  assert.equal(cleanup("an exam-\nple of it"), "an example of it");
  assert.equal(cleanup("an exam-  \n   ple of it"), "an example of it");
  assert.equal(cleanup("an exam-\r\nple of it"), "an example of it");
  assert.equal(cleanup("naïve-\nté"), "naïveté");
  assert.equal(cleanup("a well-known fact"), "a well-known fact"); // no line break, no change
  assert.equal(cleanup("exam­\nple"), "example"); // soft hyphen at a break
  assert.equal(cleanup("co­operate"), "cooperate");
});

test("cleanup: de-hyphenates across blank lines and other whitespace between the lines", () => {
  assert.equal(cleanup("an exam-\n\n\n  ple of it"), "an example of it");
  assert.equal(cleanup("an exam- \t \n \t\n ple of it"), "an example of it");
  assert.equal(cleanup("an exam-\u00a0\n\u3000ple of it"), "an example of it");
  assert.equal(cleanup("an exam‐\nple of it"), "an example of it"); // U+2010 hyphen
  assert.equal(cleanup("an exam- ple of it"), "an exam- ple of it"); // no line break: a real hyphen
});

test("cleanup: linear on a long whitespace run after a hyphen (was quadratic in the newline count)", () => {
  const blankLines = "a-" + "\n".repeat(32_000) + "B"; // next line is uppercase: no match, the engine must give up fast
  const spacedLines = "a-" + " \n".repeat(16_000) + "B";
  const joined = "a-" + "\n".repeat(32_000) + "b";
  assert.equal(cleanup(blankLines), "a- B");
  assert.equal(cleanup(spacedLines), "a- B");
  assert.equal(cleanup(joined), "ab");
  for (const input of [blankLines, spacedLines, joined]) {
    const ms = timed(() => cleanup(input));
    assert.ok(ms < 50, `${ms.toFixed(1)} ms for ${input.length} chars`); // the old regex took 400-700 ms
  }
});

test("delays: linear on a very long run of closing brackets", () => {
  const token = tok(")".repeat(32_000) + "a"); // endKind used to rescan the run from every start offset
  const ms = timed(() => delays([token]));
  assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
  assert.equal(delays([tok(")".repeat(32_000))])[0], 60_000 / 350 * 1.6); // all closers: clause end via ")"
});

test("cleanup: keeps the hyphen when the next line starts uppercase or with a digit", () => {
  assert.ok(cleanup("the Anglo-\nSaxon era").includes("Anglo-"));
  assert.equal(cleanup("pages 1-\n2"), "pages 1- 2");
});

test("cleanup: ligatures are expanded, everything else is not NFKC-normalized", () => {
  assert.equal(cleanup("ﬁnal ﬂow oﬀice ﬃ ﬄ"), "final flow office ffi ffl");
  assert.equal(cleanup("ｆｕｌｌ ① x² ½"), "ｆｕｌｌ ① x² ½");
});

test("cleanup: drops UI chrome and bullets", () => {
  assert.equal(cleanup("• Item one | Item two » next · end ■ ▪ → done"), "Item one Item two next end done");
  assert.equal(cleanup("Home » Blog » Post"), "Home Blog Post");
  assert.equal(cleanup("« Back | Next »"), "Back Next");
  assert.equal(cleanup("* note # tag ~ x"), "note tag x");
  assert.equal(cleanup("Great 👍 job"), "Great job"); // a standalone emoji is chrome ...
  assert.equal(cleanup("Great👍 job"), "Great👍 job"); // ... one attached to a word is text
});

test("cleanup: keeps real punctuation, even standalone", () => {
  assert.equal(cleanup("Tom & Jerry"), "Tom & Jerry");
  assert.equal(cleanup("wait — what"), "wait — what");
  assert.equal(cleanup("a – b"), "a – b");
  assert.equal(cleanup("5 - 3"), "5 - 3");
  assert.equal(cleanup("2 + 2 = 4"), "2 + 2 = 4");
  assert.equal(cleanup("50 % off for $ 5"), "50 % off for $ 5");
  assert.equal(cleanup("a 1 b I c"), "a 1 b I c"); // anything with a letter or digit stays
  assert.equal(cleanup("wait ... what"), "wait ... what"); // 3 characters: not a symbol fragment
});

test("cleanup: a dash at the start or end of a line is a bullet, not a dash", () => {
  assert.equal(cleanup("- item"), "item");
  assert.equal(cleanup("intro:\n- one\n- two"), "intro: one two");
  assert.equal(cleanup("item -"), "item");
  assert.equal(cleanup("• - item"), "item");
  assert.equal(cleanup("one - two\n— three"), "one - two three");
});

test("cleanup: floating punctuation (French spacing, OCR gaps) glues to the previous word", () => {
  assert.equal(cleanup("Bonjour !"), "Bonjour!");
  assert.equal(cleanup("Qu'est-ce que c'est ?"), "Qu'est-ce que c'est?");
  assert.equal(cleanup("Hello , world ."), "Hello, world.");
  assert.equal(cleanup("(see this )"), "(see this)");
  assert.equal(cleanup("Done\n."), "Done.");
});

test("cleanup: collapses whitespace and trims", () => {
  assert.equal(cleanup("  a \t b c\n\n d  "), "a b c d");
  assert.equal(cleanup(""), "");
  assert.equal(cleanup(" • | "), "");
});

// ---------------------------------------------------------------------------------------------
// toParagraphs: OCR paragraphs
// ---------------------------------------------------------------------------------------------

test("toParagraphs: cleaned paragraphs pass through, empties are dropped", () => {
  assert.deepEqual(toParagraphs({ paragraphs: ["  Hello \n world ", "", "  •  ", "Second ﬁne one"] }), ["Hello world", "Second fine one"]);
  assert.deepEqual(toParagraphs({}), []);
  assert.deepEqual(toParagraphs({ lines: [] }), []);
});

test("toParagraphs: paragraphs win over lines, lines are the fallback", () => {
  const lines = [line("From the lines", 0.05, 0.05, 0.5)];
  assert.deepEqual(toParagraphs({ paragraphs: ["From the paragraphs"], lines }), ["From the paragraphs"]);
  assert.deepEqual(toParagraphs({ paragraphs: [], lines }), ["From the lines"]);
  assert.deepEqual(toParagraphs({ paragraphs: ["  "], lines }), ["From the lines"]);
});

// ---------------------------------------------------------------------------------------------
// toParagraphs: lines -> paragraphs
// ---------------------------------------------------------------------------------------------

const P1_TEXT =
  "Reading text one word at a time can feel strange at first, but the eye soon adapts to the fixed position of each word on the screen.";
const P2_TEXT = "A second paragraph begins here and continues on the next line.";
const oneColumn: Line[] = [
  line("Reading text one word at a time can", 0.05, 0.05, 0.9),
  line("feel strange at first, but the eye", 0.05, 0.09, 0.9),
  line("soon adapts to the fixed position of", 0.05, 0.13, 0.9),
  line("each word on the screen.", 0.05, 0.17, 0.5),
  line("A second paragraph begins here and", 0.05, 0.25, 0.9), // 0.05 gap > 0.75 x line height
  line("continues on the next line.", 0.05, 0.29, 0.6),
];

test("lines: one column with two paragraphs (vertical gap)", () => {
  assert.deepEqual(toParagraphs({ lines: oneColumn }), [P1_TEXT, P2_TEXT]);
});

test("lines: input order does not matter (sorted by y, then x)", () => {
  assert.deepEqual(toParagraphs({ lines: [...oneColumn].reverse() }), [P1_TEXT, P2_TEXT]);
});

test("lines: a short line that ends a sentence starts a new paragraph, even without a gap", () => {
  const lines = [
    line("The first sentence runs the full width of the box.", 0.05, 0.05, 0.9), // long: paragraph continues
    line("Then a short one.", 0.05, 0.09, 0.3), // short + ends a sentence
    line("Next paragraph starts here without any gap", 0.05, 0.13, 0.9),
    line("and goes on.", 0.05, 0.17, 0.4),
  ];
  assert.deepEqual(toParagraphs({ lines }), [
    "The first sentence runs the full width of the box. Then a short one.",
    "Next paragraph starts here without any gap and goes on.",
  ]);
});

test("lines: an indent change after a sentence end starts a new paragraph", () => {
  const lines = [
    line("An indented paragraph follows this one.", 0.05, 0.05, 0.9),
    line("First line of the second paragraph is", 0.09, 0.09, 0.86),
    line("pushed in by a few points of space.", 0.05, 0.13, 0.9),
  ];
  assert.deepEqual(toParagraphs({ lines }), [
    "An indented paragraph follows this one.",
    "First line of the second paragraph is pushed in by a few points of space.",
  ]);
});

const LEFT = [
  "The first column holds the opening",
  "part of the story, which carries on",
  "down the page until the line runs",
  "out of room and the text wraps over",
  "to the second column.",
];
const RIGHT = [
  "where the story continues without",
  "any break in the middle of the",
  "sentence. It ends here with a",
  "last line of the article that is",
  "done.",
];
const LEFT_TEXT = LEFT.join(" ");
const RIGHT_TEXT = RIGHT.join(" ");
const twoColumns: Line[] = [
  ...LEFT.map((t, i) => line(t, 0.05, 0.1 + i * 0.04, 0.4)),
  ...RIGHT.map((t, i) => line(t, 0.55, 0.1 + i * 0.04, 0.4)),
];

test("lines: two columns are read column by column, left to right", () => {
  assert.deepEqual(toParagraphs({ lines: twoColumns }), [LEFT_TEXT, RIGHT_TEXT]);
  assert.deepEqual(toParagraphs({ lines: [...twoColumns].reverse() }), [LEFT_TEXT, RIGHT_TEXT]);
});

test("lines: full-width heading and footer stay in place around two columns", () => {
  const lines = [
    line("The Title Spans Both Columns", 0.05, 0.04, 0.9),
    ...twoColumns,
    line("Published by the editorial team", 0.05, 0.32, 0.9),
  ];
  assert.deepEqual(toParagraphs({ lines }), [
    "The Title Spans Both Columns",
    LEFT_TEXT,
    RIGHT_TEXT,
    "Published by the editorial team",
  ]);
});

test("lines: chat-like short lines become one paragraph each", () => {
  const lines = [
    line("Hey, are you coming tonight?", 0.05, 0.05, 0.5),
    line("Yes!", 0.05, 0.12, 0.12),
    line("I will be there at 8.", 0.05, 0.19, 0.35),
    line("Great, see you then", 0.05, 0.26, 0.4),
  ];
  assert.deepEqual(toParagraphs({ lines }), ["Hey, are you coming tonight?", "Yes!", "I will be there at 8.", "Great, see you then"]);
});

test("lines: chat bubbles on alternating sides are not mistaken for columns", () => {
  const lines = [
    line("Hey, are you free later?", 0.05, 0.05, 0.3),
    line("Sure, what time?", 0.65, 0.12, 0.3),
    line("Around seven maybe.", 0.05, 0.19, 0.3),
    line("Works for me!", 0.65, 0.26, 0.3),
    line("Perfect, see you.", 0.05, 0.33, 0.3),
    line("See you there.", 0.65, 0.4, 0.3),
  ];
  assert.deepEqual(toParagraphs({ lines }), [
    "Hey, are you free later?",
    "Sure, what time?",
    "Around seven maybe.",
    "Works for me!",
    "Perfect, see you.",
    "See you there.",
  ]);
});

test("lines: low-confidence lines are dropped (below 0.3), empty lines too", () => {
  const lines = [
    line("Kept line", 0.05, 0.05, 0.9, 0.95),
    line("Boundary line kept", 0.05, 0.09, 0.9, 0.3),
    line("ADVERTISEMENT BUY NOW", 0.05, 0.13, 0.9, 0.1),
    line("Just under the bar", 0.05, 0.17, 0.9, 0.29),
    line("   ", 0.05, 0.21, 0.9, 0.99),
  ];
  assert.deepEqual(toParagraphs({ lines }), ["Kept line Boundary line kept"]);
  assert.deepEqual(toParagraphs({ lines: [line("noise", 0.1, 0.1, 0.2, 0.05)] }), []);
});

test("lines: a hyphen at a line end is joined when the next line starts lowercase", () => {
  const lines = [
    line("The reading speed of an exam-", 0.05, 0.05, 0.9),
    line("ple text improves with practice.", 0.05, 0.09, 0.6),
  ];
  assert.deepEqual(toParagraphs({ lines }), ["The reading speed of an example text improves with practice."]);
});

test("lines: lines on the same row are joined left to right", () => {
  const lines = [line("world and more.", 0.5, 0.0502, 0.4), line("Hello", 0.05, 0.05, 0.2)];
  assert.deepEqual(toParagraphs({ lines }), ["Hello world and more."]);
});

// Recorded from the real OCR helper (`wordstrobe-ocr`, `{"fast":true,"langs":["en-US"]}`, which returns
// `lines`) on screenshots rendered with the system font: 1600x440 px for the article, 800x640 px for the chat.
// Vision returns the lines in its own order (two-column.json is interleaved: column 1, column 2, column 1).

test("fixture: two-column article, a headline over two paragraphs per column", () => {
  const ocr = fixture("two-column");
  assert.equal(ocr.lines!.length, 15);
  const expected = [
    "Sponge Cities Take Root",
    "Cities are quietly changing how they handle rain. Instead of sending every drop down a pipe, planners now ask where the water could stay. Parks, roofs and even parking lots are being redesigned as sponges.",
    "The idea is not new, but it is finally cheap enough to try at scale. A single street of rain gardens costs less than one new storm drain, and it keeps working long after the drain has clogged.",
    "Early results are encouraging. After two wet winters, the pilot district reported far fewer flooded basements, and residents say the gardens made the street feel calmer and greener.",
    "Engineers warn that sponges only work when the soil beneath them is healthy. Compacted ground sheds water like a roof, so the next step is a map of where the soil can still drink.",
  ];
  assert.deepEqual(toParagraphs(ocr), expected);
  assert.deepEqual(toParagraphs({ lines: [...ocr.lines!].reverse() }), expected); // input order is irrelevant
  const at = (start: string) => ocr.lines!.findIndex((l) => l.t.startsWith(start));
  assert.ok(at("The idea is not new") > at("Engineers warn")); // the recorded order really interleaves the columns
});

test("fixture: chat screenshot, one paragraph per message in time order", () => {
  const ocr = fixture("chat");
  assert.equal(ocr.lines!.length, 7); // the first message wraps onto two lines
  const expected = [
    "Today 9:41 AM",
    "Hey, are you coming to the meetup tonight?", // the two-line bubble stays one paragraph
    "Yes, I will be there around 8.", // right-aligned bubble
    "Great. Can you bring the projector?",
    "Sure, no problem.", // right-aligned bubble
    "Perfect, see you then.",
  ];
  assert.deepEqual(toParagraphs(ocr), expected);
  assert.deepEqual(toParagraphs({ lines: [...ocr.lines!].reverse() }), expected);
});

test("fixture: recorded paragraphs feed the tokenizer and map back to their text", () => {
  for (const name of ["two-column", "chat"]) {
    const paras = toParagraphs(fixture(name));
    const tokens = tokenize(paras, fixture(name).lang);
    assert.equal(tokens.filter((t) => t.paraEnd).length, paras.length);
    for (const t of tokens) assert.equal(paras[t.para]!.slice(t.start, t.end), t.text);
  }
});

// ---------------------------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------------------------

test("tokenize: whitespace split, punctuation attached, flags", () => {
  const tokens = tokenize(["Hello, world. How are you?"]);
  assert.deepEqual(texts(tokens), ["Hello,", "world.", "How", "are", "you?"]);
  assert.deepEqual(tokens.map((t) => t.sentenceStart), [true, false, true, false, false]);
  assert.deepEqual(tokens.map((t) => t.paraEnd), [false, false, false, false, true]);
  assert.ok(tokens.every((t) => t.para === 0));
});

test("tokenize: offsets point at the word in its paragraph", () => {
  const paras = ["The quick  brown fox.\nJumps over", "  Second\tparagraph “here”."];
  const tokens = tokenize(paras);
  assert.equal(tokens.length, 9);
  for (const t of tokens) assert.equal(paras[t.para]!.slice(t.start, t.end), t.text);
});

test("tokenize: paragraphs get their own start and end flags", () => {
  const tokens = tokenize(["One two three", "", "Four five. Six"]);
  assert.deepEqual(texts(tokens), ["One", "two", "three", "Four", "five.", "Six"]);
  assert.deepEqual(tokens.map((t) => t.para), [0, 0, 0, 2, 2, 2]); // `para` indexes the input array
  assert.deepEqual(tokens.map((t) => t.sentenceStart), [true, false, false, true, false, true]);
  assert.deepEqual(tokens.map((t) => t.paraEnd), [false, false, true, false, false, true]);
  assert.deepEqual(tokenize([]), []);
  assert.deepEqual(tokenize(["   "]), []);
});

test("tokenize: common abbreviations do not end a sentence", () => {
  const tokens = tokenize(["Mr. Smith met Dr. Jones, i.e. the boss, (e.g. at noon). Then he left. Prof. Lee vs. Ms. Kim."]);
  const starts = tokens.filter((t) => t.sentenceStart).map((t) => t.text);
  assert.deepEqual(starts, ["Mr.", "Then", "Prof."]);
});

test("tokenize: a sentence end may be followed by closing quotes or brackets", () => {
  const tokens = tokenize(["He said “Go.” Then he left… Later it ended?! Yes (done.) Next."]);
  const starts = tokens.filter((t) => t.sentenceStart).map((t) => t.text);
  assert.deepEqual(starts, ["He", "Then", "Later", "Yes", "Next."]);
});

test("tokenize: long words split into balanced parts of at most 9 letters", () => {
  const split = (n: number) => texts(tokenize(["a".repeat(n)]));
  assert.deepEqual(split(13), ["a".repeat(13)]); // not long enough
  assert.deepEqual(split(14), ["aaaaaaa-", "aaaaaaa"]);
  assert.deepEqual(split(18), ["aaaaaaaaa-", "aaaaaaaaa"]);
  assert.deepEqual(split(19), ["aaaaaaa-", "aaaaaa-", "aaaaaa"]);
  assert.deepEqual(split(20), ["aaaaaaa-", "aaaaaaa-", "aaaaaa"]);
  assert.deepEqual(split(27), ["aaaaaaaaa-", "aaaaaaaaa-", "aaaaaaaaa"]);
  for (let n = 14; n <= 60; n++) {
    const parts = split(n);
    const letters = parts.map((p) => p.replace("-", "").length);
    assert.equal(sum(letters), n);
    assert.ok(Math.max(...letters) <= 9 && Math.max(...letters) - Math.min(...letters) <= 1);
    assert.ok(parts.slice(0, -1).every((p) => p.endsWith("-")) && !parts.at(-1)!.endsWith("-"));
  }
});

test("tokenize: split parts share the source range and keep the punctuation at the ends", () => {
  const para = "See “internationalization,” soon.";
  const tokens = tokenize([para]);
  assert.deepEqual(texts(tokens), ["See", "“interna-", "tionali-", "zation,”", "soon."]);
  const [, a, b, c] = tokens as [Token, Token, Token, Token];
  assert.ok(a.start === b.start && b.start === c.start && a.end === b.end && b.end === c.end);
  assert.equal(para.slice(a.start, a.end), "“internationalization,”");
  assert.ok(!a.sentenceStart && !b.sentenceStart && !c.sentenceStart);
});

test("tokenize: letters are counted per glyph, so a conjunct or a flag does not inflate the length", () => {
  const ten = "क्ष".repeat(10); // 10 glyphs (20 code points that are letters)
  assert.deepEqual(texts(tokenize([ten])), [ten]);
  assert.deepEqual(texts(tokenize(["क्ष".repeat(14)])), ["क्ष".repeat(7) + "-", "क्ष".repeat(7)]); // cut between conjuncts
  const flags = US_FLAG.repeat(9); // 18 code points, 36 UTF-16 units, no letters
  assert.deepEqual(texts(tokenize([flags])), [flags]);
  const decomposed = "e\u0301".repeat(14); // 14 letters, 28 code points
  assert.deepEqual(texts(tokenize([decomposed])), ["e\u0301".repeat(7) + "-", "e\u0301".repeat(7)]);
  const jamo = "한국어".normalize("NFD").repeat(5); // 15 syllables written as 40 jamo: split 8 + 7
  const parts = texts(tokenize([jamo]));
  assert.deepEqual(parts.map((p) => p.replace("-", "").normalize("NFC")), ["한국어한국어한국", "어한국어한국어"]);
  assert.ok(parts[0]!.endsWith("-"));
});

test("tokenize: a split word that ends a sentence starts the next sentence correctly", () => {
  const tokens = tokenize(["Absolutely extraordinary. Next one", "abcdefghijklmn"]);
  assert.deepEqual(texts(tokens), ["Absolutely", "extraordinary.", "Next", "one", "abcdefg-", "hijklmn"]);
  assert.deepEqual(tokens.map((t) => t.sentenceStart), [true, false, true, false, true, false]);
  assert.deepEqual(tokens.map((t) => t.paraEnd), [false, false, false, true, false, true]);
  const long = tokenize(["Truly extraordinarily-complicated. Next"]);
  assert.deepEqual(texts(long), ["Truly", "extraordi-", "narily-com-", "plicated.", "Next"]);
  assert.deepEqual(long.filter((t) => t.sentenceStart).map((t) => t.text), ["Truly", "Next"]);
});

const zh = "我今天在北京大学学习中文。";
const ja = "私は毎日東京の大学で日本語を勉強しています。";

test("tokenize: Chinese is segmented, punctuation joins the previous token", () => {
  const tokens = tokenize([zh], "zh");
  assert.ok(tokens.length >= 4, `got ${texts(tokens).join("|")}`);
  assert.equal(texts(tokens).join(""), zh);
  assert.ok(tokens.at(-1)!.text.endsWith("。"));
  assert.ok(tokens.every((t) => /[\p{L}\p{N}]/u.test(t.text)), "no punctuation-only token");
  tokens.forEach((t, i) => {
    assert.equal(zh.slice(t.start, t.end), t.text);
    if (i > 0) assert.equal(t.start, tokens[i - 1]!.end);
  });
  assert.deepEqual(tokens.map((t) => t.sentenceStart), tokens.map((_, i) => i === 0));
  assert.ok(tokens.at(-1)!.paraEnd);
});

test("tokenize: Japanese is segmented, punctuation joins the previous token", () => {
  const tokens = tokenize([ja], "ja");
  assert.ok(tokens.length >= 5, `got ${texts(tokens).join("|")}`);
  assert.equal(texts(tokens).join(""), ja);
  assert.ok(tokens.at(-1)!.text.endsWith("。"));
  assert.ok(tokens.every((t) => /[\p{L}\p{N}]/u.test(t.text)));
});

test("tokenize: CJK sentence ends and clause marks", () => {
  const para = "今天天气很好，我们去公园玩。明天也好。";
  const tokens = tokenize([para], "zh-Hans");
  assert.equal(texts(tokens).join(""), para);
  assert.ok(tokens.some((t) => t.text.endsWith("，")));
  assert.ok(tokens.every((t) => !t.text.startsWith("，") && !t.text.startsWith("。")));
  const starts = tokens.filter((t) => t.sentenceStart);
  assert.equal(starts.length, 2);
  assert.ok(starts.every((t, i) => i === 0 || tokens[tokens.indexOf(t) - 1]!.text.endsWith("。")));
  const d = delays(tokens, at300);
  assert.ok(rounded(d).includes(320)); // the comma token
});

test("tokenize: opening quotes and brackets join the next token, not the previous one", () => {
  const para = "他说「你好」。";
  const tokens = tokenize([para], "zh");
  assert.equal(texts(tokens).join(""), para);
  assert.ok(tokens.every((t) => !t.text.endsWith("「")));
  assert.ok(tokens.some((t) => t.text.startsWith("「你好")));
  assert.ok(tokens.at(-1)!.text.endsWith("」。"));
});

test("tokenize: Thai is segmented", () => {
  const tokens = tokenize(["สวัสดีครับวันนี้อากาศดีมาก"], "th");
  assert.ok(tokens.length >= 4, `got ${texts(tokens).join("|")}`);
  assert.equal(texts(tokens).join(""), "สวัสดีครับวันนี้อากาศดีมาก");
});

test("tokenize: whatever the lang, a long CJK whitespace token is segmented; a short one is not", () => {
  const mixed = tokenize([`Read ${zh} now`], "en");
  assert.ok(mixed.length > 3);
  assert.equal(mixed[0]!.text, "Read");
  assert.equal(mixed.at(-1)!.text, "now");
  assert.deepEqual(texts(tokenize(["你好 world"], "en")), ["你好", "world"]);
  assert.deepEqual(texts(tokenize(["你好吗"], undefined)), ["你好吗"]); // 3 chars: below the threshold
  assert.ok(tokenize([zh], undefined).length >= 4);
});

test("tokenize: Latin tokens inside no-space languages stay whole; bad lang tags do not throw", () => {
  const t = texts(tokenize(["使用 state-of-the-art 3.14 U.S. 方法。"], "zh"));
  const i = t.indexOf("state-of-the-art");
  assert.ok(i >= 0);
  assert.deepEqual(t.slice(i, i + 3), ["state-of-the-art", "3.14", "U.S."]);
  assert.ok(tokenize([zh], "not a language").length >= 4);
  assert.deepEqual(texts(tokenize(["plain text"], "xx-INVALID-TAG-")), ["plain", "text"]);
});

// ---------------------------------------------------------------------------------------------
// frames
// ---------------------------------------------------------------------------------------------

const frameTokens = tokenize(["One two three four five. Six seven.", "Eight nine ten eleven"]);

test("frames: n = 1 is one token per frame", () => {
  assert.deepEqual(frames(frameTokens, 1), frameTokens.map((_, i) => [i]));
});

test("frames: n = 2 and n = 3 end at sentence and paragraph ends", () => {
  assert.deepEqual(frames(frameTokens, 2), [[0, 1], [2, 3], [4], [5, 6], [7, 8], [9, 10]]);
  assert.deepEqual(frames(frameTokens, 3), [[0, 1, 2], [3, 4], [5, 6], [7, 8, 9], [10]]);
});

test("frames: never cross a paragraph end, always cover every token once", () => {
  const tokens = tokenize(["a b c d e f g", "h i j", "k", "l m n o p", "abcdefghijklmnopqrstuvwxyz again! and again"]);
  for (const n of [1, 2, 3]) {
    const fs = frames(tokens, n);
    assert.deepEqual(fs.flat(), tokens.map((_, i) => i));
    for (const f of fs) {
      assert.ok(f.length >= 1 && f.length <= n);
      f.slice(0, -1).forEach((i) => assert.ok(!tokens[i]!.paraEnd && !tokens[i + 1]!.sentenceStart));
      assert.equal(new Set(f.map((i) => tokens[i]!.para)).size, 1);
    }
  }
});

test("frames: odd sizes fall back to 1, empty input gives no frames", () => {
  assert.deepEqual(frames(frameTokens, 0), frames(frameTokens, 1));
  assert.deepEqual(frames(frameTokens, NaN), frames(frameTokens, 1));
  assert.deepEqual(frames([], 3), []);
});

// ---------------------------------------------------------------------------------------------
// tokenAtChar and sentenceStartBefore
// ---------------------------------------------------------------------------------------------

test("tokenAtChar: every word start (as Web Speech boundary reports it) maps to its token", () => {
  const paras = toParagraphs({
    paragraphs: ["The quick brown fox. Jumps over the lazy dog!", "Second paragraph — here.\nWith a break.", "Third."],
  });
  const tokens = tokenize(paras);
  paras.forEach((p, para) => {
    for (const m of p.matchAll(/\S+/g)) {
      const i = tokenAtChar(tokens, para, m.index);
      assert.ok(i >= 0, `${para}:${m.index}`);
      assert.equal(tokens[i]!.text, m[0]);
      assert.equal(tokens[i]!.para, para);
      assert.equal(tokens[i]!.start, m.index);
    }
  });
});

test("tokenAtChar: a char inside a word, between words, and past the end", () => {
  const p = "The quick brown fox.";
  const tokens = tokenize([p, "Next one"]);
  assert.equal(tokenAtChar(tokens, 0, 6), 1); // "u" in quick
  assert.equal(tokenAtChar(tokens, 0, 4), 1); // first letter of quick
  assert.equal(tokenAtChar(tokens, 0, 8), 1); // last letter of quick
  assert.equal(tokenAtChar(tokens, 0, 9), 1); // the space after quick: last token starting before it
  assert.equal(tokenAtChar(tokens, 0, 19), 3); // the "." of "fox."
  assert.equal(tokenAtChar(tokens, 0, 500), 3); // beyond the paragraph: its last token
  assert.equal(tokenAtChar(tokens, 1, 0), 4);
  assert.equal(tokenAtChar(tokens, 1, 6), 5);
});

test("tokenAtChar: -1 when nothing in that paragraph starts at or before the char", () => {
  const tokens = tokenize(["  indented start", "", "third"]);
  assert.equal(tokenAtChar(tokens, 0, 0), -1); // leading whitespace
  assert.equal(tokenAtChar(tokens, 0, 1), -1);
  assert.equal(tokenAtChar(tokens, 0, 2), 0);
  assert.equal(tokenAtChar(tokens, 1, 0), -1); // empty paragraph
  assert.equal(tokenAtChar(tokens, 2, 0), 2);
  assert.equal(tokenAtChar(tokens, 7, 0), -1); // no such paragraph
  assert.equal(tokenAtChar(tokens, 0, -5), -1);
  assert.equal(tokenAtChar([], 0, 0), -1);
});

test("tokenAtChar: a split long word maps to its first part (or the last one past its end)", () => {
  const p = "so abcdefghijklmnopqrst is long";
  const tokens = tokenize([p]); // so | abcdefg- | hijklmn- | opqrst | is | long
  assert.equal(tokens.length, 6);
  assert.equal(tokenAtChar(tokens, 0, 3), 1);
  assert.equal(tokenAtChar(tokens, 0, 10), 1);
  assert.equal(tokenAtChar(tokens, 0, 22), 1); // still inside the word
  assert.equal(tokenAtChar(tokens, 0, 23), 3); // the space after the word: last token starting before it
  assert.equal(tokenAtChar(tokens, 0, 24), 4);
});

test("tokenAtChar: CJK segments are found by their offsets", () => {
  const tokens = tokenize([zh], "zh");
  tokens.forEach((t, i) => assert.equal(tokenAtChar(tokens, 0, t.start), i));
  tokens.forEach((t, i) => assert.equal(tokenAtChar(tokens, 0, t.end - 1), i));
});

test("tokenAtChar: works on a large token list", () => {
  const tokens = tokenize(Array.from({ length: 200 }, (_, i) => `para ${i} has some words in it`));
  for (const [para, ch] of [[0, 0], [57, 5], [199, 24]] as const) {
    const i = tokenAtChar(tokens, para, ch);
    assert.equal(tokens[i]!.para, para);
    assert.ok(tokens[i]!.start <= ch);
  }
});

test("sentenceStartBefore: walks back to the sentence start", () => {
  const tokens = tokenize(["One two three. Four five six seven. Eight", "Nine ten."]);
  // 0 One, 1 two, 2 three., 3 Four, 4 five, 5 six, 6 seven., 7 Eight, 8 Nine, 9 ten.
  assert.equal(sentenceStartBefore(tokens, 0), 0);
  assert.equal(sentenceStartBefore(tokens, 2), 0);
  assert.equal(sentenceStartBefore(tokens, 3), 3);
  assert.equal(sentenceStartBefore(tokens, 5), 3);
  assert.equal(sentenceStartBefore(tokens, 6), 3);
  assert.equal(sentenceStartBefore(tokens, 7), 7);
  assert.equal(sentenceStartBefore(tokens, 9), 8); // a new paragraph starts a sentence
  assert.equal(sentenceStartBefore(tokens, 99), 8); // clamped
  assert.equal(sentenceStartBefore(tokens, -4), 0);
  assert.equal(sentenceStartBefore([], 3), 0);
});

// ---------------------------------------------------------------------------------------------
// end to end
// ---------------------------------------------------------------------------------------------

test("pipeline: OCR lines -> paragraphs -> tokens -> schedule", () => {
  const paras = toParagraphs({ lines: oneColumn });
  const tokens = tokenize(paras, "en");
  assert.equal(tokens.length, `${P1_TEXT} ${P2_TEXT}`.split(" ").length);
  assert.equal(tokens.filter((t) => t.paraEnd).length, 2);
  assert.equal(tokens.filter((t) => t.sentenceStart).length, 2);
  for (const t of tokens) assert.equal(paras[t.para]!.slice(t.start, t.end), t.text);
  const d = delays(tokens);
  assert.equal(d.length, tokens.length);
  assert.ok(d.every((x) => x >= 60000 / 350));
});
