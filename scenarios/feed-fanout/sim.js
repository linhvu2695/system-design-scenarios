/* A home feed, a footballer with 1.5M followers, and five ways to deliver posts.

   On the left are the people posting: the footballer, and everyone else (about 2 posts
   a second, ~200 followers each, Lan among them). Below them are the people reading
   their feeds. In the middle is the write path (what one post costs) and the read path
   (what one feed read costs).

   On the right, two panels follow one post of each kind and one reader. "Who gets a
   copy" has a square per follower of Lan's post and per 5,000 followers of the
   footballer's, filled as copies land. "Minh opens the app" shows how Minh, who follows
   both, gets a feed: the timeline (copies pushed in), plus the hot list (read now),
   merged by time.

   Fanout on write (A, D) fills the squares as the workers copy each post into every
   timeline, Lan's queued behind the footballer's. Fanout on read (today, B) stores
   nothing ahead and merges ~250 accounts on a replica at every read. The hybrid (C)
   copies Lan's post into her 200 followers' timelines, writes the footballer's once to
   a hot list, and merges the two when Minh reads.

   A strip along the top plots each second's feed read p99 and how long the oldest
   post has been waiting to reach feeds. A checklist along the bottom ticks the three
   constraints.

   The model (run()) steps every 100 ms, deterministic; js/sim-player.js supplies the
   controls and scoreboard. */

import { tx } from '../../js/i18n.js';
import { css } from '../../js/sim-kit.js';
import { player } from '../../js/sim-player.js';
import { node, icon } from '../../js/sim-draw.js';

export const SETUPS = ['today', 'replicas', 'push', 'table', 'hybrid'];
export const SITUATIONS = ['evening', 'night', 'notify'];

export const DT = 0.1;
export const FOLLOWERS = 1_500_000;  // the footballer
export const TYPICAL = 200;          // followers of an ordinary account
export const FOLLOWING = 250;        // accounts a typical reader follows: one pull read merges them
export const THRESHOLD = 100_000;    // C: accounts above this are merged at read time
export const POST_EVERY = { evening: 0.5, night: 2, notify: 0.5 };   // seconds between ordinary posts
export const READS = { evening: 2500, night: 600, notify: 2500 };    // feed reads a second
export const PER_REPLICA = 1100;     // feed merges a second one read replica can serve
export const REPLICAS = { today: 4, replicas: 8 };
export const FANOUT = 25_000;        // A, C: timeline writes a second the cache cluster takes
export const ROWS = 10_000;          // D: feed-row writes a second the stream consumer manages
export const PULL = 0.03;            // seconds one merge takes on an idle replica
export const FETCH = { push: 0.006, table: 0.014, hybrid: 0.009 };   // seconds one feed read takes
export const TIMEOUT = 5;            // feed requests give up after 5 s
export const POST_AT = 10;           // the footballer posts at 0:10
export const LAN_AT = 15;            // Lan, an ordinary account, posts at 0:15
export const MINH = { lan: 120, star: 900_000 };   // where Minh, who follows both, sits in each follower list
export const OPENS = 450_000;        // followers who open the app from the notification
export const RAMP = 20;              // and the rush peaks 20 s after it goes out
export const END = { evening: 40, night: 100, notify: 130 };
// The constraints.
export const P99 = 0.2;              // feed reads: p99 under 200 ms, always
export const FRESH = 30;             // every post in its followers' feeds within 30 s

export const kind = setup => (setup === 'today' || setup === 'replicas' ? 'pull' : setup);

/* Reads a second the notification adds, s seconds after it goes out. */
export const rush = s => (s < 0 ? 0 : (OPENS / RAMP) * (s / RAMP) * Math.exp(-s / RAMP));

/* Run one situation through one setup. Pure; memoised, because the scoreboard asks often. */
const memo = new Map();
export function run(setup, situation) {
  const k = `${setup}:${situation}`;
  if (!memo.has(k)) memo.set(k, simulate(setup, situation));
  return memo.get(k);
}

function simulate(setup, situation) {
  const end = END[situation], how = kind(setup);
  const starPosts = situation !== 'evening';
  const pull = how === 'pull';
  const rate = how === 'table' ? ROWS : FANOUT;
  const cap = pull ? REPLICAS[setup] * PER_REPLICA : Infinity;
  const jobs = [];          // the fanout queue, FIFO: { post, left }
  const posts = [];         // ordinary posts: { at, lag }
  let star = null;          // the footballer's post: { at, lag, delivered }
  let lan = null;           // Lan's post, one ordinary post we follow: { at, lag, delivered }
  let backlog = 0;          // pull: merges waiting for a replica
  let opens = 0, missed = 0, peakReads = 0, maxRegLag = 0;
  const frames = [], perSec = [];
  let nextPost = POST_EVERY[situation] / 2;

  const steps = Math.round(end / DT);
  for (let n = 0; n <= steps; n++) {
    const t = +(n * DT).toFixed(4);
    // New posts.
    while (nextPost <= t + 1e-9) {
      const p = { at: nextPost, lag: pull ? 0 : null };
      posts.push(p);
      if (!pull) jobs.push({ post: p, left: TYPICAL });
      nextPost += POST_EVERY[situation];
    }
    if (starPosts && !star && t >= POST_AT - 1e-9) {
      star = { at: t, lag: null, delivered: 0 };
      if (how === 'push' || how === 'table') jobs.push({ post: star, left: FOLLOWERS });
      else { star.lag = 0; star.delivered = FOLLOWERS; }
    }
    if (!lan && t >= LAN_AT - 1e-9) {
      lan = { at: t, lag: pull ? 0 : null, delivered: pull ? TYPICAL : 0 };
      posts.push(lan);
      if (!pull) jobs.push({ post: lan, left: TYPICAL });
    }
    // The workers drain the queue in order.
    let budget = rate * DT;
    while (budget > 0 && jobs.length) {
      const j = jobs[0], k = Math.min(budget, j.left);
      j.left -= k; budget -= k;
      if (j.post === star) star.delivered = FOLLOWERS - j.left;
      if (j.post === lan) lan.delivered = TYPICAL - j.left;
      if (j.left <= 1e-6) {
        j.post.lag = t - j.post.at;
        if (j.post !== star) maxRegLag = Math.max(maxRegLag, j.post.lag);
        jobs.shift();
      }
    }
    // Reads: the evening's, plus the rush the notification brings.
    const extra = situation === 'notify' && star ? rush(t - POST_AT) : 0;
    const reads = READS[situation] + extra;
    peakReads = Math.max(peakReads, reads);
    opens += extra * DT;
    if (star && star.delivered < FOLLOWERS) missed += extra * DT * (1 - star.delivered / FOLLOWERS);
    let p99 = FETCH[how];
    if (pull) {
      backlog = Math.max(0, Math.min(cap * TIMEOUT, backlog + (reads - cap) * DT));
      p99 = Math.min(TIMEOUT, PULL / (1 - Math.min(reads / cap, 0.9)) + backlog / cap);
    }
    const oldestReg = jobs.find(j => j.post !== star);
    const waiting = jobs.length ? t - jobs[0].post.at : 0;
    const s = Math.floor(t);
    if (!perSec[s]) perSec[s] = { p99: 0, wait: 0, reads: 0 };
    perSec[s].p99 = Math.max(perSec[s].p99, p99);
    perSec[s].wait = Math.max(perSec[s].wait, waiting);
    perSec[s].reads = Math.max(perSec[s].reads, reads);

    if (n % 5 === 0) frames.push({
      t, p99, reads, backlog, cap, missed,
      queue: squash(jobs, star),
      delivered: star ? star.delivered : 0,
      posted: !!star,
      lanPosted: !!lan, lanDelivered: lan ? lan.delivered : 0,
      maxRegLag, oldestReg: oldestReg ? t - oldestReg.post.at : 0,
      regWaiting: jobs.filter(j => j.post !== star).length,
    });
  }

  // The scoreboard's facts. A post still undelivered at the end counts as late as the run.
  const lateness = p => (p.lag ?? end - p.at);
  const regLag = Math.max(0, ...posts.map(lateness));
  const starLag = star ? lateness(star) : 0;
  const maxP99 = Math.max(...perSec.map(x => x.p99));
  const checks = {
    reads: maxP99 <= P99,
    star: starLag <= FRESH,
    others: regLag <= FRESH,
  };
  const r = {
    setup, situation, end, how, rate, cap: pull ? REPLICAS[setup] * PER_REPLICA : 0,
    frames, strip: perSec, star, lan, starLag, starDone: !star || star.lag !== null, regLag, maxP99,
    peakReads, opens, missed, checks,
    ok: Object.values(checks).every(Boolean),
    at: t => frames[Math.max(0, Math.min(frames.length - 1, Math.round(t / (5 * DT))))],
  };
  r.steps = story(r);
  r.summary = summary(r);
  return r;
}

