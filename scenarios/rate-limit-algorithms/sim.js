/* One user's traffic through a rate limiter, played on the shared player. Each request
   is a ball that travels from the app, through the limiter, to the server, or drops
   with a 429. The limiter is drawn as what it keeps: a bucket of tokens, a queue that
   leaks, a log of timestamps, two counters, or one counter. A strip underneath marks
   every request as it is decided. Four situations, one per constraint in the scenario;
   before the visitor answers, only today's fixed window is unlocked. */

import { el } from '../../js/dom.js';
import { tx } from '../../js/i18n.js';
import { stat, css } from '../../js/sim-kit.js';
import { player } from '../../js/sim-player.js';

export const SPAN = 120;     // seconds of traffic in the traffic() shapes
export const BURST = 40;     // requests allowed at once
export const RATE = 0.5;     // requests per second over time (30 a minute)
export const FIXED = { limit: 30, window: 60 };   // today's limiter
export const WINDOW = BURST / RATE;               // 80 s: the only window giving burst 40 at 30/min
export const TIMEOUT = 10;   // the app gives up on a request after this many seconds
export const FEW = 2;        // numbers kept per user that still count as a few bytes

/* Arrival times in seconds, sorted. Deterministic.
   steady: autosaving every 3 s, no burst.
   sync:   the app catching up after being offline: 40 requests in 1.5 s.
   app:    that catch-up, then autosaving every 3 s.
   script: something calling flat out, 5 requests a second. */
export function traffic(shape, span = SPAN) {
  const times = [];
  const burst = () => { for (let i = 0; i < BURST; i++) times.push(1.5 * (i + 0.5) / BURST); };
  if (shape === 'steady') {
    for (let t = 1.5; t < span; t += 3) times.push(t);
  } else if (shape === 'sync') {
    burst();
  } else if (shape === 'app') {
    burst();
    for (let t = 3; t < span; t += 3) times.push(t);
  } else if (shape === 'script') {
    for (let t = 0; t < span; t += 0.2) times.push(Math.round(t * 10) / 10);
  } else throw new Error(`unknown traffic: ${shape}`);
  return times;
}

/* One user's limiter. offer(t) decides a request arriving at time t (seconds,
   non-decreasing): { ok, wait } where wait is seconds queued before being served (only
   the leaky bucket queues). view(t) is what the limiter holds at t, for drawing.
   Pure, so the argument is pinned by tests/rate-limit-algorithms.test.js. */
export function limiter(algo) {
  if (algo === 'fixed') {
    const count = new Map();
    return {
      offer(t) {
        const w = Math.floor(t / FIXED.window), n = count.get(w) || 0;
        const ok = n < FIXED.limit;
        if (ok) count.set(w, n + 1);
        return { ok, wait: 0 };
      },
      view(t) {
        const w = Math.floor(t / FIXED.window);
        return { count: count.get(w) || 0, elapsed: t - w * FIXED.window };
      },
    };
  }
  if (algo === 'log') {
    // Exact: remember every accepted timestamp still inside the window.
    const log = [];
    const trim = t => { while (log.length && log[0] <= t - WINDOW) log.shift(); };
    return {
      offer(t) {
        trim(t);
        const ok = log.length < BURST;
        if (ok) log.push(t);
        return { ok, wait: 0 };
      },
      view(t) { trim(t); return { times: log.slice() }; },
    };
  }
  if (algo === 'counter') {
    // This window's count plus last window's, scaled by how much of it still overlaps.
    const count = new Map();
    const at = t => {
      const w = Math.floor(t / WINDOW);
      const prev = count.get(w - 1) || 0, cur = count.get(w) || 0;
      const weight = 1 - (t - w * WINDOW) / WINDOW;
      return { w, prev, cur, weight, estimate: prev * weight + cur };
    };
    return {
      offer(t) {
        const e = at(t);
        const ok = e.estimate < BURST;
        if (ok) count.set(e.w, e.cur + 1);
        return { ok, wait: 0 };
      },
      view: at,
    };
  }
  if (algo === 'token') {
    // Two numbers: tokens left and when they were last topped up. Starts full.
    let tokens = BURST, last = 0;
    const at = t => Math.min(BURST, tokens + (t - last) * RATE);
    return {
      offer(t) {
        tokens = at(t);
        last = t;
        const ok = tokens >= 1;
        if (ok) tokens -= 1;
        return { ok, wait: 0 };
      },
      view: t => ({ tokens: at(t) }),
    };
  }
  if (algo === 'leaky') {
    // A queue of up to BURST, served one every 1/RATE seconds, in order.
    const departs = [];
    let free = -Infinity;
    const waiting = t => {
      while (departs.length && departs[0] <= t) departs.shift();
      return departs.length;
    };
    return {
      offer(t) {
        if (waiting(t) >= BURST) return { ok: false, wait: 0 };
        const d = Math.max(t, free);
        free = d + 1 / RATE;
        if (d > t) departs.push(d);
        return { ok: true, wait: d - t };
      },
      view: t => ({ queued: waiting(t) }),
    };
  }
  throw new Error(`unknown algorithm: ${algo}`);
}

