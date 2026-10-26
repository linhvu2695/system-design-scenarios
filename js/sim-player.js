/* A player for simulations you watch rather than drive: pick what goes wrong and how
   you handle it, watch it play out step by step, and a scoreboard fills in which
   setups survive which situations. The player owns everything around the picture:

     two rows of chips          situations, then setups; setups other than `open` stay
                                locked until revealed, and each setup chip shows ✓/✗
                                for the current situation once that run was watched
     a video-player bar         play/pause, step, replay, a track with one segment per
                                step (coloured by its tone, click to jump), speed
     caption and log            the current step's text, and every step so far
     scoreboard                 a run marks its cell once it has been watched to the end
     reduced motion, cleanup    jumps to the end; stops the frame loop and observer

   A scenario supplies the model and the drawing:

     player(root, { revealed, state }, {
       situations: [{ value, label, icon, tone }]   tone 'ok' for the calm one, else warn
       setups: [{ value, label, icon }]             icon: a name from js/icons.js
       open: ['today'],               setups unlocked before the answer (default: the first)
       initial: { situation },        what a first visit shows (default: the first of each)
       run(setup, situation)          -> { steps, ok, summary }, pure, so tests can pin it
       survives(setup, situation)     -> boolean, for the scoreboard
       duration(step)                 seconds on screen at normal speed (default 1)
       tone(step)                     'bad' | 'warn' | null, colours caption, log and track
       height, draw({ g, w, h, result, k, p, moving })
     })

   step: anything the scenario's draw() understands, plus `say: { en, vi }`.
   summary: { en, vi }, the caption once the run has finished.
   draw() is called every frame. k is the step in progress (steps.length once finished),
   p how far it has got (0..1), and moving is false while a finished step lingers. */

import { el } from './dom.js';
import { t, tx } from './i18n.js';
import { svg } from './icons.js';
import { canvas, css, onResize, reducedMotion } from './sim-kit.js';

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

