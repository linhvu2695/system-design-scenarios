/* Forty merchants' orders spread over shards four ways. Every order is a dot in its
   shard's box, grouped by merchant; the followed merchant's orders light up, EU orders
   on a US shard turn red, and a bar under each shard shows its share of new orders.
   "Add a shard" animates what moves. Before the visitor answers, only the two
   order-id strategies are unlocked. */

import { el } from '../../js/dom.js';
import { tx } from '../../js/i18n.js';
import { canvas, choice, button, stat, css, row, onResize, animate, rng } from '../../js/sim-kit.js';

export const MERCHANTS = 40;
export const RECENT = 0.15;   // the newest 15% of order ids count as "new orders"
export const MAX_SHARDS = 8;
/* The starting shards. Shard 5 is the one the largest merchant pays for; only the
   directory can actually keep it for that merchant. Added shards are in the US. */
export const START = [{ region: 'us' }, { region: 'eu' }, { region: 'us' }, { region: 'eu' }, { region: 'us', dedicated: true }];
export const shardsOf = n => [...START, ...Array.from({ length: Math.max(0, n - START.length) }, () => ({ region: 'us' }))].slice(0, n);

/* Merchants, largest first: a few big stores, a long tail. Merchant 1 is a large EU
   store; about a third of the rest are in the EU. Deterministic. */
export function merchants(seed = 5) {
  const r = rng(seed);
  return Array.from({ length: MERCHANTS }, (_, i) => ({
    id: i,
    size: Math.ceil(120 / (i + 1) ** 0.8),
    eu: i === 1 || (i > 1 && r() < 0.3),
  }));
}

/* Orders in id order: orders[id] is the merchant that placed order `id`. The merchants'
   orders are interleaved over time, so every merchant has old and new ids. */
export function orders(ms, seed = 9) {
  const list = ms.flatMap(m => Array(m.size).fill(m.id));
  const r = rng(seed);
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/* FNV-1a with a murmur3 finalizer: a small, stable string hash. The finalizer matters:
   plain FNV leaves similar strings ("merchant-1", "merchant-2") close together on the
   ring, which makes consistent hashing look far worse than it is. */
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/* Range: start with equal id ranges; each added shard splits the range holding the
   most orders and takes its upper half. Returns the shard index owning each id range
   as [{ from, to, shard }]. */
export function ranges(total, n) {
  let rs = START.map((_, i) => ({ from: Math.round(i * total / START.length), to: Math.round((i + 1) * total / START.length), shard: i }));
  for (let k = START.length; k < n; k++) {
    const big = rs.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a));
    const mid = Math.round((big.from + big.to) / 2);
    rs = rs.flatMap(r => r === big ? [{ ...r, to: mid }, { from: mid, to: r.to, shard: k }] : [r]);
  }
  return rs;
}

/* Consistent hashing: each shard owns 40 points on a ring; a merchant goes to the
   first point clockwise from its own hash. */
export function ring(n, vnodes = 40) {
  const pts = [];
  for (let s = 0; s < n; s++) for (let v = 0; v < vnodes; v++) pts.push({ at: hash(`shard-${s}-${v}`), shard: s });
  return pts.sort((a, b) => a.at - b.at);
}
const onRing = (pts, key) => {
  const h = hash(`merchant-${key}`);
  return (pts.find(p => p.at >= h) || pts[0]).shard;
};

/* Directory: a table merchant -> shard, placed by rule. The largest merchant gets the
   dedicated shard; EU merchants go to EU shards; everyone else to the least-loaded US
   shard. Each added shard is filled by moving whole merchants off the busiest shard
   while that evens things out. Replayed from the start, so it is a pure function of n. */
export function directory(ms, n) {
  const shards = shardsOf(n), dir = new Map(), load = new Array(n).fill(0);
  const put = (m, s) => { if (dir.has(m.id)) load[dir.get(m.id)] -= m.size; dir.set(m.id, s); load[s] += m.size; };
  const open = (region, upto) => shards.map((sh, i) => i).filter(i => i < upto && shards[i].region === region && !shards[i].dedicated);
  for (const m of ms) {
    if (m.id === 0) { put(m, START.findIndex(s => s.dedicated)); continue; }
    const c = open(m.eu ? 'eu' : 'us', START.length);
    put(m, c.reduce((a, b) => (load[b] < load[a] ? b : a)));
  }
  for (let k = START.length; k < n; k++) {
    for (;;) {
      const peers = open(shards[k].region, k);
      const src = peers.reduce((a, b) => (load[b] > load[a] ? b : a));
      const gap = (load[src] - load[k]) / 2;
      const m = ms.filter(x => dir.get(x.id) === src && x.size <= gap).sort((a, b) => b.size - a.size)[0];
      if (!m) break;
      put(m, k);
    }
  }
  return dir;
}

