/* App, Redis and Postgres side by side. The visitor sends views and reads (or turns on
   breaking news) and watches each request travel: which box it touches, in which
   order, and what each box holds afterwards. Postgres counts its writes; the reader's
   number turns red when it trails the true count; crashing Redis shows what each
   strategy loses. Before the visitor answers, only today's setup and cache-aside are
   unlocked. */

import { el } from '../../js/dom.js';
import { tx } from '../../js/i18n.js';
import { canvas, choice, button, stat, css, row, onResize, reducedMotion } from '../../js/sim-kit.js';

export const TTL = 6;       // read-through keeps a loaded count this long (seconds on screen)
export const FLUSH = 4;     // write-behind flushes this often
export const START = 1000;  // views before the visitor starts
/* The scenario's own settings, for the comparison table: the on-screen TTL and flush
   are shorter so the visitor does not wait. */
export const PROD = { ttl: 10, flush: 5 };

export const STRATEGIES = ['today', 'aside', 'through', 'behind', 'readthrough'];

/* One article's counter under a strategy. Each operation returns the hops it makes:
   [{ from, to, label, kind, say, state }] where state is a snapshot after the hop.
   Pure apart from its own state, so the behaviour is pinned by
   tests/caching-strategies.test.js. Times are seconds. */
export function system(strategy) {
  const cached = strategy !== 'today';
  const s = {
    truth: START, db: START, cache: cached ? START : null, expires: TTL, pending: 0,
    writes: 0, reads: 0, hits: 0, misses: 0, lost: 0, seen: null, seenTruth: null,
  };
  const out = [];
  const hop = (from, to, label, kind, say, change) => {
    if (change) change();
    out.push({ from, to, label, kind, say, state: { ...s } });
  };
  const take = () => out.splice(0);
  const answer = (from, value) => hop(from, 'app', value.toLocaleString('en'), 'value',
    { en: `The reader sees ${value.toLocaleString('en')}.`, vi: `Người đọc thấy ${value.toLocaleString('en')}.` },
    () => { s.seen = value; s.seenTruth = s.truth; });
  // On a miss, the app loads the count from Postgres and puts it in Redis.
  const lazyLoad = extra => {
    hop('redis', 'app', 'miss', 'miss', { en: 'Cache miss: the key is not in Redis.', vi: 'Cache miss: key không có trong Redis.' }, () => { s.misses++; });
    hop('app', 'db', 'SELECT', 'load', { en: 'The app reads the count from Postgres itself.', vi: 'App tự đọc số đếm từ Postgres.' }, () => { s.reads++; });
    hop('db', 'app', s.db.toLocaleString('en'), 'value', { en: 'Postgres returns the count.', vi: 'Postgres trả về số đếm.' });
    hop('app', 'redis', 'SET', 'set', { en: 'The app puts it in Redis for the next reader.', vi: 'App đưa nó vào Redis cho người đọc sau.' }, () => { s.cache = s.db + extra; });
  };

  return {
    state: s,

    /* n page views (one chip for a batch). */
    view(t, n = 1) {
      const plus = n === 1 ? '+1' : `+${n}`;
      const updates = n === 1 ? 'UPDATE +1' : `${n}× UPDATE`;
      if (strategy === 'today') {
        hop('app', 'db', updates, 'write', { en: `${n === 1 ? 'A view' : `${n} views`}: each one runs an UPDATE on the same hot row in Postgres.`, vi: `${n === 1 ? 'Một lượt xem' : `${n} lượt xem`}: mỗi lượt chạy một lệnh UPDATE trên cùng dòng nóng trong Postgres.` },
          () => { s.truth += n; s.db += n; s.writes += n; });
      } else if (strategy === 'aside') {
        hop('app', 'db', updates, 'write', { en: 'Cache-aside write: the app updates Postgres first, once per view…', vi: 'Ghi kiểu cache-aside: app cập nhật Postgres trước, mỗi lượt xem một lần…' },
          () => { s.truth += n; s.db += n; s.writes += n; });
        hop('app', 'redis', 'DEL', 'del', { en: '…then deletes the key in Redis, so the next read has to reload it.', vi: '…rồi xoá key trong Redis, nên lần đọc sau phải nạp lại.' },
          () => { s.cache = null; });
      } else if (strategy === 'through') {
        hop('app', 'redis', plus, 'write', { en: 'Write-through: the app updates Redis…', vi: 'Write-through: app cập nhật Redis…' },
          () => { s.truth += n; if (s.cache != null) s.cache += n; });
        hop('app', 'db', updates, 'write', { en: '…and Postgres in the same request, once per view. The page view waits for both.', vi: '…và Postgres trong cùng request, mỗi lượt xem một lần. Lượt xem trang phải chờ cả hai.' },
          () => { s.db += n; s.writes += n; });
      } else if (strategy === 'readthrough') {
        hop('app', 'db', updates, 'write', { en: 'Read-through only handles reads: views still UPDATE Postgres directly. Redis keeps its old copy until it expires.', vi: 'Read-through chỉ lo phần đọc: lượt xem vẫn UPDATE thẳng Postgres. Redis giữ bản cũ cho tới khi hết hạn.' },
          () => { s.truth += n; s.db += n; s.writes += n; });
      } else if (strategy === 'behind') {
        hop('app', 'redis', `INCR ${plus}`, 'write', { en: 'Write-behind: the view only increments Redis and returns at once. Postgres is not touched; the increment waits as "pending".', vi: 'Write-behind: lượt xem chỉ tăng số trong Redis rồi trả về ngay. Không chạm tới Postgres; lượt tăng nằm chờ ở "pending".' },
          () => { s.truth += n; s.pending += n; if (s.cache != null) s.cache += n; });
      }
      return take();
    },

    /* A reader loads the article and reads the count. */
    read(t) {
      if (strategy === 'today') {
        hop('app', 'db', 'SELECT', 'load', { en: 'No cache: every read goes to Postgres.', vi: 'Không có cache: mọi lần đọc đều tới Postgres.' }, () => { s.reads++; });
        answer('db', s.db);
        return take();
      }
      hop('app', 'redis', 'GET', 'read', { en: 'A reader opens the article: the app asks Redis for the count.', vi: 'Một người đọc mở bài: app hỏi Redis số đếm.' });
      if (strategy === 'readthrough') {
        if (s.cache != null && t < s.expires) {
          hop('redis', 'redis', 'hit', 'hit', { en: `Cache hit: Redis still has a copy (expires in ${Math.ceil(s.expires - t)} s), even if Postgres has moved on.`, vi: `Cache hit: Redis vẫn còn bản sao (hết hạn sau ${Math.ceil(s.expires - t)} giây), dù Postgres đã đổi.` }, () => { s.hits++; });
        } else {
          hop('redis', 'db', 'LOAD', 'load', { en: 'Expired or missing: Redis itself loads the count from Postgres. The app never talks to Postgres for reads.', vi: 'Hết hạn hoặc không có: chính Redis nạp số đếm từ Postgres. App không bao giờ đọc thẳng Postgres.' }, () => { s.misses++; s.reads++; });
          hop('db', 'redis', s.db.toLocaleString('en'), 'value', { en: `Redis keeps it for ${TTL} s.`, vi: `Redis giữ nó ${TTL} giây.` }, () => { s.cache = s.db; s.expires = t + TTL; });
        }
        answer('redis', s.cache);
        return take();
      }
      if (s.cache != null) hop('redis', 'redis', 'hit', 'hit', { en: 'Cache hit.', vi: 'Cache hit.' }, () => { s.hits++; });
      else lazyLoad(strategy === 'behind' ? s.pending : 0);
      answer('redis', s.cache);
      return take();
    },

    /* Write-behind's background job: move pending increments to Postgres in one write. */
    flush() {
      if (strategy !== 'behind' || !s.pending) return [];
      const n = s.pending;
      hop('redis', 'db', `UPDATE +${n}`, 'flush', { en: `Flush: ${n} views reach Postgres in ONE update. This is the only write Postgres sees.`, vi: `Flush: ${n} lượt xem tới Postgres trong MỘT lệnh cập nhật. Đây là lượt ghi duy nhất Postgres nhận.` },
        () => { s.db += n; s.writes++; s.pending = 0; });
      return take();
    },

    /* Redis dies and comes back empty. */
    crash() {
      if (strategy === 'today') return [];
      const lost = s.pending;
      hop('redis', 'redis', 'crash', 'crash', lost
        ? { en: `Redis crashed: the cached count is gone, and so are ${lost} views that had not been flushed yet.`, vi: `Redis sập: số đếm trong cache mất, cùng ${lost} lượt xem chưa kịp flush.` }
        : { en: 'Redis crashed and came back empty. Nothing is lost: Postgres has every view. The next read reloads it.', vi: 'Redis sập rồi khởi động lại trống rỗng. Không mất gì: Postgres có đủ mọi lượt xem. Lần đọc sau sẽ nạp lại.' },
        () => { s.lost += lost; s.pending = 0; s.cache = null; s.expires = 0; });
      return take();
    },
  };
}

