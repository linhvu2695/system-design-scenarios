/* System Design Scenarios. One page, no framework, no build step.
   Hash routing (#/ and #/s/<id>) so it works from any static host without rewrites,
   and every scenario deep-links. */

import { $, el, md } from './dom.js';
import { t, tx, LANG, setLang, onLang, FLAGS } from './i18n.js';
import * as progress from './progress.js';
import IDS from '../scenarios/index.js';
import CATEGORIES from '../scenarios/categories.js';

/* ---------------- scenarios ----------------
   The folder name is the id. Modules load on demand and are cached. */
const cache = new Map();
const load = id => {
  if (!cache.has(id)) cache.set(id, import(`../scenarios/${id}/index.js`).then(m => ({ ...m.default, id })));
  return cache.get(id);
};
const num = id => String(IDS.indexOf(id) + 1).padStart(2, '0');
// One scenario failing to load (a typo, a stale cached module) leaves out that one only.
const loadAll = async () => (await Promise.allSettled(IDS.map(load)))
  .flatMap((r, i) => r.status === 'fulfilled' ? [r.value] : (console.error(IDS[i], r.reason), []));

/* A scenario's category, as a colored label. The color comes from css/style.css
   (.cat-<id>), so it lives with the rest of the palette. */
const category = id => CATEGORIES.find(c => c.id === id);
const catTag = (id, href) => el(href ? 'a' : 'span', { class: `cat cat-${id}`, href: href ?? null }, tx(category(id)?.label));

/* ---------------- shell ---------------- */
function shell() {
  document.documentElement.lang = LANG;
  $('#eyebrow').textContent = t('System design · Interactive scenarios');
  $('#score').textContent = IDS.length ? t('{c} of {n} solved', { c: progress.solvedCount(IDS), n: IDS.length }) : '';

  const box = $('#lang');
  box.textContent = '';
  for (const [l, name] of [['vi', 'Tiếng Việt'], ['en', 'English']])
    box.append(el('button', {
      class: LANG === l ? 'on' : '', title: name, 'aria-label': name,
      'aria-pressed': String(LANG === l), onclick: () => setLang(l), html: FLAGS[l],
    }));

  const foot = $('#foot');
  foot.textContent = '';
  foot.append(el('p', {}, [
    t('Topics inspired by'), ' ',
    el('i', {}, '60 Days of System Design Questions'), ' ', t('by'), ' ',
    el('a', { href: 'https://www.linkedin.com/in/joud-awad/', target: '_blank', rel: 'noopener' }, 'Joud Awad'), '. ',
    t('Scenarios, explanations and simulations are written for this project.'),
  ]));
}

/* ---------------- routing ---------------- */
let cleanup = () => {};
let renderId = 0;