/* The queue, for the picture: the footballer's job, and runs of ordinary posts. */
function squash(jobs, star) {
  const out = [];
  for (const j of jobs) {
    const last = out[out.length - 1];
    if (j.post === star) out.push({ who: 'star', n: 1, left: j.left });
    else if (last && last.who === 'reg') { last.n++; last.left += j.left; }
    else out.push({ who: 'reg', n: 1, left: j.left });
  }
  return out;
}

export const survives = (setup, situation) => run(setup, situation).ok;

const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const secs = x => (x < 1 ? `${Math.round(x * 1000)} ms` : `${x < 10 ? x.toFixed(1) : Math.round(x)} s`);
export const count = n => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);

const LABEL = {
  today: { en: 'Fanout on read (today)', vi: 'Fanout on read (hiện tại)' },
  replicas: { en: 'On read + 8 replicas', vi: 'On read + 8 replica' },
  push: { en: 'Fanout on write', vi: 'Fanout on write' },
  table: { en: 'Feed table via stream', vi: 'Bảng feed qua stream' },
  hybrid: { en: 'Hybrid fanout', vi: 'Fanout hybrid' },
};

const SITUATION = {
  evening: { en: 'An ordinary evening', vi: 'Một buổi tối bình thường' },
  night: { en: 'Footballer posts at night', vi: 'Cầu thủ đăng bài lúc đêm' },
  notify: { en: 'Footballer posts, app notifies', vi: 'Cầu thủ đăng bài, app gửi thông báo' },
};

const HOW = {
  today: { en: 'Today: fanout on read. A post is one row in the posts table. Each feed read asks the 4 read replicas for recent posts from the ~250 accounts the reader follows, and merges them.', vi: 'Hiện tại: fanout on read. Một bài đăng là một dòng trong bảng posts. Mỗi lần đọc feed hỏi 4 read replica các bài mới của ~250 tài khoản người đọc theo dõi, rồi gộp lại.' },
  replicas: { en: 'B: still fanout on read, with 8 read replicas instead of 4.', vi: 'B: vẫn fanout on read, với 8 read replica thay vì 4.' },
  push: { en: 'A: fanout on write. Workers copy each new post into every follower’s timeline in the cache, at up to 25,000 writes a second. A feed read fetches one list.', vi: 'A: fanout on write. Worker chép mỗi bài mới vào timeline của từng follower trong cache, tối đa 25.000 lượt ghi mỗi giây. Một lần đọc feed lấy đúng một list.' },
  table: { en: 'D: a feed table. A stream consumer writes each post into every follower’s feed row in Postgres, at up to 10,000 rows a second. A feed read fetches one row.', vi: 'D: một bảng feed. Một consumer của stream ghi mỗi bài vào dòng feed của từng follower trong Postgres, tối đa 10.000 dòng mỗi giây. Một lần đọc feed lấy đúng một dòng.' },
  hybrid: { en: 'C: hybrid. Ordinary accounts fan out on write, as in A. Accounts over 100,000 followers write each post once, to their own hot list, which is merged into the feed when a follower reads.', vi: 'C: hybrid. Tài khoản thường fanout on write, như A. Tài khoản trên 100.000 follower ghi mỗi bài đúng một lần, vào hot list riêng, và list này được gộp vào feed khi follower đọc.' },
};

