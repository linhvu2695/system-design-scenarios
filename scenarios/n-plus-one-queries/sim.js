/* One page of the ticket queue, loaded five ways.

   On the left is the page the agent sees: 8 tickets (the real page has 100), each
   waiting for its assignee and its tags. Every query the app sends travels to Postgres
   as a box with its SQL, the table rows it reads light up, and the result comes back to
   fill in the page. Lazy loading sends one query per ticket per relation, one after
   another; batching sends one per relation for the whole page. A strip along the top
   adds up the database time against the page's budget.

   Two situations change the data first (automation adds a tag; an admin renames one),
   so caches and denormalized copies show what they cost.

   The model (run()) is a list of round trips on a virtual clock in milliseconds; the
   costs are illustrative, not measured. js/sim-player.js supplies the controls and
   scoreboard. */

import { tx } from '../../js/i18n.js';
import { css } from '../../js/sim-kit.js';
import { player } from '../../js/sim-player.js';
import { message, road, node, badge } from '../../js/sim-draw.js';

export const SETUPS = ['lazy', 'cache', 'join', 'batch', 'denorm'];
export const SITUATIONS = ['page', 'retag', 'rename'];

export const PAGE = 8;              // tickets on the simulated page (the real one has 100)
export const RTT = 1;               // ms for a round trip to Postgres
export const REDIS_RTT = 0.3;       // ms for a round trip to Redis
export const ROW = 0.02;            // ms to read and send one row
export const BUDGET = 8;            // ms of database time the page may spend
export const WRITE_BUDGET = 1000;   // rows a tag change may rewrite
export const RENAMED_ON = 2e6;      // tickets carrying the tag the admin renames
const GAP = 0.1;                    // ms the app spends between queries

export const AGENTS = { 412: 'Mai', 37: 'Tom', 58: 'Linh', 203: 'Sara', 91: 'Quân' };
const RULE_TAGS = Array.from({ length: 30 }, (_, i) => `rule-${String(i + 1).padStart(2, '0')}`);

/* The page's tickets, newest first. #88117 was handled by automation rules: 30 tags. */
export function tickets(situation) {
  const list = [
    { id: 88121, subj: { en: 'Refund not received', vi: 'Chưa nhận được hoàn tiền' }, agent: 412, tags: ['billing', 'refund'] },
    { id: 88119, subj: { en: 'Cannot log in', vi: 'Không đăng nhập được' }, agent: 37, tags: ['login', 'mobile'] },
    { id: 88117, subj: { en: 'Invoice export fails', vi: 'Xuất hoá đơn bị lỗi' }, agent: 58, tags: RULE_TAGS },
    { id: 88114, subj: { en: 'Change of plan', vi: 'Đổi gói dịch vụ' }, agent: 412, tags: ['billing'] },
    { id: 88112, subj: { en: 'API limit reached', vi: 'Chạm giới hạn API' }, agent: 203, tags: ['api', 'sla'] },
    { id: 88110, subj: { en: 'Dark mode request', vi: 'Yêu cầu chế độ tối' }, agent: 91, tags: [] },
    { id: 88108, subj: { en: 'Charged twice', vi: 'Bị trừ tiền hai lần' }, agent: 37, tags: ['billing', 'refund', 'vip'] },
    { id: 88105, subj: { en: 'App crashes on start', vi: 'Ứng dụng crash khi mở' }, agent: 58, tags: ['mobile', 'bug'] },
  ];
  if (situation === 'retag') list[1] = { ...list[1], tags: [...list[1].tags, 'urgent'] };
  if (situation === 'rename') return list.map(t => ({ ...t, tags: t.tags.map(x => (x === 'billing' ? 'payments' : x)) }));
  return list;
}

/* Run one situation. Returns the write (if any), every round trip with its timing, what
   it reads and what it fills in on the page, the page as it ends up, and the steps. Pure. */
