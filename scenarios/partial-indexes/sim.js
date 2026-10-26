/* The tickets table as a grid of rows, and its indexes beside it. Each cell stands for
   a slice of tickets (not to scale): its colour is the organisation, a green border
   marks open tickets. The new index marks the rows it covers: every row for a full
   index, only the open ones for a partial index.

   Reads walk the table: a pointer goes from the index in use to every row it visits.
   Writes insert rows at the end of the table, then add an entry to every index that
   covers them, one index at a time. js/sim-player.js supplies the controls, clock,
   captions and scoreboard. Timings come from a small illustrative cost model, not a
   benchmark. */

import { tx } from '../../js/i18n.js';
import { css, rng } from '../../js/sim-kit.js';
import { player } from '../../js/sim-player.js';

export const SETUPS = ['today', 'partial', 'composite', 'covering', 'replica'];
export const SITUATIONS = ['small', 'big', 'insert', 'import', 'peak'];

export const SPARE_MB = 2048;
export const SLO_MS = 200;
export const ORGS = { small: { tickets: 2000, open: 40 }, big: { tickets: 4_000_000, open: 40_000 } };
export const IMPORT_ROWS = 2_000_000;

/* The indexes the table has today; each covers every row. */
const BASE = [
  { name: 'tickets_pkey', key: '(id)', cover: 'all' },
  { name: 'tickets_org_id_idx', key: '(org_id)', cover: 'all' },
  { name: 'tickets_requester_idx', key: '(requester_id)', cover: 'all' },
];
/* The index each setup adds, with its estimated size (from the scenario). */
export const NEW = {
  partial: { name: 'tickets_open_inbox_idx', key: "(org_id, updated_at) WHERE status = 'open'", cover: 'open', mb: 90 },
  composite: { name: 'tickets_org_status_updated_idx', key: '(org_id, status, updated_at)', cover: 'all', mb: 5000 },
  covering: { name: 'tickets_inbox_covering_idx', key: '(org_id, status, updated_at) INCLUDE (…)', cover: 'all', mb: 13000 },
};
export const indexesOf = setup => NEW[setup] ? [...BASE, { ...NEW[setup], fresh: true }] : BASE;

/* The illustrative cost model, in microseconds: an index entry read, a row fetched
   from a cached table page, a row sorted, and a fixed cost per query. */
const COST = { entry: 0.5, row: 2, sort: 1, base: 1500 };
export const latencyMs = ({ entries, rows, sorted = 0 }) => (COST.base + entries * COST.entry + rows * COST.row + sorted * COST.sort) / 1000;

/* The table: 22 rows of 24 cells already written, and a last row left empty for
   inserts. Seeded, so the picture is the same on every visit. */
export const COLS = 24, ROWS = 12, FILLED = COLS * (ROWS - 1);
export const CELLS = (() => {
  const r = rng(11);
  const cells = Array.from({ length: FILLED }, () => {
    const x = r();
    return { org: x < 0.36 ? 'big' : 'other', open: r() < 0.07 };
  });
  // The small organisation: six rows spread through the table, one of them open.
  [17, 61, 108, 150, 199, 241].forEach((i, k) => { cells[i] = { org: 'small', open: k === 5 }; });
  // The newest rows of the big organisation include a few open ones.
  for (const i of [233, 247, 258]) cells[i] = { org: 'big', open: true };
  return cells;
})();
const orgCells = org => CELLS.map((c, i) => (c.org === org ? i : -1)).filter(i => i >= 0);
/* What a matching index reads: the organisation's open rows, newest first, enough
   for 50 tickets (three cells at most). */
const newestOpen = org => orgCells(org).filter(i => CELLS[i].open).reverse().slice(0, 3);
export const INSERTED = [FILLED + 3];                                     // one new open ticket
export const IMPORTED = Array.from({ length: COLS - 6 }, (_, k) => FILLED + 6 + k);   // a closed history

