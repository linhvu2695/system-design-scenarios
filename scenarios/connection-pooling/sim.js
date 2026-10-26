/* Connections as strings. Client connections on the left, PgBouncer in the middle,
   Postgres backends on the right.

   - With no pooler, every client connection is its own string to a Postgres backend,
     until max_connections refuses the rest.
   - With PgBouncer, every client stays connected to PgBouncer (a faint string), and
     PgBouncer keeps a few server connections open to Postgres. A client borrows a
     server connection (a bright string) to run a query:
       transaction mode: for one transaction, then it goes back to the pool;
       session mode:     at its first query, and keeps it until it disconnects.
     A client with nothing free waits in PgBouncer's queue (an amber string).
   - Each server connection shows the session setting left on it. Under transaction
     pooling, a plain SET stays behind and the next borrower inherits it.

   The model is a small scheduler over time (run()), drawn at any moment t. One line is
   about 25 real client connections; a transaction that takes 5 ms in production takes
   a fraction of a second here. js/sim-player.js supplies the controls and scoreboard;
   its steps are the captioned moments of the run. */

import { tx } from '../../js/i18n.js';
import { css, rng } from '../../js/sim-kit.js';
import { player } from '../../js/sim-player.js';

export const SETUPS = ['today', 'raise', 'txnlocal', 'session', 'txn'];
export const SITUATIONS = ['quiet', 'monday', 'twoclinics'];

export const SCALE = 25;            // real client connections per line
export const CORES = 16;
export const SWEET = CORES * 2;     // the PostgreSQL wiki's starting point for active connections
export const MAX_CONN = { today: 200, raise: 1000 };
export const POOL = { txnlocal: 40, txn: 40, session: 190 };
export const SLOTS = { txnlocal: 4, txn: 4, session: 8 };   // server connections drawn
export const MODE = { txnlocal: 'transaction', txn: 'transaction', session: 'session' };
export const LINES = { quiet: 5, monday: 24, twoclinics: 5 };
export const END = 10, CONNECT = 0.4, WAIT_TIMEOUT = 5;     // WAIT_TIMEOUT stands for query_wait_timeout
const DT = 0.01;
/* How long a SET, the gap before the transaction, and the transaction take on screen.
   Monday is busy, so its work is quick; with a couple of clients on screen, each round
   trip is slow enough to follow. */
const TIMING = { monday: { set: 0.06, gap: 0.08, tx: 0.3 }, quiet: { set: 0.3, gap: 0.25, tx: 0.9 }, twoclinics: { set: 0.3, gap: 0.25, tx: 0.9 } };
const CLINICS = [17, 42, 8, 23];

/* Who sends what, when: [{ line, at, clinic }]. Seeded, so every visit is the same. */
function requests(situation) {
  if (situation === 'quiet') return [0, 1, 2, 3, 4].map(i => ({ line: i, at: 1 + i * 1.6, clinic: CLINICS[i % CLINICS.length] }));
  if (situation === 'twoclinics') return [{ line: 0, at: 2, clinic: 17 }, { line: 1, at: 2.05, clinic: 42 }];
  const r = rng(5), out = [];
  for (let line = 0; line < LINES.monday; line++) {
    const clinic = CLINICS[line % CLINICS.length];
    out.push({ line, at: 0.6 + r() * 3.4, clinic });                 // the morning's normal traffic
    if (line < 14) out.push({ line, at: 4.4 + r() * 0.35, clinic });  // the 9:00 burst: 14 lines at once
    out.push({ line, at: 6.6 + r() * 2.2, clinic });
  }
  return out.sort((a, b) => a.at - b.at);
}

/* Run one situation. Returns everything the picture needs, as intervals over time:
   holds:    [{ line, slot, t0, t1, kind: 'set' | 'tx' | 'session' }]   a client on a server connection
   jobs:     [{ line, t0, t1, kind, clinic, served }]                   work running; served = whose rows came back
   waits:    [{ line, t0, t1, outcome: 'served' | 'timeout' | 'waiting' }]   a client queued in PgBouncer
   settings: [{ slot, t, value }]                                       what is left on a server connection
   leaks:    [{ line, slot, t, want, got }]                             a transaction under another clinic's setting
   empties:  [{ line, slot, t }]                                        a transaction on a connection nobody set: no rows
   links:    [{ line, backend }] / refused: [line]                       direct connections
   plus ok, steps (captioned moments for the player) and summary. Pure. */
