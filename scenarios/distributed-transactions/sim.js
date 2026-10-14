/* One flight + hotel booking, played out message by message between the booking
   service, the airline, the hotel, the payment provider and the customer. Each
   partner's box shows what it holds (seat, room, money) and changes colour as calls
   land; the service shows its checklist of steps. Pick a situation and a setup; a
   scoreboard fills in as you watch. Before the visitor answers, only today's code is
   unlocked. */

import { el } from '../../js/dom.js';
import { tx } from '../../js/i18n.js';
import { canvas, choice, button, css, row, onResize, reducedMotion } from '../../js/sim-kit.js';

export const SETUPS = ['today', 'twopc', 'saga', 'recon'];
export const SITUATIONS = ['normal', 'noroom', 'declined', 'crash', 'timeout'];

/* The six steps. A step's undo releases what it did; the ticket is the pivot: it can
   be neither undone nor skipped once done. */
const STEP = {
  seat: { partner: 'airline', call: 'HOLD SEAT', name: { en: 'Hold seat', vi: 'Giữ ghế' }, undo: 'RELEASE' },
  room: { partner: 'hotel', call: 'HOLD ROOM', name: { en: 'Hold room', vi: 'Giữ phòng' }, undo: 'RELEASE' },
  auth: { partner: 'pay', call: 'AUTHORIZE', name: { en: 'Authorize $1,240', vi: 'Cấp phép 1.240 đô' }, undo: 'CANCEL' },
  ticket: { partner: 'airline', call: 'ISSUE TICKET', name: { en: 'Issue ticket', vi: 'Xuất vé' }, pivot: true },
  confirm: { partner: 'hotel', call: 'CONFIRM', name: { en: 'Confirm room', vi: 'Xác nhận phòng' } },
  capture: { partner: 'pay', call: 'CAPTURE', name: { en: 'Capture payment', vi: 'Thu tiền' } },
};
/* Today's code (and the nightly-reconciliation version) takes the money first; the
   saga puts every reversible step before the pivot. */
export const ORDER = {
  today: ['auth', 'seat', 'room', 'ticket', 'confirm', 'capture'],
  recon: ['auth', 'seat', 'room', 'ticket', 'confirm', 'capture'],
  saga: ['seat', 'room', 'auth', 'ticket', 'confirm', 'capture'],
  twopc: ['seat', 'room', 'auth', 'ticket', 'confirm', 'capture'],
};
const CRASH_AFTER = 3;   // the 'crash' situation: the service restarts after three steps

/* Play one booking. Returns { hops, final, ok }.
   hop: { from, to, label, kind, say: {en, vi}, state } with state a snapshot after it.
   Pure, so the scoreboard is pinned by tests/distributed-transactions.test.js. */
