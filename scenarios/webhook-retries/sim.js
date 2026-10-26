/* One paid order, played out message by message between Stripe, your webhook
   endpoint, a background worker, Postgres and the print partner. Each box shows what
   it is doing and holding (waiting for a reply, stopped, order paid, inbox row, books
   printed) and changes as messages land. js/sim-player.js supplies the controls,
   clock, captions and scoreboard; this file is the model and the drawing. Before the
   visitor answers, only today's handler is unlocked. */

import { tx } from '../../js/i18n.js';
import { css } from '../../js/sim-kit.js';
import { node, badge, road, message, later, icon } from '../../js/sim-draw.js';
import { player } from '../../js/sim-player.js';

export const SETUPS = ['today', 'fast', 'inbox', 'background', 'dedup'];
export const SITUATIONS = ['normal', 'slow', 'crash', 'dup'];

const INITIAL = { stripe: 'idle', deliveries: 0, api: 'idle', work: 'idle', order: 'unpaid', inbox: 'none', seen: false, printing: false, books: 0 };

/* Play one order. Returns { steps, results, final, books, ok, summary }, the shape
   js/sim-player.js plays; each step is one message (a hop).
   hop: { from, to, label, kind, say: {en, vi}, state } with state a snapshot after it.
   results: how each Stripe delivery ended, '200' | 'timeout' | '500'.
   Pure, so the scoreboard is pinned by tests/webhook-retries.test.js. */
