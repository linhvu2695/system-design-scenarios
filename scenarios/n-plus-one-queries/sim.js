/* One page of the ticket queue, loaded three ways. The timeline shows every query as a
   block (a network round trip plus the rows it returns); the grid shows which tickets
   actually made it onto the page, and whether their tags are complete. Before the
   visitor answers, only lazy loading is unlocked. */

import { el } from '../../js/dom.js';
import { tx } from '../../js/i18n.js';
import { canvas, choice, slider, button, stat, key, css, row, onResize, animate, rng } from '../../js/sim-kit.js';

export const ROW_MS = 0.01;   // illustrative cost to read and send one row
export const AGENTS = 25;     // agents working the queue

/* The tickets in the queue, newest first: who each is assigned to and how many tags it
   has. Most have a few; about one in ten was tagged by automation and has 20 to 40.
   Deterministic. */
export function queue(n, seed = 11) {
  const r = rng(seed);
  return Array.from({ length: n }, () => ({
    agent: Math.floor(r() * AGENTS),
    tags: r() < 0.1 ? 20 + Math.floor(r() * 21) : Math.floor(r() * 7),
  }));
}

/* What loading one page costs, and what ends up on it. Pure, so the argument is pinned
   by tests/n-plus-one-queries.test.js.
   queries: [{ kind, rows }], one per round trip, in order.
   shown:   per ticket on the page, 'ok' | 'partial' (some tags missing). */
export function load(strategy, tickets, size) {
  const page = tickets.slice(0, size);
  const tagRows = page.reduce((s, t) => s + t.tags, 0);
  const queries = [], shown = [];
  if (strategy === 'lazy') {
    queries.push({ kind: 'page', rows: page.length });
    for (const t of page) {
      queries.push({ kind: 'agent', rows: 1 });
      queries.push({ kind: 'tags', rows: t.tags });
      shown.push('ok');
    }
  } else if (strategy === 'batch') {
    queries.push({ kind: 'page', rows: page.length });
    queries.push({ kind: 'agent', rows: new Set(page.map(t => t.agent)).size });
    queries.push({ kind: 'tags', rows: tagRows });
    for (let i = 0; i < page.length; i++) shown.push('ok');
  } else if (strategy === 'join') {
    // LEFT JOIN on tags: one row per tag (one row for a ticket with none), and LIMIT
    // counts those rows, so it can stop part-way through a ticket.
    let rows = 0;
    for (const t of tickets) {
      if (rows >= size) break;
      const need = Math.max(1, t.tags);
      shown.push(rows + need <= size ? 'ok' : 'partial');
      rows += Math.min(need, size - rows);
    }
    queries.push({ kind: 'join', rows });
  } else throw new Error(`unknown strategy: ${strategy}`);
  return { queries, shown };
}

/* Database time for a page: a round trip per query plus a cost per row. */
export const time = (queries, rttMs) => queries.reduce((s, q) => s + rttMs + q.rows * ROW_MS, 0);

const STRATEGIES = [
  { value: 'lazy', label: { en: 'Lazy load', vi: 'Lazy load' } },
  { value: 'join', label: { en: 'One JOIN + LIMIT', vi: 'Một JOIN + LIMIT' } },
  { value: 'batch', label: { en: 'Batch with IN (...)', vi: 'Batch với IN (...)' } },
];