function story(r) {
  const { setup, situation, end, how } = r;
  const m = [];
  const add = (t0, t1, dur, tone, en, vi) => { if (t1 > t0 || !m.length) m.push({ t0, t1, dur, tone, say: { en, vi } }); };
  add(0, 0, 2.5, null, HOW[setup].en, HOW[setup].vi);
  const fetch = secs(FETCH[how] || 0);
  const unit = { push: ['list', 'list'], table: ['row', 'dòng'], hybrid: ['list', 'list'] }[how] || [];
  const copier = how === 'table' ? ['consumer', 'Consumer'] : ['workers', 'Worker'];
  const starLate = r.starDone
    ? [`after ${secs(r.starLag)}`, `sau ${secs(r.starLag)}`]
    : [`after more than ${secs(r.starLag)}: it was still going when we stopped`, `sau hơn ${secs(r.starLag)}: lúc dừng vẫn chưa xong`];
  const left40 = FOLLOWERS - r.at(POST_AT + FRESH).delivered;
  const lanLag = secs(r.lan.lag ?? end - r.lan.at);

  // What happens when Lan, an ordinary account, posts, and Minh opens the app.
  const lanQuiet = {
    pull: [`0:15: Lan posts. That is one row, nothing else. When Minh opens the app, a replica gathers the recent posts of all ~250 accounts Minh follows, Lan’s included, and merges them by time: p99 ${secs(r.maxP99)}.`, `0:15: Lan đăng bài. Đó là một dòng, không gì thêm. Khi Minh mở app, một replica gom các bài mới của cả ~250 tài khoản Minh theo dõi, gồm cả bài của Lan, rồi gộp theo thời gian: p99 ${secs(r.maxP99)}.`],
    push: [`0:15: Lan posts, and the ${copier[0]} copy it into each of her 200 followers’ feeds: 200 writes, done within a second. When Minh opens the app, the feed is Minh’s own ${unit[0]}, already in order: one read, p99 ${fetch}.`, `0:15: Lan đăng bài, và ${copier[1].toLowerCase()} chép nó vào feed của từng người trong 200 follower: 200 lượt ghi, xong trong vòng một giây. Khi Minh mở app, feed chính là ${unit[1]} của Minh, đã sắp sẵn theo thứ tự: một lượt đọc, p99 ${fetch}.`],
    hybrid: [`0:15: Lan posts. She is an ordinary account, so she is fanned out: 200 copies, one into each follower’s timeline, within a second. When Minh opens the app, the feed service reads two lists, Minh’s timeline and the footballer’s hot list, and merges them by time: p99 ${fetch}.`, `0:15: Lan đăng bài. Cô ấy là tài khoản thường, nên được fanout: 200 bản chép, mỗi bản vào timeline của một follower, trong vòng một giây. Khi Minh mở app, feed service đọc hai list, timeline của Minh và hot list của cầu thủ, rồi gộp theo thời gian: p99 ${fetch}.`],
  };
  lanQuiet.table = lanQuiet.push;

  if (situation === 'evening') {
    if (how === 'pull') {
      const pct = Math.round((READS.evening / r.cap) * 100);
      add(0, LAN_AT, 5, null, `An ordinary evening: 2 posts a second and 2,500 feed reads a second. Each post costs one write. Each read merges ~250 accounts, and the replicas run at ${pct}%.`, `Một buổi tối bình thường: 2 bài mỗi giây và 2.500 lượt đọc feed mỗi giây. Mỗi bài tốn một lượt ghi. Mỗi lượt đọc gộp ~250 tài khoản, và các replica chạy ở mức ${pct}%.`);
    } else {
      add(0, LAN_AT, 5, null, `An ordinary evening: 2 posts a second, each copied into ~200 feeds. That is about 400 writes a second against the ${count(r.rate)} available.`, `Một buổi tối bình thường: 2 bài mỗi giây, mỗi bài chép vào ~200 feed. Tức khoảng 400 lượt ghi mỗi giây trên ${count(r.rate)} cho phép.`);
    }
    add(LAN_AT, how === 'hybrid' ? 28 : end, 7, null, ...lanQuiet[how]);
    if (how === 'hybrid') add(28, end, 5, null, 'The footballer’s posts sit in the hot list, not in Minh’s timeline. The merge puts each one where its time says, so Minh sees one feed and cannot tell which list a post came from.', 'Bài của cầu thủ nằm trong hot list, không nằm trong timeline của Minh. Phép gộp đặt mỗi bài vào đúng chỗ theo thời gian, nên Minh thấy một feed duy nhất và không biết bài nào tới từ list nào.');
    return m;
  }

  add(0, POST_AT, 2, null, situation === 'night' ? 'Late at night: a post every 2 seconds, and 600 feed reads a second.' : 'An ordinary evening: 2,500 feed reads a second.', situation === 'night' ? 'Đêm khuya: cứ 2 giây một bài, và 600 lượt đọc feed mỗi giây.' : 'Một buổi tối bình thường: 2.500 lượt đọc feed mỗi giây.');
  const notify = situation === 'notify';

  if (how === 'pull') {
    add(POST_AT, LAN_AT, 4, notify ? 'warn' : null, ...(notify
      ? ['0:10: the footballer posts: one row. The app notifies 1.5M followers, and about 450,000 of them open the app over the next two minutes.', '0:10: cầu thủ đăng bài: một dòng. App gửi thông báo tới 1,5 triệu follower, và khoảng 450.000 người mở app trong hai phút sau đó.']
      : ['0:10: the footballer posts: one row in the posts table. Notifications are held overnight, so reads stay at 600 a second.', '0:10: cầu thủ đăng bài: một dòng trong bảng posts. Thông báo bị giữ lại qua đêm, nên lượt đọc vẫn ở mức 600 mỗi giây.']));
    if (notify) {
      add(LAN_AT, POST_AT + 60, 6, 'bad', setup === 'replicas'
        ? `0:15: Lan posts, one more row. Both posts would be in Minh’s feed at once, if the feed loaded. Reads peak at ${count(r.peakReads)} a second, each a merge across ~250 accounts. Twice the replicas serve ${count(r.cap)}, so the rush still beats them for half a minute and p99 reaches ${secs(r.maxP99)}. More replicas only move the cliff.`
        : `0:15: Lan posts, one more row. Both posts would be in Minh’s feed at once, if the feed loaded. Reads peak at ${count(r.peakReads)} a second, each a merge across ~250 accounts, and the 4 replicas manage ${count(r.cap)}. The queue grows until requests hit the 5-second timeout: p99 ${secs(r.maxP99)}.`,
      setup === 'replicas'
        ? `0:15: Lan đăng bài, thêm một dòng. Cả hai bài sẽ có ngay trong feed của Minh, nếu feed tải được. Lượt đọc đạt đỉnh ${count(r.peakReads)} mỗi giây, mỗi lượt gộp ~250 tài khoản. Gấp đôi replica phục vụ được ${count(r.cap)}, nên đợt dồn vẫn vượt qua chúng trong nửa phút và p99 lên tới ${secs(r.maxP99)}. Thêm replica chỉ dời vách đá đi chỗ khác.`
        : `0:15: Lan đăng bài, thêm một dòng. Cả hai bài sẽ có ngay trong feed của Minh, nếu feed tải được. Lượt đọc đạt đỉnh ${count(r.peakReads)} mỗi giây, mỗi lượt gộp ~250 tài khoản, và 4 replica chỉ kham được ${count(r.cap)}. Hàng đợi dài ra tới khi request chạm timeout 5 giây: p99 ${secs(r.maxP99)}.`);
      add(POST_AT + 60, end, 4, 'warn', 'The rush fades and the replicas catch up. No post was ever late: with nothing stored ahead, there was nothing to deliver. The feed just could not be built in time.', 'Đợt dồn lắng xuống và các replica đuổi kịp. Không bài nào từng bị trễ: không lưu gì trước thì cũng không có gì để giao. Chỉ là feed không dựng kịp.');
    } else {
      add(LAN_AT, end, 6, null, `0:15: Lan posts, one more row. When Minh opens the app, the replica merges the ~250 accounts Minh follows, and both posts are there at once, in time order. p99: ${secs(r.maxP99)}.`, `0:15: Lan đăng bài, thêm một dòng. Khi Minh mở app, replica gộp ~250 tài khoản Minh theo dõi, và cả hai bài có mặt ngay, đúng thứ tự thời gian. p99: ${secs(r.maxP99)}.`);
    }
    return m;
  }

  if (how === 'hybrid') {
    add(POST_AT, LAN_AT, 4, null, `0:10: the footballer posts. With over 100,000 followers, the post is written once, to the hot list, not copied 1.5M times.${notify ? ' The app notifies the followers.' : ''}`, `0:10: cầu thủ đăng bài. Với hơn 100.000 follower, bài được ghi một lần, vào hot list, chứ không chép 1,5 triệu lần.${notify ? ' App gửi thông báo tới các follower.' : ''}`);
    add(LAN_AT, POST_AT + FRESH, 6, null, '0:15: Lan posts. She is an ordinary account, so she is fanned out: 200 copies, one into each follower’s timeline, within a second. Nothing is ahead of her in the queue, because the footballer never entered it.', '0:15: Lan đăng bài. Cô ấy là tài khoản thường, nên được fanout: 200 bản chép, mỗi bản vào timeline của một follower, trong vòng một giây. Không có gì chắn trước cô ấy trong hàng đợi, vì cầu thủ chưa bao giờ vào đó.');
    add(POST_AT + FRESH, end, 6, null, `When Minh opens the app, the feed service reads Minh’s timeline (Lan’s post is in it) and the footballer’s hot list, and merges them by time: Lan’s post on top, the footballer’s just below. Two cache reads, p99 ${fetch}${notify ? `, even at ${count(r.peakReads)} reads a second` : ''}.`, `Khi Minh mở app, feed service đọc timeline của Minh (có bài của Lan) và hot list của cầu thủ, rồi gộp theo thời gian: bài của Lan trên cùng, bài của cầu thủ ngay bên dưới. Hai lượt đọc cache, p99 ${fetch}${notify ? `, kể cả ở mức ${count(r.peakReads)} lượt đọc mỗi giây` : ''}.`);
    return m;
  }

  // push, table
  add(POST_AT, LAN_AT, 4, 'warn', `0:10: the footballer posts. The ${copier[0]} must copy it into 1.5M feeds at ${count(r.rate)} a second: ${secs(FOLLOWERS / r.rate)} of work.${notify ? ' The app notifies the followers.' : ''}`, `0:10: cầu thủ đăng bài. ${copier[1]} phải chép nó vào 1,5 triệu feed với tốc độ ${count(r.rate)} mỗi giây: ${secs(FOLLOWERS / r.rate)} công việc.${notify ? ' App gửi thông báo tới các follower.' : ''}`);
  add(LAN_AT, POST_AT + FRESH, 6, 'bad', `0:15: Lan posts. Her 200 copies would take a fraction of a second, but they queue behind the footballer’s 1.5M. Minh opens the app: one ${unit[0]} read, p99 ${fetch}, but Minh’s ${unit[0]} has neither post yet. Minh is follower number 900,000 in the footballer’s list.`, `0:15: Lan đăng bài. 200 bản chép của cô ấy chỉ mất chưa tới một giây, nhưng chúng phải xếp sau 1,5 triệu bản của cầu thủ. Minh mở app: một lượt đọc ${unit[1]}, p99 ${fetch}, nhưng ${unit[1]} của Minh chưa có bài nào trong hai bài. Minh là follower thứ 900.000 trong danh sách của cầu thủ.`);
  add(POST_AT + FRESH, end, 6, 'bad', notify
    ? `Fast reads of the wrong feed: ${count(r.missed)} followers opened the app from the notification before their copy arrived. The footballer’s post reached the last follower ${starLate[0]}, and Lan’s, stuck behind it, after ${lanLag}.`
    : `0:40: past the 30-second limit, and ${count(left40)} followers still don’t have the footballer’s post. It reached the last one ${starLate[0]}. Lan’s post, stuck behind it, took ${lanLag}.`,
  notify
    ? `Đọc nhanh, nhưng feed thiếu bài: ${count(r.missed)} follower mở app từ thông báo trước khi bản chép của họ tới. Bài của cầu thủ tới follower cuối cùng ${starLate[1]}, còn bài của Lan, kẹt phía sau, mất ${lanLag}.`
    : `0:40: đã quá giới hạn 30 giây, và ${count(left40)} follower vẫn chưa có bài của cầu thủ. Nó tới follower cuối cùng ${starLate[1]}. Bài của Lan, kẹt phía sau, mất ${lanLag}.`);
  return m;
}

