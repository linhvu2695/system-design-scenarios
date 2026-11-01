/* One merchant's payments in the index on (merchant_id, created_at DESC, id DESC), and a
   request finding its page in it. The index is drawn as a B-tree: a root, a row of
   branch pages, and the leaf pages in sort order along the strip. Under the leaves, the
   table, which a request visits for every row it fetches.

   A cursor goes down the tree straight to the last row the client saw and reads the next
   page. OFFSET is a count, not a place: it starts at the first leaf, reads every row
   before the page, and throws them away. Two situations show a whole page as one cell
   among millions of rows (shallow and deep). Two show single rows, five to a page, so
   you can see which payments the client gets: new payments arriving mid-export, and a
   payout batch that shares one timestamp.

   Timings come from a small illustrative cost model, not a benchmark. js/sim-player.js
   supplies the controls, clock, captions and scoreboard. */

import { tx } from '../../js/i18n.js';
import { css } from '../../js/sim-kit.js';
import { player } from '../../js/sim-player.js';

export const SETUPS = ['offset', 'deferred', 'stamp', 'cursor', 'oldest'];
export const SITUATIONS = ['shallow', 'deep', 'arrive', 'batch'];

export const PAGE = 100, TOTAL = 18_000_000, PAGES = TOTAL / PAGE;
export const DEPTH = { shallow: 3, deep: 150_000 };
export const BUDGET_MS = 150;
const OFFSETS = new Set(['offset', 'deferred', 'oldest']);

/* The illustrative cost model: a fixed cost per query in ms (planning, going down the
   tree, sending the page), then microseconds per index entry read and per table row
   fetched. */
const COST = { base: 1.5, entry: 0.08, row: 0.35 };
export const latencyMs = ({ entries, rows }) => COST.base + (entries * COST.entry + rows * COST.row) / 1000;

/* What one request for `page` reads. OFFSET reads every row before the page and throws
   it away; a deferred join reads those as index entries only; a cursor reads the page. */
export function work(setup, page) {
  const thrown = OFFSETS.has(setup) ? (page - 1) * PAGE : 0;
  return { entries: thrown + PAGE, rows: setup === 'deferred' ? PAGE : thrown + PAGE, thrown, kept: PAGE };
}
export const pageMs = (setup, page) => latencyMs(work(setup, page));

/* The strip of leaf pages for the shallow and deep situations: 60 cells of 300,000. */
export const CHUNKS = 60;
const chunkOf = page => Math.floor(((page - 1) * PAGE) / (TOTAL / CHUNKS));

/* The single-row situations, newest first, five to a page in the picture. */
export const SMALL = 5;
const rows = list => list.map(([id, t]) => ({ key: id, id, t }));
export const ARRIVING = rows(Array.from({ length: 15 }, (_, i) => [120 - i, `10:${String(20 - i).padStart(2, '0')}`]));
export const NEW_ROWS = rows([[123, '10:23'], [122, '10:22'], [121, '10:21']]);
export const BATCH_IDS = [216, 215, 214, 213, 212, 211, 210, 209, 208];
export const BATCH = rows([[230, '09:02'], [225, '09:01'], ...BATCH_IDS.map(id => [id, '09:00']),
  [205, '08:58'], [204, '08:57'], [203, '08:55'], [201, '08:54'], [200, '08:52']]);

