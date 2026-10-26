/* Watch one parcel's last two scans travel: carrier -> your API -> queue -> workers ->
   the parcel's row in the database -> the shopper's phone. The parcel card changes
   colour as each scan is applied and flashes red if it goes backwards. Pick a
   situation (something going wrong on the way) and a setup. js/sim-player.js supplies
   the controls, captions and scoreboard: the timeline is cut into steps at each moment
   worth a caption (story()), and drawScene() shows the scene at any time t. Before the
   visitor answers, only today's setup is unlocked. Time is compressed: one unit is
   about a second on screen. */

import { el } from '../../js/dom.js';
import { tx } from '../../js/i18n.js';
import { stat, css } from '../../js/sim-kit.js';
import { player } from '../../js/sim-player.js';

export const NET = 1;          // carrier -> your API
export const RETRY = 8;        // a failed webhook comes back this much later ("20 min")
export const WORK = 1.2;       // a worker handling one event
export const HOP = 0.5;        // worker -> database
export const CRASH_AT = 0.6;   // a crashing worker dies this far into the work
export const VIS = 3;          // a crashed message is invisible this long ("30 s")
export const HOLD = 4;         // the reorder buffer's window ("30 s")
export const BACKLOG = 2.5;    // extra wait per event behind everyone else, single worker
export const PEAK = 3000, PER_WORKER = 400, WORKERS = 12;

export const STRATEGIES = ['today', 'single', 'fifo', 'buffer', 'seq'];
export const SITUATIONS = ['normal', 'offline', 'retry', 'crash', 'dup'];

/* Each situation: the copies of scans 3 and 4 the carrier sends.
   scan: when it was scanned; send: when the carrier sends it; net: how long it takes
   to reach you; fail: the first attempt fails and is retried; crash: the first worker
   to handle it dies; dup: this copy is a duplicate. */
const CASES = {
  normal: [
    { seq: 3, scan: 0, send: 0, net: NET },
    { seq: 4, scan: 2.5, send: 2.5, net: NET },
  ],
  offline: [   // stored on an offline scanner, uploaded together, sent in parallel
    { seq: 3, scan: 0, send: 3, net: 1.3 },
    { seq: 4, scan: 1, send: 3, net: 0.9 },
  ],
  retry: [
    { seq: 3, scan: 0, send: 0, net: NET, fail: true },
    { seq: 4, scan: 2.5, send: 2.5, net: NET },
  ],
  crash: [
    { seq: 3, scan: 0, send: 0, net: NET, crash: true },
    { seq: 4, scan: 1.2, send: 1.2, net: NET },
  ],
  dup: [
    { seq: 3, scan: 0, send: 0, net: NET },
    { seq: 4, scan: 2.5, send: 2.5, net: NET },
    { seq: 3, scan: 0, send: 7, net: NET, dup: true },
  ],
};

/* Everything that happens to every copy under a setup, as times. Pure, so the
   argument is pinned by tests/event-ordering.test.js.
   copies: [{ id, seq, dup, scan, send, failAt?, arrive, release, picks: [{ slot, at, crashAt?, back? }], done, apply }]
   applies: [{ id, seq, at, result: 'applied' | 'backwards' | 'skipped' }], in time order. */
