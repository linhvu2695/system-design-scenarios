/* A news site's view counter under five strategies, watched as traffic.

   Readers on the left send page views to the app. From there the work flows, as
   streams of dots whose density follows the rate, to Redis and to Postgres: UPDATEs
   (amber), reads (blue), loads from Postgres (violet), key deletes (red). In Postgres
   the hot row is drawn with its row lock and the UPDATEs queued behind it, and the
   connection pool filling up; the app shows how long a page now takes. Write-behind's
   flush is one block carrying many views at once.

   A strip along the top plots views and Postgres writes a second on a log scale, with
   the scenario's budget of a few hundred writes. A checklist along the bottom ticks
   each constraint live.

   The model (run()) is a fluid simulation over 30 seconds. The view rates and the
   budget come from the scenario; how fast the hot rows take updates, the pool size and
   the page timeout are illustrative. js/sim-player.js supplies the controls and
   scoreboard. */

import { tx } from '../../js/i18n.js';
import { css } from '../../js/sim-kit.js';
import { player } from '../../js/sim-player.js';
import { node, icon, road, message } from '../../js/sim-draw.js';

export const SETUPS = ['today', 'aside', 'through', 'readthrough', 'behind'];
export const SITUATIONS = ['normal', 'news', 'crash'];

export const T = 30;               // seconds in a run
export const DT = 0.1;             // model step
export const NORMAL = 120;         // views a second on a normal day
export const PEAK = 150000;        // views a second during breaking news (the scenario)
export const NEWS_AT = 4, PEAK_AT = 8;
export const WRITE_BUDGET = 300;   // Postgres counter writes a second: "a few hundred at most"
export const FLUSH = 5;            // write-behind flushes every 5 s (option C)
export const TTL = 10;             // read-through keeps a loaded count 10 s (option D)
export const ARTICLES = 200;       // hot articles: one UPDATE each per flush
export const LOSS_OK = FLUSH;      // seconds of views it is acceptable to lose
export const CRASH_AT = 12;
// Illustrative, not measured: how many updates a second the hot rows take one after
// another under their row locks, the connection pool, and when a page gives up.
export const ROW_CAP = 5000;
export const POOL = 100;
export const TIMEOUT_MS = 3000;

/* Views a second at time t. */
export function viewsAt(situation, t) {
  if (situation !== 'news' || t < NEWS_AT) return NORMAL;
  const f = Math.min(1, (t - NEWS_AT) / (PEAK_AT - NEWS_AT));
  return Math.round(NORMAL * Math.pow(PEAK / NORMAL, f));
}

/* Run one situation: a sample every DT with every rate and level the drawing shows,
   the flushes and loads as discrete events, and the captioned steps. Pure. */