/* Decide a whole sequence of arrivals. */
export function decide(algo, arrivals) {
  const l = limiter(algo);
  return arrivals.map(t => l.offer(t));
}


/* What the limiter keeps for one user: numbers, timestamps, or requests held open. */
export function kept(algo, v) {
  if (algo === 'log') return v.times.length;
  if (algo === 'leaky') return v.queued;
  return algo === 'fixed' ? 1 : 2;
}

export const SETUPS = ['fixed', 'log', 'counter', 'leaky', 'token'];
export const SITUATIONS = ['steady', 'sync', 'editing', 'script'];
export const TRAVEL = 1.2;    // simulated seconds a ball takes along each road
const DROP = 2.5;             // how long a rejected ball stays in sight
const SHAPE = { steady: 'steady', sync: 'sync', editing: 'app', script: 'script' };
const SPANS = { steady: 30, sync: 2, editing: 90, script: 90 };
const LAST = 95;              // no run is drawn past this

/* Run one situation through one limiter: every request's fate, the facts the
   scoreboard reads, and the captioned steps. Pure. */
export function run(setup, situation) {
  const span = SPANS[situation], lim = limiter(setup);
  let most = 0;
  const reqs = traffic(SHAPE[situation], span).map((a, i) => {
    const d = lim.offer(a);
    most = Math.max(most, kept(setup, lim.view(a)));
    return { n: i + 1, a, ok: d.ok, wait: d.wait, leave: a + d.wait };
  });
  const rejected = reqs.filter(q => !q.ok).length;
  const slow = reqs.filter(q => q.ok && q.wait > TIMEOUT).length;
  const served = reqs.length - rejected;
  const maxWait = Math.round(Math.max(0, ...reqs.map(q => q.wait)));
  const cap = BURST + RATE * span;
  const ok = situation === 'script'
    ? served <= cap + 1 && most <= FEW && slow === 0
    : rejected === 0 && slow === 0;
  const last = Math.max(...reqs.map(q => (q.ok ? q.leave + TRAVEL : q.a + DROP)));
  const r = { setup, situation, span, reqs, rejected, slow, served, maxWait, most, cap, ok,
    end: Math.min(LAST, Math.max(span, last + 0.5)) };
  r.steps = story(r);
  r.summary = summary(r);
  return r;
}

export const survives = (setup, situation) => run(setup, situation).ok;

const LABEL = {
  fixed: { en: 'Fixed window (today)', vi: 'Cửa sổ cố định (hiện tại)' },
  log: { en: 'Sliding log', vi: 'Nhật ký trượt' },
  counter: { en: 'Sliding counter', vi: 'Bộ đếm trượt' },
  leaky: { en: 'Leaky bucket', vi: 'Leaky bucket' },
  token: { en: 'Token bucket', vi: 'Token bucket' },
};

const SITUATION = {
  steady: { en: 'Normal editing', vi: 'Chỉnh sửa bình thường' },
  sync: { en: 'Back from a flight', vi: 'Vừa xuống máy bay' },
  editing: { en: 'Sync, then keep editing', vi: 'Đồng bộ rồi sửa tiếp' },
  script: { en: 'A runaway client', vi: 'Một client chạy mất kiểm soát' },
};

/* How each one works, in one breath. */
const HOW = {
  fixed: { en: 'Fixed window: one counter per clock minute. Up to 30 get in; the counter goes back to 0 when the minute changes, whatever just happened.', vi: 'Cửa sổ cố định: một bộ đếm cho mỗi phút theo đồng hồ. Tối đa 30 request được vào; bộ đếm về 0 khi sang phút mới, bất kể vừa xảy ra gì.' },
  log: { en: 'Sliding log: remembers when every accepted request arrived. A new one gets in only if fewer than 40 arrived in the last 80 seconds.', vi: 'Nhật ký trượt: nhớ thời điểm của mọi request được nhận. Request mới chỉ được vào nếu có ít hơn 40 cái trong 80 giây gần nhất.' },
  counter: { en: 'Sliding counter: keeps the previous 80-second window’s count and this one’s. It estimates the last 80 seconds as the previous count, scaled by how much of it still overlaps, plus this one.', vi: 'Bộ đếm trượt: giữ số đếm của cửa sổ 80 giây trước và cửa sổ này. Nó ước lượng 80 giây vừa qua bằng số của cửa sổ trước, nhân với phần còn chồng lấn, cộng số của cửa sổ này.' },
  token: { en: 'Token bucket: holds up to 40 tokens and one drips in every 2 seconds. Each request takes a token. No token, no entry.', vi: 'Token bucket: chứa tối đa 40 token và cứ 2 giây nhỏ thêm một token. Mỗi request lấy một token. Hết token thì không được vào.' },
  leaky: { en: 'Leaky bucket: requests wait in a bucket of up to 40 and leak out to the server one every 2 seconds. When the bucket is full, new ones spill.', vi: 'Leaky bucket: request chờ trong một cái xô tối đa 40 và rỉ ra server mỗi 2 giây một cái. Khi xô đầy, request mới bị tràn ra ngoài.' },
};

