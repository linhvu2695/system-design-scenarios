/* How traffic moves from the old tax engine to the new one under each strategy.

   Accounts on the left send payslip requests (dots). The router in the middle (a load
   balancer, or for a feature flag the app itself) decides which engine each one
   reaches; the servers on the right run old code, new code, or both. Each request
   comes back in the colour of the engine that handled it: blue for old, teal for new,
   red for a wrong payslip. Next to every account, its last few results show at a
   glance who is getting the new engine.

   A strip along the top shows the share of traffic on the new engine over the run,
   with the alert and the rollback marked when something breaks.

   The model is a small simulation over 20 minutes of compressed time (run()), drawn at
   any moment t. js/sim-player.js supplies the controls and scoreboard; its steps are the
   captioned moments of the run. */

import { tx } from '../../js/i18n.js';
import { css, rng } from '../../js/sim-kit.js';
import { player } from '../../js/sim-player.js';

export const SETUPS = ['today', 'flag', 'bluegreen', 'canary', 'rolling'];
export const SITUATIONS = ['healthy', 'bug', 'enterprise', 'payrun'];

export const T = 20;                  // minutes in a run
export const TASKS = 6;               // containers behind the load balancer
export const BUG_RATE = 0.3;          // share of new-engine payslips that come out wrong when there is a bug
export const ALERT_DELAY = 1.5;       // minutes from the first wrong payslip to the alert
export const EXPOSED_BUDGET = 10;     // customer payslips the faulty engine may calculate before it counts as a failure
export const PAYRUN = { account: 'r3', at: 8.5, size: 10 };
const PROCESS = 0.35, TRIP = 0.6;     // minutes to handle a request; dot round trip on screen

/* The accounts, with how often each sends a payslip request and where it falls in the
   flag's percentage rollout (hash). */
export const ACCOUNTS = [
  { id: 'ent1', kind: 'enterprise', name: 'Northwind', every: 1.3, off: 0.3, hash: 0.9 },
  { id: 'ent2', kind: 'enterprise', name: 'Contoso', every: 1.5, off: 0.8, hash: 0.15 },
  { id: 'staff', kind: 'internal', name: { en: 'Your staff', vi: 'Nhân viên của bạn' }, every: 0.9, off: 0.2, hash: 0 },
  { id: 'r1', kind: 'regular', name: 'Acorn Bakery', every: 1.1, off: 0.5, hash: 0.03 },
  { id: 'r2', kind: 'regular', name: 'Bluefin Dental', every: 1.2, off: 0.1, hash: 0.4 },
  { id: 'r3', kind: 'regular', name: 'Brightline', every: 1.0, off: 0.7, hash: 0.2 },
  { id: 'r4', kind: 'regular', name: 'Cedar & Co', every: 1.3, off: 0.4, hash: 0.7 },
  { id: 'r5', kind: 'regular', name: 'Dovetail', every: 1.15, off: 0.9, hash: 0.55 },
  { id: 'r6', kind: 'regular', name: 'Elmwood Gym', every: 1.25, off: 0.6, hash: 0.85 },
];

/* Each strategy's plan, and how it rolls back. */
const CANARY = [[2, 0.05], [7, 0.25], [12, 0.5], [16, 1]];
const FLAG = [[5, 0.05], [10, 0.25], [14, 0.5], [17, 1]];
const ROLL_START = 2, ROLL_EVERY = 2;                 // rolling: one container every 2 minutes
const ROLLBACK = { today: 0.5, bluegreen: 0.2, canary: 0.2, rolling: 0.5, flag: 0.05 };   // minutes from alert to the first change
const REDEPLOY_EVERY = { today: 0.6, rolling: 1.5 };    // redeploying the old image, one container at a time
const stage = (plan, t) => plan.reduce((w, [at, v]) => (t >= at ? v : w), 0);

/* Every request of the run. Seeded, so every visit is the same. */
function requests() {
  const r = rng(9), out = [];
  for (const a of ACCOUNTS)
    for (let t = a.off; t < T - 0.8; t += a.every + (r() - 0.5) * 0.3)
      out.push({ acc: a.id, t, u: r(), task: Math.floor(r() * TASKS), roll: r() });
  for (let k = 0; k < PAYRUN.size; k++) out.push({ acc: PAYRUN.account, t: PAYRUN.at + k * 0.06, u: r(), task: Math.floor(r() * TASKS), roll: r(), payrun: true });
  return out.sort((a, b) => a.t - b.t);
}

/* Is container k running the new engine at time t? (today and rolling) */
function taskNew(setup, k, t, rb) {
  const up = setup === 'today' ? 2 : ROLL_START + ROLL_EVERY * k;
  if (t < up || (rb != null && up >= rb)) return false;
  if (rb == null) return true;
  // Rolling back redeploys the old image, newest containers first.
  const live = Array.from({ length: TASKS }, (_, j) => j).filter(j => (setup === 'today' ? 2 : ROLL_START + ROLL_EVERY * j) < rb);
  const order = live.sort((a, b) => b - a).indexOf(k);
  return t < rb + REDEPLOY_EVERY[setup] * order;
}

