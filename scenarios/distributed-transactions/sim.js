/* One flight + hotel booking, played out message by message between the booking
   service, the airline, the hotel, the payment provider and the customer. Each
   partner's box shows what it holds (seat, room, money) and changes colour as calls
   land; the service shows its checklist of steps. js/sim-player.js supplies the
   controls, clock, captions and scoreboard; this file is the model and the drawing.
   Before the visitor answers, only today's code is unlocked. */

import { tx } from '../../js/i18n.js';
import { css } from '../../js/sim-kit.js';
import { node, badge, road, message, later, icon } from '../../js/sim-draw.js';
import { player } from '../../js/sim-player.js';

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

/* Play one booking. Returns { steps, final, ok, summary }, the shape js/sim-player.js
   plays; each step is one message (a hop).
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
  const ok = setup !== 'twopc' ? allDone || allUndone : false;
  const summary = setup === 'twopc'
    ? { en: 'No booking possible: the partners cannot take part in two-phase commit, so even a good day ends in abort.', vi: 'Không đặt được: các đối tác không tham gia được two-phase commit, nên kể cả ngày bình thường cũng kết thúc bằng huỷ.' }
    : ok
    ? { en: 'Clean end: everything done, or everything undone and the customer never charged.', vi: 'Kết thúc sạch: hoặc mọi thứ xong, hoặc mọi thứ được hoàn tác và khách chưa bao giờ bị trừ tiền.' }
    : { en: 'Broken end: what the customer was told does not match what the partners hold.', vi: 'Kết thúc hỏng: điều khách được báo không khớp với những gì các đối tác đang giữ.' };
  return { steps: hops, final: f, ok, summary };
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

export function mount(root, ctx) {
  const H = 340;
  return player(root, ctx, {
    situations: SITUATIONS.map(x => ({ value: x, label: tx(SITUATION[x]), icon: { normal: 'sun', noroom: 'bed', declined: 'card', crash: 'power', timeout: 'hourglass' }[x] })),
    setups: SETUPS.map(x => ({ value: x, label: tx(LABEL[x]), icon: { today: 'db', twopc: 'checks', saga: 'flow', recon: 'moon' }[x] })),
    initial: { situation: 'noroom' },
    run, survives, height: H,
    duration: h => h.kind === 'night' ? 2.2 : h.from === h.to ? 1.3 : 1,
    tone: h => h.kind === 'bad' ? 'bad' : h.kind === 'night' ? 'warn' : null,
    draw: frame => draw(frame, ctx.state.setup ?? 'today', H),
  });
}

/* Where a message leaves or enters a box: the edge point facing the other box. */
function edge([cx, cy], [hw, hh], [tx2, ty2]) {
  const dx = tx2 - cx, dy = ty2 - cy;
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return [cx + dx * t, cy + dy * t];
}

/* Each party's colour and icon. */
const LOOK = {
  customer: { color: 'violet', icon: 'user' },
  svc: { color: 'blue', icon: 'server' },
  airline: { color: 'pink', icon: 'plane' },
  hotel: { color: 'cat-queue', icon: 'bed' },
  pay: { color: 'cat-caching', icon: 'card' },
};
const markOf = h => h.label === 'CRASH' ? 'stop' : /timeout|02:00|expired/.test(h.label) ? 'clock'
  : ({ call: 'arrow', ok: 'check', bad: 'cross', undo: 'undo', note: 'dots', night: 'clock' })[h.kind];
const initial = setup => ({ seat: 'none', tickets: 0, room: 'none', card: 'none', customer: 'waiting', steps: ORDER[setup].map(() => 'todo'), saved: 0 });

