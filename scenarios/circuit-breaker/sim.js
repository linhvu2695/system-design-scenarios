/* One checkout pod, a third-party fraud API that stops answering, and five ways to
   live through it.

   Requests come in on the left: checkouts, and the pod's other traffic (/cart,
   /orders). Every outbound call takes a connection from the pod's pool of 40, drawn
   as a grid of slots coloured by what holds them. A checkout makes two calls: the
   fraud check, then payment. With a bulkhead (C, D) the same 40 slots are split by a
   wall: 8 only the fraud API may use, 32 for everything else. With a circuit breaker
   (B, D) a switch sits in front of the fraud API, with its window of recent outcomes,
   the countdown while it is open, and the single probe when it half-opens. While the
   fraud check is skipped, orders go to the review queue (the agreed fallback).

   A strip along the top plots each second's p99 for /cart and /orders, the p99 for
   checkout, and the calls the pod sends to the fraud API. A checklist along the bottom
   ticks the four constraints.

   The model (run()) steps every 50 ms, deterministic; js/sim-player.js supplies the
   controls and scoreboard. */

import { tx } from '../../js/i18n.js';
import { css } from '../../js/sim-kit.js';
import { player } from '../../js/sim-player.js';
import { node, icon } from '../../js/sim-draw.js';

export const SETUPS = ['today', 'retry', 'breaker', 'bulkhead', 'both'];
export const SITUATIONS = ['normal', 'hang', 'errors'];

export const DT = 0.05;
export const CHECKOUTS = 6;        // checkouts a second, per pod
export const OTHERS = 30;          // /cart and /orders requests a second, per pod
export const POOL = 40;            // outbound connections per pod
export const FRAUD_SLOTS = 8;      // C, D: the fraud API’s share of the 40
export const FRAUD_OK = 0.15;      // seconds a healthy fraud check takes
export const PAY = 0.2;           // seconds the payment call takes
export const OTHER_CALL = 0.05;    // seconds a /cart or /orders call takes
export const ERROR = 0.05;         // seconds a 503 from the fraud API takes
export const TIMEOUT = 20;         // today’s timeout on the fraud call
export const SHORT = 2;            // A: the shorter timeout
export const BACKOFF = [0.2, 0.4, 0.8];   // A: waits before retries 1, 2 and 3
export const WINDOW = 10;          // B, D: the breaker looks at the last 10 fraud calls
export const MIN_CALLS = 5;        // and decides once it has at least 5
export const FAIL_RATE = 0.5;      // it opens when half of them failed
export const OPEN_WAIT = 30;       // and stays open 30 s before one probe call
export const START = 5;            // the incident starts at 0:05
export const FIX = { normal: Infinity, hang: 95, errors: 80 };   // the provider fixes it
export const END = { normal: 30, hang: 145, errors: 130 };
// The constraints.
export const OTHER_P99 = 0.5;      // /cart and /orders: p99 under 500 ms, always
export const CHECKOUT_P99 = 2;     // checkout: p99 under 2 s from a minute into an incident
export const GRACE = 60;
export const TRICKLE = 0.1;        // calls to a failing provider: under 10% of normal
export const RESUME = 40;          // full fraud checks back within 40 s of the fix

const has = (setup, part) => ({
  breaker: setup === 'breaker' || setup === 'both',
  bulkhead: setup === 'bulkhead' || setup === 'both',
  retry: setup === 'retry',
}[part]);

/* What the fraud API does with a call that starts at time s: [seconds, ok]. */
function fraud(situation, setup, s) {
  const limit = has(setup, 'retry') ? SHORT : TIMEOUT;
  if (situation === 'normal' || s < START || s >= FIX[situation]) return [FRAUD_OK, true];
  return situation === 'hang' ? [limit, false] : [ERROR, false];
}

/* Run one situation through one setup. Pure; memoised, because the scoreboard asks often. */
const memo = new Map();
export function run(setup, situation) {
  const k = `${setup}:${situation}`;
  if (!memo.has(k)) memo.set(k, simulate(setup, situation));
  return memo.get(k);
}