export function run(setup, situation) {
  const pooled = !!POOL[setup], mode = MODE[setup];
  const nLines = LINES[situation];
  const reqs = requests(situation);
  const { set: SET_DUR, gap: GAP, tx: TX_DUR } = TIMING[situation];
  const holds = [], jobs = [], waits = [], settings = [], leaks = [], empties = [], links = [], refused = [];
  let maxBusy = 0;

  if (!pooled) {
    // Every line opens its connections straight to Postgres.
    const room = Math.floor(MAX_CONN[setup] / SCALE);
    for (let line = 0; line < nLines; line++) (line < room ? links.push({ line, backend: line }) : refused.push(line));
    for (const q of reqs) {
      if (refused.includes(q.line)) continue;
      jobs.push({ line: q.line, t0: q.at, t1: q.at + SET_DUR + GAP + TX_DUR, kind: 'tx', clinic: q.clinic, served: q.clinic });
    }
    for (let t = 0; t <= END; t += 0.05) maxBusy = Math.max(maxBusy, jobs.filter(j => j.t0 <= t && j.t1 > t).length);
  } else {
    // A small scheduler: each request becomes one or two jobs that need a server connection.
    const nSlots = SLOTS[setup];
    const slots = Array.from({ length: nSlots }, () => ({ until: 0, setting: null, job: null }));
    const free = Array.from({ length: nSlots }, (_, j) => nSlots - 1 - j);   // a LIFO stack: pop() takes server 1 first
    const owner = new Map();             // session mode: line -> its server connection for good
    const queue = [];                    // FIFO of jobs waiting for a server connection
    const pending = reqs.map(q => (setup === 'txn'
      ? { ...q, kind: 'set', dur: SET_DUR }                   // the code's SET, a transaction of its own
      : { ...q, kind: 'tx', dur: SET_DUR + GAP + TX_DUR, local: setup === 'txnlocal' }));
    for (let t = 0; t <= END + 1e-9; t = Math.round((t + DT) * 100) / 100) {
      // Finish what is done; in transaction mode the server connection goes back to the pool.
      slots.forEach((sl, j) => {
        if (!sl.job || sl.until > t) return;
        const job = sl.job;
        sl.job = null;
        jobs.push({ line: job.line, t0: job.start, t1: t, kind: job.kind, clinic: job.clinic, served: job.served });
        if (mode === 'transaction') {
          holds.push({ line: job.line, slot: j, t0: job.start, t1: t, kind: job.kind });
          if (job.local) { sl.setting = null; settings.push({ slot: j, t, value: null }); }
          free.push(j);
          if (job.kind === 'set') pending.push({ line: job.line, clinic: job.clinic, kind: 'tx', dur: TX_DUR, at: t + GAP });
        }
      });
      // New arrivals join the queue.
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i].at <= t) { queue.push({ ...pending[i], queued: t }); pending.splice(i, 1); }
      queue.sort((a, b) => a.queued - b.queued || a.at - b.at);
      // Hand out server connections.
      for (let i = 0; i < queue.length; i++) {
        const job = queue[i];
        let j = mode === 'session' ? owner.get(job.line) : undefined;
        if (j === undefined) {
          if (!free.length) continue;
          j = free.pop();
          if (mode === 'session') { owner.set(job.line, j); holds.push({ line: job.line, slot: j, t0: t, t1: END + 1, kind: 'session' }); }
        } else if (slots[j].job) continue;   // its own connection is still busy
        queue.splice(i--, 1);
        if (t - job.queued > 0.02) waits.push({ line: job.line, t0: job.queued, t1: t, outcome: 'served' });
        const sl = slots[j];
        // Row-level security returns the rows of whatever clinic_id the connection carries.
        const served = job.kind !== 'tx' ? null : job.local || mode === 'session' ? job.clinic : sl.setting;
        Object.assign(sl, { job: { ...job, start: t, served }, until: t + job.dur });
        if (job.kind === 'tx' && !job.local && mode === 'transaction' && sl.setting !== job.clinic) {
          // Another clinic's setting is a leak; no setting at all returns nothing.
          if (sl.setting == null) empties.push({ line: job.line, slot: j, t });
          else leaks.push({ line: job.line, slot: j, t, want: job.clinic, got: sl.setting });
        }
        if (job.kind === 'set' || job.local || mode === 'session') { sl.setting = job.clinic; settings.push({ slot: j, t, value: job.clinic }); }
      }
      // Waited too long: PgBouncer disconnects the client.
      for (let i = 0; i < queue.length; i++) if (t - queue[i].queued >= WAIT_TIMEOUT) {
        waits.push({ line: queue[i].line, t0: queue[i].queued, t1: t, outcome: 'timeout' });
        queue.splice(i--, 1);
      }
      maxBusy = Math.max(maxBusy, slots.filter(s => s.job).length);
    }
    for (const job of queue) waits.push({ line: job.line, t0: job.queued, t1: END + 1, outcome: 'waiting' });
  }

  const busyReal = Math.round(maxBusy * (pooled ? POOL[setup] / SLOTS[setup] : SCALE));
  const timeouts = waits.filter(w => w.outcome === 'timeout');
  const overloaded = !pooled && busyReal > SWEET * 4;
  const ok = !refused.length && !timeouts.length && !leaks.length && !empties.length && !overloaded;

  const steps = story({ setup, situation, pooled, mode, nLines, holds, waits, leaks, refused, busyReal, overloaded, timeouts });
  const summary = ok
    ? { en: 'Within budget: every request served, every clinic sees only its own data.', vi: 'Đạt yêu cầu: mọi request được phục vụ, mỗi phòng khám chỉ thấy dữ liệu của mình.' }
    : leaks.length
    ? { en: 'Broken: a clinic’s transaction ran under another clinic’s setting and received its appointments.', vi: 'Hỏng: transaction của một phòng khám chạy dưới setting của phòng khám khác và nhận lịch hẹn của nó.' }
    : refused.length
    ? { en: 'Broken: Postgres refused connections, and requests on them failed.', vi: 'Hỏng: Postgres từ chối kết nối, và request trên các kết nối đó thất bại.' }
    : timeouts.length
    ? { en: 'Broken: clients waited for a server connection that never came back, and were disconnected.', vi: 'Hỏng: client chờ một kết nối server không bao giờ được trả lại, và bị ngắt.' }
    : { en: 'Broken: hundreds of busy processes on 16 cores slow every query down.', vi: 'Hỏng: hàng trăm tiến trình bận trên 16 nhân làm mọi truy vấn chậm đi.' };
  return { setup, situation, pooled, nLines, holds, jobs, waits, settings, leaks, empties, links, refused, busyReal, ok, summary, steps };
}

