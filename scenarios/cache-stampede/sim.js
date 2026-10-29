/* One hot cache key, the moment it expires, and five ways to live through it.

   Readers on the left send home-page requests to 40 API pods (the grid). Each pod
   reads the feed from Redis, drawn as a key card whose ring counts down its TTL. When
   the key is missing, what the pods do is the setup: every request queries Postgres
   (today), one takes a lock and the rest wait (A), requests sometimes refresh early on
   a weighted coin flip (B), each pod sends one query and shares it (C), or a worker
   refreshes the key on a schedule so it never expires (D).

   Postgres, on the right, shows the feed queries running at once: each one is a bar
   that fills as it progresses, and they slow each other down as they share the CPU.
   A strip along the top plots the page's p99, second by second, and the number of feed
   queries running. A checklist along the bottom ticks the constraints live.

   The model (run()) steps every 10 ms; the rates and costs come from the scenario.
   js/sim-player.js supplies the controls and scoreboard. */

import { tx } from '../../js/i18n.js';
import { css, rng } from '../../js/sim-kit.js';
import { player } from '../../js/sim-player.js';
import { node, icon } from '../../js/sim-draw.js';

export const SETUPS = ['today', 'lock', 'early', 'coalesce', 'ahead'];
export const SITUATIONS = ['night', 'peak', 'slow', 'worker'];

export const T = 34;              // seconds in a run
export const DT = 0.01;
export const PODS = 40;
export const RATE = { night: 300, peak: 9000, slow: 9000, worker: 9000 };   // requests a second
export const BUILD = { night: 0.4, peak: 0.4, slow: 2, worker: 0.4 };       // seconds one feed query takes alone
export const TTL = 60;
export const EXPIRES = 24;        // the key's TTL runs out at this moment of the run
export const CORES = 8;           // Postgres shares its CPU between the feed queries running
export const POOL = 10;           // database connections per pod
export const HIT = 0.002;         // seconds to serve from Redis
export const POLL = 0.05;         // option A: how often a waiting request checks again
export const BETA = 1;            // option B: XFetch's beta
export const REFRESH = 20;        // option D: the worker rebuilds every 20 s
export const AHEAD_TTL = 300;     // option D: and writes the key with a 5-minute TTL
export const WORKER_DOWN = [2, 16];   // the worker situation: its pod is evicted, then rescheduled
export const TIMEOUT = 3;         // the API gives up on a request after 3 s
export const P99 = 0.15;          // the SLO: p99 under 150 ms in every second
export const MAX_QUERIES = 1;     // never more than one feed query at a time
export const MAX_AGE = 60;        // the feed may be up to a minute old

/* Run one situation. Pure and seeded; memoised, because the scoreboard asks often. */
const memo = new Map();
export function run(setup, situation) {
  const k = `${setup}:${situation}`;
  if (!memo.has(k)) memo.set(k, simulate(setup, situation));
  return memo.get(k);
}