/* The five parties as they stand before step k, and step k's message in flight. */
function draw({ g, w, h, result, k, p, moving }, setup, H) {
  const n = result.steps.length;
  const cur = result.steps[Math.min(k, n - 1)];
  const st = k === 0 ? initial(setup) : result.steps[k - 1].state;
  const P = { customer: [w * 0.1, H / 2], svc: [w * 0.4, H / 2], airline: [w * 0.82, 62], hotel: [w * 0.82, H / 2], pay: [w * 0.82, H - 62] };
  const size = id => id === 'customer' ? [Math.min(140, w * 0.17), 130] : id === 'svc' ? [Math.min(210, w * 0.27), H - 70] : [Math.min(210, w * 0.28), 96];
  const focus = moving ? cur : k > 0 && k < n ? result.steps[k - 1] : null;
  const isActive = id => focus && focus.kind !== 'night' && (focus.from === id || focus.to === id);
  g.clearRect(0, 0, w, h);

  for (const [a, b] of [['customer', 'svc'], ['svc', 'airline'], ['svc', 'hotel'], ['svc', 'pay']]) {
    const lit = moving && cur.from !== cur.to && ((cur.from === a && cur.to === b) || (cur.from === b && cur.to === a));
    road(g, P[a], P[b], lit ? KIND[cur.kind] : null);
  }
  const box = (id, title, alert) => {
    const [x, y] = P[id], [bw, bh] = size(id);
    node(g, { x, y, w: bw, h: bh, title, ...LOOK[id], active: isActive(id), alert });
  };
  const text = (x, y, s, color, font = '11px "IBM Plex Mono", monospace', align = 'center', max) => {
    g.font = font; g.textAlign = align; g.textBaseline = 'middle'; g.fillStyle = css(color); g.fillText(s, x, y, max);
  };

  // Partners: what each one holds.
  const PILL = {
    none: ['—', 'faint', 'dots'],
    held: [{ en: 'held', vi: 'đang giữ' }, 'warn', 'clock'],
    ticketed: st.tickets > 1 ? [{ en: `${st.tickets} tickets!`, vi: `${st.tickets} vé!` }, 'bad', 'cross'] : [{ en: 'ticket issued', vi: 'đã xuất vé' }, 'ok', 'check'],
    confirmed: [{ en: 'room confirmed', vi: 'đã xác nhận phòng' }, 'ok', 'check'],
    released: [{ en: 'released', vi: 'đã huỷ giữ' }, 'muted', 'undo'],
    unavailable: [{ en: 'no room', vi: 'hết phòng' }, 'bad', 'cross'],
    authorized: [{ en: '$1,240 on hold', vi: 'giữ 1.240 đô' }, 'warn', 'clock'],
    captured: [{ en: '$1,240 charged', vi: 'đã thu 1.240 đô' }, 'ok', 'check'],
    cancelled: [{ en: 'hold cancelled', vi: 'đã huỷ cấp phép' }, 'muted', 'undo'],
    refunded: [{ en: 'refunded', vi: 'đã hoàn tiền' }, 'muted', 'undo'],
    declined: [{ en: 'declined', vi: 'bị từ chối' }, 'bad', 'cross'],
  };
  for (const [id, title, value] of [
    ['airline', tx({ en: 'Airline', vi: 'Hãng bay' }), st.seat === 'held' ? 'held' : st.seat],
    ['hotel', tx({ en: 'Hotel', vi: 'Khách sạn' }), st.room],
    ['pay', tx({ en: 'Payments', vi: 'Thanh toán' }), st.card],
  ]) {
    const [label, color, mark] = PILL[value];
    box(id, title, color === 'bad');
    const [x, y] = P[id], [bw] = size(id);
    const extra = id === 'airline' && value === 'held' ? tx({ en: 'seat ', vi: 'ghế ' }) : id === 'hotel' && value === 'held' ? tx({ en: 'room ', vi: 'phòng ' }) : '';
    badge(g, x, y + 12, extra + tx(label), color, bw - 16, mark);
  }

  // The booking service and its checklist; the ticket is the point of no return.
  const crashing = moving && cur.label === 'CRASH';
  box('svc', tx({ en: 'Booking service', vi: 'Dịch vụ đặt chỗ' }), crashing);
  {
    const [x, y] = P.svc, [bw, bh] = size('svc'), left = x - bw / 2 + 16, top = y - bh / 2 + 50;
    const MARK = { todo: ['dots', 'faint'], running: ['arrow', 'blue'], done: ['check', 'ok'], failed: ['cross', 'bad'], undone: ['undo', 'violet'], unknown: ['clock', 'warn'] };
    ORDER[setup].forEach((id, i) => {
      const yy = top + i * 25, [mk, color] = MARK[st.steps[i]], pivot = STEP[id].pivot && setup === 'saga';
      if (st.steps[i] === 'running') { g.fillStyle = css('blue'); g.globalAlpha = 0.12; g.beginPath(); g.roundRect(left - 6, yy - 11, bw - 20, 22, 6); g.fill(); g.globalAlpha = 1; }
      icon(g, mk, left + 4, yy, 12, color);
      text(left + 18, yy, tx(STEP[id].name), pivot ? 'warn' : st.steps[i] === 'todo' ? 'muted' : 'text', '12px "Hanken Grotesk", sans-serif', 'left', bw - 50);
    });
    if (setup === 'saga') {
      text(x, y + bh / 2 - 34, tx({ en: `saved: ${st.saved ?? 0} of 6 done`, vi: `đã lưu: xong ${st.saved ?? 0}/6` }), 'ok');
      text(x, y + bh / 2 - 16, tx({ en: 'yellow = point of no return', vi: 'vàng = không thể quay lại' }), 'warn', '10px "IBM Plex Mono", monospace');
    }
  }

  // The customer: what they were told, and what is on their card.
  const CUST = {
    waiting: [{ en: 'booking…', vi: 'đang đặt…' }, 'muted', 'dots'],
    confirmed: [{ en: 'confirmed', vi: 'đã xác nhận' }, 'ok', 'check'],
    failed: [{ en: 'told it failed', vi: 'được báo thất bại' }, 'muted', 'cross'],
    pending: [{ en: 'still waiting', vi: 'vẫn đang chờ' }, 'warn', 'clock'],
    unknown: [{ en: 'no answer', vi: 'không có phản hồi' }, 'bad', 'clock'],
  }[st.customer];
  const money = st.card === 'authorized' || st.card === 'captured';
  const wrong = (st.customer === 'failed' && (money || st.seat === 'ticketed')) || st.tickets > 1 || st.customer === 'unknown';
  box('customer', tx({ en: 'Customer', vi: 'Khách hàng' }), wrong);
  {
    const [x, y] = P.customer, [bw] = size('customer');
    badge(g, x, y + 4, tx(CUST[0]), CUST[1], bw - 12, CUST[2]);
    // A hold mid-booking is normal; money still held after "failed" is the bug.
    const tone = !money ? 'faint' : st.customer === 'confirmed' ? 'ok' : ['failed', 'unknown'].includes(st.customer) ? 'bad' : 'warn';
    const what = !money ? tx({ en: 'card untouched', vi: 'thẻ chưa bị trừ' }) : st.card === 'captured' ? tx({ en: '$1,240 charged', vi: 'đã trừ 1.240 đô' }) : tx({ en: '$1,240 on hold', vi: 'bị giữ 1.240 đô' });
    icon(g, 'card', x - bw / 2 + 20, y + 36, 14, tone);
    text(x + 8, y + 36, what, tone, '11px "Hanken Grotesk", sans-serif', 'center', bw - 40);
  }

  // The message in flight (none while the last one lingers).
  if (!moving) return;
  if (cur.kind === 'night') { later(g, w, h, tx({ en: 'Hours later, 02:00', vi: 'Nhiều giờ sau, 02:00' })); return; }
  if (cur.from === cur.to) {
    // Only the service talks to itself; its note appears in the space under the checklist.
    const [x, y] = P[cur.from], [, bh] = size(cur.from);
    message(g, x, y - bh / 2 + 50 + ORDER[setup].length * 25 + 18 - Math.sin(p * Math.PI) * 5, cur.label, KIND[cur.kind], markOf(cur));
    return;
  }
  const a = edge(P[cur.from], size(cur.from).map(v => v / 2), P[cur.to]);
  const b = edge(P[cur.to], size(cur.to).map(v => v / 2), P[cur.from]);
  const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;   // ease in and out
  message(g, a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, cur.label, KIND[cur.kind], markOf(cur), a);
}
