/* How a queue feeds a consumer, and where a failing message goes.

   On the left, the delivery service publishes "driver update" messages into a Kafka
   topic, drawn as partitions: rows of numbered messages, with a marker at each
   partition's committed offset. Each partition has one consumer, which takes the
   message at its offset, sends it as an SMS through the provider, and only then
   moves its offset on. The provider answers 200, 429 (over its rate limit), 503
   (down) or 400 (a number it will never accept).

   What happens to a failed message is the setup: retried on the spot and then
   dropped, retried in place until it works, kept in the consumer's memory, or
   published to a retry topic that is read again after a delay and, once the attempts
   run out, to a dead-letter queue that someone can inspect and replay. Every message
   ends in one of three bins: delivered, dead-letter queue, or lost.

   The model is a step simulation at a tenth of a second, scaled down: one message
   here stands for twenty in the scenario. js/sim-player.js supplies the controls and
   scoreboard. */

import { tx } from '../../js/i18n.js';
import { css } from '../../js/sim-kit.js';
import { player } from '../../js/sim-player.js';
import { node, icon } from '../../js/sim-draw.js';

export const SETUPS = ['today', 'inplace', 'scale', 'memory', 'dlq'];
export const SITUATIONS = ['steady', 'outage', 'poison', 'deploy'];

export const T = 45;            // seconds in a run
export const DT = 0.05;
export const RATE = 3;          // messages a second (60 a second in the scenario)
export const LAST = 38;         // the producer stops publishing here, so the queue can drain
export const LIMIT = 6;         // the provider's limit: accepted requests in any second (120 in the scenario)
export const CAP = 5;           // the token bucket in option D (100 in the scenario)
export const SEND = 0.25;       // seconds one SMS request takes
export const OUTAGE = [8, 18];  // the provider answers 503
export const POISON = 20;       // the message whose phone number the provider rejects (400)
export const RESTART = 18;      // deploy: every consumer restarts
export const BLIP = [14, 18];    // deploy: a short outage just before the restart
export const LATE = 30;         // a text later than this is useless
export const MAX_REJECT = 0.02; // the provider throttles an account when more than 2% of its requests are over the limit
export const RETRY_DELAY = 5;   // option D: seconds before a retry topic message is read again
export const ATTEMPTS = 5;      // option D: attempts before the dead-letter queue
export const MEM_RETRY = 2;     // option C: seconds between retries from memory
const BACKOFF = [1, 2, 4, 8];   // option A: wait before retrying in place
const IMMEDIATE = 3;            // today and option B: retries straight away, then drop

export const partitionsOf = setup => (setup === 'scale' ? 6 : 2);

/* Run one situation. Every message's fate, every request the provider saw, and enough
   snapshots to draw any moment. Pure and seeded. */