function simulate(setup, situation) {
  const end = END[situation], fix = FIX[situation];
  const breaker = has(setup, 'breaker'), bulkhead = has(setup, 'bulkhead');
  const sharedSize = bulkhead ? POOL - FRAUD_SLOTS : POOL;
  const shared = new Array(sharedSize).fill(null);    // { kind, req, start, end, ok }
  const fenced = new Array(bulkhead ? FRAUD_SLOTS : 0).fill(null);
  const queue = [];                                   // waiting for a shared slot: { kind, req }
  let qHead = 0;
  const later = [];                                   // A: retries waiting out their backoff: { at, req }
  const reqs = [];                                    // every request: { kind, at, done, deferred, attempts }
  const calls = [];                                   // every fraud call start: { t, ok, probe }
  const cb = { state: 'closed', window: [], until: 0, probe: null, trips: [], closes: [] };
  const frames = [];
  let review = 0;

  const enqueue = (kind, req) => queue.push({ kind, req });

  // A checkout reaches its fraud check (first try, or a retry).
  function check(req, t) {
    if (breaker) {
      if (cb.state === 'open' && t >= cb.until) { cb.state = 'half'; cb.probe = null; }
      if (cb.state === 'open' || (cb.state === 'half' && cb.probe)) return skip(req, t, 'breaker');
      if (cb.state === 'half') { cb.probe = req; req.probe = true; }
    }
    if (bulkhead) {
      const i = fenced.indexOf(null);
      if (i < 0) { if (req.probe) cb.probe = null; return skip(req, t, 'bulkhead'); }
      start(fenced, i, 'fraud', req, t);
    } else enqueue('fraud', req);
  }

  // The fallback: accept the order now, check it later from the review queue.
  function skip(req, t, why) {
    req.deferred = why;
    review++;
    enqueue('pay', req);
  }

  function start(slots, i, kind, req, t) {
    let dur = kind === 'pay' ? PAY : OTHER_CALL, ok = true;
    if (kind === 'fraud') {
      [dur, ok] = fraud(situation, setup, t);
      req.attempts = (req.attempts || 0) + 1;
      calls.push({ t, ok, probe: !!req.probe });
    }
    slots[i] = { kind, req, start: t, end: t + dur, ok };
  }

  function finish(slot, t) {
    const { kind, req, ok } = slot;
    if (kind === 'other' || kind === 'pay') { req.done = t; return; }
    if (breaker) record(req, ok, t);
    if (ok) return enqueue('pay', req);
    if (has(setup, 'retry') && req.attempts <= BACKOFF.length) {
      later.push({ at: t + BACKOFF[req.attempts - 1], req });
      return;
    }
    skip(req, t, 'failed');
  }

  function record(req, ok, t) {
    if (req.probe) {
      req.probe = false; cb.probe = null;
      if (ok) { cb.state = 'closed'; cb.window = []; cb.closes.push(t); }
      else { cb.state = 'open'; cb.until = t + OPEN_WAIT; cb.trips.push(t); }
      return;
    }
    if (cb.state !== 'closed') return;
    cb.window.push(ok);
    if (cb.window.length > WINDOW) cb.window.shift();
    const fails = cb.window.filter(x => !x).length;
    if (cb.window.length >= MIN_CALLS && fails / cb.window.length >= FAIL_RATE) {
      cb.state = 'open'; cb.until = t + OPEN_WAIT; cb.trips.push(t);
    }
  }

  let nextCheckout = 0.03, nextOther = 0.01;
  const steps = Math.round(end / DT);
  for (let n = 0; n <= steps; n++) {
    const t = +(n * DT).toFixed(4);
    // Calls that finish.
    for (const slots of [fenced, shared])
      slots.forEach((s, i) => { if (s && s.end <= t + 1e-9) { slots[i] = null; finish(s, s.end); } });
    if (breaker && cb.state === 'open' && t >= cb.until) { cb.state = 'half'; cb.probe = null; }
    // Retries whose backoff is over, then new arrivals.
    for (let i = 0; i < later.length;) {
      if (later[i].at <= t + 1e-9) { check(later[i].req, t); later.splice(i, 1); } else i++;
    }
    while (nextCheckout <= t + 1e-9) {
      const req = { kind: 'checkout', at: nextCheckout };
      reqs.push(req); check(req, t);
      nextCheckout += 1 / CHECKOUTS;
    }
    while (nextOther <= t + 1e-9) {
      const req = { kind: 'other', at: nextOther };
      reqs.push(req); enqueue('other', req);
      nextOther += 1 / OTHERS;
    }
    // Free shared slots go to the front of the queue.
    for (let i = 0; i < shared.length && qHead < queue.length; i++)
      if (!shared[i]) { const q = queue[qHead++]; start(shared, i, q.kind, q.req, t); }

    if (n % 2 === 0) frames.push(frame(t));
  }

  function frame(t) {
    const waiting = { fraud: 0, pay: 0, other: 0 };
    for (let i = qHead; i < queue.length; i++) waiting[queue[i].kind]++;
    const snap = s => (s ? [s.kind, s.start, s.ok, !!s.req.probe] : null);
    return {
      t, shared: shared.map(snap), fenced: fenced.map(snap), waiting, review,
      cb: { state: cb.state, window: cb.window.slice(), until: cb.until, probe: !!cb.probe },
      retrying: later.length,
    };
  }

  // The scoreboard's facts.
  const lat = q => (q.done ?? end) - q.at;
  const p99 = xs => { if (!xs.length) return 0; const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(0.99 * (s.length - 1))]; };
  const inc = situation !== 'normal';
  const settled = inc ? [START + GRACE, fix] : [0, end - 2];
  const others = reqs.filter(q => q.kind === 'other' && q.at < end - 2);
  const late = reqs.filter(q => q.kind === 'checkout' && q.at >= settled[0] && q.at < settled[1]);
  const otherP99 = p99(others.map(lat));
  const checkoutP99 = p99(late.map(lat));
  const callsPerSec = calls.filter(c => c.t >= settled[0] && c.t < settled[1]).length / (settled[1] - settled[0]);
  const after = reqs.filter(q => q.kind === 'checkout' && q.at >= (inc ? fix + RESUME : 0) && q.at < end - 2);
  const checks = {
    others: otherP99 <= OTHER_P99,
    checkout: checkoutP99 <= CHECKOUT_P99,
    trickle: !inc || callsPerSec <= TRICKLE * CHECKOUTS,
    resume: after.every(q => !q.deferred),
  };

  // Per second, for the strip.
  const secs = Math.ceil(end);
  const perSec = Array.from({ length: secs }, () => ({ other: [], checkout: [], calls: 0 }));
  for (const q of reqs) { const s = Math.floor(q.at); if (s < secs) perSec[s][q.kind === 'other' ? 'other' : 'checkout'].push(lat(q)); }
  for (const c of calls) { const s = Math.floor(c.t); if (s < secs) perSec[s].calls++; }
  const strip = perSec.map(x => ({ other: p99(x.other), checkout: p99(x.checkout), calls: x.calls }));

  const r = {
    setup, situation, end, fix, frames, strip, calls, trips: cb.trips, closes: cb.closes, reqs,
    otherP99, checkoutP99, callsPerSec, checks, review,
    ok: Object.values(checks).every(Boolean),
    queuedAtTrip: 0,
    at: t => frames[Math.max(0, Math.min(frames.length - 1, Math.round(t / (2 * DT))))],
  };
  if (cb.trips.length) r.queuedAtTrip = r.at(cb.trips[0]).waiting.fraud;
  r.steps = story(r);
  r.summary = summary(r);
  return r;
}

export const survives = (setup, situation) => run(setup, situation).ok;

const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const secs = x => (x < 1 ? `${Math.round(x * 1000)} ms` : `${x < 10 ? x.toFixed(1) : Math.round(x)} s`);

const LABEL = {
  today: { en: 'Shared pool (today)', vi: 'Pool dùng chung (hiện tại)' },
  retry: { en: 'Timeout + retries', vi: 'Timeout + thử lại' },
  breaker: { en: 'Circuit breaker', vi: 'Circuit breaker' },
  bulkhead: { en: 'Bulkhead', vi: 'Bulkhead' },
  both: { en: 'Breaker + bulkhead', vi: 'Breaker + bulkhead' },
};

const SITUATION = {
  normal: { en: 'A normal afternoon', vi: 'Một buổi chiều bình thường' },
  hang: { en: 'Fraud API hangs', vi: 'API fraud treo' },
  errors: { en: 'Fraud API returns 503s', vi: 'API fraud trả 503' },
};

const HOW = {
  today: { en: 'Today: one pool of 40 connections for every outbound call from the pod, and a 20-second timeout on the fraud call.', vi: 'Hiện tại: một pool 40 kết nối cho mọi lời gọi đi ra từ pod, và timeout 20 giây cho lời gọi fraud.' },
  retry: { en: 'A: the fraud call gives up after 2 seconds and is retried up to 3 times, waiting 0.2, 0.4 and 0.8 seconds between tries.', vi: 'A: lời gọi fraud bỏ cuộc sau 2 giây và được thử lại tối đa 3 lần, chờ 0,2, 0,4 và 0,8 giây giữa các lần.' },
  breaker: { en: 'B: a circuit breaker in front of the fraud call. Closed, it watches the last 10 outcomes. When half of them failed it opens for 30 seconds, then lets one probe through.', vi: 'B: một circuit breaker đặt trước lời gọi fraud. Khi đóng, nó theo dõi 10 kết quả gần nhất. Khi một nửa trong số đó thất bại, nó mở trong 30 giây, rồi cho một probe đi qua.' },
  bulkhead: { en: 'C: the fraud API gets its own 8 of the 40 connections, behind a wall. When all 8 are busy, the order goes to pending review instead of waiting.', vi: 'C: API fraud có riêng 8 trong 40 kết nối, sau một bức tường. Khi cả 8 đều bận, đơn hàng chuyển sang chờ duyệt thay vì phải chờ.' },
  both: { en: 'D: the bulkhead’s 8 fraud connections, with the circuit breaker in front of them.', vi: 'D: 8 kết nối fraud của bulkhead, với circuit breaker đặt phía trước.' },
};