const fmt = n => n.toLocaleString('en-US');
const fmtMs = ms => ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
const fmtMb = mb => mb >= 1000 ? `${(mb / 1000).toFixed(mb >= 10000 ? 0 : 1)} GB` : `${mb} MB`;

/* Play one situation. Returns { steps, ok, summary, ms, writesPerRow }.
   step: { label, kind, say: {en, vi}, act } where act is what the picture animates:
     { query }                       the statement on the banner
     { use: name }                   the index the plan uses
     { scan: [cells], tone, heap }   rows visited, one after another
     { insert: [cells], open }       rows appended to the table
     { write: name, n } / { skip: name }   an index gets its entries, or is skipped
     { load: mb } / { evict: true }  the new index in cache; hot pages pushed out
     { result: text, tone }          the answer
   Pure, so the scoreboard is pinned by tests/partial-indexes.test.js. */
export function run(setup, situation) {
  const steps = [];
  const step = (label, kind, en, vi, act = {}) => steps.push({ label, kind, say: { en, vi }, act });
  const indexes = indexesOf(setup);
  const fresh = NEW[setup];
  let ok = true, ms = null, writesPerRow = null;

  if (situation === 'small' || situation === 'big') {
    const org = ORGS[situation];
    const where = setup === 'replica' ? { en: ' The query goes to the read replica, which has the same indexes as the primary.', vi: ' Truy vấn đi tới read replica, nơi có đúng các index như primary.' } : { en: '', vi: '' };
    step('SELECT inbox', 'call', `An agent at the ${situation === 'big' ? 'largest' : 'small'} organisation opens the inbox.${where.en}`, `Một agent ở tổ chức ${situation === 'big' ? 'lớn nhất' : 'nhỏ'} mở hộp thư.${where.vi}`,
      { query: `SELECT … WHERE org_id = ${situation === 'big' ? 7 : 42} AND status = 'open' ORDER BY updated_at DESC LIMIT 50` });
    if (fresh) {
      step('PLAN', 'note', `The planner uses ${fresh.name}: it is sorted by org_id, then updated_at, and holds ${fresh.cover === 'open' ? 'only open tickets' : 'every ticket with its status'}.`, `Planner dùng ${fresh.name}: nó được sắp theo org_id rồi updated_at, và chứa ${fresh.cover === 'open' ? 'chỉ ticket đang mở' : 'mọi ticket kèm trạng thái'}.`, { use: fresh.name });
      step('SEEK → 50 rows', 'ok', 'It jumps straight to this organisation’s newest open tickets and reads 50 of them. Nothing else in the table is touched.', 'Nó nhảy thẳng tới các ticket đang mở mới nhất của tổ chức này và đọc 50 cái. Không phần nào khác của bảng bị chạm tới.',
        { scan: newestOpen(situation), tone: 'ok', count: 50 });
      if (setup === 'covering') step('HEAP CHECK 47/50', 'wait', 'An index-only scan may skip the table only for pages marked all-visible. Open tickets change all day, so it visits the table for 47 of the 50 rows anyway.', 'Index-only scan chỉ được bỏ qua bảng với trang đánh dấu all-visible. Ticket đang mở thay đổi suốt ngày, nên nó vẫn phải đọc bảng cho 47 trên 50 dòng.',
        { scan: newestOpen(situation), tone: 'warn', heap: true, count: 47 });
      ms = latencyMs({ entries: 50, rows: 50 });
    } else {
      step('PLAN', 'note', 'The only usable index is (org_id). It finds the organisation’s rows, but not which are open or how new they are.', 'Index dùng được duy nhất là (org_id). Nó tìm ra các dòng của tổ chức, nhưng không biết dòng nào đang mở hay mới tới đâu.', { use: 'tickets_org_id_idx' });
      step(`VISIT ${fmt(org.tickets)} rows`, org.tickets > 100000 ? 'bad' : 'ok', `It visits every row of the organisation, open or closed, all over the table: ${fmt(org.tickets)} rows.`, `Nó ghé mọi dòng của tổ chức, mở hay đóng, rải khắp bảng: ${fmt(org.tickets)} dòng.`,
        { scan: orgCells(situation), tone: org.tickets > 100000 ? 'bad' : 'ok', count: org.tickets });
      if (org.open > 50) step(`SORT ${fmt(org.open)}`, 'wait', `Only ${fmt(org.open)} of them are open. It sorts them all by updated_at to keep the newest 50.`, `Chỉ ${fmt(org.open)} trong số đó đang mở. Nó sắp xếp tất cả theo updated_at để giữ 50 cái mới nhất.`);
      ms = latencyMs({ entries: org.tickets, rows: org.tickets, sorted: org.open });
    }
    ok = ms <= SLO_MS;
    step(`50 rows · ${fmtMs(ms)}`, ok ? 'ok' : 'bad', ok ? `The inbox appears in ${fmtMs(ms)}.` : `The inbox appears after ${fmtMs(ms)}, far over the 200 ms budget.`, ok ? `Hộp thư hiện ra trong ${fmtMs(ms)}.` : `Hộp thư hiện ra sau ${fmtMs(ms)}, vượt xa ngân sách 200 ms.`,
      { result: `${fmtMs(ms)}`, tone: ok ? 'ok' : 'bad' });
  }

  if (situation === 'insert' || situation === 'import') {
    const bulk = situation === 'import';
    step(bulk ? 'IMPORT 2M closed' : 'INSERT 1 open', 'call',
      bulk ? 'A new customer imports their history: 2 million closed tickets, appended to the end of the table.' : 'A customer emails support: one new open ticket is appended to the end of the table.',
      bulk ? 'Một khách hàng mới nhập lịch sử: 2 triệu ticket đã đóng, được thêm vào cuối bảng.' : 'Một khách gửi email tới bộ phận hỗ trợ: một ticket mới đang mở được thêm vào cuối bảng.',
      { query: bulk ? 'COPY tickets FROM … -- 2,000,000 closed tickets' : "INSERT INTO tickets (…, status) VALUES (…, 'open')", insert: bulk ? IMPORTED : INSERTED, open: !bulk });
    let writes = 0;
    for (const ix of indexes) {
      const covers = ix.cover === 'all' || !bulk;
      if (covers) {
        writes++;
        const n = bulk ? '+2M' : '+1';
        step(`${ix.name} ${n}`, bulk && ix.fresh ? 'bad' : 'call',
          bulk && ix.fresh ? `${ix.name} covers every row, so each imported ticket writes one more index entry than today.` : `${ix.name} covers ${ix.cover === 'open' ? 'open tickets, and this one is open' : 'every row'}: it gets ${bulk ? 'an entry for each imported ticket' : 'an entry'}.`,
          bulk && ix.fresh ? `${ix.name} bao phủ mọi dòng, nên mỗi ticket được nhập ghi thêm một mục index so với hiện tại.` : `${ix.name} bao phủ ${ix.cover === 'open' ? 'ticket đang mở, và ticket này đang mở' : 'mọi dòng'}: nó nhận ${bulk ? 'một mục cho mỗi ticket được nhập' : 'một mục'}.`,
          { write: ix.name, n });
      } else {
        step(`${ix.name} SKIP`, 'ok', `${ix.name} covers open tickets only. None of the imported tickets is open, so it is not touched at all.`, `${ix.name} chỉ bao phủ ticket đang mở. Không ticket nào được nhập đang mở, nên nó hoàn toàn không bị chạm tới.`, { skip: ix.name });
      }
    }
    writesPerRow = writes;
    ok = !bulk || writes <= BASE.length;
    step(`${writes} index writes per row`, ok ? 'ok' : 'bad',
      bulk ? (ok ? `${writes} index writes per imported row, the same as today. The import fits its night.` : `${writes} index writes per imported row instead of ${BASE.length}: the import, already at the disk’s limit, does not fit its night.`) : `Committed: ${writes} index writes for the new row.`,
      bulk ? (ok ? `${writes} lượt ghi index cho mỗi dòng được nhập, bằng hiện tại. Việc nhập vừa trong một đêm.` : `${writes} lượt ghi index cho mỗi dòng được nhập thay vì ${BASE.length}: việc nhập, vốn đã chạm giới hạn của đĩa, không còn vừa trong một đêm.`) : `Đã commit: ${writes} lượt ghi index cho dòng mới.`,
      { result: `${writes}× / row`, tone: ok ? 'ok' : 'bad' });
  }

  if (situation === 'peak') {
    step('MONDAY PEAK', 'note', 'Monday morning: every agent is online, and the hot table pages fill the cache. About 2 GB is spare.', 'Sáng thứ Hai: mọi agent đều online, và các trang nóng của bảng lấp đầy cache. Còn trống khoảng 2 GB.', { query: '-- every agent online · cache: 2 GB spare' });
    if (!fresh) step('NO NEW INDEX', 'ok', 'This setup adds no index, so the cache is as it was.', 'Cách này không thêm index nào, nên cache vẫn như cũ.', { result: tx({ en: 'cache intact', vi: 'cache nguyên vẹn' }), tone: 'ok' });
    else if (fresh.mb <= SPARE_MB) step(`${fmtMb(fresh.mb)} FITS`, 'ok', `${fresh.name} is ${fmtMb(fresh.mb)}: it fits in the spare cache and stays there.`, `${fresh.name} nặng ${fmtMb(fresh.mb)}: nó vừa trong phần cache trống và nằm yên ở đó.`, { load: fresh.mb, result: tx({ en: 'cache intact', vi: 'cache nguyên vẹn' }), tone: 'ok' });
    else {
      ok = false;
      step(`${fmtMb(fresh.mb)} · TOO BIG`, 'bad', `${fresh.name} is ${fmtMb(fresh.mb)}, more than the 2 GB of spare cache. Keeping it in memory means pushing something else out.`, `${fresh.name} nặng ${fmtMb(fresh.mb)}, lớn hơn 2 GB cache trống. Giữ nó trong bộ nhớ nghĩa là phải đẩy thứ khác ra.`, { load: fresh.mb });
      step('EVICTED', 'bad', 'Hot table pages are evicted to make room. Every query on tickets now reads more from disk, not just the inbox.', 'Các trang nóng của bảng bị đẩy ra để lấy chỗ. Mọi truy vấn trên tickets giờ đọc từ đĩa nhiều hơn, không chỉ hộp thư.', { evict: true, result: tx({ en: 'hot pages evicted', vi: 'trang nóng bị đẩy ra' }), tone: 'bad' });
    }
  }

  const summary = ok
    ? { en: 'Within budget.', vi: 'Đạt yêu cầu.' }
    : situation === 'peak'
    ? { en: 'Broken: the index is too big for memory and slows down every other query on tickets.', vi: 'Hỏng: index quá lớn so với bộ nhớ và làm chậm mọi truy vấn khác trên tickets.' }
    : situation === 'import'
    ? { en: 'Broken: the import writes more index entries per row than it can afford.', vi: 'Hỏng: việc nhập phải ghi nhiều mục index cho mỗi dòng hơn mức nó gánh được.' }
    : { en: `Broken: ${fmtMs(ms)} for one inbox, against a 200 ms budget.`, vi: `Hỏng: ${fmtMs(ms)} cho một hộp thư, so với ngân sách 200 ms.` };
  return { steps, ok, summary, ms, writesPerRow };
}