function simulate(setup, situation) {
  const R = RATE[situation], build = BUILD[situation], dice = rng(11);
  const queries = [];             // every feed query: { id, start, work, done, by, pod, end, waiters }
  let running = [];
  const keyWaits = [];            // requests waiting for the key itself (A, and pool overflow): { n, at, pod }, oldest first
  const buckets = Array.from({ length: Math.ceil(T) }, () => []);   // [latency, count] per second of arrival
  const frames = [];
  let key = setup === 'ahead'
    ? { builtAt: -(REFRESH - 4), expires: -(REFRESH - 4) + AHEAD_TTL }
    : { builtAt: EXPIRES - TTL, expires: EXPIRES };
  let lock = null, nextId = 1, lastBuild = build, timeouts = 0;
  const rolls = [];
  const inflight = new Array(PODS).fill(null);   // option C: a pod's query in flight
  const conns = new Array(PODS).fill(0);
  const podWait = new Array(PODS).fill(0);
  const record = (lat, n, at) => {
    const b = buckets[Math.min(buckets.length - 1, Math.floor(at))];
    b.push([Math.min(lat, TIMEOUT), n]);
    if (lat >= TIMEOUT) timeouts += n;
  };
  const startQuery = (t, by, pod) => {
    const q = { id: nextId++, start: t, work: 0, by, pod, done: false, waiters: [] };
    queries.push(q); running.push(q);
    if (pod != null) conns[pod]++;
    return q;
  };
  const waitOn = (q, n, at, pod) => { q.waiters.push({ n, at, pod }); podWait[pod] += n; };
  const workerUp = t => !(situation === 'worker' && t >= WORKER_DOWN[0] && t < WORKER_DOWN[1]);
  let nextRefresh = setup === 'ahead' ? 4 : Infinity;

  for (let i = 0; i <= T / DT; i++) {
    const t = +(i * DT).toFixed(2);

    // Postgres: the feed queries share the CPU; one alone uses about 2.5 of its 8 cores.
    const share = Math.min(1, CORES / (running.length * 2.5));
    for (const q of running) {
      q.work += DT * share;
      if (q.work < build) continue;
      q.done = true; q.end = t;
      if (q.pod != null) conns[q.pod]--;
      lastBuild = t - q.start;
      if (key.builtAt < q.start) key = { builtAt: q.start, expires: t + (setup === 'ahead' ? AHEAD_TTL : TTL) };
      if (lock && lock.q === q) lock = null;
      if (setup === 'coalesce' && inflight[q.pod] === q) inflight[q.pod] = null;
      for (const w of q.waiters) { record(t - w.at, w.n, w.at); podWait[w.pod] -= w.n; }
    }
    running = running.filter(q => !q.done);
    // Requests waiting for the key: served once it is back (A polls every 50 ms), or time out.
    if (t < key.expires) {
      for (const w of keyWaits) { const lat = t - w.at; record(setup === 'lock' ? Math.ceil(lat / POLL - 1e-9) * POLL : lat, w.n, w.at); podWait[w.pod] -= w.n; }
      keyWaits.length = 0;
    }
    while (keyWaits.length && t - keyWaits[0].at >= TIMEOUT) { const w = keyWaits.shift(); record(TIMEOUT, w.n, w.at); podWait[w.pod] -= w.n; }

    // Option D's worker.
    if (setup === 'ahead' && !workerUp(t)) nextRefresh = Math.max(nextRefresh, WORKER_DOWN[1]);
    if (setup === 'ahead' && t >= nextRefresh) { startQuery(t, 'worker', null); nextRefresh = t + REFRESH; }

    // Requests arriving in this tick, spread over the pods.
    for (let p = 0; p < PODS; p++) {
      const n = Math.floor((t + DT) * R / PODS + p / PODS) - Math.floor(t * R / PODS + p / PODS);
      if (!n) continue;
      if (t < key.expires) {
        let served = n;
        if (setup === 'early') {
          // XFetch: rebuild if now - lastBuild * beta * ln(rand) >= expiry.
          const pr = Math.exp(-(key.expires - t) / (lastBuild * BETA));
          if (pr > 1e-7) for (let k = 0; k < n; k++) if (dice() < pr) {
            served--;
            rolls.push({ t, pod: p });
            waitOn(startQuery(t, 'early', p), 1, t, p);   // the winner rebuilds inline, so it waits
          }
        }
        record(HIT, served, t);
        continue;
      }
      if (setup === 'lock') {
        let rest = n;
        if (!lock) { lock = { pod: p, q: startQuery(t, 'lock', p) }; waitOn(lock.q, 1, t, p); rest--; }
        if (rest) { keyWaits.push({ n: rest, at: t, pod: p }); podWait[p] += rest; }
      } else if (setup === 'coalesce') {
        if (!inflight[p]) inflight[p] = startQuery(t, 'pod', p);
        waitOn(inflight[p], n, t, p);
      } else {
        // Today, and B or D if the key ever expired: every request queries on its own,
        // as far as the pod's connection pool allows; the rest wait for the key.
        let rest = n;
        while (rest && conns[p] < POOL) { waitOn(startQuery(t, 'request', p), 1, t, p); rest--; }
        if (rest) { keyWaits.push({ n: rest, at: t, pod: p }); podWait[p] += rest; }
      }
    }

    if (i % 2 === 0) frames.push({
      t, has: t < key.expires, ttl: key.expires - t, age: t - key.builtAt,
      queries: running.map(q => ({ id: q.id, by: q.by, pod: q.pod, p: Math.min(1, q.work / build), start: q.start })),
      waiting: podWait.reduce((a, b) => a + b, 0),
      podWait: podWait.map(x => x > 0),
      podQuery: Array.from({ length: PODS }, (_, p) => conns[p] > 0),
      lock: lock && lock.pod, timeouts,
    });
  }
  for (const q of running) for (const w of q.waiters) record(Math.min(TIMEOUT, T - w.at), w.n, w.at);
  for (const w of keyWaits) record(Math.min(TIMEOUT, T - w.at), w.n, w.at);

  // How it went.
  const p99 = buckets.map(b => {
    const total = b.reduce((s, [, n]) => s + n, 0);
    if (!total) return 0;
    const sorted = b.slice().sort((x, y) => x[0] - y[0]);
    let seen = 0;
    for (const [lat, n] of sorted) { seen += n; if (seen >= total * 0.99) return lat; }
    return sorted.at(-1)[0];
  });
  const concurrent = frames.map(f => f.queries.length);
  const maxQueries = Math.max(...concurrent);
  const maxAge = Math.max(...frames.map(f => (f.has ? f.age : 0)));
  const worstP99 = Math.max(...p99);
  const ok = worstP99 <= P99 && maxQueries <= MAX_QUERIES && maxAge <= MAX_AGE;
  const res = {
    setup, situation, R, build, p99, frames, rolls, queries: queries.map(({ waiters, ...q }) => q), ok,
    worstP99, maxQueries, maxAge, timeouts, totalQueries: queries.length,
  };
  res.at = t => frames[Math.max(0, Math.min(frames.length - 1, Math.round(t / (DT * 2))))];
  res.steps = story(res);
  res.summary = ok
    ? { en: `Within the constraints: one feed query at a time, p99 never above ${Math.round(worstP99 * 1000)} ms, and the feed at most ${Math.round(maxAge)} s old.`, vi: `Đạt các ràng buộc: mỗi lúc một truy vấn feed, p99 không bao giờ vượt ${Math.round(worstP99 * 1000)} ms, và feed cũ nhất ${Math.round(maxAge)} giây.` }
    : summary(res);
  return res;
}

