/* A player for simulations you watch rather than drive: pick a situation and a setup,
   watch it play out step by step, and a scoreboard fills in which setups survive which
   situations. The player owns everything around the picture:

     situation and setup pickers   setups other than `open` stay locked until revealed
     speed, pause, step, replay    one clock; each step lingers so its caption can be read
     caption and "What happened"   the current step's text, and every step so far
     scoreboard                    a run marks its cell once it has been watched to the end
     reduced motion, cleanup       jumps to the end; stops the frame loop and observer

   A scenario supplies the model and the drawing:

     player(root, { revealed, state }, {
       situations: [{ value, label }], setups: [{ value, label }],
       open: ['today'],               setups unlocked before the answer (default: the first)
       initial: { situation },        what a first visit shows (default: the first of each)
       run(setup, situation)          -> { steps, ok, summary }, pure, so tests can pin it
       survives(setup, situation)     -> boolean, for the scoreboard
       duration(step)                 seconds on screen at normal speed (default 1)
       tone(step)                     'bad' | 'warn' | null, colours caption and log line
       height, draw({ g, w, h, result, k, p, moving })
     })

   step: anything the scenario's draw() understands, plus `say: { en, vi }`.
   summary: { en, vi }, the caption once the run has finished.
   draw() is called every frame. k is the step in progress (steps.length once finished),
   p how far it has got (0..1), and moving is false while a finished step lingers. */

import { el } from './dom.js';
import { t, tx } from './i18n.js';
import { canvas, choice, button, css, row, onResize, reducedMotion } from './sim-kit.js';

export const SPEEDS = { slow: 0.5, normal: 1, fast: 2 };
export const DWELL = 1.1;   // seconds a finished step lingers before the next one starts

/* The clock, pure so tests can pin it: { k, p, wait }. */
export const start = () => ({ k: 0, p: 0, wait: 0 });

/* Move the clock on by dt seconds of animation time. */
export function tick(c, dt, steps, duration) {
  if (c.k >= steps.length) return c;
  if (c.wait > 0) return { ...c, wait: c.wait - dt };
  const p = c.p + dt / duration(steps[c.k]);
  return p >= 1 ? { k: c.k + 1, p: 0, wait: DWELL } : { ...c, p };
}

/* The Step button: cut a lingering step short, or finish the one in progress. */
export function skip(c, steps) {
  if (c.k >= steps.length) return c;
  return c.wait > 0 ? { ...c, wait: 0 } : { k: c.k + 1, p: 0, wait: 0 };
}

export function player(root, { revealed, state }, cfg) {
  const { situations, setups, run, survives, draw, height } = cfg;
  const open = cfg.open || [setups[0].value];
  const duration = cfg.duration || (() => 1);
  const toneOf = cfg.tone || (() => null);
  const s = Object.assign(state, { played: {}, ...cfg.initial, ...state });
  if (!situations.some(x => x.value === s.situation)) s.situation = situations[0].value;
  if (!setups.some(x => x.value === s.setup) || (!revealed && !open.includes(s.setup))) s.setup = open[0];
  if (!SPEEDS[s.speed]) s.speed = 'normal';

  const chart = canvas(height);
  const caption = el('p', { class: 'sim-event', 'aria-live': 'polite' });
  const log = el('ol', { class: 'sim-story' });
  const board = el('div', { class: 'sim-board' });
  const reduce = reducedMotion();
  // logged: how many steps are in the log; shown: which caption is up (-1: none yet).
  let result, clock = start(), logged = 0, shown = -1, paused = false, last = 0, raf = 0;

  function play() {
    result = run(s.setup, s.situation);
    clock = start(); logged = 0; shown = -1;
    log.textContent = '';
    setPaused(false);
    cancelAnimationFrame(raf);
    if (reduce) clock = { k: result.steps.length, p: 0, wait: 0 };
    last = performance.now() / 1000;
    frame();
  }

  function frame() {
    const now = performance.now() / 1000;
    if (!paused) clock = tick(clock, (now - last) * SPEEDS[s.speed], result.steps, duration);
    last = now;
    paint();
    if (clock.k < result.steps.length) raf = requestAnimationFrame(frame);
    else finish();
  }

  function step() {
    if (!result || clock.k >= result.steps.length) return;
    setPaused(true);
    clock = skip(clock, result.steps);
  }

  function finish() {
    s.played[`${s.setup}:${s.situation}`] = true;
    paintBoard();
  }

  function paint() {
    const { w, h } = chart.fit();
    const { steps } = result;
    const n = steps.length;
    draw({ g: chart.g, w, h, result, k: clock.k, p: clock.p, moving: clock.k < n && clock.wait <= 0 });

    // Every step that has started goes in the log, in order.
    while (logged < Math.min(clock.k + 1, n)) {
      const st = steps[logged++], tone = toneOf(st);
      log.append(el('li', { style: tone ? `color:${css(tone)}` : null }, tx(st.say)));
    }
    const now = Math.min(clock.k, n);
    if (now !== shown) {
      shown = now;
      const tone = now < n ? toneOf(steps[now]) : result.ok ? null : 'bad';
      caption.textContent = tx(now < n ? steps[now].say : result.summary);
      caption.className = `sim-event ${tone === 'bad' ? 'bad-text' : ''}`;
    }
  }

  function paintBoard() {
    board.textContent = '';
    const rows = setups.filter(x => revealed || open.includes(x.value));
    board.append(
      el('p', { class: 'sim-lbl' }, t('Scoreboard: fills in as you watch each run')),
      el('table', {}, [
        el('thead', {}, el('tr', {}, [el('th', {}, ''), ...situations.map(x => el('th', {}, x.label))])),
        el('tbody', {}, rows.map(r => el('tr', { class: r.value === s.setup ? 'on' : '' }, [
          el('th', {}, r.label),
          ...situations.map(x => {
            const seen = s.played[`${r.value}:${x.value}`], ok = seen && survives(r.value, x.value);
            return el('td', { class: !seen ? 'unseen' : ok ? 'ok' : 'bad' }, !seen ? '·' : ok ? '✓' : '✗');
          }),
        ]))),
      ]),
    );
  }

  const pauseBtn = button('', () => setPaused(!paused));
  function setPaused(v) {
    paused = v;
    pauseBtn.textContent = paused ? `${t('Resume')} ▶` : `${t('Pause')} ❚❚`;
    pauseBtn.classList.toggle('on', paused);
  }

  const locked = t('Make your call below to unlock the other setups.');
  root.append(
    row(choice(t('Situation'), situations, s.situation, v => { s.situation = v; play(); })),
    row(choice(t('Setup'), setups.map(x => {
      const shut = !revealed && !open.includes(x.value);
      return { ...x, disabled: shut, title: shut ? locked : null };
    }), s.setup, v => { s.setup = v; paintBoard(); play(); })),
    row(
      choice(t('Speed'), [
        { value: 'slow', label: t('Slow') },
        { value: 'normal', label: t('Normal') },
        { value: 'fast', label: t('Fast') },
      ], s.speed, v => { s.speed = v; }),
      el('div', { class: 'sim-buttons sim-transport' }, [
        pauseBtn,
        button(`${t('Step')} ›`, step),
        button(t('Replay'), play),
      ]),
    ),
    chart.el,
    caption,
    el('p', { class: 'sim-lbl sim-log-title' }, t('What happened')),
    log,
    board,
    revealed ? '' : el('p', { class: 'sim-note' }, locked),
  );
  paintBoard();
  play();

  const stopResize = onResize(chart.el, () => paint());
  return () => { cancelAnimationFrame(raf); stopResize(); };
}