const fmt = n => n.toLocaleString('en-US');
const fmtVi = n => n.toLocaleString('en-US').replace(/,/g, '.');
export const fmtMs = ms => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 10 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`);
const SELECT = 'SELECT … WHERE merchant_id = 42';
const DESC = 'ORDER BY created_at DESC, id DESC';
const ASC = 'ORDER BY created_at, id';
const TOKEN = 'eyJ0IjoiMjAyNi0w…';

/* Play one situation. Returns { steps, ok, summary, ms, received, dups, missing }.
   step: { label, kind, say: { en, vi }, act } where act is what the picture animates:
     { query, req, client }        a new request: the SQL on the banner, the API call
     { descend: key }              go down the tree to this leaf
     { walk: [keys], heap }        read these entries in order and throw them away
     { take: [keys], got }         read and return these rows
     { insert: [rows], strip }     new rows land in the index; strip is the new order
     { batch: [ids] }              rows written by one transaction
     { jump: [keys] }              rows a seek went past without reading
     { stats }                     what this request has read so far
     { result, tone, ms }          the outcome
   Pure, so the scoreboard is pinned by tests/keyset-pagination.test.js. */
export function run(setup, situation) {
  return situation === 'shallow' || situation === 'deep' ? onePage(setup, situation) : twoPages(setup, situation);
}

function onePage(setup, situation) {
  const steps = [];
  const step = (label, kind, en, vi, act = {}) => steps.push({ label, kind, say: { en, vi }, act });
  const dash = situation === 'shallow', page = DEPTH[situation];
  const asc = setup === 'oldest' && !dash;
  const offset = OFFSETS.has(setup);
  const w = work(setup, page), ms = latencyMs(w), c = chunkOf(page);
  const skip = (page - 1) * PAGE;
  const order = asc ? ASC : DESC;
  const query = setup === 'deferred'
    ? `SELECT p.* FROM payments p JOIN (SELECT id … ${order} LIMIT 100 OFFSET ${skip}) USING (id)`
    : offset ? `${SELECT} ${order} LIMIT 100 OFFSET ${skip}`
    : setup === 'stamp' ? `${SELECT} AND created_at < '2026-03-02 09:14:07' ${DESC} LIMIT 100`
    : `${SELECT} AND (created_at, id) < ('2026-03-02 09:14:07', 88412031) ${DESC} LIMIT 100`;
  const client = offset ? `GET /v1/payments?page=${page}` : `GET /v1/payments?cursor=${TOKEN}`;
  const zero = { entries: 0, rows: 0, thrown: 0, kept: 0 };

  step(offset ? `?page=${fmt(page)}` : '?cursor=…', 'call',
    dash ? `A support agent opens the merchant’s payments in the dashboard and clicks through to page ${page}: ${client}.`
      : `The nightly accounting export has been walking this merchant’s 18 million payments${asc ? ', oldest first,' : ''} for hours. Now it asks for page ${fmt(page)}: ${client}.`,
    dash ? `Một nhân viên hỗ trợ mở danh sách thanh toán của merchant trên dashboard và bấm tới trang ${page}: ${client}.`
      : `Bản export kế toán hằng đêm đã duyệt qua 18 triệu thanh toán của merchant này${asc ? ', từ cũ nhất,' : ''} suốt mấy tiếng. Giờ nó xin trang ${fmtVi(page)}: ${client}.`,
    { query, req: 1, client, stats: zero });

  if (offset) {
    step('SEEK first row', 'note',
      `The database goes down the index to the merchant’s ${asc ? 'oldest' : 'newest'} payment. OFFSET is a count, not a place, so it can only start at the first row and count from there.`,
      `Database đi xuống index tới thanh toán ${asc ? 'cũ nhất' : 'mới nhất'} của merchant. OFFSET là một con số đếm, không phải một vị trí, nên nó chỉ có thể bắt đầu từ dòng đầu tiên rồi đếm dần.`,
      { descend: 0, stats: zero });
    const heap = setup !== 'deferred';
    const kind = ms > BUDGET_MS ? 'bad' : 'note';
    step(`SKIP ${fmt(skip)}`, kind,
      heap ? `It reads ${fmt(skip)} index entries in order, fetches each one’s row from the table, and throws them all away. ${dash ? 'At this depth that is nothing.' : 'This is where the time goes.'}`
        : `The inner query reads ${fmt(skip)} index entries without visiting the table (an index-only scan) and throws them away. Cheaper per row, but still one entry for every row it skips. ${dash ? 'At this depth that is nothing.' : ''}`.trim(),
      heap ? `Nó đọc ${fmtVi(skip)} mục index theo thứ tự, lấy dòng tương ứng của từng mục từ bảng, rồi vứt hết đi. ${dash ? 'Ở độ sâu này thì chẳng đáng là bao.' : 'Thời gian mất vào chính chỗ này.'}`
        : `Truy vấn bên trong đọc ${fmtVi(skip)} mục index mà không ghé bảng (index-only scan) rồi vứt chúng đi. Rẻ hơn cho mỗi dòng, nhưng vẫn là một mục cho mỗi dòng bị bỏ qua. ${dash ? 'Ở độ sâu này thì chẳng đáng là bao.' : ''}`.trim(),
      { walk: Array.from({ length: c }, (_, i) => i), heap, stats: { entries: skip, rows: heap ? skip : 0, thrown: skip, kept: 0 } });
    step('KEEP 100', 'ok',
      setup === 'deferred' ? 'The 100 ids that remain are joined back to the table for the full rows.' : 'Only then does it keep the next 100 rows.',
      setup === 'deferred' ? '100 id còn lại được join ngược về bảng để lấy dòng đầy đủ.' : 'Chỉ sau đó nó mới giữ lại 100 dòng tiếp theo.',
      { take: [c], stats: w });
  } else {
    step('SEEK cursor', 'ok',
      `The cursor holds the ${setup === 'stamp' ? 'created_at' : 'created_at and id'} of the last row the client saw. The database goes down the index straight to that spot: three or four index pages, at any depth.`,
      `Cursor giữ ${setup === 'stamp' ? 'created_at' : 'created_at và id'} của dòng cuối cùng client đã thấy. Database đi xuống index thẳng tới chỗ đó: ba bốn trang index, ở bất kỳ độ sâu nào.`,
      { descend: c, stats: zero });
    step('READ 100', 'ok', 'It reads the next 100 entries and their rows, and stops.', 'Nó đọc 100 mục tiếp theo cùng các dòng của chúng, rồi dừng.', { take: [c], stats: w });
  }

  const ok = ms <= BUDGET_MS;
  step(`100 rows · ${fmtMs(ms)}`, ok ? 'ok' : 'bad',
    ok ? `Page ${fmt(page)} comes back in ${fmtMs(ms)}.` : `Page ${fmt(page)} comes back after ${fmtMs(ms)}, against a 150 ms budget. Every page after it is slower still.`,
    ok ? `Trang ${fmtVi(page)} trả về trong ${fmtMs(ms)}.` : `Trang ${fmtVi(page)} trả về sau ${fmtMs(ms)}, so với ngân sách 150 ms. Mọi trang sau nó còn chậm hơn nữa.`,
    { result: fmtMs(ms), tone: ok ? 'ok' : 'bad', ms, stats: w });

  const summary = ok ? { en: `Within budget: ${fmtMs(ms)} for page ${fmt(page)}.`, vi: `Đạt yêu cầu: ${fmtMs(ms)} cho trang ${fmtVi(page)}.` }
    : { en: `Broken: ${fmtMs(ms)} for one page at depth ${fmt(page)}, against 150 ms.`, vi: `Hỏng: ${fmtMs(ms)} cho một trang ở độ sâu ${fmtVi(page)}, so với 150 ms.` };
  return { steps, ok, summary, ms, received: [], dups: [], missing: [] };
}

function twoPages(setup, situation) {
  const steps = [];
  const step = (label, kind, en, vi, act = {}) => steps.push({ label, kind, say: { en, vi }, act });
  const asc = setup === 'oldest';
  const offset = OFFSETS.has(setup);
  const base = situation === 'arrive' ? ARRIVING : BATCH;
  let strip = asc ? [...base].reverse() : [...base];
  const original = strip.map(r => r.id);
  const ids = list => list.map(r => r.id);
  const order = asc ? ASC : DESC;
  const per = (thrown, rowsToo) => ({ entries: thrown + SMALL, rows: rowsToo ? thrown + SMALL : SMALL, thrown, kept: SMALL });

  // Page 1: every setup starts at the first row.
  const p1 = strip.slice(0, SMALL);
  const q1 = setup === 'deferred' ? `SELECT p.* … JOIN (SELECT id … ${order} LIMIT 5 OFFSET 0) USING (id)`
    : offset ? `${SELECT} ${order} LIMIT 5 OFFSET 0` : `${SELECT} ${DESC} LIMIT 5`;
  const list1 = ids(p1).join(', ');
  step('PAGE 1', 'call',
    `An export reads the merchant’s payments ${asc ? 'oldest' : 'newest'} first. Five rows to a page in this picture, 100 in production. Page 1: ${list1}.`,
    `Một bản export đọc các thanh toán của merchant từ ${asc ? 'cũ nhất' : 'mới nhất'}. Năm dòng mỗi trang trong hình này, 100 dòng ngoài thực tế. Trang 1: ${list1}.`,
    { query: q1, req: 1, client: offset ? 'GET /v1/payments?page=1' : 'GET /v1/payments', descend: p1[0].key, strip, stats: { entries: 0, rows: 0, thrown: 0, kept: 0 } });
  step(`GOT ${list1}`, 'ok', `It receives ${list1}${offset ? '' : ', and a cursor pointing at the last one'}.`, `Nó nhận ${list1}${offset ? '' : ', kèm một cursor trỏ vào dòng cuối'}.`,
    { take: ids(p1), got: { page: 1, ids: ids(p1), dups: [] }, stats: per(0, true) });

  if (situation === 'arrive') {
    const before = strip;
    strip = asc ? [...strip, ...[...NEW_ROWS].reverse()] : [...NEW_ROWS, ...strip];
    step('+3 NEW', 'note',
      asc ? 'Before it asks for page 2, three new payments arrive. Oldest first, they sort last, at the end of the list. The rows the export has not reached stay where they were.'
        : 'Before it asks for page 2, three new payments arrive. Newest first, they sort at the top of the list and push every other row down three places.',
      asc ? 'Trước khi nó xin trang 2, ba thanh toán mới tới. Sắp từ cũ nhất, chúng nằm ở cuối danh sách. Các dòng export chưa tới vẫn nằm nguyên chỗ cũ.'
        : 'Trước khi nó xin trang 2, ba thanh toán mới tới. Sắp từ mới nhất, chúng nằm ở đầu danh sách và đẩy mọi dòng khác xuống ba bậc.',
      { insert: NEW_ROWS.map(r => r.id), strip, from: before });
  } else {
    step('ONE TIMESTAMP', 'note',
      'Payments 216 to 208 were created by one payout job in one transaction. now() returns the time the transaction started, so all nine have created_at = 09:00, to the microsecond.',
      'Các thanh toán từ 216 tới 208 được tạo bởi một job chi trả trong một transaction. now() trả về thời điểm transaction bắt đầu, nên cả chín đều có created_at = 09:00, chính xác tới micro giây.',
      { batch: BATCH_IDS });
  }

  // Page 2.
  const last = p1.at(-1);
  const after = r => (setup === 'stamp' ? r.t < last.t : r.t < last.t || (r.t === last.t && r.id < last.id));
  const start = offset ? SMALL : strip.findIndex(after);
  const p2 = strip.slice(start, start + SMALL);
  const seen = new Set(ids(p1));
  const dups = ids(p2).filter(id => seen.has(id));
  const lastPos = original.indexOf(p2.at(-1).id);
  const received = [...ids(p1), ...ids(p2)];
  const missing = original.slice(0, lastPos + 1).filter(id => !received.includes(id));
  const q2 = setup === 'deferred' ? `SELECT p.* … JOIN (SELECT id … ${order} LIMIT 5 OFFSET 5) USING (id)`
    : offset ? `${SELECT} ${order} LIMIT 5 OFFSET 5`
    : setup === 'stamp' ? `${SELECT} AND created_at < '${last.t}' ${DESC} LIMIT 5`
    : `${SELECT} AND (created_at, id) < ('${last.t}', ${last.id}) ${DESC} LIMIT 5`;
  const client = offset ? 'GET /v1/payments?page=2' : `GET /v1/payments?cursor=${TOKEN}`;
  const top = ids(strip.slice(0, SMALL)).join(', ');

  if (offset) {
    step('PAGE 2 · OFFSET 5', 'call',
      `Page 2 is OFFSET 5: skip the first five rows, whatever they are now${situation === 'arrive' && !asc ? `. They are now ${top}` : ''}.`,
      `Trang 2 là OFFSET 5: bỏ qua năm dòng đầu, dù lúc này chúng là gì${situation === 'arrive' && !asc ? `. Giờ chúng là ${top}` : ''}.`,
      { query: q2, req: 2, client, descend: strip[0].key, stats: { entries: 0, rows: 0, thrown: 0, kept: 0 } });
    step(`SKIP ${top}`, 'note', `It reads ${top} and throws them away.`, `Nó đọc ${top} rồi vứt đi.`,
      { walk: ids(strip.slice(0, SMALL)), heap: setup !== 'deferred', stats: { entries: SMALL, rows: setup === 'deferred' ? 0 : SMALL, thrown: SMALL, kept: 0 } });
  } else {
    const jumped = ids(strip.slice(strip.indexOf(last) + 1, start));
    step('PAGE 2 · SEEK', jumped.length ? 'bad' : 'call',
      setup === 'stamp'
        ? `The cursor says created_at < ${last.t}. The database goes straight to the first row older than ${last.t}, which is ${strip[start].id}${jumped.length ? `, past ${jumped.length} rows of the batch the export has not seen` : ''}.`
        : `The cursor says (created_at, id) < (${last.t}, ${last.id}): an older time, or the same time and a smaller id. The database goes straight to ${strip[start].id}.`,
      setup === 'stamp'
        ? `Cursor nói created_at < ${last.t}. Database đi thẳng tới dòng đầu tiên cũ hơn ${last.t}, là ${strip[start].id}${jumped.length ? `, vượt qua ${jumped.length} dòng của lô mà export chưa thấy` : ''}.`
        : `Cursor nói (created_at, id) < (${last.t}, ${last.id}): thời điểm cũ hơn, hoặc cùng thời điểm và id nhỏ hơn. Database đi thẳng tới ${strip[start].id}.`,
      { query: q2, req: 2, client, descend: strip[start].key, jump: jumped, stats: { entries: 0, rows: 0, thrown: 0, kept: 0 } });
  }
  const list2 = ids(p2).join(', ');
  step(`GOT ${list2}`, dups.length ? 'bad' : 'ok',
    dups.length ? `It receives ${list2}. ${dups.join(', ')} were already on page 1.` : `It receives ${list2}.`,
    dups.length ? `Nó nhận ${list2}. ${dups.join(', ')} đã có ở trang 1.` : `Nó nhận ${list2}.`,
    { take: ids(p2), got: { page: 2, ids: ids(p2), dups }, stats: per(offset ? SMALL : 0, setup !== 'deferred') });

  const ok = !dups.length && !missing.length;
  const tail = BATCH.at(-1).id;
  step(ok ? 'EVERY ROW ONCE' : dups.length ? `${dups.length} TWICE` : `${missing.length} NEVER`, ok ? 'ok' : 'bad',
    ok ? 'Every payment arrives exactly once: no duplicates, no gaps.'
      : dups.length ? `${dups.length} payments arrive twice: ${dups.join(', ')}. The export double-counts them.`
      : `${missing.length} payments never arrive: ${missing.join(', ')}. The next cursor starts after ${tail}, so they are gone for good.`,
    ok ? 'Mọi thanh toán tới đúng một lần: không trùng, không sót.'
      : dups.length ? `${dups.length} thanh toán tới hai lần: ${dups.join(', ')}. Bản export tính chúng hai lần.`
      : `${missing.length} thanh toán không bao giờ tới: ${missing.join(', ')}. Cursor tiếp theo bắt đầu sau ${tail}, nên chúng mất hẳn.`,
    { result: ok ? tx({ en: 'each once', vi: 'mỗi dòng một lần' }) : dups.length ? `${dups.length} × 2` : `${missing.length} ${tx({ en: 'missing', vi: 'bị sót' })}`, tone: ok ? 'ok' : 'bad', missing });

  const summary = ok ? { en: 'Every payment exactly once.', vi: 'Mọi thanh toán đúng một lần.' }
    : dups.length ? { en: `Broken: the export received ${dups.length} payments twice.`, vi: `Hỏng: bản export nhận ${dups.length} thanh toán hai lần.` }
    : { en: `Broken: the export never received ${missing.length} payments.`, vi: `Hỏng: bản export không bao giờ nhận ${missing.length} thanh toán.` };
  return { steps, ok, summary, ms: null, received, dups, missing };
}

export const survives = (setup, situation) => run(setup, situation).ok;

const LABEL = {
  offset: { en: 'Today: ?page=N with OFFSET', vi: 'Hiện tại: ?page=N với OFFSET' },
  deferred: { en: 'Deferred join', vi: 'Deferred join' },
  stamp: { en: 'Cursor on created_at', vi: 'Cursor trên created_at' },
  cursor: { en: 'Cursor on (created_at, id)', vi: 'Cursor trên (created_at, id)' },
  oldest: { en: 'OFFSET, exports oldest first', vi: 'OFFSET, export từ cũ nhất' },
};
const SITUATION = {
  shallow: { en: 'Dashboard, page 3', vi: 'Dashboard, trang 3' },
  deep: { en: 'Export at page 150,000', vi: 'Export ở trang 150.000' },
  arrive: { en: 'New payments mid-export', vi: 'Thanh toán mới giữa lúc export' },
  batch: { en: 'Payout batch, one timestamp', vi: 'Lô chi trả, cùng một thời điểm' },
};

export function mount(root, ctx) {
  const { revealed } = ctx;
  const open = ['offset'];
  return player(root, ctx, {
    situations: SITUATIONS.map(x => ({ value: x, label: tx(SITUATION[x]), icon: { shallow: 'user', deep: 'hourglass', arrive: 'bolt', batch: 'copy' }[x], tone: x === 'shallow' ? 'ok' : undefined })),
    setups: SETUPS.map(x => ({ value: x, label: tx(LABEL[x]), icon: { offset: 'list', deferred: 'layers', stamp: 'filter', cursor: 'tag', oldest: 'replay' }[x] })),
    open,
    initial: { situation: 'deep' },
    run, survives, height: 560,
    duration: st => st.act.walk ? (st.act.walk.length > 20 ? 3.6 : st.act.walk.length ? 1.3 : 0.7) : st.act.insert ? 1.4 : st.act.descend != null ? 1.1 : 1,
    tone: st => st.kind === 'bad' ? 'bad' : null,
    draw: frame => draw(frame, ctx.state.setup ?? 'offset', ctx.state.situation ?? 'deep', v => revealed || open.includes(v)),
  });
}

/* ---------------- drawing ---------------- */

const ease = p => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const mono = (size, weight = 400) => `${weight} ${size}px "IBM Plex Mono", monospace`;
const sans = (size, weight = 400) => `${weight} ${size}px "Hanken Grotesk", sans-serif`;
function text(g, s, x, y, color, font, align = 'left', max) {
  g.font = font; g.textAlign = align; g.fillStyle = css(color);
  if (max) g.fillText(s, x, y, max); else g.fillText(s, x, y);
}
/* Text on a pill in the background colour, so it stays legible over chart lines. */
function pill(g, s, x, y, color, font, align) {
  g.font = font;
  const tw = g.measureText(s).width + 10, x0 = align === 'right' ? x - tw + 5 : align === 'center' ? x - tw / 2 : x - 5;
  g.fillStyle = css('bg'); g.globalAlpha = 0.85; g.beginPath(); g.roundRect(x0, y - 8, tw, 16, 4); g.fill(); g.globalAlpha = 1;
  text(g, s, x, y + 1, color, font, align);
}
const short = n => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1000)}k` : fmt(Math.round(n)));
const HEAP = 40;
const heapCell = key => (Math.imul(key + 3, 2654435761) >>> 0) % HEAP;