function summary(r) {
  if (r.ok) return {
    evening: { en: 'Fast reads, and every post in its followers’ feeds within a second.', vi: 'Đọc nhanh, và bài nào cũng vào feed của follower trong vòng một giây.' },
    night: { en: 'The footballer’s post was in every feed at once, and reads stayed fast.', vi: 'Bài của cầu thủ có mặt trong mọi feed ngay lập tức, và lượt đọc vẫn nhanh.' },
    notify: { en: 'All three held: one write for the footballer, two cache reads per feed, and nothing queued behind anyone.', vi: 'Cả ba đều đạt: một lượt ghi cho cầu thủ, hai lượt đọc cache cho mỗi feed, và không ai phải xếp hàng sau ai.' },
  }[r.situation];
  const c = r.checks, en = [], vi = [];
  if (!c.reads) { en.push(`Feed p99 reached ${secs(r.maxP99)} as ${count(r.peakReads)} reads a second each merged ~250 accounts.`); vi.push(`p99 của feed lên tới ${secs(r.maxP99)} khi ${count(r.peakReads)} lượt đọc mỗi giây đều phải gộp ~250 tài khoản.`); }
  if (!c.star) { en.push(r.starDone ? `The footballer’s post took ${secs(r.starLag)} to reach every follower.` : `The footballer’s post still hadn’t reached every follower after ${secs(r.starLag)}.`); vi.push(r.starDone ? `Bài của cầu thủ mất ${secs(r.starLag)} để tới mọi follower.` : `Sau ${secs(r.starLag)}, bài của cầu thủ vẫn chưa tới hết follower.`); }
  if (!c.others) { en.push(`Ordinary posts waited up to ${secs(r.regLag)} behind it.`); vi.push(`Bài thường chờ phía sau nó tới ${secs(r.regLag)}.`); }
  return { en: `Broken: ${en.join(' ')}`, vi: `Hỏng: ${vi.join(' ')}` };
}

