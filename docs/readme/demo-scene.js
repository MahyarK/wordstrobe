// Injected into reader.html by demo.mjs: a stand-in for Tauri's IPC (events, store, commands) with the
// demo's reading settings, and a desktop scene around the real popup.
window.__store = { wpm: 520, theme: "system", fontSize: 40, startDelay: 700, smartResume: false, contextLine: true, wordsPerFlash: 1, readAloud: false, voices: {} };
(() => {
  const listeners = {};
  const callbacks = new Map();
  const store = window.__store ?? {};
  let next = 1;
  window.__invokes = [];
  window.__store = store;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "reader" }, currentWebview: { windowLabel: "reader", label: "reader" } },
    transformCallback(cb) { const id = next++; callbacks.set(id, cb); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      window.__invokes.push([cmd, args]);
      switch (cmd) {
        case "plugin:event|listen": (listeners[args.event] ??= []).push(args.handler); return next++;
        case "plugin:store|load": return 7;
        case "plugin:store|get": return [store[args.key] ?? null, args.key in store];
        case "plugin:store|set": store[args.key] = args.value; return;
        case "plugin:window|set_theme": return;
        default: return null;
      }
    },
  };
  window.__emit = (event, payload) => (listeners[event] ?? []).forEach((id) => callbacks.get(id)({ event, id: 0, payload }));
  window.__listening = () => Object.keys(listeners);
})();

(() => {
  const P1 = "Rapid serial visual presentation flashes one word at a time at a fixed point. Your eyes stop jumping across lines, so the words come to you instead.";
  const P2 = "Most people read about 240 words per minute. With the eye movements gone, 400 feels easy after a short warm-up, and comprehension holds when the reader pauses at punctuation.";
  const css = `
    html, body { background: #0d0e12 !important; }
    #wall { position: fixed; inset: 0; z-index: 0; background:
      radial-gradient(55% 75% at 10% 6%, rgba(160, 44, 36, 0.55), transparent 62%),
      radial-gradient(70% 90% at 96% 104%, rgba(46, 64, 120, 0.55), transparent 62%), #0d0e12; }
    .win { position: fixed; z-index: 1; left: 56px; top: 40px; width: 476px; height: 318px; border-radius: 12px; overflow: hidden;
      background: #fbfbfc; color: #1d1d1f; box-shadow: 0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(0,0,0,.25); }
    .win .bar { height: 30px; display: flex; align-items: center; gap: 7px; padding: 0 12px; background: #efeff2; border-bottom: 1px solid #e2e2e6; }
    .win .bar i { width: 11px; height: 11px; border-radius: 50%; background: #d6d6da; }
    .win .bar span { margin-left: auto; margin-right: auto; font: 500 12px var(--sans); color: #8a8a90; transform: translateX(-24px); }
    .win .doc { padding: 22px 30px; }
    .win h1 { font: 600 21px/1.2 var(--sans); letter-spacing: -0.02em; margin: 0 0 12px; }
    .win p { font: 400 13.5px/1.62 var(--sans); color: #3a3a3f; margin: 0 0 11px; }
    #dim { position: fixed; z-index: 2; inset: 0; background: rgba(0,0,0,.16); opacity: 0; transition: opacity .2s; }
    #sel { position: fixed; z-index: 3; border: 1px solid #ff5a4f; background: rgba(255,90,79,.09); border-radius: 2px; opacity: 0; transition: opacity .2s; }
    #cross { position: fixed; z-index: 4; width: 0; height: 0; opacity: 0; transition: opacity .15s; }
    #cross::before, #cross::after { content: ""; position: absolute; background: #1d1d1f; box-shadow: 0 0 0 1px rgba(255,255,255,.8); }
    #cross::before { left: -10px; top: -.5px; width: 20px; height: 1px; }
    #cross::after { top: -10px; left: -.5px; height: 20px; width: 1px; }
    #cross b { position: absolute; left: 12px; top: 10px; padding: 3px 6px; border-radius: 5px; white-space: nowrap;
      font: 500 10px/1 var(--mono); color: #fff; background: rgba(20,20,22,.82); }
    #keys { position: fixed; z-index: 6; left: 26px; bottom: 22px; display: flex; gap: 6px;
      opacity: 0; transform: translateY(6px); transition: opacity .2s, transform .3s var(--ease); }
    #keys.on { opacity: 1; transform: none; }
    #keys kbd { font: 500 13px/1 var(--mono); padding: 8px 11px; border-radius: 8px; color: #fff; background: rgba(255,255,255,.1);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.2), 0 8px 24px rgba(0,0,0,.35); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
    #app { position: fixed !important; width: 520px; height: 190px !important; z-index: 5; --surface: rgba(24, 24, 27, 0.86);
      -webkit-backdrop-filter: blur(30px) saturate(1.6); backdrop-filter: blur(30px) saturate(1.6);
      box-shadow: inset 0 1px 0 var(--sheen), inset 0 0 0 1px var(--edge), 0 26px 70px rgba(0,0,0,.6) !important;
      opacity: 0; transform: translateY(8px) scale(.985); transition: opacity .25s var(--ease), transform .4s var(--ease); }
    #app.shown { opacity: 1; transform: none; }`;
  addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const add = (html) => { document.body.insertAdjacentHTML("afterbegin", html); };
    add(`<div id="keys"></div><div id="cross"><b></b></div><div id="sel"></div><div id="dim"></div>
      <div class="win"><div class="bar"><i></i><i></i><i></i><span>On reading</span></div>
      <div class="doc"><h1>Reading at the speed of thought</h1><p id="p1">${P1}</p><p>${P2}</p></div></div><div id="wall"></div>`);
  });
  const $ = (s) => document.querySelector(s);
  let rect;
  window.__scene = {
    P1,
    keys(labels, ms) {
      const k = $("#keys");
      k.replaceChildren(...labels.map((l) => Object.assign(document.createElement("kbd"), { textContent: l })));
      k.classList.add("on");
      setTimeout(() => k.classList.remove("on"), ms);
    },
    select(ms) {
      const r = $("#p1").getBoundingClientRect();
      rect = { x: r.left - 7, y: r.top - 6, w: r.width + 14, h: r.height + 10 };
      const sel = $("#sel"), cross = $("#cross"), label = $("#cross b");
      $("#dim").style.opacity = "1";
      cross.style.opacity = "1";
      sel.style.opacity = "1";
      const t0 = performance.now();
      const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
      const step = (now) => {
        const k = ease(Math.min(1, (now - t0) / ms));
        const w = rect.w * k, h = rect.h * k;
        Object.assign(sel.style, { left: rect.x + "px", top: rect.y + "px", width: w + "px", height: h + "px" });
        Object.assign(cross.style, { left: rect.x + w + "px", top: rect.y + h + "px" });
        label.textContent = `${Math.round(w * 2)} × ${Math.round(h * 2)}`;
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    endSelect() {
      for (const s of ["#dim", "#sel", "#cross"]) $(s).style.opacity = "0";
    },
    showPopup() {
      // Placed like the app does: centred on the cursor, 24 px below it.
      const app = $("#app");
      const cx = rect.x + rect.w, cy = rect.y + rect.h;
      Object.assign(app.style, { left: Math.min(innerWidth - 528, Math.max(8, cx - 260)) + "px", top: Math.min(innerHeight - 198, cy + 24) + "px" });
      app.classList.add("shown");
    },
  };
})();
