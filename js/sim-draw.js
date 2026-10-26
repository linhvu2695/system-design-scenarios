/* Canvas pieces for simulations that show services passing messages: boxes with an
   icon and an accent colour, roads between them, messages in flight, and the "later"
   card. Colours are theme token names (css('blue')), so both themes and the palette
   in css/style.css apply. Icons are drawn with strokes, no image files. */

import { css } from './sim-kit.js';

const rr = (g, x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, r); };
const line = (g, x1, y1, x2, y2) => { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
const ring = (g, x, y, r) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke(); };
const dot = (g, x, y, r) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };

/* Each icon fits a square of side s centred on the origin. */
const ICONS = {
  card(g, s) { rr(g, -s * .45, -s * .3, s * .9, s * .6, s * .1); g.stroke(); line(g, -s * .45, -s * .1, s * .45, -s * .1); line(g, -s * .3, s * .14, -s * .05, s * .14); },
  server(g, s) {
    for (const y of [-s * .4, s * .05]) { rr(g, -s * .42, y, s * .84, s * .35, s * .08); g.stroke(); dot(g, -s * .24, y + s * .175, s * .05); line(g, s * .02, y + s * .175, s * .26, y + s * .175); }
  },
  gear(g, s) {
    ring(g, 0, 0, s * .14);
    ring(g, 0, 0, s * .3);
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; line(g, Math.cos(a) * s * .3, Math.sin(a) * s * .3, Math.cos(a) * s * .44, Math.sin(a) * s * .44); }
  },
  db(g, s) {
    const rx = s * .36, ry = s * .11;
    g.beginPath(); g.ellipse(0, -s * .3, rx, ry, 0, 0, Math.PI * 2); g.stroke();
    line(g, -rx, -s * .3, -rx, s * .3); line(g, rx, -s * .3, rx, s * .3);
    for (const y of [0, s * .3]) { g.beginPath(); g.ellipse(0, y, rx, ry, 0, 0, Math.PI); g.stroke(); }
  },
  printer(g, s) {
    rr(g, -s * .28, -s * .44, s * .56, s * .3, s * .04); g.stroke();
    rr(g, -s * .46, -s * .14, s * .92, s * .38, s * .08); g.stroke();
    rr(g, -s * .28, s * .1, s * .56, s * .34, s * .04); g.fill();
    dot(g, s * .3, -s * .02, s * .04);
  },
  clock(g, s) { ring(g, 0, 0, s * .42); line(g, 0, 0, 0, -s * .26); line(g, 0, 0, s * .18, s * .08); },
  book(g, s) {
    rr(g, -s * .3, -s * .4, s * .6, s * .8, s * .06); g.fill();
    g.strokeStyle = css('bg'); g.lineWidth = Math.max(1.2, s / 16);
    line(g, -s * .17, -s * .4, -s * .17, s * .4);
    line(g, -s * .04, -s * .18, s * .18, -s * .18); line(g, -s * .04, -s * .04, s * .18, -s * .04);
  },
  mail(g, s) { rr(g, -s * .42, -s * .28, s * .84, s * .56, s * .06); g.stroke(); g.beginPath(); g.moveTo(-s * .42, -s * .24); g.lineTo(0, s * .06); g.lineTo(s * .42, -s * .24); g.stroke(); },
  arrow(g, s) { line(g, -s * .36, 0, s * .34, 0); g.beginPath(); g.moveTo(s * .08, -s * .26); g.lineTo(s * .36, 0); g.lineTo(s * .08, s * .26); g.stroke(); },
  check(g, s) { g.beginPath(); g.moveTo(-s * .34, 0); g.lineTo(-s * .1, s * .26); g.lineTo(s * .36, -s * .26); g.stroke(); },
  cross(g, s) { line(g, -s * .28, -s * .28, s * .28, s * .28); line(g, s * .28, -s * .28, -s * .28, s * .28); },
  stop(g, s) { ring(g, 0, 0, s * .42); rr(g, -s * .16, -s * .16, s * .32, s * .32, s * .04); g.fill(); },
  alert(g, s) {
    g.beginPath(); g.moveTo(0, -s * .42); g.lineTo(s * .44, s * .36); g.lineTo(-s * .44, s * .36); g.closePath(); g.stroke();
    line(g, 0, -s * .1, 0, s * .1); dot(g, 0, s * .22, s * .04);
  },
  dots(g, s) { for (const x of [-s * .26, 0, s * .26]) dot(g, x, 0, s * .07); },
};

export function icon(g, name, x, y, s, color) {
  g.save();
  g.translate(x, y);
  g.strokeStyle = g.fillStyle = css(color);
  g.lineWidth = Math.max(1.5, s / 11);
  g.lineCap = 'round'; g.lineJoin = 'round';
  ICONS[name](g, s);
  g.restore();
}

/* A service box. x, y is its centre. `active` glows in its colour (it is sending or
   receiving the current message); `alert` turns it red with a warning badge; `dim`
   greys out a box this setup does not use. */