/* The shard of every order under a strategy with n shards. */
export function place(strategy, ms, ords, n) {
  if (strategy === 'range') {
    const rs = ranges(ords.length, n);
    return ords.map((_, id) => rs.find(r => id >= r.from && id < r.to).shard);
  }
  if (strategy === 'hash') return ords.map((_, id) => hash(`order-${id}`) % n);
  if (strategy === 'consistent') {
    const pts = ring(n), memo = new Map();
    return ords.map(m => { if (!memo.has(m)) memo.set(m, onRing(pts, m)); return memo.get(m); });
  }
  if (strategy === 'directory') {
    const dir = directory(ms, n);
    return ords.map(m => dir.get(m));
  }
  throw new Error(`unknown strategy: ${strategy}`);
}

/* What the placement means for the business. */
export function analyze(at, ms, ords, n) {
  const shards = shardsOf(n);
  const spread = id => new Set(at.filter((_, i) => ords[i] === id)).size;
  const fresh = new Array(n).fill(0);
  const first = Math.floor(ords.length * (1 - RECENT));
  for (let i = first; i < ords.length; i++) fresh[at[i]]++;
  const euOutside = at.filter((s, i) => ms[ords[i]].eu && shards[s].region !== 'eu').length;
  const bigShards = new Set(at.filter((_, i) => ords[i] === 0));
  const neighbours = new Set(at.flatMap((s, i) => (bigShards.has(s) && ords[i] !== 0 ? [ords[i]] : []))).size;
  return {
    spread,
    fresh: fresh.map(c => c / (ords.length - first)),
    hottest: Math.max(...fresh) / (ords.length - first),
    euOutside,
    neighbours,   // other merchants sharing a shard with the largest merchant
  };
}

/* Share of orders whose shard changes from n to n + 1 shards. */
export const moved = (strategy, ms, ords, n) => {
  const a = place(strategy, ms, ords, n), b = place(strategy, ms, ords, n + 1);
  return a.filter((s, i) => s !== b[i]).length / ords.length;
};

const STRATEGIES = [
  { value: 'range', label: { en: 'Range on order id', vi: 'Range theo mã đơn' } },
  { value: 'hash', label: { en: 'Hash on order id', vi: 'Hash theo mã đơn' } },
  { value: 'consistent', label: { en: 'Consistent hashing', vi: 'Consistent hashing' } },
  { value: 'directory', label: { en: 'Directory', vi: 'Directory' } },
];
const HOW = {
  range: { en: 'Each shard owns a block of order ids. New orders have the highest ids, so they all land in the last block.', vi: 'Mỗi shard sở hữu một khối mã đơn. Đơn mới có mã lớn nhất, nên tất cả rơi vào khối cuối.' },
  hash: { en: 'Each order goes to hash(order id) mod N. Orders spread evenly, merchants do not stay together.', vi: 'Mỗi đơn đi tới hash(mã đơn) mod N. Đơn được rải đều, nhưng merchant không còn nằm cùng chỗ.' },
  consistent: { en: 'Shards sit on a hash ring. Each merchant, with all its orders, goes to the next shard clockwise from its hash.', vi: 'Các shard nằm trên một vòng hash. Mỗi merchant, cùng mọi đơn của nó, đi tới shard kế tiếp theo chiều kim đồng hồ tính từ giá trị hash.' },
  directory: { en: 'A table says which shard each merchant is on. You fill it by rule: EU merchants on EU shards, the largest merchant on its own.', vi: 'Một bảng ghi mỗi merchant nằm ở shard nào. Bạn điền nó theo quy tắc: merchant EU ở shard EU, merchant lớn nhất ở riêng một shard.' },
};
const FOLLOW = [
  { value: 0, label: { en: 'Largest store (US)', vi: 'Cửa hàng lớn nhất (US)' } },
  { value: 1, label: { en: 'Large EU store', vi: 'Cửa hàng EU lớn' } },
];