export function timeline(strategy, situation) {
  const copies = CASES[situation].map((c, id) => {
    const failAt = c.fail ? c.send + c.net : null;
    const arrive = c.fail ? failAt + RETRY + c.net : c.send + c.net;
    return { ...c, id, failAt, arrive, release: arrive, picks: [] };
  });

  // The reorder buffer: when a copy's hold expires, release everything held with an
  // earlier or equal scan time, oldest scan first.
  if (strategy === 'buffer') {
    const done = new Set();
    for (const c of [...copies].sort((a, b) => a.arrive - b.arrive)) {
      if (done.has(c)) continue;
      const at = c.arrive + HOLD;
      copies.filter(x => !done.has(x) && x.arrive <= at && x.scan <= c.scan)
        .sort((a, b) => a.scan - b.scan)
        .forEach((x, k) => { x.release = at + k * 0.15; done.add(x); });
    }
  }

  // Workers. Three slots on screen (twelve in production); one for a single worker.
  // FIFO by parcel: this parcel's copies go one at a time, in arrival order, and a
  // crashed copy keeps its place at the front. Otherwise a crashed copy comes back
  // after the visibility timeout, behind whatever arrived meanwhile.
  const slots = new Array(strategy === 'single' ? 1 : 3).fill(0);
  const pending = copies.map(c => ({ c, ready: c.release, crashed: false }));
  let groupFree = 0;
  while (pending.length) {
    const freeAt = Math.min(...slots), slot = slots.indexOf(freeAt);
    let next;
    if (strategy === 'fifo') next = pending.reduce((a, b) => (b.c.release < a.c.release ? b : a));
    else next = pending.reduce((a, b) => (b.ready < a.ready || (b.ready === a.ready && b.c.release < a.c.release) ? b : a));
    let at = Math.max(next.ready, freeAt, strategy === 'fifo' ? groupFree : 0);
    if (strategy === 'single') at += BACKLOG;
    if (next.c.crash && !next.crashed) {
      const crashAt = at + CRASH_AT, back = crashAt + VIS;
      next.c.picks.push({ slot, at, crashAt, back });
      slots[slot] = crashAt;
      next.ready = back;
      next.crashed = true;
      if (strategy === 'fifo') groupFree = back;
      continue;
    }
    next.c.picks.push({ slot, at });
    next.c.done = at + WORK;
    next.c.apply = next.c.done + HOP;
    slots[slot] = next.c.done;
    if (strategy === 'fifo') groupFree = next.c.done;
    pending.splice(pending.indexOf(next), 1);
  }

  // Apply in time order. Today's code sets the status to whatever arrives; the seq
  // check only moves forward.
  let shown = 2, best = 2;
  const applies = [...copies].sort((a, b) => a.apply - b.apply).map(c => {
    let result;
    if (strategy === 'seq') result = c.seq > shown ? 'applied' : 'skipped';
    else if (c.seq === shown) result = 'skipped';
    else result = c.seq < best ? 'backwards' : 'applied';
    if (result !== 'skipped') { shown = c.seq; best = Math.max(best, c.seq); }
    return { id: c.id, seq: c.seq, at: c.apply, result };
  });
  const end = Math.max(...copies.map(c => c.apply)) + 1.5;
  return { copies, applies, final: shown, backwards: applies.some(a => a.result === 'backwards'), end };
}

/* Did the parcel end up right, without ever going backwards? */
export const survives = (strategy, situation) => {
  const t = timeline(strategy, situation);
  return !t.backwards && t.final === 4;
};

const LABEL = {
  today: { en: 'Today: parallel workers', vi: 'Hiện tại: worker song song' },
  single: { en: 'Single worker', vi: 'Một worker' },
  fifo: { en: 'FIFO by parcel', vi: 'FIFO theo kiện hàng' },
  buffer: { en: '30 s reorder buffer', vi: 'Bộ đệm 30 giây' },
  seq: { en: 'Check seq on write', vi: 'Kiểm tra seq khi ghi' },
};
const SITUATION = {
  normal: { en: 'Normal day', vi: 'Ngày bình thường' },
  offline: { en: 'Scanner offline', vi: 'Máy quét offline' },
  retry: { en: 'Webhook retried', vi: 'Webhook gửi lại' },
  crash: { en: 'Worker crashes', vi: 'Worker bị sập' },
  dup: { en: 'Late duplicate', vi: 'Bản trùng đến muộn' },
};
const INTRO = {
  normal: { en: 'The driver scans the parcel out for delivery, then delivers it. Everything is online.', vi: 'Tài xế quét kiện hàng khi bắt đầu giao, rồi giao xong. Mọi thứ đều online.' },
  offline: { en: 'The driver is in a basement: scans 3 and 4 are stored on the scanner and uploaded together. The carrier sends both at once, in parallel.', vi: 'Tài xế đang ở tầng hầm: lần quét 3 và 4 được lưu trên máy và tải lên cùng lúc. Hãng gửi cả hai cùng một lúc, song song.' },
  retry: { en: 'Your API times out on scan 3’s webhook. The carrier will retry it about 20 minutes later.', vi: 'API của bạn bị timeout với webhook của lần quét 3. Hãng sẽ gửi lại khoảng 20 phút sau.' },
  crash: { en: 'The worker handling scan 3 crashes halfway (a deploy). The message comes back to the queue 30 seconds later.', vi: 'Worker đang xử lý lần quét 3 bị sập giữa chừng (đang deploy). Message quay lại queue sau 30 giây.' },
  dup: { en: 'The carrier sends scan 3 a second time an hour later, long after scan 4.', vi: 'Hãng gửi lại lần quét 3 thêm một lần một giờ sau, rất lâu sau lần quét 4.' },
};
const KIND = { 2: { en: 'At depot', vi: 'Tới kho' }, 3: { en: 'Out for delivery', vi: 'Đang giao' }, 4: { en: 'Delivered', vi: 'Đã giao' } };
const COLOR = { 2: 'blue', 3: 'violet', 4: 'ok' };