/* Which engine handles request q at time t: 'old' or 'new'. */
function route(setup, q, t, rb) {
  const a = ACCOUNTS.find(x => x.id === q.acc);
  if (setup === 'today' || setup === 'rolling') return taskNew(setup, q.task, t, rb) ? 'new' : 'old';
  if (rb != null && t >= rb) return 'old';
  if (setup === 'bluegreen') return t >= 3 ? 'new' : 'old';
  if (setup === 'canary') return q.u < stage(CANARY, t) ? 'new' : 'old';
  // The feature flag: evaluated per account.
  if (a.kind === 'enterprise') return 'old';
  if (a.kind === 'internal') return t >= 2 ? 'new' : 'old';
  return a.hash < stage(FLAG, t) ? 'new' : 'old';
}

/* Share of traffic on the new engine at time t, for the strip at the top. */
function shareAt(setup, t, rb) {
  if (setup === 'today' || setup === 'rolling') return Array.from({ length: TASKS }, (_, k) => taskNew(setup, k, t, rb)).filter(Boolean).length / TASKS;
  if (rb != null && t >= rb) return 0;
  if (setup === 'bluegreen') return t >= 3 ? 1 : 0;
  if (setup === 'canary') return stage(CANARY, t);
  let on = 0, all = 0;
  for (const a of ACCOUNTS) {
    const rate = 1 / a.every;
    all += rate;
    if (a.kind === 'internal' ? t >= 2 : a.kind === 'regular' && a.hash < stage(FLAG, t)) on += rate;
  }
  return on / all;
}

/* Run one situation. Returns the requests with their engine and outcome, the alert
   and rollback times, the counts the scoreboard needs, and the captioned steps. Pure. */
export function run(setup, situation) {
  const bug = situation === 'bug';
  const reqs = requests().map(q => ({ ...q }));
  let alertAt = null, rollbackAt = null, firstWrong = null;
  for (const q of reqs) {
    q.engine = route(setup, q, q.t, rollbackAt);
    q.wrong = bug && q.engine === 'new' && q.roll < BUG_RATE;
    if (q.wrong && firstWrong == null) {
      firstWrong = q;
      alertAt = q.t + PROCESS + ALERT_DELAY;
      rollbackAt = alertAt + ROLLBACK[setup];
    }
  }
  const kindOf = id => ACCOUNTS.find(a => a.id === id).kind;
  const customerWrong = reqs.filter(q => q.wrong && kindOf(q.acc) !== 'internal').length;
  // Every customer payslip the faulty engine calculated could be wrong; this is the risk.
  const customerExposed = bug ? reqs.filter(q => q.engine === 'new' && kindOf(q.acc) !== 'internal').length : 0;
  const staffWrong = reqs.filter(q => q.wrong && kindOf(q.acc) === 'internal').length;
  const enterpriseNew = reqs.filter(q => q.engine === 'new' && kindOf(q.acc) === 'enterprise');
  const payrun = reqs.filter(q => q.payrun);
  const payrunEngines = new Set(payrun.map(q => q.engine));
  const lateRegular = reqs.filter(q => kindOf(q.acc) === 'regular' && q.t > 18);
  const ok = situation === 'healthy' ? lateRegular.every(q => q.engine === 'new')
    : situation === 'bug' ? customerExposed <= EXPOSED_BUDGET
    : situation === 'enterprise' ? enterpriseNew.length === 0
    : payrunEngines.size === 1;
  const timeline = Array.from({ length: 201 }, (_, i) => shareAt(setup, (i / 200) * T, rollbackAt));
  const res = { setup, situation, reqs, alertAt, rollbackAt, firstWrong, customerWrong, customerExposed, staffWrong, enterpriseNew: enterpriseNew.length, payrunEngines: [...payrunEngines], timeline, ok };
  res.steps = story(res);
  res.summary = ok
    ? { en: 'Within the constraints.', vi: 'Đạt các ràng buộc.' }
    : situation === 'healthy' ? { en: 'The rollout did not finish.', vi: 'Việc phát hành không hoàn tất.' }
    : situation === 'bug' ? { en: `Broken: the faulty engine calculated ${customerExposed} customer payslips before traffic was back on the old engine (${customerWrong} came out wrong).`, vi: `Hỏng: engine lỗi đã tính ${customerExposed} phiếu lương của khách trước khi traffic quay về engine cũ (${customerWrong} phiếu bị sai).` }
    : situation === 'enterprise' ? { en: `Broken: enterprise accounts reached the new engine ${enterpriseNew.length} times before signing off.`, vi: `Hỏng: tài khoản enterprise chạm tới engine mới ${enterpriseNew.length} lần trước khi ký chấp thuận.` }
    : { en: 'Broken: one pay run was calculated by both engines.', vi: 'Hỏng: một đợt trả lương được tính bởi cả hai engine.' };
  return res;
}