export function run(setup, situation) {
  const samples = [], flushes = [], loads = [];
  let truth = 1_204_000, db = truth, pending = 0, queue = 0, lost = 0, lostSec = 0;
  let cache = setup === 'today' ? null : truth, loadedAt = 0, down = false;
  const waits = setup !== 'behind';   // a view runs a statement on Postgres before it returns
  let maxWrites = 0, maxPage = 0, maxTrail = 0;

  for (let i = 0; i <= T / DT; i++) {
    const t = +(i * DT).toFixed(2);
    const v = viewsAt(situation, t);
    let writes = 0, reads = 0, dels = 0, incr = 0, gets = 0;

    // Redis dies, and comes back empty half a second later.
    if (situation === 'crash' && setup !== 'today' && Math.abs(t - CRASH_AT) < DT / 2) {
      down = true;
      if (setup === 'behind') { lost = pending; lostSec = pending / v; pending = 0; }
      cache = null;
    }
    if (down && t >= CRASH_AT + 0.5) down = false;

    truth += v * DT;
    if (setup === 'behind') {
      pending += v * DT;
      if (!down) { incr = v; gets = v; }
      if (t > 0 && Math.abs(t / FLUSH - Math.round(t / FLUSH)) < 1e-6 && pending > 0) {
        const n = Math.round(pending);
        flushes.push({ t, n, rows: Math.min(ARTICLES, n) });
        db += pending; pending = 0;
        writes = Math.min(ARTICLES, n);   // one UPDATE per article, all in this second
      }
      if (cache == null && !down) { cache = db; reads = 1; }
      if (cache != null) cache = db + pending;
    } else {
      writes = v;                                  // one UPDATE per view
      if (setup === 'aside') { dels = v; reads = v; gets = v; }      // every view deletes the key, so reads miss
      else if (setup === 'today') reads = v;
      else if (setup === 'through') { incr = v; gets = v; if (cache == null && !down) { cache = db; reads = 1; } }
      else if (setup === 'readthrough') {
        gets = v;
        if (!down && (cache == null || t - loadedAt >= TTL)) { cache = db; loadedAt = t; loads.push({ t }); reads = 1; }
      }
    }

    // The hot rows take ROW_CAP updates a second; the rest wait for the row lock.
    if (setup !== 'behind') {
      queue = Math.max(0, queue + (writes - ROW_CAP) * DT);
      db = truth - queue;
      if (setup === 'through' && cache != null) cache = truth;
    }
    const pageMs = waits ? 3 + (queue / ROW_CAP) * 1000 + (setup === 'through' ? 0.5 : 0) : 1;
    const conns = waits ? Math.min(POOL, Math.max(1, Math.ceil((v * pageMs) / 1000))) : (writes ? 1 : 0);
    const shown = setup === 'today' || setup === 'aside' ? db : cache;
    const trail = shown == null ? 0 : (truth - shown) / v;

    // Writes a second over the last second, so a flush shows as its real rate.
    samples.push({ t, v, writes, reads, dels, incr, gets, queue, pageMs, conns, truth, db, cache, pending, shown, trail, down });
    const lastSec = samples.slice(-Math.round(1 / DT));
    const wps = setup === 'behind' ? lastSec.reduce((s, x) => s + x.writes, 0) : writes;
    samples.at(-1).wps = wps;
    maxWrites = Math.max(maxWrites, wps);
    maxPage = Math.max(maxPage, pageMs);
    if (pageMs < TIMEOUT_MS) maxTrail = Math.max(maxTrail, trail);
  }

  const ok = maxWrites <= WRITE_BUDGET && maxPage < TIMEOUT_MS && lostSec <= LOSS_OK;
  const res = { setup, situation, samples, flushes, loads, maxWrites, maxPage, maxTrail, lost: Math.round(lost), lostSec, ok, end: T };
  res.at = t => samples[Math.max(0, Math.min(samples.length - 1, Math.round(t / DT)))];
  res.steps = story(res);
  res.summary = ok
    ? (lost ? { en: `Within the constraints. Redis lost ${fmt(res.lost)} views, ${lostSec.toFixed(1)} seconds’ worth, which the scenario accepts.`, vi: `Đạt các ràng buộc. Redis mất ${fmt(res.lost)} lượt xem, tương đương ${lostSec.toFixed(1)} giây, mức tình huống chấp nhận.` } : { en: 'Within the constraints.', vi: 'Đạt các ràng buộc.' })
    : { en: `Broken: Postgres got up to ${fmt(maxWrites)} counter writes a second (the budget is ${WRITE_BUDGET}), and pages timed out.`, vi: `Hỏng: Postgres nhận tới ${fmt(maxWrites)} lượt ghi bộ đếm mỗi giây (ngân sách là ${WRITE_BUDGET}), và các trang bị timeout.` };
  return res;
}

export const survives = (setup, situation) => run(setup, situation).ok;

const fmt = n => Math.round(n).toLocaleString('en');
const clock = s => `0:${String(Math.floor(s)).padStart(2, '0')}`;

const HOW = {
  today: ['No cache. Every view runs UPDATE articles SET views = views + 1 on Postgres, and every page reads the count from Postgres.', 'Không cache. Mỗi lượt xem chạy UPDATE articles SET views = views + 1 trên Postgres, và mỗi trang đọc số đếm từ Postgres.'],
  aside: ['Cache-aside: the app reads Redis and loads from Postgres on a miss. On each view it updates Postgres, then deletes the Redis key.', 'Cache-aside: app đọc Redis và nạp từ Postgres khi miss. Mỗi lượt xem, nó cập nhật Postgres rồi xoá key trong Redis.'],
  through: ['Write-through: each view increments Redis and updates Postgres in the same request. Pages read the count from Redis.', 'Write-through: mỗi lượt xem tăng số trong Redis và cập nhật Postgres trong cùng request. Trang đọc số đếm từ Redis.'],
  readthrough: ['Read-through: Redis loads the count from Postgres itself and keeps it 10 seconds. Views still update Postgres directly.', 'Read-through: Redis tự nạp số đếm từ Postgres và giữ 10 giây. Lượt xem vẫn cập nhật thẳng Postgres.'],
  behind: ['Write-behind: each view runs INCR in Redis and returns. Every 5 seconds a job moves the pending increments to Postgres, one UPDATE per article.', 'Write-behind: mỗi lượt xem chạy INCR trong Redis rồi trả về. Cứ 5 giây, một job chuyển các lượt tăng đang chờ xuống Postgres, mỗi bài viết một lệnh UPDATE.'],
};