export function node(g, { x, y, w, h, title, icon: name, color, active, alert, dim }) {
  const edge = alert ? 'bad' : color;
  g.save();
  g.globalAlpha = dim ? 0.35 : 1;
  if ((active || alert) && !dim) { g.shadowColor = css(edge); g.shadowBlur = active ? 22 : 14; }
  g.fillStyle = css('surface2');
  rr(g, x - w / 2, y - h / 2, w, h, 12); g.fill();
  g.shadowBlur = 0;
  g.fillStyle = css(edge); g.globalAlpha = (dim ? 0.35 : 1) * (alert ? 0.1 : 0.07); g.fill();
  g.globalAlpha = (dim ? 0.35 : 1) * (active || alert ? 1 : 0.45);
  g.strokeStyle = css(edge); g.lineWidth = active || alert ? 2 : 1; g.stroke();
  g.globalAlpha = dim ? 0.35 : 1;

  // Header: icon badge and title.
  const bx = x - w / 2 + 20, by = y - h / 2 + 19;
  g.fillStyle = css(color); g.globalAlpha *= 0.18;
  g.beginPath(); g.arc(bx, by, 12, 0, Math.PI * 2); g.fill();
  g.globalAlpha = dim ? 0.35 : 1;
  icon(g, name, bx, by, 15, color);
  g.font = '700 10.5px "IBM Plex Mono", monospace'; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillStyle = css(color);
  g.fillText(title.toUpperCase(), bx + 18, by + 1, w - 52);
  if (alert && !dim) {
    g.fillStyle = css('bad'); g.beginPath(); g.arc(x + w / 2 - 16, by, 10, 0, Math.PI * 2); g.fill();
    icon(g, 'alert', x + w / 2 - 16, by - 0.5, 12, 'bg');
  }
  g.restore();
}

/* A soft pill of text inside a box, with an optional icon before it. */
export function badge(g, x, y, text, color, maxW, name) {
  g.save();
  g.font = '600 12px "Hanken Grotesk", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const iw = name ? 18 : 0;
  const tw = Math.min(maxW, g.measureText(text).width + 22 + iw);
  g.fillStyle = css(color); g.globalAlpha = 0.16;
  rr(g, x - tw / 2, y - 12, tw, 24, 12); g.fill();
  g.globalAlpha = 1;
  if (name) icon(g, name, x - tw / 2 + 16, y, 12, color);
  g.fillStyle = css(color);
  g.fillText(text, x + iw / 2, y + 1, tw - 14 - iw);
  g.restore();
}

/* A road between two points: faint dashes, or marching dashes in `color` while a
   message travels it. */
export function road(g, [x1, y1], [x2, y2], color) {
  g.save();
  if (color) {
    g.strokeStyle = css(color); g.globalAlpha = 0.7; g.lineWidth = 2;
    g.setLineDash([6, 6]); g.lineDashOffset = -(performance.now() / 40) % 12;
  } else {
    g.strokeStyle = css('line'); g.setLineDash([3, 5]);
  }
  line(g, x1, y1, x2, y2);
  g.restore();
}

/* A message in flight at (x, y), heading from (fx, fy): a solid block with an icon,
   and a fading tail behind it. */
export function message(g, x, y, label, color, name, from) {
  g.save();
  if (from) {
    const [fx, fy] = from, d = Math.hypot(x - fx, y - fy) || 1;
    for (let i = 1; i <= 4; i++) {
      const back = Math.min(d, i * 9);
      g.fillStyle = css(color); g.globalAlpha = 0.35 - i * 0.07;
      dot(g, x - (x - fx) / d * back, y - (y - fy) / d * back, 5 - i * 0.8);
    }
    g.globalAlpha = 1;
  }
  g.font = '700 11px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const iw = name ? 16 : 0;
  const tw = g.measureText(label).width + 16 + iw;
  g.shadowColor = css(color); g.shadowBlur = 12;
  g.fillStyle = css(color);
  rr(g, x - tw / 2, y - 12, tw, 24, 7); g.fill();
  g.shadowBlur = 0;
  if (name) icon(g, name, x - tw / 2 + 13, y, 11, 'bg');
  g.fillStyle = css('bg');
  g.fillText(label, x + iw / 2, y + 1);
  g.restore();
  return tw;
}

/* The card shown while the story skips ahead in time. */
export function later(g, w, h, text) {
  g.save();
  g.fillStyle = css('bg'); g.globalAlpha = 0.72; g.fillRect(0, 0, w, h);
  g.globalAlpha = 1;
  const cw = Math.min(260, w - 40), ch = 64, x = w / 2 - cw / 2, y = h / 2 - ch / 2;
  g.shadowColor = css('warn'); g.shadowBlur = 24;
  g.fillStyle = css('surface2'); rr(g, x, y, cw, ch, 14); g.fill();
  g.shadowBlur = 0;
  g.strokeStyle = css('warn'); g.lineWidth = 1.5; g.stroke();
  icon(g, 'clock', x + 34, h / 2, 26, 'warn');
  g.font = '700 18px "Bricolage Grotesque", sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillStyle = css('warn');
  g.fillText(text, x + 60, h / 2 + 1, cw - 72);
  g.restore();
}
