// Records the README demo (docs/readme/demo.gif): the real reader page in headless Chrome, inside the
// scene from demo-scene.js, driven through a capture -> read -> pause -> done story.
// Run from anywhere: node docs/readme/demo.mjs   (needs Google Chrome and ffmpeg; starts Vite if needed)
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = join(HERE, "../..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL_ = "http://localhost:1420/reader.html";
const FPS = 24;
const HOLD = 2.8; // seconds on the finished done screen before the GIF loops

const tmp = mkdtempSync(join(tmpdir(), "wordstrobe-demo-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = async () => { try { return (await fetch(URL_)).ok; } catch { return false; } };

let vite;
if (!(await up())) {
  vite = spawn(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "--port", "1420", "--strictPort"], { cwd: ROOT, stdio: "ignore" });
  for (let i = 0; i < 60 && !(await up()); i++) await sleep(250);
}
const port = 9500 + Math.floor(Math.random() * 300);
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${tmp}/profile`,
  "--no-first-run", "--hide-scrollbars", "--window-size=800,450", "about:blank"], { stdio: "ignore" });

try {
  let targets = [];
  for (let i = 0; i < 100 && !targets.some((t) => t.type === "page"); i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await sleep(100); }
  }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  // Minimal CDP client. Screencast frames are saved as they arrive, with their timestamps.
  let id = 0;
  const pending = new Map();
  const frames = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  mkdirSync(`${tmp}/frames`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method !== "Page.screencastFrame") return;
    const file = `${tmp}/frames/${String(frames.length).padStart(5, "0")}.png`;
    writeFileSync(file, Buffer.from(m.params.data, "base64"));
    frames.push({ file, t: m.params.metadata.timestamp });
    send("Page.screencastFrameAck", { sessionId: m.params.sessionId });
  };
  const run = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
  const space = async () => {
    for (const type of ["keyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", { type, key: " ", code: "Space", windowsVirtualKeyCode: 32, text: type === "keyDown" ? " " : undefined });
    }
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 800, height: 450, deviceScaleFactor: 2, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: readFileSync(join(HERE, "demo-scene.js"), "utf8") });
  await send("Page.navigate", { url: URL_ });
  await sleep(1500);

  // The story.
  await send("Page.startScreencast", { format: "png", maxWidth: 1600, maxHeight: 900, everyNthFrame: 1 });
  await sleep(500);
  await run(`__scene.keys(["⌥", "⇧", "R"], 1100)`);
  await sleep(450);
  await run(`__scene.select(1000)`);
  await sleep(1250);
  await run(`__scene.endSelect(); __scene.showPopup(); __emit("reader:status", { state: "ocr" })`);
  await sleep(700);
  await run(`__emit("reader:load", { paragraphs: [__scene.P1], lang: "en", ms: 270, source: "region" })`);
  await sleep(3000);
  await run(`__scene.keys(["Space"], 900)`);
  await space();
  await sleep(1700);
  await run(`__scene.keys(["Space"], 700)`);
  await space();
  for (let i = 0; i < 200 && (await run(`document.getElementById("app").dataset.state`)) !== "done"; i++) await sleep(50);
  await sleep(1500); // let the done screen settle; the hold itself is added below
  await send("Page.stopScreencast");
  await sleep(200);
  ws.close();

  // The screencast only sends a frame when something changes: resample to a fixed rate, each output
  // frame showing whatever was on screen at that moment, and hold the last one.
  const start = frames[0].t;
  const total = frames.at(-1).t - start + HOLD;
  mkdirSync(`${tmp}/seq`);
  for (let k = 0, j = 0; k < Math.floor(total * FPS); k++) {
    while (j + 1 < frames.length && frames[j + 1].t - start <= k / FPS) j++;
    symlinkSync(frames[j].file, `${tmp}/seq/${String(k).padStart(5, "0")}.png`);
  }
  const out = join(HERE, "demo.gif");
  const ff = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-framerate", String(FPS), "-i", `${tmp}/seq/%05d.png`, "-vf",
    "scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
    "-loop", "0", out], { stdio: "inherit" });
  if (ff.status !== 0) throw new Error("ffmpeg failed");
  console.log(`demo.gif: ${frames.length} captured frames, ${total.toFixed(1)} s`);
} finally {
  chrome.kill();
  vite?.kill();
  rmSync(tmp, { recursive: true, force: true });
}