const MEMORY = {
  fixed: { en: '1 counter', vi: '1 bộ đếm' },
  counter: { en: '2 counters', vi: '2 bộ đếm' },
  token: { en: '2 numbers', vi: '2 con số' },
};

function story(r) {
  const { setup, situation, end, span, served, slow, maxWait, most } = r;
  const m = [];
  const add = (t0, t1, dur, tone, en, vi) => m.push({ t0, t1, dur, tone, say: { en, vi } });
  add(-TRAVEL, -TRAVEL, 2.5, null, HOW[setup].en, HOW[setup].vi);
  const autoRej = r.reqs.slice(BURST).filter(q => !q.ok).length;
  const burstRej = r.reqs.slice(0, BURST).filter(q => !q.ok).length;

  if (situation === 'steady') {
    add(-TRAVEL, end, 6, null, 'The user edits. The app autosaves once every 3 seconds, one request at a time.', 'Người dùng chỉnh sửa. App tự lưu mỗi 3 giây một lần, từng request một.');
  }

  if (situation === 'sync') {
    add(-TRAVEL, 3, 3, null, 'The app opens after a flight and catches up: 40 requests in 1.5 seconds.', 'App mở lại sau chuyến bay và bắt kịp: 40 request trong 1,5 giây.');
    if (setup === 'fixed') {
      add(3, end, 2.5, 'bad', `30 get through. The other ${burstRej} get a 429, and so would the app’s retries, until the clock reaches the next minute.`, `30 request đi qua. ${burstRej} cái còn lại nhận 429, và các lần retry của app cũng vậy, cho tới khi đồng hồ sang phút mới.`);
    } else if (setup === 'leaky') {
      add(3, 11.5, 3, 'warn', 'Nothing is rejected. The 40 requests wait in the bucket and leak to the server one every 2 seconds.', 'Không gì bị từ chối. 40 request chờ trong xô và rỉ ra server mỗi 2 giây một cái.');
      add(11.5, end, 6, 'bad', `From 10 seconds on, the app gives up on each request still waiting: ${slow} of the 40. The last one reaches the server after ${maxWait} seconds.`, `Từ giây thứ 10, app bỏ cuộc với mọi request còn đang chờ: ${slow} trên 40. Request cuối tới server sau ${maxWait} giây.`);
    } else {
      add(3, end, 2.5, null, {
        log: 'All 40 get a 200 at once. The log now holds 40 timestamps.',
        counter: 'All 40 get a 200 at once. This window’s count is now 40.',
        token: 'All 40 get a 200 at once, spending every token in the bucket.',
      }[setup], {
        log: 'Cả 40 nhận 200 ngay. Nhật ký giờ giữ 40 mốc thời gian.',
        counter: 'Cả 40 nhận 200 ngay. Số đếm của cửa sổ này giờ là 40.',
        token: 'Cả 40 nhận 200 ngay, tiêu hết mọi token trong xô.',
      }[setup]);
    }
  }

  if (situation === 'editing') {
    add(-TRAVEL, 3, 3, null, 'The app comes back online and catches up: 40 requests in 1.5 seconds. Then the user keeps editing, and the app autosaves every 3 seconds.', 'App online trở lại và bắt kịp: 40 request trong 1,5 giây. Sau đó người dùng tiếp tục sửa, và app tự lưu mỗi 3 giây.');
    const s1 = {
      fixed: ['bad', `30 of the burst get through and ${burstRej} get a 429. Then every autosave gets a 429 too: this minute’s 30 are spent.`, `30 request của loạt dồn đi qua và ${burstRej} cái nhận 429. Sau đó mọi lần tự lưu cũng nhận 429: 30 lượt của phút này đã hết.`],
      log: ['bad', 'The whole burst gets a 200. But the log is now full of its 40 timestamps, so every autosave gets a 429.', 'Cả loạt dồn nhận 200. Nhưng nhật ký giờ đầy 40 mốc thời gian của nó, nên mọi lần tự lưu nhận 429.'],
      counter: ['bad', 'The whole burst gets a 200. This window’s count is now 40, so every autosave gets a 429.', 'Cả loạt dồn nhận 200. Số đếm của cửa sổ này giờ là 40, nên mọi lần tự lưu nhận 429.'],
      leaky: ['warn', 'Nothing is rejected. The burst waits in the bucket, leaking out one every 2 seconds, and each autosave joins the back of the queue.', 'Không gì bị từ chối. Loạt dồn chờ trong xô, rỉ ra mỗi 2 giây một cái, và mỗi lần tự lưu xếp vào cuối hàng.'],
      token: [null, 'The whole burst gets a 200, spending every token. A new token drips in every 2 seconds.', 'Cả loạt dồn nhận 200, tiêu hết token. Cứ 2 giây một token mới nhỏ vào.'],
    }[setup];
    add(3, 45, 5, ...s1);
    const s2 = {
      fixed: ['bad', `At 1:00 the counter resets and autosaves get through again. ${autoRej} autosaves in a row were rejected first.`, `Tới 1:00 bộ đếm về 0 và các lần tự lưu lại đi qua. Trước đó ${autoRej} lần tự lưu liên tiếp đã bị từ chối.`],
      log: ['bad', `The burst only ages out of the log at 80 seconds. Until then the user’s edits are not saved: ${autoRej} autosaves rejected.`, `Loạt dồn chỉ hết hạn khỏi nhật ký ở giây 80. Tới lúc đó thay đổi của người dùng không được lưu: ${autoRej} lần tự lưu bị từ chối.`],
      counter: ['bad', `At 80 seconds a new window starts and the old count fades out, so autosaves get in again. ${autoRej} were rejected before that.`, `Ở giây 80 một cửa sổ mới bắt đầu và số đếm cũ mờ dần, nên các lần tự lưu lại được vào. Trước đó ${autoRej} lần đã bị từ chối.`],
      leaky: ['bad', `The bucket drains one every 2 seconds and autosaves add one every 3, so the backlog shrinks slowly. ${slow} requests waited past the app’s 10 seconds, the longest ${maxWait} seconds.`, `Xô xả mỗi 2 giây một cái còn tự lưu thêm mỗi 3 giây một cái, nên hàng tồn giảm rất chậm. ${slow} request chờ quá 10 giây của app, lâu nhất ${maxWait} giây.`],
      token: [null, 'An autosave spends one token every 3 seconds, fewer than drip in, so one is always ready: every autosave gets a 200 at once, and the bucket slowly refills for the next burst.', 'Mỗi lần tự lưu tiêu một token mỗi 3 giây, ít hơn lượng nhỏ vào, nên luôn có sẵn token: mọi lần tự lưu nhận 200 ngay, và xô từ từ đầy lại cho loạt dồn kế tiếp.'],
    }[setup];
    add(45, end, 5, ...s2);
  }

  if (situation === 'script') {
    add(-TRAVEL, 4, 3, null, 'A buggy client calls the API flat out: 5 requests a second, nonstop.', 'Một client lỗi gọi API liên tục: 5 request mỗi giây, không ngừng.');
    const s1 = {
      fixed: [null, `It gets 30 a minute and a 429 for the rest: ${served} served in ${span} seconds. The limiter keeps one counter for this user.`, `Nó được 30 mỗi phút và nhận 429 cho phần còn lại: ${served} request được phục vụ trong ${span} giây. Bộ giới hạn giữ một bộ đếm cho người dùng này.`],
      log: ['bad', `It gets 40, then one more each time an old timestamp ages out: ${served} in ${span} seconds. But the log holds ${most} timestamps for this user, and any of 5 million users can do the same.`, `Nó được 40, rồi thêm một mỗi khi một mốc cũ hết hạn: ${served} trong ${span} giây. Nhưng nhật ký giữ ${most} mốc thời gian cho người dùng này, và bất kỳ ai trong 5 triệu người dùng cũng có thể làm vậy.`],
      counter: [null, `Two counters hold it to about 40 per 80 seconds: ${served} served in ${span} seconds.`, `Hai bộ đếm giữ nó ở khoảng 40 mỗi 80 giây: ${served} request được phục vụ trong ${span} giây.`],
      leaky: ['bad', `The queue fills up and stays full: ${most} requests, each held open on an API server for up to ${maxWait} seconds.`, `Hàng đợi đầy và cứ đầy như vậy: ${most} request, mỗi cái bị giữ mở trên API server tới ${maxWait} giây.`],
      token: [null, `It gets the 40 in the bucket, then one every 2 seconds: ${served} served in ${span} seconds. Two numbers for this user.`, `Nó lấy 40 token trong xô, rồi mỗi 2 giây một cái: ${served} request được phục vụ trong ${span} giây. Hai con số cho người dùng này.`],
    }[setup];
    add(4, end, 7, ...s1);
  }
  return m;
}