export const survives = (setup, situation) => run(setup, situation).ok;

function summary(r) {
  const bits = [];
  if (r.maxQueries > MAX_QUERIES) bits.push({ en: `${fmt(r.maxQueries)} feed queries ran at once`, vi: `${fmt(r.maxQueries)} truy vấn feed chạy cùng lúc` });
  if (r.worstP99 > P99) bits.push({ en: `p99 reached ${r.worstP99 >= TIMEOUT ? 'the 3 s timeout' : `${Math.round(r.worstP99 * 1000)} ms`}`, vi: `p99 lên tới ${r.worstP99 >= TIMEOUT ? 'mức timeout 3 giây' : `${Math.round(r.worstP99 * 1000)} ms`}` });
  if (r.maxAge > MAX_AGE) bits.push({ en: `the feed got ${Math.round(r.maxAge)} s old`, vi: `feed cũ tới ${Math.round(r.maxAge)} giây` });
  return { en: `Broken: ${bits.map(b => b.en).join(', ')}.`, vi: `Hỏng: ${bits.map(b => b.vi).join(', ')}.` };
}

const fmt = n => Math.round(n).toLocaleString('en');
const clock = s => `0:${String(Math.floor(Math.max(0, s))).padStart(2, '0')}`;

const HOW = {
  today: ['Today: requests read the feed from Redis, with a 60-second TTL. On a miss, each request queries Postgres and writes the result back.', 'Hiện tại: request đọc feed từ Redis, TTL 60 giây. Khi miss, mỗi request tự truy vấn Postgres rồi ghi kết quả lại.'],
  lock: ['Option A, lock: on a miss, the first request takes a Redis lock and rebuilds the feed. Every other request checks again every 50 ms until the key is back.', 'Phương án A, lock: khi miss, request đầu tiên lấy một lock trong Redis và dựng lại feed. Mọi request khác kiểm tra lại mỗi 50 ms cho tới khi key có lại.'],
  early: ['Option B, early refresh (XFetch): every read flips a weighted coin. The closer the key is to expiry, the likelier a request is to rebuild it, before it expires.', 'Phương án B, refresh sớm (XFetch): mỗi lần đọc tung một đồng xu có trọng số. Key càng gần hết hạn, request càng dễ dựng lại nó, trước khi nó hết hạn.'],
  coalesce: ['Option C, coalescing: inside each pod, concurrent misses share one in-flight query to Postgres and all get its result.', 'Phương án C, gộp request: trong mỗi pod, các lần miss đồng thời dùng chung một truy vấn đang chạy tới Postgres và cùng nhận kết quả.'],
  ahead: ['Option D, refresh ahead: one worker rebuilds the feed every 20 s and writes it with a 5-minute TTL. Requests only read.', 'Phương án D, refresh trước: một worker dựng lại feed mỗi 20 giây và ghi với TTL 5 phút. Request chỉ đọc.'],
};