function story(r) {
  const { setup, situation, samples } = r;
  const m = [];
  const add = (t, tone, en, vi) => m.push({ t, tone, say: { en, vi } });
  add(0, null, ...HOW[setup]);

  if (situation === 'normal' || situation === 'crash') add(1, null, `A normal day: about ${NORMAL} views a second.`, `Một ngày bình thường: khoảng ${NORMAL} lượt xem mỗi giây.`);
  else add(1, null, `A normal day so far: ${NORMAL} views a second, and Postgres keeps up.`, `Tới giờ vẫn là ngày bình thường: ${NORMAL} lượt xem mỗi giây, và Postgres theo kịp.`);

  const detail = {
    today: ['Each view is one UPDATE on the hot row and one SELECT to show the count. At this rate the row lock is free almost all the time.', 'Mỗi lượt xem là một UPDATE trên dòng nóng và một SELECT để hiện số đếm. Ở tốc độ này khoá dòng gần như luôn rảnh.'],
    aside: ['Watch the red DELs: every view deletes the key, so the next reader misses and loads from Postgres. The cache almost never holds anything.', 'Để ý các lệnh DEL màu đỏ: mỗi lượt xem xoá key, nên người đọc sau miss và nạp từ Postgres. Cache gần như chẳng giữ được gì.'],
    through: ['Reads come from Redis, always fresh. But every view still waits for its UPDATE on Postgres.', 'Lượt đọc lấy từ Redis, luôn mới. Nhưng mỗi lượt xem vẫn chờ lệnh UPDATE của nó trên Postgres.'],
    readthrough: ['Reads come from Redis, which reloads from Postgres every 10 seconds, so the count on the page trails by up to 10 seconds. Every view still UPDATEs Postgres.', 'Lượt đọc lấy từ Redis, nạp lại từ Postgres mỗi 10 giây, nên số trên trang trễ tới 10 giây. Mỗi lượt xem vẫn UPDATE Postgres.'],
    behind: ['Views only touch Redis. Postgres sees nothing until the flush.', 'Lượt xem chỉ chạm Redis. Postgres không thấy gì cho tới lần flush.'],
  }[setup];
  add(2, null, ...detail);
  if (setup === 'behind' && r.flushes.length) {
    const f = r.flushes[0];
    add(f.t, null, `Flush: ${fmt(f.n)} views reach Postgres in ${f.rows === 1 ? 'one UPDATE' : `${f.rows} UPDATEs, one per article`}.`, `Flush: ${fmt(f.n)} lượt xem tới Postgres trong ${f.rows === 1 ? 'một lệnh UPDATE' : `${f.rows} lệnh UPDATE, mỗi bài viết một lệnh`}.`);
  }

  if (situation === 'news') {
    add(NEWS_AT, 'warn', 'Breaking news. Views climb toward 150,000 a second, almost all on a handful of articles.', 'Tin nóng. Lượt xem tăng dần tới 150.000 mỗi giây, gần như dồn hết vào vài bài viết.');
    if (setup === 'behind') {
      const big = r.flushes.find(f => f.t > PEAK_AT);
      if (big) add(big.t, null, `Flush: ${fmt(big.n)} views reach Postgres, still one UPDATE per article: ${big.rows} writes. Postgres does not notice the news.`, `Flush: ${fmt(big.n)} lượt xem tới Postgres, vẫn mỗi bài viết một lệnh UPDATE: ${big.rows} lượt ghi. Postgres không hề biết có tin nóng.`);
      add(20, null, 'Pages answer in about a millisecond: one INCR and one GET on Redis. The count on the page is fresh, because it is read from Redis, pending views included.', 'Trang trả lời trong khoảng một mili giây: một INCR và một GET trên Redis. Số trên trang luôn mới, vì nó được đọc từ Redis, tính cả các lượt đang chờ.');
    } else {
      const over = samples.find(s => s.wps > WRITE_BUDGET);
      add(over.t, 'bad', `Postgres is past its budget of ${WRITE_BUDGET} counter writes a second, on the way to 150,000. Every UPDATE on a hot row waits for the row lock held by the one before it.`, `Postgres đã vượt ngân sách ${WRITE_BUDGET} lượt ghi bộ đếm mỗi giây, trên đường tới 150.000. Mỗi UPDATE trên dòng nóng phải chờ khoá dòng mà lệnh trước đang giữ.`);
      const full = samples.find(s => s.conns >= POOL);
      if (full) add(full.t, 'bad', 'The UPDATEs queue up behind the lock and hold their connections while they wait. The pool is exhausted.', 'Các UPDATE xếp hàng sau khoá và giữ connection trong lúc chờ. Pool connection cạn.');
      const dead = samples.find(s => s.pageMs >= TIMEOUT_MS);
      if (dead) add(dead.t, 'bad', {
        today: 'Pages time out: each one waits in the lock queue for its UPDATE. The counter has taken the site down.',
        aside: 'Pages time out. The cache did not help: every view still UPDATEs Postgres, and since every view deletes the key, the reads go to Postgres too.',
        through: 'Pages time out. Redis has the fresh count, but each view waits for its UPDATE on Postgres before it can return.',
        readthrough: 'Pages time out. Reads were already coming from Redis; the UPDATEs, which are the problem, never changed.',
      }[setup], {
        today: 'Trang bị timeout: mỗi trang chờ UPDATE của nó trong hàng đợi khoá. Bộ đếm đã kéo sập trang web.',
        aside: 'Trang bị timeout. Cache không giúp gì: mỗi lượt xem vẫn UPDATE Postgres, và vì mỗi lượt xem xoá key, lượt đọc cũng tới Postgres.',
        through: 'Trang bị timeout. Redis có số mới, nhưng mỗi lượt xem phải chờ UPDATE của nó trên Postgres trước khi trả về.',
        readthrough: 'Trang bị timeout. Lượt đọc vốn đã lấy từ Redis; các UPDATE, chính là vấn đề, thì không hề đổi.',
      }[setup]);
    }
  }

  if (situation === 'crash') {
    if (setup === 'today') add(CRASH_AT, null, 'Redis restarts, but this setup does not use it. Nothing changes.', 'Redis khởi động lại, nhưng cách này không dùng nó. Không gì thay đổi.');
    else if (setup === 'behind') {
      const last = r.flushes.filter(f => f.t < CRASH_AT).at(-1);
      add(CRASH_AT, 'warn', `Redis dies and comes back empty. The ${fmt(r.lost)} views since the last flush at ${clock(last ? last.t : 0)} were only in Redis: they are lost, ${r.lostSec.toFixed(1)} seconds’ worth. The scenario allows a few seconds; AOF with fsync every second would shrink it.`, `Redis sập rồi khởi động lại trống rỗng. ${fmt(r.lost)} lượt xem kể từ lần flush lúc ${clock(last ? last.t : 0)} chỉ nằm trong Redis: chúng mất, tương đương ${r.lostSec.toFixed(1)} giây. Tình huống cho phép vài giây; AOF với fsync mỗi giây sẽ thu nhỏ nó hơn nữa.`);
      add(CRASH_AT + 1, null, 'The count is reloaded from Postgres and counting carries on.', 'Số đếm được nạp lại từ Postgres và việc đếm tiếp tục.');
    } else add(CRASH_AT, null, 'Redis dies and comes back empty. Nothing is lost: Postgres has every view, and the next read loads the count again.', 'Redis sập rồi khởi động lại trống rỗng. Không mất gì: Postgres có đủ mọi lượt xem, và lần đọc sau nạp lại số đếm.');
  }

  m.sort((a, b) => a.t - b.t);
  return m.map((x, i) => ({ ...x, t0: x.t, t1: i + 1 < m.length ? m[i + 1].t : T }));
}

