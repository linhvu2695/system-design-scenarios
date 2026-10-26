/* One paid order, played out message by message between Stripe, your webhook
   endpoint, a background worker, Postgres and the print partner. Each box shows what
   it is doing and holding (waiting for a reply, stopped, order paid, inbox row, books
   printed) and changes as messages land. Pick a situation and a setup; a scoreboard
   fills in as you watch. Before the visitor answers, only today's handler is unlocked. */

import { el } from '../../js/dom.js';
import { tx } from '../../js/i18n.js';
import { canvas, choice, button, css, row, onResize, reducedMotion } from '../../js/sim-kit.js';

export const SETUPS = ['today', 'fast', 'inbox', 'background', 'dedup'];
export const SITUATIONS = ['normal', 'slow', 'crash', 'dup'];

const INITIAL = { stripe: 'idle', deliveries: 0, api: 'idle', work: 'idle', order: 'unpaid', inbox: 'none', seen: false, printing: false, books: 0 };

/* Play one order. Returns { hops, results, final, books, ok }.
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
  return { hops, results, final, books: final.books, ok: final.books === 1 && results.includes('200') };
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

export function mount(root, { revealed, state }) {
  const s = Object.assign(state, { setup: 'today', situation: 'slow', played: {}, ...state });
  if (!revealed) s.setup = 'today';

  const H = 340;
  const chart = canvas(H);
  const caption = el('p', { class: 'sim-event', 'aria-live': 'polite' });
  const log = el('ol', { class: 'sim-story' });
  const board = el('div', { class: 'sim-board' });
  const reduce = reducedMotion();
  // Seconds per message at normal speed; after landing, a message lingers so its
  // caption can be read before the next one starts.
  const DUR = { self: 1.3, gap: 1.6, move: 1.0 }, DWELL = 1.1;
  const SPEEDS = { slow: 0.5, normal: 1, fast: 2 };
  if (!SPEEDS[s.speed]) s.speed = 'normal';
  const dur = h => (reduce ? 0.05 : h.kind === 'gap' ? DUR.gap : h.from === h.to ? DUR.self : DUR.move);
  // k: the message in flight; p: how far it has travelled (0..1); dwell: seconds left
  // to linger on the one that just landed; logged: how many captions are in the log.
  let result, k = 0, p = 0, dwell = 0, logged = 0, paused = false, last = 0, raf = 0;

  function play() {
    result = run(s.setup, s.situation);
    k = 0; p = 0; dwell = 0; logged = 0;
    log.textContent = '';
    delete caption.dataset.k;
    setPaused(false);
    cancelAnimationFrame(raf);
    if (reduce) { k = result.hops.length; draw(); finish(); return; }
    last = performance.now() / 1000;
    raf = requestAnimationFrame(frame);
  }

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
    else finish();
  }

  /* Paused: deliver the current message (or skip the linger) and stop again. */
  function step() {
    if (!result || k >= result.hops.length) return;
    setPaused(true);
    if (dwell > 0) dwell = 0;
    else { k++; p = 0; dwell = 0; }
    draw();
    if (k >= result.hops.length) finish();
  }

  function finish() {
    s.played[`${s.setup}:${s.situation}`] = true;
    paintBoard();
  }

  /* Where a message leaves or enters a box: the edge point facing the other box. */
  function edge([cx, cy], [hw, hh], [tx2, ty2]) {
    const dx = tx2 - cx, dy = ty2 - cy;
    const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
    return [cx + dx * t, cy + dy * t];
  }

  function draw() {
    const { w, h } = chart.fit();
    const g = chart.g;
    const n = result.hops.length;
    const cur = result.hops[Math.min(k, n - 1)];
    const st = k === 0 ? INITIAL : result.hops[k - 1].state;
    const bw = Math.min(200, w * 0.27), bh = 82;
    const P = { stripe: [w * 0.11, H / 2], api: [w * 0.45, 72], work: [w * 0.45, H - 72], db: [w * 0.83, 72], printer: [w * 0.83, H - 72] };
    const SIZE = { stripe: [Math.min(150, w * 0.19), 120] };
    const size = id => SIZE[id] || [bw, bh];
    const hasWorker = s.setup === 'inbox' || s.setup === 'background';
    g.clearRect(0, 0, w, h);
    g.textBaseline = 'middle';

    // Roads between boxes that talk to each other in this setup.
    g.strokeStyle = css('line'); g.setLineDash([3, 5]);
    const roads = [['stripe', 'api'], ['api', 'db'], ...(hasWorker ? [['api', 'work'], ['work', 'db'], ['work', 'printer']] : [['api', 'printer']])];
    for (const [a, b] of roads) { g.beginPath(); g.moveTo(...P[a]); g.lineTo(...P[b]); g.stroke(); }
    g.setLineDash([]);

    const panel = (id, title, border = 'line', dim = false) => {
      const [x, y] = P[id], [wd, ht] = size(id);
      g.globalAlpha = dim ? 0.4 : 1;
      g.fillStyle = css('surface2'); g.strokeStyle = css(border); g.lineWidth = border === 'line' ? 1 : 2;
      g.beginPath(); g.roundRect(x - wd / 2, y - ht / 2, wd, ht, 10); g.fill(); g.stroke(); g.lineWidth = 1;
      g.fillStyle = css('muted'); g.font = '600 10px "IBM Plex Mono", monospace'; g.textAlign = 'left';
      g.fillText(title.toUpperCase(), x - wd / 2 + 10, y - ht / 2 + 13, wd - 20);
      g.globalAlpha = 1;
    };
    const pill = (id, dy, text, color) => {
      const [x, y] = P[id], [wd] = size(id);
      g.font = '600 12px "Hanken Grotesk", sans-serif'; g.textAlign = 'center';
      const tw = Math.min(wd - 16, g.measureText(text).width + 18);
      g.fillStyle = css(color); g.globalAlpha = 0.18; g.beginPath(); g.roundRect(x - tw / 2, y + dy - 12, tw, 24, 12); g.fill(); g.globalAlpha = 1;
      g.fillStyle = css(color); g.fillText(text, x, y + dy + 1, tw - 8);
    };
    const small = (id, dy, text, color = 'muted') => {
      const [x, y] = P[id], [wd] = size(id);
      g.font = '11px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.fillStyle = css(color);
      g.fillText(text, x, y + dy, wd - 14);
    };

    // Stripe.
    const stripe = { idle: ['—', 'faint'], waiting: [tx({ en: 'waiting for 2xx', vi: 'đang chờ 2xx' }), 'warn'], ok: [tx({ en: '200 received', vi: 'đã nhận 200' }), 'ok'], timeout: [tx({ en: 'timed out', vi: 'hết thời gian chờ' }), 'bad'], 500: [tx({ en: 'got 500', vi: 'nhận 500' }), 'bad'] }[st.stripe];
    panel('stripe', 'Stripe', stripe[1] === 'bad' ? 'bad' : 'line');
    pill('stripe', 0, stripe[0], stripe[1]);
    small('stripe', 32, tx({ en: `deliveries: ${st.deliveries}`, vi: `số lần gửi: ${st.deliveries}` }));

    // Your endpoint.
    const api = { idle: ['idle', 'faint'], busy: ['handling', 'blue'], waiting: ['waiting on printer', 'warn'], stopped: ['stopped', 'bad'] }[st.api];
    const apiVi = { idle: 'rảnh', busy: 'đang xử lý', waiting: 'chờ máy in', stopped: 'đã dừng' }[st.api];
    panel('api', tx({ en: 'Your endpoint', vi: 'Endpoint của bạn' }), st.api === 'stopped' ? 'bad' : 'line');
    pill('api', 6, tx({ en: api[0], vi: apiVi }), api[1]);

    // The worker, or the in-memory background job.
    const workTitle = s.setup === 'inbox' ? tx({ en: 'Worker', vi: 'Worker' }) : s.setup === 'background' ? tx({ en: 'Background job (same container)', vi: 'Job background (cùng container)' }) : tx({ en: 'No workers', vi: 'Không có worker' });
    const work = { idle: [tx({ en: 'idle', vi: 'rảnh' }), 'faint'], busy: [tx({ en: 'working', vi: 'đang làm' }), 'blue'], stopped: [tx({ en: 'stopped', vi: 'đã dừng' }), 'bad'] }[st.work];
    panel('work', workTitle, st.work === 'stopped' ? 'bad' : 'line', !hasWorker);
    if (hasWorker) pill('work', 6, work[0], work[1]);

    // Postgres: the order, and the inbox or processed_events table.
    panel('db', 'Postgres');
    pill('db', -2, st.order === 'paid' ? tx({ en: 'order: paid', vi: 'đơn: đã thanh toán' }) : tx({ en: 'order: unpaid', vi: 'đơn: chưa thanh toán' }), st.order === 'paid' ? 'ok' : 'muted');
    if (s.setup === 'inbox') small('db', 26, tx({ en: `inbox row: ${st.inbox === 'none' ? '—' : st.inbox}`, vi: `dòng inbox: ${{ none: '—', pending: 'chờ', claimed: 'đã nhận', done: 'xong' }[st.inbox]}` }), st.inbox === 'done' ? 'ok' : 'muted');
    if (s.setup === 'dedup') small('db', 26, tx({ en: `processed_events: ${st.seen ? '1 ID' : '—'}`, vi: `processed_events: ${st.seen ? '1 ID' : '—'}` }));

    // The print partner and what it has printed.
    const booksText = st.books === 0 ? tx({ en: 'no book yet', vi: 'chưa có sách' }) : st.books === 1 ? tx({ en: '1 book', vi: '1 cuốn' }) : tx({ en: `${st.books} books!`, vi: `${st.books} cuốn!` });
    panel('printer', tx({ en: 'Print partner', vi: 'Đối tác in' }), st.books > 1 ? 'bad' : 'line');
    pill('printer', -2, booksText, st.books === 0 ? 'muted' : st.books === 1 ? 'ok' : 'bad');
    if (st.printing) small('printer', 26, tx({ en: 'printing…', vi: 'đang in…' }), 'warn');

    // The message in flight (none while the last one lingers).
    if (cur && k < n && dwell <= 0) {
      if (cur.kind === 'gap') {
        g.fillStyle = css('bg'); g.globalAlpha = 0.6; g.fillRect(0, 0, w, h); g.globalAlpha = 1;
        g.fillStyle = css('warn'); g.font = '700 20px "IBM Plex Mono", monospace'; g.textAlign = 'center';
        g.fillText(tx({ en: '… later', vi: '… một lúc sau' }), w / 2, h / 2);
      } else {
        let x, y;
        if (cur.from === cur.to) { x = P[cur.from][0]; y = P[cur.from][1] - size(cur.from)[1] / 2 - 2; }
        else {
          const [x1, y1] = edge(P[cur.from], size(cur.from).map(v => v / 2), P[cur.to]);
          const [x2, y2] = edge(P[cur.to], size(cur.to).map(v => v / 2), P[cur.from]);
          x = x1 + (x2 - x1) * p; y = y1 + (y2 - y1) * p;
        }
        g.font = '700 11px "IBM Plex Mono", monospace'; g.textAlign = 'center';
        const tw = g.measureText(cur.label).width + 14;
        x = Math.min(Math.max(x, tw / 2 + 2), w - tw / 2 - 2);
        g.fillStyle = css(KIND[cur.kind]); g.beginPath(); g.roundRect(x - tw / 2, y - 11, tw, 22, 6); g.fill();
        g.fillStyle = css('bg'); g.fillText(cur.label, x, y + 1);
      }
    }

    // Caption and log: every message that has started, in order.
    while (logged < Math.min(k + 1, n)) {
      const hp = result.hops[logged++];
      const tone = hp.kind === 'bad' ? 'bad' : hp.kind === 'late' || hp.kind === 'wait' ? 'warn' : null;
      log.append(el('li', { style: tone ? `color:${css(tone)}` : null }, tx(hp.say)));
    }
    if (k < n && caption.dataset.k !== String(k)) {
      caption.dataset.k = String(k);
      caption.textContent = tx(cur.say);
      caption.className = `sim-event ${cur.kind === 'bad' ? 'bad-text' : ''}`;
    } else if (k >= n && caption.dataset.k !== 'end') {
      caption.dataset.k = 'end';
      caption.textContent = result.ok
        ? tx({ en: 'Correct: one book printed, and Stripe has its 200.', vi: 'Đúng: in một cuốn, và Stripe đã nhận 200.' })
        : result.books === 0
        ? tx({ en: 'Broken: someone paid, and no book will ever be printed. Nothing will retry it.', vi: 'Hỏng: khách đã trả tiền, và sẽ không có cuốn sách nào được in. Không gì thử lại nó.' })
        : tx({ en: `Broken: ${result.books} books for one order.`, vi: `Hỏng: ${result.books} cuốn cho một đơn hàng.` });
      caption.className = `sim-event ${result.ok ? '' : 'bad-text'}`;
    }
  }

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
    el('p', { class: 'sim-lbl', style: 'margin-top:14px' }, tx({ en: 'What happened', vi: 'Diễn biến' })),
    log,
    board,
    revealed ? '' : el('p', { class: 'sim-note' }, locked),
  );
  paintBoard();
  play();

  const stopResize = onResize(chart.el, () => draw());
  return () => { cancelAnimationFrame(raf); stopResize(); };
}
