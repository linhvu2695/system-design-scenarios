/* Template simulation: one slider driving a bar on a canvas. Replace all of it.
   The contract (mount, revealed, state, cleanup) is documented in js/sim-kit.js;
   rate-limit-algorithms/sim.js is a full example. Keep the model in pure exported
   functions so tests can pin it, and keep the DOM in mount(). */

import { el } from '../../js/dom.js';
import { tx } from '../../js/i18n.js';
import { canvas, slider, stat, css, row, onResize } from '../../js/sim-kit.js';

/* The model. Pure: no DOM, no randomness without a seed. */
export const model = load => ({ latency: 20 + load * load * 0.02 });

export function mount(root, { revealed, state }) {
  const s = Object.assign(state, { load: 50, ...state });

  const chart = canvas(120);
  const latency = stat(tx({ en: 'Latency', vi: 'Độ trễ' }));

  function draw() {
    const { latency: ms } = model(s.load);
    latency.set(`${Math.round(ms)} ms`, ms > 150 ? 'bad' : 'ok');
    const { w, h } = chart.fit();
    const g = chart.g;
    g.clearRect(0, 0, w, h);
    g.fillStyle = css(ms > 150 ? 'bad' : 'ok');
    g.fillRect(0, h / 2 - 12, Math.min(w, (ms / 220) * w), 24);
  }

  root.append(
    row(slider(tx({ en: 'Load', vi: 'Tải' }), { min: 0, max: 100, value: s.load, format: v => `${v}%` },
      v => { s.load = v; draw(); })),
    chart.el,
    el('div', { class: 'sim-stats' }, [latency.el]),
    // Hide anything that gives the answer away until the visitor has made their call.
    revealed ? '' : el('p', { class: 'sim-note' }, tx({ en: 'TODO what unlocks after answering', vi: 'TODO' })),
  );

  const stopResize = onResize(chart.el, draw);
  draw();
  return () => stopResize();
}