function draw({ g, w, h, result, k, p, moving }, setup, situation, visible) {
  const { steps } = result;
  const n = steps.length;
  const zoom = situation === 'arrive' || situation === 'batch';
  const asc = setup === 'oldest' && situation !== 'shallow';
  g.clearRect(0, 0, w, h);
  g.textBaseline = 'middle';

  const done = steps.slice(0, Math.min(k, n));
  const cur = k < n ? steps[k] : null;
  const prog = moving ? ease(p) : 0;
  const live = [...done, ...(cur ? [cur] : [])];
  const latest = f => live.map(s => s.act[f]).filter(v => v != null).at(-1);

  // Banner: the statement being run, and the outcome once there is one.
  const query = latest('query');
  const res = done.map(s => s.act).filter(a => a.result).at(-1);
  g.fillStyle = css('bg2'); g.beginPath(); g.roundRect(8, 6, w - 16, 30, 8); g.fill();
  const resW = res ? 110 : 0;
  text(g, query || '', 18, 21, 'text', mono(11), 'left', w - 40 - resW);
  if (res) text(g, res.result, w - 18, 21, res.tone, sans(13, 700), 'right', resW);

  // The leaf strip: cells in sort order. Single rows slide when new ones land.
  const sx = 12, sw = w - 24, sy = 160, ch = zoom ? 40 : 26;
  let items, xOf;
  if (zoom) {
    const strip = done.map(s => s.act.strip).filter(Boolean).at(-1) || steps[0].act.strip;
    const ins = cur?.act.insert && moving ? cur.act : null;
    items = ins ? ins.strip : strip;
    const cw = sw / Math.max(items.length, 18);
    const pos = (list, key) => list.findIndex(r => r.key === key);
    xOf = key => {
      const to = pos(items, key);
      if (!ins) return sx + to * cw;
      const from = pos(ins.from, key);
      return from < 0 ? sx + to * cw : sx + lerp(from, to, prog) * cw;
    };
    items.cw = cw;
  } else {
    items = Array.from({ length: CHUNKS }, (_, i) => ({ key: i }));
    const cw = sw / CHUNKS;
    xOf = key => sx + key * cw;
    items.cw = cw;
  }
  const cw = items.cw;

  // Marks, by key, from every act so far: walked (thrown away), taken, received before,
  // received twice, jumped over.
  const marks = new Map(), heapLit = new Map();
  let req = 0, walker = null, seek = null;
  for (const s of live) {
    const a = s.act, now = s === cur;
    const t = now ? (moving ? prog : 0) : 1;
    if (a.req) {
      req = a.req;
      for (const [key, m] of marks) marks.set(key, m === 'take' || m === 'dup' ? 'got' : m === 'jump' ? 'jump' : null);
    }
    if (a.descend != null) seek = { key: a.descend, t, req };
    if (a.walk) {
      const m = Math.ceil(a.walk.length * t);
      a.walk.slice(0, m).forEach(key => { marks.set(key, 'walk'); if (a.heap) heapLit.set(heapCell(key), 'warn'); });
      if (now && m) walker = a.walk[m - 1];
    }
    if (a.take && t > 0) for (const key of a.take) { marks.set(key, marks.get(key) === 'got' ? 'dup' : 'take'); heapLit.set(heapCell(key), 'ok'); }
    if (a.jump && t > 0.5) for (const key of a.jump) marks.set(key, 'jump');
  }

  // The tree: a root and four branch pages above the strip.
  text(g, tx({ en: 'INDEX (merchant_id, created_at DESC, id DESC)', vi: 'INDEX (merchant_id, created_at DESC, id DESC)' }), 12, 52, 'cat-caching', mono(10.5, 600), 'left', w * 0.6);
  text(g, tx({ en: 'B-tree: root → branch pages → leaf pages', vi: 'B-tree: gốc → trang nhánh → trang lá' }), w - 12, 52, 'faint', mono(10), 'right', w * 0.38);
  const root = [w / 2, 82], by = 122;
  const branchX = b => sx + (b + 0.5) * (sw / 4);
  const box = (x, y, wd, active, label) => {
    g.save();
    if (active) { g.shadowColor = css('cat-caching'); g.shadowBlur = 14; }
    g.fillStyle = css('surface2'); g.beginPath(); g.roundRect(x - wd / 2, y - 11, wd, 22, 6); g.fill();
    g.restore();
    g.strokeStyle = css(active ? 'cat-caching' : 'line'); g.lineWidth = active ? 2 : 1;
    g.beginPath(); g.roundRect(x - wd / 2, y - 11, wd, 22, 6); g.stroke(); g.lineWidth = 1;
    text(g, label, x, y + 1, active ? 'text' : 'muted', mono(9.5), 'center', wd - 8);
  };
  g.strokeStyle = css('line');
  for (let b = 0; b < 4; b++) {
    g.beginPath(); g.moveTo(root[0], root[1] + 11); g.lineTo(branchX(b), by - 11); g.stroke();
    const x0 = sx + b * (sw / 4), x1 = x0 + sw / 4;
    g.beginPath(); g.moveTo(branchX(b), by + 11); g.lineTo(x0 + 2, sy - 2); g.moveTo(branchX(b), by + 11); g.lineTo(x1 - 2, sy - 2); g.stroke();
  }
  // The seek path for the current request: root, then the branch, then the leaf.
  let path = null;
  if (seek && seek.req === req) {
    const lx = xOf(seek.key) + cw / 2;
    const b = Math.max(0, Math.min(3, Math.floor((lx - sx) / (sw / 4))));
    path = { pts: [[root[0], root[1] + 11], [branchX(b), by], [lx, sy - 2]], t: seek.t, b };
  }
  box(root[0], root[1], 70, path && path.t < 0.5, tx({ en: 'root', vi: 'gốc' }));
  for (let b = 0; b < 4; b++) box(branchX(b), by, Math.min(110, sw / 4 - 12), path && path.b === b && path.t >= 0.4 && path.t < 1, tx({ en: 'branch', vi: 'nhánh' }));
  if (path) {
    const [a, m, z] = path.pts, t = path.t;
    g.save(); g.strokeStyle = css('cat-caching'); g.lineWidth = 2.2; g.globalAlpha = t >= 1 ? 0.55 : 1;
    g.beginPath(); g.moveTo(...a);
    const p1 = Math.min(1, t * 2), p2 = Math.max(0, t * 2 - 1);
    g.lineTo(lerp(a[0], m[0], p1), lerp(a[1], m[1], p1));
    if (p2 > 0) g.lineTo(lerp(m[0], z[0], p2), lerp(m[1], z[1], p2));
    g.stroke();
    const head = p2 > 0 ? [lerp(m[0], z[0], p2), lerp(m[1], z[1], p2)] : [lerp(a[0], m[0], p1), lerp(a[1], m[1], p1)];
    if (t < 1) { g.fillStyle = css('cat-caching'); g.beginPath(); g.arc(...head, 5, 0, Math.PI * 2); g.fill(); }
    g.restore();
  }

  // The strip itself.
  const MARK = { walk: 'warn', take: 'ok', got: 'ok', dup: 'bad' };
  const batch = live.some(s => s.act.batch) ? new Set(BATCH_IDS) : null;
  for (const it of items) {
    const x = xOf(it.key), m = marks.get(it.key);
    const fresh = zoom && situation === 'arrive' && it.id > 120;
    let alpha = 1;
    if (fresh && cur?.act.insert && moving) alpha = prog;
    g.globalAlpha = alpha;
    g.fillStyle = css(m && m !== 'jump' ? MARK[m] : 'surface2');
    g.globalAlpha = alpha * (m === 'walk' ? 0.35 : m === 'got' ? 0.3 : m ? 0.75 : 1);
    g.beginPath(); g.roundRect(x + 1, sy, cw - 2, ch, 3); g.fill();
    g.globalAlpha = alpha;
    g.strokeStyle = css(m === 'jump' ? 'bad' : fresh ? 'warn' : batch?.has(it.id) ? 'violet' : 'line');
    g.lineWidth = m === 'jump' || fresh || batch?.has(it.id) ? 1.6 : 1;
    if (m === 'jump') g.setLineDash([3, 3]);
    g.beginPath(); g.roundRect(x + 1, sy, cw - 2, ch, 3); g.stroke();
    g.setLineDash([]); g.lineWidth = 1;
    if (zoom) {
      const tc = m === 'take' || m === 'dup' ? 'bg' : m === 'walk' ? 'faint' : 'text';
      text(g, String(it.id), x + cw / 2, sy + 14, tc, mono(cw < 30 ? 9.5 : 11, 700), 'center', cw - 3);
      text(g, it.t, x + cw / 2, sy + 29, m === 'take' || m === 'dup' ? 'bg' : 'faint', mono(cw < 30 ? 8 : 9.5), 'center', cw - 3);
      if (m === 'walk') { g.strokeStyle = css('warn'); g.beginPath(); g.moveTo(x + 4, sy + ch - 4); g.lineTo(x + cw - 4, sy + 4); g.stroke(); }
    }
    g.globalAlpha = 1;
  }
  if (walker != null) {
    const x = xOf(walker) + cw / 2;
    g.fillStyle = css('warn'); g.beginPath(); g.moveTo(x, sy - 3); g.lineTo(x - 6, sy - 12); g.lineTo(x + 6, sy - 12); g.closePath(); g.fill();
  }
  // Under the strip: which end is which, and the scale.
  const dir = asc ? tx({ en: 'oldest → newest', vi: 'cũ nhất → mới nhất' }) : tx({ en: 'newest → oldest', vi: 'mới nhất → cũ nhất' });
  text(g, `${tx({ en: 'leaf pages', vi: 'trang lá' })} · ${dir}`, sx, sy + ch + 11, 'faint', mono(10));
  text(g, zoom ? tx({ en: 'one cell = one payment · 5 per page here', vi: 'mỗi ô = một thanh toán · 5 mỗi trang ở đây' }) : tx({ en: 'one cell ≈ 300,000 payments · one page = 100', vi: 'mỗi ô ≈ 300.000 thanh toán · một trang = 100' }), sx + sw, sy + ch + 11, 'faint', mono(10), 'right', sw * 0.55);
  if (batch && zoom) {
    const inBatch = items.filter(it => batch.has(it.id));
    if (inBatch.length) {
      const x0 = Math.min(...inBatch.map(it => xOf(it.key))), x1 = Math.max(...inBatch.map(it => xOf(it.key))) + cw;
      g.strokeStyle = css('violet'); g.beginPath(); g.moveTo(x0 + 2, sy - 6); g.lineTo(x0 + 2, sy - 10); g.lineTo(x1 - 2, sy - 10); g.lineTo(x1 - 2, sy - 6); g.stroke();
      text(g, tx({ en: 'one transaction · 09:00', vi: 'một transaction · 09:00' }), (x0 + x1) / 2, sy - 18, 'violet', mono(9.5, 600), 'center');
    }
  }

  // The table: one cell per table page, lit when a request fetches a row from it.
  const hy = sy + ch + 30, hw = sw / HEAP;
  text(g, tx({ en: 'TABLE payments · lit when a row is fetched', vi: 'BẢNG payments · sáng khi một dòng được lấy ra' }), sx, hy - 2, 'pink', mono(10, 600));
  for (let i = 0; i < HEAP; i++) {
    const lit = heapLit.get(i);
    g.fillStyle = css(lit || 'surface2'); g.globalAlpha = lit ? 0.7 : 1;
    g.beginPath(); g.roundRect(sx + i * hw + 1, hy + 8, hw - 2, 12, 2); g.fill();
    g.globalAlpha = 1;
  }

  // Bottom: the depth chart or what the export received, and this request's numbers.
  const top = hy + 38, split = Math.max(260, w * 0.58);
  const narrow = w < 560;
  const left = { x: 8, y: top, w: narrow ? w - 16 : split - 16, h: narrow ? (h - top) * 0.48 : h - top - 8 };
  const right = narrow ? { x: 8, y: left.y + left.h + 8, w: w - 16, h: h - left.y - left.h - 16 } : { x: split, y: top, w: w - split - 8, h: h - top - 8 };
  if (zoom) received(g, left, live, cur, moving, prog);
  else depthChart(g, left, setup, situation, visible, res);
  numbers(g, right, live, cur, moving, prog, zoom ? null : res, !zoom);
}