/* The same strategies at the scenario's scale, for the comparison table. */
export function atScale(strategy, { views = 150000, articles = 200 } = {}) {
  const reads = views;   // every view also shows the count
  return {
    dbWrites: strategy === 'behind' ? articles / PROD.flush : views,
    dbReads: { today: reads, aside: reads, through: 0, behind: 0, readthrough: articles / PROD.ttl }[strategy],
    staleUpTo: strategy === 'readthrough' ? PROD.ttl : 0,
    lostUpTo: strategy === 'behind' ? PROD.flush : 0,
    viewWaitsOnDb: strategy !== 'behind',
  };
}

const LABEL = {
  today: { en: 'No cache (today)', vi: 'Không cache (hiện tại)' },
  aside: { en: 'Cache-aside', vi: 'Cache-aside' },
  through: { en: 'Write-through', vi: 'Write-through' },
  behind: { en: 'Write-behind', vi: 'Write-behind' },
  readthrough: { en: 'Read-through', vi: 'Read-through' },
};
const HOW = {
  today: { en: 'Every view is an UPDATE and every read a SELECT, all on the same Postgres row.', vi: 'Mỗi lượt xem là một UPDATE và mỗi lần đọc là một SELECT, tất cả trên cùng một dòng Postgres.' },
  aside: { en: 'The app owns the cache: it reads Redis, loads from Postgres on a miss, and after a write updates Postgres and deletes the key.', vi: 'App tự quản lý cache: đọc Redis, nạp từ Postgres khi miss, và sau khi ghi thì cập nhật Postgres rồi xoá key.' },
  through: { en: 'Every write goes to Redis and Postgres together, in the same request. Redis is always up to date.', vi: 'Mọi lượt ghi đi tới Redis và Postgres cùng lúc, trong cùng request. Redis luôn được cập nhật.' },
  behind: { en: 'Writes go to Redis only and pile up as "pending". A background job flushes them to Postgres in one update every few seconds.', vi: 'Lượt ghi chỉ đi tới Redis và dồn lại ở "pending". Một job nền flush chúng xuống Postgres bằng một lệnh cập nhật mỗi vài giây.' },
  readthrough: { en: 'Redis loads missing or expired values from Postgres itself and keeps them for a while. Writes go straight to Postgres.', vi: 'Redis tự nạp giá trị thiếu hoặc hết hạn từ Postgres và giữ một lúc. Lượt ghi đi thẳng tới Postgres.' },
};
const KIND = { read: 'blue', write: 'warn', del: 'bad', load: 'violet', set: 'ok', value: 'ok', miss: 'muted', hit: 'ok', flush: 'ok', crash: 'bad' };