function story(r) {
  const { setup, situation, end, fix, trips, closes } = r;
  const m = [];
  const add = (t0, t1, dur, tone, en, vi) => { if (t1 > t0 || !m.length) m.push({ t0, t1, dur, tone, say: { en, vi } }); };
  add(0, 0, 2.5, null, HOW[setup].en, HOW[setup].vi);
  const trip = trips[0], close = closes[closes.length - 1];

  if (situation === 'normal') {
    add(0, end, 7, null, 'A normal afternoon. A fraud check takes 150 ms, so only one or two connections are busy with it at a time, and every order gets a real check.', 'Một buổi chiều bình thường. Một lần kiểm tra fraud mất 150 ms, nên mỗi lúc chỉ một hai kết nối bận với nó, và đơn nào cũng được kiểm tra thật.');
    return m;
  }
  add(0, START, 2, null, 'Business as usual: every order gets a real fraud check in 150 ms.', 'Mọi thứ như thường: đơn nào cũng được kiểm tra fraud thật trong 150 ms.');

  if (situation === 'hang') {
    const s1 = {
      today: ['warn', '0:05: the fraud API stops answering. Each fraud call now holds a connection until its 20-second timeout, and 6 new ones start every second.', '0:05: API fraud ngừng trả lời. Mỗi lời gọi fraud giờ giữ một kết nối tới khi hết timeout 20 giây, và mỗi giây có 6 lời gọi mới bắt đầu.'],
      retry: ['warn', '0:05: the fraud API stops answering. Each try now gives up after 2 seconds and the order tries again: up to four tries, about 8 seconds of holding a connection.', '0:05: API fraud ngừng trả lời. Mỗi lần thử giờ bỏ cuộc sau 2 giây và đơn hàng thử lại: tối đa bốn lần, khoảng 8 giây giữ một kết nối.'],
      breaker: ['warn', '0:05: the fraud API stops answering. The breaker is closed and has seen no failure: a hanging call only counts as failed when its 20-second timeout ends.', '0:05: API fraud ngừng trả lời. Breaker đang đóng và chưa thấy lỗi nào: một lời gọi treo chỉ tính là thất bại khi hết timeout 20 giây.'],
      bulkhead: ['warn', '0:05: the fraud API stops answering. Only the 8 fraud connections can be taken. The wall keeps the other 32 for /cart, /orders and payment.', '0:05: API fraud ngừng trả lời. Chỉ 8 kết nối fraud có thể bị chiếm. Bức tường giữ 32 kết nối còn lại cho /cart, /orders và thanh toán.'],
      both: ['warn', '0:05: the fraud API stops answering. Only the 8 fraud connections can be taken, and the breaker, still closed, has seen no failure yet.', '0:05: API fraud ngừng trả lời. Chỉ 8 kết nối fraud có thể bị chiếm, và breaker, vẫn đóng, chưa thấy lỗi nào.'],
    }[setup];
    add(START, 12, 4, ...s1);

    if (setup === 'today' || setup === 'retry') {
      add(12, 25, 4, 'bad', ...(setup === 'today'
        ? ['By 0:12 all 40 connections hold a hanging fraud call. /cart and /orders requests queue behind them, though their own services are healthy.', 'Tới 0:12 cả 40 kết nối đều giữ một lời gọi fraud đang treo. Request /cart và /orders xếp hàng phía sau, dù service của chính chúng vẫn khỏe.']
        : ['6 orders a second, each wanting a connection for about 8 seconds, need about 48 connections. The pool has 40, so the queue grows, with /cart and /orders stuck in it.', '6 đơn mỗi giây, mỗi đơn cần một kết nối khoảng 8 giây, tức cần khoảng 48 kết nối. Pool chỉ có 40, nên hàng đợi dài ra, với /cart và /orders kẹt trong đó.']));
      add(25, fix, 5, 'bad', ...(setup === 'today'
        ? [`0:25: the first calls time out and those orders go to pending review. Each freed connection goes to the front of the queue, often another fraud call that hangs 20 seconds more. A minute in, /cart and /orders p99 is ${secs(r.otherP99)} and checkout p99 is ${secs(r.checkoutP99)}.`, `0:25: những lời gọi đầu tiên hết timeout và các đơn đó chuyển sang chờ duyệt. Mỗi kết nối được giải phóng đi cho request đầu hàng đợi, thường lại là một lời gọi fraud treo thêm 20 giây. Sau một phút, p99 của /cart và /orders là ${secs(r.otherP99)} và p99 của checkout là ${secs(r.checkoutP99)}.`]
        : [`The fraud API gets ${r.callsPerSec.toFixed(0)} calls a second from this pod, three times normal, while it is asking clients to back off. /cart and /orders p99: ${secs(r.otherP99)}.`, `API fraud nhận ${r.callsPerSec.toFixed(0)} lời gọi mỗi giây từ pod này, gấp ba bình thường, đúng lúc nó đề nghị client giảm tải. p99 của /cart và /orders: ${secs(r.otherP99)}.`]));
      add(fix, end, 4, 'warn', `${clock(fix)}: the provider fixes the API. New fraud calls succeed again, but the backlog in the queue takes a while to drain.`, `${clock(fix)}: nhà cung cấp sửa xong API. Lời gọi fraud mới lại thành công, nhưng hàng tồn trong hàng đợi cần một lúc mới hết.`);
    }

    if (setup === 'breaker') {
      add(12, trip, 4, 'bad', 'Meanwhile every fraud call takes a shared connection. By 0:12 all 40 are taken, and /cart and /orders queue behind them.', 'Trong lúc đó mỗi lời gọi fraud chiếm một kết nối dùng chung. Tới 0:12 cả 40 đều bị chiếm, và /cart, /orders xếp hàng phía sau.');
      add(trip, START + GRACE, 5, 'bad', `${clock(trip)}: the first timeouts arrive and the breaker opens. New orders skip the fraud API. But ${r.queuedAtTrip} fraud calls were already waiting in the client’s queue, let through while it was closed, and each one hangs in turn.`, `${clock(trip)}: những timeout đầu tiên tới và breaker mở. Đơn mới bỏ qua API fraud. Nhưng ${r.queuedAtTrip} lời gọi fraud đã nằm sẵn trong hàng đợi của client, được cho qua khi breaker còn đóng, và lần lượt từng cái treo.`);
      add(START + GRACE, fix, 4, 'bad', `/cart and /orders are still stuck behind them: p99 ${secs(r.otherP99)}. When the breaker half-opens, its one probe waits in the same queue.`, `/cart và /orders vẫn kẹt phía sau chúng: p99 ${secs(r.otherP99)}. Khi breaker nửa mở, probe duy nhất của nó cũng phải chờ trong cùng hàng đợi đó.`);
      add(fix, end, 4, 'warn', `${clock(fix)}: the provider fixes the API. The backlog still has to drain before the probe gets through and closes the breaker.`, `${clock(fix)}: nhà cung cấp sửa xong API. Hàng tồn vẫn phải chạy hết trước khi probe đi qua được và đóng breaker.`);
    }

    if (setup === 'bulkhead') {
      add(12, 25, 4, null, 'The 8 fill within 2 seconds. New orders find them busy and go to pending review at once. /cart and /orders do not notice.', '8 kết nối đầy trong vòng 2 giây. Đơn mới thấy chúng bận và chuyển ngay sang chờ duyệt. /cart và /orders không hề hay biết.');
      add(25, fix, 6, 'bad', `0:25: the 8 calls time out, and the next 8 orders take the connections and hang for 20 seconds. It never stops calling: every 20 seconds, 8 more customers wait 20 seconds. Checkout p99: ${secs(r.checkoutP99)}.`, `0:25: 8 lời gọi hết timeout, và 8 đơn kế tiếp chiếm các kết nối rồi treo 20 giây. Nó không bao giờ ngừng gọi: cứ 20 giây lại có thêm 8 khách chờ 20 giây. p99 của checkout: ${secs(r.checkoutP99)}.`);
      add(fix, end, 4, null, `${clock(fix)}: the provider fixes the API. The next calls succeed.`, `${clock(fix)}: nhà cung cấp sửa xong API. Các lời gọi kế tiếp thành công.`);
    }

    if (setup === 'both') {
      const half = trip + OPEN_WAIT;
      add(12, trip, 4, null, 'The 8 fill within 2 seconds. New orders find them busy and go to pending review at once. /cart and /orders do not notice.', '8 kết nối đầy trong vòng 2 giây. Đơn mới thấy chúng bận và chuyển ngay sang chờ duyệt. /cart và /orders không hề hay biết.');
      add(trip, half, 5, null, `${clock(trip)}: the 8 calls time out and the breaker opens. From now on orders skip the fraud API: checkout answers in about a quarter of a second, and the provider gets nothing.`, `${clock(trip)}: 8 lời gọi hết timeout và breaker mở. Từ giờ đơn hàng bỏ qua API fraud: checkout trả lời trong khoảng một phần tư giây, và nhà cung cấp không nhận gì cả.`);
      add(half, fix, 5, 'warn', `${clock(half)}: half-open. One probe call goes through. The API still hangs, so 20 seconds later the probe fails and the breaker opens for another 30 seconds.`, `${clock(half)}: nửa mở. Một lời gọi probe đi qua. API vẫn treo, nên 20 giây sau probe thất bại và breaker mở thêm 30 giây nữa.`);
      add(fix, end, 5, null, `${clock(fix)}: the provider fixes the API. At ${clock(close)} the next probe succeeds and the breaker closes: orders get a real fraud check again.`, `${clock(fix)}: nhà cung cấp sửa xong API. Lúc ${clock(close)} probe kế tiếp thành công và breaker đóng lại: đơn hàng lại được kiểm tra fraud thật.`);
    }
  }

  if (situation === 'errors') {
    add(START, 8, 3, 'warn', '0:05: the fraud API starts answering every call with a 503 in about 50 ms. Nothing hangs, so no connection is held for long.', '0:05: API fraud bắt đầu trả 503 cho mọi lời gọi trong khoảng 50 ms. Không gì bị treo, nên không kết nối nào bị giữ lâu.');
    if (setup === 'breaker' || setup === 'both') {
      add(8, 36, 4, null, `${clock(trip)}: five 503s in a row and the breaker opens. Orders skip the fraud API and go to pending review at once.`, `${clock(trip)}: năm lần 503 liên tiếp và breaker mở. Đơn hàng bỏ qua API fraud và chuyển ngay sang chờ duyệt.`);
      add(36, fix, 5, 'warn', 'Every 30 seconds it half-opens and sends one probe. The probe gets a 503, and the breaker opens again. The provider sees one call every 30 seconds.', 'Cứ mỗi 30 giây nó nửa mở và gửi một probe. Probe nhận 503, và breaker lại mở. Nhà cung cấp chỉ thấy một lời gọi mỗi 30 giây.');
      add(fix, end, 4, null, `${clock(fix)}: the provider fixes the API. At ${clock(close)} the next probe succeeds and the breaker closes.`, `${clock(fix)}: nhà cung cấp sửa xong API. Lúc ${clock(close)} probe kế tiếp thành công và breaker đóng lại.`);
    } else {
      add(8, fix, 6, 'bad', ...{
        today: ['Every order calls it, gets a 503 and goes to pending review. Checkout and /cart are fine, but the provider still gets 6 calls a second from every pod, while it asks clients to back off.', 'Đơn nào cũng gọi nó, nhận 503 rồi chuyển sang chờ duyệt. Checkout và /cart vẫn ổn, nhưng nhà cung cấp vẫn nhận 6 lời gọi mỗi giây từ mỗi pod, đúng lúc nó đề nghị client giảm tải.'],
        retry: [`Every order calls it four times before giving up: ${r.callsPerSec.toFixed(0)} calls a second, four times normal, and each order waits through the backoff for nothing.`, `Đơn nào cũng gọi nó bốn lần trước khi bỏ cuộc: ${r.callsPerSec.toFixed(0)} lời gọi mỗi giây, gấp bốn bình thường, và mỗi đơn chờ qua backoff mà chẳng được gì.`],
        bulkhead: ['503s come back so fast that the 8 connections are never all busy, so nothing is turned away: every order still calls the API, 6 a second, while it asks clients to back off.', '503 trả về nhanh tới mức 8 kết nối không bao giờ cùng bận, nên chẳng đơn nào bị chặn: đơn nào cũng vẫn gọi API, 6 lần mỗi giây, đúng lúc nó đề nghị client giảm tải.'],
      }[setup]);
      add(fix, end, 4, null, `${clock(fix)}: the provider fixes the API. The next calls succeed.`, `${clock(fix)}: nhà cung cấp sửa xong API. Các lời gọi kế tiếp thành công.`);
    }
  }
  return m;
}

