// Generates the README banner: the tagline flashed word by word in the reader's reticle, then the
// wordmark. Writes hero-dark.svg and hero-light.svg next to this file. Run: node docs/readme/hero.mjs
import { readFileSync, writeFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const font = readFileSync(new URL("../../node_modules/geist/dist/fonts/geist-mono/GeistMono-Medium.woff2", here)).toString("base64");

const W = 1200, H = 380, CX = 480; // the pivot column sits at 40 % of the width, as in the app
const SIZE = 72, ADV = SIZE * 0.6; // Geist Mono: every glyph advances 600/1000 em
const TOP = 118, BOTTOM = 238, BASE = 204; // reticle lines; baseline centres the cap height between them
const LOOP = 10; // seconds

// The ORP table from PLAN §5.2.
const orp = (w) => { const n = w.replace(/[^\p{L}\p{N}]/gu, "").length; return n <= 1 ? 0 : n <= 5 ? 1 : n <= 9 ? 2 : n <= 13 ? 3 : 4; };

// [word, seconds on screen]: a little slower than real use so it reads in a banner; the full stop pauses.
const words = [["Read", 0.3], ["any", 0.3], ["text", 0.3], ["on", 0.3], ["your", 0.3], ["screen", 0.3], ["faster.", 0.65]];
const START = 0.6, MARK_AT = 3.35, OUT = 8.7;

const pct = (s) => +((s / LOOP) * 100).toFixed(3);
const xs = (from, n) => Array.from({ length: n }, (_, i) => +(CX - ADV / 2 + (from + i) * ADV).toFixed(1)).join(" ");

function wordSvg(word, cls) {
  const p = orp(word);
  const [l, piv, r] = [word.slice(0, p), word[p], word.slice(p + 1)];
  return `<g class="${cls}">` +
    (l ? `<text x="${xs(-p, l.length)}" y="${BASE}">${l}</text>` : "") +
    `<text class="pivot" filter="url(#glow)" x="${xs(0, 1)}" y="${BASE}">${piv}</text>` +
    (r ? `<text x="${xs(1, r.length)}" y="${BASE}">${r}</text>` : "") +
    `</g>`;
}

let t = START;
const flashes = words.map(([w, d], i) => {
  const rule = `@keyframes f${i}{0%{opacity:0}${pct(t)}%{opacity:1}${pct(t + d)}%{opacity:0}}.f${i}{animation-name:f${i}}`;
  t += d;
  return { svg: wordSvg(w, `flash f${i}`), rule };
});
const RULER_END = t;

const themes = {
  dark: { bg: "#0b0b0d", glow: "rgba(255,90,79,0.16)", edge: "rgba(255,255,255,0.08)", fg: "#f4f4f6", muted: "rgba(244,244,246,0.5)", line: "rgba(244,244,246,0.16)", pivot: "#ff5a4f" },
  light: { bg: "#f7f7f9", glow: "rgba(229,55,46,0.09)", edge: "rgba(0,0,0,0.08)", fg: "#141416", muted: "rgba(20,20,22,0.52)", line: "rgba(20,20,22,0.16)", pivot: "#e5372e" },
};

for (const [name, c] of Object.entries(themes)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t">
<title id="t">Wordstrobe: read any text on your screen faster, one word at a time</title>
<defs>
<style>
@font-face{font-family:"Geist Mono";src:url(data:font/woff2;base64,${font}) format("woff2")}
text{font:500 ${SIZE}px "Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:${c.fg}}
.pivot{fill:${c.pivot}}
.flash,.mark,.sub,.ruler{animation:${LOOP}s infinite both}
.flash{opacity:0;animation-timing-function:step-end}
${flashes.map((f) => f.rule).join("\n")}
@keyframes mark{0%,${pct(MARK_AT) - 0.01}%{opacity:0}${pct(MARK_AT)}%{opacity:1}${pct(OUT)}%{opacity:1}${pct(OUT + 0.5)}%,100%{opacity:0}}
.mark{animation-name:mark}
@keyframes sub{0%,${pct(MARK_AT + 0.35)}%{opacity:0;transform:translateY(8px)}${pct(MARK_AT + 0.9)}%{opacity:1;transform:none}${pct(OUT)}%{opacity:1}${pct(OUT + 0.5)}%,100%{opacity:0}}
.sub{animation-name:sub;animation-timing-function:cubic-bezier(.2,.8,.2,1)}
.sub text{font-size:22px;fill:${c.muted};text-anchor:middle}
@keyframes ruler{0%,${pct(START - 0.2)}%{opacity:0}${pct(START)}%{opacity:1}${pct(RULER_END + 0.3)}%{opacity:1}${pct(MARK_AT + 0.4)}%,100%{opacity:0}}
.ruler{animation-name:ruler}
@keyframes arm{0%{transform:scaleY(0)}${pct(0.5)}%,100%{transform:scaleY(1)}}
.notch{fill:${c.pivot};transform-box:fill-box;animation:arm ${LOOP}s infinite cubic-bezier(.2,.8,.2,1)}
.notch.top{transform-origin:top}.notch.bottom{transform-origin:bottom}
@media (prefers-reduced-motion:reduce){.flash,.ruler{display:none}.mark,.sub,.notch{animation:none;opacity:1}}
</style>
<radialGradient id="g" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(0 0) scale(${W * 0.75} ${H * 1.4})"><stop offset="0" stop-color="${c.glow}"/><stop offset="1" stop-color="${c.glow}" stop-opacity="0"/></radialGradient>
<linearGradient id="fade" x1="0" x2="1"><stop offset="0" stop-color="${c.line}" stop-opacity="0"/><stop offset=".16" stop-color="${c.line}"/><stop offset=".84" stop-color="${c.line}"/><stop offset="1" stop-color="${c.line}" stop-opacity="0"/></linearGradient>
<filter id="glow" x="-100%" y="-50%" width="300%" height="200%"><feGaussianBlur stdDeviation="9" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<mask id="fill" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect x="140" y="288" height="24" width="0" fill="#fff"><animate attributeName="width" dur="${LOOP}s" repeatCount="indefinite" calcMode="linear" keyTimes="0;${(START / LOOP).toFixed(4)};${(RULER_END / LOOP).toFixed(4)};1" values="0;0;920;920"/></rect></mask>
</defs>
<rect width="${W}" height="${H}" rx="22" fill="${c.bg}"/>
<rect width="${W}" height="${H}" rx="22" fill="url(#g)"/>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="21.5" fill="none" stroke="${c.edge}"/>
<rect x="60" y="${TOP}" width="${W - 120}" height="1.5" fill="url(#fade)"/>
<rect x="60" y="${BOTTOM - 1.5}" width="${W - 120}" height="1.5" fill="url(#fade)"/>
<rect class="notch top" x="${CX - 1.5}" y="${TOP}" width="3" height="14" rx="1.5"/>
<rect class="notch bottom" x="${CX - 1.5}" y="${BOTTOM - 14}" width="3" height="14" rx="1.5"/>
${flashes.map((f) => f.svg).join("\n")}
<g class="mark">${wordSvg("Wordstrobe", "")}</g>
<g class="ruler"><line x1="140" x2="1060" y1="300" y2="300" stroke="${c.line}" stroke-width="10" stroke-dasharray="2 8"/><line x1="140" x2="1060" y1="300" y2="300" stroke="${c.pivot}" stroke-width="10" stroke-dasharray="2 8" mask="url(#fill)"/></g>
<g class="sub"><text x="${W / 2}" y="312">Press a shortcut. Drag a box. Read it one word at a time.</text></g>
</svg>
`;
  writeFileSync(new URL(`hero-${name}.svg`, here), svg);
  console.log(`hero-${name}.svg ${(svg.length / 1024).toFixed(0)} KB`);
}