function summary(r) {
  const { setup, situation, rejected, slow, served, span, cap, most, maxWait } = r;
  if (r.ok) return {
    steady: { en: 'Every autosave got a 200 at once.', vi: 'Mọi lần tự lưu đều nhận 200 ngay.' },
    sync: { en: 'All 40 sync requests got a 200 at once.', vi: 'Cả 40 request đồng bộ đều nhận 200 ngay.' },
    editing: { en: 'The burst and every autosave got a 200 at once.', vi: 'Loạt dồn và mọi lần tự lưu đều nhận 200 ngay.' },
    script: { en: `Held to ${served} requests in ${span} seconds (the cap is ${cap}), keeping ${most === 1 ? 'one number' : `${most} numbers`} for this user.`, vi: `Giữ ở ${served} request trong ${span} giây (mức trần là ${cap}), chỉ lưu ${most} con số cho người dùng này.` },
  }[situation];
  if (situation === 'script') return setup === 'log'
    ? { en: `Broken: ${most} timestamps kept for one user, not a few bytes.`, vi: `Hỏng: ${most} mốc thời gian cho một người dùng, không phải vài byte.` }
    : { en: `Broken: ${most} requests held open on the API servers, up to ${maxWait} seconds each.`, vi: `Hỏng: ${most} request bị giữ mở trên API server, mỗi cái tới ${maxWait} giây.` };
  if (rejected) return { en: `Broken: ${rejected} requests got a 429, and the user sees “Sync failed”.`, vi: `Hỏng: ${rejected} request nhận 429, và người dùng thấy “Đồng bộ thất bại”.` };
  return { en: `Broken: ${slow} requests waited past the app’s 10-second timeout.`, vi: `Hỏng: ${slow} request chờ quá thời gian chờ 10 giây của app.` };
}