function summary(r) {
  if (r.ok) return {
    normal: { en: 'Every order got a real fraud check, and everything stayed fast.', vi: 'Đơn nào cũng được kiểm tra fraud thật, và mọi thứ vẫn nhanh.' },
    hang: { en: 'All four held: /cart and /orders never noticed, checkout kept answering, the provider got a trickle, and checks came back on their own.', vi: 'Cả bốn đều đạt: /cart và /orders không hề hay biết, checkout vẫn trả lời, nhà cung cấp chỉ nhận dòng nhỏ giọt, và việc kiểm tra tự quay lại.' },
    errors: { en: 'All four held: the breaker stopped the calls within a second and closed by itself after the fix.', vi: 'Cả bốn đều đạt: breaker chặn lời gọi trong vòng một giây và tự đóng lại sau khi sửa xong.' },
  }[r.situation];
  const c = r.checks, en = [], vi = [];
  if (!c.others) { en.push(`/cart and /orders p99 reached ${secs(r.otherP99)}, though their services were healthy.`); vi.push(`p99 của /cart và /orders lên tới ${secs(r.otherP99)}, dù service của chúng vẫn khỏe.`); }
  if (!c.checkout) { en.push(`A minute into the incident, checkout p99 was still ${secs(r.checkoutP99)}.`); vi.push(`Sau một phút sự cố, p99 của checkout vẫn là ${secs(r.checkoutP99)}.`); }
  if (!c.trickle) { en.push(`The pod kept sending the failing API ${r.callsPerSec.toFixed(1)} calls a second (normal is ${CHECKOUTS}).`); vi.push(`Pod vẫn gửi tới API đang lỗi ${r.callsPerSec.toFixed(1)} lời gọi mỗi giây (bình thường là ${CHECKOUTS}).`); }
  if (!c.resume) { en.push('Orders were still skipping the fraud check 40 seconds after the fix.'); vi.push('Đơn hàng vẫn bỏ qua kiểm tra fraud 40 giây sau khi sửa xong.'); }
  return { en: `Broken: ${en.join(' ')}`, vi: `Hỏng: ${vi.join(' ')}` };
}