/* The captioned moments of a run, as player steps: { t0, t1, tone, say }. */
function story({ setup, situation, pooled, mode, nLines, holds, waits, leaks, refused, busyReal, overloaded, timeouts }) {
  const m = [];
  const add = (t, tone, en, vi) => m.push({ t, tone, say: { en, vi } });
  const real = nLines * SCALE;
  add(0, null, `Each line on the left is about ${SCALE} client connections from the app pods: ${real} in all.`, `Mỗi đường bên trái là khoảng ${SCALE} kết nối client từ các pod: tổng cộng ${real}.`);
  if (situation !== 'monday') add(CONNECT + 0.3, null, 'Why the clinic ID: the queries never say WHERE clinic_id = …. Row-level security adds that filter from app.clinic_id on the connection the query runs on, so whatever clinic is set there decides whose appointments come back.', 'Vì sao cần clinic ID: các truy vấn không bao giờ viết WHERE clinic_id = …. Row-level security tự thêm bộ lọc đó từ app.clinic_id trên kết nối mà truy vấn chạy, nên phòng khám nào được đặt ở đó sẽ quyết định lịch hẹn của ai được trả về.');
  if (!pooled) {
    add(CONNECT, refused.length ? 'bad' : null,
      refused.length ? `With no pooler, every client connection is a connection to Postgres. max_connections is ${MAX_CONN[setup]}: the first ${(nLines - refused.length) * SCALE} get in, and the other ${refused.length * SCALE} are refused with "too many clients".` : `With no pooler, every client connection is its own Postgres backend: ${real} of ${MAX_CONN[setup]} allowed.`,
      refused.length ? `Không có pooler, mỗi kết nối client là một kết nối tới Postgres. max_connections là ${MAX_CONN[setup]}: ${(nLines - refused.length) * SCALE} kết nối đầu vào được, ${refused.length * SCALE} còn lại bị từ chối với "too many clients".` : `Không có pooler, mỗi kết nối client là một backend Postgres riêng: ${real} trên ${MAX_CONN[setup]} cho phép.`);
  } else {
    add(CONNECT, null, `The clients connect to PgBouncer, not to Postgres. PgBouncer keeps ${POOL[setup]} server connections open to Postgres (${SLOTS[setup]} drawn) and lends them out in ${mode} mode.`, `Các client kết nối tới PgBouncer, không phải Postgres. PgBouncer giữ ${POOL[setup]} kết nối server mở tới Postgres (vẽ ${SLOTS[setup]}) và cho mượn ở chế độ ${mode}.`);
    const first = holds.slice().sort((a, b) => a.t0 - b.t0)[0];
    if (first && mode === 'transaction') add(first.t0, null,
      setup === 'txn' ? 'A request arrives. Its SET runs outside any transaction, so PgBouncer lends it a server connection just for that statement, then takes it back. The setting stays behind on the connection.' : 'A request arrives. Its transaction borrows a server connection, runs, and at COMMIT the connection goes back to the pool for the next client. SET LOCAL leaves nothing behind.',
      setup === 'txn' ? 'Một request tới. Lệnh SET của nó chạy ngoài transaction, nên PgBouncer cho mượn một kết nối server chỉ cho lệnh đó rồi lấy lại. Setting ở lại trên kết nối.' : 'Một request tới. Transaction của nó mượn một kết nối server, chạy, và khi COMMIT kết nối quay về pool cho client tiếp theo. SET LOCAL không để lại gì.');
    if (first && mode === 'session') add(first.t0, null, 'A client sends its first query and gets a server connection. In session mode it keeps it until it disconnects, busy or idle: the string stays.', 'Một client gửi truy vấn đầu tiên và nhận một kết nối server. Ở chế độ session nó giữ kết nối tới khi ngắt kết nối, bận hay rảnh: sợi dây vẫn còn.');
    const sessions = holds.filter(h => h.kind === 'session').sort((a, b) => a.t0 - b.t0);
    if (mode === 'session' && sessions.length === SLOTS[setup] && waits.length) add(sessions.at(-1).t0, 'warn', 'Every server connection is now held by a client that will never give it back. The next client to send a query has to wait.', 'Mọi kết nối server giờ đều bị giữ bởi client sẽ không bao giờ trả lại. Client tiếp theo gửi truy vấn phải chờ.');
  }
  if (situation === 'monday') {
    add(4.4, overloaded ? 'bad' : null,
      !pooled ? `9:00: a burst of requests. With nothing in front of the database, every one runs at once as its own process: about ${busyReal} busy processes on ${CORES} cores, against a sweet spot near ${SWEET}.` : mode === 'transaction' ? `9:00: a burst of requests. They queue inside PgBouncer and take turns on the server connections. Postgres never has more than ${POOL[setup]} busy processes.` : '9:00: a burst of requests. Clients that already hold a server connection run; everyone else keeps waiting.',
      !pooled ? `9:00: một đợt request dồn dập. Không có gì phía trước database, mọi request chạy cùng lúc như một tiến trình riêng: khoảng ${busyReal} tiến trình bận trên ${CORES} nhân, so với điểm tối ưu gần ${SWEET}.` : mode === 'transaction' ? `9:00: một đợt request dồn dập. Chúng xếp hàng trong PgBouncer và lần lượt dùng các kết nối server. Postgres không bao giờ có quá ${POOL[setup]} tiến trình bận.` : '9:00: một đợt request dồn dập. Client đã giữ kết nối server thì chạy; những client khác tiếp tục chờ.');
  }
  if (timeouts.length) add(timeouts[0].t1, 'bad', `After query_wait_timeout PgBouncer gives up on a waiting client and disconnects it. ${new Set(timeouts.map(w => w.line)).size * SCALE} client connections are cut off like this.`, `Sau query_wait_timeout PgBouncer bỏ cuộc với client đang chờ và ngắt nó. ${new Set(timeouts.map(w => w.line)).size * SCALE} kết nối client bị cắt như vậy.`);
  if (leaks.length) {
    const l = leaks[0];
    add(l.t, 'bad', `Clinic ${l.want}'s transaction is handed server ${l.slot + 1}, the connection released most recently. Another request's SET left clinic_id = ${l.got} on it, so row-level security returns clinic ${l.got}'s appointments to clinic ${l.want}.`, `Transaction của phòng khám ${l.want} được cấp server ${l.slot + 1}, kết nối vừa được trả gần nhất. Lệnh SET của request khác đã để lại clinic_id = ${l.got} trên đó, nên row-level security trả lịch hẹn của phòng khám ${l.got} cho phòng khám ${l.want}.`);
  }
  if (situation === 'twoclinics' && !leaks.length) add(3.6, null, 'Both clinics got their own appointments: each transaction ran with its own clinic_id.', 'Cả hai phòng khám nhận đúng lịch hẹn của mình: mỗi transaction chạy với clinic_id của chính nó.');
  if (situation === 'quiet' && setup === 'txn') add(5.5, 'warn', 'One request at a time, the SET and the transaction keep landing on the same server connection, so this looks fine. The leftover setting is still there for the next borrower.', 'Mỗi lúc một request, lệnh SET và transaction cứ rơi vào cùng một kết nối server, nên trông có vẻ ổn. Setting còn sót lại vẫn nằm đó chờ người mượn tiếp theo.');
  m.sort((a, b) => a.t - b.t);
  return m.map((x, i) => ({ ...x, t0: x.t, t1: i + 1 < m.length ? m[i + 1].t : END }));
}