function story(r) {
  const { setup, situation, R, build } = r;
  const m = [];
  const add = (t, tone, en, vi, slow) => m.push({ t, tone, say: { en, vi }, slow });
  add(0, null, ...HOW[setup]);
  add(1, null,
    situation === 'night' ? `Night: ${R} requests a second. The key’s TTL runs out at ${clock(EXPIRES)}.` : `Peak: ${fmt(R)} requests a second over ${PODS} pods.${situation === 'slow' ? ` Postgres is busy, so one feed query takes ${build} s instead of 0.4 s.` : ''} The key’s TTL runs out at ${clock(EXPIRES)}.`,
    situation === 'night' ? `Ban đêm: ${R} request mỗi giây. TTL của key hết lúc ${clock(EXPIRES)}.` : `Giờ cao điểm: ${fmt(R)} request mỗi giây trên ${PODS} pod.${situation === 'slow' ? ` Postgres đang bận, nên một truy vấn feed mất ${build} giây thay vì 0,4 giây.` : ''} TTL của key hết lúc ${clock(EXPIRES)}.`);

  if (setup === 'ahead') {
    if (situation === 'worker') {
      add(WORKER_DOWN[0], 'warn', 'The worker’s pod is evicted. Nothing refreshes the feed; requests keep reading the copy in Redis, which has minutes of TTL left.', 'Pod của worker bị evict. Không gì refresh feed; request vẫn đọc bản trong Redis, vốn còn vài phút TTL.');
      add(WORKER_DOWN[1], null, `The worker is rescheduled and refreshes at once. The feed was ${Math.round(r.maxAge)} s old at worst, inside the minute allowed.`, `Worker được lên lịch lại và refresh ngay. Feed cũ nhất ${Math.round(r.maxAge)} giây, trong mức một phút cho phép.`);
    } else add(4, null, 'The worker rebuilds the feed: one query, while every request keeps reading the old copy from Redis.', 'Worker dựng lại feed: một truy vấn, trong khi mọi request vẫn đọc bản cũ từ Redis.', true);
    add(EXPIRES - 1, null, 'The moment that hurts the other setups passes unnoticed: the key has minutes of TTL left, so it never expires.', 'Khoảnh khắc làm khổ các cách khác trôi qua êm ả: key còn vài phút TTL, nên nó không bao giờ hết hạn.', true);
  } else if (setup === 'early') {
    const first = r.rolls[0];
    if (first) {
      add(Math.max(1.5, first.t - 2), null, `${Math.round(EXPIRES - first.t + 2)} s before expiry, each read has a tiny chance to rebuild early. With ${fmt(R)} reads a second, someone soon wins.`, `${Math.round(EXPIRES - first.t + 2)} giây trước khi hết hạn, mỗi lần đọc có một cơ hội nhỏ để dựng lại sớm. Với ${fmt(R)} lần đọc mỗi giây, sớm muộn sẽ có request trúng.`);
      const dup = r.rolls.filter(x => x.t > first.t && x.t < first.t + build * 1.5).length;
      add(first.t, dup ? 'bad' : null,
        dup ? `A request on pod ${first.pod + 1} wins and starts a rebuild. Nothing tells the others, so while it runs, ${dup} more win too: ${dup + 1} feed queries for one key.` : `A request on pod ${first.pod + 1} wins and rebuilds the feed. The key is fresh again before it ever expired.`,
        dup ? `Một request ở pod ${first.pod + 1} trúng và bắt đầu dựng lại. Không gì báo cho các request khác, nên trong lúc nó chạy, thêm ${dup} request nữa cũng trúng: ${dup + 1} truy vấn feed cho một key.` : `Một request ở pod ${first.pod + 1} trúng và dựng lại feed. Key mới lại trước khi kịp hết hạn.`, true);
    }
  } else {
    add(EXPIRES - 2, null, 'The TTL is about to run out at peak traffic.', 'TTL sắp hết đúng lúc lưu lượng cao điểm.', true);
    add(EXPIRES, 'warn', 'The key expires. Every request in the next moments finds nothing in Redis.', 'Key hết hạn. Mọi request trong những khoảnh khắc tiếp theo đều không tìm thấy gì trong Redis.', true);
    const say = {
      today: [`Every one of them queries Postgres: up to ${POOL} per pod, ${fmt(r.maxQueries)} feed queries at once. They share the CPU, so each takes far longer, and more requests miss while they wait.`, `Mỗi request đều truy vấn Postgres: tối đa ${POOL} mỗi pod, ${fmt(r.maxQueries)} truy vấn feed cùng lúc. Chúng chia nhau CPU, nên mỗi truy vấn lâu hơn nhiều, và càng nhiều request miss trong lúc chờ.`],
      lock: ['One request takes the lock and runs the only query. Everyone else waits, polling every 50 ms.', 'Một request lấy lock và chạy truy vấn duy nhất. Mọi request khác chờ, kiểm tra lại mỗi 50 ms.'],
      coalesce: [`Each pod sends one query and parks its own requests on it. That is still one query per pod: ${r.maxQueries} at once, and every request waits for them.`, `Mỗi pod gửi một truy vấn và để các request của mình chờ nó. Vẫn là mỗi pod một truy vấn: ${r.maxQueries} truy vấn cùng lúc, và mọi request phải chờ.`],
    }[setup];
    add(EXPIRES + 0.15, setup === 'lock' ? 'warn' : 'bad', ...say, true);
    if (setup === 'lock') add(EXPIRES + build + 0.2, r.worstP99 > P99 ? 'bad' : null, `The key is back after ${build} s. Postgres was fine, but every request in that window waited: p99 for that second was ${Math.round(r.worstP99 * 1000)} ms.`, `Key có lại sau ${build} giây. Postgres ổn, nhưng mọi request trong khoảng đó đều phải chờ: p99 của giây đó là ${Math.round(r.worstP99 * 1000)} ms.`);
    else add(EXPIRES + Math.min(4, build * 3), 'bad', `p99 reached ${r.worstP99 >= TIMEOUT ? 'the 3-second timeout' : `${Math.round(r.worstP99 * 1000)} ms`}.`, `p99 lên tới ${r.worstP99 >= TIMEOUT ? 'mức timeout 3 giây' : `${Math.round(r.worstP99 * 1000)} ms`}.`);
  }
  m.sort((a, b) => a.t - b.t);
  return m.map((x, i) => ({ ...x, t0: x.t, t1: i + 1 < m.length ? m[i + 1].t : T }));
}

const LABEL = {
  today: { en: 'Today: TTL, miss, query', vi: 'Hiện tại: TTL, miss, truy vấn' },
  lock: { en: 'A · Lock the rebuild', vi: 'A · Lock khi dựng lại' },
  early: { en: 'B · Probabilistic early refresh', vi: 'B · Refresh sớm theo xác suất' },
  coalesce: { en: 'C · Coalesce requests', vi: 'C · Gộp request' },
  ahead: { en: 'D · Refresh ahead', vi: 'D · Refresh trước' },
};
const SITUATION = {
  night: { en: 'Quiet night', vi: 'Đêm yên tĩnh' },
  peak: { en: 'Expiry at peak', vi: 'Hết hạn giờ cao điểm' },
  slow: { en: 'Postgres is slow', vi: 'Postgres đang chậm' },
  worker: { en: 'The refresher dies', vi: 'Worker refresh chết' },
};