export function run(setup, situation) {
  const now = tickets(situation), before = tickets('page');
  let t = 0;

  // A change to the tags first, in two of the situations.
  let write = null;
  if (situation === 'retag')
    write = { who: 'automation', sql: 'INSERT INTO ticket_tags (ticket_id, tag) VALUES (88119, \'urgent\')', short: '+ urgent → #88119', rows: setup === 'denorm' ? 2 : 1 };
  if (situation === 'rename')
    write = { who: 'admin', sql: setup === 'denorm' ? 'UPDATE tickets SET tag_names = replace(tag_names, \'billing\', \'payments\') WHERE …' : 'UPDATE tags SET name = \'payments\' WHERE name = \'billing\'', short: 'billing → payments', rows: setup === 'denorm' ? RENAMED_ON : 1 };
  if (write) { write.t0 = 0; write.t1 = write.rows > WRITE_BUDGET ? 6 : 1.6; t = write.t1 + 0.6; }
  const loadStart = t;

  const trips = [];
  const trip = (o) => {
    const dur = (o.to === 'redis' ? REDIS_RTT : RTT) + (o.rows || 0) * ROW;
    trips.push({ ...o, t0: t, t1: t + dur });
    t += dur + GAP;
  };
  const ids = now.map(x => x.id);
  const pageSql = 'SELECT * FROM tickets WHERE queue_id = 7 ORDER BY updated_at DESC LIMIT 8';
  const fillAll = field => now.map((_, i) => ({ i, field }));

  // What ends up on the page: each ticket's tags as shown, or missing tickets.
  let shown = now.map(x => ({ id: x.id, tags: x.tags, cut: 0, stale: false }));

  if (setup === 'lazy' || setup === 'cache') {
    trip({ to: 'db', short: 'tickets LIMIT 8', sql: pageSql, rows: PAGE, reads: { tickets: ids }, fills: fillAll('ticket') });
    now.forEach((x, i) => {
      if (setup === 'lazy') {
        trip({ to: 'db', short: `agent ${x.agent}`, sql: `SELECT * FROM agents WHERE id = ${x.agent}`, rows: 1, reads: { agents: [x.agent] }, fills: [{ i, field: 'agent' }], ticket: i });
        trip({ to: 'db', short: `tags of #${x.id}`, sql: `SELECT tags.* FROM tags JOIN ticket_tags … WHERE ticket_id = ${x.id}`, rows: x.tags.length, reads: { tags: [i] }, fills: [{ i, field: 'tags' }], ticket: i });
      } else {
        trip({ to: 'redis', short: `GET agent:${x.agent}`, sql: `GET agent:${x.agent}`, rows: 1, fills: [{ i, field: 'agent' }], ticket: i });
        trip({ to: 'redis', short: `GET tags:${x.id}`, sql: `GET tags:${x.id}`, rows: 1, fills: [{ i, field: 'tags' }], ticket: i });
      }
    });
    // The cache still holds tag lists from before the change (5-minute TTL).
    if (setup === 'cache') shown = now.map((x, i) => ({ id: x.id, tags: before[i].tags, cut: 0, stale: before[i].tags.join() !== x.tags.join() }));
  } else if (setup === 'batch') {
    const agents = [...new Set(now.map(x => x.agent))];
    trip({ to: 'db', short: 'tickets LIMIT 8', sql: pageSql, rows: PAGE, reads: { tickets: ids }, fills: fillAll('ticket') });
    trip({ to: 'db', short: `agents IN (${agents.length})`, sql: `SELECT * FROM agents WHERE id IN (${agents.join(', ')})`, rows: agents.length, reads: { agents }, fills: fillAll('agent') });
    trip({ to: 'db', short: 'tags IN (8 tickets)', sql: `SELECT … FROM ticket_tags JOIN tags … WHERE ticket_id IN (${ids.join(', ')})`, rows: now.reduce((s, x) => s + x.tags.length, 0), reads: { tags: now.map((_, i) => i) }, fills: fillAll('tags') });
  } else if (setup === 'join') {
    // One row per (ticket, tag), and LIMIT counts rows: it can stop part-way through a ticket.
    let rows = 0;
    shown = [];
    for (const x of now) {
      if (rows >= PAGE) break;
      const need = Math.max(1, x.tags.length), got = Math.min(need, PAGE - rows);
      shown.push({ id: x.id, tags: x.tags.slice(0, got), cut: need - got, stale: false });
      rows += got;
    }
    trip({ to: 'db', short: 'JOIN … LIMIT 8', sql: 'SELECT * FROM tickets JOIN agents … LEFT JOIN ticket_tags … JOIN tags … ORDER BY updated_at DESC LIMIT 8', rows,
      reads: { tickets: shown.map(s => s.id), agents: [...new Set(shown.map(s => now.find(x => x.id === s.id).agent))], tags: shown.map((_, i) => i), tagLimit: shown.map(s => s.tags.length) },
      fills: shown.flatMap((_, i) => [{ i, field: 'ticket' }, { i, field: 'agent' }, { i, field: 'tags' }]) });
  } else {
    trip({ to: 'db', short: 'tickets LIMIT 8', sql: 'SELECT id, subject, assignee_name, tag_names FROM tickets WHERE queue_id = 7 ORDER BY updated_at DESC LIMIT 8', rows: PAGE, reads: { tickets: ids }, fills: now.flatMap((_, i) => [{ i, field: 'ticket' }, { i, field: 'agent' }, { i, field: 'tags' }]) });
  }

  const loadMs = trips.reduce((s, x) => s + (x.t1 - x.t0), 0);
  const complete = shown.length === PAGE && shown.every(s => !s.cut);
  const current = shown.every(s => !s.stale);
  const fast = loadMs <= BUDGET;
  const ok = situation === 'page' ? complete && fast
    : situation === 'retag' ? complete && current
    : complete && current && write.rows <= WRITE_BUDGET;
  const end = t + 0.6;

  const res = { setup, situation, now, before, write, trips, shown, loadStart, loadMs, complete, current, fast, ok, end };
  res.steps = story(res);
  res.summary = ok ? { en: 'Within the constraints.', vi: 'Đạt các ràng buộc.' }
    : !complete ? { en: `Broken: the page shows ${shown.length} of ${PAGE} tickets${shown.some(s => s.cut) ? ', and one of them is missing tags' : ''}.`, vi: `Hỏng: trang hiện ${shown.length} / ${PAGE} ticket${shown.some(s => s.cut) ? ', và một ticket bị thiếu tag' : ''}.` }
    : !current ? { en: 'Broken: the page shows tags from before the change.', vi: 'Hỏng: trang hiện tag từ trước khi thay đổi.' }
    : write && write.rows > WRITE_BUDGET ? { en: `Broken: renaming one tag rewrote ${RENAMED_ON.toLocaleString('en')} ticket rows.`, vi: `Hỏng: đổi tên một tag phải ghi lại ${RENAMED_ON.toLocaleString('vi')} dòng ticket.` }
    : { en: `Broken: ${trips.length} round trips, ${loadMs.toFixed(1)} ms of database time; the budget is ${BUDGET} ms.`, vi: `Hỏng: ${trips.length} vòng mạng, ${loadMs.toFixed(1)} ms thời gian database; ngân sách là ${BUDGET} ms.` };
  return res;
}