const ico = (name, cls = 'ico') => el('span', { class: cls, html: svg(name) });

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
  const deck = el('div', { class: 'deck' });
  const track = el('div', { class: 'track' });
  const counter = el('span', { class: 'counter' });
  const reduce = reducedMotion();
  const locked = t('Make your call below to unlock the other setups.');
  // logged: how many steps are in the log; shown: which caption is up (-1: none yet).
  let result, clock = start(), logged = 0, shown = -1, paused = false, last = 0, raf = 0;
  const done = () => clock.k >= result.steps.length;

  function play() {
    result = run(s.setup, s.situation);
    clock = start(); logged = 0; shown = -1;
    log.textContent = '';
    buildTrack();
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
    if (!done()) raf = requestAnimationFrame(frame);
    else finish();
  }

  /* Restart the frame loop after a jump or step once it has stopped at the end. */
  function wake() {
    cancelAnimationFrame(raf);
    last = performance.now() / 1000;
    frame();
  }

  function step() {
    if (!result || done()) return;
    setPaused(true);
    clock = skip(clock, result.steps);
    wake();
  }

  /* Jump to step i, paused, with the log rebuilt up to it. */
  function jump(i) {
    setPaused(true);
    clock = { k: i, p: 0, wait: 0 };
    log.textContent = ''; logged = 0; shown = -1;
    wake();
  }

  function finish() {
    const key = `${s.setup}:${s.situation}`;
    if (!s.played[key]) { s.played[key] = true; paintDeck(); }
    paintBoard();
    setPaused(paused);
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
    paintTrack();
  }

  /* ---- the chips ---- */
  function chip(x, on, onPick, { tone, shut, mark } = {}) {
    return el('button', {
      type: 'button', role: 'radio', class: ['pick', on ? 'on' : '', tone ? `tone-${tone}` : '', shut ? 'shut' : ''].join(' ').trim(),
      'aria-checked': String(on), disabled: shut ? '' : null, title: shut ? locked : null,
      onclick: () => onPick(x.value),
    }, [x.icon ? ico(x.icon) : '', el('span', {}, x.label), shut ? ico('lock', 'ico end') : mark || '']);
  }

  function paintDeck() {
    deck.textContent = '';
    const heading = (n, text) => el('p', { class: 'deck-title' }, [el('span', { class: 'deck-n' }, n), text]);
    deck.append(
      heading('1', t('What goes wrong')),
      el('div', { class: 'picks', role: 'radiogroup', 'aria-label': t('What goes wrong') }, situations.map((x, i) =>
        chip(x, x.value === s.situation, v => { s.situation = v; paintDeck(); play(); }, { tone: x.tone || (i ? 'warn' : 'ok') }))),
      heading('2', t('How you handle it')),
      el('div', { class: 'picks', role: 'radiogroup', 'aria-label': t('How you handle it') }, setups.map(x => {
        const shut = !revealed && !open.includes(x.value);
        const seen = s.played[`${x.value}:${s.situation}`];
        const mark = seen && (survives(x.value, s.situation)
          ? el('span', { class: 'res ok', title: t('Survives this situation'), html: svg('check') })
          : el('span', { class: 'res bad', title: t('Breaks in this situation'), html: svg('cross') }));
        return chip(x, x.value === s.setup, v => { s.setup = v; paintDeck(); paintBoard(); play(); }, { tone: 'setup', shut, mark });
      })),
    );
  }

  /* ---- the bar under the picture ---- */
  const mainBtn = el('button', { type: 'button', class: 'tbtn main', onclick: () => (done() ? play() : setPaused(!paused)) });
  function setPaused(v) {
    paused = v;
    const end = result && done();
    mainBtn.innerHTML = svg(end ? 'replay' : paused ? 'play' : 'pause');
    mainBtn.setAttribute('aria-label', end ? t('Replay') : paused ? t('Play') : t('Pause'));
    mainBtn.title = mainBtn.getAttribute('aria-label');
  }

  function buildTrack() {
    track.textContent = '';
    result.steps.forEach((st, i) => {
      const tone = toneOf(st) || 'blue';
      track.append(el('button', {
        type: 'button', class: 'seg', style: `--c:var(--${tone})`, title: tx(st.say),
        'aria-label': t('Step {n} of {total}', { n: i + 1, total: result.steps.length }), onclick: () => jump(i),
      }, el('i')));
    });
  }

  function paintTrack() {
    const n = result.steps.length;
    [...track.children].forEach((seg, i) => {
      const fill = i < clock.k ? 1 : i === clock.k && clock.wait <= 0 ? clock.p : 0;
      seg.firstChild.style.width = `${fill * 100}%`;
      seg.classList.toggle('now', i === clock.k);
    });
    counter.textContent = `${Math.min(clock.k + 1, n)} / ${n}`;
  }

  const speed = el('div', { class: 'speed', role: 'radiogroup', 'aria-label': t('Speed') }, [
    ico('gauge'),
    ...[['slow', '0.5×'], ['normal', '1×'], ['fast', '2×']].map(([v, label]) => el('button', {
      type: 'button', role: 'radio', class: s.speed === v ? 'on' : '', 'aria-checked': String(s.speed === v),
      onclick: e => {
        s.speed = v;
        for (const b of speed.querySelectorAll('button')) { b.classList.toggle('on', b === e.currentTarget); b.setAttribute('aria-checked', String(b === e.currentTarget)); }
      },
    }, label)),
  ]);

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

  root.append(
    deck,
    revealed ? '' : el('p', { class: 'sim-note deck-note' }, [ico('lock'), locked]),
    el('div', { class: 'stage' }, [
      chart.el,
      el('div', { class: 'transport' }, [
        mainBtn,
        el('button', { type: 'button', class: 'tbtn', title: t('Step'), 'aria-label': t('Step'), html: svg('step'), onclick: step }),
        el('button', { type: 'button', class: 'tbtn', title: t('Replay'), 'aria-label': t('Replay'), html: svg('replay'), onclick: play }),
        track,
        counter,
        speed,
      ]),
    ]),
    caption,
    el('p', { class: 'sim-lbl sim-log-title' }, t('What happened')),
    log,
    board,
  );
  paintDeck();
  paintBoard();
  play();

  const stopResize = onResize(chart.el, () => paint());
  return () => { cancelAnimationFrame(raf); stopResize(); };
}