export function mount(root, ctx) {
  let cached = null;   // the player asks for each run once; the drawing reads the same result
  return player(root, ctx, {
    situations: SITUATIONS.map(x => ({ value: x, label: tx(SITUATION[x]), icon: { normal: 'sun', hang: 'hourglass', errors: 'alert' }[x], tone: x === 'normal' ? 'ok' : undefined })),
    setups: SETUPS.map(x => ({ value: x, label: tx(LABEL[x]), icon: { today: 'server', retry: 'replay', breaker: 'power', bulkhead: 'grid', both: 'layers' }[x] })),
    initial: { situation: 'hang' },
    run: (setup, situation) => (cached = run(setup, situation)),
    survives, height: 540,
    duration: st => st.dur,
    tone: st => st.tone,
    draw: ({ g, w, h, k, p }) => {
      const st = cached.steps[k];
      draw(g, w, h, cached, st ? st.t0 + p * (st.t1 - st.t0) : cached.end);
    },
  });
}

/* ---------------- drawing ---------------- */

const mono = (px, wt = 600) => `${wt} ${px}px "IBM Plex Mono", monospace`;
const sans = (px, wt = 500) => `${wt} ${px}px "Hanken Grotesk", sans-serif`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const KIND = { fraud: 'pink', pay: 'violet', other: 'blue' };