export function run(setup, situation) {
  const s = { ...INITIAL };
  const hops = [], results = [];
  let attemptNo = 0;
  const hop = (from, to, label, kind, en, vi, change) => {
    if (change) change();
    hops.push({ from, to, label, kind, say: { en, vi }, state: { ...s } });
  };

  /* The partner answers a print job: one more book, whoever is still listening. */
  const printed = (to, en, vi) => {
    const n = s.books + 1;
    if (n > 1) hop('printer', to, 'PRINTED', 'bad', `Book #${n} is printed. The customer gets ${n} books for one order, and you pay for both.`, `Cuốn thứ ${n} được in. Khách nhận ${n} cuốn cho một đơn hàng, và bạn trả tiền cho cả hai.`, () => { s.printing = false; s.books = n; });
    else hop('printer', to, 'PRINTED', 'ok', en, vi, () => { s.printing = false; s.books = n; });
  };
  const sendJob = (from, en, vi) => hop(from, 'printer', 'PRINT JOB', 'call', en, vi, () => { s.printing = true; if (from === 'api') s.api = 'waiting'; });

  /* Today, faster + timeout and record-ID-first: all the work inside the request. */
  function inRequest(crash, slow) {
    if (setup === 'dedup') {
      hop('api', 'db', 'INSERT event_id', 'call', 'Before doing any work, the handler records the event ID in processed_events.', 'Trước khi làm bất cứ việc gì, handler ghi event ID vào processed_events.');
      if (s.seen) {
        hop('db', 'api', 'DUPLICATE', 'note', 'That event ID is already recorded.', 'Event ID đó đã được ghi.');
        if (s.books) hop('api', 'stripe', '200', 'ok', 'So the handler replies 200 and stops. No second book.', 'Vì vậy handler trả về 200 và dừng. Không có cuốn thứ hai.', () => { s.stripe = 'ok'; s.api = 'idle'; });
        else hop('api', 'stripe', '200', 'bad', 'So the handler replies 200 and stops. But the first attempt never reached the printer: "seen" was not "done". This paid order will never be printed.', 'Vì vậy handler trả về 200 và dừng. Nhưng lần đầu chưa bao giờ tới máy in: "đã thấy" không phải "đã xong". Đơn đã thanh toán này sẽ không bao giờ được in.', () => { s.stripe = 'ok'; s.api = 'idle'; });
        return '200';
      }
      hop('db', 'api', 'OK', 'ok', 'Recorded.', 'Đã ghi.', () => { s.seen = true; });
    }
    hop('api', 'db', 'UPDATE paid', 'call', 'The handler marks the order paid.', 'Handler đánh dấu đơn hàng đã thanh toán.');
    hop('db', 'api', 'OK', 'ok', 'Saved.', 'Đã lưu.', () => { s.order = 'paid'; });
    if (crash) {
      hop('api', 'api', 'STOPPED', 'bad', 'A deploy stops the container right after the order was marked paid. Stripe never gets an answer.', 'Một lần deploy dừng container ngay sau khi đơn được đánh dấu đã thanh toán. Stripe không bao giờ nhận được phản hồi.', () => { s.api = 'stopped'; });
      hop('stripe', 'stripe', 'TIMEOUT', 'bad', 'Stripe stops waiting. As far as it knows, the delivery failed, so it will send the event again later.', 'Stripe ngừng chờ. Theo những gì nó biết, lần gửi đã thất bại, nên nó sẽ gửi lại sự kiện sau.', () => { s.stripe = 'timeout'; });
      return 'timeout';
    }
    sendJob('api', slow
      ? 'The handler sends the book to the print partner and waits. The partner is slow today: this job takes about 13 seconds.'
      : 'The handler sends the book to the print partner and waits for its answer.',
    slow
      ? 'Handler gửi cuốn sách sang đối tác in và chờ. Hôm nay đối tác chậm: job này mất khoảng 13 giây.'
      : 'Handler gửi cuốn sách sang đối tác in và chờ phản hồi.');
    if (slow && setup === 'fast') {
      hop('api', 'api', '5 s TIMEOUT', 'bad', 'After 5 seconds, the handler’s own timeout fires and it stops waiting for the printer…', 'Sau 5 giây, timeout của chính handler kích hoạt và nó ngừng chờ máy in…', () => { s.api = 'busy'; });
      hop('api', 'stripe', '500', 'bad', '…and returns 500. Stripe counts the delivery as failed. But the partner had already accepted the job.', '…và trả về 500. Stripe coi lần gửi là thất bại. Nhưng đối tác đã nhận job từ trước.', () => { s.stripe = '500'; s.api = 'idle'; });
      printed('printer', 'Nobody is listening any more, but the partner finishes the job: book #1 is printed.', 'Không còn ai nghe nữa, nhưng đối tác vẫn hoàn tất job: cuốn #1 được in.');
      return '500';
    }
    if (slow) {
      hop('stripe', 'stripe', 'TIMEOUT', 'bad', 'The printer is still working, and Stripe stops waiting. As far as it knows, the delivery failed, so it will send the event again later. Your handler keeps going.', 'Máy in vẫn đang chạy, và Stripe ngừng chờ. Theo những gì nó biết, lần gửi đã thất bại, nên nó sẽ gửi lại sự kiện sau. Handler của bạn vẫn tiếp tục.', () => { s.stripe = 'timeout'; });
      printed('api', 'The partner finally answers: book #1 is printed.', 'Cuối cùng đối tác trả lời: cuốn #1 được in.');
      hop('api', 'stripe', '200', 'late', 'The handler emails the invoice and replies 200, but Stripe stopped listening long ago.', 'Handler gửi email hoá đơn và trả về 200, nhưng Stripe đã ngừng nghe từ lâu.', () => { s.api = 'idle'; });
      return 'timeout';
    }
    printed('api', 'The partner answers: book #1 is printed.', 'Đối tác trả lời: cuốn #1 được in.');
    hop('api', 'stripe', '200', 'ok', 'The handler emails the invoice and replies 200.', 'Handler gửi email hoá đơn và trả về 200.', () => { s.stripe = 'ok'; s.api = 'idle'; });
    return '200';
  }

  /* Reply first, then do the work in memory in the same container. */
  function background(crash, slow) {
    hop('api', 'stripe', '200', 'ok', 'The endpoint checks the signature and replies 200 at once.', 'Endpoint kiểm tra chữ ký và trả về 200 ngay.', () => { s.stripe = 'ok'; });
    hop('api', 'work', 'START', 'note', 'Then it starts the order work in the background: a promise that lives only in this container’s memory.', 'Rồi nó bắt đầu xử lý đơn hàng ở background: một promise chỉ tồn tại trong bộ nhớ của container này.', () => { s.api = 'idle'; s.work = 'busy'; });
    hop('work', 'db', 'UPDATE paid', 'call', 'The background job marks the order paid.', 'Job background đánh dấu đơn hàng đã thanh toán.');
    hop('db', 'work', 'OK', 'ok', 'Saved.', 'Đã lưu.', () => { s.order = 'paid'; });
    if (crash) {
      hop('work', 'work', 'STOPPED', 'bad', 'A deploy stops the container. The work lived only in its memory, and Stripe already has its 200, so it will never send the event again. The paid order is lost.', 'Một lần deploy dừng container. Công việc chỉ nằm trong bộ nhớ của nó, và Stripe đã nhận 200, nên sẽ không bao giờ gửi lại sự kiện. Đơn đã thanh toán bị mất.', () => { s.work = 'stopped'; });
      return '200';
    }
    sendJob('work', slow
      ? 'It sends the book to the print partner. The partner is slow today, but nobody is waiting on it: Stripe already has its answer.'
      : 'It sends the book to the print partner.',
    slow
      ? 'Nó gửi cuốn sách sang đối tác in. Hôm nay đối tác chậm, nhưng không ai phải chờ: Stripe đã có câu trả lời.'
      : 'Nó gửi cuốn sách sang đối tác in.');
    printed('work', 'Book #1 is printed.', 'Cuốn #1 được in.');
    hop('work', 'work', 'EMAIL', 'note', 'The job emails the invoice and finishes.', 'Job gửi email hoá đơn và kết thúc.', () => { s.work = 'idle'; });
    return '200';
  }

  /* Store the event in the inbox, reply, and let a worker with a lease do the work. */
  function inbox(crash, slow) {
    hop('api', 'db', 'INSERT inbox', 'call', 'The endpoint checks the signature and inserts the event into the inbox table, keyed by its event ID.', 'Endpoint kiểm tra chữ ký và insert sự kiện vào bảng inbox, với khoá là event ID.');
    if (s.inbox !== 'none') {
      hop('db', 'api', 'CONFLICT', 'note', 'That event ID is already in the inbox, so the insert does nothing.', 'Event ID đó đã có trong inbox, nên lệnh insert không làm gì.');
      hop('api', 'stripe', '200', 'ok', 'The endpoint replies 200. No worker will ever see this event twice.', 'Endpoint trả về 200. Không worker nào thấy sự kiện này hai lần.', () => { s.stripe = 'ok'; s.api = 'idle'; });
      return '200';
    }
    hop('db', 'api', 'OK', 'ok', 'Stored.', 'Đã lưu.', () => { s.inbox = 'pending'; });
    hop('api', 'stripe', '200', 'ok', 'Only now does the endpoint reply 200: the event is safe in Postgres before Stripe hears "done".', 'Đến lúc này endpoint mới trả về 200: sự kiện đã an toàn trong Postgres trước khi Stripe nghe "xong".', () => { s.stripe = 'ok'; s.api = 'idle'; });
    hop('work', 'db', 'CLAIM', 'call', 'A worker claims the inbox row with a short lease.', 'Một worker nhận dòng inbox kèm một lease ngắn.', () => { s.work = 'busy'; });
    hop('db', 'work', 'ROW', 'ok', 'It gets the row.', 'Nó nhận được dòng đó.', () => { s.inbox = 'claimed'; });
    hop('work', 'db', 'UPDATE paid', 'call', 'The worker marks the order paid.', 'Worker đánh dấu đơn hàng đã thanh toán.');
    hop('db', 'work', 'OK', 'ok', 'Saved.', 'Đã lưu.', () => { s.order = 'paid'; });
    if (crash) {
      hop('work', 'work', 'STOPPED', 'bad', 'A deploy stops the worker mid-order. The row is still in the inbox, under a lease that will run out.', 'Một lần deploy dừng worker giữa chừng. Dòng đó vẫn nằm trong inbox, dưới một lease sẽ hết hạn.', () => { s.work = 'stopped'; });
      hop('db', 'db', 'LEASE EXPIRED', 'wait', 'The lease runs out, and the row is available again.', 'Lease hết hạn, và dòng đó lại sẵn sàng.', () => { s.inbox = 'pending'; });
      hop('work', 'db', 'CLAIM', 'call', 'Another worker claims the same row. The order is already paid, and no print job was recorded, so it goes on to printing.', 'Một worker khác nhận cùng dòng đó. Đơn đã được thanh toán, và chưa có job in nào được ghi, nên nó tiếp tục bước in.', () => { s.work = 'busy'; });
      hop('db', 'work', 'ROW', 'ok', 'It gets the row.', 'Nó nhận được dòng đó.', () => { s.inbox = 'claimed'; });
    }
    sendJob('work', slow
      ? 'It sends the book to the print partner. The partner is slow today, but nobody is waiting on it: Stripe already has its answer.'
      : 'It sends the book to the print partner.',
    slow
      ? 'Nó gửi cuốn sách sang đối tác in. Hôm nay đối tác chậm, nhưng không ai phải chờ: Stripe đã có câu trả lời.'
      : 'Nó gửi cuốn sách sang đối tác in.');
    printed('work', 'Book #1 is printed.', 'Cuốn #1 được in.');
    hop('work', 'db', 'MARK DONE', 'call', 'The worker emails the invoice and marks the inbox row done.', 'Worker gửi email hoá đơn và đánh dấu dòng inbox là xong.', () => { s.inbox = 'done'; s.work = 'idle'; });
    return '200';
  }

  const handle = { today: inRequest, fast: inRequest, dedup: inRequest, background, inbox }[setup];
  const SAY = {
    first: ['A customer pays. Stripe sends checkout.session.completed to your endpoint and waits for a 2xx.', 'Một khách thanh toán. Stripe gửi checkout.session.completed tới endpoint của bạn và chờ một mã 2xx.'],
    dup: ['Stripe delivers the same event a second time. Its docs warn that this can happen.', 'Stripe gửi cùng sự kiện đó lần thứ hai. Tài liệu của Stripe cảnh báo điều này có thể xảy ra.'],
    retry: ['Stripe retries the event it thinks failed.', 'Stripe gửi lại sự kiện mà nó nghĩ đã thất bại.'],
  };
  const attempt = kind => {
    attemptNo++;
    hop('stripe', 'api', 'POST event', 'call', ...SAY[kind], () => { s.deliveries++; s.stripe = 'waiting'; s.api = 'busy'; });
    const r = handle(situation === 'crash' && kind === 'first', situation === 'slow' && attemptNo === 1);
    results.push(r);
    return r;
  };

  const first = attempt('first');
  if (situation === 'dup') {
    hop('stripe', 'stripe', 'later', 'gap', 'A little later…', 'Một lúc sau…');
    attempt('dup');
  }
  if (first !== '200') {
    hop('stripe', 'stripe', 'later', 'gap', 'Later… (real retries come with growing gaps; the animation skips ahead)', 'Một lúc sau… (retry thật cách nhau ngày càng xa; hoạt cảnh tua nhanh)');
    attempt('retry');
  }

  const final = { ...s };
  const ok = final.books === 1 && results.includes('200');
  const summary = ok
    ? { en: 'Correct: one book printed, and Stripe has its 200.', vi: 'Đúng: in một cuốn, và Stripe đã nhận 200.' }
    : final.books === 0
    ? { en: 'Broken: someone paid, and no book will ever be printed. Nothing will retry it.', vi: 'Hỏng: khách đã trả tiền, và sẽ không có cuốn sách nào được in. Không gì thử lại nó.' }
    : { en: `Broken: ${final.books} books for one order.`, vi: `Hỏng: ${final.books} cuốn cho một đơn hàng.` };
  return { steps: hops, results, final, books: final.books, ok, summary };
}

