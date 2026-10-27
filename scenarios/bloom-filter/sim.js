/* How a Bloom filter keeps guesses for short codes away from Postgres.

   Requests for short codes (pills) arrive on the left. Depending on the setup they meet
   a check first (a Bloom filter, an exact set of every code, or a rate limit per IP),
   then the Redis cache, then Postgres. Each pill comes back coloured by what happened:
   green for a redirect, grey for a cheap 404, amber for a 404 that cost a Postgres
   query, red for a real link that was refused.

   The Bloom filter is drawn as its bit array: a toy one of 48 bits and 3 hashes. Adding
   a code sets the 3 bits its hashes point to; checking a code reads the same 3 bits.
   Lines show which bits each code touches, so you can watch the filter answer
   "definitely not" (a 0 among them) or "maybe" (all 1), including the occasional false
   positive whose bits were all set by other codes.

   A strip along the top shows Postgres queries per second against what it can take.
   The model is a small simulation over 24 seconds (run()), drawn at any moment t;
   js/sim-player.js supplies the controls and scoreboard. */

import { tx } from '../../js/i18n.js';
import { css, rng } from '../../js/sim-kit.js';
import { player } from '../../js/sim-player.js';

export const SETUPS = ['today', 'negcache', 'exactset', 'bloom', 'ratelimit'];
export const SITUATIONS = ['normal', 'scan', 'launch', 'memory'];

export const T = 24;                  // seconds in a run
export const M = 48, K = 3;           // the toy filter: 48 bits, 3 hashes
export const CACHE_SLOTS = 8;
export const DB_CAP = 3;              // Postgres queries a second it can take, at the toy's scale
export const NEG_TTL = 10;            // seconds a cached "not found" lives
export const RATE_LIMIT = 5;          // not-found answers an IP may get before it is blocked
export const START = 2.5;             // traffic starts once the filter or the set is built
export const CREATE_AT = 8;           // launch: marketing creates the custom link
export const ALIAS = 'spring';
// Memory each check needs at the real scale: 2 billion codes, 7 bytes each.
export const CODES = 2e9;
export const BUDGET_GB = 4;
export const BLOOM_BITS_PER_CODE = 9.585;   // at a 1% false positive rate (Redis docs)
export const MEMORY_GB = { today: 0, negcache: 0, exactset: (CODES * 7) / 1e9, bloom: +((CODES * BLOOM_BITS_PER_CODE) / 8 / 1e9).toFixed(1), ratelimit: 0 };
const LOAD_TIME = 16;                 // memory situation: seconds to load every code
const HOP = 0.35, DWELL = 0.24, BACK = 0.45, WINDOW = 2;

const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const newCode = r => Array.from({ length: 7 }, () => ALPHA[Math.floor(r() * ALPHA.length)]).join('');

/* The links that exist. The first four are popular. */
export const LINKS = (() => { const r = rng(41); return Array.from({ length: 10 }, () => newCode(r)); })();