export function mount(root, { revealed, state }) {
  const s = Object.assign(state, { strategy: 'lazy', size: 100, rtt: 1, ...state });
  if (!revealed) s.strategy = 'lazy';

  const tickets = queue(400);
  const timeline = canvas(70);
  const grid = canvas(120);
  const queries = stat(tx({ en: 'Queries', vi: 'Truy vấn' }));
  const ms = stat(tx({ en: 'Database time', vi: 'Thời gian database' }));
  const onPage = stat(tx({ en: 'Tickets on page', vi: 'Ticket trên trang' }));
  const complete = stat(tx({ en: 'With all tags', vi: 'Đủ tag' }));
  let run, stop = () => {};

  function compute() {
    run = load(s.strategy, tickets, s.size);
    // The timeline's scale is the slowest strategy, so the fast ones look as short as they are.
    run.scale = time(load('lazy', tickets, s.size).queries, s.rtt);
    run.ms = time(run.queries, s.rtt);
    const ok = run.shown.filter(v => v === 'ok').length;
    queries.set(String(run.queries.length), run.queries.length > 10 ? 'bad' : 'ok');
    ms.set(`${run.ms < 10 ? run.ms.toFixed(1) : Math.round(run.ms)} ms`, run.ms > 50 ? 'bad' : 'ok');
    onPage.set(`${run.shown.length} / ${s.size}`, run.shown.length < s.size ? 'bad' : 'ok');
    complete.set(`${ok} / ${run.shown.length}`, ok < run.shown.length ? 'bad' : 'ok');
  }

  const COLORS = { page: 'blue', agent: 'ok', tags: 'warn', join: 'blue' };

  function draw(p = 1) {
    // Timeline: each query is a block as wide as its time.
    {
      const { w, h } = timeline.fit();
      const g = timeline.g, l = 8, r = 8, pw = w - l - r;
      g.clearRect(0, 0, w, h);
      let at = 0;
      for (const q of run.queries) {
        const d = s.rtt + q.rows * ROW_MS;
        if (at / run.scale > p) break;
        const x0 = l + (at / run.scale) * pw;
        const x1 = l + (Math.min(at + d, p * run.scale) / run.scale) * pw;
        g.fillStyle = css(COLORS[q.kind]);
        g.fillRect(x0, 14, Math.max(1, x1 - x0 - (pw / run.queries.length > 3 ? 1 : 0)), 26);
        at += d;
      }
      g.fillStyle = css('muted');
      g.font = '11px "IBM Plex Mono", monospace';
      g.textBaseline = 'top';
      g.textAlign = 'left';
      g.fillText('0 ms', l, 48);
      g.textAlign = 'right';
      g.fillText(`${Math.round(run.scale)} ms`, w - r, 48);
    }
    // The page: one square per ticket slot.
    {
      const { w, h } = grid.fit();
      const g = grid.g, cols = Math.min(25, s.size), rows = Math.ceil(s.size / cols);
      const cell = Math.min((w - 16) / cols, (h - 8) / rows);
      g.clearRect(0, 0, w, h);
      for (let i = 0; i < s.size; i++) {
        const v = p === 1 ? run.shown[i] : null;
        g.fillStyle = v === 'ok' ? css('ok') : v === 'partial' ? css('warn') : css('line');
        g.fillRect(8 + (i % cols) * cell, 4 + Math.floor(i / cols) * cell, cell - 3, cell - 3);
      }
    }
  }

  const replay = () => { stop(); stop = animate(1600, draw); };
  const update = () => { compute(); replay(); };

  const locked = tx({ en: 'Make your call below to unlock the other strategies.', vi: 'Trả lời câu hỏi bên dưới để mở khoá các cách còn lại.' });
  root.append(
    row(
      choice(tx({ en: 'Strategy', vi: 'Cách tải' }), STRATEGIES.map(o => ({
        value: o.value, label: tx(o.label),
        disabled: !revealed && o.value !== 'lazy', title: !revealed && o.value !== 'lazy' ? locked : null,
      })), s.strategy, v => { s.strategy = v; update(); }),
    ),
    row(
      slider(tx({ en: 'Page size', vi: 'Kích thước trang' }), { min: 25, max: 200, step: 25, value: s.size, format: String },
        v => { s.size = v; stop(); compute(); draw(); }),
      slider(tx({ en: 'Round trip', vi: 'Một vòng mạng' }), { min: 0.2, max: 5, step: 0.1, value: s.rtt, format: v => `${v} ms` },
        v => { s.rtt = v; stop(); compute(); draw(); }),
    ),
    el('p', { class: 'sim-lbl' }, tx({ en: 'Queries, in order', vi: 'Các truy vấn, theo thứ tự' })),
    timeline.el,
    el('div', { class: 'sim-legend' }, [
      key(css('blue'), tx({ en: 'tickets query', vi: 'truy vấn tickets' })),
      key(css('ok'), tx({ en: 'assignee', vi: 'người được giao' })),
      key(css('warn'), tx({ en: 'tags', vi: 'tag' })),
    ]),
    el('p', { class: 'sim-lbl' }, tx({ en: 'The page', vi: 'Trang hiển thị' })),
    grid.el,
    el('div', { class: 'sim-legend' }, [
      key(css('ok'), tx({ en: 'ticket with all its tags', vi: 'ticket đủ tag' })),
      key(css('warn'), tx({ en: 'tags cut off', vi: 'thiếu tag' })),
      key(css('line'), tx({ en: 'missing from the page', vi: 'không có trên trang' })),
    ]),
    el('div', { class: 'sim-stats' }, [queries.el, ms.el, onPage.el, complete.el]),
    el('p', { class: 'sim-note' }, tx({
      en: 'Round-trip and per-row costs are illustrative, not measured.',
      vi: 'Chi phí mỗi vòng mạng và mỗi dòng là minh hoạ, không phải số đo.',
    })),
    el('div', { class: 'sim-foot' }, [
      revealed ? el('span') : el('p', { class: 'sim-note' }, locked),
      button(tx({ en: 'Replay', vi: 'Chạy lại' }), replay),
    ]),
  );

  const stopResize = onResize(timeline.el, () => { stop(); draw(); });
  update();
  return () => { stop(); stopResize(); };
}