export function run(setup, situation) {
  const P = partitionsOf(setup);
  const msgs = [];
  for (let i = 0, t = 0.5; t < LAST; i++, t = 0.5 + i / RATE)
    msgs.push({ id: i + 1, t: +t.toFixed(2), part: i % P, attempts: 0, state: 'queued', log: [] });
  const parts = Array.from({ length: P }, (_, p) => ({ ids: msgs.filter(m => m.part === p).map(m => m.id), offset: 0 }));
  const cons = parts.map((_, p) => ({ p, busy: null, until: 0, wait: 0, mem: [] }));
  const retryCon = { busy: null, until: 0 };
  const retryTopic = [], dlq = [], requests = [], frames = [];
  let tokens = 1, restarted = false;
  const byId = id => msgs[id - 1];

  function provider(t, m) {
    let code;
    if (m.id === POISON && situation === 'poison') code = 400;
    else if (situation === 'outage' && t >= OUTAGE[0] && t < OUTAGE[1]) code = 503;
    else if (situation === 'deploy' && t >= BLIP[0] && t < BLIP[1]) code = 503;
    else code = requests.filter(q => q.t > t - 1 && q.code === 200).length >= LIMIT ? 429 : 200;
    requests.push({ t, id: m.id, code });
    m.attempts++;
    m.log.push({ t, code });
    return code;
  }
  const start = (c, m, t, from) => { c.busy = { id: m.id, from, code: provider(t, m), t }; c.until = t + SEND; m.state = 'sending'; };

  for (let i = 0; i <= T / DT; i++) {
    const t = +(i * DT).toFixed(2);
    if (setup === 'dlq') tokens = Math.min(1, tokens + CAP * DT);

    // A deploy restarts every consumer: what is in flight is read again from its
    // committed offset; what only lived in memory is gone.
    if (situation === 'deploy' && !restarted && t >= RESTART) {
      restarted = true;
      for (const c of cons) {
        if (c.busy) { const m = byId(c.busy.id); if (c.busy.from === 'mem') m.state = 'lost'; else m.state = 'queued'; c.busy = null; }
        for (const e of c.mem) byId(e.id).state = 'lost';
        c.mem = []; c.wait = t + 1;
      }
      if (retryCon.busy) { byId(retryCon.busy.id).state = 'retry'; retryCon.busy = null; }
    }

    // Finish requests that are done.
    for (const c of [...cons, retryCon]) {
      if (!c.busy || t < c.until) continue;
      const { id, from, code } = c.busy, m = byId(id);
      c.busy = null;
      const commit = () => { if (from === 'part') parts[m.part].offset++; };
      if (code === 200) { m.state = 'delivered'; m.at = t; commit(); continue; }
      if (setup === 'today' || setup === 'scale') {
        if (m.attempts <= IMMEDIATE) start(c, m, t, from);
        else { m.state = 'lost'; m.at = t; commit(); }
      } else if (setup === 'inplace') {
        m.state = 'waiting';
        c.wait = t + BACKOFF[Math.min(BACKOFF.length - 1, m.attempts - 1)];
      } else if (setup === 'memory') {
        m.state = 'memory';
        c.mem.push({ id, due: t + MEM_RETRY });
        commit();
      } else {
        if (code === 400 || m.attempts >= ATTEMPTS) { m.state = 'dlq'; m.at = t; dlq.push({ id, t, code }); }
        else { m.state = 'retry'; retryTopic.push({ id, due: t + RETRY_DELAY, t }); }
        commit();
      }
    }

    // Start new requests.
    for (const c of cons) {
      if (c.busy || t < c.wait) continue;
      if (setup === 'dlq' && tokens < 1) continue;
      let m = null, from = 'part';
      if (setup === 'memory') {
        const k = c.mem.findIndex(e => e.due <= t);
        if (k >= 0) { m = byId(c.mem[k].id); c.mem.splice(k, 1); from = 'mem'; }
      }
      if (!m) {
        const part = parts[c.p], next = part.ids[part.offset];
        if (next && byId(next).t <= t) m = byId(next);
      }
      if (!m) continue;
      if (setup === 'dlq') tokens -= 1;
      start(c, m, t, from);
    }
    if (setup === 'dlq' && !retryCon.busy && tokens >= 1 && t >= (cons[0].wait || 0)) {
      const k = retryTopic.findIndex(e => e.due <= t);
      if (k >= 0) { const e = retryTopic.splice(k, 1)[0]; tokens -= 1; start(retryCon, byId(e.id), t, 'retry'); }
    }

    if (i % 2 === 0) frames.push({
      t,
      offsets: parts.map(p => p.offset),
      busy: cons.map(c => c.busy && { ...c.busy }),
      retryBusy: retryCon.busy && { ...retryCon.busy },
      wait: cons.map(c => c.wait),
      mem: cons.map(c => c.mem.map(e => ({ ...e }))),
      retry: retryTopic.map(e => ({ ...e })),
      dlq: dlq.length,
      states: msgs.map(m => m.state),
      tokens,
    });
  }

  // How it went.
  // Lateness is about texts still on their way: lost and dead-lettered ones are counted in their own bins.
  const real = msgs.filter(m => !(situation === 'poison' && m.id === POISON) && m.state !== 'lost' && m.state !== 'dlq');
  const poison = situation === 'poison' ? byId(POISON) : null;
  const lost = msgs.filter(m => m.state === 'lost');
  const late = real.filter(m => (m.state === 'delivered' ? m.at : T) - m.t > LATE);
  const sent = requests.filter(q => q.code !== 503);
  const rejected = requests.filter(q => q.code === 429).length;
  const share = sent.length ? rejected / sent.length : 0;
  const ok = lost.length === 0 && late.length === 0 && share <= MAX_REJECT && (!poison || poison.state === 'dlq');
  const res = {
    setup, situation, P, msgs, parts: parts.map(p => p.ids), requests, frames, ok,
    lost: lost.length, late: late.length, rejected, share,
    delivered: msgs.filter(m => m.state === 'delivered').length,
    inDlq: dlq.length, poison: poison && poison.state,
    maxDelay: Math.max(0, ...real.map(m => (m.state === 'delivered' ? m.at : T) - m.t)),
  };
  res.at = t => frames[Math.max(0, Math.min(frames.length - 1, Math.round(t / (DT * 2))))];
  res.steps = story(res);
  res.summary = ok ? { en: 'Within the constraints: nothing lost, nothing late, the provider never pushed back.', vi: 'Đạt các ràng buộc: không mất gì, không trễ, nhà cung cấp không hề từ chối vì vượt giới hạn.' } : summary(res);
  return res;
}

export const survives = (setup, situation) => run(setup, situation).ok;

function summary(r) {
  const bits = [];
  if (r.lost) bits.push({ en: `${r.lost} message${r.lost > 1 ? 's' : ''} lost`, vi: `mất ${r.lost} tin` });
  if (r.late) bits.push({ en: `${r.late} texts more than ${LATE} s late`, vi: `${r.late} tin trễ quá ${LATE} giây` });
  if (r.share > MAX_REJECT) bits.push({ en: `${Math.round(r.share * 100)}% of requests over the provider’s limit`, vi: `${Math.round(r.share * 100)}% request vượt giới hạn của nhà cung cấp` });
  if (r.poison && r.poison !== 'dlq' && r.poison !== 'lost') bits.push({ en: 'the bad message never reached a person', vi: 'tin hỏng không bao giờ tới tay một người' });
  return { en: `Broken: ${bits.map(b => b.en).join(', ')}.`, vi: `Hỏng: ${bits.map(b => b.vi).join(', ')}.` };
}