export function mount(root, ctx) {
  let cached = null;   // the player asks for each run once; the drawing reads the same result
  return player(root, ctx, {
    situations: SITUATIONS.map(x => ({ value: x, label: tx(SITUATION[x]), icon: { night: 'moon', peak: 'bolt', slow: 'hourglass', worker: 'power' }[x], tone: x === 'night' ? 'ok' : undefined })),
    setups: SETUPS.map(x => ({ value: x, label: tx(LABEL[x]), icon: { today: 'server', lock: 'lock', early: 'gauge', coalesce: 'layers', ahead: 'replay' }[x] })),
    initial: { situation: 'peak' },
    run: (setup, situation) => (cached = run(setup, situation)),
    survives, height: 520,
    duration: st => Math.max(1.3, (st.t1 - st.t0) / (st.slow ? 0.6 : 5)),
    tone: st => st.tone,
    draw: ({ g, w, h, k, p }) => {
      const st = cached.steps[k];
      draw(g, w, h, cached, st ? st.t0 + p * (st.t1 - st.t0) : T);
    },
  });
}

/* ---------------- drawing ---------------- */

const mono = (px, wt = 600) => `${wt} ${px}px "IBM Plex Mono", monospace`;
const sans = (px, wt = 500) => `${wt} ${px}px "Hanken Grotesk", sans-serif`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const BY = { request: 'bad', pod: 'warn', lock: 'violet', early: 'pink', worker: 'ok' };