export const survives = (setup, situation) => run(setup, situation).ok;

const LABEL = {
  today: { en: 'Today: direct, max 200', vi: 'Hiện tại: kết nối thẳng, tối đa 200' },
  raise: { en: 'max_connections = 1000', vi: 'max_connections = 1000' },
  txnlocal: { en: 'Transaction mode + SET LOCAL', vi: 'Chế độ transaction + SET LOCAL' },
  session: { en: 'Session mode, pool 190', vi: 'Chế độ session, pool 190' },
  txn: { en: 'Transaction mode, code as is', vi: 'Chế độ transaction, giữ code' },
};
const SITUATION = {
  quiet: { en: 'Quiet hour', vi: 'Giờ vắng' },
  monday: { en: 'Monday scale-out', vi: 'Scale-out sáng thứ Hai' },
  twoclinics: { en: 'Two clinics at once', vi: 'Hai phòng khám cùng lúc' },
};

export function mount(root, ctx) {
  const H = 440;
  let cached = null;   // the player asks for each run once; the drawing reads the same result
  return player(root, ctx, {
    situations: SITUATIONS.map(x => ({ value: x, label: tx(SITUATION[x]), icon: { quiet: 'sun', monday: 'building', twoclinics: 'copy' }[x] })),
    setups: SETUPS.map(x => ({ value: x, label: tx(LABEL[x]), icon: { today: 'server', raise: 'gauge', txnlocal: 'flow', session: 'lock', txn: 'bolt' }[x] })),
    initial: { situation: 'monday' },
    run: (setup, situation) => (cached = run(setup, situation)),
    survives, height: H,
    duration: st => Math.max(0.7, (st.t1 - st.t0) * (cached.situation === 'monday' ? 3.2 : 2.4)),
    tone: st => st.tone,
    draw: ({ g, w, h, k, p }) => {
      const st = cached.steps[k];
      draw(g, w, h, cached, st ? st.t0 + p * (st.t1 - st.t0) : END);
    },
  });
}