const HOW = {
  today: ['Today: each consumer sends as fast as it reads. On an error it retries straight away, up to 3 times, then logs the error and moves its offset on.', 'Hiện tại: mỗi consumer gửi nhanh nhất có thể. Gặp lỗi thì retry ngay, tối đa 3 lần, rồi ghi log và dời offset đi tiếp.'],
  inplace: ['Retry in place: on an error the consumer waits (1, 2, 4, then 8 s) and retries the same message. Its offset only moves once the message is delivered.', 'Retry tại chỗ: gặp lỗi thì consumer chờ (1, 2, 4, rồi 8 giây) và retry đúng tin đó. Offset chỉ dời khi tin đã được gửi.'],
  scale: ['Scale out: three times the partitions and consumers, with today’s error handling.', 'Scale out: gấp ba số partition và consumer, vẫn xử lý lỗi như hiện tại.'],
  memory: ['Retry from memory: a failed message goes into a list inside the consumer, the offset moves on, and the list is retried every 2 seconds.', 'Retry từ bộ nhớ: tin lỗi được đưa vào một danh sách trong consumer, offset dời đi tiếp, và danh sách được retry mỗi 2 giây.'],
  dlq: ['Rate limit, retry topic and DLQ: sends are capped at 4 a second, under the provider’s 5. A failed message is published to a retry topic and the offset moves on. After 5 attempts, or at once on a 400, it goes to the dead-letter queue.', 'Rate limit, retry topic và DLQ: số lần gửi bị giới hạn 4 mỗi giây, dưới mức 5 của nhà cung cấp. Tin lỗi được publish sang retry topic và offset dời đi tiếp. Sau 5 lần thử, hoặc ngay khi gặp 400, nó vào dead-letter queue.'],
};