export function run(setup, situation) {
  const order = ORDER[setup];
  const s = {
    seat: 'none', tickets: 0, room: 'none', card: 'none', customer: 'waiting',
    steps: order.map(() => 'todo'), saved: null, night: false,
  };
  const hops = [];
  const hop = (from, to, label, kind, say, change) => {
    if (change) change();
    hops.push({ from, to, label, kind, say, state: { ...s, steps: [...s.steps] } });
  };
  const fails = id => (situation === 'noroom' && id === 'room') || (situation === 'declined' && id === 'auth');
  const effect = id => ({
    seat: () => { s.seat = 'held'; },
    room: () => { s.room = 'held'; },
    auth: () => { s.card = 'authorized'; },
    ticket: () => { s.seat = 'ticketed'; s.tickets++; },
    confirm: () => { s.room = 'confirmed'; },
    capture: () => { s.card = 'captured'; },
  })[id];
  const failEffect = id => ({ room: () => { s.room = 'unavailable'; }, auth: () => { s.card = 'declined'; } })[id];
  const tell = (msg, say) => hop('svc', 'customer', msg === 'confirmed' ? 'CONFIRMED' : msg === 'failed' ? 'FAILED' : '…', msg === 'confirmed' ? 'ok' : 'bad', say, () => { s.customer = msg; });

  /* Call step i; returns 'ok' | 'fail' | 'timeout'. */
  const call = (i, opts = {}) => {
    const id = order[i], st = STEP[id];
    const label = opts.retry ? `${st.call} ↻` : st.call;
    hop('svc', st.partner, label, 'call', opts.say || { en: `${tx2(st.name)}: the booking service calls the ${partnerName(st.partner)}.`, vi: `${st.name.vi}: dịch vụ đặt chỗ gọi ${partnerNameVi(st.partner)}.` },
      () => { s.steps[i] = 'running'; });
    if (fails(id)) {
      hop(st.partner, 'svc', id === 'room' ? 'NO ROOM' : 'DECLINED', 'bad', id === 'room'
        ? { en: 'The hotel has no room left.', vi: 'Khách sạn đã hết phòng.' }
        : { en: 'The card is declined.', vi: 'Thẻ bị từ chối.' },
        () => { failEffect(id)(); s.steps[i] = 'failed'; });
      return 'fail';
    }
    if (situation === 'timeout' && id === 'ticket' && !opts.retry) {
      hop(st.partner, 'svc', 'timeout', 'bad', { en: 'The airline issued the ticket, but its reply timed out on the way back. The service cannot tell whether it worked.', vi: 'Hãng bay đã xuất vé, nhưng phản hồi bị timeout trên đường về. Dịch vụ không biết lời gọi có thành công không.' },
        () => { effect(id)(); s.steps[i] = 'unknown'; });
      return 'timeout';
    }
    hop(st.partner, 'svc', 'OK', 'ok', opts.reply || { en: `${partnerCap(st.partner)}: done.`, vi: `${partnerCapVi(st.partner)}: xong.` },
      () => {
        // Same idempotency key: the partner returns what it already did instead of doing it again.
        if (!opts.sameKey) effect(id)();
        s.steps[i] = 'done';
        if (setup === 'saga') s.saved = i + 1;
      });
    return 'ok';
  };

  if (setup === 'twopc') {
    hop('svc', 'airline', 'PREPARE', 'call', { en: 'Two-phase commit, phase one: the coordinator asks the airline to PREPARE (vote yes and hold its changes open).', vi: 'Two-phase commit, pha một: coordinator yêu cầu hãng bay PREPARE (bỏ phiếu đồng ý và giữ thay đổi mở).' });
    hop('airline', 'svc', '501', 'bad', { en: 'The airline’s API has no prepare or commit endpoint, and neither do the hotel or payment APIs. There is nothing to vote with.', vi: 'API của hãng bay không có endpoint prepare hay commit, API khách sạn và thanh toán cũng vậy. Không có gì để bỏ phiếu.' });
    tell('failed', { en: 'The coordinator can only abort. Nobody can book anything this way, even on a good day.', vi: 'Coordinator chỉ có thể huỷ. Theo cách này không ai đặt được gì, kể cả ngày bình thường.' });
  } else if (setup === 'today') {
    hop('svc', 'svc', 'BEGIN', 'note', { en: 'Today’s code opens a database transaction for the booking row, then calls the partners one by one.', vi: 'Code hiện tại mở một transaction database cho dòng đặt chỗ, rồi gọi từng đối tác.' });
    let done = true;
    for (let i = 0; i < order.length; i++) {
      if (situation === 'crash' && i === CRASH_AFTER) {
        hop('svc', 'svc', 'CRASH', 'bad', { en: 'A deploy restarts the service. The database rolls the open transaction back, so nothing records which partner calls already went out. The seat and room stay held and the money stays authorized.', vi: 'Một lần deploy khởi động lại dịch vụ. Database rollback transaction đang mở, nên không còn gì ghi lại lời gọi nào đã được gửi. Ghế và phòng vẫn bị giữ, tiền vẫn bị cấp phép.' },
          () => { s.customer = 'unknown'; });
        done = false; break;
      }
      const r = call(i);
      if (r === 'fail') {
        hop('svc', 'svc', 'ROLLBACK', 'bad', { en: 'ROLLBACK deletes the booking row. It cannot reach the airline or the payment provider: what they already did stays done.', vi: 'ROLLBACK xoá dòng đặt chỗ. Nó không với tới hãng bay hay bên thanh toán: những gì họ đã làm vẫn còn đó.' });
        tell('failed', { en: 'The customer is told the booking failed.', vi: 'Khách được báo đặt chỗ thất bại.' });
        done = false; break;
      }
      if (r === 'timeout') call(i, { retry: true, say: { en: 'Today’s code just retries, with no idempotency key: to the airline, this is a new request.', vi: 'Code hiện tại chỉ thử lại, không có idempotency key: với hãng bay, đây là một yêu cầu mới.' }, reply: { en: 'The airline issues a SECOND ticket.', vi: 'Hãng bay xuất vé THỨ HAI.' } });
    }
    if (done) {
      hop('svc', 'svc', 'COMMIT', 'note', { en: 'All calls returned: the booking row is committed.', vi: 'Mọi lời gọi đều trả về: dòng đặt chỗ được commit.' });
      tell('confirmed', { en: 'The customer gets a confirmation.', vi: 'Khách nhận xác nhận.' });
    }
  } else if (setup === 'saga') {
    let i = 0;
    while (i < order.length) {
      if (situation === 'crash' && i === CRASH_AFTER && !s.restarted) {
        hop('svc', 'svc', 'CRASH', 'bad', { en: 'A deploy restarts the service mid-booking…', vi: 'Một lần deploy khởi động lại dịch vụ giữa lúc đặt…' }, () => { s.restarted = true; });
        hop('svc', 'svc', 'RESUME', 'note', { en: `…the new process reads the saved saga: ${s.saved} steps done, next is "${STEP[order[s.saved]].name.en}". It carries on from there.`, vi: `…tiến trình mới đọc saga đã lưu: xong ${s.saved} bước, tiếp theo là "${STEP[order[s.saved]].name.vi}". Nó tiếp tục từ đó.` });
      }
      const r = call(i);
      if (r === 'fail') {
        // Undo every earlier reversible step, newest first.
        for (let j = i - 1; j >= 0; j--) {
          const st = STEP[order[j]];
          hop('svc', st.partner, st.undo, 'undo', { en: `Compensate: undo "${st.name.en}".`, vi: `Bù trừ: hoàn tác "${st.name.vi}".` });
          hop(st.partner, 'svc', 'OK', 'ok', { en: `${partnerCap(st.partner)}: released.`, vi: `${partnerCapVi(st.partner)}: đã huỷ.` }, () => {
            s.steps[j] = 'undone';
            if (order[j] === 'seat') s.seat = 'released';
            if (order[j] === 'room') s.room = 'released';
            if (order[j] === 'auth') s.card = 'cancelled';
          });
        }
        tell('failed', { en: 'Every earlier step is undone. The customer is told it failed and was never charged.', vi: 'Mọi bước trước đã được hoàn tác. Khách được báo thất bại và chưa bao giờ bị trừ tiền.' });
        break;
      }
      if (r === 'timeout') {
        call(i, { retry: true, sameKey: true, say: { en: 'The saga retries with the SAME idempotency key it used the first time.', vi: 'Saga thử lại với CÙNG idempotency key đã dùng lần đầu.' }, reply: { en: 'The airline recognises the key and returns the ticket it already issued. Still one ticket.', vi: 'Hãng bay nhận ra key và trả về vé đã xuất. Vẫn chỉ một vé.' } });
      }
      i++;
      if (i === order.length) tell('confirmed', { en: 'All six steps done: the customer gets a confirmation.', vi: 'Xong cả sáu bước: khách nhận xác nhận.' });
    }
  } else if (setup === 'recon') {
    let failed = false;
    const skip = new Set();   // a step whose prerequisite failed is not attempted
    for (let i = 0; i < order.length; i++) {
      if (skip.has(order[i])) continue;
      if (situation === 'crash' && i === CRASH_AFTER) {
        hop('svc', 'svc', 'CRASH', 'bad', { en: 'A deploy restarts the service. The calls already made are recorded, but nothing will continue this booking until tonight.', vi: 'Một lần deploy khởi động lại dịch vụ. Các lời gọi đã làm được ghi lại, nhưng không gì tiếp tục lần đặt này cho tới tối nay.' }, () => { s.customer = 'unknown'; });
        failed = true; break;
      }
      const r = call(i);
      if (r === 'fail') {
        failed = true;
        if (order[i] === 'room') skip.add('confirm');
        if (order[i] === 'auth') skip.add('capture');
      }
    }
    if (!failed) tell('confirmed', { en: 'The customer gets a confirmation.', vi: 'Khách nhận xác nhận.' });
    else {
      if (s.customer !== 'unknown') tell('pending', { en: 'Some calls failed, but the service just records the results and moves on. The customer waits.', vi: 'Một vài lời gọi thất bại, nhưng dịch vụ chỉ ghi lại kết quả và đi tiếp. Khách phải chờ.' });
      hop('svc', 'svc', '02:00', 'night', { en: 'Many hours later, at 02:00, the reconciliation job compares records with the partners…', vi: 'Nhiều giờ sau, lúc 02:00, job đối soát so sánh bản ghi với các đối tác…' }, () => { s.night = true; });
      if (s.card === 'authorized' || s.card === 'captured') hop('svc', 'pay', s.card === 'captured' ? 'REFUND' : 'CANCEL', 'undo', { en: 'It gives the money back.', vi: 'Nó trả lại tiền.' }, () => { s.card = s.card === 'captured' ? 'refunded' : 'cancelled'; });
      if (s.room === 'held' || s.room === 'confirmed') hop('svc', 'hotel', 'RELEASE', 'undo', { en: 'It releases the room.', vi: 'Nó huỷ giữ phòng.' }, () => { s.room = 'released'; });
      if (s.seat === 'held') hop('svc', 'svc', 'expired', 'note', { en: 'The seat hold expired hours ago on its own.', vi: 'Giữ ghế đã tự hết hạn từ nhiều giờ trước.' }, () => { s.seat = 'released'; });
      if (s.seat === 'ticketed') hop('svc', 'airline', 'CANCEL?', 'bad', { en: 'The ticket was issued during the day and the fare is non-refundable: it cannot be undone.', vi: 'Vé đã được xuất trong ngày và không hoàn được: không thể hoàn tác.' });
      tell('failed', { en: 'Only now is the customer told the booking failed.', vi: 'Đến giờ khách mới được báo đặt chỗ thất bại.' });
    }
  }

  const f = hops.at(-1).state;
  const allDone = f.customer === 'confirmed' && f.seat === 'ticketed' && f.tickets === 1 && f.room === 'confirmed' && f.card === 'captured';
  const allUndone = f.customer === 'failed' && ['none', 'released'].includes(f.seat) && ['none', 'released', 'unavailable'].includes(f.room) && ['none', 'cancelled', 'declined'].includes(f.card) && !f.night;
  return { hops, final: f, ok: setup !== 'twopc' ? allDone || allUndone : false };
}