const n = v => v.toLocaleString('en');

export function mount(root, { revealed, state }) {
  const s = Object.assign(state, { strategy: 'today', ...state });
  const isLocked = v => !revealed && !['today', 'aside'].includes(v);
  if (isLocked(s.strategy)) s.strategy = 'today';

  const chart = canvas(270);
  const how = el('p', { class: 'sim-how' });
  const caption = el('p', { class: 'sim-event', 'aria-live': 'polite' });
  const writes = stat(tx({ en: 'Postgres writes', vi: 'Lượt ghi Postgres' }));
  const reads = stat(tx({ en: 'Postgres reads', vi: 'Lượt đọc Postgres' }));
  const hits = stat(tx({ en: 'Cache hits / misses', vi: 'Cache hit / miss' }));
  const lost = stat(tx({ en: 'Views lost', vi: 'Lượt xem bị mất' }));
  const table = el('div', { class: 'sim-board' });
  const slow = reducedMotion();

  let sys, queue, cur, shown, t0, raf = 0, news = null, flusher = null, writeTimes = [];
  const now = () => performance.now() / 1000 - t0;

  function reset() {
    sys = system(s.strategy);
    queue = []; cur = null; shown = { ...sys.state }; writeTimes = [];
    t0 = performance.now() / 1000;
    how.textContent = tx(HOW[s.strategy]);
    caption.textContent = tx({ en: 'Send a view or read the count to see where each request goes.', vi: 'Gửi một lượt xem hoặc đọc số đếm để xem mỗi request đi đâu.' });
    caption.className = 'sim-event';
    clearInterval(flusher);
    flusher = s.strategy === 'behind' ? setInterval(() => enqueue(sys.flush(now())), FLUSH * 1000) : null;
    paintStats();
  }
  const enqueue = hops => { queue.push(...hops); };

  function paintStats() {
    writes.set(n(shown.writes), shown.writes > 40 ? 'bad' : '');
    reads.set(n(shown.reads));
    hits.set(s.strategy === 'today' ? '–' : `${shown.hits} / ${shown.misses}`);
    lost.set(String(shown.lost), shown.lost ? 'bad' : 'ok');
  }

  function frame() {
    const t = now();
    if (!cur && queue.length) {
      const d = slow ? 0.05 : Math.max(0.1, 0.45 / (1 + queue.length / 5));
      cur = { ...queue.shift(), start: t, d };
      caption.textContent = tx(cur.say);
      caption.className = `sim-event ${cur.kind === 'crash' && cur.state.lost > shown.lost ? 'bad-text' : ''}`;
    }
    if (cur && t - cur.start >= cur.d) {
      if (cur.state.writes > shown.writes) for (let i = shown.writes; i < cur.state.writes; i++) writeTimes.push(t);
      shown = cur.state;
      cur = null;
      paintStats();
    }
    draw(t);
    raf = requestAnimationFrame(frame);
  }

  function draw(t) {
    const { w, h } = chart.fit();
    const g = chart.g, mid = 130;
    const X = { app: w * 0.13, redis: w * 0.5, db: w * 0.86 };
    const bw = Math.min(150, w * 0.24), bh = 96;
    g.clearRect(0, 0, w, h);
    g.textAlign = 'center'; g.textBaseline = 'middle';

    // Roads between the boxes.
    g.strokeStyle = css('line'); g.setLineDash([3, 5]);
    g.beginPath(); g.moveTo(X.app + bw / 2, mid); g.lineTo(X.redis - bw / 2, mid); g.moveTo(X.redis + bw / 2, mid); g.lineTo(X.db - bw / 2, mid);
    g.moveTo(X.app, mid + bh / 2); g.quadraticCurveTo(X.redis, mid + bh / 2 + 90, X.db, mid + bh / 2); g.stroke(); g.setLineDash([]);

    const box = (x, title, lines, color = 'line', faded = false) => {
      g.globalAlpha = faded ? 0.45 : 1;
      g.fillStyle = css('surface2'); g.strokeStyle = css(color); g.lineWidth = color === 'line' ? 1 : 2;
      g.beginPath(); g.roundRect(x - bw / 2, mid - bh / 2, bw, bh, 12); g.fill(); g.stroke(); g.lineWidth = 1;
      g.fillStyle = css('muted'); g.font = '600 11px "IBM Plex Mono", monospace';
      g.fillText(title.toUpperCase(), x, mid - bh / 2 + 14);
      lines.forEach(([text, c, size = 13], i) => {
        g.fillStyle = css(c); g.font = `${i === 0 ? 700 : 500} ${size}px "IBM Plex Mono", monospace`;
        g.fillText(text, x, mid - 12 + i * 22, bw - 10);
      });
      g.globalAlpha = 1;
    };

    // App: the true count and what the last reader saw.
    const behind = shown.seen == null ? 0 : shown.seenTruth - shown.seen;
    box(X.app, tx({ en: 'App', vi: 'App' }), [
      [shown.seen == null ? '—' : n(shown.seen), shown.seen == null ? 'muted' : behind > 0 ? 'bad' : 'ok', 18],
      [shown.seen == null ? tx({ en: 'no read yet', vi: 'chưa đọc' }) : behind > 0 ? tx({ en: `${behind} behind`, vi: `trễ ${behind}` }) : tx({ en: 'reader sees', vi: 'người đọc thấy' }), behind > 0 ? 'bad' : 'muted', 11],
    ], behind > 0 ? 'bad' : 'line');
    g.fillStyle = css('muted'); g.font = '11px "IBM Plex Mono", monospace';
    g.fillText(tx({ en: `true views: ${n(shown.truth)}`, vi: `lượt xem thật: ${n(shown.truth)}` }), X.app, mid - bh / 2 - 12);

    // Redis: the cached count, pending increments, TTL.
    if (s.strategy === 'today') box(X.redis, 'Redis', [[tx({ en: 'not used', vi: 'không dùng' }), 'faint', 12]], 'line', true);
    else {
      const crashed = cur && cur.kind === 'crash';
      const lines = [[shown.cache == null ? tx({ en: '(empty)', vi: '(trống)' }) : n(shown.cache), shown.cache == null ? 'faint' : 'text', 18]];
      if (s.strategy === 'behind') lines.push([tx({ en: `pending +${shown.pending}`, vi: `chờ +${shown.pending}` }), shown.pending ? 'warn' : 'muted', 11]);
      if (s.strategy === 'readthrough' && shown.cache != null) lines.push([tx({ en: `expires in ${Math.max(0, Math.ceil(shown.expires - t))} s`, vi: `hết hạn sau ${Math.max(0, Math.ceil(shown.expires - t))} giây` }), 'muted', 11]);
      box(X.redis, 'Redis', lines, crashed ? 'bad' : 'line');
    }

    // Postgres: the stored count, total writes and the write rate right now.
    writeTimes = writeTimes.filter(x => t - x < 2);
    const rate = writeTimes.length / 2;
    box(X.db, 'Postgres', [
      [n(shown.db), 'text', 18],
      [tx({ en: `writes: ${n(shown.writes)}`, vi: `lượt ghi: ${n(shown.writes)}` }), shown.writes > 40 ? 'bad' : 'muted', 11],
    ], rate > 8 ? 'bad' : 'line');
    const meterW = bw - 20, my = mid + bh / 2 + 10;
    g.fillStyle = css('bg2'); g.fillRect(X.db - meterW / 2, my, meterW, 7);
    g.fillStyle = css(rate > 8 ? 'bad' : rate > 3 ? 'warn' : 'ok'); g.fillRect(X.db - meterW / 2, my, meterW * Math.min(1, rate / 20), 7);
    g.fillStyle = css('muted'); g.font = '10px "IBM Plex Mono", monospace';
    g.fillText(tx({ en: `${rate.toFixed(1)} writes/s`, vi: `${rate.toFixed(1)} lượt ghi/giây` }), X.db, my + 18);

    // The request in flight.
    if (cur) {
      const p = Math.min(1, (t - cur.start) / cur.d);
      const pos = node => [X[node], mid];
      const [x1] = pos(cur.from), [x2] = pos(cur.to);
      let x, y;
      if (cur.from === cur.to) { x = x1; y = mid - bh / 2 - 16 - Math.sin(p * Math.PI) * 10; }
      else if ((cur.from === 'app' && cur.to === 'db') || (cur.from === 'db' && cur.to === 'app')) {
        // The low road under Redis.
        const sx = cur.from === 'app' ? X.app : X.db, ex = cur.to === 'app' ? X.app : X.db, sy = mid + bh / 2;
        const q = 1 - p;
        x = q * q * sx + 2 * q * p * X.redis + p * p * ex;
        y = q * q * sy + 2 * q * p * (sy + 90) + p * p * sy;
      } else {
        // Between neighbouring boxes, edge to edge: rightwards above the road, leftwards below.
        const dir = Math.sign(x2 - x1);
        x = x1 + dir * bw / 2 + ((x2 - dir * bw / 2) - (x1 + dir * bw / 2)) * p;
        y = mid + (dir > 0 ? -14 : 14);
      }
      g.font = '700 11px "IBM Plex Mono", monospace';
      const tw = g.measureText(cur.label).width + 14;
      g.fillStyle = css(KIND[cur.kind] || 'blue');
      g.beginPath(); g.roundRect(x - tw / 2, y - 11, tw, 22, 6); g.fill();
      g.fillStyle = css('bg'); g.fillText(cur.label, x, y + 1);
    }
    if (queue.length > 3) {
      g.fillStyle = css('muted'); g.font = '10px "IBM Plex Mono", monospace'; g.textAlign = 'left';
      g.fillText(tx({ en: `${queue.length} steps queued`, vi: `${queue.length} bước đang chờ` }), 8, h - 10);
    }
  }

  function toggleNews() {
    if (news) { clearInterval(news); news = null; }
    else {
      let tick = 0;   // a burst of views every tick, a reader every other tick
      news = setInterval(() => { enqueue(sys.view(now(), 5)); if (tick++ % 2) enqueue(sys.read(now())); }, 600);
    }
    newsBtn.textContent = news ? tx({ en: 'Breaking news: on', vi: 'Tin nóng: bật' }) : tx({ en: 'Breaking news: off', vi: 'Tin nóng: tắt' });
    newsBtn.classList.toggle('on', !!news);
  }

  /* After answering: all strategies at the scenario's scale. */
  function paintTable() {
    table.textContent = '';
    if (!revealed) return;
    const cell = (text, tone = '') => el('td', { class: tone }, text);
    table.append(
      el('p', { class: 'sim-lbl' }, tx({ en: 'At the scenario’s scale: 150,000 views/s on 200 articles', vi: 'Ở quy mô của tình huống: 150.000 lượt xem/giây trên 200 bài viết' })),
      el('table', {}, [
        el('thead', {}, el('tr', {}, [el('th', {}, ''), ...[
          { en: 'Postgres writes/s', vi: 'Ghi Postgres/giây' }, { en: 'Postgres reads/s', vi: 'Đọc Postgres/giây' },
          { en: 'Readers see', vi: 'Người đọc thấy' }, { en: 'If Redis dies', vi: 'Nếu Redis sập' }, { en: 'View waits on Postgres', vi: 'Lượt xem chờ Postgres' },
        ].map(x => el('th', {}, tx(x)))])),
        el('tbody', {}, STRATEGIES.map(st => {
          const r = atScale(st);
          return el('tr', { class: st === s.strategy ? 'on' : '' }, [
            el('th', {}, tx(LABEL[st])),
            cell(n(Math.round(r.dbWrites)), r.dbWrites > 1000 ? 'bad' : 'ok'),
            cell(n(Math.round(r.dbReads)), r.dbReads > 1000 ? 'bad' : 'ok'),
            cell(r.staleUpTo ? tx({ en: `up to ${r.staleUpTo} s old`, vi: `cũ tới ${r.staleUpTo} giây` }) : tx({ en: 'fresh', vi: 'mới' }), r.staleUpTo ? 'warn' : 'ok'),
            cell(r.lostUpTo ? tx({ en: `lose ≤ ${r.lostUpTo} s of views`, vi: `mất ≤ ${r.lostUpTo} giây lượt xem` }) : tx({ en: 'nothing lost', vi: 'không mất gì' }), r.lostUpTo ? 'warn' : 'ok'),
            cell(r.viewWaitsOnDb ? tx({ en: 'yes', vi: 'có' }) : tx({ en: 'no', vi: 'không' }), r.viewWaitsOnDb ? 'bad' : 'ok'),
          ]);
        })),
      ]),
    );
  }

  const newsBtn = button('', toggleNews);
  const locked = tx({ en: 'Make your call below to unlock write-through, write-behind and read-through.', vi: 'Trả lời câu hỏi bên dưới để mở khoá write-through, write-behind và read-through.' });
  root.append(
    row(choice(tx({ en: 'Strategy', vi: 'Chiến lược' }), STRATEGIES.map(v => ({
      value: v, label: tx(LABEL[v]), disabled: isLocked(v), title: isLocked(v) ? locked : null,
    })), s.strategy, v => { s.strategy = v; if (news) toggleNews(); reset(); paintTable(); })),
    how,
    el('div', { class: 'sim-buttons' }, [
      button(tx({ en: '+1 view', vi: '+1 lượt xem' }), () => enqueue(sys.view(now()))),
      button(tx({ en: 'Read the count', vi: 'Đọc số đếm' }), () => enqueue(sys.read(now()))),
      newsBtn,
      button(tx({ en: 'Crash Redis', vi: 'Làm sập Redis' }), () => enqueue(sys.crash(now()))),
      button(tx({ en: 'Reset', vi: 'Đặt lại' }), () => { if (news) toggleNews(); reset(); }),
    ]),
    chart.el,
    caption,
    el('div', { class: 'sim-stats' }, [writes.el, reads.el, hits.el, lost.el]),
    table,
    el('p', { class: 'sim-note' }, tx({ en: 'Scaled down: a few views a second here stand for 150,000 a second in the scenario.', vi: 'Đã thu nhỏ: vài lượt xem mỗi giây ở đây đại diện cho 150.000 lượt mỗi giây trong tình huống.' })),
    revealed ? '' : el('p', { class: 'sim-note' }, locked),
  );
  newsBtn.textContent = tx({ en: 'Breaking news: off', vi: 'Tin nóng: tắt' });
  reset();
  paintTable();
  raf = requestAnimationFrame(frame);

  const stopResize = onResize(chart.el, () => draw(now()));
  return () => { cancelAnimationFrame(raf); clearInterval(news); clearInterval(flusher); stopResize(); };
}