/* Latency against page number for every setup the visitor may see, on a log scale. */
function depthChart(g, r, setup, situation, visible, res) {
  const { x, y, w, h } = r;
  text(g, tx({ en: 'TIME FOR ONE PAGE, BY HOW DEEP IT IS', vi: 'THỜI GIAN CHO MỘT TRANG, THEO ĐỘ SÂU' }), x + 4, y + 6, 'muted', mono(10, 600), 'left', w);
  const px = x + 44, pw = w - 56, py = y + 22, ph = h - 46;
  const lo = 0, hi = 4; // log10 ms: 1 ms .. 10 s
  const X = page => px + (page / PAGES) * pw;
  const Y = ms => py + ph - ((Math.log10(Math.max(1, ms)) - lo) / (hi - lo)) * ph;
  g.strokeStyle = css('line');
  for (let d = lo; d <= hi; d++) {
    g.globalAlpha = 0.6; g.beginPath(); g.moveTo(px, Y(10 ** d)); g.lineTo(px + pw, Y(10 ** d)); g.stroke(); g.globalAlpha = 1;
    text(g, ['1 ms', '10 ms', '100 ms', '1 s', '10 s'][d], px - 6, Y(10 ** d), 'faint', mono(9.5), 'right');
  }
  for (const page of [0, 50_000, 100_000, 150_000]) text(g, page ? `${page / 1000}k` : '1', X(page), py + ph + 12, 'faint', mono(9.5), 'center');
  text(g, tx({ en: 'page', vi: 'trang' }), px + pw, py + ph + 12, 'faint', mono(9.5), 'right');
  // The budget.
  g.save(); g.strokeStyle = css('bad'); g.setLineDash([5, 4]);
  g.beginPath(); g.moveTo(px, Y(BUDGET_MS)); g.lineTo(px + pw, Y(BUDGET_MS)); g.stroke(); g.restore();
  text(g, tx({ en: '150 ms budget', vi: 'ngân sách 150 ms' }), px + pw, Y(BUDGET_MS) - 8, 'bad', mono(9.5, 600), 'right');

  const groups = [
    { members: ['offset', 'oldest'], color: 'pink', label: 'OFFSET' },
    { members: ['deferred'], color: 'violet', label: tx({ en: 'deferred join', vi: 'deferred join' }) },
    { members: ['stamp', 'cursor'], color: 'blue', label: tx({ en: 'cursor', vi: 'cursor' }) },
  ];
  for (const grp of groups) {
    if (!grp.members.some(visible)) continue;
    const mine = grp.members.includes(setup);
    const f = page => pageMs(grp.members[0], page);
    g.save(); g.strokeStyle = css(grp.color); g.lineWidth = mine ? 2.6 : 1.4; g.globalAlpha = mine ? 1 : 0.5;
    g.beginPath();
    for (let i = 0; i <= 120; i++) { const page = 1 + (i / 120) * (PAGES - 1); i ? g.lineTo(X(page), Y(f(page))) : g.moveTo(X(page), Y(f(page))); }
    g.stroke(); g.restore();
    const ly = Math.max(py + 8, Math.min(py + ph - 8, Y(f(PAGES)) - 9));
    pill(g, grp.label, px + pw - 2, ly, grp.color, mono(10, 700), 'right');
    // Where the budget is crossed.
    const cross = !OFFSETS.has(grp.members[0]) ? null : Math.ceil(((BUDGET_MS - COST.base) * 1000) / (grp.members[0] === 'deferred' ? COST.entry : COST.entry + COST.row) / PAGE);
    if (cross && cross < PAGES && mine) {
      g.fillStyle = css(grp.color); g.beginPath(); g.arc(X(cross), Y(BUDGET_MS), 3.5, 0, Math.PI * 2); g.fill();
      pill(g, tx({ en: `over budget from page ~${short(cross)}`, vi: `vượt ngân sách từ trang ~${short(cross)}` }), X(cross) + 9, Y(BUDGET_MS) + 12, grp.color, mono(9.5), 'left');
    }
  }
  // This run's page, once it has come back.
  if (res) {
    const page = DEPTH[situation];
    const cx = X(page), cy = Y(res.ms);
    g.fillStyle = css(res.tone); g.beginPath(); g.arc(cx, cy, 6, 0, Math.PI * 2); g.fill();
    g.strokeStyle = css('bg'); g.lineWidth = 2; g.stroke(); g.lineWidth = 1;
    const label = tx({ en: `page ${short(page)} · ${fmtMs(res.ms)}`, vi: `trang ${short(page)} · ${fmtMs(res.ms)}` });
    const right = cx < px + pw * 0.6;
    pill(g, label, cx + (right ? 12 : -12), cy + (cy > py + ph - 20 ? -14 : cy < py + 24 ? 16 : -14), res.tone, mono(10.5, 700), right ? 'left' : 'right');
  }
}

