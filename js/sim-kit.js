/* Building blocks for simulations.

   A simulation is a module exporting
       mount(root, { revealed, state }) -> cleanup()
   - root      an empty element to render into
   - revealed  whether the visitor has checked their answer. The app re-mounts on reveal,
               so a simulation can keep answer-giving controls locked until then.
   - state     a plain object that survives re-mounts (reveal, language switch). Keep
               the visitor's slider and toggle positions here.
   cleanup() must stop every timer, animation frame and observer the simulation started.

   Labels are passed in already translated: simulations write their own strings as
   { en, vi } and read them with tx(), next to the scenario they belong to. */

import { el } from './dom.js';

/* A theme color from css/style.css, e.g. css('ok'), for drawing on canvas. */
export const css = name => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();

export const row = (...kids) => el('div', { class: 'sim-row' }, kids);

/* A segmented control. options: [{ value, label, disabled?, title? }]. */
export function choice(label, options, value, onChange) {
  const seg = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  const paint = v => {
    for (const b of seg.children) {
      b.classList.toggle('on', b.dataset.v === v);
      b.setAttribute('aria-checked', String(b.dataset.v === v));
    }
  };
  for (const o of options)
    seg.append(el('button', {
      type: 'button', role: 'radio', 'data-v': o.value, title: o.title ?? null,
      disabled: o.disabled ? '' : null,
      onclick: () => { paint(o.value); onChange(o.value); },
    }, o.label));
  paint(value);
  return el('div', { class: 'sim-ctl' }, [el('span', { class: 'sim-lbl' }, label), seg]);
}

export function slider(label, { min, max, step = 1, value, format = String }, onChange) {
  const out = el('output', {}, format(value));
  const input = el('input', {
    type: 'range', min, max, step, value, 'aria-label': label,
    oninput: () => { const v = Number(input.value); out.textContent = format(v); onChange(v); },
  });
  return el('label', { class: 'sim-ctl' }, [el('span', { class: 'sim-lbl' }, [label, ' ', out]), input]);
}

export const button = (label, onClick) => el('button', { type: 'button', class: 'btn ghost sm', onclick: onClick }, label);

/* A labelled number. set(text, tone) where tone is '', 'ok', 'warn' or 'bad'. */
export function stat(label) {
  const value = el('b');
  return {
    el: el('div', { class: 'stat' }, [el('span', {}, label), value]),
    set(text, tone = '') { value.textContent = text; value.className = tone; },
  };
}

/* A legend chip: swatch + text. */
export const key = (color, text) => el('span', { class: 'key-item' }, [el('i', { style: `background:${color}` }), text]);

/* A canvas sized for the device pixel ratio. Call fit() at the start of every draw;
   it returns the size in CSS pixels to draw in. */
export function canvas(height) {
  const c = el('canvas', { class: 'sim-canvas', style: `height:${height}px` });
  const g = c.getContext('2d');
  const fit = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 600;
    c.width = Math.round(w * dpr);
    c.height = Math.round(height * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h: height };
  };
  return { el: c, g, fit };
}

/* Calls fn when the element's width changes (not on the first observation). */
export function onResize(node, fn) {
  if (!('ResizeObserver' in window)) return () => {};
  let width = null;
  const ro = new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    if (width !== null && w !== width) fn();
    width = w;
  });
  ro.observe(node);
  return () => ro.disconnect();
}

export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/* Runs frame(p) with p going 0 -> 1 over `ms`. Returns stop(). Honors reduced motion. */
export function animate(ms, frame) {
  if (reducedMotion()) { frame(1); return () => {}; }
  let id;
  const start = performance.now();
  const tick = now => {
    const p = Math.min(1, (now - start) / ms);
    frame(p);
    if (p < 1) id = requestAnimationFrame(tick);
  };
  id = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(id);
}

/* Seeded PRNG (mulberry32): random-looking traffic that is the same on every load,
   so a chart never changes under the reader and tests can pin it. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
