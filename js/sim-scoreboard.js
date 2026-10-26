/* The scoreboard: setups (rows) × situations (columns). A cell fills in once that run
   has been watched to the end, green with ✓ if the setup survives it, red with ✕ if it
   breaks; clicking a cell plays that matchup. A row watched in every situation without
   a failure is highlighted. Locked setups show as dimmed rows with a padlock.

   js/sim-player.js uses it; a simulation not on the player can call it too:

     scoreboard({
       situations, setups,            [{ value, label, icon }], as for the player
       played,                        { 'setup:situation': true } for runs watched
       survives(setup, situation),    -> boolean
       current: { setup, situation }, the matchup on screen, ringed
       isOpen(setup),                 false for a setup locked until the answer
       onPick(setup, situation),      a cell was clicked
       onFillAll(),                   "Show all results": mark every open matchup played
       fresh,                         Set of 'setup:situation' keys to animate in
     }) -> element */

import { el } from './dom.js';
import { t } from './i18n.js';
import { svg } from './icons.js';

const ico = name => el('span', { class: 'ico', html: svg(name) });

export function scoreboard({ situations, setups, played, survives, current, isOpen, onPick, onFillAll, fresh = new Set() }) {
  let order = 0;   // fresh tiles flip in one after another, row by row
  const open = setups.filter(r => isOpen(r.value));
  const watched = open.reduce((n, r) => n + situations.filter(x => played[`${r.value}:${x.value}`]).length, 0);
  const total = open.length * situations.length;

  const grid = el('div', { class: 'score-grid', role: 'table', style: `--cols:${situations.length}` }, [
    el('div', { class: 'score-tr', role: 'row' }, [
      el('span', { class: 'score-corner', role: 'columnheader' }),
      ...situations.map(x => el('span', { class: 'score-col', role: 'columnheader', title: x.label }, [x.icon ? ico(x.icon) : '', el('span', {}, x.label)])),
    ]),
    ...setups.map(r => {
      const shut = !isOpen(r.value);
      // A locked row never shows a result, even one watched before "Try again".
      const results = situations.map(x => !shut && played[`${r.value}:${x.value}`] ? survives(r.value, x.value) : null);
      const champ = !shut && results.every(v => v === true);
      return el('div', { class: ['score-tr', shut ? 'shut' : '', champ ? 'champ' : '', r.value === current.setup ? 'on' : ''].join(' ').trim(), role: 'row' }, [
        el('span', { class: 'score-row', role: 'rowheader' }, [
          r.icon ? ico(r.icon) : '',
          el('span', { class: 'score-name' }, r.label),
          shut ? el('span', { class: 'ico lock', title: t('Locked until you answer'), html: svg('lock') }) : '',
          champ ? el('span', { class: 'champ-tag' }, [ico('check'), t('Survives every situation')]) : '',
        ]),
        ...situations.map((x, i) => {
          const v = results[i];
          const state = v === true ? 'ok' : v === false ? 'bad' : 'unseen';
          const word = shut ? t('Locked until you answer') : v === true ? t('Survives') : v === false ? t('Breaks') : t('Not watched yet: click to play');
          const here = r.value === current.setup && x.value === current.situation;
          const pop = fresh.has(`${r.value}:${x.value}`);
          return el('span', { class: 'score-td', role: 'cell' }, el('button', {
            type: 'button', class: ['cell', state, here ? 'here' : '', pop ? 'pop' : ''].join(' ').trim(), disabled: shut ? '' : null,
            style: pop ? `animation-delay:${order++ * 60}ms` : null,
            title: `${r.label} · ${x.label}: ${word}`, 'aria-label': `${r.label} · ${x.label}: ${word}`,
            onclick: () => onPick(r.value, x.value),
            html: svg(shut ? 'lock' : v === true ? 'check' : v === false ? 'cross' : 'play'),
          }));
        }),
      ]);
    }),
  ]);

  return el('div', { class: 'score' }, [
    el('div', { class: 'score-top' }, [
      el('p', { class: 'deck-title' }, [el('span', { class: 'deck-n' }, '3'), t('Scoreboard')]),
      el('div', { class: 'score-actions' }, [
        el('span', { class: 'score-count' }, t('{c} of {n} matchups watched', { c: watched, n: total })),
        onFillAll && watched < total
          ? el('button', { type: 'button', class: 'btn sm fill-all', onclick: onFillAll }, [ico('grid'), t('Show all results')])
          : '',
      ]),
    ]),
    el('div', { class: 'score-scroll' }, grid),
  ]);
}