/* The captioned moments of a run, as player steps: { t0, t1, tone, say }. */
function story(r) {
  const { setup, situation, alertAt, rollbackAt, firstWrong } = r;
  const m = [];
  const add = (t, tone, en, vi) => { if (t <= T) m.push({ t, tone, say: { en, vi } }); };
  const before = t => rollbackAt == null || t < rollbackAt;   // plan steps that still happen
  add(0, null, 'Each account on the left sends payslip requests. The router decides which engine handles each one: results come back blue from the old engine, teal from the new one.', 'Mỗi tài khoản bên trái gửi request tính phiếu lương. Router quyết định engine nào xử lý từng request: kết quả trả về màu xanh dương từ engine cũ, màu xanh ngọc từ engine mới.');
  const plan = {
    today: [[2, 'All six containers are replaced at once: from now on every request, from every account, reaches the new engine.', 'Cả sáu container được thay cùng lúc: từ giờ mọi request, từ mọi tài khoản, đều tới engine mới.']],
    bluegreen: [[1, 'A green environment comes up running the new engine. Smoke tests pass. It takes no traffic yet.', 'Môi trường green khởi động với engine mới. Smoke test đạt. Nó chưa nhận traffic.'],
      [3, 'The load balancer switches from blue to green: 100% of traffic, every account, on the new engine at once.', 'Load balancer chuyển từ blue sang green: 100% traffic, mọi tài khoản, sang engine mới cùng lúc.']],
    canary: CANARY.map(([t, w]) => [t, `The load balancer sends ${w * 100}% of requests to the canary servers. It picks requests at random, not accounts: any account can land there.`, `Load balancer gửi ${w * 100}% request tới các server canary. Nó chọn request ngẫu nhiên, không chọn tài khoản: tài khoản nào cũng có thể rơi vào đó.`]),
    rolling: [[2, 'The first container is replaced with the new version. The load balancer sends any request to any container.', 'Container đầu tiên được thay bằng phiên bản mới. Load balancer gửi request bất kỳ tới container bất kỳ.'],
      [6, 'Three of six containers now run the new engine: about half of every account’s requests land there.', 'Ba trên sáu container giờ chạy engine mới: khoảng một nửa request của mọi tài khoản rơi vào đó.'],
      [12, 'All six containers run the new engine.', 'Cả sáu container đều chạy engine mới.']],
    flag: [[1, 'The new engine is deployed dark to every server: both code paths are there, and the flag sends everyone down the old one.', 'Engine mới được deploy ở trạng thái tắt lên mọi server: cả hai nhánh code đều có, và flag đưa mọi người vào nhánh cũ.'],
      [2, 'The flag turns on for your own staff only. The app checks it per account, so every request from your staff takes the new path.', 'Flag bật chỉ cho nhân viên của bạn. Ứng dụng kiểm tra flag theo tài khoản, nên mọi request của nhân viên đều đi nhánh mới.'],
      ...FLAG.map(([t, w]) => [t, `The flag turns on for ${w * 100}% of regular accounts, chosen by account, so each company is wholly on one engine. Enterprise accounts are excluded by a rule.`, `Flag bật cho ${w * 100}% tài khoản thường, chọn theo tài khoản, nên mỗi công ty nằm trọn ở một engine. Tài khoản enterprise bị loại trừ bằng một rule.`])],
  }[setup];
  for (const [t, en, vi] of plan) if (before(t)) add(t, null, en, vi);

  if (situation === 'bug' && firstWrong) {
    const staff = firstWrong.acc === 'staff';
    add(firstWrong.t + PROCESS, 'bad', staff ? 'A wrong payslip, for one of your own staff: the new engine has a bug.' : 'A wrong payslip, issued to a customer. It cannot be recalled.', staff ? 'Một phiếu lương sai, của một nhân viên của bạn: engine mới có bug.' : 'Một phiếu lương sai, đã phát hành cho khách hàng. Không thể thu hồi.');
    add(alertAt, 'warn', 'The alert fires: tax totals from the new engine disagree with the old one. Time to switch traffic back.', 'Cảnh báo kích hoạt: tổng thuế từ engine mới lệch với engine cũ. Đến lúc chuyển traffic lại.');
    const back = {
      today: ['Rolling back means redeploying the old image, one container at a time. Until each one is replaced, it keeps issuing payslips from the new engine.', 'Rollback nghĩa là deploy lại image cũ, từng container một. Cho tới khi được thay, mỗi container vẫn phát hành phiếu lương từ engine mới.'],
      bluegreen: ['The load balancer switches back to blue: every account is on the old engine again, within seconds. Everyone was exposed until now.', 'Load balancer chuyển lại blue: mọi tài khoản trở về engine cũ, trong vài giây. Ai cũng đã bị ảnh hưởng cho tới lúc này.'],
      canary: ['The canary weight goes to 0: every request is back on the old engine within seconds.', 'Trọng số canary về 0: mọi request trở về engine cũ trong vài giây.'],
      rolling: ['Rolling back redeploys the old image, newest containers first, one at a time. The share on the new engine shrinks over minutes, not seconds.', 'Rollback deploy lại image cũ, container mới nhất trước, từng cái một. Phần traffic ở engine mới giảm dần trong vài phút, không phải vài giây.'],
      flag: ['The kill switch turns the flag off. The very next request from every account takes the old path, with no deploy.', 'Kill switch tắt flag. Ngay request tiếp theo của mọi tài khoản đi nhánh cũ, không cần deploy.'],
    }[setup];
    add(rollbackAt, null, ...back);
    add(Math.min(T - 0.5, rollbackAt + 4.5), r.customerExposed > EXPOSED_BUDGET ? 'bad' : null,
      `In all, the faulty engine calculated ${r.customerExposed} customer payslips, and ${r.customerWrong} of them came out wrong. Your staff got ${r.staffWrong} wrong.`, `Tổng cộng, engine lỗi đã tính ${r.customerExposed} phiếu lương của khách hàng, và ${r.customerWrong} phiếu bị sai. Nhân viên của bạn nhận ${r.staffWrong} phiếu sai.`);
  }
  if (situation === 'enterprise') {
    const first = r.reqs.find(q => q.engine === 'new' && ACCOUNTS.find(a => a.id === q.acc).kind === 'enterprise');
    if (first) add(first.t + PROCESS, 'bad', `${ACCOUNTS.find(a => a.id === first.acc).name}, an enterprise account that has not signed off, gets a payslip from the new engine. Their contract says no new engine until they have reviewed it: the payslip may be right, but the promise is broken.`, `${ACCOUNTS.find(a => a.id === first.acc).name}, một tài khoản enterprise chưa ký chấp thuận, nhận phiếu lương từ engine mới. Hợp đồng của họ nói không dùng engine mới cho tới khi họ xem xét xong: phiếu lương có thể đúng, nhưng lời hứa đã bị phá vỡ.`);
    else add(6, null, 'Enterprise requests never reach the new engine: the flag rule excludes their accounts, whatever the percentage.', 'Request của enterprise không bao giờ tới engine mới: rule của flag loại trừ tài khoản của họ, dù phần trăm là bao nhiêu.');
  }
  if (situation === 'payrun') {
    add(PAYRUN.at, null, 'Brightline runs payroll: ten payslips for one company, at once.', 'Brightline chạy lương: mười phiếu lương cho một công ty, cùng lúc.');
    const mixed = r.payrunEngines.length > 1;
    const counts = e => r.reqs.filter(q => q.payrun && q.engine === e).length;
    add(PAYRUN.at + PAYRUN.size * 0.06 + PROCESS, mixed ? 'bad' : null,
      mixed ? `The run is split: ${counts('old')} payslips from the old engine, ${counts('new')} from the new one. Its totals no longer add up.` : `The whole run came from the ${r.payrunEngines[0]} engine. Its totals add up.`,
      mixed ? `Đợt chạy bị chia đôi: ${counts('old')} phiếu từ engine cũ, ${counts('new')} từ engine mới. Tổng cộng không còn khớp.` : `Cả đợt chạy đều từ engine ${r.payrunEngines[0] === 'new' ? 'mới' : 'cũ'}. Tổng cộng khớp.`);
  }
  m.sort((a, b) => a.t - b.t);
  return m.map((x, i) => ({ ...x, t0: x.t, t1: i + 1 < m.length ? m[i + 1].t : T }));
}

