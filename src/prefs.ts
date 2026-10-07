// The settings store (settings.json, shared with Rust), as one typed object. The reader popup and the
// settings window both read it through `normalize`, so the two can never disagree on what a value
// means (a hand-edited or older store, or one written by a newer build, never breaks either page).
//
// DOM-free and erasable TypeScript only: it runs under `node --test` as well.

export type Placement = "cursor" | "center" | "last";
export type Theme = "system" | "light" | "dark";
export type VoiceMode = "along" | "voice";

export type Prefs = {
  wpm: number;
  wordsPerFlash: 1 | 2 | 3;
  fontSize: number;
  theme: Theme;
  startDelay: number;
  smartResume: boolean;
  contextLine: boolean;
  placement: Placement;
  readAloud: boolean;
  voiceMode: VoiceMode;
  /** language prefix ("en") -> voiceURI */
  voices: Record<string, string>;
  /** voiceURI -> measured speed of the voice at rate 1, in words per minute (written by the reader's calibration) */
  voiceBaseWpm: Record<string, number>;
  /** Read-only in the UI; Rust registers it at startup. */
  hotkeyRegion: string;
  /** Logical size of the popup, written by Rust when the user resizes it; passed through, never edited here. */
  readerSize?: { w: number; h: number };
};

export const DEFAULTS: Readonly<Prefs> = {
  wpm: 350,
  wordsPerFlash: 1,
  fontSize: 44,
  theme: "system",
  startDelay: 600,
  smartResume: true,
  contextLine: true,
  placement: "cursor",
  readAloud: false,
  voiceMode: "along",
  voices: {},
  voiceBaseWpm: {},
  hotkeyRegion: "Alt+Shift+R",
};

/** Every key of the store this app knows. */
export const PREF_KEYS = [...(Object.keys(DEFAULTS) as (keyof Prefs)[]), "readerSize"] as const;

/** Limits of the numeric settings: what the Settings sliders allow, and what the reader accepts. */
export const LIMITS = {
  wpm: { min: 100, max: 1200, step: 25 },
  fontSize: { min: 28, max: 72, step: 1 },
  startDelay: { min: 0, max: 2000, step: 50 },
} as const;

/** A voice's speed at rate 1 outside this range is a bad measurement (the calibration clamps to it too). */
export const BASE_WPM = { min: 60, max: 600 } as const;

export const PLACEMENTS: readonly Placement[] = ["cursor", "center", "last"];
export const THEMES: readonly Theme[] = ["system", "light", "dark"];
export const VOICE_MODES: readonly VoiceMode[] = ["along", "voice"];

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((a) => a === value) ?? fallback;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function inRange(value: unknown, key: keyof typeof LIMITS): number {
  const { min, max } = LIMITS[key];
  return finite(value) ? Math.min(max, Math.max(min, Math.round(value))) : (DEFAULTS[key] as number);
}

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A plain object's entries that pass `keep`; anything that is not a plain object gives `{}`. */
function pick<T>(value: unknown, keep: (v: unknown) => v is T): Record<string, T> {
  return isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([, v]) => keep(v))) as Record<string, T> : {};
}

/** Whatever is in the store, turned into valid preferences: no value of any key can make this throw. */
export function normalize(raw: Record<string, unknown> = {}): Prefs {
  const out: Prefs = {
    wpm: inRange(raw.wpm, "wpm"),
    wordsPerFlash: raw.wordsPerFlash === 2 || raw.wordsPerFlash === 3 ? raw.wordsPerFlash : 1,
    fontSize: inRange(raw.fontSize, "fontSize"),
    theme: oneOf(raw.theme, THEMES, DEFAULTS.theme),
    startDelay: inRange(raw.startDelay, "startDelay"),
    smartResume: bool(raw.smartResume, DEFAULTS.smartResume),
    contextLine: bool(raw.contextLine, DEFAULTS.contextLine),
    placement: oneOf(raw.placement, PLACEMENTS, DEFAULTS.placement),
    readAloud: bool(raw.readAloud, DEFAULTS.readAloud),
    voiceMode: oneOf(raw.voiceMode, VOICE_MODES, DEFAULTS.voiceMode),
    voices: pick(raw.voices, (v): v is string => typeof v === "string" && v !== ""),
    voiceBaseWpm: pick(
      raw.voiceBaseWpm,
      (v): v is number => finite(v) && v >= BASE_WPM.min && v <= BASE_WPM.max,
    ),
    hotkeyRegion:
      typeof raw.hotkeyRegion === "string" && raw.hotkeyRegion !== "" ? raw.hotkeyRegion : DEFAULTS.hotkeyRegion,
  };
  const size = raw.readerSize;
  if (isRecord(size) && finite(size.w) && finite(size.h) && size.w > 0 && size.h > 0) {
    out.readerSize = { w: size.w, h: size.h };
  }
  return out;
}

/** Reads every key through `get` (a store's `get`) in parallel and normalizes the result. */
export async function readPrefs(get: (key: string) => Promise<unknown>): Promise<Prefs> {
  const entries = await Promise.all(PREF_KEYS.map(async (key) => [key, await get(key)] as const));
  return normalize(Object.fromEntries(entries));
}