export const survives = (setup, situation) => run(setup, situation).ok;

const LABEL = {
  today: { en: 'Today: index on org_id', vi: 'Hiện tại: index trên org_id' },
  partial: { en: 'Partial index, open only', vi: 'Partial index, chỉ ticket mở' },
  composite: { en: 'Composite B-tree, all rows', vi: 'B-tree tổng hợp, mọi dòng' },
  covering: { en: 'Covering index (INCLUDE)', vi: 'Covering index (INCLUDE)' },
  replica: { en: 'Read replica', vi: 'Read replica' },
};
const SITUATION = {
  small: { en: 'Small org opens inbox', vi: 'Tổ chức nhỏ mở hộp thư' },
  big: { en: 'Largest org opens inbox', vi: 'Tổ chức lớn nhất mở hộp thư' },
  insert: { en: 'New ticket arrives', vi: 'Có ticket mới' },
  import: { en: 'Closed history import', vi: 'Nhập lịch sử đã đóng' },
  peak: { en: 'Monday peak, cache tight', vi: 'Cao điểm thứ Hai, cache chật' },
};

export function mount(root, ctx) {
  const H = 370;
  return player(root, ctx, {
    situations: SITUATIONS.map(x => ({ value: x, label: tx(SITUATION[x]), icon: { small: 'user', big: 'building', insert: 'mail', import: 'inbox', peak: 'memory' }[x] })),
    setups: SETUPS.map(x => ({ value: x, label: tx(LABEL[x]), icon: { today: 'list', partial: 'filter', composite: 'db', covering: 'layers', replica: 'copy' }[x] })),
    initial: { situation: 'big' },
    run, survives, height: H,
    duration: st => st.act.scan ? Math.min(4, 0.6 + st.act.scan.length * 0.035) : st.act.insert ? 1.4 : 1,
    tone: st => st.kind === 'bad' ? 'bad' : st.kind === 'wait' ? 'warn' : null,
    draw: frame => draw(frame, ctx.state.setup ?? 'today', ctx.state.situation ?? 'big'),
  });
}