/* The pages the export has received, with repeats in red and, at the end, the
   payments it never got. */
function received(g, r, live, cur, moving, prog) {
  const { x, y, w } = r;
  text(g, tx({ en: 'WHAT THE EXPORT HAS RECEIVED', vi: 'NHỮNG GÌ BẢN EXPORT ĐÃ NHẬN' }), x + 4, y + 6, 'muted', mono(10, 600), 'left', w);
  const pages = live.filter(s => s.act.got && (s !== cur || moving)).map(s => ({ ...s.act.got, t: s === cur ? prog : 1 }));
  const cwd = Math.min(46, (w - 70) / 5 - 6);
  pages.forEach((pg, j) => {
    const yy = y + 34 + j * 38;
    text(g, tx({ en: `page ${pg.page}`, vi: `trang ${pg.page}` }), x + 4, yy, 'faint', mono(10.5));
    pg.ids.forEach((id, i) => {
      const xx = x + 60 + i * (cwd + 6);
      const dup = pg.dups.includes(id);
      g.globalAlpha = Math.max(0, Math.min(1, pg.t * 5 - i * 0.6));
      g.fillStyle = css(dup ? 'bad' : 'ok'); g.globalAlpha *= dup ? 0.9 : 0.25;
      g.beginPath(); g.roundRect(xx, yy - 12, cwd, 24, 6); g.fill();
      g.globalAlpha = Math.max(0, Math.min(1, pg.t * 5 - i * 0.6));
      text(g, String(id), xx + cwd / 2, yy + 1, dup ? 'bg' : 'text', mono(11, 700), 'center');
      g.globalAlpha = 1;
    });
    if (pg.dups.length && pg.t >= 1) text(g, tx({ en: 'again', vi: 'lặp lại' }), x + 60 + 5 * (cwd + 6), yy, 'bad', mono(10, 700), 'left');
  });
  const end = live.find(s => s.act.missing && s !== cur);
  if (end && end.act.missing.length) {
    const yy = y + 34 + 2 * 38;
    text(g, tx({ en: 'never', vi: 'không tới' }), x + 4, yy, 'bad', mono(10.5, 700));
    end.act.missing.forEach((id, i) => {
      const xx = x + 60 + i * (cwd + 6);
      if (xx + cwd > x + w) return;
      g.save(); g.strokeStyle = css('bad'); g.setLineDash([3, 3]); g.lineWidth = 1.4;
      g.beginPath(); g.roundRect(xx, yy - 12, cwd, 24, 6); g.stroke(); g.restore();
      text(g, String(id), xx + cwd / 2, yy + 1, 'bad', mono(11, 700), 'center');
    });
  }
}