function story(r) {
  const { setup, situation, msgs, requests } = r;
  const m = [];
  const add = (t, tone, en, vi) => m.push({ t, tone, say: { en, vi } });
  add(0, null, ...HOW[setup]);
  add(0.6, null, `The delivery service publishes ${RATE} messages a second into the topic, spread over ${r.P} partitions. Each partition is read in order by one consumer, which sends the SMS and then commits its offset.`, `Delivery service publish ${RATE} tin mỗi giây vào topic, chia ra ${r.P} partition. Mỗi partition được một consumer đọc theo thứ tự, consumer gửi SMS rồi mới commit offset.`);

  const first = (f, from = 0) => requests.find(q => q.t >= from && f(q));
  if (situation === 'outage') {
    add(OUTAGE[0], 'warn', `The SMS provider goes down for ${OUTAGE[1] - OUTAGE[0]} seconds and answers 503 to everything.`, `Nhà cung cấp SMS sập ${OUTAGE[1] - OUTAGE[0]} giây và trả 503 cho mọi request.`);
    const say = {
      today: ['Each failing message is retried three times within a second, then dropped. Every text in the outage is gone.', 'Mỗi tin lỗi được retry ba lần trong một giây, rồi bị bỏ. Mọi tin nhắn trong lúc sập đều mất.'],
      scale: ['More consumers fail faster: each message is retried three times, then dropped.', 'Nhiều consumer hơn thì hỏng nhanh hơn: mỗi tin được retry ba lần, rồi bị bỏ.'],
      inplace: ['Each consumer waits and retries the same message; the partition behind it waits too. Nothing is lost, the queue just grows.', 'Mỗi consumer chờ rồi retry đúng tin đó; partition phía sau cũng chờ theo. Không mất gì, hàng đợi chỉ dài thêm.'],
      memory: ['Failed messages pile up in the consumers’ memory while the offsets move on.', 'Tin lỗi chất đống trong bộ nhớ của consumer trong khi offset vẫn dời đi.'],
      dlq: ['Failed messages go to the retry topic and come back 5 seconds later. The partitions keep moving.', 'Tin lỗi vào retry topic và quay lại sau 5 giây. Các partition vẫn tiếp tục chạy.'],
    }[setup];
    add(OUTAGE[0] + 1.5, setup === 'today' || setup === 'scale' ? 'bad' : null, ...say);
    const storm = first(q => q.code === 429, OUTAGE[1]);
    add(OUTAGE[1], null, 'The provider is back.', 'Nhà cung cấp hoạt động lại.');
    if (storm) add(storm.t, 'bad', 'Catching up, the consumers send as fast as they can, past the provider’s 5 a second. It answers 429, and every 429 counts against the account.', 'Để bắt kịp, các consumer gửi nhanh hết mức, vượt mức 5 mỗi giây của nhà cung cấp. Nó trả 429, và mỗi 429 đều bị tính vào tài khoản.');
    else if (setup === 'dlq') add(OUTAGE[1] + 2, null, 'The backlog and the retries drain at 4 a second, under the limit. No 429s.', 'Phần tồn và các tin retry được xả ở mức 4 mỗi giây, dưới giới hạn. Không có 429 nào.');
  }
  if (situation === 'poison') {
    const p = msgs[POISON - 1];
    add(p.t, 'warn', `Message ${POISON} has a phone number the provider rejects with 400. It will never succeed.`, `Tin ${POISON} có số điện thoại mà nhà cung cấp từ chối bằng 400. Nó sẽ không bao giờ thành công.`);
    const say = {
      today: ['It is retried three times and dropped. Only a log line says it existed.', 'Nó được retry ba lần rồi bị bỏ. Chỉ một dòng log cho biết nó từng tồn tại.'],
      scale: ['It is retried three times and dropped. Only a log line says it existed.', 'Nó được retry ba lần rồi bị bỏ. Chỉ một dòng log cho biết nó từng tồn tại.'],
      inplace: [`Its consumer retries it forever, and every message behind it in partition ${p.part + 1} waits. That partition has stopped.`, `Consumer của nó retry mãi mãi, và mọi tin phía sau trong partition ${p.part + 1} phải chờ. Partition đó đã đứng.`],
      memory: ['It goes into memory and is retried every 2 seconds, forever. Nobody is told.', 'Nó vào bộ nhớ và được retry mỗi 2 giây, mãi mãi. Không ai được báo.'],
      dlq: ['A 400 will not get better, so it goes straight to the dead-letter queue, which alerts on-call. The partition keeps moving.', 'Lỗi 400 sẽ không tự khỏi, nên nó vào thẳng dead-letter queue, nơi báo cho người trực. Partition vẫn tiếp tục chạy.'],
    }[setup];
    add(p.t + 1.5, setup === 'dlq' ? null : 'bad', ...say);
    if (setup === 'inplace') add(p.t + LATE, 'bad', `The messages stuck behind it are now more than ${LATE} seconds late.`, `Các tin kẹt phía sau giờ đã trễ hơn ${LATE} giây.`);
  }
  if (situation === 'deploy') {
    add(BLIP[0], 'warn', `The provider fails for ${BLIP[1] - BLIP[0]} seconds (503), and a deploy is rolling out.`, `Nhà cung cấp lỗi ${BLIP[1] - BLIP[0]} giây (503), đúng lúc một lần deploy đang chạy.`);
    add(RESTART, setup === 'memory' ? 'bad' : null,
      setup === 'memory' ? 'A deploy restarts the consumers. Their offsets had moved past the messages in memory, so those messages are gone.' : 'A deploy restarts the consumers. Each starts again from its committed offset, and nothing that was committed is lost.',
      setup === 'memory' ? 'Một lần deploy khởi động lại các consumer. Offset đã vượt qua các tin trong bộ nhớ, nên những tin đó mất hẳn.' : 'Một lần deploy khởi động lại các consumer. Mỗi consumer bắt đầu lại từ offset đã commit, và không gì đã commit bị mất.');
  }
  add(LAST, null, `The last message is published. ${r.delivered} delivered, ${r.inDlq} in the dead-letter queue, ${r.lost} lost.`, `Tin cuối cùng được publish. Đã gửi ${r.delivered}, ${r.inDlq} trong dead-letter queue, mất ${r.lost}.`);
  m.sort((a, b) => a.t - b.t);
  return m.map((x, i) => ({ ...x, t0: x.t, t1: i + 1 < m.length ? m[i + 1].t : T }));
}

const LABEL = {
  today: { en: 'Today: retry 3×, then drop', vi: 'Hiện tại: retry 3 lần rồi bỏ' },
  inplace: { en: 'Retry in place', vi: 'Retry tại chỗ' },
  scale: { en: 'Scale out consumers', vi: 'Scale out consumer' },
  memory: { en: 'Retry from memory', vi: 'Retry từ bộ nhớ' },
  dlq: { en: 'Rate limit + retry topic + DLQ', vi: 'Rate limit + retry topic + DLQ' },
};
const SITUATION = {
  steady: { en: 'A normal evening', vi: 'Một buổi tối bình thường' },
  outage: { en: 'The provider goes down', vi: 'Nhà cung cấp sập' },
  poison: { en: 'A number it rejects', vi: 'Một số bị từ chối' },
  deploy: { en: 'A deploy mid-failure', vi: 'Deploy giữa lúc lỗi' },
};

export function mount(root, ctx) {
  let cached = null;   // the player asks for each run once; the drawing reads the same result
  return player(root, ctx, {
    situations: SITUATIONS.map(x => ({ value: x, label: tx(SITUATION[x]), icon: { steady: 'sun', outage: 'power', poison: 'alert', deploy: 'replay' }[x] })),
    setups: SETUPS.map(x => ({ value: x, label: tx(LABEL[x]), icon: { today: 'bolt', inplace: 'hourglass', scale: 'layers', memory: 'memory', dlq: 'inbox' }[x] })),
    initial: { situation: 'outage' },
    run: (setup, situation) => (cached = run(setup, situation)),
    survives, height: 530,
    duration: st => Math.max(1.4, (st.t1 - st.t0) / 2.4),
    tone: st => st.tone,
    draw: ({ g, w, h, k, p }) => {
      const st = cached.steps[k];
      draw(g, w, h, cached, st ? st.t0 + p * (st.t1 - st.t0) : T);
    },
  });
}