/* ---------------- drawing ---------------- */

const ORG_COLOR = { big: 'blue', small: 'violet', other: 'surface2', imported: 'cat-queue' };
const ease = p => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

function draw({ g, w, h, result, k, p, moving }, setup, situation) {
  const { steps } = result;
  const n = steps.length;
  const indexes = indexesOf(setup);
  const fresh = NEW[setup];
  g.clearRect(0, 0, w, h);
  g.textBaseline = 'middle';

  // Everything done before step k, plus step k in progress.
  const doneActs = steps.slice(0, Math.min(k, n)).map(s => s.act);
  const cur = k < n ? steps[k] : null;
  const prog = moving ? ease(p) : 0;
  const query = [...doneActs, cur?.act].filter(Boolean).map(a => a.query).filter(Boolean).at(-1);
  const using = [...doneActs, cur?.act].filter(Boolean).map(a => a.use).filter(Boolean).at(-1);
  const evicted = doneActs.some(a => a.evict) || (cur?.act.evict && moving);
  const result2 = doneActs.map(a => a.result && a).filter(Boolean).at(-1);

  // Layout: the banner, the index panel on the left, the table on the right.
  const top = 46, left = Math.min(330, w * 0.36), gx = left + 22;
  const cell = Math.max(6, Math.floor(Math.min((w - gx - 12) / COLS, (h - top - 56) / ROWS)));
  const gy = top + 22;
  const at = i => [gx + (i % COLS) * cell, gy + Math.floor(i / COLS) * cell];

  // Banner: the statement being run, and its outcome.
  g.fillStyle = css('bg2'); g.beginPath(); g.roundRect(8, 6, w - 16, 30, 8); g.fill();
  g.font = '12px "IBM Plex Mono", monospace'; g.textAlign = 'left'; g.fillStyle = css(query ? 'text' : 'faint');
  const resW = result2 ? 130 : 0;
  g.fillText(query || tx({ en: 'waiting for the next statement…', vi: 'đang chờ câu lệnh tiếp theo…' }), 18, 21, w - 40 - resW);
  if (result2) {
    g.font = '700 13px "Hanken Grotesk", sans-serif'; g.textAlign = 'right'; g.fillStyle = css(result2.tone);
    g.fillText(result2.result, w - 18, 21, resW);
  }

  // Which rows exist: the table, plus anything inserted so far (sliding in while it lands).
  const inserted = new Map();
  for (const a of doneActs) if (a.insert) for (const i of a.insert) inserted.set(i, { open: a.open, t: 1 });
  if (cur?.act.insert && moving) cur.act.insert.forEach((i, j) => inserted.set(i, { open: cur.act.open, t: Math.max(0, Math.min(1, prog * 1.6 - j * 0.03)) }));
  const rowOf = i => (i < FILLED ? CELLS[i] : inserted.has(i) ? { org: situation === 'import' ? 'imported' : 'small', open: inserted.get(i).open } : null);

  // Rows visited by reads: done scans fully, the current one up to its progress.
  const visited = new Map();
  for (const a of doneActs) if (a.scan) for (const i of a.scan) visited.set(i, a.heap ? 'warn' : a.tone);
  let cursor = null;
  if (cur?.act.scan && moving) {
    const m = Math.ceil(cur.act.scan.length * prog);
    cur.act.scan.slice(0, m).forEach(i => visited.set(i, cur.act.heap ? 'warn' : cur.act.tone));
    cursor = cur.act.scan[Math.max(0, m - 1)];
  }

  // The table.
  g.font = '600 10.5px "IBM Plex Mono", monospace'; g.textAlign = 'left'; g.fillStyle = css('pink');
  g.fillText(tx({ en: 'TABLE tickets · each cell ≈ many rows (not to scale)', vi: 'BẢNG tickets · mỗi ô ≈ nhiều dòng (không theo tỉ lệ)' }), gx, gy - 11, w - gx - 10);
  for (let i = 0; i < COLS * ROWS; i++) {
    const row = rowOf(i), [x, y] = at(i), s = cell - 2;
    if (!row) { g.strokeStyle = css('line'); g.setLineDash([2, 3]); g.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1); g.setLineDash([]); continue; }
    const fall = inserted.has(i) ? inserted.get(i).t : 1;
    if (fall <= 0) continue;
    const yy = y - (1 - fall) * 30;
    g.globalAlpha = (evicted && i < FILLED && (i * 7) % 5 < 2 ? 0.25 : 1) * fall;
    g.fillStyle = css(ORG_COLOR[row.org]);
    g.globalAlpha *= row.org === 'other' ? 1 : 0.55;
    g.beginPath(); g.roundRect(x, yy, s, s, 2); g.fill();
    g.globalAlpha = fall;
    if (row.open) { g.strokeStyle = css('ok'); g.lineWidth = 1.6; g.beginPath(); g.roundRect(x + 0.8, yy + 0.8, s - 1.6, s - 1.6, 2); g.stroke(); g.lineWidth = 1; }
    // Rows the new index covers carry its mark.
    if (fresh && (fresh.cover === 'all' || row.open) && fall >= 1) {
      g.fillStyle = css('cat-caching'); g.beginPath(); g.arc(x + s - 3.5, yy + 3.5, 1.9, 0, Math.PI * 2); g.fill();
    }
    const v = visited.get(i);
    if (v) { g.strokeStyle = css(v); g.lineWidth = 2; g.strokeRect(x - 1, yy - 1, s + 2, s + 2); g.lineWidth = 1; }
    g.globalAlpha = 1;
  }
  if (evicted) {
    g.font = '700 11px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.fillStyle = css('bad');
    g.fillText(tx({ en: 'hot pages evicted from cache', vi: 'trang nóng bị đẩy khỏi cache' }), gx + (COLS * cell) / 2, gy + ROWS * cell + 12);
  }

  // The index panel: every index, what it covers, and the writes it received.
  const writes = new Map(), skips = new Set();
  for (const a of [...doneActs, moving ? cur?.act : null].filter(Boolean)) { if (a.write) writes.set(a.write, a.n); if (a.skip) skips.add(a.skip); }
  const rowH = 46, iy0 = top + 22;
  g.font = '600 10.5px "IBM Plex Mono", monospace'; g.textAlign = 'left'; g.fillStyle = css('cat-caching');
  g.fillText(tx({ en: setup === 'replica' ? 'INDEXES · same on the replica' : 'INDEXES', vi: setup === 'replica' ? 'INDEX · replica có y hệt' : 'INDEX' }), 10, iy0 - 11, left - 14);
  const cardY = {};
  indexes.forEach((ix, j) => {
    const y = iy0 + j * (rowH + 6), x = 8, wd = left - 8;
    cardY[ix.name] = y + rowH / 2;
    const inUse = using === ix.name;
    const writing = cur && moving && (cur.act.write === ix.name || cur.act.skip === ix.name);
    const color = ix.fresh ? 'cat-caching' : 'muted';
    g.save();
    const glow = cur?.act.skip === ix.name ? 'ok' : ix.fresh ? 'cat-caching' : 'blue';
    if (inUse || writing) { g.shadowColor = css(glow); g.shadowBlur = 16; }
    g.fillStyle = css('surface2'); g.beginPath(); g.roundRect(x, y, wd, rowH, 9); g.fill();
    g.restore();
    g.strokeStyle = css(inUse || writing ? glow : ix.fresh ? 'cat-caching' : 'line');
    g.lineWidth = inUse || writing ? 2 : 1; g.beginPath(); g.roundRect(x, y, wd, rowH, 9); g.stroke(); g.lineWidth = 1;
    g.font = `${ix.fresh ? 700 : 600} 11px "IBM Plex Mono", monospace`; g.textAlign = 'left'; g.fillStyle = css(ix.fresh ? 'text' : 'muted');
    g.fillText(ix.name, x + 10, y + 15, wd - 96);
    g.font = '10.5px "IBM Plex Mono", monospace'; g.fillStyle = css('faint');
    g.fillText(ix.key, x + 10, y + 32, wd - 96);
    // Coverage tag, or what just happened to it.
    const tag = skips.has(ix.name) ? [tx({ en: 'skipped', vi: 'bỏ qua' }), 'ok']
      : writes.has(ix.name) ? [writes.get(ix.name), situation === 'import' && ix.fresh ? 'bad' : 'blue']
      : ix.cover === 'open' ? [tx({ en: 'open only', vi: 'chỉ ticket mở' }), 'ok'] : [tx({ en: 'all rows', vi: 'mọi dòng' }), color];
    g.font = '700 10.5px "IBM Plex Mono", monospace';
    const tw = g.measureText(tag[0]).width + 14;
    g.fillStyle = css(tag[1]); g.globalAlpha = 0.16; g.beginPath(); g.roundRect(x + wd - tw - 8, y + 13, tw, 20, 10); g.fill(); g.globalAlpha = 1;
    g.textAlign = 'center'; g.fillStyle = css(tag[1]); g.fillText(tag[0], x + wd - tw / 2 - 8, y + 23.5);
  });

  // The new index's size against the spare cache.
  if (fresh) {
    const y = iy0 + indexes.length * (rowH + 6) + 12, x = 10, barW = left - 20;
    const over = fresh.mb > SPARE_MB, loaded = doneActs.some(a => a.load) || (cur?.act.load && moving);
    g.font = '10.5px "IBM Plex Mono", monospace'; g.textAlign = 'left'; g.fillStyle = css(over ? 'bad' : 'muted');
    g.fillText(tx({ en: `${fresh.name}: ${fmtMb(fresh.mb)} · spare cache 2 GB`, vi: `${fresh.name}: ${fmtMb(fresh.mb)} · cache trống 2 GB` }), x, y, barW);
    g.fillStyle = css('line'); g.beginPath(); g.roundRect(x, y + 12, barW, 8, 4); g.fill();
    g.fillStyle = css(over ? 'bad' : 'ok'); g.globalAlpha = loaded || situation !== 'peak' ? 1 : 0.4;
    g.beginPath(); g.roundRect(x, y + 12, Math.max(5, barW * Math.min(1, fresh.mb / SPARE_MB)), 8, 4); g.fill(); g.globalAlpha = 1;
    if (over) { g.font = '700 10.5px "IBM Plex Mono", monospace'; g.textAlign = 'right'; g.fillStyle = css('bad'); g.fillText(tx({ en: `${(fresh.mb / SPARE_MB).toFixed(1)}× the spare cache`, vi: `gấp ${(fresh.mb / SPARE_MB).toFixed(1)} lần cache trống` }), x + barW, y + 32); }
  }

  // Pointers: from the index in use to the row it is visiting, and from new rows to
  // the index receiving their entries.
  const centre = i => { const [x, y] = at(i); return [x + (cell - 2) / 2, y + (cell - 2) / 2]; };
  const pointer = (from, to, color) => {
    g.save(); g.strokeStyle = css(color); g.globalAlpha = 0.85; g.lineWidth = 1.6; g.setLineDash([5, 4]);
    g.lineDashOffset = -(performance.now() / 40) % 9;
    g.beginPath(); g.moveTo(...from); g.bezierCurveTo(from[0] + 60, from[1], to[0] - 60, to[1], ...to); g.stroke();
    g.setLineDash([]); g.fillStyle = css(color); g.beginPath(); g.arc(to[0], to[1], 3, 0, Math.PI * 2); g.fill(); g.restore();
  };
  if (cursor != null && using && cardY[using] != null) pointer([left, cardY[using]], centre(cursor), cur.act.heap ? 'warn' : cur.act.tone === 'bad' ? 'bad' : 'cat-caching');
  if (cur && moving && (cur.act.write || cur.act.skip)) {
    const rows = situation === 'import' ? IMPORTED : INSERTED;
    const mid = centre(rows[Math.floor(rows.length / 2)]);
    const target = [left, cardY[cur.act.write || cur.act.skip]];
    if (cur.act.write) {
      pointer(mid, target, situation === 'import' && cur.kind === 'bad' ? 'bad' : 'blue');
      // An entry travelling from the new rows to the index.
      const t = prog, x = mid[0] + (target[0] - mid[0]) * t, y = mid[1] + (target[1] - mid[1]) * t;
      g.fillStyle = css(cur.kind === 'bad' ? 'bad' : 'blue'); g.beginPath(); g.roundRect(x - 9, y - 6, 18, 12, 3); g.fill();
    }
  }

  // Legend.
  const ly = gy + ROWS * cell + 30;
  if (ly < h - 4) {
    const items = [['blue', tx({ en: 'largest org', vi: 'tổ chức lớn nhất' })], ['violet', tx({ en: 'small org', vi: 'tổ chức nhỏ' })], ['surface2', tx({ en: 'other orgs', vi: 'tổ chức khác' })], ...(situation === 'import' ? [['cat-queue', tx({ en: 'imported', vi: 'được nhập' })]] : [])];
    // Swatches wrap onto a second line when the canvas is narrow.
    let x = gx, y = ly;
    g.font = '11px "Hanken Grotesk", sans-serif'; g.textAlign = 'left';
    const item = (label, swatch) => {
      const wd = g.measureText(label).width + 30;
      if (x + wd > w - 6 && x > gx) { x = gx; y += 17; }
      swatch(x, y);
      g.fillStyle = css('muted'); g.fillText(label, x + 14, y); x += wd;
    };
    for (const [c, label] of items) item(label, (x0, y0) => { g.fillStyle = css(c); g.globalAlpha = c === 'surface2' ? 1 : 0.55; g.fillRect(x0, y0 - 5, 10, 10); g.globalAlpha = 1; });
    item(tx({ en: 'open ticket', vi: 'ticket đang mở' }), (x0, y0) => { g.strokeStyle = css('ok'); g.lineWidth = 1.6; g.strokeRect(x0, y0 - 5, 10, 10); g.lineWidth = 1; });
    if (fresh) item(tx({ en: 'in the new index', vi: 'nằm trong index mới' }), (x0, y0) => { g.fillStyle = css('cat-caching'); g.beginPath(); g.arc(x0 + 5, y0, 2.5, 0, Math.PI * 2); g.fill(); });
  }
}