/* The limiter's state at time t: replay every request that has reached it. */
function viewAt(r, t) {
  const l = limiter(r.setup);
  for (const q of r.reqs) { if (q.a > t) break; l.offer(q.a); }
  return l.view(Math.max(0, t));
}

const fmt = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

export function mount(root, ctx) {
  let cached = null;   // the player asks for each run once; the drawing reads the same result
  const served = stat(tx({ en: 'Reached the server', vi: 'Tới server' }));
  const rejected = stat(tx({ en: 'Rejected (429)', vi: 'Bị từ chối (429)' }));
  const wait = stat(tx({ en: 'Longest wait', vi: 'Chờ lâu nhất' }));
  const memory = stat(tx({ en: 'Kept per user', vi: 'Lưu cho mỗi người dùng' }));
  const key = (c, label) => el('span', { class: 'key-item' }, [el('i', { style: `background:${css(c)}` }), label]);

  /* The stats as of time t, so they count up with the picture. */
  function stats(r, t, v) {
    const seen = r.reqs.filter(q => q.a <= t);
    const nServed = seen.filter(q => q.ok && q.leave + TRAVEL <= t).length;
    const nRejected = seen.filter(q => !q.ok).length;
    const longest = Math.max(0, ...seen.filter(q => q.ok).map(q => Math.min(q.wait, t - q.a)));
    served.set(String(nServed), 'ok');
    rejected.set(String(nRejected), nRejected ? 'bad' : '');
    wait.set(`${Math.round(longest)} s`, longest > TIMEOUT ? 'bad' : longest > 0.5 ? 'warn' : 'ok');
    const n = kept(r.setup, v);
    memory.set(r.setup === 'log' ? tx({ en: `${n} timestamps`, vi: `${n} mốc thời gian` })
      : r.setup === 'leaky' ? tx({ en: `${n} requests held`, vi: `${n} request đang giữ` })
      : tx(MEMORY[r.setup]), n > FEW ? 'bad' : 'ok');
  }

  return player(root, ctx, {
    situations: SITUATIONS.map(x => ({ value: x, label: tx(SITUATION[x]), icon: { steady: 'sun', sync: 'nowifi', editing: 'copy', script: 'bolt' }[x] })),
    setups: SETUPS.map(x => ({ value: x, label: tx(LABEL[x]), icon: { fixed: 'hourglass', log: 'list', counter: 'hash', leaky: 'inbox', token: 'layers' }[x] })),
    open: ['fixed'],
    initial: { situation: 'sync' },
    run: (setup, situation) => (cached = run(setup, situation)),
    survives, height: 300,
    duration: st => st.dur,
    tone: st => st.tone,
    draw: ({ g, w, h, k, p }) => {
      const st = cached.steps[k];
      const t = st ? st.t0 + p * (st.t1 - st.t0) : cached.end;
      const v = viewAt(cached, t);
      draw(g, w, h, cached, t, v);
      stats(cached, t, v);
    },
    footer: [
      el('div', { class: 'sim-legend' }, [
        key('ok', tx({ en: '200 at once', vi: '200 ngay' })),
        key('blue', tx({ en: 'waiting in the queue', vi: 'đang chờ trong hàng' })),
        key('warn', tx({ en: 'waited past 10 s: the app gave up', vi: 'chờ quá 10 giây: app đã bỏ cuộc' })),
        key('bad', tx({ en: '429', vi: '429' })),
      ]),
      el('div', { class: 'sim-stats' }, [served.el, rejected.el, wait.el, memory.el]),
    ],
  });
}