async function render() {
  const mine = ++renderId;
  cleanup();
  cleanup = () => {};
  const main = $('#main');
  const m = location.hash.match(/^#\/s\/([\w-]+)$/);
  const c = location.hash.match(/^#\/c\/([\w-]+)$/);
  const filter = c && category(c[1]) ? c[1] : null;
  const all = await loadAll();
  const view = m && IDS.includes(m[1]) ? scenarioView(m[1]) : listView(all, filter);
  const result = await view.catch(err => {
    console.error(err);
    return { node: el('p', { class: 'muted' }, String(err.message || err)) };
  });
  if (mine !== renderId) { result.cleanup?.(); return; }   // a newer navigation won
  const side = $('#side');
  side.textContent = '';
  // On a scenario page, highlight the scenario's own category.
  side.append(sidebar(all, m ? all.find(s => s.id === m[1])?.category ?? null : filter));
  main.textContent = '';
  main.append(result.node);
  result.mounted?.();
  cleanup = result.cleanup || (() => {});
  shell();
}

/* ---------------- sidebar ----------------
   Every category with how many scenarios it has; it is also the list's filter.
   A category with none yet stays visible, dimmed and not a link. */
function sidebar(all, active) {
  const count = id => all.filter(s => s.category === id).length;
  const item = (id, label, n) => {
    const on = active === id;
    return el('li', {}, el(n || !id ? 'a' : 'span', {
      class: ['topic-link', id ? `cat-${id}` : '', on ? 'on' : '', n ? '' : 'empty'].join(' ').trim(),
      href: n || !id ? (id ? `#/c/${id}` : '#/') : null,
      'aria-current': on ? 'true' : null,
    }, [id ? el('i') : '', el('span', { class: 'label' }, label), el('span', { class: 'n' }, String(n))]));
  };
  return el('nav', { 'aria-label': t('Categories') }, [
    el('h4', {}, t('Categories')),
    el('ul', { class: 'topics' }, [
      item(null, t('All'), all.length),
      ...CATEGORIES.map(cat => item(cat.id, tx(cat.label), count(cat.id))),
    ]),
  ]);
}

/* ---------------- list ---------------- */
async function listView(all, filter) {
  const node = el('div', { class: 'list' }, [el('p', { class: 'lede' }, t('Each scenario is a situation from a real system with four possible calls. Play with the simulation, make your call, then see why each option holds up or falls apart.'))]);
  if (!all.length) { node.append(el('p', { class: 'muted' }, t('No scenarios yet. Run make new ID=<name> to add one.'))); return { node }; }

  // The category filter is the sidebar; the card shows its category as a color only.
  const grid = el('div', { class: 'grid' });
  for (const s of all.filter(s => !filter || s.category === filter)) {
    const p = progress.get(s.id);
    const [cls, label] = !p ? ['new', t('New')] : p.correct ? ['ok', t('Solved')] : ['bad', t('Missed')];
    const cat = tx(category(s.category)?.label);
    grid.append(el('a', { class: `card cat-${s.category}`, href: `#/s/${s.id}`, title: cat }, [
      el('div', { class: 'card-top' }, [
        el('span', { class: 'num' }, [num(s.id), el('span', { class: 'sr-only' }, ` · ${cat}`)]),
        el('span', { class: `pill ${cls}` }, [el('i'), label]),
      ]),
      el('div', { class: 'topic' }, tx(s.topic)),
      el('h3', {}, tx(s.title)),
    ]));
  }
  node.append(grid);
  return { node };
}

/* ---------------- one scenario ----------------
   A language switch re-renders the view; `session` keeps an unchecked pick and the
   simulation's controls so the visitor does not lose them. */
const session = new Map();

async function scenarioView(id) {
  const s = await load(id);
  const prior = progress.get(id);
  if (!session.has(id)) session.set(id, { picked: null, simState: {} });
  const ui = session.get(id);
  ui.revealed = !!prior;
  if (prior) ui.picked = prior.picked;

  const simBox = el('div', { class: 'sim' });
  const quiz = el('div', { class: 'quiz' });
  const after = el('div', { class: 'after' });
  let stopSim = () => {};

  function mountSim() {
    stopSim();
    stopSim = () => {};
    simBox.textContent = '';
    if (!s.simulation) return;
    try {
      stopSim = s.simulation.mount(simBox, { revealed: ui.revealed, state: ui.simState }) || (() => {});
    } catch (err) {
      console.error(err);
      simBox.textContent = '';
      simBox.append(el('p', { class: 'muted' }, t('This simulation failed to load.')));
    }
  }

  const pick = optId => {
    if (ui.revealed) return;
    ui.picked = optId;
    paint();
  };
  const check = () => {
    if (ui.revealed || !ui.picked) return;
    ui.revealed = true;
    progress.record(id, ui.picked, ui.picked === s.answer);
    paint();
    mountSim();
    shell();
    after.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  };
  const reset = () => {
    ui.revealed = false;
    ui.picked = null;
    progress.clear(id);
    paint();
    mountSim();
    shell();
  };

  function paint() {
    quiz.textContent = '';
    after.textContent = '';

    const options = el('div', { class: 'options', role: 'radiogroup', 'aria-label': t('Answers') });
    for (const o of s.options) {
      const state = !ui.revealed ? '' : o.id === s.answer ? 'right' : o.id === ui.picked ? 'wrong' : 'other';
      options.append(el('button', {
        type: 'button', role: 'radio',
        class: ['opt', ui.picked === o.id ? 'picked' : '', state].join(' ').trim(),
        'aria-checked': String(ui.picked === o.id),
        'aria-disabled': ui.revealed ? 'true' : null,
        onclick: () => pick(o.id),
      }, [
        el('span', { class: 'letter' }, o.id),
        el('div', { class: 'opt-body' }, [
          md(tx(o.text)),
          ui.revealed ? el('div', { class: 'why' }, [
            el('span', { class: 'why-tag' }, o.id === s.answer ? t('Why this works') : t('Why not')),
            md(tx(o.why)),
          ]) : '',
        ]),
      ]));
    }

    const bar = el('div', { class: 'actions' });
    if (!ui.revealed) {
      bar.append(
        el('button', { type: 'button', class: 'btn primary', disabled: ui.picked ? null : '', onclick: check }, t('Check answer')),
        el('span', { class: 'muted sm' }, t('Pick an answer, then check it. Keys A–D and Enter work too.')),
      );
    } else {
      const right = ui.picked === s.answer;
      bar.append(
        el('div', { class: `verdict ${right ? 'ok' : 'bad'}`, role: 'status' }, right ? t('Correct.') : t('Not quite. The answer is {x}.', { x: s.answer })),
        el('button', { type: 'button', class: 'btn ghost', onclick: reset }, t('Try again')),
      );
    }
    quiz.append(el('h3', { class: 'question' }, tx(s.question)), options, bar);

    if (ui.revealed) {
      after.append(el('section', { class: 'takeaway' }, [el('h4', {}, t('Takeaway')), md(tx(s.takeaway))]));
      if (s.sources?.length)
        after.append(el('section', { class: 'sources' }, [
          el('h4', {}, t('Sources')),
          el('ul', {}, s.sources.map(src => el('li', {}, el('a', { href: src.url, target: '_blank', rel: 'noopener' }, tx(src.title))))),
        ]));
    }
  }

  const i = IDS.indexOf(id);
  const navLink = (target, label, cls) => target
    ? el('a', { class: `btn ghost ${cls}`, href: `#/s/${target}` }, label)
    : el('span');

  const node = el('article', { class: 'scenario' }, [
    el('a', { class: 'back', href: '#/' }, `← ${t('All scenarios')}`),
    el('div', { class: 'meta' }, [el('span', { class: 'num' }, t('Scenario {n}', { n: num(id) })), catTag(s.category, `#/c/${s.category}`), el('span', { class: 'topic' }, tx(s.topic))]),
    el('h2', {}, tx(s.title)),
    el('section', { class: 'panel' }, [el('h4', {}, t('The situation')), md(tx(s.scenario))]),
    s.simulation ? el('section', { class: 'panel' }, [el('h4', {}, t('Explore')), simBox]) : '',
    el('section', { class: 'panel' }, [el('h4', {}, t('Your call')), quiz]),
    after,
    el('nav', { class: 'pager' }, [
      navLink(IDS[i - 1], `← ${t('Previous')}`, 'prev'),
      navLink(IDS[i + 1], `${t('Next')} →`, 'next'),
    ]),
  ]);
  paint();

  const LETTERS = { a: 'A', b: 'B', c: 'C', d: 'D', 1: 'A', 2: 'B', 3: 'C', 4: 'D' };
  const onKey = e => {
    if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const letter = LETTERS[e.key.toLowerCase()];
    if (letter && s.options.some(o => o.id === letter)) pick(letter);
    else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'A') check();
  };
  document.addEventListener('keydown', onKey);

  return {
    node,
    mounted: () => { window.scrollTo(0, 0); mountSim(); },
    cleanup: () => { stopSim(); document.removeEventListener('keydown', onKey); },
  };
}

/* ---------------- boot ---------------- */
onLang(render);
window.addEventListener('hashchange', render);
render();