export const survives = (setup, situation) => run(setup, situation).ok;

const LABEL = {
  today: { en: 'Today: all in the request', vi: 'Hiện tại: làm hết trong request' },
  fast: { en: 'Faster + 5 s timeout', vi: 'Nhanh hơn + timeout 5 giây' },
  inbox: { en: 'Inbox + workers', vi: 'Inbox + worker' },
  background: { en: 'Reply, then background', vi: 'Trả lời, rồi chạy background' },
  dedup: { en: 'Record event ID first', vi: 'Ghi event ID trước' },
};
const SITUATION = {
  normal: { en: 'Normal day', vi: 'Ngày bình thường' },
  slow: { en: 'Printer is slow', vi: 'Máy in chậm' },
  crash: { en: 'Deploy mid-order', vi: 'Deploy giữa đơn' },
  dup: { en: 'Event sent twice', vi: 'Sự kiện gửi hai lần' },
};
const KIND = { call: 'blue', ok: 'ok', bad: 'bad', note: 'muted', wait: 'warn', late: 'warn', gap: 'warn' };

export function mount(root, ctx) {
  const H = 360;
  return player(root, ctx, {
    situations: SITUATIONS.map(x => ({ value: x, label: tx(SITUATION[x]) })),
    setups: SETUPS.map(x => ({ value: x, label: tx(LABEL[x]) })),
    initial: { situation: 'slow' },
    run, survives, height: H,
    duration: h => h.kind === 'gap' ? 1.6 : h.from === h.to ? 1.3 : 1,
    tone: h => h.kind === 'bad' ? 'bad' : h.kind === 'late' || h.kind === 'wait' ? 'warn' : null,
    draw: frame => draw(frame, ctx.state.setup ?? 'today', H),
  });
}

