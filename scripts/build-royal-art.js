#!/usr/bin/env node
/**
 * Generates the decorative SVGs of the Nguyễn-court theme into public/images/:
 * - royal-silk.svg   repeating silk tile: lotus, spiral clouds, round "Thọ" medallion, diamonds
 * - royal-band.svg   squared-spiral hồi văn band for the red lacquer header
 * Run: node scripts/build-royal-art.js
 */
const fs = require('node:fs');
const path = require('node:path');

const out = path.join(__dirname, '..', 'public', 'images');
const f = n => Number(n.toFixed(2));
const polar = (r, angle) => [f(r * Math.cos(angle)), f(r * Math.sin(angle))];
const range = n => Array.from({ length: n }, (_, i) => i);
const around = (count, render, offset = 0) => range(count).map(i => render(offset + (i * 360) / count)).join('');
const rotate = (deg, content) => `<g transform="rotate(${f(deg)})">${content}</g>`;

/* ---------- Silk tile ---------- */
function lotus(x, y, s = 1) {
  const petal = 'M0 -44 C15 -32 18 -10 0 8 C-18 -10 -15 -32 0 -44Z';
  const vein = 'M0 -36 V2 M0 -22 L-6 -30 M0 -22 L6 -30 M0 -12 L-8 -20 M0 -12 L8 -20';
  const layer = (deg, scale) => `<g transform="rotate(${deg}) scale(${scale})"><path d="${petal}" class="petal"/><path d="${vein}"/></g>`;
  return `<g transform="translate(${x} ${y}) scale(${s})">
    ${layer(-72, 0.78)}${layer(72, 0.78)}${layer(-40, 0.9)}${layer(40, 0.9)}${layer(0, 1)}
    <path d="M-40 10 Q-20 26 0 22 Q20 26 40 10 M-30 18 Q0 34 30 18"/>
    ${[-12, -4, 4, 12].map(dx => `<circle cx="${dx}" cy="14" r="2" class="dot"/>`).join('')}
    <path d="M0 26 V44 M0 44 Q-14 48 -24 58 M0 44 Q14 48 24 58"/>
  </g>`;
}

function spiral(cx, cy, r, turns, dir = 1) {
  const steps = 40;
  const pts = range(steps + 1).map(i => {
    const t = i / steps;
    const a = dir * turns * 2 * Math.PI * t;
    const rr = r * (1 - t * 0.85);
    return [f(cx + rr * Math.cos(a)), f(cy + rr * Math.sin(a))];
  });
  return `M${pts.map(p => p.join(' ')).join('L')}`;
}

function cloud(x, y, s = 1) {
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <path d="M-52 14 C-60 -6 -40 -22 -24 -14 C-20 -34 8 -36 14 -18 C26 -30 50 -20 46 0 C60 2 62 22 46 24 H-40 C-48 24 -52 20 -52 14Z"/>
    <path d="${spiral(-28, 6, 14, 1.4, -1)}"/>
    <path d="${spiral(-2, -10, 15, 1.5, 1)}"/>
    <path d="${spiral(26, 4, 13, 1.4, -1)}"/>
    <path d="M46 24 C66 26 74 40 64 50 C56 56 46 50 52 42"/>
    <path d="M-40 24 C-56 30 -62 44 -50 50"/>
  </g>`;
}

function medallion(x, y, s = 1) {
  const beads = around(24, deg => { const [bx, by] = polar(27, (deg * Math.PI) / 180); return `<circle cx="${bx}" cy="${by}" r="1.8" class="dot"/>`; });
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <circle r="32"/><circle r="22"/>${beads}
    <path d="M-14 -13 H14 M-14 13 H14 M0 -17 V17 M-9 -13 V-6 H9 V-13 M-9 13 V6 H9 V13 M-18 0 H-10 M10 0 H18 M-14 -6 V6 M14 -6 V6"/>
    ${around(4, deg => rotate(deg, '<path d="M32 0 L42 -6 L50 0 L42 6 Z" class="petal"/>'), 45)}
  </g>`;
}

const diamond = (x, y) => `<path d="M${x} ${y - 9} L${x + 9} ${y} L${x} ${y + 9} L${x - 9} ${y} Z" class="petal"/><circle cx="${x}" cy="${y}" r="1.6" class="dot"/>`;

function silk() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="260" viewBox="0 0 260 260">
<style>g.art{fill:none;stroke:#9b7428;stroke-opacity:.26;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}.petal{fill:#9b7428;fill-opacity:.06}.dot{fill:#9b7428;fill-opacity:.4;stroke:none}</style>
<g class="art">
${lotus(65, 58)}
${medallion(195, 195)}
${cloud(195, 62, 0.95)}
${cloud(65, 198, 0.95)}
${diamond(130, 130)}${diamond(0, 130)}${diamond(260, 130)}${diamond(130, 0)}${diamond(130, 260)}
${diamond(0, 0)}${diamond(260, 0)}${diamond(0, 260)}${diamond(260, 260)}
</g></svg>`;
}

/* ---------- Hồi văn band ---------- */
function band() {
  // Squared spiral turning inward, the classic key pattern on Huế beams, framed by two rules.
  const unit = 'M0 18 H4 V4 H20 V16 H9 V9 H15 V12';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="22" viewBox="0 0 24 22">
<rect width="24" height="22" fill="#5f100c"/>
<path d="M0 1 H24 M0 21 H24" stroke="#c99a3b" stroke-width="1.2"/>
<path d="${unit}" fill="none" stroke="#e2b54f" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"/>
<circle cx="22" cy="18" r="1.2" fill="#e2b54f"/>
</svg>`;
}

fs.mkdirSync(out, { recursive: true });
const files = { 'royal-silk.svg': silk(), 'royal-band.svg': band() };
for (const [name, content] of Object.entries(files)) {
  fs.writeFileSync(path.join(out, name), content.replace(/\n\s*\n/g, '\n') + '\n');
  console.log(name, Buffer.byteLength(content), 'bytes');
}