const LABEL = {
  today: { en: 'No cache (today)', vi: 'Không cache (hiện tại)' },
  aside: { en: 'Cache-aside', vi: 'Cache-aside' },
  through: { en: 'Write-through', vi: 'Write-through' },
  readthrough: { en: 'Read-through', vi: 'Read-through' },
  behind: { en: 'Write-behind', vi: 'Write-behind' },
};
const SITUATION = {
  normal: { en: 'A normal day', vi: 'Một ngày bình thường' },
  news: { en: 'Breaking news', vi: 'Tin nóng' },
  crash: { en: 'Redis restarts', vi: 'Redis khởi động lại' },
};

export function mount(root, ctx) {
  let cached = null;   // the player asks for each run once; the drawing reads the same result
  return player(root, ctx, {
    situations: SITUATIONS.map(x => ({ value: x, label: tx(SITUATION[x]), icon: { normal: 'sun', news: 'bolt', crash: 'power' }[x] })),
    setups: SETUPS.map(x => ({ value: x, label: tx(LABEL[x]), icon: { today: 'db', aside: 'inbox', through: 'copy', readthrough: 'layers', behind: 'hourglass' }[x] })),
    open: ['today', 'aside'],
    initial: { situation: 'news' },
    run: (setup, situation) => (cached = run(setup, situation)),
    survives, height: 540,
    duration: st => Math.max(1.4, (st.t1 - st.t0) / 1.8),
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
const short = n => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));

function draw(g, w, h, r, t) {
  const { setup } = r;
  const s = r.at(t);
  g.clearRect(0, 0, w, h);
  g.textBaseline = 'middle';
  const text = (str, x, y, color = 'muted', font = mono(10, 400), align = 'left', max) => {
    g.font = font; g.textAlign = align; g.fillStyle = css(color); g.fillText(str, x, y, max);
  };
  const box = (x, y, bw, bh, rad, fill, stroke, alpha = 1) => {
    g.beginPath(); g.roundRect(x, y, bw, bh, rad);
    if (fill) { g.globalAlpha = alpha; g.fillStyle = css(fill); g.fill(); g.globalAlpha = 1; }
    if (stroke) { g.strokeStyle = css(stroke); g.stroke(); }
  };
  const dot = (x, y, rad, color, alpha = 1) => { g.globalAlpha = alpha; g.fillStyle = css(color); g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; };
  const timeout = s.pageMs >= TIMEOUT_MS;

  // ---- The strip: views and Postgres writes a second, log scale. ----
  const sx0 = 150, sx1 = w - 14, sy0 = 12, sy1 = 92;
  const X = tt => sx0 + (tt / T) * (sx1 - sx0);
  const Y = v => sy1 - (Math.log10(Math.max(1, v)) / 6) * (sy1 - sy0);
  text(tx({ en: 'PER SECOND', vi: 'MỖI GIÂY' }), 12, 20, 'muted', mono(10, 700));
  text(tx({ en: '— views', vi: '— lượt xem' }), 12, 38, 'faint', mono(10, 600));
  text(tx({ en: '— Postgres writes', vi: '— ghi Postgres' }), 12, 54, 'warn', mono(10, 600));
  text(tx({ en: '- - budget 300', vi: '- - ngân sách 300' }), 12, 70, 'bad', mono(10, 600));
  box(sx0, sy0, sx1 - sx0, sy1 - sy0, 6, 'bg2');
  for (const p of [10, 100, 1000, 1e4, 1e5]) {
    g.strokeStyle = css('line'); g.globalAlpha = 0.5; g.beginPath(); g.moveTo(sx0, Y(p)); g.lineTo(sx1, Y(p)); g.stroke(); g.globalAlpha = 1;
    text(short(p), sx0 + 4, Y(p) - 6, 'faint', mono(8.5, 400));
  }
  g.strokeStyle = css('bad'); g.setLineDash([4, 4]); g.beginPath(); g.moveTo(sx0, Y(WRITE_BUDGET)); g.lineTo(sx1, Y(WRITE_BUDGET)); g.stroke(); g.setLineDash([]);
  const upto = r.samples.filter(x => x.t <= t);
  const plot = (key, color, width) => {
    g.strokeStyle = css(color); g.lineWidth = width; g.beginPath();
    upto.forEach((x, i) => (i ? g.lineTo(X(x.t), Y(x[key])) : g.moveTo(X(x.t), Y(x[key]))));
    g.stroke(); g.lineWidth = 1;
  };
  plot('v', 'faint', 1.5);
  // Writes: red where they are over budget.
  g.save(); g.beginPath(); g.rect(sx0, sy0, sx1 - sx0, Y(WRITE_BUDGET) - sy0); g.clip(); plot('wps', 'bad', 2.5); g.restore();
  g.save(); g.beginPath(); g.rect(sx0, Y(WRITE_BUDGET), sx1 - sx0, sy1 - Y(WRITE_BUDGET)); g.clip(); plot('wps', 'warn', 2.5); g.restore();
  g.strokeStyle = css('text'); g.globalAlpha = 0.6; g.beginPath(); g.moveTo(X(t), sy0 - 2); g.lineTo(X(t), sy1 + 2); g.stroke(); g.globalAlpha = 1;
  text(clock(t), Math.min(X(t), sx1 - 16), sy1 + 11, 'faint', mono(9.5, 600), 'center');

  // ---- The row: readers, app, Redis, Postgres. ----
  const mid = 226;
  const nodeW = clamp(w * 0.19, 120, 190), nodeH = 150;
  const XR = clamp(w * 0.07, 44, 70), XA = w * 0.27, XC = w * 0.55, XD = w - 14 - nodeW / 2;
  const low = mid + nodeH / 2 + 44;   // the road from the app to Postgres, under Redis

  // Roads, then flows on them.
  const path = {
    view: f => [lerp(XR + 26, XA - nodeW / 2, f), mid],
    toRedis: f => [lerp(XA + nodeW / 2, XC - nodeW / 2, f), mid - 14],
    fromRedis: f => [lerp(XC - nodeW / 2, XA + nodeW / 2, f), mid + 14],
    redisDb: f => [lerp(XC + nodeW / 2, XD - nodeW / 2, f), mid],
    toDb: f => quad([XA, mid + nodeH / 2], [XC, low + 50], [XD - 20, mid + nodeH / 2], f),
    fromDb: f => quad([XD - 34, mid + nodeH / 2], [XC, low + 30], [XA + 14, mid + nodeH / 2], f),
  };
  const trace = (fn, color) => {
    g.save(); g.strokeStyle = css(color || 'line'); g.globalAlpha = color ? 0.55 : 1; g.lineWidth = color ? 1.5 : 1; g.setLineDash(color ? [6, 6] : [3, 5]);
    g.beginPath(); for (let i = 0; i <= 30; i++) { const [x, y] = fn(i / 30); i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); g.restore();
  };
  // A stream: dots moving along a path, as many as the rate's order of magnitude allows.
  const stream = (fn, rate, color, speed = 0.9, phase = 0) => {
    if (rate <= 0) return;
    trace(fn, color);
    const k = clamp(Math.round(Math.log10(rate + 1) * 3), 1, 18);
    for (let i = 0; i < k; i++) {
      const f = (t * speed + i / k + phase) % 1;
      const [x, y] = fn(f);
      dot(x, y, rate > 1e4 ? 3.6 : 3, color, 0.95);
    }
  };
  const label = (fn, f, str, color, dy = -12) => { if (/ 0\/s$/.test(str)) return; const [x, y] = fn(f); text(str, x, y + dy, color, mono(9.5, 700), 'center'); };

  for (const fn of [path.view, path.toRedis, path.fromRedis, path.redisDb, path.toDb, path.fromDb]) trace(fn);
  stream(path.view, s.v, 'text', 1.1);
  label(path.view, 0.5, `${short(s.v)}/s`, 'muted');
  if (setup === 'today' || setup === 'aside' || setup === 'through' || setup === 'readthrough') {
    stream(path.toDb, s.writes, timeout ? 'bad' : 'warn', 0.7);
    label(path.toDb, 0.5, `UPDATE +1 · ${short(s.writes)}/s`, timeout ? 'bad' : 'warn', 22);
  }
  if (s.reads > 1 && (setup === 'today' || setup === 'aside')) {
    stream(path.fromDb, s.reads, 'violet', 0.7, 0.3);
    label(path.fromDb, 0.62, `SELECT · ${short(s.reads)}/s`, 'violet', -12);
  }
  if (setup === 'aside') {
    stream(path.toRedis, s.dels, 'bad', 1);
    label(path.toRedis, 0.5, `DEL · ${short(s.dels)}/s`, 'bad', -12);
    stream(path.fromRedis, s.gets, 'muted', 1, 0.5);
    label(path.fromRedis, 0.5, tx({ en: 'miss', vi: 'miss' }), 'muted', 14);
  }
  if (setup === 'through' || setup === 'behind') {
    stream(path.toRedis, s.incr, 'warn', 1);
    label(path.toRedis, 0.5, `INCR · ${short(s.incr)}/s`, 'warn', -12);
  }
  if (setup === 'through' || setup === 'behind' || setup === 'readthrough') {
    stream(path.fromRedis, s.gets, 'blue', 1, 0.5);
    label(path.fromRedis, 0.5, `GET · ${short(s.gets)}/s`, 'blue', 14);
  }
  // Discrete trips: write-behind's flushes, read-through's loads.
  for (const f of r.flushes) if (t >= f.t && t < f.t + 1.2) {
    const p = (t - f.t) / 1.2, [x, y] = path.redisDb(p), [fx, fy] = path.redisDb(Math.max(0, p - 0.1));
    message(g, x, y - 18, `UPDATE +${short(f.n)}`, 'ok', null, [fx, fy - 18]);
  }
  for (const l of r.loads) if (t >= l.t && t < l.t + 1) {
    const p = (t - l.t) / 1, [x, y] = path.redisDb(1 - p), [fx, fy] = path.redisDb(Math.min(1, 1.1 - p));
    message(g, x, y - 18, 'LOAD', 'violet', null, [fx, fy - 18]);
  }

  // Readers.
  const rv = Math.log10(s.v) / Math.log10(PEAK);
  for (let i = 0; i < 12; i++) {
    const cx = XR - 14 + (i % 3) * 14, cy = mid - 40 + Math.floor(i / 3) * 24;
    const on = (i / 12) < rv * 1.05 || i === 0;
    icon(g, 'user', cx, cy, 13, on ? (s.v > 1e4 ? 'warn' : 'text') : 'faint');
  }
  text(tx({ en: 'readers', vi: 'người đọc' }), XR, mid + 66, 'muted', mono(10, 600), 'center');

  // App.
  node(g, { x: XA, y: mid, w: nodeW, h: nodeH, title: tx({ en: 'App', vi: 'App' }), icon: 'server', color: 'blue', alert: timeout });
  text(tx({ en: 'page takes', vi: 'trang mất' }), XA, mid - 16, 'muted', sans(11), 'center');
  text(timeout ? tx({ en: 'timeout', vi: 'timeout' }) : `${s.pageMs < 10 ? s.pageMs.toFixed(1) : fmt(s.pageMs)} ms`, XA, mid + 6, timeout ? 'bad' : s.pageMs > 100 ? 'warn' : 'ok', mono(18, 700), 'center');
  const shows = timeout ? '—' : s.shown == null ? '…' : fmt(s.shown);
  text(tx({ en: `page shows ${shows}`, vi: `trang hiện ${shows}` }), XA, mid + 30, 'text', mono(10, 600), 'center', nodeW - 12);
  const trailing = !timeout && s.trail > 0.5;
  text(timeout ? tx({ en: 'readers get an error', vi: 'người đọc nhận lỗi' }) : trailing ? tx({ en: `${s.trail.toFixed(0)} s behind`, vi: `trễ ${s.trail.toFixed(0)} giây` }) : tx({ en: 'fresh', vi: 'mới' }), XA, mid + 48, timeout ? 'bad' : trailing ? 'warn' : 'faint', mono(9.5, 600), 'center', nodeW - 12);

  // Redis.
  const unused = setup === 'today';
  node(g, { x: XC, y: mid, w: nodeW, h: nodeH, title: 'Redis', icon: 'db', color: 'bad', dim: unused, alert: s.down });
  if (unused) text(tx({ en: 'not used', vi: 'không dùng' }), XC, mid + 6, 'faint', mono(11, 600), 'center');
  else if (s.down) text(tx({ en: 'restarting…', vi: 'đang khởi động lại…' }), XC, mid + 4, 'bad', mono(12, 700), 'center');
  else {
    const cv = setup === 'aside' ? null : s.cache;
    text('views:42', XC, mid - 16, 'faint', mono(9.5, 600), 'center');
    text(cv == null ? tx({ en: '(empty)', vi: '(trống)' }) : fmt(cv), XC, mid + 4, cv == null ? 'faint' : 'text', mono(cv == null ? 12 : 15, 700), 'center', nodeW - 14);
    const sub = setup === 'behind' ? [tx({ en: `pending +${fmt(s.pending)}`, vi: `đang chờ +${fmt(s.pending)}` }), 'warn']
      : setup === 'readthrough' ? [tx({ en: `reloads in ${Math.max(0, Math.ceil(TTL - ((t - (r.loads.filter(l => l.t <= t).at(-1)?.t ?? 0)))))} s`, vi: `nạp lại sau ${Math.max(0, Math.ceil(TTL - ((t - (r.loads.filter(l => l.t <= t).at(-1)?.t ?? 0)))))} giây` }), 'violet']
      : setup === 'aside' ? [tx({ en: 'deleted on every view', vi: 'bị xoá mỗi lượt xem' }), 'bad']
      : [tx({ en: 'updated on every view', vi: 'cập nhật mỗi lượt xem' }), 'muted'];
    text(sub[0], XC, mid + 28, sub[1], mono(10, 600), 'center', nodeW - 12);
    if (setup === 'behind') {
      const sinceFlush = t % FLUSH;
      box(XC - nodeW / 2 + 14, mid + 44, nodeW - 28, 6, 3, 'bg2');
      box(XC - nodeW / 2 + 14, mid + 44, (nodeW - 28) * (sinceFlush / FLUSH), 6, 3, 'warn');
    }
  }

  // Postgres: the hot row, its lock, the queue behind it, the pool.
  const busy = s.queue > 0 || timeout;
  node(g, { x: XD, y: mid, w: nodeW, h: nodeH, title: 'Postgres', icon: 'table', color: 'blue', alert: busy, active: r.flushes.some(f => t >= f.t + 1 && t < f.t + 1.6) });
  const rx = XD - nodeW / 2 + 12, rw = nodeW - 24;
  box(rx, mid - 24, rw, 22, 5, 'bg2', s.queue > 0 ? 'bad' : 'line');
  text(`#42 views ${short(s.db)}`, rx + 8, mid - 13, 'text', mono(10, 700), 'left', rw - 26);
  // The padlock: shut and red while UPDATEs queue for it.
  const lx = rx + rw - 11, ly = mid - 14, locked = s.writes > 0 && setup !== 'behind' && s.v > NORMAL;
  g.strokeStyle = css(s.queue > 0 ? 'bad' : 'muted'); g.lineWidth = 1.5;
  g.beginPath(); g.arc(lx, ly - 3, 3.5, Math.PI, 0); g.stroke(); g.lineWidth = 1;
  box(lx - 5, ly - 3, 10, 8, 2, s.queue > 0 ? 'bad' : locked ? 'warn' : 'muted');
  // The queue for the lock.
  const qn = Math.min(10, Math.ceil(Math.log10(s.queue + 1) * 2));
  for (let i = 0; i < qn; i++) box(rx + (i % 5) * (rw / 5) + 1, mid + 6 + Math.floor(i / 5) * 12, rw / 5 - 3, 9, 2, 'bad', null, 0.75);
  text(s.queue > 0 ? tx({ en: `${short(s.queue)} UPDATEs waiting`, vi: `${short(s.queue)} UPDATE đang chờ` }) : tx({ en: 'no lock queue', vi: 'không có hàng chờ khoá' }), XD, mid + 36, s.queue > 0 ? 'bad' : 'faint', mono(9.5, 700), 'center', nodeW - 12);
  // The connection pool.
  box(rx, mid + 48, rw, 6, 3, 'bg2');
  box(rx, mid + 48, rw * (s.conns / POOL), 6, 3, s.conns >= POOL ? 'bad' : s.conns > 50 ? 'warn' : 'ok');
  text(tx({ en: `connections ${s.conns}/${POOL}`, vi: `connection ${s.conns}/${POOL}` }), XD, mid + 62, s.conns >= POOL ? 'bad' : 'faint', mono(9, 600), 'center', nodeW - 12);

  // ---- The constraints, live. ----
  const cy0 = h - 112, half = (w - 28) / 2;
  const past = r.samples.filter(x => x.t <= t);
  const maxW = Math.max(...past.map(x => x.wps)), maxMs = Math.max(...past.map(x => x.pageMs));
  const lostNow = r.situation === 'crash' && t >= CRASH_AT ? r.lost : 0;
  const rows = [
    [maxW <= WRITE_BUDGET, tx({ en: 'Postgres: ≤ 300 counter writes/s', vi: 'Postgres: ≤ 300 lượt ghi bộ đếm/giây' }), tx({ en: `peak so far ${fmt(maxW)}/s`, vi: `đỉnh tới giờ ${fmt(maxW)}/giây` })],
    [maxMs < TIMEOUT_MS ? (setup === 'behind' ? true : 'note') : false, tx({ en: 'A page view never waits on Postgres', vi: 'Lượt xem không phải chờ Postgres' }),
      setup === 'behind' ? tx({ en: 'Redis only', vi: 'chỉ Redis' }) : maxMs >= TIMEOUT_MS ? tx({ en: 'pages timed out', vi: 'trang bị timeout' }) : tx({ en: `waits, ${maxMs.toFixed(1)} ms for now`, vi: `có chờ, ${maxMs.toFixed(1)} ms lúc này` })],
    [true, tx({ en: 'Count may trail by a few seconds', vi: 'Số đếm được trễ vài giây' }), setup === 'readthrough' ? tx({ en: 'up to 10 s', vi: 'tới 10 giây' }) : tx({ en: 'fresh', vi: 'mới' })],
    [lostNow / NORMAL > LOSS_OK ? false : lostNow ? 'note' : true, tx({ en: 'Redis dies: lose ≤ a few s of views', vi: 'Redis sập: mất ≤ vài giây lượt xem' }),
      setup === 'behind' ? (lostNow ? tx({ en: `lost ${fmt(lostNow)} (${r.lostSec.toFixed(1)} s)`, vi: `mất ${fmt(lostNow)} (${r.lostSec.toFixed(1)} giây)` }) : tx({ en: `would lose ≤ ${FLUSH} s`, vi: `có thể mất ≤ ${FLUSH} giây` })) : tx({ en: 'nothing to lose', vi: 'không mất gì' })],
  ];
  text(tx({ en: 'CONSTRAINTS', vi: 'RÀNG BUỘC' }), 14, cy0 - 10, 'muted', mono(10, 700));
  rows.forEach(([pass, what, detail], i) => {
    const x = 14 + (i % 2) * (half + 0), y = cy0 + 6 + Math.floor(i / 2) * 40;
    const color = pass === true ? 'ok' : pass === 'note' ? 'warn' : 'bad';
    box(x, y, half - 8, 34, 8, color, null, 0.1);
    icon(g, pass === true ? 'check' : pass === 'note' ? 'alert' : 'cross', x + 16, y + 17, 14, color);
    text(what, x + 32, y + 11, 'text', sans(11.5, 600), 'left', half - 50);
    text(detail, x + 32, y + 25, color, mono(9.5, 600), 'left', half - 50);
  });
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, f) => a + (b - a) * f;
const quad = (a, c, b, f) => {
  const q = 1 - f;
  return [q * q * a[0] + 2 * q * f * c[0] + f * f * b[0], q * q * a[1] + 2 * q * f * c[1] + f * f * b[1]];
};
