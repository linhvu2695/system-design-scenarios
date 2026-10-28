/* Forty merchants' orders spread over shards four ways. Every order is a dot in its
   shard's box, grouped by merchant; the followed merchant's orders light up, EU orders
   on a US shard turn red, and a bar under each shard shows its share of new orders.

   Four situations play on that picture: two merchants open their dashboards (the
   shards holding their orders are outlined), new orders arrive (the bars fill), a
   sixth shard joins (the dots that move slide over), and the contract rules (EU data
   in the EU, the largest merchant alone). The placement model is pure; js/sim-player.js
   supplies the controls, captions and scoreboard. */

import { el } from '../../js/dom.js';
import { tx } from '../../js/i18n.js';
import { stat, css, rng } from '../../js/sim-kit.js';
import { player } from '../../js/sim-player.js';

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

export const SETUPS = ['range', 'hash', 'consistent', 'directory'];
export const SITUATIONS = ['dashboard', 'writes', 'grow', 'rules'];
export const FOLLOW = [0, 1];         // the largest store (US) and a large EU store open their dashboards
export const GROW_OK = 0.3;           // at most this share of orders may move when a shard joins
const T = { dashboard: 10, writes: 10, grow: 8, rules: 8 };
const FILL = [1.5, 8];                // writes: the bars fill over this span
const MOVE = [2, 4.5];                // grow: the dots slide over this span

/* Run one situation: the placements, the facts the scoreboard reads, and the captioned
   steps. Pure. */
export function run(setup, situation) {
  const ms = merchants(), ords = orders(ms), n = START.length;
  const at = place(setup, ms, ords, n), info = analyze(at, ms, ords, n);
  const r = { setup, situation, ms, ords, n, at, info, end: T[situation] };

  if (situation === 'dashboard') {
    r.queries = FOLLOW.map((id, i) => ({
      id, t: 1 + i * 4.5,
      shards: [...new Set(at.filter((_, o) => ords[o] === id))].sort((a, b) => a - b),
      orders: ords.filter(m => m === id).length,
    }));
    r.ok = r.queries.every(q => q.shards.length === 1);
  }
  if (situation === 'writes') r.ok = info.hottest <= 2 / n;
  if (situation === 'grow') {
    r.after = place(setup, ms, ords, n + 1);
    r.afterInfo = analyze(r.after, ms, ords, n + 1);
    r.movedShare = moved(setup, ms, ords, n);
    r.ok = r.movedShare <= GROW_OK;
  }
  if (situation === 'rules') r.ok = info.euOutside === 0 && info.neighbours === 0;
  r.steps = story(r);
  r.summary = r.ok ? { en: 'Within the constraints.', vi: 'Đạt các ràng buộc.' } : {
    dashboard: { en: `Broken: one merchant’s dashboard asks all ${n} shards and merges the answers.`, vi: `Hỏng: dashboard của một merchant phải hỏi cả ${n} shard rồi gộp kết quả.` },
    writes: { en: `Broken: one shard takes ${pct(info.hottest)} of new orders, the write limit you were escaping.`, vi: `Hỏng: một shard nhận ${pct(info.hottest)} đơn mới, đúng giới hạn ghi bạn đang muốn thoát.` },
    grow: { en: `Broken: adding one shard moved ${pct(r.movedShare)} of all orders.`, vi: `Hỏng: thêm một shard làm ${pct(r.movedShare)} tổng số đơn phải di chuyển.` },
    rules: { en: `Broken: ${info.euOutside} EU orders sit on US servers, and the largest merchant shares its server with ${info.neighbours} other stores.`, vi: `Hỏng: ${info.euOutside} đơn EU nằm trên server US, và merchant lớn nhất ở chung server với ${info.neighbours} cửa hàng khác.` },
  }[situation];
  return r;
}

export const survives = (setup, situation) => run(setup, situation).ok;

const pct = x => `${Math.round(x * 100)}%`;
const S = i => `#${i + 1}`;