/* ---------------- drawing ---------------- */

/* One colour per clinic (four clinics), used for its queries and its rows, so rows that
   come back in another clinic's colour stand out. Grey is structure and idle
   connections, blue the pool's server connections, red a failure. */
const CLINIC_COLOR = { 17: 'cat-queue', 42: 'pink', 8: 'violet', 23: 'cat-caching' };

function draw(g, w, h, r, t) {
  const { setup, pooled, nLines } = r;
  const tint = c => CLINIC_COLOR[c] || 'blue';
  g.clearRect(0, 0, w, h);
  g.textBaseline = 'middle';
  const text = (s, x, y, color = 'muted', font = '11px "IBM Plex Mono", monospace', align = 'left', max) => {
    g.font = font; g.textAlign = align; g.fillStyle = css(color); g.fillText(s, x, y, max);
  };
  const live = a => a.t0 <= t && t < a.t1;
  const connected = t >= CONNECT;

  // Layout: clients | PgBouncer | Postgres.
  const top = 40, bottom = h - 62;
  const cx = 64, bx0 = w * 0.34, bx1 = w * 0.62, px = w * 0.88;
  const rowY = i => top + 6 + (i + 0.5) * ((bottom - top - 6) / nLines);
  const nSlots = pooled ? SLOTS[setup] : 0;
  const slotY = j => top + 30 + (j + 0.5) * ((bottom - top - 50) / Math.max(nSlots, 1));
  const slotX = bx1 - 24, queueX = bx0 + 34;
  const nBack = pooled ? nSlots : Math.min(nLines, Math.floor(MAX_CONN[setup] / SCALE));
  const backY = j => (pooled ? slotY(j) : top + 14 + (j + 0.5) * ((bottom - top - 20) / Math.max(nBack, 1)));

  // Headings.
  text(tx({ en: `CLIENT CONNECTIONS · ${nLines * SCALE}`, vi: `KẾT NỐI CLIENT · ${nLines * SCALE}` }), 10, 18, 'muted', '700 10.5px "IBM Plex Mono", monospace');
  text(pooled ? tx({ en: `PGBOUNCER · ${MODE[setup].toUpperCase()} MODE`, vi: `PGBOUNCER · CHẾ ĐỘ ${MODE[setup].toUpperCase()}` }) : tx({ en: 'NO POOLER', vi: 'KHÔNG CÓ POOLER' }), (bx0 + bx1) / 2, 18, pooled ? 'muted' : 'faint', '700 10.5px "IBM Plex Mono", monospace', 'center');
  text(tx({ en: `POSTGRES · max ${pooled ? 200 : MAX_CONN[setup]}`, vi: `POSTGRES · tối đa ${pooled ? 200 : MAX_CONN[setup]}` }), px, 18, 'muted', '700 10.5px "IBM Plex Mono", monospace', 'center');
  text(tx({ en: 'RLS: rows where clinic_id = app.clinic_id', vi: 'RLS: các dòng có clinic_id = app.clinic_id' }), w - 8, 31, 'muted', '9.5px "IBM Plex Mono", monospace', 'right', (w - bx1) - 12);

  // The PgBouncer box, with its queue on the left and its server connections on the right.
  g.save(); g.globalAlpha = pooled ? 1 : 0.3;
  g.fillStyle = css('surface2'); g.beginPath(); g.roundRect(bx0, top, bx1 - bx0, bottom - top, 14); g.fill();
  g.strokeStyle = css('faint'); g.globalAlpha *= 0.5; g.stroke(); g.restore();
  if (pooled) {
    text(tx({ en: 'queue', vi: 'hàng đợi' }), queueX, top + 14, 'muted', '600 10px "IBM Plex Mono", monospace', 'center');
    text(tx({ en: 'server connections', vi: 'kết nối server' }), slotX, top + 14, 'muted', '600 10px "IBM Plex Mono", monospace', 'right');
  }

  // A string between two points: a gentle S-curve.
  const curve = (x1, y1, x2, y2, u) => {
    const mx = (x1 + x2) / 2, v = 1 - u;
    return [v ** 3 * x1 + 3 * v * v * u * mx + 3 * v * u * u * mx + u ** 3 * x2, v ** 3 * y1 + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u ** 3 * y2];
  };
  const string = (x1, y1, x2, y2, color, width = 1.4, alpha = 1, dash) => {
    g.save(); g.strokeStyle = css(color); g.globalAlpha = alpha; g.lineWidth = width;
    if (dash) { g.setLineDash(dash); g.lineDashOffset = -(performance.now() / 50) % 20; }
    const mx = (x1 + x2) / 2;
    g.beginPath(); g.moveTo(x1, y1); g.bezierCurveTo(mx, y1, mx, y2, x2, y2); g.stroke(); g.restore();
  };
  const pulse = (x1, y1, x2, y2, u, color) => {   // a dot running along a string while work runs
    const [x, y] = curve(x1, y1, x2, y2, u);
    g.fillStyle = css(color); g.beginPath(); g.arc(x, y, 3.4, 0, Math.PI * 2); g.fill();
  };
  // A few rows, coloured by the clinic they belong to.
  const rows = (x, y, clinic, ring) => {
    for (let k = 0; k < 3; k++) {
      g.fillStyle = css(tint(clinic)); g.beginPath(); g.roundRect(x + k * 8, y - 3.5, 6.5, 7, 1.5); g.fill();
    }
    if (ring) { g.strokeStyle = css('bad'); g.lineWidth = 1.5; g.beginPath(); g.roundRect(x - 3, y - 6.5, 28, 13, 3); g.stroke(); g.lineWidth = 1; }
  };
  // A transaction's round trip: the query goes out in the client's colour, and the rows
  // that row-level security picked come back in their clinic's colour.
  const trip = (x1, y1, x2, y2, job) => {
    const u = progress(job);
    if (job.kind !== 'tx' || job.served == null || u < 0.5) return pulse(x1, y1, x2, y2, job.kind !== 'tx' ? u : u * 2, tint(job.clinic));
    const [x, y] = curve(x1, y1, x2, y2, 2 - u * 2);
    rows(x - 10, y, job.served, job.served !== job.clinic);
  };
  const progress = jb => Math.min(1, Math.max(0, (t - jb.t0) / (jb.t1 - jb.t0)));

  // Postgres backends.
  const s = Math.min(16, (bottom - top - 30) / Math.max(nBack, 1) - 3);
  for (let j = 0; j < nBack; j++) {
    const y = backY(j), open = connected && (pooled || r.links.some(l => l.backend === j));
    const busy = pooled
      ? r.holds.some(hd => hd.slot === j && live(hd) && r.jobs.some(jb => jb.line === hd.line && live(jb)))
      : r.jobs.some(jb => live(jb) && jb.line === j);
    g.fillStyle = css(busy ? 'blue' : open ? 'surface2' : 'bg2'); g.strokeStyle = css(open ? 'blue' : 'line');
    g.beginPath(); g.roundRect(px - s / 2, y - s / 2, s, s, 3); g.fill(); g.stroke();
  }

  // Server connections: PgBouncer keeps them open to Postgres the whole time.
  for (let j = 0; j < nSlots; j++) {
    const y = slotY(j);
    if (connected) string(slotX + 10, y, px - s / 2 - 2, backY(j), 'blue', 1.3, 0.5);
    const hold = r.holds.find(hd => hd.slot === j && live(hd));
    const busy = hold && r.jobs.some(jb => jb.line === hold.line && live(jb));
    g.save();
    if (busy) { g.shadowColor = css('blue'); g.shadowBlur = 14; }
    g.fillStyle = css(hold ? 'blue' : 'bg2'); g.globalAlpha = hold ? (busy ? 1 : 0.55) : 1;
    g.beginPath(); g.arc(slotX, y, 10, 0, Math.PI * 2); g.fill(); g.restore();
    g.strokeStyle = css(hold ? 'blue' : 'muted'); g.beginPath(); g.arc(slotX, y, 10, 0, Math.PI * 2); g.stroke();
    text(String(j + 1), slotX, y + 0.5, hold ? 'bg' : 'muted', '700 10px "IBM Plex Mono", monospace', 'center');
    // The setting left on this server connection.
    const set = r.settings.filter(sg => sg.slot === j && sg.t <= t).at(-1);
    if (set?.value != null && nSlots <= 4) {
      const leak = hold && r.leaks.some(l => l.slot === j && Math.abs(l.t - hold.t0) < 1e-6);
      const label = `clinic_id=${set.value}`, color = leak ? 'bad' : tint(set.value);
      g.font = '700 9.5px "IBM Plex Mono", monospace';
      const tw = g.measureText(label).width + 10, lx = slotX - 16 - tw, ly = y - 20;
      g.fillStyle = css(color); g.globalAlpha = 0.2; g.beginPath(); g.roundRect(lx, ly - 8, tw, 16, 8); g.fill(); g.globalAlpha = 1;
      text(label, lx + tw / 2, ly + 0.5, color, '700 9.5px "IBM Plex Mono", monospace', 'center');
    }
  }
  if (pooled) text(tx({ en: `${SLOTS[setup]} of ${POOL[setup]} server connections drawn`, vi: `vẽ ${SLOTS[setup]}/${POOL[setup]} kết nối server` }), (bx0 + bx1) / 2, bottom - 12, 'faint', '10px "IBM Plex Mono", monospace', 'center', bx1 - bx0 - 16);

  // Clients and their strings.
  let queued = 0;
  for (let i = 0; i < nLines; i++) {
    const y = rowY(i);
    const refused = r.refused.includes(i) && connected;
    const job = r.jobs.find(jb => jb.line === i && live(jb));
    const hold = r.holds.find(hd => hd.line === i && live(hd));
    const wait = r.waits.find(wt => wt.line === i && live(wt));
    const timedOut = r.waits.find(wt => wt.line === i && wt.outcome === 'timeout' && wt.t1 <= t);
    const leak = r.leaks.find(l => l.line === i && l.t <= t);
    const clinic = job?.clinic;
    const color = refused || timedOut || leak ? 'bad' : clinic ? tint(clinic) : 'muted';
    g.fillStyle = css(color); g.globalAlpha = clinic || refused || timedOut || leak ? 1 : 0.5;
    g.beginPath(); g.arc(cx, y, Math.min(6, (bottom - top) / nLines / 2.6), 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
    if (refused || timedOut || leak) text('✕', cx - 18, y, 'bad', '700 12px "IBM Plex Mono", monospace', 'center');
    if (nLines <= 6) {
      if (leak) text(tx({ en: `clinic ${leak.want}`, vi: `phòng khám ${leak.want}` }), cx + 12, y - 13, 'bad', '700 10px "IBM Plex Mono", monospace');
      else if (clinic) text(tx({ en: `clinic ${clinic}`, vi: `phòng khám ${clinic}` }), cx + 12, y - 13, tint(clinic), '600 10px "IBM Plex Mono", monospace');
      const got = r.jobs.filter(jb => jb.line === i && jb.kind === 'tx' && jb.t1 <= t).at(-1);
      if (got?.served != null) {
        const wrong = got.served !== got.clinic;
        rows(cx + 14, y + 12, got.served, wrong);
        text(tx({ en: `received clinic ${got.served}’s rows`, vi: `nhận dòng của phòng khám ${got.served}` }), cx + 44, y + 12, wrong ? 'bad' : tint(got.served), '600 9.5px "IBM Plex Mono", monospace', 'left', bx0 - cx - 52);
      }
    }
    if (nLines > 6) {
      // Many clients: show the rows each one just received, for a moment, beside it.
      const got = r.jobs.filter(jb => jb.line === i && jb.kind === 'tx' && jb.t1 <= t && t - jb.t1 < 1.2).at(-1);
      if (got?.served != null) rows(cx + 12, y, got.served, got.served !== got.clinic);
    }
    if (!connected) continue;

    if (!pooled) {
      const link = r.links.find(l => l.line === i);
      if (link) {
        string(cx + 7, y, px - s / 2 - 2, backY(link.backend), job ? tint(clinic) : 'muted', job ? 2.4 : 1.2, job ? 1 : 0.4);
        if (job) trip(cx + 7, y, px - s / 2 - 2, backY(link.backend), job);
      } else if (refused) {
        // Refused before reaching a backend: the string stops short.
        string(cx + 7, y, bx0 - 8, y, 'bad', 1.2, 0.6, [4, 4]);
        text(tx({ en: 'refused', vi: 'bị từ chối' }), bx0 - 4, y, 'bad', '9.5px "IBM Plex Mono", monospace');
      }
      continue;
    }
    // Every client stays connected to PgBouncer; a timed-out one is cut off.
    if (timedOut) { string(cx + 7, y, bx0 - 30, y, 'bad', 1, 0.45, [3, 4]); continue; }
    string(cx + 7, y, bx0, y, 'muted', 1, 0.3);
    if (wait && !hold) {
      const qy = top + 30 + (queued++ % 14) * 9;
      string(bx0, y, queueX, qy, 'muted', 1.6, 0.9, [5, 4]);
      g.fillStyle = css('muted'); g.beginPath(); g.arc(queueX, qy, 3, 0, Math.PI * 2); g.fill();
    } else if (hold) {
      const sy = slotY(hold.slot), active = !!job;
      string(bx0, y, slotX - 11, sy, active ? tint(clinic) : 'blue', active ? 2.6 : 1.6, active ? 1 : 0.4);
      if (active) trip(bx0, y, slotX - 11, sy, job);
    }
  }

  // Footer: what PgBouncer and Postgres carry right now.
  const busyNow = r.jobs.filter(live).length;
  const realConns = !connected ? 0 : pooled ? POOL[setup] : (nLines - r.refused.length) * SCALE;
  const realBusy = Math.round(busyNow * (pooled ? POOL[setup] / SLOTS[setup] : SCALE));
  const waitingNow = pooled ? new Set(r.waits.filter(live).map(wt => wt.line)).size : 0;
  const fy = h - 34, barW = Math.min(240, w * 0.28);
  text(tx({ en: `Postgres connections: ${realConns}${r.refused.length && connected ? ` · ${r.refused.length * SCALE} refused` : ''}`, vi: `kết nối Postgres: ${realConns}${r.refused.length && connected ? ` · ${r.refused.length * SCALE} bị từ chối` : ''}` }), 10, fy, r.refused.length && connected ? 'bad' : 'muted', '600 11px "IBM Plex Mono", monospace');
  if (pooled) text(tx({ en: `waiting in PgBouncer: ${waitingNow * SCALE}`, vi: `đang chờ trong PgBouncer: ${waitingNow * SCALE}` }), 10, fy + 18, waitingNow ? 'text' : 'muted', '600 11px "IBM Plex Mono", monospace');
  const bx = w - barW - 12, over = realBusy > SWEET * 4, scaleMax = SWEET * 8;
  text(tx({ en: `busy Postgres processes: ${realBusy}`, vi: `tiến trình Postgres bận: ${realBusy}` }), bx, fy, over ? 'bad' : 'muted', '600 11px "IBM Plex Mono", monospace');
  g.fillStyle = css('line'); g.beginPath(); g.roundRect(bx, fy + 12, barW, 8, 4); g.fill();
  g.fillStyle = css(over ? 'bad' : 'blue'); g.beginPath(); g.roundRect(bx, fy + 12, Math.max(realBusy ? 4 : 0, barW * Math.min(1, realBusy / scaleMax)), 8, 4); g.fill();
  const sx = bx + barW * (SWEET / scaleMax);
  g.strokeStyle = css('muted'); g.beginPath(); g.moveTo(sx, fy + 9); g.lineTo(sx, fy + 23); g.stroke();
  text(tx({ en: `≈${SWEET} = 2 × ${CORES} cores`, vi: `≈${SWEET} = 2 × ${CORES} nhân` }), sx + 4, fy + 30, 'muted', '9.5px "IBM Plex Mono", monospace');
}