function draw(g, w, h, r, t) {
  const { setup, situation } = r;
  const f = r.at(t);
  const breaker = has(setup, 'breaker'), bulkhead = has(setup, 'bulkhead');
  const incident = situation !== 'normal' && t >= START && t < r.fix;
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

  // ---- The strip: /cart p99, checkout p99, calls to the fraud API, each second. ----
  const sx0 = 168, sx1 = w - 14, X = s => sx0 + (s / r.end) * (sx1 - sx0);
  const rows = [[12, 38], [44, 70], [76, 102]];
  const labels = [
    [tx({ en: '/cart /orders p99', vi: 'p99 /cart /orders' }), '- - 500 ms'],
    [tx({ en: 'checkout p99', vi: 'p99 checkout' }), '- - 2 s'],
    [tx({ en: 'calls to fraud API', vi: 'lời gọi tới API fraud' }), tx({ en: '- - 10% of normal', vi: '- - 10% bình thường' })],
  ];
  labels.forEach(([a, b], i) => { text(a.toUpperCase(), 12, rows[i][0] + 7, 'muted', mono(9.5, 700)); text(b, 12, rows[i][0] + 19, 'bad', mono(9, 600)); });
  if (situation !== 'normal') {
    const x0 = X(START), x1 = X(Math.min(r.fix, r.end));
    box(x0, rows[0][0] - 4, x1 - x0, rows[2][1] - rows[0][0] + 8, 4, 'bad', null, 0.07);
    text(situation === 'hang' ? tx({ en: 'fraud API hangs', vi: 'API fraud treo' }) : tx({ en: 'fraud API: 503', vi: 'API fraud: 503' }), x0 + 4, rows[2][1] + 9, 'bad', mono(8.5, 600));
    if (r.fix < r.end) text(tx({ en: 'fixed', vi: 'đã sửa' }), x1 + 4, rows[2][1] + 9, 'ok', mono(8.5, 600));
  }
  rows.forEach(([a, b]) => box(sx0, a, sx1 - sx0, b - a, 4, 'bg2', null, 0.8));
  const Ylat = (v, [a, b]) => b - (Math.log10(clamp(v * 1000, 10, 60000) / 10) / Math.log10(6000)) * (b - a - 3);
  const Ycalls = (v, [a, b]) => b - (Math.min(v, 30) / 30) * (b - a - 3);
  const bw = (sx1 - sx0) / r.end;
  r.strip.forEach((x, s) => {
    if (s + 1 > t) return;
    const xs = X(s) + 0.5, ww = Math.max(1, bw - 1);
    let y = Ylat(x.other, rows[0]); box(xs, y, ww, rows[0][1] - y, 1, x.other > OTHER_P99 ? 'bad' : 'ok', null, 0.85);
    y = Ylat(x.checkout, rows[1]); box(xs, y, ww, rows[1][1] - y, 1, x.checkout > CHECKOUT_P99 ? 'bad' : 'ok', null, 0.85);
    const failing = situation !== 'normal' && s >= START && s < r.fix;
    y = Ycalls(x.calls, rows[2]); box(xs, y, ww, rows[2][1] - y, 1, failing && x.calls > TRICKLE * CHECKOUTS ? 'bad' : 'pink', null, 0.85);
  });
  line(sx0, Ylat(OTHER_P99, rows[0]), sx1, Ylat(OTHER_P99, rows[0]), 'bad', 0.7, 1, [4, 4]);
  line(sx0, Ylat(CHECKOUT_P99, rows[1]), sx1, Ylat(CHECKOUT_P99, rows[1]), 'bad', 0.7, 1, [4, 4]);
  line(sx0, Ycalls(TRICKLE * CHECKOUTS, rows[2]), sx1, Ycalls(TRICKLE * CHECKOUTS, rows[2]), 'bad', 0.7, 1, [4, 4]);
  if (situation !== 'normal') line(X(START + GRACE), rows[1][0] - 2, X(START + GRACE), rows[2][1] + 2, 'warn', 0.6, 1, [2, 3]);
  line(X(t), rows[0][0] - 3, X(t), rows[2][1] + 3, 'text', 0.6);
  text(clock(t), clamp(X(t), sx0 + 14, sx1 - 14), rows[2][1] + 20, 'text', mono(9.5, 600), 'center');

  // ---- Layout of the main row. ----
  const top = 138, bot = h - 76;
  const rw = clamp(w * 0.24, 160, 220), rx0 = w - 14 - rw;
  const px0 = 100, px1 = rx0 - 46;
  const mid = (top + bot) / 2;

  // Arrivals.
  const lane = [top + 70, top + 130];
  icon(g, 'card', 40, lane[0] - 14, 20, 'warn');
  text('checkout', 40, lane[0] + 10, 'warn', mono(9.5, 700), 'center');
  text(`${CHECKOUTS}/s`, 40, lane[0] + 22, 'warn', mono(9.5, 700), 'center');
  icon(g, 'user', 40, lane[1] - 14, 20, 'blue');
  text('/cart', 40, lane[1] + 10, 'blue', mono(9.5, 700), 'center');
  text('/orders', 40, lane[1] + 22, 'blue', mono(9.5, 700), 'center');
  text(`${OTHERS}/s`, 40, lane[1] + 34, 'blue', mono(9.5, 700), 'center');
  for (let i = 0; i < 4; i++) {
    const ph = (t * 0.9 + i / 4) % 1, x = 64 + ph * (px0 - 70);
    g.globalAlpha = Math.sin(ph * Math.PI);
    g.fillStyle = css('warn'); g.beginPath(); g.arc(x, lane[0] - 14, 3, 0, Math.PI * 2); g.fill();
    g.fillStyle = css('blue'); g.beginPath(); g.arc(x, lane[1] - 14, 3, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
  }

  // The pod.
  const queued = f.waiting.fraud + f.waiting.pay + f.waiting.other;
  node(g, { x: (px0 + px1) / 2, y: (top + bot) / 2, w: px1 - px0, h: bot - top, title: tx({ en: 'Checkout pod', vi: 'Pod checkout' }), icon: 'server', color: 'text', alert: queued > 200 });
  const ix0 = px0 + 14, ix1 = px1 - 14;

  // Its queue: requests waiting for a connection.
  const qy = top + 48;
  text(tx({ en: 'WAITING FOR A CONNECTION', vi: 'ĐANG CHỜ KẾT NỐI' }), ix0, qy, 'muted', mono(9, 700));
  text(tx({ en: `${queued} requests · ${f.waiting.fraud} fraud calls`, vi: `${queued} request · ${f.waiting.fraud} lời gọi fraud` }), ix1, qy, queued > 40 ? 'bad' : 'muted', mono(9.5, 600), 'right');
  const per = Math.floor((ix1 - ix0) / 7), cap = per * 2;
  const shown = Math.min(queued, cap), scale = queued ? shown / queued : 0;
  const nf = Math.round(f.waiting.fraud * scale), np = Math.round(f.waiting.pay * scale);
  box(ix0 - 4, qy + 9, ix1 - ix0 + 8, 24, 6, 'bg2', null, 0.8);
  for (let i = 0; i < shown; i++) {
    const kind = i < nf ? 'fraud' : i < nf + np ? 'pay' : 'other';
    g.fillStyle = css(KIND[kind]);
    g.beginPath(); g.arc(ix0 + 3 + (i % per) * 7, qy + 15 + Math.floor(i / per) * 8, 2.6, 0, Math.PI * 2); g.fill();
  }
  if (queued > cap) text(`+${queued - cap}`, ix1, qy + 42, 'bad', mono(9, 700), 'right');

  // The pool, and the breaker in front of it.
  const ay = qy + 52;
  let poolX0 = ix0;
  if (breaker) drawBreaker(g, ix0, ay, 150, bot - 14 - ay, f, t, text, box);
  else {
    // No breaker: an empty bay, so every setup lines up and the gap is visible.
    g.save(); g.setLineDash([4, 4]); box(ix0, ay, 150, Math.min(bot - 14 - ay, 200), 10, null, 'line', 1, 1); g.restore();
    text(tx({ en: 'NO CIRCUIT BREAKER', vi: 'KHÔNG CÓ CIRCUIT BREAKER' }), ix0 + 75, ay + 80, 'faint', mono(9, 700), 'center');
    text(tx({ en: 'every order calls', vi: 'đơn nào cũng gọi' }), ix0 + 75, ay + 98, 'faint', mono(9, 500), 'center');
    text(tx({ en: 'the fraud API', vi: 'API fraud' }), ix0 + 75, ay + 112, 'faint', mono(9, 500), 'center');
  }
  poolX0 = ix0 + 166;
  const cols = 8;
  const cell = clamp(Math.floor((ix1 - poolX0) / cols), 16, 30);
  const gw = cols * cell, gx = poolX0 + Math.max(0, (ix1 - poolX0 - gw) / 2);
  const slot = (x, y, s) => {
    box(x + 2, y + 2, cell - 4, cell - 4, 4, 'bg2', 'line', 1);
    if (!s) return;
    const [kind, start, ok, probe] = s, age = t - start;
    const hanging = kind === 'fraud' && !ok && situation === 'hang';
    const color = hanging && age > 0.5 ? 'bad' : KIND[kind];
    box(x + 2, y + 2, cell - 4, cell - 4, 4, color, null, hanging ? 0.35 : 0.85);
    if (hanging) {
      const limit = has(setup, 'retry') ? SHORT : TIMEOUT;
      g.save(); g.strokeStyle = css('bad'); g.lineWidth = 2;
      g.beginPath(); g.arc(x + cell / 2, y + cell / 2, cell / 2 - 6, -Math.PI / 2, -Math.PI / 2 + clamp(age / limit, 0, 1) * Math.PI * 2); g.stroke(); g.restore();
    }
    if (probe) box(x + 1, y + 1, cell - 2, cell - 2, 5, null, 'warn', 1, 2);
  };
  let fenceY = null, sharedY = ay + 16;
  if (bulkhead) {
    fenceY = ay + 16;
    text(tx({ en: 'FRAUD API ONLY · 8', vi: 'CHỈ CHO API FRAUD · 8' }), gx, ay + 6, 'pink', mono(9, 700));
    box(gx - 4, fenceY - 4, gw + 8, cell + 8, 7, 'pink', 'pink', 0.06, 1.5);
    f.fenced.forEach((s, i) => slot(gx + i * cell, fenceY, s));
    // The wall.
    const wy = fenceY + cell + 12;
    g.save(); g.fillStyle = css('warn'); g.globalAlpha = 0.85;
    for (let x = gx - 4; x < gx + gw + 4; x += 8) { g.beginPath(); g.moveTo(x, wy + 4); g.lineTo(x + 4, wy - 2); g.lineTo(x + 7, wy - 2); g.lineTo(x + 3, wy + 4); g.fill(); }
    g.restore();
    text(tx({ en: 'bulkhead', vi: 'bulkhead' }), gx + gw + 8, wy + 1, 'warn', mono(8.5, 700), 'left');
    sharedY = wy + 26;
  }
  text(bulkhead ? tx({ en: 'EVERYTHING ELSE · 32', vi: 'MỌI THỨ KHÁC · 32' }) : tx({ en: 'SHARED POOL · 40 CONNECTIONS', vi: 'POOL DÙNG CHUNG · 40 KẾT NỐI' }), gx, sharedY - 10, 'muted', mono(9, 700));
  f.shared.forEach((s, i) => slot(gx + (i % cols) * cell, sharedY + Math.floor(i / cols) * cell, s));
  const sharedBot = sharedY + Math.ceil(f.shared.length / cols) * cell;

  // ---- Right column: the fraud API, the review queue, the other services. ----
  const nh = 74, fy = top + nh / 2 + 4, sy = bot - nh / 2 - 4, ry = (fy + sy) / 2;
  const cx = rx0 + rw / 2;
  const hanging = f.fenced.concat(f.shared).filter(s => s && s[0] === 'fraud').length;
  const fraudState = situation === 'normal' || t < START || t >= r.fix ? 'ok' : 'bad';
  node(g, { x: cx, y: fy, w: rw, h: nh, title: tx({ en: 'Fraud API · 3rd party', vi: 'API fraud · bên thứ ba' }), icon: 'alert', color: fraudState === 'ok' ? 'ok' : 'bad', alert: fraudState === 'bad' });
  text(fraudState === 'ok' ? tx({ en: 'healthy · 150 ms', vi: 'khỏe · 150 ms' }) : situation === 'hang' ? tx({ en: 'not answering', vi: 'không trả lời' }) : tx({ en: '503 in 50 ms', vi: '503 trong 50 ms' }), rx0 + 14, fy + 8, fraudState, mono(10.5, 700));
  text(tx({ en: `open calls from this pod: ${hanging}`, vi: `lời gọi đang mở từ pod này: ${hanging}` }), rx0 + 14, fy + 25, 'muted', mono(9.5, 500));

  const recent = r.at(Math.max(0, t - 1)).review;
  node(g, { x: cx, y: ry, w: rw, h: 60, title: tx({ en: 'Pending review', vi: 'Chờ duyệt' }), icon: 'book', color: 'warn', active: f.review > recent });
  text(tx({ en: `${f.review} orders, no fraud check`, vi: `${f.review} đơn, chưa kiểm tra fraud` }), rx0 + 14, ry + 12, f.review ? 'warn' : 'muted', mono(10, 600));

  node(g, { x: cx, y: sy, w: rw, h: nh, title: tx({ en: 'Payments · cart · orders', vi: 'Thanh toán · giỏ · đơn' }), icon: 'db', color: 'blue' });
  text(tx({ en: 'healthy, ~50–200 ms', vi: 'khỏe, ~50–200 ms' }), rx0 + 14, sy + 8, 'ok', mono(10, 600));
  const busy = f.shared.filter(s => s && s[0] !== 'fraud').length;
  text(tx({ en: `open calls from this pod: ${busy}`, vi: `lời gọi đang mở từ pod này: ${busy}` }), rx0 + 14, sy + 25, 'muted', mono(9.5, 500));

  // Roads from the pool to the right column.
  const fromFraud = bulkhead ? [gx + gw + 4, fenceY + cell / 2] : [gx + gw + 4, sharedY + cell];
  const fraudColor = hanging ? (fraudState === 'bad' && situation === 'hang' ? 'bad' : 'pink') : null;
  roadLine(g, fromFraud, [rx0, fy], fraudColor, t);
  roadLine(g, [gx + gw + 4, (sharedY + sharedBot) / 2], [rx0, sy], busy ? 'blue' : null, t);
  if (r.at(t).review > r.at(Math.max(0, t - 0.5)).review) roadLine(g, [ix1 + 14, ry], [rx0, ry], 'warn', t);

  // ---- The checklist. ----
  checks(g, w, h, r, t, text, box);
  void incident;
}

function roadLine(g, [x1, y1], [x2, y2], color, t) {
  g.save();
  if (color) { g.strokeStyle = css(color); g.globalAlpha = 0.75; g.lineWidth = 2; g.setLineDash([6, 6]); g.lineDashOffset = -(t * 24) % 12; }
  else { g.strokeStyle = css('line'); g.setLineDash([3, 5]); }
  g.beginPath(); g.moveTo(x1, y1); g.bezierCurveTo((x1 + x2) / 2, y1, (x1 + x2) / 2, y2, x2, y2); g.stroke();
  g.restore();
}

/* The breaker: its state, a switch, its window of recent outcomes, and the countdown. */
function drawBreaker(g, x, y, bw, bh, f, t, text, box) {
  const { state, window, until, probe } = f.cb;
  const color = state === 'closed' ? 'ok' : state === 'open' ? 'bad' : 'warn';
  box(x, y, bw, Math.min(bh, 200), 10, color, color, 0.06, 1.5);
  text(tx({ en: 'CIRCUIT BREAKER', vi: 'CIRCUIT BREAKER' }), x + 10, y + 14, 'muted', mono(9, 700));
  const label = { closed: tx({ en: 'CLOSED', vi: 'ĐÓNG' }), open: tx({ en: 'OPEN', vi: 'MỞ' }), half: tx({ en: 'HALF-OPEN', vi: 'NỬA MỞ' }) }[state];
  text(label, x + 10, y + 32, color, mono(13, 700));

  // The switch: two contacts and a lever, shut while closed, lifted while open.
  const sy = y + 70, a = x + 30, b = x + bw - 30;
  g.save(); g.strokeStyle = css(color); g.fillStyle = css(color); g.lineWidth = 3; g.lineCap = 'round';
  g.beginPath(); g.moveTo(x + 10, sy); g.lineTo(a, sy); g.moveTo(b, sy); g.lineTo(x + bw - 10, sy); g.stroke();
  g.beginPath(); g.arc(a, sy, 4, 0, Math.PI * 2); g.fill(); g.beginPath(); g.arc(b, sy, 4, 0, Math.PI * 2); g.fill();
  const lift = state === 'closed' ? 0 : state === 'open' ? 0.55 : 0.25;
  g.beginPath(); g.moveTo(a, sy); g.lineTo(a + (b - a) * Math.cos(lift), sy - (b - a) * Math.sin(lift)); g.stroke();
  g.restore();
  if (state === 'open') {
    const left = Math.max(0, until - t);
    text(tx({ en: `probe in ${Math.ceil(left)} s`, vi: `probe sau ${Math.ceil(left)} giây` }), x + bw / 2, sy + 22, 'bad', mono(10, 600), 'center');
    box(x + 10, sy + 32, bw - 20, 5, 2, 'bg2');
    box(x + 10, sy + 32, (bw - 20) * clamp(1 - left / OPEN_WAIT, 0, 1), 5, 2, 'bad', null, 0.8);
  } else if (state === 'half') {
    text(probe ? tx({ en: '1 probe in flight', vi: '1 probe đang chạy' }) : tx({ en: 'next order is the probe', vi: 'đơn kế tiếp là probe' }), x + bw / 2, sy + 22, 'warn', mono(10, 600), 'center');
  } else {
    text(tx({ en: 'calls go through', vi: 'lời gọi đi qua' }), x + bw / 2, sy + 22, 'ok', mono(10, 600), 'center');
  }

  // The window: the last 10 outcomes it decides on.
  const wy = sy + 60;
  text(tx({ en: `LAST ${WINDOW} CALLS`, vi: `${WINDOW} LỜI GỌI GẦN NHẤT` }), x + 10, wy, 'muted', mono(8.5, 700));
  const d = (bw - 20) / WINDOW;
  for (let i = 0; i < WINDOW; i++) {
    const v = window[i];
    g.fillStyle = css(v === undefined ? 'line' : v ? 'ok' : 'bad');
    g.beginPath(); g.arc(x + 10 + d * (i + 0.5), wy + 16, Math.min(5, d / 2 - 1), 0, Math.PI * 2); g.fill();
  }
  const fails = window.filter(v => !v).length;
  text(state === 'closed' ? tx({ en: `${fails} failed · opens at ${WINDOW * FAIL_RATE}`, vi: `${fails} lỗi · mở khi ${WINDOW * FAIL_RATE}` }) : tx({ en: 'not counting while open', vi: 'không đếm khi đang mở' }), x + 10, wy + 34, fails >= MIN_CALLS ? 'bad' : 'muted', mono(9, 500));
}

/* The four constraints, ticked live. */
function checks(g, w, h, r, t, text, box) {
  const done = t >= r.end - 1e-6, inc = r.situation !== 'normal';
  const from = START + GRACE;
  const between = (q, a, b) => q.at >= a && q.at < Math.min(b, t);
  const lat = q => (q.done !== undefined && q.done <= t ? q.done : t) - q.at;
  const p99 = xs => { if (!xs.length) return 0; const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(0.99 * (s.length - 1))]; };
  const seen = r.strip.slice(0, Math.max(0, Math.floor(t)));
  const worst = Math.max(0, ...seen.map(x => x.other));
  const items = [];
  items.push({ label: tx({ en: '/cart /orders under 500 ms', vi: '/cart /orders dưới 500 ms' }), value: secs(done ? r.otherP99 : worst), ok: done ? r.checks.others : worst <= OTHER_P99 });
  if (!inc || t >= from) {
    const lateQ = r.reqs.filter(q => q.kind === 'checkout' && between(q, inc ? from : 0, inc ? r.fix : r.end));
    const v = done ? r.checkoutP99 : p99(lateQ.map(lat));
    items.push({ label: tx({ en: 'checkout p99 under 2 s', vi: 'p99 checkout dưới 2 giây' }), value: secs(v), ok: done ? r.checks.checkout : v <= CHECKOUT_P99 });
  } else items.push({ label: tx({ en: 'checkout p99 under 2 s', vi: 'p99 checkout dưới 2 giây' }), value: tx({ en: 'from 1:05', vi: 'từ 1:05' }) });
  if (!inc) items.push({ label: tx({ en: 'back off a failing API', vi: 'giảm tải cho API đang lỗi' }), value: tx({ en: 'no incident', vi: 'không có sự cố' }), ok: true });
  else if (t >= from) {
    const span = Math.max(0.5, Math.min(t, r.fix) - from);
    const v = done ? r.callsPerSec : r.calls.filter(c => c.t >= from && c.t < Math.min(t, r.fix)).length / span;
    items.push({ label: tx({ en: 'back off a failing API', vi: 'giảm tải cho API đang lỗi' }), value: tx({ en: `${v.toFixed(1)} calls/s`, vi: `${v.toFixed(1)} lời gọi/s` }), ok: done ? r.checks.trickle : v <= TRICKLE * CHECKOUTS });
  } else items.push({ label: tx({ en: 'back off a failing API', vi: 'giảm tải cho API đang lỗi' }), value: tx({ en: 'from 1:05', vi: 'từ 1:05' }) });
  const back = inc ? r.fix + RESUME : 0;
  if (t >= back) {
    const skipped = r.reqs.filter(q => q.kind === 'checkout' && between(q, back, r.end - 2) && q.deferred).length;
    items.push({ label: tx({ en: 'real checks resume', vi: 'kiểm tra thật quay lại' }), value: skipped ? tx({ en: `${skipped} skipped`, vi: `${skipped} đơn bỏ qua` }) : tx({ en: 'all checked', vi: 'đều được kiểm tra' }), ok: done ? r.checks.resume : !skipped });
  } else items.push({ label: tx({ en: 'real checks resume', vi: 'kiểm tra thật quay lại' }), value: tx({ en: `from ${clock(back)}`, vi: `từ ${clock(back)}` }) });

  const y = h - 62, cw = (w - 28 - 30) / 4;
  items.forEach((it, i) => {
    const x = 14 + i * (cw + 10);
    const tone = it.ok === undefined ? 'muted' : it.ok ? 'ok' : 'bad';
    box(x, y, cw, 50, 8, tone, tone, 0.07, 1);
    icon(g, it.ok === undefined ? 'clock' : it.ok ? 'check' : 'cross', x + 16, y + 17, 14, tone);
    text(it.label, x + 30, y + 17, 'text', sans(11.5, 600), 'left', cw - 38);
    text(it.value, x + 30, y + 35, tone, mono(11, 700), 'left', cw - 38);
  });
}