const HOW = {
  range: { en: 'Each shard owns a block of order ids. New orders have the highest ids, so they all land in the last block.', vi: 'Mỗi shard sở hữu một khối mã đơn. Đơn mới có mã lớn nhất, nên tất cả rơi vào khối cuối.' },
  hash: { en: 'Each order goes to hash(order id) mod N. Orders spread evenly, merchants do not stay together.', vi: 'Mỗi đơn đi tới hash(mã đơn) mod N. Đơn được rải đều, nhưng merchant không còn nằm cùng chỗ.' },
  consistent: { en: 'Shards sit on a hash ring. Each merchant, with all its orders, goes to the next shard clockwise from its hash.', vi: 'Các shard nằm trên một vòng hash. Mỗi merchant, cùng mọi đơn của nó, đi tới shard kế tiếp theo chiều kim đồng hồ tính từ giá trị hash.' },
  directory: { en: 'A table says which shard each merchant is on. You fill it by rule: EU merchants on EU shards, the largest merchant on its own.', vi: 'Một bảng ghi mỗi merchant nằm ở shard nào. Bạn điền nó theo quy tắc: merchant EU ở shard EU, merchant lớn nhất ở riêng một shard.' },
};

function story(r) {
  const { setup, situation, n, info } = r;
  const m = [];
  const add = (t, tone, en, vi) => m.push({ t, tone, say: { en, vi } });
  add(0, null, HOW[setup].en, HOW[setup].vi);
  const byOrder = setup === 'range' || setup === 'hash';

  if (situation === 'dashboard') {
    r.queries.forEach((q, i) => {
      const who = i === 0 ? { en: `The largest store (${q.orders} orders)`, vi: `Cửa hàng lớn nhất (${q.orders} đơn)` } : { en: `A large EU store (${q.orders} orders)`, vi: `Một cửa hàng EU lớn (${q.orders} đơn)` };
      add(q.t, null,
        `${who.en} opens its dashboard. Its orders light up. ${setup === 'directory' ? `The router looks it up in the table: shard ${S(q.shards[0])}.` : setup === 'consistent' ? `The router hashes the merchant id onto the ring: shard ${S(q.shards[0])}.` : 'The router knows where order ids live, not merchants.'}`,
        `${who.vi} mở dashboard. Các đơn của nó sáng lên. ${setup === 'directory' ? `Router tra bảng: shard ${S(q.shards[0])}.` : setup === 'consistent' ? `Router hash merchant id lên vòng: shard ${S(q.shards[0])}.` : 'Router biết mã đơn nằm ở đâu, không biết merchant.'}`);
      add(q.t + 2, q.shards.length > 1 ? 'bad' : null,
        q.shards.length > 1 ? `Its orders are on all ${q.shards.length} shards, so the query asks every one of them and merges the answers, waiting for the slowest.` : 'Every order of this merchant is on one shard, which answers alone.',
        q.shards.length > 1 ? `Đơn của nó nằm trên cả ${q.shards.length} shard, nên truy vấn phải hỏi từng shard rồi gộp kết quả, chờ shard chậm nhất.` : 'Mọi đơn của merchant này nằm trên một shard, và shard đó trả lời một mình.');
    });
    if (byOrder) add(9.5, 'bad', `Every merchant query costs ${n} queries, and each shard you add makes it wider, not cheaper.`, `Mỗi truy vấn merchant tốn ${n} truy vấn, và mỗi shard thêm vào làm nó rộng hơn chứ không rẻ hơn.`);
  }

  if (situation === 'writes') {
    add(1, null, 'New orders arrive. Order ids come from one global sequence, so every new order has the highest id so far. The bars show each shard’s share.', 'Đơn mới tới. Mã đơn lấy từ một sequence toàn cục, nên mọi đơn mới đều có mã lớn nhất tính tới lúc đó. Các thanh cho thấy phần của từng shard.');
    const hot = info.fresh.indexOf(Math.max(...info.fresh));
    add(5, r.ok ? null : 'bad',
      setup === 'range' ? `Every new id is past the last range edge, so every new order goes to shard ${S(hot)}. The other shards hold history and take no writes.`
        : setup === 'hash' ? 'The hash scatters new orders evenly over the shards.'
        : `New orders follow their merchant, so a shard is as busy as the merchants on it. The busiest, shard ${S(hot)}, takes ${pct(info.fresh[hot])}.`,
      setup === 'range' ? `Mọi mã mới đều vượt ranh giới khoảng cuối, nên mọi đơn mới đi tới shard ${S(hot)}. Các shard khác giữ lịch sử và không nhận lượt ghi nào.`
        : setup === 'hash' ? 'Hàm hash rải đơn mới đều ra các shard.'
        : `Đơn mới đi theo merchant của nó, nên một shard bận đúng bằng các merchant trên nó. Shard bận nhất, ${S(hot)}, nhận ${pct(info.fresh[hot])}.`);
    add(8.5, r.ok ? null : 'bad', `The busiest shard takes ${pct(info.hottest)} of new orders. With ${n} shards, a fair share is ${pct(1 / n)}.`, `Shard bận nhất nhận ${pct(info.hottest)} đơn mới. Với ${n} shard, phần công bằng là ${pct(1 / n)}.`);
  }

  if (situation === 'grow') {
    add(1, null, `You add a sixth shard. Stores stay open while data moves.`, `Bạn thêm shard thứ sáu. Các cửa hàng vẫn mở trong lúc dữ liệu di chuyển.`);
    add(MOVE[0], r.ok ? null : 'bad', {
      range: 'The range with the most orders is split in two; the new shard takes its upper half.',
      hash: 'mod 5 becomes mod 6, and for most order ids the answer changes. Orders move between old shards too, not only onto the new one.',
      consistent: 'The new shard takes its points on the ring; only the merchants just before those points move to it.',
      directory: 'You choose whole merchants from the busiest US shard and move them, one at a time, until the load is even.',
    }[setup], {
      range: 'Khoảng có nhiều đơn nhất bị chia đôi; shard mới nhận nửa trên của nó.',
      hash: 'mod 5 thành mod 6, và với phần lớn mã đơn kết quả thay đổi. Đơn di chuyển cả giữa các shard cũ, không chỉ sang shard mới.',
      consistent: 'Shard mới nhận các điểm của nó trên vòng; chỉ những merchant nằm ngay trước các điểm đó chuyển sang.',
      directory: 'Bạn chọn những merchant trọn vẹn từ shard US bận nhất và chuyển chúng, từng cái một, cho tới khi tải đều.',
    }[setup]);
    add(MOVE[1] + 0.5, r.ok ? null : 'bad', `${pct(r.movedShare)} of all orders moved.${setup === 'range' ? ' But every new id still lands on the last range.' : ''}`, `${pct(r.movedShare)} tổng số đơn đã di chuyển.${setup === 'range' ? ' Nhưng mọi mã mới vẫn rơi vào khoảng cuối.' : ''}`);
  }

  if (situation === 'rules') {
    add(1, info.euOutside ? 'bad' : null,
      info.euOutside ? `EU merchants’ data must be stored in the EU. ${info.euOutside} EU orders (red) sit on US shards, and nothing can move them: ${byOrder ? 'the order id' : 'the hash'} decides.` : 'EU merchants’ data must be stored in the EU. Every EU merchant was placed on an EU shard by rule: no red dots.',
      info.euOutside ? `Dữ liệu của merchant EU phải nằm ở EU. ${info.euOutside} đơn EU (màu đỏ) nằm trên shard US, và không gì dời được chúng: ${byOrder ? 'mã đơn' : 'hàm hash'} quyết định.` : 'Dữ liệu của merchant EU phải nằm ở EU. Mọi merchant EU đã được đặt vào shard EU theo quy tắc: không có chấm đỏ.');
    add(4.5, info.neighbours ? 'bad' : null,
      info.neighbours ? `The largest merchant (highlighted) pays for a server of its own, but it shares ${byOrder ? 'every shard' : 'its shard'} with ${info.neighbours} other stores.` : 'The largest merchant (highlighted) has shard #5 to itself: the ★ server it pays for.',
      info.neighbours ? `Merchant lớn nhất (được tô sáng) trả tiền cho một server riêng, nhưng nó ở chung ${byOrder ? 'mọi shard' : 'shard của nó'} với ${info.neighbours} cửa hàng khác.` : 'Merchant lớn nhất (được tô sáng) có shard #5 cho riêng mình: server ★ mà nó trả tiền.');
  }
  m.sort((a, b) => a.t - b.t);
  return m.map((x, i) => ({ ...x, t0: x.t, t1: i + 1 < m.length ? m[i + 1].t : r.end }));
}

