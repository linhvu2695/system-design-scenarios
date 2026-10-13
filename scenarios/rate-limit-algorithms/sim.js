/* A rate limiter you can poke. The visitor sends requests (one, a 40-request burst,
   or an autosave every 3 s); each is a ball that travels from the app, through the
   limiter, to the server, or drops with a 429. The limiter is drawn as what it keeps:
   a bucket of tokens, a queue that leaks, a log of timestamps, two counters, or one
   counter. Time runs at 4x so the 80-second effects play out in 20 seconds.
   Before the visitor answers, only today's fixed window is unlocked. */

import { el } from '../../js/dom.js';
import { tx } from '../../js/i18n.js';
import { canvas, choice, button, stat, css, row, onResize, reducedMotion } from '../../js/sim-kit.js';

export const SPAN = 120;     // seconds of traffic in the traffic() shapes
export const BURST = 40;     // requests allowed at once
export const RATE = 0.5;     // requests per second over time (30 a minute)
export const FIXED = { limit: 30, window: 60 };   // today's limiter
export const WINDOW = BURST / RATE;               // 80 s: the only window giving burst 40 at 30/min
export const SPEED = 4;      // simulated seconds per real second in the simulation

/* Arrival times in seconds, sorted. Deterministic.
   app:    the app catching up after being offline, then autosaving every 3 s.
   script: something calling flat out, 5 requests a second. */