/* This request: the API call, what it read, what it threw away, and its time. */
function numbers(g, r, live, cur, moving, prog, res, timed) {
  const { x, y, w, h } = r;
  g.fillStyle = css('surface2'); g.beginPath(); g.roundRect(x, y, w, h, 10); g.fill();
  g.strokeStyle = css('line'); g.stroke();
  const client = live.map(s => s.act.client).filter(Boolean).at(-1) || '';
  text(g, tx({ en: 'THIS REQUEST', vi: 'REQUEST NÀY' }), x + 12, y + 16, 'muted', mono(10, 600));
  text(g, client, x + 12, y + 34, 'blue', mono(10.5, 600), 'left', w - 24);
  // Interpolate from the previous step's numbers to this one's while it plays.
  const withStats = live.filter(s => s.act.stats && (s !== cur || moving));
  const now = withStats.at(-1)?.act.stats || { entries: 0, rows: 0, thrown: 0, kept: 0 };
  const prev = cur && moving && withStats.at(-1) === cur && !cur.act.req ? withStats.at(-2)?.act.stats || now : now;
  const t = cur && moving && withStats.at(-1) === cur ? prog : 1;
  const v = f => lerp(prev[f], now[f], t);
  const lines = [
    [tx({ en: 'index entries read', vi: 'mục index đã đọc' }), v('entries'), 'text'],
    [tx({ en: 'table rows fetched', vi: 'dòng lấy từ bảng' }), v('rows'), 'text'],
    [tx({ en: 'read, then thrown away', vi: 'đọc rồi vứt đi' }), v('thrown'), v('thrown') > 0 ? 'warn' : 'text'],
    [tx({ en: 'returned to the client', vi: 'trả về cho client' }), v('kept'), v('kept') ? 'ok' : 'text'],
  ];
  const rowH = Math.max(17, Math.min(24, (h - 96) / 4));
  lines.forEach(([label, val, color], i) => {
    const yy = y + 58 + i * rowH;
    text(g, label, x + 12, yy, 'muted', sans(12), 'left', w - 110);
    text(g, fmt(Math.round(val)), x + w - 12, yy, color, mono(12, 700), 'right', 96);
  });
  // Time, against the budget, on the same log scale as the chart.
  const yy = y + 58 + 4 * rowH + 6;
  if (!timed || yy + 22 > y + h) return;
  text(g, tx({ en: 'time', vi: 'thời gian' }), x + 12, yy, 'muted', sans(12));
  const bx = x + 60, bw = w - 72;
  g.fillStyle = css('line'); g.beginPath(); g.roundRect(bx, yy - 4, bw, 8, 4); g.fill();
  const at = ms => bx + Math.min(1, Math.log10(Math.max(1, ms)) / 4) * bw;
  g.strokeStyle = css('bad'); g.lineWidth = 2; g.beginPath(); g.moveTo(at(BUDGET_MS), yy - 8); g.lineTo(at(BUDGET_MS), yy + 8); g.stroke(); g.lineWidth = 1;
  if (res?.ms != null) {
    g.fillStyle = css(res.tone); g.beginPath(); g.roundRect(bx, yy - 4, Math.max(6, at(res.ms) - bx), 8, 4); g.fill();
    text(g, fmtMs(res.ms), x + w - 12, yy + 16, res.tone, mono(11, 700), 'right');
  }
  text(g, '150 ms', at(BUDGET_MS), yy + 16, 'bad', mono(9.5), 'center');
}
