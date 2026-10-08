// Wordstrobe region overlay (PLAN §11 M6): shows the frozen frame of one monitor, lets the user drag
// a rectangle over it and reports that to Rust (`overlay.rs`), which does the cropping on the
// original pixels. Opened once per monitor as `overlay.html?m=<index>`.
//
// Nothing here touches the clipboard, the DOM from outside, or the network: the frame comes from the
// app's own `overlay` URI scheme. Rust shows the window only after `overlay_ready`.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

/** A drag smaller than this (CSS px, either side) is a click, not a selection. */
const MIN = 4;
/** Room the size label needs below or above the rectangle (CSS px) and beside it. */
const LABEL_H = 34;
const LABEL_W = 130;

type Selection = { monitor: number; x: number; y: number; w: number; h: number; vw: number; vh: number };
type Point = { x: number; y: number };

// Demo mode (a plain browser, `npm run dev`): `overlay.html?src=<image>` instead of the app's frame.
const TAURI = "__TAURI_INTERNALS__" in window;
const query = new URLSearchParams(location.search);
const monitor = Number(query.get("m") ?? 0);

const shot = document.getElementById("shot") as HTMLImageElement;
const sel = document.getElementById("sel") as HTMLElement;
const size = document.getElementById("size") as HTMLElement;

let done = false;
/** Reports the selection, or `null` = cancel (all overlays close). Once. */
function finish(selection: Selection | null): void {
  if (done) return;
  done = true;
  if (TAURI) void invoke("overlay_select", { selection });
  else console.log("overlay_select", selection);
}

const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
const point = (e: PointerEvent): Point => ({ x: clamp(e.clientX, innerWidth), y: clamp(e.clientY, innerHeight) });

/** Image px per CSS px. The label uses the same edge rounding as Rust's crop, so it shows what is read. */
const edge = (v: number, scale: number) => Math.round(v * scale);

let origin: Point | null = null;

function rectOf(a: Point, b: Point) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function draw(a: Point, b: Point): void {
  const { x, y, w, h } = rectOf(a, b);
  const sx = (shot.naturalWidth || innerWidth * devicePixelRatio) / innerWidth;
  const sy = (shot.naturalHeight || innerHeight * devicePixelRatio) / innerHeight;
  for (const [name, v] of Object.entries({ x, y, w, h })) sel.style.setProperty(`--${name}`, `${v}px`);
  size.textContent = `${edge(x + w, sx) - edge(x, sx)} × ${edge(y + h, sy) - edge(y, sy)}`;
  sel.dataset.v = innerHeight - (y + h) >= LABEL_H ? "below" : y >= LABEL_H ? "above" : "inside";
  sel.dataset.h = innerWidth - x >= LABEL_W ? "left" : "right";
  sel.hidden = false;
  document.body.dataset.drag = "";
}

function reset(): void {
  origin = null;
  sel.hidden = true;
  delete document.body.dataset.drag;
}

addEventListener("pointerdown", (e) => {
  if (e.button === 2) return finish(null);
  if (e.button !== 0 || origin) return;
  origin = point(e);
  (e.target as Element).setPointerCapture(e.pointerId); // the drag goes on outside the window
});

addEventListener("pointermove", (e) => {
  if (origin) draw(origin, point(e));
});

addEventListener("pointerup", (e) => {
  if (!origin || e.button !== 0) return;
  const r = rectOf(origin, point(e));
  reset();
  if (r.w >= MIN && r.h >= MIN) finish({ monitor, ...r, vw: innerWidth, vh: innerHeight });
});

addEventListener("pointercancel", reset);
addEventListener("keydown", (e) => e.key === "Escape" && finish(null));
addEventListener("contextmenu", (e) => {
  e.preventDefault();
  finish(null);
});

// A frame that cannot be shown cancels everything: Rust tells the user nothing, but it logs the cause.
shot.addEventListener("error", () => {
  console.error("overlay: the frozen frame did not load");
  finish(null);
});

void (async () => {
  if (TAURI) shot.src = convertFileSrc(String(monitor), "overlay");
  else if (query.has("src")) shot.src = query.get("src")!;
  // Decoded before the window is shown, so it never appears without its picture. Not waited for
  // forever: a webview that is not painting yet may not finish `decode()`.
  await Promise.race([shot.decode().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 400))]);
  if (TAURI && !done) await invoke("overlay_ready", { monitor });
})();