/* ---------------- drawing: the limiter at time t of a run ---------------- */

const lerp = (a, b, p) => a + (b - a) * Math.min(1, Math.max(0, p));

function draw(g, w, h, r, t, v) {
  const mid = 112, appX = 34, srvX = w - 34;
  const box = { w: Math.max(130, Math.min(260, w - 200)), h: 170 };
  box.x = (w - box.w) / 2; box.y = mid - 90;
  g.clearRect(0, 0, w, h);
  g.font = '12px "Hanken Grotesk", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const servedNow = r.reqs.filter(q => q.ok && q.leave + TRAVEL <= t).length;

  // The app and the server.
  const node = (x, label, sub) => {
    g.fillStyle = css('surface2'); g.strokeStyle = css('line');
    g.beginPath(); g.roundRect(x - 26, mid - 34, 52, 68, 10); g.fill(); g.stroke();
    g.fillStyle = css('text'); g.fillText(label, x, mid - 6);
    if (sub != null) { g.fillStyle = css('ok'); g.font = '600 13px "IBM Plex Mono", monospace'; g.fillText(sub, x, mid + 14); g.font = '12px "Hanken Grotesk", sans-serif'; }
  };
  node(appX, tx({ en: 'App', vi: 'App' }));
  node(srvX, tx({ en: 'Server', vi: 'Server' }), String(servedNow));

  // The road: app -> limiter -> server.
  g.strokeStyle = css('line'); g.setLineDash([3, 5]);
  g.beginPath(); g.moveTo(appX + 26, mid); g.lineTo(box.x, mid); g.moveTo(box.x + box.w, mid); g.lineTo(srvX - 26, mid); g.stroke();
  g.setLineDash([]);

  const waiting = r.reqs.filter(q => q.ok && q.a <= t && t < q.leave);
  drawLimiter(g, box, r.setup, v, Math.max(0, t), waiting);

  // The balls.
  const ball = (x, y, color, alpha = 1) => {
    g.globalAlpha = alpha; g.fillStyle = css(color);
    g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
  };
  for (const q of r.reqs) {
    if (t < q.a - TRAVEL) break;
    if (t < q.a) ball(lerp(appX + 30, box.x - 6, (t - q.a + TRAVEL) / TRAVEL), mid, 'blue');
    else if (!q.ok) {
      if (t > q.a + DROP) continue;
      const p = (t - q.a) / DROP;
      ball(box.x - 10, mid + p * 70, 'bad', 1 - p * 0.8);
      g.globalAlpha = 1 - p; g.fillStyle = css('bad'); g.font = '600 11px "IBM Plex Mono", monospace';
      g.fillText('429', box.x - 30, mid + 10 + p * 70); g.globalAlpha = 1;
      g.font = '12px "Hanken Grotesk", sans-serif';
    } else if (t >= q.leave && t < q.leave + TRAVEL) ball(lerp(box.x + box.w + 6, srvX - 30, (t - q.leave) / TRAVEL), mid, 'ok');
    // Balls between `a` and `leave` are waiting in the leaky bucket, drawn by it.
  }

  timeline(g, w, h, r, t);
}

/* Every request as a tick at the moment it reached the limiter: up for a 200, down
   for a 429, coloured by how long it waited. */