export function mount(root, { revealed, state }) {
  const s = Object.assign(state, { strategy: 'range', n: START.length, follow: 0, ...state });
  if (!revealed && (s.strategy === 'consistent' || s.strategy === 'directory')) s.strategy = 'range';

  const ms = merchants(), ords = orders(ms);
  const chart = canvas(240);
  const spread = stat(tx({ en: 'Shards one dashboard query hits', vi: 'Số shard một truy vấn dashboard chạm tới' }));
  const hot = stat(tx({ en: 'Busiest shard, share of new orders', vi: 'Shard bận nhất, tỉ lệ đơn mới' }));
  const eu = stat(tx({ en: 'EU orders outside the EU', vi: 'Đơn EU nằm ngoài EU' }));
  const own = stat(tx({ en: 'Largest store shares its server with', vi: 'Cửa hàng lớn nhất ở chung server với' }));
  const how = el('p', { class: 'sim-how' });
  const event = el('p', { class: 'sim-event', 'aria-live': 'polite' });
  const addBtn = button(tx({ en: 'Add a shard', vi: 'Thêm một shard' }), () => {
    if (s.n >= MAX_SHARDS) return;
    const share = moved(s.strategy, ms, ords, s.n);
    s.n++;
    event.textContent = tx({ en: `Added shard ${s.n}. ${Math.round(share * 100)}% of all orders had to move.`, vi: `Đã thêm shard ${s.n}. ${Math.round(share * 100)}% tổng số đơn phải di chuyển.` });
    update();
  });

  let at, info, pos = null, from = null, stop = () => {};

  function compute() {
    at = place(s.strategy, ms, ords, s.n);
    info = analyze(at, ms, ords, s.n);
    how.textContent = tx(HOW[s.strategy]);
    const sp = info.spread(s.follow);
    spread.set(`${sp} / ${s.n}`, sp > 1 ? 'bad' : 'ok');
    const fair = 1 / s.n;
    hot.set(`${Math.round(info.hottest * 100)}%`, info.hottest > fair * 2 ? 'bad' : info.hottest > fair * 1.4 ? 'warn' : 'ok');
    eu.set(String(info.euOutside), info.euOutside ? 'bad' : 'ok');
    own.set(tx({ en: `${info.neighbours} other stores`, vi: `${info.neighbours} cửa hàng khác` }), info.neighbours ? 'warn' : 'ok');
    addBtn.disabled = s.n >= MAX_SHARDS;
  }

  /* Where each order's dot sits: shards side by side, dots grouped by merchant. */
  function layout(w) {
    const gap = 8, top = 34, bottom = 46;
    const cw = (w - gap * (s.n - 1)) / s.n;
    const counts = new Array(s.n).fill(0);
    at.forEach(sh => counts[sh]++);
    const maxCount = Math.max(...counts);
    let step = 7;
    while (step > 3 && Math.ceil(maxCount / Math.max(1, Math.floor((cw - 10) / step))) * step > chart.el.clientHeight - top - bottom - 8) step--;
    const perRow = Math.max(1, Math.floor((cw - 10) / step));
    const idx = new Array(s.n).fill(0);
    const order = ords.map((m, id) => id).sort((a, b) => at[a] - at[b] || ords[a] - ords[b] || a - b);
    const out = new Array(ords.length);
    for (const id of order) {
      const sh = at[id], k = idx[sh]++;
      out[id] = [sh * (cw + gap) + 5 + step / 2 + (k % perRow) * step, top + 6 + step / 2 + Math.floor(k / perRow) * step];
    }
    return { out, cw, gap, top, bottom, r: Math.max(1.2, step / 2 - 0.8) };
  }

  function draw(p = 1) {
    const { w, h } = chart.fit();
    const g = chart.g, L = layout(w), shards = shardsOf(s.n);
    if (!pos || pos.length !== ords.length) pos = L.out;
    g.clearRect(0, 0, w, h);

    // Shard boxes, labels, and new-order bars.
    for (let i = 0; i < s.n; i++) {
      const x = i * (L.cw + L.gap), sh = shards[i];
      g.fillStyle = css('bg2'); g.strokeStyle = css('line');
      g.beginPath(); g.roundRect(x, L.top, L.cw, h - L.top - L.bottom, 8); g.fill(); g.stroke();
      g.font = '600 11px "IBM Plex Mono", monospace'; g.textBaseline = 'middle'; g.textAlign = 'left';
      g.fillStyle = css('text'); g.fillText(`#${i + 1}`, x + 4, 12);
      g.fillStyle = css(sh.region === 'eu' ? 'blue' : 'muted');
      g.fillText(sh.region.toUpperCase(), x + 30, 12);
      if (sh.dedicated && s.strategy === 'directory') { g.fillStyle = css('warn'); g.fillText('★', x + 54, 12); }
      const fy = h - L.bottom + 10, frac = info.fresh[i];
      g.fillStyle = css('surface2'); g.fillRect(x, fy, L.cw, 8);
      g.fillStyle = css(frac > 2 / s.n ? 'bad' : 'ok'); g.fillRect(x, fy, L.cw * Math.min(1, frac), 8);
      g.fillStyle = css('muted'); g.font = '11px "IBM Plex Mono", monospace';
      g.fillText(`${Math.round(frac * 100)}%`, x, fy + 20);
    }

    // The dots, moving from where they were to where they are now.
    for (let id = 0; id < ords.length; id++) {
      const a = from ? from[id] : L.out[id], b = L.out[id];
      const x = a[0] + (b[0] - a[0]) * p, y = a[1] + (b[1] - a[1]) * p;
      const m = ms[ords[id]], sh = shards[at[id]];
      let color = m.eu ? (sh.region === 'eu' ? 'blue' : 'bad') : 'faint';
      if (m.id === s.follow) color = 'warn';
      g.fillStyle = css(color);
      g.beginPath(); g.arc(x, y, m.id === s.follow ? L.r + 0.6 : L.r, 0, Math.PI * 2); g.fill();
    }
    if (p === 1) { pos = L.out; from = null; }
  }

  function update() {
    compute();
    from = pos;
    stop(); stop = animate(700, draw);
  }

  const locked = tx({ en: 'Make your call below to unlock consistent hashing and the directory.', vi: 'Trả lời câu hỏi bên dưới để mở khoá consistent hashing và directory.' });
  const isLocked = v => !revealed && (v === 'consistent' || v === 'directory');
  root.append(
    row(
      choice(tx({ en: 'Strategy', vi: 'Cách chia' }), STRATEGIES.map(o => ({
        value: o.value, label: tx(o.label), disabled: isLocked(o.value), title: isLocked(o.value) ? locked : null,
      })), s.strategy, v => { s.strategy = v; event.textContent = ''; update(); }),
      choice(tx({ en: 'Follow', vi: 'Theo dõi' }), FOLLOW.map(o => ({ value: String(o.value), label: tx(o.label) })), String(s.follow),
        v => { s.follow = Number(v); compute(); stop(); draw(); }),
    ),
    how,
    el('div', { class: 'sim-buttons' }, [
      addBtn,
      button(tx({ en: `Back to ${START.length} shards`, vi: `Về lại ${START.length} shard` }), () => { s.n = START.length; event.textContent = ''; update(); }),
    ]),
    chart.el,
    el('div', { class: 'sim-legend' }, [
      el('span', { class: 'key-item' }, [el('i', { style: `background:${css('warn')}` }), tx({ en: 'followed store', vi: 'cửa hàng đang theo dõi' })]),
      el('span', { class: 'key-item' }, [el('i', { style: `background:${css('blue')}` }), tx({ en: 'EU store, on an EU shard', vi: 'cửa hàng EU, ở shard EU' })]),
      el('span', { class: 'key-item' }, [el('i', { style: `background:${css('bad')}` }), tx({ en: 'EU store, outside the EU', vi: 'cửa hàng EU, ngoài EU' })]),
      el('span', { class: 'key-item' }, [el('i', { style: `background:${css('faint')}` }), tx({ en: 'other orders', vi: 'đơn khác' })]),
      el('span', { class: 'key-item' }, tx({ en: 'bar: share of new orders · ★ dedicated server', vi: 'thanh: tỉ lệ đơn mới · ★ server riêng' })),
    ]),
    event,
    el('div', { class: 'sim-stats' }, [spread.el, hot.el, eu.el, own.el]),
    revealed ? '' : el('p', { class: 'sim-note' }, locked),
  );

  compute();
  const stopResize = onResize(chart.el, () => { stop(); pos = null; draw(); });
  draw();
  return () => { stop(); stopResize(); };
}