export const survives = (setup, situation) => run(setup, situation).ok;

/* The captioned moments of a run, as player steps: { t0, t1, tone, say }. */
function story(r) {
  const { setup, situation, trips, write } = r;
  const m = [];
  const add = (t, tone, en, vi) => m.push({ t, tone, say: { en, vi } });

  if (situation === 'retag')
    add(0, null, setup === 'denorm' ? 'Automation adds the tag urgent to #88119, and rewrites the copy of tag names on the ticket row in the same transaction.' : 'Automation adds the tag urgent to #88119, a moment before the agent opens the queue.',
      setup === 'denorm' ? 'Automation thêm tag urgent vào #88119, và ghi lại bản sao tên tag trên dòng ticket trong cùng transaction.' : 'Automation thêm tag urgent vào #88119, ngay trước khi nhân viên mở hàng đợi.');
  if (situation === 'rename')
    add(0, setup === 'denorm' ? 'bad' : null,
      setup === 'denorm' ? 'An admin renames the tag billing to payments. With a copy of tag names on every ticket, that means rewriting every ticket that carries it: 2,000,000 rows, each locked while it changes.' : 'An admin renames the tag billing to payments. It sits on 2 million tickets, but every ticket points to the tag by id: one row changes.',
      setup === 'denorm' ? 'Một admin đổi tên tag billing thành payments. Khi mỗi ticket giữ một bản sao tên tag, việc đó nghĩa là ghi lại mọi ticket mang tag này: 2.000.000 dòng, dòng nào cũng bị khoá trong lúc đổi.' : 'Một admin đổi tên tag billing thành payments. Tag nằm trên 2 triệu ticket, nhưng mỗi ticket trỏ tới tag bằng id: chỉ một dòng thay đổi.');

  const first = trips[0];
  const at = (x) => x.t0;
  if (setup === 'lazy') {
    add(at(first), null, 'The page query: the 8 newest tickets. One round trip. The page now has its rows, but not their assignees or tags.', 'Truy vấn trang: 8 ticket mới nhất. Một vòng mạng. Trang đã có các dòng, nhưng chưa có người được giao hay tag.');
    add(at(trips[1]), null, 'The template reads ticket.assignee.name. The ORM has not loaded it, so it sends a query for that one agent: another round trip.', 'Template đọc ticket.assignee.name. ORM chưa tải nó, nên gửi một truy vấn cho đúng agent đó: thêm một vòng mạng.');
    add(at(trips[2]), null, 'Then the template loops over ticket.tags: one more query, for this ticket’s tags only.', 'Rồi template lặp qua ticket.tags: thêm một truy vấn nữa, chỉ cho tag của ticket này.');
    add(at(trips[3]), 'warn', 'The same two queries again for the next ticket, and the next. Each one is fast; the page waits for all of them, one after another.', 'Lại đúng hai truy vấn đó cho ticket tiếp theo, rồi ticket sau nữa. Từng cái đều nhanh; trang phải chờ tất cả, lần lượt từng cái một.');
    add(trips.at(-1).t1, r.fast ? null : 'bad', `1 + 2 × 8 = ${trips.length} round trips, ${r.loadMs.toFixed(1)} ms of database time. On the real page of 100 tickets it is 201.`, `1 + 2 × 8 = ${trips.length} vòng mạng, ${r.loadMs.toFixed(1)} ms thời gian database. Với trang thật 100 ticket là 201.`);
  } else if (setup === 'cache') {
    add(at(first), null, 'The page query goes to Postgres: the 8 newest tickets.', 'Truy vấn trang đi tới Postgres: 8 ticket mới nhất.');
    add(at(trips[1]), null, 'Each assignee and each tag list now comes from Redis: a quicker round trip, but still one per ticket per relation.', 'Mỗi người được giao và mỗi danh sách tag giờ lấy từ Redis: vòng mạng nhanh hơn, nhưng vẫn mỗi ticket một lần cho mỗi quan hệ.');
    const stale = r.shown.findIndex(s => s.stale);
    if (stale >= 0) add(trips.find(x => x.ticket === stale && x.short.startsWith('GET tags')).t1, 'bad', 'Redis still holds the tag list it cached before the change, so the page shows the old tags until the entry expires, up to 5 minutes.', 'Redis vẫn giữ danh sách tag đã cache trước khi thay đổi, nên trang hiện tag cũ cho tới khi entry hết hạn, tối đa 5 phút.');
    add(trips.at(-1).t1, null, `${trips.length} round trips, ${r.loadMs.toFixed(1)} ms. Fewer milliseconds, the same number of trips.`, `${trips.length} vòng mạng, ${r.loadMs.toFixed(1)} ms. Ít mili giây hơn, số vòng mạng vẫn vậy.`);
  } else if (setup === 'batch') {
    add(at(first), null, 'The page query: the 8 newest tickets, LIMIT 8 on the tickets themselves.', 'Truy vấn trang: 8 ticket mới nhất, LIMIT 8 đặt trên chính bảng tickets.');
    add(at(trips[1]), null, 'One query for every assignee on the page at once: WHERE id IN (…). Five agents, one round trip.', 'Một truy vấn cho mọi người được giao trên trang cùng lúc: WHERE id IN (…). Năm agent, một vòng mạng.');
    add(at(trips[2]), null, 'One query for every tag of all 8 tickets: WHERE ticket_id IN (…). The code hands each ticket its own tags, 30 of them for #88117.', 'Một truy vấn cho mọi tag của cả 8 ticket: WHERE ticket_id IN (…). Code chia cho mỗi ticket đúng tag của nó, 30 tag cho #88117.');
    add(trips.at(-1).t1, null, `3 round trips, ${r.loadMs.toFixed(1)} ms. A page of 100 tickets is still 3.`, `3 vòng mạng, ${r.loadMs.toFixed(1)} ms. Trang 100 ticket vẫn chỉ 3.`);
  } else if (setup === 'join') {
    add(at(first), null, 'One query joins tickets, agents and tags, with LIMIT 8. But LIMIT counts rows, and each tag of a ticket is its own row.', 'Một truy vấn join tickets, agents và tags, với LIMIT 8. Nhưng LIMIT đếm dòng, và mỗi tag của một ticket là một dòng riêng.');
    const cut = r.shown.find(s => s.cut);
    add(first.t1, 'bad', `The 8 rows run out inside #${cut ? cut.id : r.shown.at(-1).id}, which has 30 tags. The page gets ${r.shown.length} tickets instead of 8${cut ? `, and the last one is missing ${cut.cut} tags` : ''}.`, `8 dòng hết ngay bên trong #${cut ? cut.id : r.shown.at(-1).id}, ticket có 30 tag. Trang chỉ có ${r.shown.length} ticket thay vì 8${cut ? `, và ticket cuối thiếu ${cut.cut} tag` : ''}.`);
  } else {
    add(at(first), null, 'One query: each ticket row carries a copy of its assignee’s name and its tag names.', 'Một truy vấn: mỗi dòng ticket mang sẵn bản sao tên người được giao và tên các tag.');
    add(first.t1, null, `1 round trip, ${r.loadMs.toFixed(1)} ms. Reads are cheap; the cost moved to every write that changes a name or a tag.`, `1 vòng mạng, ${r.loadMs.toFixed(1)} ms. Đọc thì rẻ; chi phí chuyển sang mọi lần ghi làm đổi một cái tên hay một tag.`);
  }
  m.sort((a, b) => a.t - b.t);
  return m.map((x, i) => ({ ...x, t0: x.t, t1: i + 1 < m.length ? m[i + 1].t : r.end }));
}