export const survives = (setup, situation) => run(setup, situation).ok;

const LABEL = {
  today: { en: 'Today: replace all at once', vi: 'Hiện tại: thay tất cả cùng lúc' },
  flag: { en: 'Feature flag per account', vi: 'Feature flag theo tài khoản' },
  bluegreen: { en: 'Blue/green flip', vi: 'Chuyển blue/green' },
  canary: { en: 'Canary by LB weight', vi: 'Canary theo trọng số LB' },
  rolling: { en: 'Rolling update', vi: 'Rolling update' },
};
const SITUATION = {
  healthy: { en: 'Healthy release', vi: 'Phát hành suôn sẻ' },
  bug: { en: 'The new engine has a bug', vi: 'Engine mới có bug' },
  enterprise: { en: 'Enterprise account', vi: 'Tài khoản enterprise' },
  payrun: { en: 'A company’s pay run', vi: 'Một đợt trả lương' },
};

export function mount(root, ctx) {
  const H = 480;
  let cached = null;   // the player asks for each run once; the drawing reads the same result
  return player(root, ctx, {
    situations: SITUATIONS.map(x => ({ value: x, label: tx(SITUATION[x]), icon: { healthy: 'sun', bug: 'alert', enterprise: 'building', payrun: 'list' }[x] })),
    setups: SETUPS.map(x => ({ value: x, label: tx(LABEL[x]), icon: { today: 'server', flag: 'filter', bluegreen: 'copy', canary: 'gauge', rolling: 'replay' }[x] })),
    initial: { situation: 'bug' },
    run: (setup, situation) => (cached = run(setup, situation)),
    survives, height: H,
    duration: st => Math.max(0.8, (st.t1 - st.t0) * 1.6),
    tone: st => st.tone,
    draw: ({ g, w, h, k, p }) => {
      const st = cached.steps[k];
      draw(g, w, h, cached, st ? st.t0 + p * (st.t1 - st.t0) : T);
    },
  });
}

/* ---------------- drawing ---------------- */