/* ---------------- drawing ---------------- */

const mono = (px, wt = 600) => `${wt} ${px}px "IBM Plex Mono", monospace`;
const sans = (px, wt = 500) => `${wt} ${px}px "Hanken Grotesk", sans-serif`;
const CODE = { 200: 'ok', 429: 'bad', 503: 'warn', 400: 'violet' };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, f) => a + (b - a) * clamp(f, 0, 1);
const clock = s => `0:${String(Math.floor(s)).padStart(2, '0')}`;
/* How each state of a message looks: fill, ink, outline. */
const LOOK = {
  queued: ['surface', 'text', 'line'],
  sending: ['blue', 'bg', null],
  waiting: ['warn', 'bg', null],
  delivered: ['ok', 'bg', null],
  lost: ['bad', 'bg', null],
  memory: ['bg2', 'warn', 'warn'],
  retry: ['bg2', 'violet', 'violet'],
  dlq: ['bad', 'bg', null],
};

function draw(g, w, h, r, t) {
  const { setup, situation, msgs } = r;
  const f = r.at(t);
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
  const down = (situation === 'outage' && t >= OUTAGE[0] && t < OUTAGE[1]) || (situation === 'deploy' && t >= BLIP[0] && t < BLIP[1]);
  const restarting = situation === 'deploy' && t >= RESTART && t < RESTART + 1;
  const stateOf = id => f.states[id - 1];
  /* One message: a numbered chip, styled by its state. */
  const chip = (x, y, id, cw, chh, state = stateOf(id)) => {
    const [fill, ink, stroke] = LOOK[state] || LOOK.queued;
    const poisoned = situation === 'poison' && id === POISON;
    box(x, y, cw, chh, 4, fill, poisoned && state === 'queued' ? 'violet' : stroke, state === 'delivered' ? 0.35 : 1, stroke || poisoned ? 1.5 : 1);
    text(String(id), x + cw / 2, y + chh / 2 + 0.5, state === 'delivered' ? 'ok' : ink, mono(Math.min(10, chh * 0.6), 700), 'center');
    if (state === 'lost') { g.strokeStyle = css('bg'); g.lineWidth = 1.5; g.beginPath(); g.moveTo(x + 3, y + 3); g.lineTo(x + cw - 3, y + chh - 3); g.stroke(); g.lineWidth = 1; }
  };

  // ---- The strip: every request the provider saw, and the backlog. ----
  const sx0 = 128, sx1 = w - 14, sy0 = 12, sy1 = 70;
  const X = tt => sx0 + (tt / T) * (sx1 - sx0);
  text(tx({ en: 'PROVIDER', vi: 'NHÀ CUNG CẤP' }), 12, 22, 'muted', mono(10, 700));
  text(tx({ en: 'requests by answer', vi: 'request theo kết quả' }), 12, 36, 'faint', mono(9.5, 600));
  text(tx({ en: 'BACKLOG', vi: 'TỒN ĐỌNG' }), 12, 58, 'blue', mono(10, 700));
  box(sx0, sy0, sx1 - sx0, sy1 - sy0, 6, 'bg2');
  for (const [a, b] of situation === 'outage' ? [OUTAGE] : situation === 'deploy' ? [BLIP] : [])
    box(X(a), sy0, X(Math.min(b, t)) - X(a), sy1 - sy0, 0, 'warn', null, a < t ? 0.12 : 0);
  const rows = { 200: sy0 + 8, 503: sy0 + 16, 429: sy0 + 24, 400: sy0 + 24 };
  for (const q of r.requests) {
    if (q.t > t) break;
    g.fillStyle = css(CODE[q.code]); g.fillRect(X(q.t) - 0.75, rows[q.code] - 3, 1.5, 7);
  }
  // Backlog: messages published but not yet delivered, dropped or parked.
  const backlog = fr => fr.states.filter((s, i) => msgs[i].t <= fr.t && ['queued', 'sending', 'waiting', 'memory', 'retry'].includes(s)).length;
  const bMax = 40, BY = v => sy1 - 4 - (Math.min(v, bMax) / bMax) * 26;
  g.strokeStyle = css('blue'); g.lineWidth = 1.5; g.beginPath();
  r.frames.filter(fr => fr.t <= t).forEach((fr, i) => (i ? g.lineTo(X(fr.t), BY(backlog(fr))) : g.moveTo(X(fr.t), BY(backlog(fr)))));
  g.stroke(); g.lineWidth = 1;
  g.strokeStyle = css('text'); g.globalAlpha = 0.6; g.beginPath(); g.moveTo(X(t), sy0 - 2); g.lineTo(X(t), sy1 + 2); g.stroke(); g.globalAlpha = 1;
  text(clock(t), clamp(X(t), sx0 + 14, sx1 - 14), sy1 + 10, 'faint', mono(9.5, 600), 'center');

  // ---- Layout. ----
  const top = 96, P = r.P;
  const prodW = clamp(w * 0.12, 84, 118), provW = clamp(w * 0.17, 110, 160);
  const prodX = 14 + prodW / 2, provX = w - 14 - provW / 2;
  const conW = clamp(w * 0.13, 84, 120);
  const conX1 = provX - provW / 2 - 40, conX0 = conX1 - conW;
  const tx0 = 14 + prodW + 22, tx1 = conX0 - 18;
  const laneTop = top + 26, laneGap = 6;
  const laneH = P > 2 ? 26 : 50;
  const lanesBottom = laneTop + P * (laneH + laneGap) - laneGap;
  const retryTop = lanesBottom + 30, retryH = 34;
  const midY = (laneTop + lanesBottom) / 2;

  // Producer.
  node(g, { x: prodX, y: midY, w: prodW, h: 110, title: tx({ en: 'Delivery', vi: 'Delivery' }), icon: 'server', color: 'blue', active: t < LAST && (t * RATE) % 1 < 0.3 });
  text(t < LAST ? tx({ en: `+${RATE} / s`, vi: `+${RATE} / giây` }) : tx({ en: 'done', vi: 'xong' }), prodX, midY + 10, 'text', mono(12, 700), 'center');
  text(tx({ en: `${msgs.filter(m => m.t <= t).length} published`, vi: `đã publish ${msgs.filter(m => m.t <= t).length}` }), prodX, midY + 30, 'faint', mono(9.5, 600), 'center', prodW - 10);

  // The topic: one lane per partition, the committed offset marked.
  box(tx0 - 10, top, tx1 - tx0 + 20, lanesBottom - top + 12, 12, 'surface2', 'line');
  text(tx({ en: 'TOPIC · driver-updates', vi: 'TOPIC · driver-updates' }), tx0, top + 12, 'cat-queue', mono(10, 700), 'left', tx1 - tx0);
  const cw = P > 2 ? 22 : 26, chh = laneH - (P > 2 ? 8 : 16);
  const fit = Math.max(3, Math.floor((tx1 - tx0 - 54) / (cw + 3)));
  for (let p = 0; p < P; p++) {
    const ly = laneTop + p * (laneH + laneGap), ids = r.parts[p].filter(id => msgs[id - 1].t <= t);
    const off = f.offsets[p];
    box(tx0, ly, tx1 - tx0, laneH, 6, 'bg2');
    text(`P${p + 1}`, tx0 + 6, ly + laneH / 2, 'faint', mono(9.5, 700));
    const from = Math.max(0, off - 3), shown = ids.slice(from, from + fit);
    shown.forEach((id, k) => {
      const x = tx0 + 28 + k * (cw + 3), y = ly + (laneH - chh) / 2;
      chip(x, y, id, cw, chh);
      if (from + k === off) {   // the committed offset: the next message this consumer reads
        g.fillStyle = css('text'); g.beginPath(); g.moveTo(x + cw / 2, ly + laneH - 1); g.lineTo(x + cw / 2 - 4, ly + laneH + 5); g.lineTo(x + cw / 2 + 4, ly + laneH + 5); g.fill();
      }
    });
    const lag = ids.length - off;
    if (ids.length - from > fit) text(`+${ids.length - from - fit}`, tx1 - 22, ly + laneH / 2, 'warn', mono(10, 700), 'center');
    text(tx({ en: `lag ${lag}`, vi: `lag ${lag}` }), tx1 + 4, ly - 2, lag > 8 ? 'warn' : 'faint', mono(8.5, 600), 'right');
    // The road to this partition's consumer.
    g.strokeStyle = css('line'); g.setLineDash([3, 4]); g.beginPath(); g.moveTo(tx1 + 10, ly + laneH / 2); g.lineTo(conX0, ly + laneH / 2); g.stroke(); g.setLineDash([]);
  }
  if (P <= 2) text(tx({ en: '▲ committed offset: the next message the consumer reads', vi: '▲ offset đã commit: tin tiếp theo consumer sẽ đọc' }), tx0, lanesBottom + 14, 'faint', mono(9, 500), 'left', tx1 - tx0);

  // Option D's retry topic, under the main one.
  if (setup === 'dlq') {
    box(tx0 - 10, retryTop, tx1 - tx0 + 20, retryH + 22, 12, 'surface2', 'violet');
    text(tx({ en: `RETRY TOPIC · read again after ${RETRY_DELAY} s`, vi: `RETRY TOPIC · đọc lại sau ${RETRY_DELAY} giây` }), tx0, retryTop + 12, 'violet', mono(10, 700), 'left', tx1 - tx0);
    f.retry.slice(0, fit + 1).forEach((e, k) => {
      const x = tx0 + k * (cw + 3), y = retryTop + 24;
      chip(x, y, e.id, cw, 22, 'retry');
      const left = clamp((e.due - t) / RETRY_DELAY, 0, 1);
      box(x, y + 24, cw * left, 3, 1.5, 'violet');
    });
    if (!f.retry.length) text(tx({ en: 'empty', vi: 'trống' }), tx0, retryTop + 35, 'faint', mono(10, 600));
  }

  // Consumers: one per partition, plus the retry consumer.
  for (let p = 0; p < P; p++) {
    const ly = laneTop + p * (laneH + laneGap), b = f.busy[p];
    const waiting = !b && f.wait[p] > t;
    const color = restarting ? 'bad' : b ? 'blue' : waiting ? 'warn' : 'line';
    box(conX0, ly, conW, laneH, 6, 'surface2', color, 1, b || waiting || restarting ? 1.5 : 1);
    const label = restarting ? tx({ en: 'restarting', vi: 'khởi động lại' })
      : b ? `${tx({ en: 'send', vi: 'gửi' })} #${b.id}`
      : waiting ? tx({ en: `wait ${Math.ceil(f.wait[p] - t)} s`, vi: `chờ ${Math.ceil(f.wait[p] - t)} giây` })
      : tx({ en: 'idle', vi: 'rảnh' });
    text(`C${p + 1} · ${label}`, conX0 + conW / 2, ly + laneH / 2, restarting ? 'bad' : b ? 'text' : waiting ? 'warn' : 'faint', mono(P > 2 ? 9 : 10, 700), 'center', conW - 8);
  }
  // Option C: what each consumer holds in memory.
  if (setup === 'memory') {
    const held = f.mem.flat();
    const my = lanesBottom + 30;
    box(conX0 - 8, my, conW + 16, 56, 10, 'surface2', held.length ? 'warn' : 'line');
    text(tx({ en: 'IN MEMORY', vi: 'TRONG BỘ NHỚ' }), conX0, my + 12, 'warn', mono(9.5, 700));
    held.slice(0, 8).forEach((e, k) => chip(conX0 + (k % 4) * (cw + 3), my + 22 + Math.floor(k / 4) * 16, e.id, cw, 14, 'memory'));
    if (held.length > 8) text(`+${held.length - 8}`, conX0 + conW, my + 46, 'warn', mono(10, 700), 'right');
    if (!held.length) text(restarting ? tx({ en: 'wiped by the restart', vi: 'bị xoá khi khởi động lại' }) : tx({ en: 'empty', vi: 'trống' }), conX0, my + 32, restarting ? 'bad' : 'faint', mono(10, 600), 'left', conW);
  }
  let retryY = null;
  if (setup === 'dlq') {
    retryY = retryTop + 24 + 11;
    const b = f.retryBusy;
    box(conX0, retryTop + 18, conW, 34, 6, 'surface2', b ? 'violet' : 'line', 1, b ? 1.5 : 1);
    text(b ? `R · ${tx({ en: 'send', vi: 'gửi' })} #${b.id}` : tx({ en: 'R · retry consumer', vi: 'R · consumer retry' }), conX0 + conW / 2, retryTop + 35, b ? 'text' : 'faint', mono(9.5, 700), 'center', conW - 8);
    // The token bucket that caps every send.
    text(tx({ en: `≤ ${CAP} sends / s`, vi: `≤ ${CAP} lần gửi / giây` }), conX0 + conW / 2, top + 12, 'ok', mono(9.5, 700), 'center', conW + 20);
  }

  // The provider.
  const provY = midY;
  const acc = r.requests.filter(q => q.t > t - 1 && q.t <= t && q.code === 200).length;
  node(g, { x: provX, y: provY, w: provW, h: 128, title: tx({ en: 'SMS provider', vi: 'Nhà cung cấp SMS' }), icon: 'mail', color: 'ok', alert: down });
  text(down ? '503 · DOWN' : 'UP', provX, provY - 10, down ? 'warn' : 'ok', mono(13, 700), 'center');
  const bw = provW - 28, bx = provX - bw / 2, byy = provY + 14;
  box(bx, byy, bw, 8, 4, 'bg2');
  box(bx, byy, bw * Math.min(1, acc / LIMIT), 8, 4, acc >= LIMIT ? 'bad' : 'ok');
  text(tx({ en: `${acc} / ${LIMIT} this second`, vi: `${acc} / ${LIMIT} trong giây này` }), provX, byy + 22, acc >= LIMIT ? 'bad' : 'faint', mono(9.5, 600), 'center', provW - 10);
  const recent429 = r.requests.filter(q => q.code === 429 && q.t > t - 1 && q.t <= t).length;
  if (recent429) text(`429 × ${recent429}`, provX, byy + 40, 'bad', mono(11, 700), 'center');

  // Requests in flight: out to the provider, and the answer back.
  const sendOf = (b, y) => {
    if (!b) return;
    const pr = (t - b.t) / SEND, x0 = conX1 + 4, x1 = provX - provW / 2 - 4;
    if (pr < 0.5) chip(lerp(x0, x1, pr * 2) - cw / 2, y - 8, b.id, cw, 16, 'sending');
    else { const x = lerp(x1, x0, (pr - 0.5) * 2); box(x - 16, y - 8, 32, 16, 8, CODE[b.code]); text(String(b.code), x, y + 0.5, 'bg', mono(9.5, 700), 'center'); }
  };
  for (let p = 0; p < P; p++) {
    const y = laneTop + p * (laneH + laneGap) + laneH / 2;
    g.strokeStyle = css('line'); g.setLineDash([3, 4]); g.beginPath(); g.moveTo(conX1, y); g.lineTo(provX - provW / 2, provY); g.stroke(); g.setLineDash([]);
    sendOf(f.busy[p], lerp(y, provY, 0));
  }
  if (retryY) sendOf(f.retryBusy, retryY);

  // ---- Where every message ended up. ----
  const by0 = h - 128, bh = 54, binW = (w - 28 - 20) / 3;
  const bins = [
    ['delivered', 'ok', tx({ en: 'DELIVERED', vi: 'ĐÃ GỬI' }), tx({ en: 'the customer got the text', vi: 'khách đã nhận tin' })],
    ['dlq', 'violet', tx({ en: 'DEAD-LETTER QUEUE', vi: 'DEAD-LETTER QUEUE' }), tx({ en: 'kept, alerts on-call, replayable', vi: 'được giữ, báo người trực, phát lại được' })],
    ['lost', 'bad', tx({ en: 'LOST', vi: 'MẤT' }), tx({ en: 'only a log line says it existed', vi: 'chỉ còn một dòng log' })],
  ];
  bins.forEach(([state, color, title, sub], i) => {
    const x = 14 + i * (binW + 10), ids = msgs.filter((m, k) => f.states[k] === state).map(m => m.id);
    const unused = state === 'dlq' && setup !== 'dlq';
    box(x, by0, binW, bh, 10, 'surface2', ids.length && state !== 'delivered' ? color : 'line', unused ? 0.5 : 1, ids.length && state !== 'delivered' ? 1.5 : 1);
    text(title, x + 12, by0 + 14, unused ? 'faint' : color, mono(10, 700), 'left', binW - 70);
    text(String(ids.length), x + binW - 12, by0 + 16, unused ? 'faint' : ids.length && state !== 'delivered' ? color : 'text', mono(18, 700), 'right');
    if (state === 'delivered' || !ids.length) text(unused ? tx({ en: 'this setup has none', vi: 'cách này không có' }) : sub, x + 12, by0 + 36, 'faint', mono(9.5, 500), 'left', binW - 24);
    else {
      const per = Math.floor((binW - 24) / (cw + 3));
      ids.slice(-per).forEach((id, k) => chip(x + 12 + k * (cw + 3), by0 + 28, id, cw, 18, state));
    }
  });

  // ---- The constraints, live. ----
  const cy = h - 54, half = (w - 28 - 10) / 2;
  const seen = msgs.filter(m => m.t <= t);
  const lostNow = f.states.filter(s => s === 'lost').length;
  const delays = seen.filter(m => !(situation === 'poison' && m.id === POISON) && !['lost', 'dlq'].includes(f.states[m.id - 1]))
    .map(m => (f.states[m.id - 1] === 'delivered' ? m.at : t) - m.t);
  const lateNow = delays.filter(d => d > LATE).length, slowest = Math.round(Math.max(0, ...delays));
  const reqs = r.requests.filter(q => q.t <= t && q.code !== 503), rej = reqs.filter(q => q.code === 429).length;
  const share = reqs.length ? rej / reqs.length : 0;
  const poisonState = situation === 'poison' && t >= msgs[POISON - 1].t ? stateOf(POISON) : null;
  const checks = [
    [lostNow === 0, tx({ en: 'No message silently lost', vi: 'Không tin nào mất âm thầm' }), lostNow ? tx({ en: `${lostNow} lost`, vi: `mất ${lostNow}` }) : tx({ en: 'none so far', vi: 'chưa mất tin nào' })],
    [lateNow === 0, tx({ en: `Texts out within ${LATE} s`, vi: `Tin gửi đi trong ${LATE} giây` }), lateNow ? tx({ en: `${lateNow} late`, vi: `${lateNow} tin trễ` }) : tx({ en: `slowest so far ${slowest} s`, vi: `chậm nhất tới giờ ${slowest} giây` })],
    [share <= MAX_REJECT, tx({ en: '≤ 2% of requests over the limit', vi: '≤ 2% request vượt giới hạn' }), `${rej} × 429 (${(share * 100).toFixed(1)}%)`],
    [situation !== 'poison' || poisonState === 'dlq' || !poisonState ? true : false, tx({ en: 'A bad message reaches a person', vi: 'Tin hỏng tới tay một người' }),
      situation !== 'poison' ? tx({ en: 'no bad message here', vi: 'không có tin hỏng' }) : !poisonState ? tx({ en: 'not yet', vi: 'chưa tới' }) : poisonState === 'dlq' ? tx({ en: 'in the dead-letter queue', vi: 'trong dead-letter queue' }) : tx({ en: `#${POISON} is ${poisonState}`, vi: `#${POISON}: ${poisonState}` })],
  ];
  checks.forEach(([pass, what, detail], i) => {
    const x = 14 + (i % 2) * (half + 10), y = cy + Math.floor(i / 2) * 26;
    const color = pass ? 'ok' : 'bad';
    icon(g, pass ? 'check' : 'cross', x + 8, y + 9, 12, color);
    text(what, x + 22, y + 9, 'text', sans(11.5, 600), 'left', half * 0.55);
    text(detail, x + half - 4, y + 9, color, mono(9.5, 700), 'right', half * 0.42);
  });
}