/* The moments worth a caption, in time order: [{ t, tone, say: { en, vi } }]. Pure. */
export function story(strategy, situation, tl = timeline(strategy, situation)) {
  const out = [{ t: 0, tone: null, say: INTRO[situation] }];
  const add = (t, tone, en, vi) => out.push({ t, tone, say: { en, vi } });
  const name = c => c.dup
    ? { en: `the duplicate of scan ${c.seq}`, vi: `bản trùng của lần quét ${c.seq}` }
    : { en: `scan ${c.seq}`, vi: `lần quét ${c.seq}` };
  const cap = s => s[0].toUpperCase() + s.slice(1);
  for (const c of tl.copies) {
    const n = name(c);
    if (c.failAt != null) add(c.failAt, 'warn', `Scan ${c.seq}’s webhook failed at your API. The carrier will retry later.`, `Webhook của lần quét ${c.seq} lỗi tại API của bạn. Hãng sẽ gửi lại sau.`);
    for (const p of c.picks) if (p.crashAt != null) add(p.crashAt, 'warn', `The worker crashed while handling ${n.en}. It will come back to the queue.`, `Worker bị sập khi đang xử lý ${n.vi}. Nó sẽ quay lại queue.`);
    if (strategy === 'buffer') add(c.arrive, null, `${cap(n.en)} waits in the buffer for 30 s.`, `${cap(n.vi)} chờ trong bộ đệm 30 giây.`);
    else add(c.arrive, null, `${cap(n.en)} reaches your API and goes on the queue.`, `${cap(n.vi)} tới API của bạn và vào queue.`);
    c.picks.forEach((p, i) => add(p.at, null,
      i ? `A worker picks up ${n.en} again.` : `A worker picks up ${n.en}.`,
      i ? `Một worker nhận lại ${n.vi}.` : `Một worker nhận ${n.vi}.`));
  }
  for (const a of tl.applies) {
    const n = name(tl.copies[a.id]), kind = KIND[a.seq];
    if (a.result === 'applied') add(a.at, null, `Applied ${n.en}: the parcel is now ${kind.en}. Notification sent.`, `Đã áp dụng ${n.vi}: kiện hàng giờ là ${kind.vi}. Đã gửi thông báo.`);
    if (a.result === 'backwards') add(a.at, 'bad', `Applied ${n.en} after scan 4: the parcel went BACK to ${kind.en}, and the shopper got the notification.`, `Áp dụng ${n.vi} sau lần quét 4: kiện hàng QUAY LẠI ${kind.vi}, và người mua nhận thông báo.`);
    if (a.result === 'skipped') {
      if (strategy === 'seq') add(a.at, null, `${cap(n.en)} is older than what the parcel has (seq ${a.seq} ≤ last seq). Kept in history; status and phone untouched.`, `${cap(n.vi)} cũ hơn trạng thái hiện có (seq ${a.seq} ≤ seq cuối). Chỉ lưu lịch sử; trạng thái và điện thoại không đổi.`);
      else add(a.at, null, `${cap(n.en)} matches the current status. Nothing changes.`, `${cap(n.vi)} trùng với trạng thái hiện tại. Không có gì thay đổi.`);
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/* One run for the player: each step runs from one captioned moment to the next. */
export function run(strategy, situation) {
  const tl = timeline(strategy, situation);
  const moments = story(strategy, situation, tl);
  const steps = moments.map((m, i) => ({ ...m, t0: m.t, t1: i + 1 < moments.length ? moments[i + 1].t : tl.end }));
  const ok = !tl.backwards && tl.final === 4;
  const summary = ok
    ? { en: 'Correct: the parcel ends Delivered and never went backwards.', vi: 'Đúng: kiện hàng kết thúc ở Đã giao và chưa từng quay lùi.' }
    : { en: 'Broken: the parcel’s status went backwards, and the shopper was told.', vi: 'Hỏng: trạng thái kiện hàng đã quay lùi, và người mua đã được báo.' };
  return { tl, steps, ok, summary };
}

export function mount(root, ctx) {
  const latency = stat(tx({ en: 'Scan to notification (this run)', vi: 'Từ lúc quét tới thông báo (lần này)' }));
  const keeps = stat(tx({ en: 'Keeps up with 3,000 events/s', vi: 'Theo kịp 3.000 sự kiện/giây' }));
  return player(root, ctx, {
    situations: SITUATIONS.map(x => ({ value: x, label: tx(SITUATION[x]), icon: { normal: 'sun', offline: 'nowifi', retry: 'replay', crash: 'power', dup: 'copy' }[x] })),
    setups: STRATEGIES.map(x => ({ value: x, label: tx(LABEL[x]), icon: { today: 'gear', single: 'user', fifo: 'list', buffer: 'hourglass', seq: 'hash' }[x] })),
    initial: { situation: 'offline' },
    run, survives, height: 290,
    duration: st => Math.max(0.35, st.t1 - st.t0),
    tone: st => st.tone,
    draw: ({ g, w, h, result, k, p }) => {
      const st = result.steps[k];
      drawScene(g, w, h, result.tl, st ? st.t0 + p * (st.t1 - st.t0) : result.tl.end, ctx.state.setup ?? 'today');
    },
    onRun: ({ tl }) => {
      const c4 = tl.copies.find(c => c.seq === 4);
      latency.set(`${(c4.apply - c4.scan).toFixed(1)} s`, c4.apply - c4.scan > 6 ? 'warn' : 'ok');
      const up = ctx.state.setup === 'single' ? PER_WORKER >= PEAK : PER_WORKER * WORKERS >= PEAK;
      keeps.set(up ? tx({ en: 'yes', vi: 'có' }) : tx({ en: `no: ${PER_WORKER}/s`, vi: `không: ${PER_WORKER}/giây` }), up ? 'ok' : 'bad');
    },
    footer: [
      el('div', { class: 'sim-stats' }, [latency.el, keeps.el]),
      el('p', { class: 'sim-note' }, tx({ en: 'Time is compressed: a 20-minute retry or a 30-second timeout takes a few seconds here.', vi: 'Thời gian được nén lại: lần gửi lại sau 20 phút hay timeout 30 giây chỉ mất vài giây ở đây.' })),
    ],
  });
}

/* The scene at time t: stations, the parcel card, the phone and every scan in flight. */
function drawScene(g, w, h, tl, t, strategy) {
  const mid = 150, cw = 30, ch = 22;
  const X = { carrier: w * 0.06, api: w * 0.2, queue: w * 0.38, workers: w * 0.57, db: w * 0.75, phone: w * 0.915 };
  const qw = w * 0.15;
  const slotY = k => (strategy === 'single' ? mid : mid - 52 + k * 52);
  g.clearRect(0, 0, w, h);
  g.textBaseline = 'middle';
  g.textAlign = 'center';

  // Stations.
  const title = (x, text) => { g.fillStyle = css('muted'); g.font = '600 11px "IBM Plex Mono", monospace'; g.fillText(text.toUpperCase(), x, 16, w * 0.17); };
  title(X.carrier, tx({ en: 'Carrier', vi: 'Hãng' }));
  title(X.api, tx({ en: 'Your API', vi: 'API của bạn' }));
  title(X.queue, strategy === 'buffer' ? tx({ en: 'Buffer', vi: 'Bộ đệm' }) : tx({ en: 'Queue', vi: 'Queue' }));
  title(X.workers, tx({ en: 'Workers', vi: 'Worker' }));
  title(X.db, tx({ en: 'Database', vi: 'Database' }));
  title(X.phone, tx({ en: 'Phone', vi: 'Điện thoại' }));
  g.strokeStyle = css('line'); g.setLineDash([3, 5]);
  g.beginPath(); g.moveTo(X.carrier, mid); g.lineTo(X.db, mid); g.stroke(); g.setLineDash([]);
  // API gate.
  g.fillStyle = css('surface2'); g.fillRect(X.api - 3, mid - 40, 6, 80);
  // Queue or buffer box.
  g.fillStyle = css('bg2'); g.strokeStyle = css(strategy === 'buffer' ? 'warn' : 'line');
  g.beginPath(); g.roundRect(X.queue - qw / 2, mid - 24, qw, 48, 8); g.fill(); g.stroke();
  g.font = '10px "IBM Plex Mono", monospace'; g.fillStyle = css('muted');
  const note = {
    single: tx({ en: '+2,600 other events ahead', vi: '+2.600 sự kiện khác phía trước' }),
    fifo: tx({ en: 'one at a time for this parcel', vi: 'từng cái một cho kiện này' }),
    buffer: tx({ en: 'hold 30 s, sort by scan time', vi: 'giữ 30 giây, xếp theo giờ quét' }),
  }[strategy];
  if (note) g.fillText(note, X.queue, mid + 36, qw + 30);
  // Worker slots.
  const nslots = strategy === 'single' ? 1 : 3;
  for (let k = 0; k < nslots; k++) {
    g.fillStyle = css('surface2'); g.strokeStyle = css('line');
    g.beginPath(); g.roundRect(X.workers - 26, slotY(k) - 17, 52, 34, 8); g.fill(); g.stroke();
  }

  // The parcel card: colour = current status; red flash right after going backwards.
  const done = tl.applies.filter(a => a.at <= t);
  let shown = 2, best = 2;
  for (const a of done) if (a.result !== 'skipped') { shown = a.seq; best = Math.max(best, a.seq); }
  // Once it has gone backwards and stays there, the card stays red.
  const flash = shown < best;
  const cardW = Math.min(118, w * 0.15), cardH = 64;
  g.fillStyle = css(flash ? 'bad' : COLOR[shown]); g.globalAlpha = 0.18;
  g.beginPath(); g.roundRect(X.db - cardW / 2, mid - cardH / 2, cardW, cardH, 10); g.fill(); g.globalAlpha = 1;
  g.strokeStyle = css(flash ? 'bad' : COLOR[shown]); g.lineWidth = 2;
  g.beginPath(); g.roundRect(X.db - cardW / 2, mid - cardH / 2, cardW, cardH, 10); g.stroke(); g.lineWidth = 1;
  g.fillStyle = css('muted'); g.font = '10px "IBM Plex Mono", monospace';
  g.fillText(tx({ en: 'parcel A17', vi: 'kiện A17' }), X.db, mid - 18);
  g.fillStyle = css(flash ? 'bad' : COLOR[shown]); g.font = '700 12px "Hanken Grotesk", sans-serif';
  g.fillText(tx(KIND[shown]), X.db, mid + 1, cardW - 8);
  g.font = '10px "IBM Plex Mono", monospace';
  if (flash) { g.fillStyle = css('bad'); g.fillText(tx({ en: `should be ${tx(KIND[best])}`, vi: `lẽ ra là ${tx(KIND[best])}` }), X.db, mid + 19, cardW - 6); }
  else if (strategy === 'seq') { g.fillStyle = css('muted'); g.fillText(`last seq = ${shown}`, X.db, mid + 19); }
  // A skipped copy bounces off the card.
  const skip = done.filter(a => a.result === 'skipped').at(-1);
  if (skip && t - skip.at < 2.2) {
    g.fillStyle = css(strategy === 'seq' ? 'ok' : 'muted'); g.font = '600 10px "IBM Plex Mono", monospace';
    g.fillText(strategy === 'seq' ? tx({ en: `seq ${skip.seq} ≤ ${shown}: history only`, vi: `seq ${skip.seq} ≤ ${shown}: chỉ lưu lịch sử` }) : tx({ en: 'same status', vi: 'trùng trạng thái' }), X.db, mid + cardH / 2 + 12, cardW + 40);
  }

  // The phone: notifications so far.
  const notes = done.filter(a => a.result !== 'skipped');
  const pw = Math.min(110, w * 0.15);
  g.fillStyle = css('bg2'); g.strokeStyle = css('line');
  g.beginPath(); g.roundRect(X.phone - pw / 2, 30, pw, h - 44, 12); g.fill(); g.stroke();
  [{ seq: 2, result: 'applied' }, ...notes].forEach((n, i) => {
    const y = 46 + i * 34, bad = n.result === 'backwards';
    g.fillStyle = css(bad ? 'bad' : 'surface2'); g.globalAlpha = bad ? 0.25 : 1;
    g.beginPath(); g.roundRect(X.phone - pw / 2 + 5, y, pw - 10, 28, 6); g.fill(); g.globalAlpha = 1;
    g.fillStyle = css(bad ? 'bad' : COLOR[n.seq]); g.font = '600 10px "Hanken Grotesk", sans-serif';
    g.fillText(tx(KIND[n.seq]), X.phone, y + 14, pw - 16);
  });

  // The scans, as chips moving between stations.
  const chip = (x, y, c, mode = '') => {
    g.globalAlpha = mode === 'ghost' ? 0.35 : 1;
    g.fillStyle = css(mode === 'bad' ? 'bad' : COLOR[c.seq]);
    g.beginPath(); g.roundRect(x - cw / 2, y - ch / 2, cw, ch, 6); g.fill();
    g.fillStyle = css('bg'); g.font = '700 12px "IBM Plex Mono", monospace';
    g.fillText(`${c.seq}${c.dup ? '′' : ''}`, x, y + 1);
    g.globalAlpha = 1;
  };
  const lerp = (a, b, p) => a + (b - a) * Math.min(1, Math.max(0, p));
  // Where is copy c at time t? Returns [x, y, mode] or null once it has been applied.
  const where = c => {
    const carrierY = mid - 30 + c.id * 28;
    if (t < c.send) return t >= c.scan ? [X.carrier, carrierY, ''] : null;
    if (c.failAt != null && t < c.failAt + RETRY) {
      if (t < c.failAt) return [lerp(X.carrier, X.api - 18, (t - c.send) / c.net), mid, ''];
      if (t < c.failAt + 0.8) return [X.api - 18, mid + (t - c.failAt) * 40, 'bad'];
      return [X.carrier, carrierY, 'ghost'];
    }
    const leave = c.failAt != null ? c.failAt + RETRY : c.send;
    if (t < c.arrive) return [lerp(X.carrier, X.queue - qw / 2 + 16, (t - leave) / (c.arrive - leave)), mid, ''];
    // In the queue/buffer until a worker picks it; between crashes it is invisible.
    for (const [i, p] of c.picks.entries()) {
      const enter = i === 0 ? c.arrive : c.picks[i - 1].back;
      if (t < p.at) {
        const waiting = tl.copies.filter(o => o.arrive <= t && o.picks.some((q, j) => q.at > t && (j === 0 ? o.arrive : o.picks[j - 1].back) <= t));
        const order = waiting.sort((a, b) => a.arrive - b.arrive).indexOf(c);
        return [X.queue + qw / 2 - 18 - Math.max(0, order) * (cw + 4), mid, t < enter ? 'ghost' : ''];
      }
      if (p.crashAt != null) {
        if (t < p.crashAt) return [lerp(X.queue + qw / 2, X.workers, (t - p.at) / 0.3), lerp(mid, slotY(p.slot), (t - p.at) / 0.3), ''];
        if (t < p.back) return [X.workers, slotY(p.slot), 'ghost'];
        continue;
      }
      if (t < c.done) return [lerp(X.queue + qw / 2, X.workers, (t - p.at) / 0.3), lerp(mid, slotY(p.slot), (t - p.at) / 0.3), ''];
    }
    if (t < c.apply) return [lerp(X.workers, X.db - cardW / 2 - 4, (t - c.done) / HOP), lerp(slotY(c.picks.at(-1).slot), mid, (t - c.done) / HOP), ''];
    return null;
  };
  for (const c of tl.copies) {
    const p = where(c);
    if (p) chip(p[0], p[1], c, p[2]);
    if (c.failAt != null && t >= c.failAt && t < c.failAt + 1.5) {
      g.fillStyle = css('bad'); g.font = '700 16px "IBM Plex Mono", monospace'; g.fillText('✕', X.api, mid - 52);
    }
    for (const pk of c.picks) if (pk.crashAt != null && t >= pk.crashAt && t < pk.back) {
      g.fillStyle = css('bad'); g.font = '600 10px "IBM Plex Mono", monospace';
      g.fillText(tx({ en: 'crashed', vi: 'sập' }), X.workers, slotY(pk.slot) - 26);
    }
  }
}