const LABEL = {
  range: { en: 'Range on order id', vi: 'Range theo mã đơn' },
  hash: { en: 'Hash on order id', vi: 'Hash theo mã đơn' },
  consistent: { en: 'Consistent hashing', vi: 'Consistent hashing' },
  directory: { en: 'Directory', vi: 'Directory' },
};
const SITUATION = {
  dashboard: { en: 'Merchants open dashboards', vi: 'Merchant mở dashboard' },
  writes: { en: 'New orders arrive', vi: 'Đơn mới tới' },
  grow: { en: 'Add a shard', vi: 'Thêm một shard' },
  rules: { en: 'EU data, a dedicated server', vi: 'Dữ liệu EU, server riêng' },
};

export function mount(root, ctx) {
  let cached = null;   // the player asks for each run once; the drawing reads the same result
  const spread = stat(tx({ en: 'Shards one dashboard query hits', vi: 'Số shard một truy vấn dashboard chạm tới' }));
  const hot = stat(tx({ en: 'Busiest shard, share of new orders', vi: 'Shard bận nhất, tỉ lệ đơn mới' }));
  const eu = stat(tx({ en: 'EU orders outside the EU', vi: 'Đơn EU nằm ngoài EU' }));
  const own = stat(tx({ en: 'Largest store shares its server with', vi: 'Cửa hàng lớn nhất ở chung server với' }));
  const key = (c, label) => el('span', { class: 'key-item' }, [el('i', { style: `background:${css(c)}` }), label]);
  return player(root, ctx, {
    situations: SITUATIONS.map(x => ({ value: x, label: tx(SITUATION[x]), icon: { dashboard: 'grid', writes: 'bolt', grow: 'layers', rules: 'building' }[x] })),
    setups: SETUPS.map(x => ({ value: x, label: tx(LABEL[x]), icon: { range: 'flow', hash: 'hash', consistent: 'gauge', directory: 'list' }[x] })),
    open: ['range', 'hash'],
    initial: { situation: 'dashboard' },
    run: (setup, situation) => (cached = run(setup, situation)),
    survives, height: 280,
    duration: st => Math.max(1.4, (st.t1 - st.t0) * 0.9),
    tone: st => st.tone,
    draw: ({ g, w, h, k, p }) => {
      const st = cached.steps[k];
      draw(g, w, h, cached, st ? st.t0 + p * (st.t1 - st.t0) : cached.end);
    },
    onRun: r => {
      const { info, n } = r;
      const sp = Math.max(info.spread(FOLLOW[0]), info.spread(FOLLOW[1]));
      spread.set(`${sp} / ${n}`, sp > 1 ? 'bad' : 'ok');
      hot.set(pct(info.hottest), info.hottest > 2 / n ? 'bad' : info.hottest > 1.4 / n ? 'warn' : 'ok');
      eu.set(String(info.euOutside), info.euOutside ? 'bad' : 'ok');
      own.set(tx({ en: `${info.neighbours} other stores`, vi: `${info.neighbours} cửa hàng khác` }), info.neighbours ? 'warn' : 'ok');
    },
    footer: [
      el('div', { class: 'sim-legend' }, [
        key('warn', tx({ en: 'followed store', vi: 'cửa hàng đang theo dõi' })),
        key('blue', tx({ en: 'EU store, on an EU shard', vi: 'cửa hàng EU, ở shard EU' })),
        key('bad', tx({ en: 'EU store, outside the EU', vi: 'cửa hàng EU, ngoài EU' })),
        key('faint', tx({ en: 'other orders', vi: 'đơn khác' })),
        el('span', { class: 'key-item' }, tx({ en: 'bar: share of new orders · ★ dedicated server', vi: 'thanh: tỉ lệ đơn mới · ★ server riêng' })),
      ]),
      el('div', { class: 'sim-stats' }, [spread.el, hot.el, eu.el, own.el]),
    ],
  });
}