/* The K bit positions a code maps to: K FNV-1a hashes, each with its own seed. */
function fnv(s, seed) {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
export const bitsOf = s => Array.from({ length: K }, (_, i) => fnv(s, Math.imul(i + 1, 0x9e3779b1)) % M);

/* Every request of a run. Seeded, so every visit is the same. */
const SEED = { normal: 3, scan: 5, launch: 7, memory: 11 };
function traffic(situation) {
  const r = rng(SEED[situation]), out = [];
  const guess = () => { let c; do c = newCode(r); while (LINKS.includes(c)); return c; };
  const user = () => `198.51.100.${1 + Math.floor(r() * 30)}`;
  for (let t = START; t < T - 1.6; t += 0.3 + r() * 0.14) {
    const u = r();
    const code = u < 0.72 ? LINKS[Math.floor(r() * 4)] : u < 0.93 ? LINKS[4 + Math.floor(r() * 6)] : guess();
    out.push({ t, code, ip: user(), kind: u < 0.93 ? 'real' : 'typo' });
  }
  if (situation === 'scan')
    for (let t = 7; t < 19; t += 0.24 + r() * 0.1) out.push({ t, code: guess(), ip: `203.0.${Math.floor(r() * 256)}.${Math.floor(r() * 256)}`, kind: 'guess' });
  if (situation === 'launch') {
    for (const t of [5.2, 6.1, 7.0]) out.push({ t, code: ALIAS, ip: user(), kind: 'early' });
    for (let t = 9; t < 17; t += 0.5 + r() * 0.2) out.push({ t, code: ALIAS, ip: user(), kind: 'crowd' });
  }
  return out.sort((a, b) => a.t - b.t);
}

/* Where a request is at each stop: it reaches stop i at q.t + i·(HOP+DWELL) + HOP. */
const arriveAt = (q, i) => q.t + i * (HOP + DWELL) + HOP;

/* Run one situation. Returns every request with its stops and outcome, the filter and
   set inserts, the cache over time, Postgres load, and the captioned steps. Pure. */
export function run(setup, situation) {
  const reqs = traffic(situation).map(q => ({ ...q }));
  const keeps = setup === 'bloom' || setup === 'exactset';
  const inserts = keeps ? LINKS.map((code, i) => ({ t: 0.3 + i * 0.2, code })) : [];
  if (keeps && situation === 'launch') inserts.push({ t: CREATE_AT, code: ALIAS, created: true });
  const exists = (c, t) => LINKS.includes(c) || (c === ALIAS && situation === 'launch' && t >= CREATE_AT);

  const filter = new Uint8Array(M), set = new Set();
  let done = 0;
  const catchUp = t => {
    for (; done < inserts.length && inserts[done].t <= t; done++) {
      for (const b of bitsOf(inserts[done].code)) filter[b] = 1;
      set.add(inserts[done].code);
    }
  };

  // The cache: fixed slots, least recently used evicted. Pre-warmed with links people use.
  const slots = Array.from({ length: CACHE_SLOTS }, (_, i) => (i < 6 ? { code: LINKS[i], used: 0 } : null));
  const cacheLog = [{ t: 0, slots: slots.map(s => s && { ...s }) }];
  const live = (s, t) => s && (!s.neg || s.until > t);
  const put = (entry, t) => {
    let i = slots.findIndex(s => s && s.code === entry.code);
    if (i < 0) i = slots.findIndex(s => !live(s, t));
    if (i < 0) i = slots.reduce((m, s, j) => (s.used < slots[m].used ? j : m), 0);
    if (slots[i] && slots[i].code !== entry.code && !slots[i].neg && live(slots[i], t)) evicted.push({ t, code: slots[i].code });
    slots[i] = { ...entry, used: t };
    cacheLog.push({ t, slots: slots.map(s => s && { ...s }) });
    return i;
  };
  const evicted = [];
  const notFound = {};

  for (const q of reqs) {
    catchUp(q.t);
    q.stops = [];
    if (keeps || setup === 'ratelimit') {
      q.stops.push('check');
      if (setup === 'bloom') { q.bits = bitsOf(q.code); q.bitVals = q.bits.map(b => filter[b]); q.pass = q.bitVals.every(Boolean); }
      else if (setup === 'exactset') q.pass = set.has(q.code);
      else { q.count = notFound[q.ip] || 0; q.pass = q.count < RATE_LIMIT; }
    } else q.pass = true;

    if (!q.pass) q.outcome = setup === 'ratelimit' ? 'blocked' : 'rejected';
    else {
      q.stops.push('cache');
      const at = arriveAt(q, q.stops.length - 1);
      const hit = slots.findIndex(s => live(s, at) && s.code === q.code);
      if (hit >= 0) {
        slots[hit].used = at;
        q.slot = hit;
        q.outcome = slots[hit].neg ? 'negcached' : 'ok';
      } else {
        q.stops.push('db');
        q.dbAt = arriveAt(q, q.stops.length - 1);
        if (exists(q.code, q.t)) { q.outcome = 'ok'; q.slot = put({ code: q.code }, q.dbAt + DWELL); }
        else {
          q.outcome = 'notfound';
          notFound[q.ip] = (notFound[q.ip] || 0) + 1;
          if (setup === 'negcache') q.slot = put({ code: q.code, neg: true, until: q.dbAt + NEG_TTL }, q.dbAt + DWELL);
        }
      }
    }
    q.wrong = exists(q.code, q.t) && q.outcome !== 'ok';
    q.fp = setup === 'bloom' && q.pass && !exists(q.code, q.t);
    q.end = q.t + q.stops.length * (HOP + DWELL) + BACK;
  }

  // Postgres queries a second, over a sliding window.
  const dbTimes = reqs.filter(q => q.dbAt != null).map(q => q.dbAt);
  const rateAt = t => dbTimes.filter(x => x > t - WINDOW && x <= t).length / WINDOW;
  const timeline = Array.from({ length: 241 }, (_, i) => rateAt((i / 240) * T));
  const peak = Math.max(...timeline);
  const overAt = timeline.findIndex(v => v > DB_CAP);
  const wrong = reqs.filter(q => q.wrong);
  const guesses = reqs.filter(q => q.kind === 'guess');
  const ok = situation === 'memory' ? MEMORY_GB[setup] <= BUDGET_GB : wrong.length === 0 && peak <= DB_CAP;

  const res = {
    setup, situation, reqs, inserts, cacheLog, evicted, timeline, peak, ok,
    overAt: overAt < 0 ? null : (overAt / 240) * T,
    wrong: wrong.length,
    dbQueries: dbTimes.length,
    guessesToDb: guesses.filter(q => q.dbAt != null).length,
    guesses: guesses.length,
    fps: reqs.filter(q => q.fp).length,
    overflowAt: situation === 'memory' && MEMORY_GB[setup] > BUDGET_GB ? START + LOAD_TIME * (BUDGET_GB / MEMORY_GB[setup]) : null,
  };
  res.steps = story(res);
  res.summary = ok
    ? { en: 'Within the constraints.', vi: 'Đạt các ràng buộc.' }
    : situation === 'memory' ? { en: `Broken: the set needs ${MEMORY_GB[setup]} GB for 2 billion codes, and you have ${BUDGET_GB} GB.`, vi: `Hỏng: set cần ${MEMORY_GB[setup]} GB cho 2 tỷ mã, còn bạn có ${BUDGET_GB} GB.` }
    : wrong.length ? { en: `Broken: a real link answered 404 ${wrong.length} times.`, vi: `Hỏng: một link có thật trả về 404 ${wrong.length} lần.` }
    : { en: `Broken: Postgres peaked at ${peak.toFixed(1)} queries a second; it can take ${DB_CAP}.`, vi: `Hỏng: Postgres đạt đỉnh ${peak.toFixed(1)} truy vấn mỗi giây; nó chỉ chịu được ${DB_CAP}.` };
  return res;
}

export const survives = (setup, situation) => run(setup, situation).ok;

/* The captioned moments of a run, as player steps: { t0, t1, tone, say }. */
function story(r) {
  const { setup, situation, reqs } = r;
  const m = [];
  const add = (t, tone, en, vi) => { if (t != null && t <= T) m.push({ t, tone, say: { en, vi } }); };
  const intro = {
    today: ['Every request asks Redis for the code, and on a miss, Postgres. A code that does not exist is never cached, so every request for one reaches Postgres.', 'Mọi request hỏi Redis về mã, và nếu miss thì hỏi Postgres. Một mã không tồn tại thì không bao giờ được cache, nên mọi request cho nó đều tới Postgres.'],
    negcache: ['Every request asks Redis, then Postgres. When Postgres has no row, Redis stores “not found” for that code for 10 seconds here (10 minutes in production).', 'Mọi request hỏi Redis, rồi Postgres. Khi Postgres không có dòng nào, Redis lưu “không tìm thấy” cho mã đó trong 10 giây ở đây (10 phút trên production).'],
    exactset: ['Every existing code is loaded into a Redis set. A request first asks the set: not a member means 404, without the cache or Postgres.', 'Mọi mã đang có được nạp vào một Redis set. Request hỏi set trước: không phải thành viên nghĩa là 404, không cần cache hay Postgres.'],
    bloom: ['Building the Bloom filter: each existing code is hashed 3 times, and the 3 bits it points to are set to 1. Codes share bits; the filter never stores the codes themselves.', 'Xây Bloom filter: mỗi mã đang có được hash 3 lần, và 3 bit mà nó trỏ tới được đặt thành 1. Các mã dùng chung bit; filter không bao giờ lưu chính các mã.'],
    ratelimit: ['Each IP may get 5 “not found” answers; after that its requests are refused before they reach the cache.', 'Mỗi IP được nhận 5 câu trả lời “không tìm thấy”; sau đó request của nó bị từ chối trước khi tới cache.'],
  }[setup];
  add(0, null, ...intro);

  if (setup === 'bloom') {
    add(START, null, 'Each request is hashed the same way and its 3 bits are read. If any is 0, the code was never added: a certain “no”. If all are 1, it is maybe there, and the cache and Postgres confirm it.', 'Mỗi request được hash cùng cách và 3 bit của nó được đọc. Nếu có bit nào là 0, mã chưa từng được thêm: một câu “không” chắc chắn. Nếu cả 3 là 1, có thể nó tồn tại, và cache cùng Postgres xác nhận.');
    const no = reqs.find(q => !q.pass);
    if (no) add(no.t + HOP, null, `${no.code}: one of its bits is 0, so it was never added. 404 at once, without Redis or Postgres.`, `${no.code}: một trong các bit của nó là 0, nên nó chưa từng được thêm. Trả 404 ngay, không cần Redis hay Postgres.`);
    const fp = reqs.find(q => q.fp);
    if (fp) add(fp.t + HOP, 'warn', `${fp.code} was never created, but other codes happened to set all 3 of its bits: a false positive. It costs one wasted Postgres lookup, nothing worse.`, `${fp.code} chưa từng được tạo, nhưng các mã khác tình cờ đã đặt cả 3 bit của nó: một false positive. Nó chỉ tốn một lần tra Postgres thừa, không tệ hơn.`);
  }
  if (setup === 'exactset') add(START, null, 'The set answers exactly: real codes pass, everything else gets 404. But it holds every code itself.', 'Set trả lời chính xác: mã thật đi tiếp, mọi thứ khác nhận 404. Nhưng nó giữ chính từng mã.');

  if (situation === 'scan') {
    add(7, null, 'Scanners start guessing codes, from hundreds of IP addresses, a guess or two each. Almost no guess exists, and none is asked twice.', 'Các scanner bắt đầu đoán mã, từ hàng trăm địa chỉ IP, mỗi IP một hai lần. Gần như không lần đoán nào tồn tại, và không mã nào bị hỏi hai lần.');
    if (setup === 'negcache') {
      const ev = r.evicted.find(e => e.t > 7);
      if (ev) add(ev.t, 'warn', `Each guess is cached as “not found”, and is never asked again. The entries push real links out of the cache: ${ev.code} was just evicted.`, `Mỗi lần đoán được cache là “không tìm thấy”, và không bao giờ được hỏi lại. Các entry này đẩy link thật ra khỏi cache: ${ev.code} vừa bị loại.`);
    }
    if (setup === 'ratelimit') add(9, null, 'No scanner IP sends more than a guess or two, so none comes near the limit. Every guess still reaches Postgres.', 'Không IP scanner nào gửi quá một hai lần đoán, nên không IP nào chạm tới giới hạn. Mọi lần đoán vẫn tới Postgres.');
    if (r.overAt != null) add(r.overAt, 'bad', 'Postgres is over capacity, busy answering “no such row” for codes nobody created.', 'Postgres quá tải, bận trả lời “không có dòng nào” cho những mã chẳng ai tạo.');
    if (setup === 'bloom') add(19.5, null, `Of ${r.guesses} guesses, ${r.guessesToDb} slipped through as false positives. This toy filter is tiny, so that is about 1 in ${Math.round(r.guesses / Math.max(1, r.guessesToDb))}; the production one, sized at 1%, lets through 1 in 100.`, `Trong ${r.guesses} lần đoán, ${r.guessesToDb} lần lọt qua do false positive. Filter thu nhỏ này rất bé, nên tỉ lệ khoảng 1 trên ${Math.round(r.guesses / Math.max(1, r.guessesToDb))}; bản production, chọn kích thước ở mức 1%, chỉ để lọt 1 trên 100.`);
    else add(19.5, r.guessesToDb > r.guesses * 0.2 ? 'bad' : null, `Of ${r.guesses} guesses, ${r.guessesToDb} reached Postgres.`, `Trong ${r.guesses} lần đoán, ${r.guessesToDb} lần tới Postgres.`);
  }
  if (situation === 'launch') {
    add(5.2, null, `People try the custom link /${ALIAS} before marketing has created it. 404 is the right answer, for now.`, `Mọi người thử link tuỳ chỉnh /${ALIAS} trước khi marketing tạo nó. 404 là câu trả lời đúng, vào lúc này.`);
    add(CREATE_AT, null,
      setup === 'bloom' ? `Marketing creates /${ALIAS}. Before the create call returns, the code is added to the filter: its 3 bits are set.` : setup === 'exactset' ? `Marketing creates /${ALIAS}. Before the create call returns, the code is added to the set.` : `Marketing creates /${ALIAS} and announces it.`,
      setup === 'bloom' ? `Marketing tạo /${ALIAS}. Trước khi lệnh tạo trả về, mã được thêm vào filter: 3 bit của nó được đặt.` : setup === 'exactset' ? `Marketing tạo /${ALIAS}. Trước khi lệnh tạo trả về, mã được thêm vào set.` : `Marketing tạo /${ALIAS} và công bố nó.`);
    const bad = reqs.find(q => q.wrong);
    if (bad) add(bad.t + HOP, 'bad', `The link exists, but Redis still holds the “not found” cached before it was created. /${ALIAS} answers 404 to the crowd until the entry expires.`, `Link đã tồn tại, nhưng Redis vẫn giữ “không tìm thấy” được cache trước khi nó được tạo. /${ALIAS} trả 404 cho đám đông cho tới khi entry hết hạn.`);
    else add(9, null, `The crowd arrives and /${ALIAS} redirects from the first request.`, `Đám đông tới và /${ALIAS} chuyển hướng ngay từ request đầu tiên.`);
  }
  if (situation === 'memory') {
    const gb = MEMORY_GB[setup];
    add(START, null,
      gb ? `In production the check must hold all 2 billion codes. Loading them: ${setup === 'bloom' ? `about ${BLOOM_BITS_PER_CODE} bits a code at a 1% false positive rate, ${gb} GB in all` : `7 bytes a code before Redis’s own per-entry overhead, ${gb} GB in all`}. You have ${BUDGET_GB} GB.` : 'This setup keeps nothing extra per code, so memory is not its problem.',
      gb ? `Trên production, phần kiểm tra phải chứa đủ 2 tỷ mã. Đang nạp: ${setup === 'bloom' ? `khoảng ${BLOOM_BITS_PER_CODE} bit mỗi mã ở tỉ lệ false positive 1%, tổng ${gb} GB` : `7 byte mỗi mã chưa tính overhead của Redis cho mỗi entry, tổng ${gb} GB`}. Bạn có ${BUDGET_GB} GB.` : 'Cách này không giữ thêm gì cho mỗi mã, nên bộ nhớ không phải vấn đề của nó.');
    if (r.overflowAt) add(r.overflowAt, 'bad', `Out of memory at about ${Math.round((CODES * BUDGET_GB) / MEMORY_GB[setup] / 1e6)} million codes, less than a third of the way.`, `Hết bộ nhớ ở khoảng ${Math.round((CODES * BUDGET_GB) / MEMORY_GB[setup] / 1e6)} triệu mã, chưa tới một phần ba chặng đường.`);
    else if (MEMORY_GB[setup]) add(START + LOAD_TIME, null, `All 2 billion codes loaded in ${MEMORY_GB[setup]} GB.`, `Đã nạp đủ 2 tỷ mã trong ${MEMORY_GB[setup]} GB.`);
  }
  m.sort((a, b) => a.t - b.t);
  return m.map((x, i) => ({ ...x, t0: x.t, t1: i + 1 < m.length ? m[i + 1].t : T }));
}

const LABEL = {
  today: { en: 'Today: cache, then Postgres', vi: 'Hiện tại: cache, rồi Postgres' },
  negcache: { en: 'Cache “not found” too', vi: 'Cache cả “không tìm thấy”' },
  exactset: { en: 'Exact set of every code', vi: 'Set chính xác mọi mã' },
  bloom: { en: 'Bloom filter', vi: 'Bloom filter' },
  ratelimit: { en: 'Rate limit per IP', vi: 'Rate limit theo IP' },
};
const SITUATION = {
  normal: { en: 'Normal traffic', vi: 'Traffic bình thường' },
  scan: { en: 'Scanners guess codes', vi: 'Scanner đoán mã' },
  launch: { en: 'A new custom link', vi: 'Một link tuỳ chỉnh mới' },
  memory: { en: 'All 2 billion links', vi: 'Đủ 2 tỷ link' },
};

export function mount(root, ctx) {
  let cached = null;   // the player asks for each run once; the drawing reads the same result
  return player(root, ctx, {
    situations: SITUATIONS.map(x => ({ value: x, label: tx(SITUATION[x]), icon: { normal: 'sun', scan: 'hash', launch: 'tag', memory: 'memory' }[x] })),
    setups: SETUPS.map(x => ({ value: x, label: tx(LABEL[x]), icon: { today: 'server', negcache: 'inbox', exactset: 'list', bloom: 'grid', ratelimit: 'gauge' }[x] })),
    initial: { situation: 'scan' },
    run: (setup, situation) => (cached = run(setup, situation)),
    survives, height: 500,
    duration: st => Math.max(0.8, (st.t1 - st.t0) * 1.4),
    tone: st => st.tone,
    draw: ({ g, w, h, k, p }) => {
      const st = cached.steps[k];
      draw(g, w, h, cached, st ? st.t0 + p * (st.t1 - st.t0) : T);
    },
  });
}

/* ---------------- drawing ---------------- */

const OUTCOME_COLOR = { ok: 'ok', rejected: 'muted', negcached: 'muted', notfound: 'warn', blocked: 'violet' };
const mono = (px, wt = 600) => `${wt} ${px}px "IBM Plex Mono", monospace`;

function draw(g, w, h, r, t) {
  const { setup, situation } = r;
  g.clearRect(0, 0, w, h);
  g.textBaseline = 'middle';
  const text = (s, x, y, color = 'muted', font = mono(10, 400), align = 'left', max) => {
    g.font = font; g.textAlign = align; g.fillStyle = css(color); g.fillText(s, x, y, max);
  };
  const box = (x, y, bw, bh, rad, fill, stroke) => {
    g.beginPath(); g.roundRect(x, y, bw, bh, rad);
    if (fill) { g.fillStyle = css(fill); g.fill(); }
    if (stroke) { g.strokeStyle = css(stroke); g.stroke(); }
  };

  // ---- The strip: Postgres queries a second over the run. ----
  const sx0 = 170, sx1 = w - 14, sy0 = 14, sy1 = 64;
  const X = tt => sx0 + (tt / T) * (sx1 - sx0);
  const yMax = DB_CAP * 2.2;
  const Y = v => sy1 - (Math.min(v, yMax) / yMax) * (sy1 - sy0);
  text(tx({ en: 'POSTGRES', vi: 'POSTGRES' }), 10, 26, 'blue', mono(10, 700));
  text(tx({ en: 'QUERIES / SECOND', vi: 'TRUY VẤN / GIÂY' }), 10, 40, 'muted', mono(10, 700));
  box(sx0, sy0, sx1 - sx0, sy1 - sy0, 6, 'bg2');
  const upto = Math.min(T, t);
  const area = () => {
    g.beginPath(); g.moveTo(X(0), sy1);
    r.timeline.forEach((v, i) => { const tt = (i / 240) * T; if (tt <= upto) g.lineTo(X(tt), Y(v)); });
    g.lineTo(X(upto), sy1); g.closePath();
  };
  for (const [c, y0, y1] of [['blue', Y(DB_CAP), sy1], ['bad', sy0, Y(DB_CAP)]]) {
    g.save(); g.beginPath(); g.rect(sx0, y0, sx1 - sx0, y1 - y0); g.clip();
    area(); g.fillStyle = css(c); g.globalAlpha = 0.7; g.fill(); g.restore();
  }
  g.strokeStyle = css('warn'); g.setLineDash([4, 4]); g.beginPath(); g.moveTo(sx0, Y(DB_CAP)); g.lineTo(sx1, Y(DB_CAP)); g.stroke(); g.setLineDash([]);
  text(tx({ en: `capacity ${DB_CAP}/s`, vi: `sức chịu ${DB_CAP}/s` }), sx0 + 6, Y(DB_CAP) - 7, 'warn', mono(9, 700));
  g.strokeStyle = css('text'); g.globalAlpha = 0.7; g.beginPath(); g.moveTo(X(t), sy0 - 4); g.lineTo(X(t), sy1 + 4); g.stroke(); g.globalAlpha = 1;
  const now = r.timeline[Math.min(240, Math.round((upto / T) * 240))];
  const nearEnd = X(t) > sx1 - 50;
  text(`${now.toFixed(1)}/s`, X(t) + (nearEnd ? -4 : 4), sy1 - 8, now > DB_CAP ? 'bad' : 'blue', mono(11, 700), nearEnd ? 'right' : 'left');

  // ---- Layout below the strip. ----
  const top = 92, bottom = h - 40;
  const srcX = 14, cx0 = 128, cx1 = w * 0.56, kx0 = w * 0.62, kx1 = w * 0.79, dx0 = w * 0.84, dx1 = w - 14;
  const midY = (top + bottom) / 2;
  text(tx({ en: 'REQUESTS', vi: 'REQUEST' }), srcX, top - 12, 'muted', mono(10, 700));
  const LANES = 14;
  const laneY = i => top + 8 + (((i * 5) % LANES) + 0.5) * ((bottom - top - 16) / LANES);

  // ---- The check: a Bloom filter, an exact set, a rate limit, or nothing. ----
  box(cx0, top, cx1 - cx0, bottom - top, 12, 'surface2', 'line');
  const keeps = setup === 'bloom' || setup === 'exactset';
  const added = r.inserts.filter(x => x.t <= t);
  const cols = 16, cell = Math.min(28, (cx1 - cx0 - 40) / cols), gx0 = cx0 + (cx1 - cx0 - cols * cell) / 2, gy0 = top + 96;
  let checkPt = [cx0 + 40, midY];
  let overlay = null;   // the Bloom filter's grid, drawn over the requests in flight
  const atCheck = r.reqs.filter(q => q.stops[0] === 'check' && t >= arriveAt(q, 0) && t < arriveAt(q, 0) + DWELL);
  const cur = atCheck[atCheck.length - 1];

  if (setup === 'bloom') {
    text(tx({ en: `BLOOM FILTER · ${M} bits · ${K} hashes (a toy; production: ~19 billion bits, 7 hashes)`, vi: `BLOOM FILTER · ${M} bit · ${K} hash (bản thu nhỏ; production: ~19 tỷ bit, 7 hash)` }), cx0 + 12, top + 18, 'cat-queue', mono(9.5, 700), 'left', cx1 - cx0 - 24);
    checkPt = [(cx0 + cx1) / 2, top + 50];
    overlay = () => {
      const on = new Uint8Array(M);
      for (const x of added) for (const b of bitsOf(x.code)) on[b] = 1;
      const cellXY = b => [gx0 + (b % cols) * cell, gy0 + Math.floor(b / cols) * cell];
      // An insert in progress: the code's lines to its bits, which flash as they are set.
      const adding = r.inserts.filter(x => t >= x.t && t < x.t + (x.created ? 1.2 : 0.35));
      const lit = new Map();
      for (const x of adding) for (const b of bitsOf(x.code)) lit.set(b, 'cat-queue');
      if (cur) cur.bits.forEach((b, i) => lit.set(b, cur.bitVals[i] ? 'ok' : 'bad'));
      const lines = (from, list, color) => {
        g.strokeStyle = css(color); g.globalAlpha = 0.85; g.lineWidth = 1.5;
        for (const b of list) { const [x, y] = cellXY(b); g.beginPath(); g.moveTo(from[0], from[1] + 7); g.lineTo(x + cell / 2, y + cell / 2); g.stroke(); }
        g.globalAlpha = 1; g.lineWidth = 1;
      };
      for (const x of adding) lines(checkPt, bitsOf(x.code), 'cat-queue');
      if (cur) cur.bits.forEach((b, i) => lines(checkPt, [b], cur.bitVals[i] ? 'ok' : 'bad'));
      box(gx0 - 4, gy0 - 4, cols * cell + 8, 3 * cell + 8, 6, 'surface2');
      for (let b = 0; b < M; b++) {
        const [x, y] = cellXY(b);
        box(x + 1, y + 1, cell - 2, cell - 2, 3, on[b] ? null : 'bg2');
        if (on[b]) { g.fillStyle = css('cat-queue'); g.globalAlpha = 0.45; g.beginPath(); g.roundRect(x + 1, y + 1, cell - 2, cell - 2, 3); g.fill(); g.globalAlpha = 1; }
        if (lit.has(b)) { g.lineWidth = 2; g.strokeStyle = css(lit.get(b)); g.beginPath(); g.roundRect(x + 1, y + 1, cell - 2, cell - 2, 3); g.stroke(); g.lineWidth = 1; }
        text(on[b] ? '1' : '0', x + cell / 2, y + cell / 2, on[b] ? 'text' : 'faint', mono(Math.min(11, cell * 0.45), on[b] ? 700 : 400), 'center');
      }
      for (const x of adding) pill(g, checkPt, x.code, 'cat-queue', 'bg');
      // Bit numbers above the grid, so the verdict's "bit 17" can be found.
      for (let c = 0; c < cols; c += 4) text(String(c), gx0 + c * cell + 2, gy0 - 10, 'faint', mono(8, 400));
      // The verdict for what is being checked or added right now.
      const vy = gy0 + 3 * cell + 22;
      const sayLine = (s, c, y = vy) => text(s, cx0 + 12, y, c, mono(10.5, 700), 'left', cx1 - cx0 - 24);
      if (adding.length) {
        const x = adding[adding.length - 1];
        sayLine(tx({ en: `add ${x.code}: set bits ${bitsOf(x.code).join(', ')} to 1`, vi: `thêm ${x.code}: đặt bit ${bitsOf(x.code).join(', ')} thành 1` }), 'cat-queue');
      } else if (cur) {
        const zero = cur.bits.find((b, i) => !cur.bitVals[i]);
        sayLine(tx({ en: `check ${cur.code}: bits ${cur.bits.join(', ')}`, vi: `kiểm tra ${cur.code}: bit ${cur.bits.join(', ')}` }), 'text');
        if (zero != null) sayLine(tx({ en: `bit ${zero} is 0 → definitely not → 404`, vi: `bit ${zero} là 0 → chắc chắn không → 404` }), 'muted', vy + 18);
        else sayLine(tx({ en: cur.fp ? 'all 1 → maybe → Postgres (a false positive)' : 'all 1 → maybe → ask the cache', vi: cur.fp ? 'đều là 1 → có thể → Postgres (false positive)' : 'đều là 1 → có thể → hỏi cache' }), cur.fp ? 'warn' : 'ok', vy + 18);
      }
      const ones = on.reduce((a, b) => a + b, 0);
      text(tx({ en: `${ones} of ${M} bits set · ${added.length} codes added`, vi: `${ones} / ${M} bit đã đặt · đã thêm ${added.length} mã` }), cx0 + 12, vy + 42, 'faint', mono(9.5, 400), 'left', cx1 - cx0 - 24);
    };
  } else if (setup === 'exactset') {
    text(tx({ en: 'REDIS SET · every code, stored exactly', vi: 'REDIS SET · mọi mã, lưu chính xác' }), cx0 + 12, top + 18, 'cat-queue', mono(9.5, 700), 'left', cx1 - cx0 - 24);
    const per = 3, cw = (cx1 - cx0 - 24) / per;
    added.forEach((x, i) => {
      const px = cx0 + 12 + (i % per) * cw, py = top + 40 + Math.floor(i / per) * 26;
      const hitMe = cur && cur.code === x.code;
      box(px, py, cw - 8, 20, 5, 'bg2', hitMe ? 'ok' : x.created && t < x.t + 1.2 ? 'cat-queue' : 'line');
      text(x.code, px + (cw - 8) / 2, py + 10, hitMe ? 'ok' : 'text', mono(10, 600), 'center');
    });
    checkPt = [cx0 + 40, top + 40 + Math.ceil(added.length / per) * 26 + 24];
    if (cur) text(tx(cur.pass ? { en: `${cur.code} is in the set → ask the cache`, vi: `${cur.code} có trong set → hỏi cache` } : { en: `${cur.code} is not in the set → 404`, vi: `${cur.code} không có trong set → 404` }), cx0 + 92, checkPt[1], cur.pass ? 'ok' : 'muted', mono(10.5, 700), 'left', cx1 - cx0 - 104);
  } else if (setup === 'ratelimit') {
    text(tx({ en: `RATE LIMIT · ${RATE_LIMIT} “not found” per IP`, vi: `RATE LIMIT · ${RATE_LIMIT} “không tìm thấy” mỗi IP` }), cx0 + 12, top + 18, 'violet', mono(9.5, 700), 'left', cx1 - cx0 - 24);
    const seen = r.reqs.filter(q => q.stops[0] === 'check' && arriveAt(q, 0) <= t);
    const recent = [...new Map(seen.map(q => [q.ip, q])).values()].slice(-8);
    recent.forEach((q, i) => {
      const y = top + 46 + i * 22;
      const n = r.reqs.filter(x => x.ip === q.ip && x.outcome === 'notfound' && x.dbAt != null && x.dbAt <= t).length;
      text(q.ip, cx0 + 92, y, q === cur ? 'text' : 'muted', mono(10, 600));
      const bx = cx0 + 92 + 130, bw = Math.max(40, cx1 - bx - 60);
      box(bx, y - 4, bw, 8, 3, 'bg2');
      box(bx, y - 4, (bw * Math.min(n, RATE_LIMIT)) / RATE_LIMIT, 8, 3, n >= RATE_LIMIT ? 'violet' : 'muted');
      text(`${n}/${RATE_LIMIT}`, bx + bw + 8, y, 'faint', mono(9.5, 400));
    });
    const ips = new Set(seen.map(q => q.ip)).size;
    text(tx({ en: `${ips} IPs seen · ${seen.filter(q => !q.pass).length} requests blocked`, vi: `đã thấy ${ips} IP · chặn ${seen.filter(q => !q.pass).length} request` }), cx0 + 12, top + 46 + 8 * 22 + 10, 'faint', mono(9.5, 400), 'left', cx1 - cx0 - 24);
  } else {
    text(tx({ en: 'NO CHECK', vi: 'KHÔNG KIỂM TRA' }), cx0 + 12, top + 18, 'muted', mono(9.5, 700));
    text(tx({ en: 'every request goes on to the cache', vi: 'mọi request đi tiếp tới cache' }), (cx0 + cx1) / 2, midY, 'faint', mono(10.5, 400), 'center', cx1 - cx0 - 24);
  }

  // Memory this check needs at the real scale.
  const gb = MEMORY_GB[setup];
  const my = bottom - 22, mx0 = cx0 + 12, mx1 = cx1 - 12, scale = 16;
  const loaded = situation === 'memory' ? Math.max(0, Math.min(1, (t - START) / LOAD_TIME)) : 1;
  const used = gb * loaded;
  text(gb ? tx({ en: `memory at 2 billion codes: ${used.toFixed(1)} GB · budget ${BUDGET_GB} GB`, vi: `bộ nhớ với 2 tỷ mã: ${used.toFixed(1)} GB · ngân sách ${BUDGET_GB} GB` }) : tx({ en: 'memory: nothing extra per code', vi: 'bộ nhớ: không thêm gì cho mỗi mã' }), mx0, my - 13, used > BUDGET_GB ? 'bad' : 'muted', mono(9.5, 600), 'left', mx1 - mx0);
  box(mx0, my - 4, mx1 - mx0, 9, 3, 'bg2');
  if (used) box(mx0, my - 4, Math.min(1, used / scale) * (mx1 - mx0), 9, 3, used > BUDGET_GB ? 'bad' : 'cat-queue');
  const bxBudget = mx0 + (BUDGET_GB / scale) * (mx1 - mx0);
  g.strokeStyle = css('warn'); g.lineWidth = 2; g.beginPath(); g.moveTo(bxBudget, my - 8); g.lineTo(bxBudget, my + 9); g.stroke(); g.lineWidth = 1;

  // ---- The cache. ----
  box(kx0, top, kx1 - kx0, bottom - top, 12, 'surface2', 'line');
  text(tx({ en: 'REDIS CACHE', vi: 'REDIS CACHE' }), (kx0 + kx1) / 2, top + 18, 'muted', mono(10, 700), 'center');
  const snap = r.cacheLog.filter(x => x.t <= t).at(-1).slots;
  const slotH = Math.min(30, (bottom - top - 50) / CACHE_SLOTS);
  const slotY = i => top + 40 + (i + 0.5) * slotH;
  const atCache = r.reqs.filter(q => { const i = q.stops.indexOf('cache'); return i >= 0 && t >= arriveAt(q, i) && t < arriveAt(q, i) + DWELL; });
  snap.forEach((s, i) => {
    const y = slotY(i), alive = s && (!s.neg || s.until > t);
    const hot = atCache.some(q => q.slot === i && q.outcome !== 'notfound');
    box(kx0 + 10, y - slotH / 2 + 2, kx1 - kx0 - 20, slotH - 4, 5, 'bg2', hot ? 'ok' : null);
    if (alive) text(s.neg ? `∅ ${s.code}` : s.code, kx0 + 20, y, s.neg ? 'faint' : 'text', mono(10, s.neg ? 400 : 600), 'left', kx1 - kx0 - 34);
  });
  const negs = snap.filter(s => s && s.neg && s.until > t).length;
  if (setup === 'negcache') text(tx({ en: `${negs} “not found” entries`, vi: `${negs} entry “không tìm thấy”` }), (kx0 + kx1) / 2, bottom - 14, negs > 3 ? 'warn' : 'faint', mono(9.5, 600), 'center', kx1 - kx0 - 10);

  // ---- Postgres. ----
  box(dx0, top, dx1 - dx0, bottom - top, 12, 'surface2', now > DB_CAP ? 'bad' : 'line');
  text('POSTGRES', (dx0 + dx1) / 2, top + 18, 'blue', mono(10, 700), 'center');
  text(tx({ en: '2B links', vi: '2 tỷ link' }), (dx0 + dx1) / 2, top + 34, 'faint', mono(9.5, 400), 'center');
  const lh = bottom - top - 90, lx = (dx0 + dx1) / 2 - 9;
  box(lx, top + 50, 18, lh, 4, 'bg2');
  const lf = Math.min(1, now / yMax);
  box(lx, top + 50 + lh * (1 - lf), 18, lh * lf, 4, now > DB_CAP ? 'bad' : 'blue');
  const capY = top + 50 + lh * (1 - DB_CAP / yMax);
  g.strokeStyle = css('warn'); g.setLineDash([3, 3]); g.beginPath(); g.moveTo(lx - 6, capY); g.lineTo(lx + 24, capY); g.stroke(); g.setLineDash([]);
  text(`${now.toFixed(1)}/s`, (dx0 + dx1) / 2, bottom - 18, now > DB_CAP ? 'bad' : 'blue', mono(11, 700), 'center');

  // ---- Requests in flight. ----
  const pt = (q, stop) => stop === 'check' ? checkPt
    : stop === 'cache' ? [kx0 - 30, q.slot != null && q.dbAt == null ? slotY(q.slot) : midY]
    : [dx0 - 30, midY + 30];
  r.reqs.forEach((q, i) => {
    if (t < q.t || t > q.end) return;
    const src = [srcX + 30, laneY(i)];
    const pts = [src, ...q.stops.map(s => pt(q, s))];
    let s = t - q.t, p = null, decided = false;
    for (let j = 0; j < q.stops.length && !p; j++) {
      if (s < HOP) p = lerp(pts[j], pts[j + 1], s / HOP);
      else if (s < HOP + DWELL) { p = pts[j + 1]; decided = j === q.stops.length - 1 && s > HOP + DWELL * 0.5; }
      else s -= HOP + DWELL;
    }
    if (!p) { p = lerp(pts.at(-1), src, Math.min(1, s / BACK)); decided = true; }
    const color = q.wrong ? 'bad' : OUTCOME_COLOR[q.outcome];
    if (decided) pill(g, p, q.code, color, 'bg');
    else pill(g, p, q.code, null, q.kind === 'guess' ? 'muted' : 'text');
  });

  if (overlay) overlay();

  // ---- Footer. ----
  const seen = r.reqs.filter(q => q.end <= t);
  const fy = h - 16;
  const n = f => seen.filter(f).length;
  text(tx({ en: `redirected ${n(q => q.outcome === 'ok')} · cheap 404 ${n(q => ['rejected', 'negcached', 'blocked'].includes(q.outcome))} · 404 from Postgres ${n(q => q.outcome === 'notfound')}`, vi: `chuyển hướng ${n(q => q.outcome === 'ok')} · 404 rẻ ${n(q => ['rejected', 'negcached', 'blocked'].includes(q.outcome))} · 404 từ Postgres ${n(q => q.outcome === 'notfound')}` }), 10, fy, 'muted', mono(10.5, 600), 'left', w * 0.5);
  const wrongNow = n(q => q.wrong);
  if (wrongNow) text(tx({ en: `real link refused: ${wrongNow}`, vi: `link thật bị từ chối: ${wrongNow}` }), w * 0.52, fy, 'bad', mono(10.5, 700));
  const legend = [['ok', tx({ en: 'redirect', vi: 'chuyển hướng' })], ['muted', tx({ en: 'cheap 404', vi: '404 rẻ' })], ['warn', tx({ en: 'Postgres 404', vi: '404 từ Postgres' })], ['bad', tx({ en: 'real link refused', vi: 'link thật bị từ chối' })]];
  let lx2 = w - 14;
  for (const [c, label] of legend.reverse()) {
    g.font = '11px "Hanken Grotesk", sans-serif';
    lx2 -= g.measureText(label).width; text(label, lx2, fy, 'muted', '11px "Hanken Grotesk", sans-serif');
    lx2 -= 14; g.fillStyle = css(c); g.beginPath(); g.roundRect(lx2, fy - 4, 8, 8, 2); g.fill();
    lx2 -= 12;
  }
}

const lerp = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];

/* A request: its code in a small rounded box centred on p. */
function pill(g, p, code, fill, ink) {
  const pw = 58, ph = 15;
  g.beginPath(); g.roundRect(p[0] - pw / 2, p[1] - ph / 2, pw, ph, 4);
  g.fillStyle = css(fill || 'surface'); g.fill();
  if (!fill) { g.strokeStyle = css('line'); g.stroke(); }
  g.font = mono(9, 600); g.textAlign = 'center'; g.fillStyle = css(ink); g.fillText(code, p[0], p[1] + 0.5, pw - 6);
}