function timeline(g, w, h, r, t) {
  const x0 = 12, x1 = w - 12, sy = h - 58, sh = 30, axis = sy + sh / 2;
  const X = s => x0 + (Math.min(s, r.end) / r.end) * (x1 - x0);
  g.font = '11px "IBM Plex Mono", monospace'; g.textBaseline = 'middle';
  g.fillStyle = css('muted');
  g.textAlign = 'left'; g.fillText(tx({ en: 'every request, as the limiter decides it', vi: 'mọi request, khi bộ giới hạn quyết định' }), x0, sy - 10);
  g.textAlign = 'right'; g.fillText(tx({ en: `simulated time ${fmt(Math.max(0, t))}`, vi: `thời gian mô phỏng ${fmt(Math.max(0, t))}` }), x1, sy - 10);
  g.fillStyle = css('bg2'); g.fillRect(x0, sy, x1 - x0, sh);
  g.strokeStyle = css('line'); g.beginPath(); g.moveTo(x0, axis); g.lineTo(x1, axis); g.stroke();
  // The app's 10-second timeout, measured from the first request.
  if (r.reqs[0].a + TIMEOUT < r.end) {
    const tx0 = X(r.reqs[0].a + TIMEOUT);
    g.setLineDash([2, 3]); g.strokeStyle = css('faint');
    g.beginPath(); g.moveTo(tx0, sy); g.lineTo(tx0, sy + sh); g.stroke(); g.setLineDash([]);
  }
  g.lineWidth = 1.5;
  for (const q of r.reqs) {
    if (q.a > t) break;
    const x = X(q.a);
    const color = !q.ok ? 'bad' : q.wait > TIMEOUT && t >= q.a + TIMEOUT ? 'warn' : t < q.leave ? 'blue' : 'ok';
    g.strokeStyle = css(color);
    g.beginPath();
    if (q.ok) { g.moveTo(x, axis - 2); g.lineTo(x, sy + 3); } else { g.moveTo(x, axis + 2); g.lineTo(x, sy + sh - 3); }
    g.stroke();
  }
  g.lineWidth = 1;
  // The playhead.
  if (t >= 0 && t < r.end) {
    g.strokeStyle = css('text'); g.globalAlpha = 0.5;
    g.beginPath(); g.moveTo(X(t), sy - 2); g.lineTo(X(t), sy + sh + 2); g.stroke(); g.globalAlpha = 1;
  }
  g.fillStyle = css('faint'); g.textBaseline = 'top';
  g.textAlign = 'left'; g.fillText('0:00', x0, sy + sh + 4);
  g.textAlign = 'right'; g.fillText(fmt(r.end), x1, sy + sh + 4);
  g.textBaseline = 'middle';
}