/* Where a message leaves or enters a box: the edge point facing the other box. */
function edge([cx, cy], [hw, hh], [tx2, ty2]) {
  const dx = tx2 - cx, dy = ty2 - cy;
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return [cx + dx * t, cy + dy * t];
}

/* Each service's colour and icon. */
const LOOK = {
  stripe: { color: 'violet', icon: 'card' },
  api: { color: 'blue', icon: 'server' },
  work: { color: 'cat-queue', icon: 'gear' },
  db: { color: 'cat-caching', icon: 'db' },
  printer: { color: 'pink', icon: 'printer' },
};
/* A message's icon: what happened to it, or what it is. */
const markOf = h => /TIMEOUT|EXPIRED/.test(h.label) ? 'clock' : h.label === 'STOPPED' ? 'stop'
  : ({ call: 'mail', ok: 'check', bad: 'cross', note: 'dots', late: 'clock', wait: 'clock' })[h.kind];

/* The five boxes as they stand before step k, and step k's message in flight. */
function draw({ g, w, h, result, k, p, moving }, setup, H) {
  const n = result.steps.length;
  const cur = result.steps[Math.min(k, n - 1)];
  const st = k === 0 ? INITIAL : result.steps[k - 1].state;
  const bw = Math.min(230, w * 0.28), bh = 100;
  const P = { stripe: [w * 0.11, H / 2], api: [w * 0.45, 70], work: [w * 0.45, H - 70], db: [w * 0.83, 70], printer: [w * 0.83, H - 70] };
  const size = id => id === 'stripe' ? [Math.min(170, w * 0.2), 140] : [bw, bh];
  const hasWorker = setup === 'inbox' || setup === 'background';
  // The message being drawn, or the one that just landed while its caption lingers.
  const focus = moving ? cur : k > 0 && k < n ? result.steps[k - 1] : null;
  const isActive = id => focus && focus.kind !== 'gap' && (focus.from === id || focus.to === id);
  g.clearRect(0, 0, w, h);

  // Roads; the one a message is travelling lights up in the message's colour.
  const roads = [['stripe', 'api'], ['api', 'db'], ...(hasWorker ? [['api', 'work'], ['work', 'db'], ['work', 'printer']] : [['api', 'printer']])];
  for (const [a, b] of roads) {
    const lit = moving && cur.from !== cur.to && ((cur.from === a && cur.to === b) || (cur.from === b && cur.to === a));
    road(g, P[a], P[b], lit ? KIND[cur.kind] : null);
  }

  const box = (id, title, alert, dim) => {
    const [x, y] = P[id], [bw2, bh2] = size(id);
    node(g, { x, y, w: bw2, h: bh2, title, ...LOOK[id], active: isActive(id) && !dim, alert, dim });
  };
  const inner = id => { const [x, y] = P[id], [wd] = size(id); return { x, y, wd }; };
  const note = (id, dy, text, color = 'muted') => {
    const { x, y, wd } = inner(id);
    g.font = '11px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = css(color);
    g.fillText(text, x, y + dy, wd - 16);
  };

  // Stripe: how its delivery stands, and one envelope per delivery.
  const stripe = {
    idle: ['—', 'faint', null],
    waiting: [tx({ en: 'waiting for 2xx', vi: 'đang chờ 2xx' }), 'warn', 'clock'],
    ok: [tx({ en: '200 received', vi: 'đã nhận 200' }), 'ok', 'check'],
    timeout: [tx({ en: 'timed out', vi: 'hết thời gian chờ' }), 'bad', 'clock'],
    500: [tx({ en: 'got 500', vi: 'nhận 500' }), 'bad', 'cross'],
  }[st.stripe];
  box('stripe', 'Stripe', stripe[1] === 'bad');
  {
    const { x, y, wd } = inner('stripe');
    badge(g, x, y + 4, stripe[0], stripe[1], wd - 14, stripe[2]);
    for (let i = 0; i < st.deliveries; i++) icon(g, 'mail', x - (st.deliveries - 1) * 11 + i * 22, y + 40, 16, 'violet');
    if (!st.deliveries) note('stripe', 40, tx({ en: 'no deliveries', vi: 'chưa gửi' }), 'faint');
  }

  // Your endpoint, and the worker or in-memory background job.
  const RUN = {
    idle: [{ en: 'idle', vi: 'rảnh' }, 'faint', 'dots'],
    busy: [{ en: 'handling', vi: 'đang xử lý' }, 'blue', 'gear'],
    waiting: [{ en: 'waiting on printer', vi: 'chờ máy in' }, 'warn', 'clock'],
    stopped: [{ en: 'stopped by a deploy', vi: 'bị deploy dừng' }, 'bad', 'stop'],
  };
  box('api', tx({ en: 'Your endpoint', vi: 'Endpoint của bạn' }), st.api === 'stopped');
  { const { x, y, wd } = inner('api'), [text, color, mark] = RUN[st.api]; badge(g, x, y + 12, tx(text), color, wd - 14, mark); }
  const workTitle = setup === 'inbox' ? tx({ en: 'Worker', vi: 'Worker' }) : setup === 'background' ? tx({ en: 'Background job', vi: 'Job background' }) : tx({ en: 'Worker', vi: 'Worker' });
  box('work', workTitle, st.work === 'stopped', !hasWorker);
  if (hasWorker) {
    const { x, y, wd } = inner('work'), [text, color, mark] = RUN[st.work === 'busy' ? 'busy' : st.work];
    badge(g, x, y + 6, tx(text), color, wd - 14, mark);
    if (setup === 'background') note('work', 34, tx({ en: 'in the endpoint’s memory', vi: 'trong bộ nhớ của endpoint' }), 'faint');
  } else note('work', 10, tx({ en: 'not used in this setup', vi: 'không dùng ở cách này' }), 'muted');

  // Postgres: the order, and the inbox or processed_events table.
  box('db', 'Postgres');
  {
    const { x, y, wd } = inner('db'), paid = st.order === 'paid';
    badge(g, x, y + 4, paid ? tx({ en: 'order paid', vi: 'đơn đã thanh toán' }) : tx({ en: 'order unpaid', vi: 'đơn chưa thanh toán' }), paid ? 'ok' : 'faint', wd - 14, paid ? 'check' : 'dots');
    if (setup === 'inbox') note('db', 32, tx({ en: `inbox row: ${st.inbox === 'none' ? '—' : st.inbox}`, vi: `dòng inbox: ${{ none: '—', pending: 'chờ', claimed: 'đã nhận', done: 'xong' }[st.inbox]}` }), st.inbox === 'done' ? 'ok' : st.inbox === 'none' ? 'faint' : 'cat-caching');
    if (setup === 'dedup') note('db', 32, `processed_events: ${st.seen ? '1 ID' : '—'}`, st.seen ? 'cat-caching' : 'faint');
  }

  // The print partner: one book icon per printed book. Two is a duplicate; none at
  // the end is a lost order.
  const lost = k >= n && st.books === 0;
  box('printer', tx({ en: 'Print partner', vi: 'Đối tác in' }), st.books > 1 || lost);
  {
    const { x, y } = inner('printer');
    if (st.books) {
      const tone = st.books > 1 ? 'bad' : 'ok';
      for (let i = 0; i < st.books; i++) icon(g, 'book', x - (st.books - 1) * 14 + i * 28 - 30, y + 12, 26, tone);
      g.font = '700 13px "Hanken Grotesk", sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillStyle = css(tone);
      g.fillText(st.books > 1 ? tx({ en: `${st.books} books!`, vi: `${st.books} cuốn!` }) : tx({ en: '1 book', vi: '1 cuốn' }), x + (st.books - 1) * 14 - 4, y + 12);
    } else note('printer', 12, lost ? tx({ en: 'never printed', vi: 'không bao giờ được in' }) : tx({ en: 'no book yet', vi: 'chưa có sách' }), lost ? 'bad' : 'faint');
    if (st.printing) note('printer', 38, tx({ en: 'printing…', vi: 'đang in…' }), 'warn');
  }

  // The message in flight (none while the last one lingers).
  if (!moving) return;
  if (cur.kind === 'gap') { later(g, w, h, tx({ en: 'Later…', vi: 'Một lúc sau…' })); return; }
  if (cur.from === cur.to) {
    const [x, y] = P[cur.from], [, ht] = size(cur.from);
    message(g, x, y - ht / 2 - 4 - Math.sin(p * Math.PI) * 6, cur.label, KIND[cur.kind], markOf(cur));
    return;
  }
  const a = edge(P[cur.from], size(cur.from).map(v => v / 2), P[cur.to]);
  const b = edge(P[cur.to], size(cur.to).map(v => v / 2), P[cur.from]);
  const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;   // ease in and out
  message(g, a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, cur.label, KIND[cur.kind], markOf(cur), a);
}