const LABEL = {
  lazy: { en: 'Today: lazy loading', vi: 'Hiện tại: lazy loading' },
  cache: { en: 'Cache lookups in Redis', vi: 'Cache tra cứu trong Redis' },
  join: { en: 'One JOIN + LIMIT', vi: 'Một JOIN + LIMIT' },
  batch: { en: 'Batch with IN (...)', vi: 'Batch với IN (...)' },
  denorm: { en: 'Denormalize onto tickets', vi: 'Phi chuẩn hoá vào tickets' },
};
const SITUATION = {
  page: { en: 'Load the queue page', vi: 'Tải trang hàng đợi' },
  retag: { en: 'Automation adds a tag', vi: 'Automation thêm tag' },
  rename: { en: 'An admin renames a tag', vi: 'Admin đổi tên tag' },
};

export function mount(root, ctx) {
  let cached = null;   // the player asks for each run once; the drawing reads the same result
  return player(root, ctx, {
    situations: SITUATIONS.map(x => ({ value: x, label: tx(SITUATION[x]), icon: { page: 'list', retag: 'tag', rename: 'gear' }[x] })),
    setups: SETUPS.map(x => ({ value: x, label: tx(LABEL[x]), icon: { lazy: 'hourglass', cache: 'memory', join: 'layers', batch: 'checks', denorm: 'copy' }[x] })),
    initial: { situation: 'page' },
    run: (setup, situation) => (cached = run(setup, situation)),
    survives, height: 540,
    duration: st => Math.max(0.9, (st.t1 - st.t0) * 0.75),
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
const KIND = { ticket: 'blue', agent: 'ok', tags: 'warn' };
const SCALE = 20;   // ms across the time strip, the same for every setup

function draw(g, w, h, r, t) {
  const { setup } = r;
  g.clearRect(0, 0, w, h);
  g.textBaseline = 'middle';
  const text = (s, x, y, color = 'muted', font = mono(10, 400), align = 'left', max) => {
    g.font = font; g.textAlign = align; g.fillStyle = css(color); g.fillText(s, x, y, max);
  };
  const box = (x, y, bw, bh, rad, fill, stroke, alpha = 1) => {
    g.beginPath(); g.roundRect(x, y, bw, bh, rad);
    if (fill) { g.globalAlpha = alpha; g.fillStyle = css(fill); g.fill(); g.globalAlpha = 1; }
    if (stroke) { g.strokeStyle = css(stroke); g.stroke(); }
  };

  // Round trips done or under way, and database time spent so far.
  const started = r.trips.filter(x => x.t0 <= t);
  const spent = started.reduce((s, x) => s + Math.min(t, x.t1) - x.t0, 0);
  const cur = r.trips.find(x => t >= x.t0 && t < x.t1);

  // ---- The strip: database time for the page, against the budget. ----
  const sx0 = 190, sx1 = w - 14, sy = 30;
  const X = ms => sx0 + (Math.min(ms, SCALE) / SCALE) * (sx1 - sx0);
  text(tx({ en: 'DATABASE TIME', vi: 'THỜI GIAN DATABASE' }), 10, 22, 'muted', mono(10, 700));
  text(tx({ en: `${started.length} round trip${started.length === 1 ? '' : 's'}`, vi: `${started.length} vòng mạng` }), 10, 38, started.length > 4 ? 'bad' : 'text', mono(11, 700));
  box(sx0, sy - 10, sx1 - sx0, 20, 6, 'bg2');
  // One segment per round trip, so you can count them.
  let acc = 0;
  for (const x of started) {
    const d = Math.min(t, x.t1) - x.t0;
    const x0 = X(acc), x1 = X(acc + d);
    const over = acc + d > BUDGET;
    box(x0 + 0.5, sy - 8, Math.max(1, x1 - x0 - 1.5), 16, 3, over ? 'bad' : x.to === 'redis' ? 'violet' : 'blue', null, 0.85);
    acc += d;
  }
  g.strokeStyle = css('warn'); g.lineWidth = 2; g.beginPath(); g.moveTo(X(BUDGET), sy - 14); g.lineTo(X(BUDGET), sy + 14); g.stroke(); g.lineWidth = 1;
  text(tx({ en: `budget ${BUDGET} ms`, vi: `ngân sách ${BUDGET} ms` }), X(BUDGET) + 5, sy - 17, 'warn', mono(9, 700));
  text(`${spent.toFixed(1)} ms`, Math.min(X(spent) + 6, sx1 - 4), sy + 20, spent > BUDGET ? 'bad' : 'text', mono(10.5, 700), X(spent) + 60 > sx1 ? 'right' : 'left');

  // ---- Layout. ----
  const top = 70, bottom = h - 36;
  const px0 = 12, px1 = w * 0.42, dbx0 = w * 0.64, dbx1 = w - 12;
  const wireY = top + 30;

  // ---- The page. ----
  box(px0, top, px1 - px0, bottom - top, 12, 'surface2', 'line');
  text(tx({ en: 'THE QUEUE PAGE · 8 of 100 tickets', vi: 'TRANG HÀNG ĐỢI · 8 / 100 ticket' }), px0 + 12, top + 16, 'muted', mono(10, 700), 'left', px1 - px0 - 24);
  const filled = (i, field) => r.trips.some(x => x.t1 <= t && x.fills.some(f => f.i === i && f.field === field));
  const filling = (i, field) => cur && cur.fills.some(f => f.i === i && f.field === field);
  const rowH = (bottom - top - 34) / PAGE;
  for (let i = 0; i < PAGE; i++) {
    const y0 = top + 30 + i * rowH, yA = y0 + rowH * 0.32, yB = y0 + rowH * 0.72;
    const tk = r.now[i], s = r.shown[i];
    const missing = !s && r.trips.every(x => x.t1 <= t);
    box(px0 + 8, y0 + 2, px1 - px0 - 16, rowH - 4, 6, missing ? null : 'bg2', missing ? 'bad' : null);
    if (missing) {
      g.setLineDash([4, 4]); box(px0 + 8, y0 + 2, px1 - px0 - 16, rowH - 4, 6, null, 'bad'); g.setLineDash([]);
      text(tx({ en: 'not on the page: LIMIT 8 ran out on tag rows', vi: 'không có trên trang: LIMIT 8 đã hết vì các dòng tag' }), px0 + 20, y0 + rowH / 2, 'bad', mono(10, 600), 'left', px1 - px0 - 40);
      continue;
    }
    if (!filled(i, 'ticket')) {
      box(px0 + 18, yA - 4, 120, 8, 3, filling(i, 'ticket') ? 'blue' : 'line', null, filling(i, 'ticket') ? 0.5 : 0.6);
      continue;
    }
    text(`#${tk.id}`, px0 + 18, yA, 'blue', mono(10, 700));
    text(tx(tk.subj), px0 + 78, yA, 'text', sans(11.5, 600), 'left', px1 - px0 - 96);
    // Assignee.
    if (filled(i, 'agent')) text(AGENTS[tk.agent], px0 + 18, yB, 'ok', sans(11, 700));
    else box(px0 + 18, yB - 4, 34, 8, 3, filling(i, 'agent') ? 'ok' : 'line', null, filling(i, 'agent') ? 0.6 : 0.6);
    // Tags.
    let cx = px0 + 70;
    const maxX = px1 - 20;
    if (filled(i, 'tags')) {
      const tags = s ? s.tags : tk.tags;
      const show = tags.length > 5 ? tags.slice(0, 3) : tags;
      for (const tag of show) {
        g.font = mono(9, 600);
        const tw = g.measureText(tag).width + 12;
        if (cx + tw > maxX - 70) break;
        const stale = s && s.stale && !tk.tags.includes(tag);
        box(cx, yB - 8, tw, 16, 8, stale ? 'bad' : 'warn', null, 0.2);
        text(tag, cx + tw / 2, yB, stale ? 'bad' : 'warn', mono(9, 600), 'center');
        cx += tw + 4;
      }
      if (tags.length > show.length) { text(tx({ en: `+${tags.length - show.length} more`, vi: `+${tags.length - show.length} nữa` }), cx + 2, yB, 'warn', mono(9, 700)); cx += 60; }
      if (s && s.cut) text(tx({ en: `${s.cut} tags cut off`, vi: `thiếu ${s.cut} tag` }), cx + 4, yB, 'bad', mono(9.5, 700), 'left', maxX - cx);
      if (s && s.stale) {
        const gone = tk.tags.filter(x => !s.tags.includes(x));
        text(tx({ en: `stale: missing ${gone.join(', ')}`, vi: `cũ: thiếu ${gone.join(', ')}` }), cx + 4, yB, 'bad', mono(9.5, 700), 'left', maxX - cx);
      }
      if (!tags.length) text(tx({ en: 'no tags', vi: 'không có tag' }), cx, yB, 'faint', mono(9, 400));
    } else box(cx, yB - 4, 90, 8, 3, filling(i, 'tags') ? 'warn' : 'line', null, 0.6);
  }

  const wr = r.write;
  // ---- Postgres and its tables. ----
  box(dbx0, top, dbx1 - dbx0, bottom - top, 12, 'surface2', cur && cur.to === 'db' ? 'blue' : 'line');
  text('POSTGRES', dbx0 + 12, top + 16, 'blue', mono(10, 700));
  const reads = cur && cur.reads && (t - cur.t0) / (cur.t1 - cur.t0) >= 0.3 && (t - cur.t0) / (cur.t1 - cur.t0) < 0.7 ? cur.reads : {};
  const tw = dbx1 - dbx0 - 24, tx0 = dbx0 + 12;
  // tickets
  let y = top + 36;
  text(setup === 'denorm' ? 'tickets (+ assignee_name, tag_names)' : 'tickets', tx0, y, 'blue', mono(9.5, 700), 'left', tw);
  y += 10;
  const bigWrite = wr && wr.rows > WRITE_BUDGET && t >= wr.t0 && t < wr.t1;
  r.now.forEach((x, i) => {
    const hot = reads.tickets && reads.tickets.includes(x.id);
    const cols = 2, cw = tw / cols, rx = tx0 + (i % cols) * cw, ry = y + Math.floor(i / cols) * 17;
    box(rx, ry, cw - 4, 14, 3, hot ? 'blue' : bigWrite && x.tags.includes('payments') ? 'bad' : 'bg2', null, hot ? 0.55 : bigWrite ? 0.4 : 1);
    text(`#${x.id}`, rx + 6, ry + 7, hot ? 'text' : 'faint', mono(9, 600));
  });
  y += 4 * 17 + 2;
  text(tx({ en: '… 2,000,000+ more', vi: '… hơn 2.000.000 dòng nữa' }), tx0, y + 4, 'faint', mono(8.5, 400));
  // agents
  y += 22;
  text('agents', tx0, y, 'ok', mono(9.5, 700));
  y += 10;
  Object.entries(AGENTS).forEach(([id, name], i) => {
    const hot = reads.agents && reads.agents.includes(+id);
    const cw = tw / 5, rx = tx0 + i * cw;
    box(rx, y, cw - 4, 16, 3, hot ? 'ok' : 'bg2', null, hot ? 0.55 : 1);
    text(name, rx + (cw - 4) / 2, y + 8, hot ? 'text' : 'faint', mono(9, 600), 'center', cw - 8);
  });
  // ticket_tags: one small cell per tag row, a line per ticket.
  y += 34;
  text('ticket_tags', tx0, y, 'warn', mono(9.5, 700));
  y += 10;
  const cell = Math.min(9, (tw - 60) / 30);
  r.now.forEach((x, i) => {
    const ry = y + i * 13;
    text(`#${x.id}`, tx0, ry + 5, 'faint', mono(8, 400));
    const lim = reads.tagLimit ? reads.tagLimit[i] ?? 0 : Infinity;
    x.tags.forEach((tag, j) => {
      const hot = reads.tags && reads.tags.includes(i) && j < lim;
      box(tx0 + 52 + j * cell, ry, cell - 2, 10, 2, hot ? 'warn' : 'bg2', null, hot ? 0.8 : 1);
    });
  });

  // ---- The wire, and Redis for the cache setup. ----
  const appEdge = [px1, wireY], dbEdge = [dbx0, wireY];
  const redis = setup === 'cache' ? [(px1 + dbx0) / 2 + 44, wireY + 56] : null;
  road(g, appEdge, dbEdge, cur && cur.to === 'db' ? 'blue' : null);
  if (redis) {
    road(g, [px1, redis[1]], [redis[0] - 50, redis[1]], cur && cur.to === 'redis' ? 'violet' : null);
    const staleHit = cur && cur.to === 'redis' && r.shown[cur.ticket] && r.shown[cur.ticket].stale && cur.short.startsWith('GET tags');
    node(g, { x: redis[0], y: redis[1], w: 110, h: 46, title: 'Redis', icon: 'gear', color: 'violet', active: cur && cur.to === 'redis', alert: staleHit });
    text(tx({ en: '5 min TTL', vi: 'TTL 5 phút' }), redis[0] + 20, redis[1] + 12, 'faint', mono(9, 400), 'center');
  }
  // The query in flight: out, at the database, and back with rows.
  if (cur) {
    const f = (t - cur.t0) / (cur.t1 - cur.t0);
    const from = cur.to === 'redis' ? [px1 + 6, redis[1]] : [px1 + 6, wireY];
    const to = cur.to === 'redis' ? [redis[0] - 60, redis[1]] : [dbx0 - 6, wireY];
    const atDb = f >= 0.42 && f < 0.58;
    const color = cur.to === 'redis' ? 'violet' : 'blue';
    if (f < 0.42) { const k = f / 0.42; const p = [from[0] + (to[0] - from[0]) * k, from[1]]; message(g, Math.max(p[0], from[0] + 60), p[1], cur.short, color, 'arrow', from); }
    else if (atDb) { g.font = '700 11px "IBM Plex Mono", monospace'; const mw = g.measureText(cur.short).width + 32; message(g, to[0] - mw / 2, to[1], cur.short, color, 'gear'); }
    else if (f >= 0.58) {
      const k = (f - 0.58) / 0.42; const p = [to[0] + (from[0] - to[0]) * k, from[1]];
      const kinds = cur.fills.map(x => x.field);
      const c = kinds.includes('tags') && !kinds.includes('ticket') ? 'warn' : kinds.includes('agent') && !kinds.includes('ticket') ? 'ok' : 'blue';
      const n = cur.rows;
      message(g, Math.max(p[0], from[0] + 40), p[1], tx({ en: `${n} row${n === 1 ? '' : 's'}`, vi: `${n} dòng` }), c, 'check', to);
    }
    // The SQL of the current query, written out under the wire.
    const sqlY = setup === 'cache' ? wireY + 104 : wireY + 44;
    box(px1 + 10, sqlY - 14, dbx0 - px1 - 20, 46, 8, 'bg2', 'line');
    text(cur.to === 'redis' ? 'Redis' : 'SQL', px1 + 20, sqlY - 4, color, mono(9, 700));
    wrap(g, cur.sql, px1 + 20, sqlY + 10, dbx0 - px1 - 40, 12, mono(9.5, 500), css('text'), 2);
  }
  // The query log: every round trip so far, one line each.
  if (t >= r.loadStart) {
    const ly0 = (setup === 'cache' ? wireY + 104 : wireY + 44) + 50, lx0 = px1 + 14, lw = dbx0 - px1 - 28;
    const lh = 15, room = Math.floor((bottom - ly0 - 18) / lh);
    text(tx({ en: 'QUERY LOG', vi: 'LOG TRUY VẤN' }), lx0, ly0, 'muted', mono(9.5, 700));
    const list = started.slice(-room);
    list.forEach((x, j) => {
      const n = started.indexOf(x) + 1, y = ly0 + 16 + j * lh;
      const kinds = x.fills.map(f => f.field);
      const c = x.to === 'redis' ? 'violet' : kinds.includes('ticket') ? 'blue' : kinds.includes('agent') ? 'ok' : 'warn';
      if (x === cur) box(lx0 - 4, y - 7, lw + 8, 14, 3, c, null, 0.15);
      text(String(n).padStart(2, ' '), lx0, y, 'faint', mono(9.5, 400));
      text(x.short, lx0 + 22, y, c, mono(9.5, 600), 'left', lw - 80);
      text(`${(x.t1 - x.t0).toFixed(2)} ms`, lx0 + lw, y, 'faint', mono(9, 400), 'right');
    });
    if (started.length > room) text(tx({ en: `(${started.length - room} earlier)`, vi: `(${started.length - room} cái trước)` }), lx0 + lw, ly0, 'faint', mono(9, 400), 'right');
  }

  // A write before the page loads.
  if (wr && t < wr.t1 + 0.6) {
    const f = Math.min(1, (t - wr.t0) / (wr.t1 - wr.t0));
    const big = wr.rows > WRITE_BUDGET;
    badge(g, (px1 + dbx0) / 2, top + 14, tx(wr.who === 'admin' ? { en: 'ADMIN', vi: 'ADMIN' } : { en: 'AUTOMATION', vi: 'AUTOMATION' }), 'violet', 160, wr.who === 'admin' ? 'user' : 'gear');
    if (f < 0.3) message(g, px1 + 60 + (dbx0 - px1 - 120) * (f / 0.3), wireY - 30, wr.short, 'violet', 'arrow');
    const wy = wireY + 44;
    box(px1 + 10, wy - 14, dbx0 - px1 - 20, 64, 8, 'bg2', big ? 'bad' : 'line');
    wrap(g, wr.sql, px1 + 20, wy, dbx0 - px1 - 40, 12, mono(9.5, 500), css('text'), 2);
    const done = Math.round(wr.rows * Math.max(0, (f - 0.3) / 0.7));
    text(tx({ en: `rows rewritten: ${done.toLocaleString('en')}${big ? ` of ${wr.rows.toLocaleString('en')}` : ''}`, vi: `số dòng ghi lại: ${done.toLocaleString('vi')}${big ? ` / ${wr.rows.toLocaleString('vi')}` : ''}` }), px1 + 20, wy + 34, big ? 'bad' : 'ok', mono(10, 700), 'left', dbx0 - px1 - 40);
  }

  // ---- Footer. ----
  const fy = h - 14;
  const allDone = r.trips.every(x => x.t1 <= t);
  if (allDone) {
    const msg = r.ok ? tx({ en: `page complete · ${r.trips.length} round trip${r.trips.length === 1 ? '' : 's'} · ${r.loadMs.toFixed(1)} ms`, vi: `trang đầy đủ · ${r.trips.length} vòng mạng · ${r.loadMs.toFixed(1)} ms` }) : tx(r.summary);
    text(msg, 10, fy, r.ok ? 'ok' : 'bad', mono(10.5, 700), 'left', w * 0.6);
  } else text(tx({ en: 'one round trip at a time: the page waits for each before sending the next', vi: 'mỗi lần một vòng mạng: trang chờ xong cái này mới gửi cái tiếp theo' }), 10, fy, 'faint', mono(10, 400), 'left', w * 0.6);
  const legend = [['blue', tx({ en: 'ticket', vi: 'ticket' })], ['ok', tx({ en: 'assignee', vi: 'người được giao' })], ['warn', tx({ en: 'tags', vi: 'tag' })]];
  let lx = w - 14;
  for (const [c, label] of legend.reverse()) {
    g.font = sans(11, 400);
    lx -= g.measureText(label).width; text(label, lx, fy, 'muted', sans(11, 400));
    lx -= 14; g.fillStyle = css(c); g.beginPath(); g.roundRect(lx, fy - 4, 8, 8, 2); g.fill();
    lx -= 12;
  }
}

/* Text wrapped to a width, at most `lines` lines, the last one cut with an ellipsis. */
function wrap(g, s, x, y, maxW, lh, font, color, lines) {
  g.font = font; g.fillStyle = color; g.textAlign = 'left';
  const words = s.split(' ');
  let line = '', n = 0;
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (g.measureText(next).width > maxW && line) {
      if (n === lines - 1) { g.fillText(`${line} …`, x, y + n * lh, maxW); return; }
      g.fillText(line, x, y + n * lh, maxW); n++; line = words[i];
    } else line = next;
  }
  g.fillText(line, x, y + n * lh, maxW);
}