/* The limiter, drawn as the state it keeps. */
function drawLimiter(g, box, algo, v, st, waiting) {
  const { x, y, w, h } = box;
  const caption = (text, dy = 0, color = 'muted') => {
    g.textAlign = 'center'; g.fillStyle = css(color); g.font = '12px "Hanken Grotesk", sans-serif';
    g.fillText(text, x + w / 2, y + h + 14 + dy);
  };
  const big = (text, cy, color = 'text') => {
    g.textAlign = 'center'; g.fillStyle = css(color); g.font = '700 22px "IBM Plex Mono", monospace';
    g.fillText(text, x + w / 2, cy);
  };
  const bar = (bx, by, bw, frac, color, bh = 10) => {
    g.fillStyle = css('bg2'); g.fillRect(bx, by, bw, bh);
    g.fillStyle = css(color); g.fillRect(bx, by, bw * Math.min(1, Math.max(0, frac)), bh);
  };

  if (algo === 'token' || algo === 'leaky') {
    // A bucket with 40 slots, 8 across, filled from the bottom.
    const top = y + 18, bottom = y + h - 6, inset = 18;
    g.strokeStyle = css('muted'); g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, top); g.lineTo(x + inset, bottom); g.lineTo(x + w - inset, bottom); g.lineTo(x + w, top); g.stroke();
    g.lineWidth = 1;
    const cols = 8, rows = BURST / cols;
    const cw = (w - 2 * inset - 8) / cols, chh = (bottom - top - 8) / rows, r = Math.min(cw, chh) / 2 - 2;
    const slot = i => [x + inset + 4 + (i % cols + 0.5) * cw, bottom - 4 - (Math.floor(i / cols) + 0.5) * chh];
    if (algo === 'token') {
      const full = Math.floor(v.tokens), part = v.tokens - full;
      for (let i = 0; i < BURST; i++) {
        const [cx, cy] = slot(i);
        if (i < full) { g.fillStyle = css('warn'); g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill(); }
        else if (i === full && part > 0) {
          g.strokeStyle = css('warn'); g.lineWidth = 2;
          g.beginPath(); g.arc(cx, cy, r - 1, -Math.PI / 2, -Math.PI / 2 + part * Math.PI * 2); g.stroke(); g.lineWidth = 1;
        }
      }
      // The tap that drips one token every 2 s.
      g.fillStyle = css('warn'); g.font = '600 11px "IBM Plex Mono", monospace'; g.textAlign = 'center';
      g.fillText(tx({ en: '+1 token / 2 s', vi: '+1 token / 2 giây' }), x + w / 2, y + 4);
      caption(tx({ en: `${Math.floor(v.tokens)} of ${BURST} tokens`, vi: `${Math.floor(v.tokens)} / ${BURST} token` }), 0, v.tokens < 1 ? 'bad' : 'muted');
    } else {
      // Oldest at the bottom; a request waiting past the app's timeout turns amber.
      waiting.forEach((q, i) => {
        const [cx, cy] = slot(i);
        g.fillStyle = css(st - q.a > TIMEOUT ? 'warn' : 'blue'); g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
      });
      // The hole: one drips out every 2 s.
      g.fillStyle = css('bg'); g.fillRect(x + w / 2 - 6, bottom - 2, 12, 4);
      g.fillStyle = css('blue'); g.font = '600 11px "IBM Plex Mono", monospace'; g.textAlign = 'center';
      g.fillText(tx({ en: 'leaks 1 / 2 s ↓', vi: 'rỉ 1 / 2 giây ↓' }), x + w / 2, bottom + 12);
      caption(tx({ en: `${waiting.length} of ${BURST} waiting`, vi: `${waiting.length} / ${BURST} đang chờ` }), 12, waiting.length >= BURST ? 'bad' : 'muted');
    }
    return;
  }

  // The other three are counters: draw them in a panel.
  g.fillStyle = css('bg2'); g.strokeStyle = css('line');
  g.beginPath(); g.roundRect(x, y + 18, w, h - 24, 12); g.fill(); g.stroke();
  const px = x + 14, pw = w - 28;

  if (algo === 'fixed') {
    big(`${v.count} / ${FIXED.limit}`, y + 60, v.count >= FIXED.limit ? 'bad' : 'text');
    bar(px, y + 82, pw, v.count / FIXED.limit, v.count >= FIXED.limit ? 'bad' : 'ok');
    g.textAlign = 'left'; g.fillStyle = css('muted'); g.font = '11px "IBM Plex Mono", monospace';
    g.fillText(tx({ en: `minute resets in ${Math.ceil(FIXED.window - v.elapsed)} s`, vi: `phút mới sau ${Math.ceil(FIXED.window - v.elapsed)} giây` }), px, y + 118);
    bar(px, y + 130, pw, v.elapsed / FIXED.window, 'faint', 6);
    caption(tx({ en: 'requests this clock minute', vi: 'request trong phút này' }));
  } else if (algo === 'log') {
    // The last 80 s as a strip; each accepted request is a tick that slides left and falls off.
    big(`${v.times.length} / ${BURST}`, y + 56, v.times.length >= BURST ? 'bad' : 'text');
    const sy = y + 86, sh = 40;
    g.fillStyle = css('surface'); g.fillRect(px, sy, pw, sh);
    g.strokeStyle = css('ok');
    for (const ti of v.times) {
      const tx0 = px + pw - ((st - ti) / WINDOW) * pw;
      g.beginPath(); g.moveTo(tx0, sy + 4); g.lineTo(tx0, sy + sh - 4); g.stroke();
    }
    g.fillStyle = css('muted'); g.font = '11px "IBM Plex Mono", monospace';
    g.textAlign = 'left'; g.fillText(tx({ en: '80 s ago', vi: '80 giây trước' }), px, sy + sh + 12);
    g.textAlign = 'right'; g.fillText(tx({ en: 'now', vi: 'bây giờ' }), px + pw, sy + sh + 12);
    caption(tx({ en: 'timestamps in the last 80 s', vi: 'mốc thời gian trong 80 giây gần nhất' }));
  } else if (algo === 'counter') {
    big(`≈ ${v.estimate.toFixed(1)} / ${BURST}`, y + 56, v.estimate >= BURST ? 'bad' : 'text');
    // One bar: last window's count scaled down (faded), then this window's count.
    const by = y + 80, scale = pw / BURST;
    g.fillStyle = css('bg'); g.fillRect(px, by, pw, 16);
    const a = Math.min(pw, v.prev * v.weight * scale), b = Math.min(pw - a, v.cur * scale);
    g.globalAlpha = 0.45; g.fillStyle = css('blue'); g.fillRect(px, by, a, 16); g.globalAlpha = 1;
    g.fillStyle = css('blue'); g.fillRect(px + a, by, b, 16);
    g.fillStyle = css('muted'); g.font = '11px "IBM Plex Mono", monospace'; g.textAlign = 'left';
    g.fillText(tx({ en: `previous ${v.prev} × ${v.weight.toFixed(2)}`, vi: `cửa sổ trước ${v.prev} × ${v.weight.toFixed(2)}` }), px, by + 32);
    g.fillText(tx({ en: `+ this window ${v.cur}`, vi: `+ cửa sổ này ${v.cur}` }), px, by + 48);
    bar(px, by + 62, pw, 1 - v.weight, 'faint', 6);
    caption(tx({ en: 'estimate for the last 80 s', vi: 'ước lượng cho 80 giây gần nhất' }));
  }
}