/* Small helpers for captions. */
const tx2 = v => v.en;
const partnerName = p => ({ airline: 'airline', hotel: 'hotel', pay: 'payment provider' })[p];
const partnerNameVi = p => ({ airline: 'hãng bay', hotel: 'khách sạn', pay: 'bên thanh toán' })[p];
const partnerCap = p => ({ airline: 'Airline', hotel: 'Hotel', pay: 'Payments' })[p];
const partnerCapVi = p => ({ airline: 'Hãng bay', hotel: 'Khách sạn', pay: 'Thanh toán' })[p];

export const survives = (setup, situation) => run(setup, situation).ok;

const LABEL = {
  today: { en: 'Today: DB transaction', vi: 'Hiện tại: transaction DB' },
  twopc: { en: 'Two-phase commit', vi: 'Two-phase commit' },
  saga: { en: 'Saga with saved state', vi: 'Saga lưu trạng thái' },
  recon: { en: 'Nightly reconciliation', vi: 'Đối soát ban đêm' },
};
const SITUATION = {
  normal: { en: 'Everything works', vi: 'Mọi thứ ổn' },
  noroom: { en: 'Hotel has no room', vi: 'Khách sạn hết phòng' },
  declined: { en: 'Card declined', vi: 'Thẻ bị từ chối' },
  crash: { en: 'Service crashes', vi: 'Dịch vụ bị sập' },
  timeout: { en: 'Airline times out', vi: 'Hãng bay timeout' },
};
const KIND = { call: 'blue', ok: 'ok', bad: 'bad', undo: 'violet', note: 'muted', night: 'warn' };
const STEP_MARK = { todo: '○', running: '●', done: '✓', failed: '✗', undone: '↩', unknown: '?' };
const STEP_COLOR = { todo: 'faint', running: 'blue', done: 'ok', failed: 'bad', undone: 'violet', unknown: 'warn' };