export function mount(root, ctx) {
  let cached = null;   // the player asks for each run once; the drawing reads the same result
  return player(root, ctx, {
    situations: SITUATIONS.map(x => ({ value: x, label: tx(SITUATION[x]), icon: { evening: 'sun', night: 'moon', notify: 'mail' }[x], tone: x === 'evening' ? 'ok' : undefined })),
    setups: SETUPS.map(x => ({ value: x, label: tx(LABEL[x]), icon: { today: 'db', replicas: 'layers', push: 'flow', table: 'list', hybrid: 'filter' }[x] })),
    initial: { situation: 'notify' },
    run: (setup, situation) => (cached = run(setup, situation)),
    survives, height: 700,
    duration: st => st.dur,
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
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const PER_SQUARE = 5000;

function draw(g, w, h, r, t) {
  const { how, situation } = r;
  const f = r.at(t);
  const pull = how === 'pull';
  g.clearRect(0, 0, w, h);
  g.textBaseline = 'middle';
  const text = (s, x, y, color = 'muted', font = mono(10, 400), align = 'left', max) => {
    g.font = font; g.textAlign = align; g.fillStyle = css(color); g.fillText(s, x, y, max);
  };
  const box = (x, y, bw, bh, rad, fill, stroke, alpha = 1, lw = 1) => {
    g.beginPath(); g.roundRect(x, y, Math.max(0, bw), Math.max(0, bh), rad);
    if (fill) { g.globalAlpha = alpha; g.fillStyle = css(fill); g.fill(); g.globalAlpha = 1; }
    if (stroke) { g.lineWidth = lw; g.strokeStyle = css(stroke); g.stroke(); g.lineWidth = 1; }
  };
  const line = (x1, y1, x2, y2, color, alpha = 1, lw = 1, dash) => {
    g.save(); g.globalAlpha = alpha; g.strokeStyle = css(color); g.lineWidth = lw; if (dash) g.setLineDash(dash);
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); g.restore();
  };
  const posted = situation !== 'evening' && t >= POST_AT;
  const since = t - POST_AT;

  // ---- The strip: feed read p99, and how long the oldest post has waited to reach feeds. ----
  const sx0 = 168, sx1 = w - 14, X = s => sx0 + (s / r.end) * (sx1 - sx0);
  const rows = [[12, 38], [44, 70]];
  const labels = [
    [tx({ en: 'feed read p99', vi: 'p99 đọc feed' }), '- - 200 ms'],
    [tx({ en: 'waiting for feeds', vi: 'chờ vào feed' }), '- - 30 s'],
  ];
  labels.forEach(([a, b], i) => { text(a.toUpperCase(), 12, rows[i][0] + 7, 'muted', mono(9.5, 700)); text(b, 12, rows[i][0] + 19, 'bad', mono(9, 600)); });
  rows.forEach(([a, b]) => box(sx0, a, sx1 - sx0, b - a, 4, 'bg2', null, 0.8));
  const Ylat = (v, [a, b]) => b - (Math.log10(clamp(v * 1000, 1, 5000)) / Math.log10(5000)) * (b - a - 3);
  const Ywait = (v, [a, b]) => b - (Math.min(v, 120) / 120) * (b - a - 3);
  const bw = (sx1 - sx0) / r.end;
  r.strip.forEach((x, s) => {
    if (s + 1 > t) return;
    const xs = X(s) + 0.5, ww = Math.max(1, bw - 1);
    let y = Ylat(x.p99, rows[0]); box(xs, y, ww, rows[0][1] - y, 1, x.p99 > P99 ? 'bad' : 'ok', null, 0.85);
    y = Ywait(x.wait, rows[1]); box(xs, y, ww, rows[1][1] - y, 1, x.wait > FRESH ? 'bad' : 'ok', null, 0.85);
  });
  line(sx0, Ylat(P99, rows[0]), sx1, Ylat(P99, rows[0]), 'bad', 0.7, 1, [4, 4]);
  line(sx0, Ywait(FRESH, rows[1]), sx1, Ywait(FRESH, rows[1]), 'bad', 0.7, 1, [4, 4]);
  if (situation !== 'evening') {
    line(X(POST_AT), rows[0][0] - 3, X(POST_AT), rows[1][1] + 3, 'pink', 0.9, 1.5);
    text(situation === 'notify' ? tx({ en: 'post + notification', vi: 'đăng bài + thông báo' }) : tx({ en: 'post', vi: 'đăng bài' }), X(POST_AT) + 4, rows[1][1] + 9, 'pink', mono(8.5, 600));
  }
  line(X(t), rows[0][0] - 3, X(t), rows[1][1] + 3, 'text', 0.6);
  text(clock(t), clamp(X(t), sx0 + 14, sx1 - 14), rows[1][1] + 20, 'text', mono(9.5, 600), 'center');

  // ---- Layout. ----
  const top = 104, bot = h - 76;
  const c1x = 14, c1w = clamp(w * 0.17, 120, 160);
  const c2x = c1x + c1w + 30, c2w = clamp(w * 0.28, 180, 260);
  const c3x = c2x + c2w + 30, c3w = w - 14 - c3x;
  const mid = (top + bot) / 2;

  // Left: who posts, who reads.
  const nh = 78;
  const starY = top + nh / 2, regY = starY + nh / 2 + 12 + 46, readY = bot - nh / 2;
  const justPosted = posted && since < 2.5;
  node(g, { x: c1x + c1w / 2, y: starY, w: c1w, h: nh, title: tx({ en: 'Footballer', vi: 'Cầu thủ' }), icon: 'user', color: 'pink', active: justPosted });
  text(tx({ en: '1.5M followers', vi: '1,5 triệu follower' }), c1x + 12, starY + 8, 'pink', mono(10.5, 700));
  text(situation === 'evening' ? tx({ en: 'not posting', vi: 'không đăng bài' }) : posted ? tx({ en: `posted at ${clock(POST_AT)}`, vi: `đăng lúc ${clock(POST_AT)}` }) : tx({ en: `posts at ${clock(POST_AT)}`, vi: `đăng lúc ${clock(POST_AT)}` }), c1x + 12, starY + 25, 'muted', mono(9.5, 500));
  node(g, { x: c1x + c1w / 2, y: regY, w: c1w, h: 92, title: tx({ en: 'Everyone else', vi: 'Mọi người khác' }), icon: 'user', color: 'blue', active: f.lanPosted && t - LAN_AT < 2.5 });
  text(tx({ en: '~200 followers each', vi: '~200 follower mỗi người' }), c1x + 12, regY + 8, 'blue', mono(9.5, 700), 'left', c1w - 20);
  text(tx({ en: `a post every ${POST_EVERY[situation]} s`, vi: `${POST_EVERY[situation]} giây một bài` }), c1x + 12, regY + 25, 'muted', mono(9.5, 500), 'left', c1w - 20);
  text(tx({ en: `incl. Lan at ${clock(LAN_AT)}`, vi: `có Lan lúc ${clock(LAN_AT)}` }), c1x + 12, regY + 39, 'blue', mono(9.5, 600), 'left', c1w - 20);
  const rushing = f.reads > READS[situation] * 1.2;
  node(g, { x: c1x + c1w / 2, y: readY, w: c1w, h: nh, title: tx({ en: 'Feed reads', vi: 'Lượt đọc feed' }), icon: 'user', color: 'text', active: rushing });
  text(tx({ en: `${count(f.reads)} / s`, vi: `${count(f.reads)} / giây` }), c1x + 12, readY + 8, rushing ? 'warn' : 'text', mono(12, 700));
  text(rushing ? tx({ en: 'notification rush', vi: 'đợt dồn từ thông báo' }) : tx({ en: 'people opening the app', vi: 'người mở app' }), c1x + 12, readY + 25, 'muted', mono(9, 500), 'left', c1w - 20);

  // Middle top: the write path.
  const wTop = top, wBot = mid - 6, wY = (wTop + wBot) / 2, wH = wBot - wTop;
  const ix0 = c2x + 14, ix1 = c2x + c2w - 14;
  const queued = f.queue.reduce((a, j) => a + j.left, 0);
  const starQueued = f.queue.some(j => j.who === 'star');
  if (pull) {
    node(g, { x: c2x + c2w / 2, y: wY, w: c2w, h: wH, title: tx({ en: 'Posts table', vi: 'Bảng posts' }), icon: 'db', color: 'text' });
    text(tx({ en: '1 write per post', vi: '1 lượt ghi mỗi bài' }), ix0, wTop + 52, 'ok', mono(11, 700));
    text(tx({ en: 'no fanout: nothing is', vi: 'không fanout: không có gì' }), ix0, wTop + 74, 'muted', mono(9.5, 500), 'left', c2w - 28);
    text(tx({ en: 'copied ahead of reads', vi: 'được chép trước khi đọc' }), ix0, wTop + 88, 'muted', mono(9.5, 500), 'left', c2w - 28);
    if (posted) text(tx({ en: 'footballer’s post: 1 row', vi: 'bài của cầu thủ: 1 dòng' }), ix0, wBot - 18, 'pink', mono(9.5, 700), 'left', c2w - 28);
  } else {
    const title = how === 'table' ? tx({ en: 'Stream → feed table', vi: 'Stream → bảng feed' }) : tx({ en: 'Fanout workers', vi: 'Worker fanout' });
    node(g, { x: c2x + c2w / 2, y: wY, w: c2w, h: wH, title, icon: how === 'table' ? 'table' : 'gear', color: starQueued ? 'pink' : 'blue', alert: f.oldestReg > FRESH });
    text(tx({ en: `${count(r.rate)} writes / s, in order`, vi: `${count(r.rate)} lượt ghi / giây, theo thứ tự` }), ix0, wTop + 46, 'muted', mono(9.5, 600), 'left', c2w - 28);
    // The queue: head on the right, nearest the feeds.
    const qy = wTop + 62, qh = 18, scale = (ix1 - ix0) / Math.max(FOLLOWERS, queued);
    box(ix0, qy, ix1 - ix0, qh, 5, 'bg2', 'line', 1);
    let cum = 0;
    for (const j of f.queue) {
      const xr = ix1 - cum * scale;
      if (j.who === 'star') {
        const ww = Math.max(3, j.left * scale);
        box(xr - ww, qy + 2, ww, qh - 4, 4, 'pink', null, 0.85);
        cum += j.left;
      } else {
        const ww = Math.min(Math.max(4, j.n), 36);
        box(xr - ww - (cum ? 2 : 0), qy + 3, ww, qh - 6, 3, 'blue', null, 0.9);
        cum += j.left + ww / scale;
      }
    }
    text(tx({ en: 'next →', vi: 'kế tiếp →' }), ix1, qy - 8, 'faint', mono(8.5, 600), 'right');
    const clears = queued / r.rate;
    text(queued > 1000
      ? tx({ en: `${count(queued)} writes queued · ${secs(clears)} to clear`, vi: `${count(queued)} lượt ghi đang chờ · ${secs(clears)} mới hết` })
      : tx({ en: 'queue empty', vi: 'hàng đợi trống' }), ix0, qy + qh + 14, queued > 1000 ? 'pink' : 'ok', mono(9.5, 700), 'left', c2w - 28);
    if (starQueued && f.regWaiting) text(tx({ en: `${f.regWaiting} ordinary posts stuck behind`, vi: `${f.regWaiting} bài thường kẹt phía sau` }), ix0, qy + qh + 30, f.oldestReg > FRESH ? 'bad' : 'blue', mono(9.5, 600), 'left', c2w - 28);
    else if (how === 'hybrid' && posted) text(tx({ en: 'footballer skipped: over 100k', vi: 'bỏ qua cầu thủ: trên 100k' }), ix0, qy + qh + 30, 'pink', mono(9.5, 600), 'left', c2w - 28);
    else text(tx({ en: '~200 writes per ordinary post', vi: '~200 lượt ghi mỗi bài thường' }), ix0, qy + qh + 30, 'muted', mono(9.5, 500), 'left', c2w - 28);
  }

  // Middle bottom: the read path.
  const rTop = mid + 6, rBot = bot, rY = (rTop + rBot) / 2, rH = rBot - rTop;
  let readColor = f.p99 > P99 ? 'bad' : 'ok';
  if (pull) {
    const load = f.reads / f.cap;
    node(g, { x: c2x + c2w / 2, y: rY, w: c2w, h: rH, title: tx({ en: `Read replicas × ${REPLICAS[r.setup]}`, vi: `Read replica × ${REPLICAS[r.setup]}` }), icon: 'db', color: readColor, alert: load > 1 });
    text(tx({ en: `each read merges ~${FOLLOWING} accounts`, vi: `mỗi lượt đọc gộp ~${FOLLOWING} tài khoản` }), ix0, rTop + 46, 'muted', mono(9.5, 500), 'left', c2w - 28);
    const by = rTop + 62;
    box(ix0, by, ix1 - ix0, 12, 4, 'bg2', 'line', 1);
    box(ix0, by, (ix1 - ix0) * clamp(load, 0, 1), 12, 4, load > 0.9 ? 'bad' : load > 0.7 ? 'warn' : 'ok', null, 0.85);
    text(tx({ en: `${count(f.reads)} of ${count(f.cap)} merges / s`, vi: `${count(f.reads)} / ${count(f.cap)} lượt gộp / giây` }), ix0, by + 26, load > 1 ? 'bad' : 'text', mono(10, 700), 'left', c2w - 28);
    text(f.backlog > 1 ? tx({ en: `${count(f.backlog)} waiting · p99 ${secs(f.p99)}`, vi: `${count(f.backlog)} đang chờ · p99 ${secs(f.p99)}` }) : tx({ en: `p99 ${secs(f.p99)}`, vi: `p99 ${secs(f.p99)}` }), ix0, by + 44, readColor, mono(10, 700), 'left', c2w - 28);
  } else {
    const title = { push: tx({ en: 'Timeline cache', vi: 'Cache timeline' }), table: tx({ en: 'Feed table', vi: 'Bảng feed' }), hybrid: tx({ en: 'Timelines + hot list', vi: 'Timeline + hot list' }) }[how];
    node(g, { x: c2x + c2w / 2, y: rY, w: c2w, h: rH, title, icon: how === 'table' ? 'table' : 'db', color: readColor });
    text({ push: tx({ en: '1 list per feed read', vi: '1 list mỗi lượt đọc feed' }), table: tx({ en: '1 row per feed read', vi: '1 dòng mỗi lượt đọc feed' }), hybrid: tx({ en: 'your timeline + hot list', vi: 'timeline của bạn + hot list' }) }[how], ix0, rTop + 46, 'muted', mono(9.5, 500), 'left', c2w - 28);
    text(tx({ en: `p99 ${secs(f.p99)}`, vi: `p99 ${secs(f.p99)}` }), ix0, rTop + 66, readColor, mono(12, 700));
    if (how !== 'hybrid' && f.missed > 1) {
      text(tx({ en: 'notified, opened the app,', vi: 'nhận thông báo, mở app,' }), ix0, rTop + 92, 'muted', mono(9.5, 500), 'left', c2w - 28);
      text(tx({ en: `post not there yet: ${count(f.missed)}`, vi: `bài chưa có trong feed: ${count(f.missed)}` }), ix0, rTop + 108, 'bad', mono(10.5, 700), 'left', c2w - 28);
    }
    if (how === 'hybrid') {
      // The hot list: the footballer's recent posts, written once.
      const hy = rTop + 84;
      text(tx({ en: 'HOT LIST · FOOTBALLER', vi: 'HOT LIST · CẦU THỦ' }), ix0, hy, 'pink', mono(8.5, 700));
      box(ix0, hy + 8, ix1 - ix0, 22, 5, 'pink', 'pink', 0.06, 1);
      for (let i = 0; i < 4; i++) box(ix0 + 4 + i * 26, hy + 12, 22, 14, 3, 'pink', null, i === 0 && !posted ? 0 : 0.35 + (i === 0 ? 0.5 : 0));
      if (posted) text(tx({ en: 'new · 1 write', vi: 'mới · 1 lượt ghi' }), ix0 + 112, hy + 19, 'pink', mono(9, 700), 'left', ix1 - ix0 - 116);
    }
  }

  // Right top: who gets a copy of Lan's post and of the footballer's.
  const pTop = top, pBot = top + 236;
  const lanPosted = f.lanPosted, lanSince = t - LAN_AT;
  node(g, { x: c3x + c3w / 2, y: (pTop + pBot) / 2, w: c3w, h: pBot - pTop, title: tx({ en: 'Who gets a copy', vi: 'Ai nhận bản chép' }), icon: 'table', color: 'text' });
  const gx0 = c3x + 14, gx1 = c3x + c3w - 14, gap = 18;
  box(gx1 - 52, pTop + 13, 11, 11, 2, null, 'text', 1, 1.5);
  text('Minh', gx1, pTop + 19, 'text', mono(9.5, 700), 'right');
  const lw = Math.floor((gx1 - gx0 - gap) * 0.36), sx = gx0 + lw + gap, sw = gx1 - sx;
  const ly = pTop + 46;
  text(tx({ en: 'LAN’S POST', vi: 'BÀI CỦA LAN' }), gx0, ly, 'blue', mono(9, 700), 'left', lw);
  text(tx({ en: '1 square = 1 follower', vi: '1 ô = 1 follower' }), gx0, ly + 13, 'faint', mono(8.5, 500), 'left', lw);
  text(tx({ en: 'FOOTBALLER’S POST', vi: 'BÀI CỦA CẦU THỦ' }), sx, ly, 'pink', mono(9, 700), 'left', sw);
  text(tx({ en: `1 square = ${count(PER_SQUARE)} followers`, vi: `1 ô = ${count(PER_SQUARE)} follower` }), sx, ly + 13, 'faint', mono(8.5, 500), 'left', sw);
  const gTop = ly + 24, gMax = pBot - 40 - gTop;
  // A grid of followers: n filled squares out of cols × rows, Minh's square outlined.
  const grid = (x0, cols, rowsN, cell, filled, color, late, minh) => {
    for (let i = 0; i < cols * rowsN; i++) {
      const x = x0 + (i % cols) * cell, y = gTop + Math.floor(i / cols) * cell;
      if (i < Math.floor(filled)) box(x + 1, y + 1, cell - 2, cell - 2, 2, color, null, 0.85);
      else {
        box(x + 1, y + 1, cell - 2, cell - 2, 2, late ? 'bad' : 'bg2', null, late ? 0.18 : 1);
        if (i < filled) box(x + 1, y + 1, (cell - 2) * (filled - i), cell - 2, 2, color, null, 0.85);
      }
      if (i === minh) box(x, y, cell, cell, 3, null, 'text', 1, 1.5);
    }
    return gTop + rowsN * cell;
  };
  const lcell = Math.max(3, Math.floor(Math.min(lw / 10, gMax / 20)));
  const scell = Math.max(3, Math.floor(Math.min(sw / 20, gMax / 15)));
  const copiesLan = pull ? 0 : f.lanDelivered;
  grid(gx0, 10, 20, lcell, lanPosted ? copiesLan : 0, 'blue', !pull && lanPosted && lanSince > FRESH, Math.floor(MINH.lan));
  const copiesStar = how === 'push' || how === 'table' ? f.delivered : 0;
  const sEnd = grid(sx, 20, 15, scell, posted ? copiesStar / PER_SQUARE : 0, 'pink', copiesStar < FOLLOWERS && posted && since > FRESH && (how === 'push' || how === 'table'), Math.floor(MINH.star / PER_SQUARE));
  if (posted && (pull || how === 'hybrid')) {
    const cy = (gTop + sEnd) / 2, cx = sx + Math.min(sw, 20 * scell) / 2;
    box(cx - 64, cy - 15, 128, 30, 7, 'surface2', 'line', 0.95);
    text(pull ? tx({ en: '0 copies', vi: '0 bản chép' }) : tx({ en: '0 copies → hot list', vi: '0 bản chép → hot list' }), cx, cy + 1, pull ? 'muted' : 'pink', mono(10, 700), 'center', 120);
  }
  // Status under each grid.
  const st = (s, x, color, max) => text(s, x, pBot - 22, color, mono(9.5, 700), 'left', max);
  if (!lanPosted) st(tx({ en: `posts at ${clock(LAN_AT)}`, vi: `đăng lúc ${clock(LAN_AT)}` }), gx0, 'muted', lw + 10);
  else if (pull) st(tx({ en: '0 copies', vi: '0 bản chép' }), gx0, 'muted', lw + 10);
  else if (f.lanDelivered >= TYPICAL) st(r.lan.lag < 1 ? tx({ en: '200 copies · < 1 s', vi: '200 bản · < 1 giây' }) : tx({ en: `200 copies · ${secs(r.lan.lag)}`, vi: `200 bản · ${secs(r.lan.lag)}` }), gx0, r.lan.lag > FRESH ? 'bad' : 'blue', lw + 10);
  else st(tx({ en: `waiting ${Math.floor(lanSince)} s`, vi: `chờ ${Math.floor(lanSince)} giây` }), gx0, lanSince > FRESH ? 'bad' : 'warn', lw + 10);
  let status = '', statusColor = 'muted';
  if (!posted) status = situation === 'evening' ? tx({ en: 'no new post tonight', vi: 'tối nay không có bài mới' }) : tx({ en: `posts at ${clock(POST_AT)}`, vi: `đăng lúc ${clock(POST_AT)}` });
  else if (pull) { status = tx({ en: 'built at read time', vi: 'dựng lúc đọc' }); statusColor = 'ok'; }
  else if (how === 'hybrid') { status = tx({ en: '1 write, read by everyone', vi: '1 lượt ghi, ai cũng đọc' }); statusColor = 'pink'; }
  else if (f.delivered >= FOLLOWERS) { status = tx({ en: `1.5M copies · ${secs(r.starLag)}`, vi: `1,5 triệu bản · ${secs(r.starLag)}` }); statusColor = r.starLag > FRESH ? 'bad' : 'ok'; }
  else { status = tx({ en: `${count(f.delivered)} of 1.5M · ${Math.floor(since)} s`, vi: `${count(f.delivered)} / 1,5 triệu · ${Math.floor(since)} giây` }); statusColor = since > FRESH ? 'bad' : 'pink'; }
  st(status, sx, statusColor, sw);

  // Right bottom: Minh opens the app, and the feed is put together.
  const mTop = pBot + 12, mBot = bot;
  const loading = pull && f.p99 > 1;
  node(g, { x: c3x + c3w / 2, y: (mTop + mBot) / 2, w: c3w, h: mBot - mTop, title: tx({ en: 'Minh opens the app', vi: 'Minh mở app' }), icon: 'user', color: f.p99 > P99 ? 'bad' : 'text' });
  text(tx({ en: 'follows Lan, the footballer and ~248 others', vi: 'theo dõi Lan, cầu thủ và ~248 người khác' }), gx0, mTop + 44, 'faint', mono(9, 500), 'left', c3w - 28);
  const OLD = [{ who: 'Huy', at: -50 }, { who: 'Mai', at: -170 }, { who: 'Tú', at: -420 }];
  const starOld = { who: 'star', at: -7200 }, starNew = { who: 'star', at: POST_AT }, lanPost = { who: 'Lan', at: LAN_AT };
  const lanHere = lanPosted && (pull || f.lanDelivered > MINH.lan);
  const copied = how === 'push' || how === 'table';
  const starHere = posted && (!copied || f.delivered > MINH.star);
  const colA = [...OLD], colB = [];
  if (lanHere) colA.push(lanPost);
  else if (lanPosted) colA.push({ ...lanPost, ghost: true });
  if (how === 'hybrid') { colB.push(starOld); if (posted) colB.push(starNew); }
  else { colA.push(starOld); if (posted) colA.push(starHere ? starNew : { ...starNew, ghost: true }); }
  const byTime = (a, b) => b.at - a.at;
  colA.sort(byTime); colB.sort(byTime);
  const feed = [...colA, ...colB].filter(x => !x.ghost).sort(byTime);

  const sign = 16, cw3 = (gx1 - gx0 - 2 * sign) / 3;
  const cx = [gx0, gx0 + cw3 + sign, gx0 + 2 * (cw3 + sign)];
  const hy = mTop + 64, iy = mTop + 86, rowH = 24, shown = 5;
  const heads = [
    pull ? tx({ en: '~250 ACCOUNTS', vi: '~250 TÀI KHOẢN' }) : how === 'table' ? tx({ en: 'FEED ROW', vi: 'DÒNG FEED' }) : tx({ en: 'TIMELINE', vi: 'TIMELINE' }),
    tx({ en: 'HOT LIST', vi: 'HOT LIST' }),
    tx({ en: 'FEED, BY TIME', vi: 'FEED, THEO GIỜ' }),
  ];
  const subs = [
    pull ? tx({ en: 'merged on a replica', vi: 'gộp trên replica' }) : tx({ en: 'copies pushed in', vi: 'bản chép được đẩy vào' }),
    how === 'hybrid' ? tx({ en: 'read now', vi: 'đọc lúc này' }) : '',
    tx({ en: 'what Minh sees', vi: 'Minh nhìn thấy' }),
  ];
  heads.forEach((s, i) => { text(s, cx[i], hy, i === 1 ? (how === 'hybrid' ? 'pink' : 'faint') : i === 0 ? 'blue' : 'text', mono(8.5, 700), 'left', cw3); text(subs[i], cx[i], hy + 11, 'faint', mono(8, 500), 'left', cw3); });
  const ago = s => (s < 1 ? tx({ en: 'now', vi: 'vừa xong' }) : s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`);
  const chip = (x, y, it, dim) => {
    const color = it.who === 'star' ? 'pink' : it.who === 'Lan' ? 'blue' : 'muted';
    const name = it.who === 'star' ? tx({ en: 'Footballer', vi: 'Cầu thủ' }) : it.who;
    if (it.ghost) {
      g.save(); g.setLineDash([3, 3]); box(x, y, cw3, rowH - 4, 5, null, 'bad', 1, 1); g.restore();
      text(name, x + 7, y + 10, 'bad', sans(10.5, 600), 'left', cw3 - 50);
      text(tx({ en: 'not yet', vi: 'chưa tới' }), x + cw3 - 6, y + 10, 'bad', mono(8.5, 600), 'right');
      return;
    }
    g.globalAlpha = dim ? 0.35 : 1;
    box(x, y, cw3, rowH - 4, 5, color, null, 0.14);
    box(x, y, 3, rowH - 4, 2, color, null, 0.9);
    text(name, x + 8, y + 10, color === 'muted' ? 'text' : color, sans(10.5, 600), 'left', cw3 - 44);
    text(ago(t - it.at), x + cw3 - 6, y + 10, 'muted', mono(9, 500), 'right');
    g.globalAlpha = 1;
  };
  colA.slice(0, shown).forEach((it, i) => chip(cx[0], iy + i * rowH, it));
  if (how === 'hybrid') colB.slice(0, shown).forEach((it, i) => chip(cx[1], iy + i * rowH, it));
  else {
    g.save(); g.setLineDash([4, 4]); box(cx[1], iy, cw3, shown * rowH - 4, 6, null, 'line', 1, 1); g.restore();
    text(tx({ en: 'none', vi: 'không có' }), cx[1] + cw3 / 2, iy + (shown * rowH) / 2 - 8, 'faint', mono(9, 600), 'center');
    text(pull ? tx({ en: 'all merged at read', vi: 'gộp hết lúc đọc' }) : tx({ en: 'all copied ahead', vi: 'chép hết từ trước' }), cx[1] + cw3 / 2, iy + (shown * rowH) / 2 + 6, 'faint', mono(8.5, 500), 'center', cw3 - 8);
  }
  feed.slice(0, shown).forEach((it, i) => chip(cx[2], iy + i * rowH, it, loading));
  if (loading) {
    const cy = iy + (shown * rowH) / 2;
    box(cx[2] + 4, cy - 16, cw3 - 8, 32, 6, 'surface2', 'bad', 0.95);
    text(tx({ en: `loading… ${secs(f.p99)}`, vi: `đang tải… ${secs(f.p99)}` }), cx[2] + cw3 / 2, cy + 1, 'bad', mono(10, 700), 'center', cw3 - 12);
  }
  text('+', cx[1] - sign / 2, iy + (shown * rowH) / 2 - 2, 'text', mono(15, 700), 'center');
  text('=', cx[2] - sign / 2, iy + (shown * rowH) / 2 - 2, 'text', mono(15, 700), 'center');
  // What the read cost, and what is missing.
  const cost = {
    pull: tx({ en: `a merge of ~250 accounts on a replica · p99 ${secs(f.p99)}`, vi: `gộp ~250 tài khoản trên replica · p99 ${secs(f.p99)}` }),
    push: tx({ en: `1 list read · p99 ${secs(f.p99)}`, vi: `đọc 1 list · p99 ${secs(f.p99)}` }),
    table: tx({ en: `1 row read · p99 ${secs(f.p99)}`, vi: `đọc 1 dòng · p99 ${secs(f.p99)}` }),
    hybrid: tx({ en: `2 cache reads, merged in the feed service · p99 ${secs(f.p99)}`, vi: `2 lượt đọc cache, gộp ở feed service · p99 ${secs(f.p99)}` }),
  }[how];
  text(cost, gx0, mBot - 30, f.p99 > P99 ? 'bad' : 'ok', mono(9.5, 700), 'left', c3w - 28);
  let note = '', noteColor = 'muted';
  if (copied && posted && !starHere) { note = tx({ en: `missing: the footballer’s post. Minh is #${count(MINH.star)} in line`, vi: `thiếu: bài của cầu thủ. Minh đứng thứ ${count(MINH.star)} trong hàng` }); noteColor = 'bad'; }
  else if (copied && lanPosted && !lanHere) { note = tx({ en: 'missing: Lan’s post, stuck behind the footballer’s copies', vi: 'thiếu: bài của Lan, kẹt sau các bản chép của cầu thủ' }); noteColor = 'bad'; }
  else if (how === 'hybrid') { note = tx({ en: 'the footballer’s posts slot in by time, from the hot list', vi: 'bài của cầu thủ chen vào theo giờ, từ hot list' }); noteColor = 'pink'; }
  else if (loading) { note = tx({ en: 'the posts exist; the feed cannot be built in time', vi: 'bài đã có; feed không dựng kịp' }); noteColor = 'bad'; }
  if (note) text(note, gx0, mBot - 14, noteColor, mono(9, 600), 'left', c3w - 28);

  // Roads.
  const readIn = [c2x, rY];
  const starTarget = how === 'hybrid' ? [c2x, rY + 10] : [c2x, wY - 14];
  roadLine(g, [c1x + c1w, starY], starTarget, justPosted ? 'pink' : null, t);
  roadLine(g, [c1x + c1w, regY], [c2x, wY + 10], 'blue', t);
  roadLine(g, [c1x + c1w, readY], readIn, rushing ? 'warn' : 'text', t);
  if (!pull) roadLine(g, [c2x + c2w, wY], [c3x, (pTop + pBot) / 2], starQueued ? 'pink' : 'blue', t);
  roadLine(g, [c2x + c2w, rY], [c3x, (mTop + mBot) / 2], f.p99 > P99 ? 'bad' : how === 'hybrid' ? 'pink' : 'ok', t);
  const travel = (s, from, to, color) => {
    const p = clamp(s / 1.2, 0, 1), x = from[0] + (to[0] - from[0]) * p, y = from[1] + (to[1] - from[1]) * p;
    g.fillStyle = css(color); g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill();
  };
  if (justPosted) travel(since, [c1x + c1w, starY], starTarget, 'pink');
  if (lanPosted && lanSince < 2.5) travel(lanSince, [c1x + c1w, regY], [c2x, wY + 10], 'blue');

  checks(g, w, h, r, t, f, text, box);
}

function roadLine(g, [x1, y1], [x2, y2], color, t) {
  g.save();
  if (color) { g.strokeStyle = css(color); g.globalAlpha = 0.7; g.lineWidth = 2; g.setLineDash([6, 6]); g.lineDashOffset = -(t * 24) % 12; }
  else { g.strokeStyle = css('line'); g.setLineDash([3, 5]); }
  g.beginPath(); g.moveTo(x1, y1); g.bezierCurveTo((x1 + x2) / 2, y1, (x1 + x2) / 2, y2, x2, y2); g.stroke();
  g.restore();
}

/* The three constraints, ticked live. */
function checks(g, w, h, r, t, f, text, box) {
  const done = t >= r.end - 1e-6;
  const seen = r.strip.slice(0, Math.max(1, Math.floor(t)));
  const worst = Math.max(0, ...seen.map(x => x.p99));
  const items = [];
  items.push({ label: tx({ en: 'feed reads p99 under 200 ms', vi: 'p99 đọc feed dưới 200 ms' }), value: secs(done ? r.maxP99 : worst), ok: done ? r.checks.reads : worst <= P99 });

  const label = tx({ en: 'footballer’s post in feeds ≤ 30 s', vi: 'bài cầu thủ vào feed ≤ 30 giây' });
  if (r.situation === 'evening') items.push({ label, value: tx({ en: 'no post', vi: 'không có bài' }), ok: true });
  else if (t < POST_AT) items.push({ label, value: tx({ en: `from ${clock(POST_AT)}`, vi: `từ ${clock(POST_AT)}` }) });
  else {
    const since = t - POST_AT;
    const arrived = r.star.lag !== null && r.star.lag <= since;
    if (arrived) items.push({ label, value: r.star.lag < 0.05 ? tx({ en: 'at once', vi: 'ngay lập tức' }) : secs(r.star.lag), ok: r.star.lag <= FRESH });
    else items.push({ label, value: tx({ en: `${secs(since)} and counting`, vi: `${secs(since)} và đang tăng` }), ok: since > FRESH ? false : undefined });
  }

  const reg = Math.max(f.maxRegLag, f.oldestReg);
  items.push({ label: tx({ en: 'other posts in feeds ≤ 30 s', vi: 'bài khác vào feed ≤ 30 giây' }), value: reg < 1 ? tx({ en: 'under 1 s', vi: 'dưới 1 giây' }) : secs(done ? r.regLag : reg), ok: done ? r.checks.others : reg <= FRESH });

  const y = h - 62, cw = (w - 28 - 20) / 3;
  items.forEach((it, i) => {
    const x = 14 + i * (cw + 10);
    const tone = it.ok === undefined ? 'muted' : it.ok ? 'ok' : 'bad';
    box(x, y, cw, 50, 8, tone, tone, 0.07, 1);
    icon(g, it.ok === undefined ? 'clock' : it.ok ? 'check' : 'cross', x + 16, y + 17, 14, tone);
    text(it.label, x + 30, y + 17, 'text', sans(11.5, 600), 'left', cw - 38);
    text(it.value, x + 30, y + 35, tone, mono(11, 700), 'left', cw - 38);
  });
}