export function traffic(shape) {
  const times = [];
  if (shape === 'app') {
    for (let i = 0; i < BURST; i++) times.push(1.5 * (i + 0.5) / BURST);
    for (let t = 3; t < SPAN; t += 3) times.push(t);
  } else if (shape === 'script') {
    for (let t = 0; t < SPAN; t += 0.2) times.push(Math.round(t * 10) / 10);
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

const ALGOS = [
  { value: 'fixed', label: { en: 'Fixed window (today)', vi: 'Cửa sổ cố định (hiện tại)' } },
  { value: 'log', label: { en: 'Sliding log', vi: 'Nhật ký trượt' } },
  { value: 'counter', label: { en: 'Sliding counter', vi: 'Bộ đếm trượt' } },
  { value: 'leaky', label: { en: 'Leaky bucket', vi: 'Leaky bucket' } },
  { value: 'token', label: { en: 'Token bucket', vi: 'Token bucket' } },
];

/* How each one works, in one breath. */
const HOW = {
  fixed: { en: 'One counter per clock minute. Up to 30 get in; the counter goes back to 0 when the minute changes, whatever just happened.', vi: 'Một bộ đếm cho mỗi phút theo đồng hồ. Tối đa 30 request được vào; bộ đếm về 0 khi sang phút mới, bất kể vừa xảy ra gì.' },
  log: { en: 'Remembers when every accepted request arrived. A new one gets in only if fewer than 40 arrived in the last 80 seconds.', vi: 'Nhớ thời điểm của mọi request được nhận. Request mới chỉ được vào nếu có ít hơn 40 cái trong 80 giây gần nhất.' },
  counter: { en: 'Keeps two counts: the previous 80-second window and this one. It estimates the last 80 seconds as the previous count, scaled by how much of it still overlaps, plus this one.', vi: 'Giữ hai số đếm: cửa sổ 80 giây trước và cửa sổ này. Nó ước lượng 80 giây vừa qua bằng số của cửa sổ trước, nhân với phần còn chồng lấn, cộng số của cửa sổ này.' },
  token: { en: 'A bucket holds up to 40 tokens and one drips in every 2 seconds. Each request takes a token. No token, no entry.', vi: 'Một cái xô chứa tối đa 40 token và cứ 2 giây nhỏ thêm một token. Mỗi request lấy một token. Hết token thì không được vào.' },
  leaky: { en: 'Requests wait in a bucket of up to 40 and leak out to the server one every 2 seconds. When the bucket is full, new ones spill.', vi: 'Request chờ trong một cái xô tối đa 40 và rỉ ra server mỗi 2 giây một cái. Khi xô đầy, request mới bị tràn ra ngoài.' },
};

/* Why a request was just rejected. */
const WHY_REJECTED = {
  fixed: { en: '30 already this minute. Nothing gets in until the clock reaches the next minute.', vi: 'Phút này đã có 30. Không gì được vào cho tới khi đồng hồ sang phút mới.' },
  log: { en: '40 already in the last 80 seconds. The oldest one has to age out first.', vi: 'Đã có 40 trong 80 giây gần nhất. Cái cũ nhất phải hết hạn trước.' },
  counter: { en: 'The estimate for the last 80 seconds has reached 40.', vi: 'Ước lượng cho 80 giây gần nhất đã chạm 40.' },
  token: { en: 'The bucket is empty. The next token drips in within 2 seconds.', vi: 'Xô đã rỗng. Token tiếp theo sẽ nhỏ vào trong vòng 2 giây.' },
  leaky: { en: 'The bucket is full: 40 already waiting.', vi: 'Xô đã đầy: 40 request đang chờ.' },
};

const MEMORY = {
  fixed: { en: '1 counter', vi: '1 bộ đếm' },
  log: { en: `≤ ${BURST} timestamps`, vi: `≤ ${BURST} mốc thời gian` },
  counter: { en: '2 counters', vi: '2 bộ đếm' },
  leaky: { en: `queue of ≤ ${BURST}`, vi: `hàng đợi ≤ ${BURST}` },
  token: { en: '2 numbers', vi: '2 con số' },
};

const fmt = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

export function mount(root, { revealed, state }) {
  const s = Object.assign(state, { algo: 'fixed', autosave: false, ...state });
  if (!revealed) s.algo = 'fixed';

  const TRAVEL = reducedMotion() ? 0.05 : 0.45;   // real seconds per leg of a ball's trip
  const DROP = reducedMotion() ? 0.3 : 0.9;       // how long a rejected ball stays visible
  const chart = canvas(260);
  const served = stat(tx({ en: 'Reached the server', vi: 'Tới server' }));
  const rejected = stat(tx({ en: 'Rejected (429)', vi: 'Bị từ chối (429)' }));
  const wait = stat(tx({ en: 'Longest wait', vi: 'Chờ lâu nhất' }));
  const memory = stat(tx({ en: 'Memory per user', vi: 'Bộ nhớ mỗi người dùng' }));
  const how = el('p', { class: 'sim-how' });
  const event = el('p', { class: 'sim-event', 'aria-live': 'polite' });
  const now = () => performance.now() / 1000;

  let sim;   // everything about the current run
  function reset() {
    sim = { lim: limiter(s.algo), start: now(), balls: [], sent: 0, served: 0, rejected: 0, maxWait: 0, nextSave: now() };
    how.textContent = tx(HOW[s.algo]);
    event.textContent = tx({ en: 'Send a request to see what the limiter does.', vi: 'Gửi một request để xem bộ giới hạn làm gì.' });
    memory.set(tx(MEMORY[s.algo]));
  }
  const simTime = real => (real - sim.start) * SPEED;
  const send = (delay = 0) => sim.balls.push({ n: ++sim.sent, sent: now() + delay });

  /* Decide every ball that has reached the limiter, in arrival order. */
  function tick() {
    const t = now();
    if (s.autosave && t >= sim.nextSave) { send(); sim.nextSave = t + 3 / SPEED; }
    const due = sim.balls.filter(b => b.ok === undefined && t >= b.sent + TRAVEL).sort((a, b) => a.sent - b.sent);
    for (const b of due) {
      const r = sim.lim.offer(simTime(b.sent + TRAVEL));
      b.ok = r.ok;
      b.at = b.sent + TRAVEL;                 // reached the limiter
      b.leave = b.at + r.wait / SPEED;        // left it (later than `at` only when queued)
      if (r.ok) {
        sim.maxWait = Math.max(sim.maxWait, r.wait);
        if (r.wait > 0.5) event.textContent = tx({ en: `Request ${b.n} is in the bucket and will reach the server in ${Math.round(r.wait)} s.`, vi: `Request ${b.n} đang trong xô và sẽ tới server sau ${Math.round(r.wait)} giây.` });
        else event.textContent = tx({ en: `Request ${b.n} went straight through.`, vi: `Request ${b.n} đi thẳng qua.` });
      } else {
        sim.rejected++;
        event.textContent = `${tx({ en: `Request ${b.n} rejected.`, vi: `Request ${b.n} bị từ chối.` })} ${tx(WHY_REJECTED[s.algo])}`;
      }
    }
    sim.balls = sim.balls.filter(b => {
      if (b.ok === false && t > b.at + DROP) return false;
      if (b.ok && t > b.leave + TRAVEL) { sim.served++; return false; }
      return true;
    });
    served.set(String(sim.served), 'ok');
    rejected.set(String(sim.rejected), sim.rejected ? 'bad' : '');
    wait.set(`${Math.round(sim.maxWait)} s`, sim.maxWait > 10 ? 'bad' : 'ok');
  }

  function draw() {
    const { w, h } = chart.fit();
    const g = chart.g, t = now(), st = simTime(t);
    const mid = 112, appX = 34, srvX = w - 34;
    const box = { w: Math.max(130, Math.min(260, w - 200)), h: 170 };
    box.x = (w - box.w) / 2; box.y = mid - 90;
    g.clearRect(0, 0, w, h);
    g.font = '12px "Hanken Grotesk", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    // The app and the server.
    const node = (x, label, sub) => {
      g.fillStyle = css('surface2'); g.strokeStyle = css('line');
      g.beginPath(); g.roundRect(x - 26, mid - 34, 52, 68, 10); g.fill(); g.stroke();
      g.fillStyle = css('text'); g.fillText(label, x, mid - 6);
      if (sub != null) { g.fillStyle = css('ok'); g.font = '600 13px "IBM Plex Mono", monospace'; g.fillText(sub, x, mid + 14); g.font = '12px "Hanken Grotesk", sans-serif'; }
    };
    node(appX, tx({ en: 'App', vi: 'App' }));
    node(srvX, tx({ en: 'Server', vi: 'Server' }), String(sim.served));

    // The road: app -> limiter -> server.
    g.strokeStyle = css('line'); g.setLineDash([3, 5]);
    g.beginPath(); g.moveTo(appX + 26, mid); g.lineTo(box.x, mid); g.moveTo(box.x + box.w, mid); g.lineTo(srvX - 26, mid); g.stroke();
    g.setLineDash([]);

    drawLimiter(g, box, st);

    // The balls.
    const ball = (x, y, color, alpha = 1) => {
      g.globalAlpha = alpha; g.fillStyle = css(color);
      g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
    };
    const lerp = (a, b, p) => a + (b - a) * Math.min(1, Math.max(0, p));
    for (const b of sim.balls) {
      if (t < b.sent) continue;
      if (b.ok === undefined || t < b.at) ball(lerp(appX + 30, box.x - 6, (t - b.sent) / TRAVEL), mid, 'blue');
      else if (b.ok === false) {
        const p = (t - b.at) / DROP;
        ball(box.x - 10, mid + p * 70, 'bad', 1 - p * 0.8);
        g.globalAlpha = 1 - p; g.fillStyle = css('bad'); g.font = '600 11px "IBM Plex Mono", monospace';
        g.fillText('429', box.x - 30, mid + 10 + p * 70); g.globalAlpha = 1;
        g.font = '12px "Hanken Grotesk", sans-serif';
      } else if (t >= b.leave) ball(lerp(box.x + box.w + 6, srvX - 30, (t - b.leave) / TRAVEL), mid, 'ok');
      // Balls between `at` and `leave` are waiting in the leaky bucket, drawn by it.
    }

    g.textAlign = 'left'; g.fillStyle = css('muted'); g.font = '11px "IBM Plex Mono", monospace';
    g.fillText(tx({ en: `simulated time ${fmt(st)} · ${SPEED}× speed`, vi: `thời gian mô phỏng ${fmt(st)} · tốc độ ${SPEED}×` }), 8, h - 10);
  }

  /* The limiter, drawn as the state it keeps. */
  function drawLimiter(g, box, st) {
    const v = sim.lim.view(st);
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

    if (s.algo === 'token' || s.algo === 'leaky') {
      // A bucket with 40 slots, 8 across, filled from the bottom.
      const top = y + 18, bottom = y + h - 6, inset = 18;
      g.strokeStyle = css('muted'); g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, top); g.lineTo(x + inset, bottom); g.lineTo(x + w - inset, bottom); g.lineTo(x + w, top); g.stroke();
      g.lineWidth = 1;
      const cols = 8, rows = BURST / cols;
      const cw = (w - 2 * inset - 8) / cols, chh = (bottom - top - 8) / rows, r = Math.min(cw, chh) / 2 - 2;
      const slot = i => [x + inset + 4 + (i % cols + 0.5) * cw, bottom - 4 - (Math.floor(i / cols) + 0.5) * chh];
      if (s.algo === 'token') {
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
        for (let i = 0; i < v.queued; i++) {
          const [cx, cy] = slot(i);
          g.fillStyle = css('blue'); g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
        }
        // The hole: one drips out every 2 s.
        g.fillStyle = css('bg'); g.fillRect(x + w / 2 - 6, bottom - 2, 12, 4);
        g.fillStyle = css('blue'); g.font = '600 11px "IBM Plex Mono", monospace'; g.textAlign = 'center';
        g.fillText(tx({ en: 'leaks 1 / 2 s ↓', vi: 'rỉ 1 / 2 giây ↓' }), x + w / 2, bottom + 12);
        caption(tx({ en: `${v.queued} of ${BURST} waiting`, vi: `${v.queued} / ${BURST} đang chờ` }), 12, v.queued >= BURST ? 'bad' : 'muted');
      }
      return;
    }

    // The other three are counters: draw them in a panel.
    g.fillStyle = css('bg2'); g.strokeStyle = css('line');
    g.beginPath(); g.roundRect(x, y + 18, w, h - 24, 12); g.fill(); g.stroke();
    const px = x + 14, pw = w - 28;

    if (s.algo === 'fixed') {
      big(`${v.count} / ${FIXED.limit}`, y + 60, v.count >= FIXED.limit ? 'bad' : 'text');
      bar(px, y + 82, pw, v.count / FIXED.limit, v.count >= FIXED.limit ? 'bad' : 'ok');
      g.textAlign = 'left'; g.fillStyle = css('muted'); g.font = '11px "IBM Plex Mono", monospace';
      g.fillText(tx({ en: `minute resets in ${Math.ceil(FIXED.window - v.elapsed)} s`, vi: `phút mới sau ${Math.ceil(FIXED.window - v.elapsed)} giây` }), px, y + 118);
      bar(px, y + 130, pw, v.elapsed / FIXED.window, 'faint', 6);
      caption(tx({ en: 'requests this clock minute', vi: 'request trong phút này' }));
    } else if (s.algo === 'log') {
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
    } else if (s.algo === 'counter') {
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

  // Controls.
  const autosaveBtn = button('', () => {
    s.autosave = !s.autosave;
    if (s.autosave) sim.nextSave = now();
    paintAutosave();
  });
  const paintAutosave = () => {
    autosaveBtn.textContent = s.autosave
      ? tx({ en: 'Autosave every 3 s: on', vi: 'Tự lưu mỗi 3 giây: bật' })
      : tx({ en: 'Autosave every 3 s: off', vi: 'Tự lưu mỗi 3 giây: tắt' });
    autosaveBtn.setAttribute('aria-pressed', String(s.autosave));
    autosaveBtn.classList.toggle('on', s.autosave);
  };

  const locked = tx({ en: 'Make your call below to unlock the other algorithms.', vi: 'Trả lời câu hỏi bên dưới để mở khoá các thuật toán còn lại.' });
  root.append(
    row(
      choice(tx({ en: 'Algorithm', vi: 'Thuật toán' }), ALGOS.map(a => ({
        value: a.value, label: tx(a.label),
        disabled: !revealed && a.value !== 'fixed', title: !revealed && a.value !== 'fixed' ? locked : null,
      })), s.algo, v => { s.algo = v; reset(); }),
    ),
    how,
    el('div', { class: 'sim-buttons' }, [
      button(tx({ en: 'Send 1 request', vi: 'Gửi 1 request' }), () => send()),
      button(tx({ en: 'Open the app (40 at once)', vi: 'Mở app (40 cùng lúc)' }), () => { for (let i = 0; i < BURST; i++) send(i * 0.03); }),
      autosaveBtn,
      button(tx({ en: 'Reset', vi: 'Đặt lại' }), () => { s.autosave = false; paintAutosave(); reset(); }),
    ]),
    chart.el,
    event,
    el('div', { class: 'sim-stats' }, [served.el, rejected.el, wait.el, memory.el]),
    revealed ? '' : el('p', { class: 'sim-note' }, locked),
  );
  paintAutosave();
  reset();

  let raf = 0;
  const frame = () => { tick(); draw(); raf = requestAnimationFrame(frame); };
  raf = requestAnimationFrame(frame);
  const stopResize = onResize(chart.el, draw);
  return () => { cancelAnimationFrame(raf); stopResize(); };
}