export function mount(root, { revealed, state }) {
  const s = Object.assign(state, { setup: 'today', situation: 'noroom', played: {}, ...state });
  if (!revealed) s.setup = 'today';

  const chart = canvas(320);
  const caption = el('p', { class: 'sim-event', 'aria-live': 'polite' });
  const board = el('div', { class: 'sim-board' });
  const reduce = reducedMotion();
  // Seconds per message at normal speed; after landing, a message lingers so its
  // caption can be read before the next one starts.
  const DUR = { self: 1.3, night: 2.2, move: 1.0 }, DWELL = 1.2;
  const SPEEDS = { slow: 0.5, normal: 1, fast: 2 };
  if (!SPEEDS[s.speed]) s.speed = 'slow';
  const dur = h => (reduce ? 0.05 : h.kind === 'night' ? DUR.night : h.from === h.to ? DUR.self : DUR.move);
  // k: the message in flight; p: how far it has travelled (0..1); dwell: seconds left
  // to linger on the one that just landed.
  let result, k = 0, p = 0, dwell = 0, paused = false, last = 0, raf = 0;

  function play() {
    result = run(s.setup, s.situation);
    k = 0; p = 0; dwell = 0;
    setPaused(false);
    cancelAnimationFrame(raf);
    last = performance.now() / 1000;
    raf = requestAnimationFrame(frame);
  }

  /* Move the current message on by dt seconds of animation time. */
  function advance(dt) {
    if (k >= result.hops.length) return;
    if (dwell > 0) { dwell -= dt; return; }
    p += dt / dur(result.hops[k]);
    if (p >= 1) { k++; p = 0; dwell = reduce ? 0 : DWELL; }
  }

  function frame() {
    const now = performance.now() / 1000;
    if (!paused) advance((now - last) * SPEEDS[s.speed]);
    last = now;
    draw();
    if (k < result.hops.length) raf = requestAnimationFrame(frame);
    else { s.played[`${s.setup}:${s.situation}`] = true; paintBoard(); setPaused(false); }
  }

  /* Paused: deliver the current message (or skip the linger) and stop again. */
  function step() {
    if (!result || k >= result.hops.length) return;
    setPaused(true);
    if (dwell > 0) dwell = 0;
    else { k++; p = 0; dwell = 0; }
    draw();
    if (k >= result.hops.length) { s.played[`${s.setup}:${s.situation}`] = true; paintBoard(); }
    else { cancelAnimationFrame(raf); last = performance.now() / 1000; raf = requestAnimationFrame(frame); }
  }

  function draw() {
    const { w, h } = chart.fit();
    const g = chart.g;
    const cur = result.hops[Math.min(k, result.hops.length - 1)];
    const st = k === 0 ? { ...result.hops[0].state, ...initial() } : result.hops[k - 1].state;
    const X = { customer: w * 0.1, svc: w * 0.36, partners: w * 0.78 };
    const Y = { airline: 62, hotel: 160, pay: 258 };
    const pw = Math.min(190, w * 0.3), ph = 74;
    g.clearRect(0, 0, w, h);
    g.textBaseline = 'middle';

    const panel = (x, y, wd, ht, title, color = 'line') => {
      g.fillStyle = css('surface2'); g.strokeStyle = css(color); g.lineWidth = color === 'line' ? 1 : 2;
      g.beginPath(); g.roundRect(x - wd / 2, y - ht / 2, wd, ht, 10); g.fill(); g.stroke(); g.lineWidth = 1;
      g.fillStyle = css('muted'); g.font = '600 10px "IBM Plex Mono", monospace'; g.textAlign = 'left';
      g.fillText(title.toUpperCase(), x - wd / 2 + 10, y - ht / 2 + 13);
    };
    const pill = (x, y, text, color) => {
      g.font = '600 12px "Hanken Grotesk", sans-serif'; g.textAlign = 'center';
      const tw = Math.min(pw - 20, g.measureText(text).width + 18);
      g.fillStyle = css(color); g.globalAlpha = 0.18; g.beginPath(); g.roundRect(x - tw / 2, y - 12, tw, 24, 12); g.fill(); g.globalAlpha = 1;
      g.fillStyle = css(color); g.fillText(text, x, y + 1, tw - 8);
    };

    // Roads.
    g.strokeStyle = css('line'); g.setLineDash([3, 5]);
    for (const p of ['airline', 'hotel', 'pay']) { g.beginPath(); g.moveTo(X.svc + 70, 160); g.lineTo(X.partners - pw / 2, Y[p]); g.stroke(); }
    g.beginPath(); g.moveTo(X.customer + 50, 160); g.lineTo(X.svc - 70, 160); g.stroke(); g.setLineDash([]);

    // Partners.
    const seat = { none: ['—', 'faint'], held: [tx({ en: 'seat held', vi: 'đang giữ ghế' }), 'warn'], ticketed: [st.tickets > 1 ? tx({ en: `${st.tickets} tickets!`, vi: `${st.tickets} vé!` }) : tx({ en: 'ticket issued', vi: 'đã xuất vé' }), st.tickets > 1 ? 'bad' : 'ok'], released: [tx({ en: 'released', vi: 'đã huỷ giữ' }), 'muted'] }[st.seat];
    const room = { none: ['—', 'faint'], held: [tx({ en: 'room held', vi: 'đang giữ phòng' }), 'warn'], confirmed: [tx({ en: 'room confirmed', vi: 'đã xác nhận phòng' }), 'ok'], released: [tx({ en: 'released', vi: 'đã huỷ giữ' }), 'muted'], unavailable: [tx({ en: 'no room', vi: 'hết phòng' }), 'bad'] }[st.room];
    const card = { none: ['—', 'faint'], authorized: [tx({ en: '$1,240 on hold', vi: 'giữ 1.240 đô' }), 'warn'], captured: [tx({ en: '$1,240 charged', vi: 'đã thu 1.240 đô' }), 'ok'], cancelled: [tx({ en: 'hold cancelled', vi: 'đã huỷ cấp phép' }), 'muted'], refunded: [tx({ en: 'refunded', vi: 'đã hoàn tiền' }), 'muted'], declined: [tx({ en: 'declined', vi: 'bị từ chối' }), 'bad'] }[st.card];
    for (const [p, title, [text, color]] of [['airline', tx({ en: 'Airline', vi: 'Hãng bay' }), seat], ['hotel', tx({ en: 'Hotel', vi: 'Khách sạn' }), room], ['pay', tx({ en: 'Payments', vi: 'Thanh toán' }), card]]) {
      panel(X.partners, Y[p], pw, ph, title, color === 'bad' ? 'bad' : 'line');
      pill(X.partners, Y[p] + 8, text, color);
    }

    // The booking service and its checklist.
    const sw = 140, sh = 250;
    const crashed = cur && cur.label === 'CRASH' && k < result.hops.length;
    panel(X.svc, 160, sw, sh, tx({ en: 'Booking service', vi: 'Dịch vụ đặt chỗ' }), crashed ? 'bad' : 'line');
    ORDER[s.setup].forEach((id, i) => {
      const y = 160 - sh / 2 + 38 + i * 26, mark = st.steps[i];
      g.textAlign = 'left'; g.fillStyle = css(STEP_COLOR[mark]); g.font = '700 12px "IBM Plex Mono", monospace';
      g.fillText(STEP_MARK[mark], X.svc - sw / 2 + 10, y);
      g.font = '12px "Hanken Grotesk", sans-serif';
      g.fillStyle = css(STEP[id].pivot && s.setup === 'saga' ? 'warn' : mark === 'todo' ? 'muted' : 'text');
      g.fillText(tx(STEP[id].name), X.svc - sw / 2 + 26, y, sw - 34);
    });
    g.font = '10px "IBM Plex Mono", monospace'; g.textAlign = 'center';
    if (s.setup === 'saga') { g.fillStyle = css('ok'); g.fillText(tx({ en: `saved: ${st.saved ?? 0} of 6 done`, vi: `đã lưu: xong ${st.saved ?? 0}/6` }), X.svc, 160 + sh / 2 - 16); }
    if (s.setup === 'saga') { g.fillStyle = css('warn'); g.fillText(tx({ en: 'yellow = point of no return', vi: 'vàng = không thể quay lại' }), X.svc, 160 + sh / 2 + 12); }

    // The customer.
    const cust = { waiting: [tx({ en: 'booking…', vi: 'đang đặt…' }), 'muted'], confirmed: [tx({ en: 'confirmed', vi: 'đã xác nhận' }), 'ok'], failed: [tx({ en: 'booking failed', vi: 'đặt thất bại' }), 'muted'], pending: [tx({ en: 'still waiting', vi: 'vẫn đang chờ' }), 'warn'], unknown: [tx({ en: 'no answer', vi: 'không có phản hồi' }), 'bad'] }[st.customer];
    const money = st.card === 'authorized' || st.card === 'captured';
    const wrong = (st.customer === 'failed' && (money || st.seat === 'ticketed')) || st.tickets > 1 || st.customer === 'unknown';
    const cw = Math.min(120, w * 0.17);
    panel(X.customer, 160, cw, 120, tx({ en: 'Customer', vi: 'Khách hàng' }), wrong ? 'bad' : 'line');
    g.textAlign = 'center'; g.fillStyle = css(cust[1]); g.font = '700 12px "Hanken Grotesk", sans-serif';
    g.fillText(cust[0], X.customer, 150, cw - 10);
    // A hold mid-booking is normal; money still held after "failed" is the bug.
    const moneyText = st.card === 'captured' ? tx({ en: '$1,240 charged', vi: 'đã trừ 1.240 đô' }) : tx({ en: '$1,240 on hold', vi: 'bị giữ 1.240 đô' });
    const moneyTone = st.customer === 'confirmed' ? 'ok' : ['failed', 'unknown'].includes(st.customer) ? 'bad' : 'warn';
    g.font = '11px "Hanken Grotesk", sans-serif'; g.fillStyle = css(money ? moneyTone : 'muted');
    g.fillText(money ? moneyText : tx({ en: 'card untouched', vi: 'thẻ chưa bị trừ' }), X.customer, 178, cw - 10);

    // The message in flight (none while the last one lingers).
    if (cur && k < result.hops.length && dwell <= 0) {
      const at = n => n === 'svc' ? [X.svc, 160] : n === 'customer' ? [X.customer, 160] : [X.partners - pw / 2, Y[n]];
      const [x1, y1] = at(cur.from), [x2, y2] = at(cur.to);
      let x = x1 + (x2 - x1) * p, y = y1 + (y2 - y1) * p;
      if (cur.from === cur.to) { x = X.svc; y = 160 - sh / 2 - 14; }
      if (cur.kind === 'night') {
        g.fillStyle = css('bg'); g.globalAlpha = 0.6; g.fillRect(0, 0, w, h); g.globalAlpha = 1;
        g.fillStyle = css('warn'); g.font = '700 20px "IBM Plex Mono", monospace'; g.textAlign = 'center';
        g.fillText(tx({ en: '… hours later, 02:00', vi: '… nhiều giờ sau, 02:00' }), w / 2, h / 2);
      } else {
        g.font = '700 11px "IBM Plex Mono", monospace'; g.textAlign = 'center';
        const tw = g.measureText(cur.label).width + 14;
        g.fillStyle = css(KIND[cur.kind]); g.beginPath(); g.roundRect(x - tw / 2, y - 11, tw, 22, 6); g.fill();
        g.fillStyle = css('bg'); g.fillText(cur.label, x, y + 1);
      }
      if (caption.dataset.k !== String(k)) {
        caption.dataset.k = String(k);
        caption.textContent = tx(cur.say);
        caption.className = `sim-event ${cur.kind === 'bad' ? 'bad-text' : ''}`;
      }
    } else if (k >= result.hops.length && caption.dataset.k !== 'end') {
      caption.dataset.k = 'end';
      caption.textContent = s.setup === 'twopc'
        ? tx({ en: 'No booking possible: the partners cannot take part in two-phase commit, so even a good day ends in abort.', vi: 'Không đặt được: các đối tác không tham gia được two-phase commit, nên kể cả ngày bình thường cũng kết thúc bằng huỷ.' })
        : result.ok
        ? tx({ en: 'Clean end: everything done, or everything undone and the customer never charged.', vi: 'Kết thúc sạch: hoặc mọi thứ xong, hoặc mọi thứ được hoàn tác và khách chưa bao giờ bị trừ tiền.' })
        : tx({ en: 'Broken end: what the customer was told does not match what the partners hold.', vi: 'Kết thúc hỏng: điều khách được báo không khớp với những gì các đối tác đang giữ.' });
      caption.className = `sim-event ${result.ok ? '' : 'bad-text'}`;
    }
  }
  const initial = () => ({ seat: 'none', tickets: 0, room: 'none', card: 'none', customer: 'waiting', steps: ORDER[s.setup].map(() => 'todo'), saved: 0 });

  function paintBoard() {
    board.textContent = '';
    const rows = revealed ? SETUPS : ['today'];
    board.append(
      el('p', { class: 'sim-lbl' }, tx({ en: 'Scoreboard: fills in as you watch each run', vi: 'Bảng điểm: tự điền khi bạn xem từng lần chạy' })),
      el('table', {}, [
        el('thead', {}, el('tr', {}, [el('th', {}, ''), ...SITUATIONS.map(x => el('th', {}, tx(SITUATION[x])))])),
        el('tbody', {}, rows.map(st => el('tr', { class: st === s.setup ? 'on' : '' }, [
          el('th', {}, tx(LABEL[st])),
          ...SITUATIONS.map(x => {
            const seen = s.played[`${st}:${x}`], ok = seen && survives(st, x);
            return el('td', { class: !seen ? 'unseen' : ok ? 'ok' : 'bad' }, !seen ? '·' : ok ? '✓' : '✗');
          }),
        ]))),
      ]),
    );
  }

  const pauseBtn = button('', () => setPaused(!paused));
  function setPaused(v) {
    paused = v;
    pauseBtn.textContent = paused ? tx({ en: 'Resume ▶', vi: 'Tiếp tục ▶' }) : tx({ en: 'Pause ❚❚', vi: 'Tạm dừng ❚❚' });
    pauseBtn.classList.toggle('on', paused);
  }

  const locked = tx({ en: 'Make your call below to unlock the other setups.', vi: 'Trả lời câu hỏi bên dưới để mở khoá các cách làm còn lại.' });
  root.append(
    row(choice(tx({ en: 'Situation', vi: 'Tình huống' }), SITUATIONS.map(x => ({ value: x, label: tx(SITUATION[x]) })), s.situation, v => { s.situation = v; play(); })),
    row(choice(tx({ en: 'Setup', vi: 'Cách làm' }), SETUPS.map(v => ({
      value: v, label: tx(LABEL[v]), disabled: !revealed && v !== 'today', title: !revealed && v !== 'today' ? locked : null,
    })), s.setup, v => { s.setup = v; paintBoard(); play(); })),
    row(
      choice(tx({ en: 'Speed', vi: 'Tốc độ' }), [
        { value: 'slow', label: tx({ en: 'Slow', vi: 'Chậm' }) },
        { value: 'normal', label: tx({ en: 'Normal', vi: 'Bình thường' }) },
        { value: 'fast', label: tx({ en: 'Fast', vi: 'Nhanh' }) },
      ], s.speed, v => { s.speed = v; }),
      el('div', { class: 'sim-buttons sim-transport' }, [
        pauseBtn,
        button(tx({ en: 'Step ›', vi: 'Từng bước ›' }), step),
        button(tx({ en: 'Replay', vi: 'Chạy lại' }), play),
      ]),
    ),
    chart.el,
    caption,
    board,
    revealed ? '' : el('p', { class: 'sim-note' }, locked),
  );
  paintBoard();
  play();

  const stopResize = onResize(chart.el, () => draw());
  return () => { cancelAnimationFrame(raf); stopResize(); };
}