const KIND_COLOR = { enterprise: 'warn', internal: 'violet', regular: 'muted' };
const ENGINE_COLOR = { old: 'blue', new: 'cat-queue' };

function draw(g, w, h, r, t) {
  const { setup } = r;
  g.clearRect(0, 0, w, h);
  g.textBaseline = 'middle';
  const text = (s, x, y, color = 'muted', font = '11px "IBM Plex Mono", monospace', align = 'left', max) => {
    g.font = font; g.textAlign = align; g.fillStyle = css(color); g.fillText(s, x, y, max);
  };
  const rb = r.rollbackAt;
  // In the enterprise situation, an enterprise payslip from the new engine is the failure: drawn red.
  const watchEnt = r.situation === 'enterprise';
  const isEnt = q => ACCOUNTS.find(a => a.id === q.acc).kind === 'enterprise';
  const breach = q => watchEnt && q.engine === 'new' && isEnt(q);

  // ---- The strip: share of traffic on the new engine over the run. ----
  const sx0 = 150, sx1 = w - 14, sy0 = 14, sy1 = 64;
  const X = tt => sx0 + (tt / T) * (sx1 - sx0);
  text(tx({ en: 'TRAFFIC ON THE', vi: 'TRAFFIC Ở' }), 10, 26, 'muted', '700 10px "IBM Plex Mono", monospace');
  text(tx({ en: 'NEW ENGINE', vi: 'ENGINE MỚI' }), 10, 40, 'cat-queue', '700 10px "IBM Plex Mono", monospace');
  g.fillStyle = css('bg2'); g.beginPath(); g.roundRect(sx0, sy0, sx1 - sx0, sy1 - sy0, 6); g.fill();
  const area = (upto, alpha) => {
    g.beginPath(); g.moveTo(X(0), sy1);
    r.timeline.forEach((v, i) => { const tt = (i / 200) * T; if (tt <= upto) g.lineTo(X(tt), sy1 - v * (sy1 - sy0)); });
    g.lineTo(X(Math.min(upto, T)), sy1); g.closePath();
    g.fillStyle = css('cat-queue'); g.globalAlpha = alpha; g.fill(); g.globalAlpha = 1;
  };
  area(T, 0.15);     // the plan, faint
  area(t, 0.75);     // what has happened
  for (const pct of [0.5, 1]) { g.strokeStyle = css('line'); g.beginPath(); g.moveTo(sx0, sy1 - pct * (sy1 - sy0)); g.lineTo(sx1, sy1 - pct * (sy1 - sy0)); g.stroke(); }
  text('100%', sx0 - 4, sy0 + 1, 'faint', '9px "IBM Plex Mono", monospace', 'right');
  text('0%', sx0 - 4, sy1 - 1, 'faint', '9px "IBM Plex Mono", monospace', 'right');
  const marker = (tt, color, label, dy = 8) => {
    if (tt == null || tt > t) return;
    g.strokeStyle = css(color); g.lineWidth = 2; g.beginPath(); g.moveTo(X(tt), sy0 - 2); g.lineTo(X(tt), sy1 + 2); g.stroke(); g.lineWidth = 1;
    text(label, X(tt) + 4, sy0 + dy, color, '700 9.5px "IBM Plex Mono", monospace');
  };
  marker(r.alertAt, 'bad', tx({ en: 'alert', vi: 'cảnh báo' }));
  marker(rb, 'blue', tx({ en: 'rollback', vi: 'rollback' }), 21);
  g.strokeStyle = css('text'); g.globalAlpha = 0.7; g.beginPath(); g.moveTo(X(t), sy0 - 4); g.lineTo(X(t), sy1 + 4); g.stroke(); g.globalAlpha = 1;
  const share = r.timeline[Math.min(200, Math.round((t / T) * 200))];
  const nearEnd = X(t) > sx1 - 44;
  text(`${Math.round(share * 100)}%`, X(t) + (nearEnd ? -4 : 4), sy1 - 8, 'cat-queue', '700 11px "IBM Plex Mono", monospace', nearEnd ? 'right' : 'left');

  // ---- Layout below the strip. ----
  const top = 92, bottom = h - 44;
  const accX = 16, nameW = 120, routerX0 = w * 0.36, routerX1 = w * 0.52, srvX0 = w * 0.64, srvX1 = w - 16;
  const rowY = i => top + (i + 0.5) * ((bottom - top) / ACCOUNTS.length);
  const routerMid = [(routerX0 + routerX1) / 2, (top + bottom) / 2];

  // Accounts, each with its last results.
  text(tx({ en: 'ACCOUNTS', vi: 'TÀI KHOẢN' }), accX, top - 12, 'muted', '700 10px "IBM Plex Mono", monospace');
  ACCOUNTS.forEach((a, i) => {
    const y = rowY(i);
    const done = r.reqs.filter(q => q.acc === a.id && q.t + TRIP <= t);
    const breached = a.kind === 'enterprise' && done.some(breach);
    if (breached) {
      const rh = (bottom - top) / ACCOUNTS.length - 4;
      g.fillStyle = css('bad'); g.globalAlpha = 0.14; g.beginPath(); g.roundRect(accX - 6, y - rh / 2, routerX0 - accX - 4, rh, 6); g.fill();
      g.globalAlpha = 1; g.strokeStyle = css('bad'); g.stroke();
    }
    g.fillStyle = css(KIND_COLOR[a.kind]); g.beginPath(); g.arc(accX + 5, y, 5, 0, Math.PI * 2); g.fill();
    text(tx(typeof a.name === 'string' ? { en: a.name, vi: a.name } : a.name), accX + 16, y, a.kind === 'regular' ? 'text' : KIND_COLOR[a.kind], `${a.kind === 'regular' ? 500 : 700} 11px "Hanken Grotesk", sans-serif`, 'left', nameW - 20);
    done.slice(-6).forEach((q, j) => {
      const x = accX + nameW + j * 9;
      g.fillStyle = css(q.wrong || breach(q) ? 'bad' : ENGINE_COLOR[q.engine]);
      g.beginPath(); g.roundRect(x, y - 4, 7, 8, 1.5); g.fill();
    });
    if (a.kind === 'enterprise') {
      const sub = !watchEnt ? [{ en: 'enterprise', vi: 'enterprise' }, 'warn']
        : breached ? [{ en: 'enterprise · on the NEW engine!', vi: 'enterprise · đang ở engine MỚI!' }, 'bad']
        : done.length ? [{ en: 'enterprise · still on old ✓', vi: 'enterprise · vẫn ở engine cũ ✓' }, 'ok']
        : [{ en: 'enterprise · must stay on old', vi: 'enterprise · phải ở engine cũ' }, 'warn'];
      text(tx(sub[0]), accX + 16, y + 11, sub[1], `${breached ? 700 : 400} 9px "IBM Plex Mono", monospace`, 'left', routerX0 - accX - 30);
    }
  });

  // The router.
  const flag = setup === 'flag';
  g.fillStyle = css('surface2'); g.beginPath(); g.roundRect(routerX0, top, routerX1 - routerX0, bottom - top, 12); g.fill();
  g.strokeStyle = css('line'); g.stroke();
  text(flag ? tx({ en: 'APP · FLAG', vi: 'ỨNG DỤNG · FLAG' }) : tx({ en: 'LOAD BALANCER', vi: 'LOAD BALANCER' }), routerMid[0], top + 16, 'muted', '700 10px "IBM Plex Mono", monospace', 'center', routerX1 - routerX0 - 10);
  const rolledBack = rb != null && t >= rb;
  const lines = flag
    ? (rolledBack ? [[tx({ en: 'kill switch: OFF', vi: 'kill switch: TẮT' }), 'bad']]
      : [[tx({ en: `staff: ${t >= 2 ? 'on' : 'off'}`, vi: `nhân viên: ${t >= 2 ? 'bật' : 'tắt'}` }), t >= 2 ? 'cat-queue' : 'muted'],
        [tx({ en: 'enterprise: off', vi: 'enterprise: tắt' }), 'warn'],
        [tx({ en: `regular: ${Math.round(stage(FLAG, t) * 100)}%`, vi: `thường: ${Math.round(stage(FLAG, t) * 100)}%` }), stage(FLAG, t) ? 'cat-queue' : 'muted']])
    : [[tx({ en: `new: ${Math.round(share * 100)}%`, vi: `mới: ${Math.round(share * 100)}%` }), share ? 'cat-queue' : 'muted'], [tx({ en: `old: ${Math.round((1 - share) * 100)}%`, vi: `cũ: ${Math.round((1 - share) * 100)}%` }), 'blue']];
  lines.forEach(([s, c], i) => text(s, routerMid[0], top + 40 + i * 18, c, '600 11px "IBM Plex Mono", monospace', 'center', routerX1 - routerX0 - 10));
  if (!flag) text(tx({ en: setup === 'canary' ? 'picks requests at random' : 'any request, any server', vi: setup === 'canary' ? 'chọn request ngẫu nhiên' : 'request bất kỳ, server bất kỳ' }), routerMid[0], bottom - 14, 'faint', '9.5px "IBM Plex Mono", monospace', 'center', routerX1 - routerX0 - 10);
  else text(tx({ en: 'decides per account', vi: 'quyết định theo tài khoản' }), routerMid[0], bottom - 14, 'faint', '9.5px "IBM Plex Mono", monospace', 'center', routerX1 - routerX0 - 10);

  // The servers, laid out for the strategy. Each slot: { x, y, w, h, engine, label }.
  const boxes = [];
  const col = (n, y0, y1) => Array.from({ length: n }, (_, k) => y0 + (k + 0.5) * ((y1 - y0) / n));
  const bw = srvX1 - srvX0, bh = Math.min(30, (bottom - top) / 9);
  if (setup === 'today' || setup === 'rolling') {
    col(TASKS, top + 10, bottom).forEach((y, k) => boxes.push({ k, x: srvX0, y, w: bw, h: bh, engine: taskNew(setup, k, t, rb) ? 'new' : 'old', label: `container ${k + 1}` }));
  } else if (setup === 'bluegreen') {
    const mid = (top + bottom) / 2;
    const live = t >= 3 && !(rb != null && t >= rb) ? 'new' : 'old';
    col(3, top + 18, mid - 6).forEach((y, k) => boxes.push({ k, group: 'old', x: srvX0, y, w: bw, h: bh, engine: 'old', label: `blue ${k + 1}`, dim: live !== 'old' }));
    col(3, mid + 18, bottom).forEach((y, k) => boxes.push({ k, group: 'new', x: srvX0, y, w: bw, h: bh, engine: 'new', label: `green ${k + 1}`, dim: live !== 'new' || t < 1, hidden: t < 1 }));
    text(tx({ en: `BLUE · old${live === 'old' ? ' · live' : ''}`, vi: `BLUE · cũ${live === 'old' ? ' · đang chạy' : ''}` }), srvX0, top + 4, 'blue', '700 10px "IBM Plex Mono", monospace');
    text(tx({ en: `GREEN · new${live === 'new' ? ' · live' : ''}`, vi: `GREEN · mới${live === 'new' ? ' · đang chạy' : ''}` }), srvX0, mid + 4, 'cat-queue', '700 10px "IBM Plex Mono", monospace');
  } else if (setup === 'canary') {
    const mid = top + (bottom - top) * 0.62;
    col(4, top + 18, mid - 6).forEach((y, k) => boxes.push({ k, group: 'old', x: srvX0, y, w: bw, h: bh, engine: 'old', label: `stable ${k + 1}` }));
    col(2, mid + 18, bottom).forEach((y, k) => boxes.push({ k, group: 'new', x: srvX0, y, w: bw, h: bh, engine: 'new', label: `canary ${k + 1}`, dim: t < 2 }));
    text(tx({ en: 'STABLE · old', vi: 'STABLE · cũ' }), srvX0, top + 4, 'blue', '700 10px "IBM Plex Mono", monospace');
    text(tx({ en: 'CANARY · new', vi: 'CANARY · mới' }), srvX0, mid + 4, 'cat-queue', '700 10px "IBM Plex Mono", monospace');
  } else {
    col(4, top + 18, bottom).forEach((y, k) => boxes.push({ k, x: srvX0, y, w: bw, h: bh + 6, engine: 'both', label: `server ${k + 1}` }));
    text(tx({ en: t >= 1 ? 'SERVERS · both paths deployed' : 'SERVERS · old code', vi: t >= 1 ? 'SERVER · đã deploy cả hai nhánh' : 'SERVER · code cũ' }), srvX0, top + 4, 'muted', '700 10px "IBM Plex Mono", monospace');
  }
  for (const b of boxes) {
    if (b.hidden) { g.strokeStyle = css('line'); g.setLineDash([3, 4]); g.strokeRect(b.x, b.y - b.h / 2, b.w, b.h); g.setLineDash([]); continue; }
    g.globalAlpha = b.dim ? 0.35 : 1;
    if (b.engine === 'both') {
      const half = b.w / 2;
      const on = t >= 1;
      g.fillStyle = css('blue'); g.globalAlpha *= 0.22; g.beginPath(); g.roundRect(b.x, b.y - b.h / 2, half - 2, b.h, 6); g.fill();
      g.fillStyle = css('cat-queue'); g.globalAlpha = on ? 0.22 : 0.06; g.beginPath(); g.roundRect(b.x + half + 2, b.y - b.h / 2, half - 2, b.h, 6); g.fill();
      g.globalAlpha = 1;
      text(tx({ en: 'old path', vi: 'nhánh cũ' }), b.x + half / 2, b.y, 'blue', '600 10px "IBM Plex Mono", monospace', 'center');
      text(on ? tx({ en: rolledBack ? 'new path · off' : 'new path', vi: rolledBack ? 'nhánh mới · tắt' : 'nhánh mới' }) : '—', b.x + half * 1.5, b.y, on ? 'cat-queue' : 'faint', '600 10px "IBM Plex Mono", monospace', 'center');
    } else {
      g.fillStyle = css(ENGINE_COLOR[b.engine]); g.globalAlpha *= 0.25; g.beginPath(); g.roundRect(b.x, b.y - b.h / 2, b.w, b.h, 6); g.fill();
      g.globalAlpha = b.dim ? 0.35 : 1;
      g.strokeStyle = css(ENGINE_COLOR[b.engine]); g.beginPath(); g.roundRect(b.x, b.y - b.h / 2, b.w, b.h, 6); g.stroke();
      text(`${b.label} · ${b.engine === 'new' ? tx({ en: 'new engine', vi: 'engine mới' }) : tx({ en: 'old engine', vi: 'engine cũ' })}`, b.x + 10, b.y, ENGINE_COLOR[b.engine], '600 10.5px "IBM Plex Mono", monospace', 'left', b.w - 16);
    }
    g.globalAlpha = 1;
  }

  // Where request q is served: the box, and in a flag server the half for its path.
  const target = q => {
    let b;
    if (setup === 'today' || setup === 'rolling') b = boxes[q.task];
    else if (setup === 'bluegreen' || setup === 'canary') { const pool = boxes.filter(x => x.group === q.engine); b = pool[q.task % pool.length]; }
    else b = boxes[q.task % boxes.length];
    const x = b.engine === 'both' ? b.x + (q.engine === 'new' ? b.w * 0.75 : b.w * 0.25) : b.x + 12;
    return [x, b.y];
  };

  // Requests in flight: out through the router to a server, then back with the result.
  const lerp = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  for (const q of r.reqs) {
    const f = (t - q.t) / TRIP;
    if (f < 0 || f > 1) continue;
    const i = ACCOUNTS.findIndex(a => a.id === q.acc);
    const from = [accX + nameW - 6, rowY(i)], via = [routerX0, routerMid[1] + (i - 4) * 6], out = [routerX1, routerMid[1] + (i - 4) * 6], to = target(q);
    let p, color = 'muted', back = false;
    if (f < 0.25) p = lerp(from, via, f / 0.25);
    else if (f < 0.3) p = lerp(via, out, (f - 0.25) / 0.05);
    else if (f < 0.55) p = lerp(out, to, (f - 0.3) / 0.25);
    else if (f < 0.62) p = to;
    else { p = lerp(to, from, (f - 0.62) / 0.38); back = true; }
    if (watchEnt && isEnt(q) && f < 0.55) color = 'warn';   // follow enterprise requests on their way out
    if (f >= 0.55) color = q.wrong || breach(q) ? 'bad' : ENGINE_COLOR[q.engine];
    // A faint line from the router to the server it picked, while the request is there.
    if (f >= 0.3 && f < 0.62) {
      const bad = breach(q);
      g.strokeStyle = css(bad ? 'bad' : ENGINE_COLOR[q.engine]); g.globalAlpha = bad ? 0.9 : 0.35; g.lineWidth = bad ? 2 : 1;
      g.beginPath(); g.moveTo(...out); g.lineTo(...to); g.stroke(); g.globalAlpha = 1; g.lineWidth = 1;
      // Name the enterprise account where it lands on the new engine.
      if (bad) {
        const name = ACCOUNTS.find(a => a.id === q.acc).name;
        g.font = '700 10px "IBM Plex Mono", monospace';
        const lw = g.measureText(`⚠ ${name}`).width + 10;
        const lx = to[0] + 8, ly = to[1] - 20;
        g.fillStyle = css('bad'); g.beginPath(); g.roundRect(lx, ly - 8, lw, 16, 4); g.fill();
        text(`⚠ ${name}`, lx + 5, ly, 'bg', '700 10px "IBM Plex Mono", monospace');
      }
    }
    g.fillStyle = css(color);
    if (back) { g.beginPath(); g.roundRect(p[0] - 4, p[1] - 4, 8, 8, 2); g.fill(); }
    else { g.beginPath(); g.arc(p[0], p[1], 3.5, 0, Math.PI * 2); g.fill(); }
  }

  // Footer.
  const seen = r.reqs.filter(q => q.t + TRIP <= t);
  const kind = id => ACCOUNTS.find(a => a.id === id).kind;
  const wrongC = seen.filter(q => q.wrong && kind(q.acc) !== 'internal').length;
  const exposedC = r.situation === 'bug' ? seen.filter(q => q.engine === 'new' && kind(q.acc) !== 'internal').length : 0;
  const entNew = seen.filter(q => q.engine === 'new' && kind(q.acc) === 'enterprise').length;
  const fy = h - 18;
  text(r.situation === 'bug' ? tx({ en: `customer payslips from the faulty engine: ${exposedC} · wrong: ${wrongC}`, vi: `phiếu của khách từ engine lỗi: ${exposedC} · sai: ${wrongC}` }) : tx({ en: 'no bug in this run', vi: 'lần chạy này không có bug' }), 10, fy, exposedC > EXPOSED_BUDGET ? 'bad' : exposedC ? 'warn' : 'muted', '600 11px "IBM Plex Mono", monospace', 'left', w * 0.42);
  text(tx({ en: `enterprise payslips from the new engine: ${entNew}`, vi: `phiếu enterprise từ engine mới: ${entNew}` }), w * 0.44, fy, entNew ? 'bad' : 'muted', '600 11px "IBM Plex Mono", monospace', 'left', w * 0.3);
  const legend = [['blue', tx({ en: 'old', vi: 'cũ' })], ['cat-queue', tx({ en: 'new', vi: 'mới' })],
    ['bad', watchEnt ? tx({ en: 'enterprise on new', vi: 'enterprise ở engine mới' }) : tx({ en: 'wrong', vi: 'sai' })]];
  let lx = w - 14;
  for (const [c, label] of legend.reverse()) {
    g.font = '11px "Hanken Grotesk", sans-serif';
    const lw = g.measureText(label).width;
    lx -= lw; text(label, lx, fy, 'muted', '11px "Hanken Grotesk", sans-serif');
    lx -= 14; g.fillStyle = css(c); g.beginPath(); g.roundRect(lx, fy - 4, 8, 8, 2); g.fill();
    lx -= 12;
  }
}