/* ---------------- drawing: the original picture, at time t of a run ---------------- */

const ease = f => (f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2);
const clamp01 = f => Math.max(0, Math.min(1, f));

/* Where each order's dot sits: shards side by side, dots grouped by merchant. */
function layout(at, ords, n, w, h) {
  const gap = 8, top = 34, bottom = 46;
  const cw = (w - gap * (n - 1)) / n;
  const counts = new Array(n).fill(0);
  at.forEach(sh => counts[sh]++);
  const maxCount = Math.max(...counts);
  let step = 7;
  while (step > 3 && Math.ceil(maxCount / Math.max(1, Math.floor((cw - 10) / step))) * step > h - top - bottom - 8) step--;
  const perRow = Math.max(1, Math.floor((cw - 10) / step));
  const idx = new Array(n).fill(0);
  const order = ords.map((m, id) => id).sort((a, b) => at[a] - at[b] || ords[a] - ords[b] || a - b);
  const out = new Array(ords.length);
  for (const id of order) {
    const sh = at[id], k = idx[sh]++;
    out[id] = [sh * (cw + gap) + 5 + step / 2 + (k % perRow) * step, top + 6 + step / 2 + Math.floor(k / perRow) * step];
  }
  return { out, cw, gap, top, bottom, r: Math.max(1.2, step / 2 - 0.8) };
}