function draw(g, w, h, r, t) {
  const { setup, situation } = r;
  const f = r.at(t);
  g.clearRect(0, 0, w, h);
  g.textBaseline = 'middle';
  const text = (s, x, y, color = 'muted', font = mono(10, 400), align = 'left', max) => {
    g.font = font; g.textAlign = align; g.fillStyle = css(color); g.fillText(s, x, y, max);
  };
  const box = (x, y, bw, bh, rad, fill, stroke, alpha = 1, lw = 1) => {
    g.beginPath(); g.roundRect(x, y, bw, bh, rad);
    if (fill) { g.globalAlpha = alpha; g.fillStyle = css(fill); g.fill(); g.globalAlpha = 1; }
    if (stroke) { g.lineWidth = lw; g.strokeStyle = css(stroke); g.stroke(); g.lineWidth = 1; }
  };
  const line = (x1, y1, x2, y2, color, alpha = 1, lw = 1, dash) => {
    g.save(); g.globalAlpha = alpha; g.strokeStyle = css(color); g.lineWidth = lw; if (dash) g.setLineDash(dash);
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); g.restore();
  };

  // ---- The strip: p99 each second, and feed queries running. ----
  const sx0 = 150, sx1 = w - 14, X = tt => sx0 + (tt / T) * (sx1 - sx0);
  const r1 = [12, 50], r2 = [58, 94];
  text(tx({ en: 'p99 EACH SECOND', vi: 'p99 MỖI GIÂY' }), 12, 24, 'muted', mono(10, 700));
  text(tx({ en: '- - 150 ms', vi: '- - 150 ms' }), 12, 38, 'bad', mono(9.5, 600));
  text(tx({ en: 'FEED QUERIES', vi: 'TRUY VẤN FEED' }), 12, 70, 'muted', mono(10, 700));
  text(tx({ en: '- - at most 1', vi: '- - tối đa 1' }), 12, 84, 'bad', mono(9.5, 600));
  box(sx0, r1[0], sx1 - sx0, r1[1] - r1[0], 5, 'bg2');
  box(sx0, r2[0], sx1 - sx0, r2[1] - r2[0], 5, 'bg2');
  const Ylat = (v, [a, b]) => b - (Math.log10(clamp(v * 1000, 1, 3000)) / Math.log10(3000)) * (b - a - 4);
  const Yq = (v, [a, b]) => b - (Math.log10(1 + v) / Math.log10(501)) * (b - a - 4);
  r.p99.forEach((v, s) => {
    if (s + 1 > t) return;
    const bad = v > P99, y = Ylat(v, r1);
    box(X(s) + 1, y, X(s + 1) - X(s) - 2, r1[1] - y, 2, bad ? 'bad' : 'ok', null, 0.85);
  });
  line(sx0, Ylat(P99, r1), sx1, Ylat(P99, r1), 'bad', 0.8, 1, [4, 4]);
  g.save(); g.strokeStyle = css('blue'); g.lineWidth = 1.5; g.beginPath();
  r.frames.filter(x => x.t <= t).forEach((x, i) => (i ? g.lineTo(X(x.t), Yq(x.queries.length, r2)) : g.moveTo(X(x.t), Yq(x.queries.length, r2))));
  g.stroke(); g.restore();
  line(sx0, Yq(1, r2), sx1, Yq(1, r2), 'bad', 0.8, 1, [4, 4]);
  line(X(EXPIRES), r1[0], X(EXPIRES), r2[1], 'warn', 0.5, 1, [2, 3]);
  text(tx({ en: 'TTL runs out', vi: 'TTL hết' }), X(EXPIRES) + 4, r2[1] - 6, 'warn', mono(8.5, 600));
  line(X(t), r1[0] - 2, X(t), r2[1] + 2, 'text', 0.6);
  text(clock(t), clamp(X(t), sx0 + 14, sx1 - 14), r2[1] + 10, 'faint', mono(9.5, 600), 'center');

  // ---- Layout of the row. ----
  const top = 122, bot = h - 92, mid = (top + bot) / 2;
  const readerX = 30;
  const gx0 = 66, cols = 8, rows = PODS / cols;
  const cell = clamp(Math.floor((w * 0.24) / cols), 16, 26), gw = cols * cell, gh = rows * cell;
  const gy0 = mid - gh / 2 + 6;
  const kw = clamp(w * 0.22, 170, 210), kx = gx0 + gw + 40, kx1 = kx + kw;
  const dbW = clamp(w * 0.25, 190, 250), dbx = w - 14 - dbW;

  // Readers and their stream.
  for (let i = 0; i < 4; i++) icon(g, 'user', readerX, gy0 + 10 + i * 24, 14, 'text');
  text(`${fmt(r.R)}/s`, readerX, gy0 + gh + 22, 'muted', mono(10, 700), 'center');
  const dots = clamp(Math.round(Math.log10(r.R) * 3), 3, 14);
  for (let i = 0; i < dots; i++) { const ph = (t * 1.3 + i / dots) % 1; g.fillStyle = css('text'); g.globalAlpha = 0.8; g.beginPath(); g.arc(readerX + 14 + ph * (gx0 - readerX - 18), gy0 + gh / 2 + Math.sin(i * 1.7) * gh * 0.35, 2.2, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; }

  // Pods.
  text(tx({ en: `${PODS} API PODS`, vi: `${PODS} API POD` }), gx0, gy0 - 14, 'muted', mono(10, 700));
  const podXY = p => [gx0 + (p % cols) * cell, gy0 + Math.floor(p / cols) * cell];
  const winners = r.rolls.filter(x => t >= x.t && t < x.t + 0.6);
  for (let p = 0; p < PODS; p++) {
    const [x, y] = podXY(p);
    const holds = f.lock === p, won = winners.some(x2 => x2.pod === p);
    const color = holds ? 'violet' : won ? 'pink' : f.podQuery[p] ? 'blue' : f.podWait[p] ? 'warn' : 'ok';
    box(x + 1, y + 1, cell - 3, cell - 3, 4, color, null, color === 'ok' ? 0.35 : 0.9);
    if (holds) text('🔒', x + cell / 2 - 1, y + cell / 2, 'bg', sans(10), 'center');
  }
  const waiting = f.waiting;
  text(waiting ? tx({ en: `${fmt(waiting)} requests waiting`, vi: `${fmt(waiting)} request đang chờ` }) : tx({ en: 'all served from Redis', vi: 'tất cả lấy từ Redis' }), gx0, gy0 + gh + 14, waiting ? 'warn' : 'ok', mono(10, 700), 'left', gw + 20);
  if (f.timeouts) text(tx({ en: `${fmt(f.timeouts)} timed out`, vi: `${fmt(f.timeouts)} bị timeout` }), gx0, gy0 + gh + 30, 'bad', mono(10, 700), 'left', gw + 20);

  // Every running query is a line from whoever sent it to Postgres: the herd, drawn.
  // Drawn before the key card, so the lines pass behind it.
  const toDb = [dbx - 2, (top + bot) / 2];
  const lines = f.queries.slice(0, 160);
  for (const q of lines) {
    if (q.pod == null) continue;
    const [x, y] = podXY(q.pod);
    g.save(); g.globalAlpha = lines.length > 20 ? 0.18 : 0.6; g.strokeStyle = css(BY[q.by]); g.lineWidth = lines.length > 20 ? 1 : 1.5;
    g.beginPath(); g.moveTo(x + cell / 2, y + cell / 2); g.quadraticCurveTo((x + toDb[0]) / 2, Math.min(y, toDb[1]) - 60, toDb[0], toDb[1]); g.stroke(); g.restore();
  }
  // Redis: the key card with its TTL ring.
  const ky0 = top, ky1 = bot;
  const ttlFull = setup === 'ahead' ? AHEAD_TTL : TTL;
  box(kx, ky0, kw, ky1 - ky0, 14, 'surface2', f.has ? 'line' : 'bad', 1, f.has ? 1 : 2);
  text('REDIS', kx + 14, ky0 + 16, 'bad', mono(10, 700));
  text('feed:home', kx1 - 14, ky0 + 16, 'muted', mono(10, 600), 'right');
  const cx = kx + kw / 2, cy = ky0 + 84, R0 = 44;
  g.lineWidth = 9; g.strokeStyle = css('bg2'); g.beginPath(); g.arc(cx, cy, R0, 0, Math.PI * 2); g.stroke();
  if (f.has) {
    const frac = clamp(f.ttl / ttlFull, 0, 1), col = f.ttl < 5 && setup !== 'ahead' ? 'bad' : f.ttl < 15 && setup !== 'ahead' ? 'warn' : 'ok';
    g.strokeStyle = css(col); g.lineCap = 'round'; g.beginPath(); g.arc(cx, cy, R0, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); g.stroke(); g.lineCap = 'butt';
    g.lineWidth = 1;
    text(f.ttl >= 100 ? `${Math.floor(f.ttl / 60)}m${String(Math.floor(f.ttl % 60)).padStart(2, '0')}` : `${Math.ceil(f.ttl)}s`, cx, cy - 4, col, mono(20, 700), 'center');
    text('TTL', cx, cy + 16, 'faint', mono(9.5, 700), 'center');
  } else {
    g.lineWidth = 1;
    text('MISS', cx, cy - 2, 'bad', mono(20, 700), 'center');
    text(tx({ en: 'key gone', vi: 'key mất' }), cx, cy + 18, 'bad', mono(9.5, 700), 'center');
  }
  text(f.has ? tx({ en: `feed is ${Math.floor(f.age)} s old`, vi: `feed đã ${Math.floor(f.age)} giây` }) : '—', cx, cy + R0 + 20, f.has && f.age > MAX_AGE ? 'bad' : 'muted', mono(10, 600), 'center');
  // What this setup adds next to the key.
  const ny = cy + R0 + 44, nx = kx + 14, nw = kw - 28;
  if (setup === 'lock') {
    const held = f.lock != null;
    box(nx, ny - 12, nw, 26, 6, held ? 'violet' : 'bg2', null, held ? 0.2 : 1);
    text(held ? tx({ en: `lock:feed:home → pod ${f.lock + 1}`, vi: `lock:feed:home → pod ${f.lock + 1}` }) : tx({ en: 'lock:feed:home · free', vi: 'lock:feed:home · trống' }), nx + 8, ny + 1, held ? 'violet' : 'faint', mono(10, 700), 'left', nw - 12);
  } else if (setup === 'early') {
    const pr = f.has ? Math.exp(-f.ttl / (r.build * BETA)) : 1;
    text(tx({ en: 'chance a read rebuilds now', vi: 'xác suất một lần đọc dựng lại' }), nx, ny - 6, 'faint', mono(9, 600), 'left', nw);
    const lp = clamp((Math.log10(Math.max(pr, 1e-8)) + 8) / 8, 0, 1);
    box(nx, ny + 4, nw, 8, 4, 'bg2'); box(nx, ny + 4, nw * lp, 8, 4, 'pink');
    text(pr < 1e-6 ? '< 0.0001%' : `${(pr * 100).toPrecision(2)}%`, nx + nw, ny - 6, 'pink', mono(9.5, 700), 'right');
    text(tx({ en: `× ${fmt(r.R)} reads a second`, vi: `× ${fmt(r.R)} lần đọc mỗi giây` }), nx, ny + 24, 'faint', mono(9, 600), 'left', nw);
    const won = r.rolls.filter(x => x.t <= t).length;
    if (won) text(tx({ en: `🎲 ${won} rebuild${won > 1 ? 's' : ''} won`, vi: `🎲 ${won} lần trúng dựng lại` }), nx, ny + 40, won > 1 ? 'bad' : 'pink', mono(10, 700), 'left', nw);
  } else if (setup === 'coalesce') {
    text(tx({ en: 'each pod shares one query', vi: 'mỗi pod dùng chung một truy vấn' }), nx, ny, 'warn', mono(9.5, 600), 'left', nw);
    text(tx({ en: `pods: ${PODS} → queries: up to ${PODS}`, vi: `${PODS} pod → tối đa ${PODS} truy vấn` }), nx, ny + 16, 'faint', mono(9.5, 600), 'left', nw);
  } else if (setup === 'ahead') {
    const next = situation === 'worker' && t >= WORKER_DOWN[0] && t < WORKER_DOWN[1] ? null : (() => { const ws = r.queries.filter(q => q.by === 'worker' && q.start > t); return ws.length ? ws[0].start - t : null; })();
    text(tx({ en: `refreshed every ${REFRESH} s`, vi: `refresh mỗi ${REFRESH} giây` }), nx, ny, 'ok', mono(9.5, 700), 'left', nw);
    text(next != null ? tx({ en: `next in ${Math.ceil(next)} s`, vi: `lần tới sau ${Math.ceil(next)} giây` }) : tx({ en: 'worker down', vi: 'worker đang chết' }), nx, ny + 16, next != null ? 'faint' : 'bad', mono(9.5, 700), 'left', nw);
  } else {
    text(tx({ en: 'on a miss: every request', vi: 'khi miss: mọi request' }), nx, ny, 'faint', mono(9.5, 600), 'left', nw);
    text(tx({ en: 'queries Postgres itself', vi: 'tự truy vấn Postgres' }), nx, ny + 16, 'faint', mono(9.5, 600), 'left', nw);
  }
  // Pods read the key: a soft road between grid and card.
  line(gx0 + gw + 4, gy0 + gh / 2, kx - 2, gy0 + gh / 2, f.has ? 'ok' : 'bad', 0.5, 2, [5, 5]);

  // Postgres: the feed queries running, and the CPU they share.
  const dy0 = top, dy1 = bot, dcx = dbx + dbW / 2;
  const busy = f.queries.length;
  const cpu = Math.min(1, (busy * 2.5) / CORES);
  node(g, { x: dcx, y: (dy0 + dy1) / 2, w: dbW, h: dy1 - dy0, title: 'Postgres', icon: 'db', color: 'blue', alert: busy > MAX_QUERIES });
  text(tx({ en: `CPU ${Math.round(cpu * 100)}%`, vi: `CPU ${Math.round(cpu * 100)}%` }), dbx + 14, dy0 + 46, cpu >= 1 ? 'bad' : 'muted', mono(10, 700));
  box(dbx + 80, dy0 + 42, dbW - 94, 8, 4, 'bg2'); box(dbx + 80, dy0 + 42, (dbW - 94) * cpu, 8, 4, cpu >= 1 ? 'bad' : cpu > 0.5 ? 'warn' : 'ok');
  text(busy ? tx({ en: `${fmt(busy)} feed quer${busy > 1 ? 'ies' : 'y'} running`, vi: `${fmt(busy)} truy vấn feed đang chạy` }) : tx({ en: 'no feed query running', vi: 'không có truy vấn feed' }), dbx + 14, dy0 + 66, busy > 1 ? 'bad' : busy ? 'blue' : 'faint', mono(10, 700), 'left', dbW - 28);
  const show = f.queries.slice(0, 9), qy0 = dy0 + 82, qh = 15;
  show.forEach((q, i) => {
    const y = qy0 + i * (qh + 4), color = BY[q.by];
    box(dbx + 14, y, dbW - 28, qh, 4, 'bg2');
    box(dbx + 14, y, (dbW - 28) * q.p, qh, 4, color, null, 0.8);
    const who = q.by === 'worker' ? tx({ en: 'worker', vi: 'worker' }) : q.by === 'lock' ? tx({ en: `pod ${q.pod + 1} · lock`, vi: `pod ${q.pod + 1} · lock` }) : q.by === 'early' ? tx({ en: `pod ${q.pod + 1} · 🎲`, vi: `pod ${q.pod + 1} · 🎲` }) : `pod ${q.pod + 1}`;
    text(who, dbx + 20, y + qh / 2 + 0.5, 'text', mono(9, 700), 'left', dbW - 40);
  });
  if (f.queries.length > show.length) text(tx({ en: `+ ${fmt(f.queries.length - show.length)} more`, vi: `+ ${fmt(f.queries.length - show.length)} nữa` }), dcx, qy0 + show.length * (qh + 4) + 8, 'bad', mono(11, 700), 'center');

  // Option D's worker, above the key card, wired to Postgres and back to Redis.
  if (setup === 'ahead') {
    const wx = (kx1 + dbx) / 2, wy = top + 26, down = situation === 'worker' && t >= WORKER_DOWN[0] && t < WORKER_DOWN[1];
    const wq = f.queries.find(q => q.by === 'worker');
    box(wx - 46, wy - 16, 92, 32, 8, 'surface2', down ? 'bad' : wq ? 'ok' : 'line', 1, wq || down ? 2 : 1);
    icon(g, 'clock', wx - 30, wy, 14, down ? 'bad' : 'ok');
    text(down ? tx({ en: 'evicted', vi: 'bị evict' }) : tx({ en: 'refresher', vi: 'refresher' }), wx + 8, wy, down ? 'bad' : 'text', mono(10, 700), 'center');
    if (wq) line(wx + 46, wy, dbx, dy0 + 66, 'ok', 0.8, 2, [6, 4]);
  }
  // A finished query writes the key back: a green pulse from Postgres to Redis.
  for (const q of r.queries) if (q.end != null && t >= q.end && t < q.end + 0.5) {
    const pr = (t - q.end) / 0.5, x = dbx - (dbx - kx1) * pr, y = cy;
    g.fillStyle = css('ok'); g.beginPath(); g.roundRect(x - 18, y - 9, 36, 18, 9); g.fill();
    text('SET', x, y + 0.5, 'bg', mono(9.5, 700), 'center');
    break;
  }

  // ---- The constraints, live. ----
  const cy0 = h - 64, third = (w - 28 - 20) / 3;
  const past = r.p99.slice(0, Math.max(0, Math.floor(t)));
  const worst = Math.max(0, ...past);
  const qmax = Math.max(...r.frames.filter(x => x.t <= t).map(x => x.queries.length));
  const amax = Math.max(...r.frames.filter(x => x.t <= t).map(x => (x.has ? x.age : 0)));
  const checks = [
    [worst <= P99, tx({ en: 'p99 under 150 ms, every second', vi: 'p99 dưới 150 ms, mọi giây' }), worst >= TIMEOUT ? tx({ en: 'worst: 3 s timeouts', vi: 'tệ nhất: timeout 3 giây' }) : tx({ en: `worst so far ${Math.round(worst * 1000)} ms`, vi: `tệ nhất tới giờ ${Math.round(worst * 1000)} ms` })],
    [qmax <= MAX_QUERIES, tx({ en: 'At most 1 feed query at a time', vi: 'Tối đa 1 truy vấn feed mỗi lúc' }), tx({ en: `most at once: ${fmt(qmax)}`, vi: `nhiều nhất cùng lúc: ${fmt(qmax)}` })],
    [amax <= MAX_AGE, tx({ en: 'Feed at most 60 s old', vi: 'Feed cũ tối đa 60 giây' }), tx({ en: `oldest: ${Math.round(amax)} s`, vi: `cũ nhất: ${Math.round(amax)} giây` })],
  ];
  checks.forEach(([pass, what, detail], i) => {
    const x = 14 + i * (third + 10);
    box(x, cy0, third, 46, 10, pass ? 'ok' : 'bad', null, 0.1);
    icon(g, pass ? 'check' : 'cross', x + 16, cy0 + 15, 13, pass ? 'ok' : 'bad');
    text(what, x + 30, cy0 + 15, 'text', sans(11.5, 600), 'left', third - 40);
    text(detail, x + 30, cy0 + 32, pass ? 'ok' : 'bad', mono(9.5, 700), 'left', third - 40);
  });
}