/* The picture inside a margin, so it sits in the player's frame like the others. */
function draw(g, fw, fh, r, t) {
  g.clearRect(0, 0, fw, fh);
  g.save();
  g.translate(14, 10);
  picture(g, fw - 28, fh - 16, r, t);
  g.restore();
}

function picture(g, w, h, r, t) {
  const { setup, situation, ms, ords } = r;
  // Adding a shard: the picture switches to six boxes and the dots slide over.
  const grown = situation === 'grow' && t >= MOVE[0];
  const n = grown ? r.n + 1 : r.n;
  const at = grown ? r.after : r.at;
  const info = grown ? r.afterInfo : r.info;
  const L = layout(at, ords, n, w, h), shards = shardsOf(n);
  const from = grown ? layout(r.at, ords, r.n, w, h).out : null;
  const p = grown ? ease(clamp01((t - MOVE[0]) / (MOVE[1] - MOVE[0]))) : 1;

  const focus = situation === 'dashboard' ? r.queries.filter(q => t >= q.t).at(-1) : null;
  const follow = focus ? focus.id : situation === 'rules' && t >= 4.5 ? 0 : null;
  const touched = focus && t >= focus.t + 1 ? new Set(focus.shards) : new Set();
  const fill = situation === 'writes' ? clamp01((t - FILL[0]) / (FILL[1] - FILL[0])) : 1;

  // Shard boxes, labels, and new-order bars.
  for (let i = 0; i < n; i++) {
    const x = i * (L.cw + L.gap), sh = shards[i];
    const fresh = grown && i === r.n;
    g.fillStyle = css('bg2'); g.strokeStyle = css(touched.has(i) ? 'warn' : fresh ? 'ok' : 'line');
    g.lineWidth = touched.has(i) || fresh ? 2 : 1;
    g.beginPath(); g.roundRect(x, L.top, L.cw, h - L.top - L.bottom, 8); g.fill(); g.stroke();
    g.lineWidth = 1;
    g.font = '600 11px "IBM Plex Mono", monospace'; g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillStyle = css('text'); g.fillText(`#${i + 1}`, x + 4, 12);
    g.fillStyle = css(sh.region === 'eu' ? 'blue' : 'muted');
    g.fillText(sh.region.toUpperCase(), x + 30, 12);
    if (sh.dedicated && setup === 'directory') { g.fillStyle = css('warn'); g.fillText('★', x + 54, 12); }
    const fy = h - L.bottom + 10, frac = info.fresh[i] * fill;
    g.fillStyle = css('surface2'); g.fillRect(x, fy, L.cw, 8);
    g.fillStyle = css(frac > 2 / n ? 'bad' : 'ok'); g.fillRect(x, fy, L.cw * Math.min(1, frac), 8);
    g.fillStyle = css('muted'); g.font = '11px "IBM Plex Mono", monospace';
    g.fillText(`${Math.round(frac * 100)}%`, x, fy + 20);
  }

  // The dots, moving from where they were to where they are now.
  for (let id = 0; id < ords.length; id++) {
    const a = from ? from[id] : L.out[id], b = L.out[id];
    const x = a[0] + (b[0] - a[0]) * p, y = a[1] + (b[1] - a[1]) * p;
    const m = ms[ords[id]], sh = shards[at[id]];
    let color = m.eu ? (sh.region === 'eu' ? 'blue' : 'bad') : 'faint';
    if (m.id === follow) color = 'warn';
    g.fillStyle = css(color);
    g.beginPath(); g.arc(x, y, m.id === follow ? L.r + 0.6 : L.r, 0, Math.PI * 2); g.fill();
  }
}
