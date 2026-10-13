/* Five services, an app nobody can force-update, and two endpoint moves in a year. The
   chart is the share of active users whose app calls an endpoint that is no longer
   there. Before the visitor answers, only today's setup (hostnames built into the app)
   is unlocked, so they see the problem without being handed the fix. */

import { el } from '../../js/dom.js';
import { tx } from '../../js/i18n.js';
import { canvas, choice, slider, button, stat, key, css, row, onResize, animate } from '../../js/sim-kit.js';

export const WEEKS = 52;
export const MOVES = [0, 26];   // weeks at which an endpoint moves to another service
export const SERVICES = 5;
export const DEFAULTS = { update: 0.12, stuck: 0.18, keep: 8 };

/* Share of active users still on a version older than a release `weeks` ago.
   An illustrative model, not measured data: each week a fraction `update` of the
   remaining users update, and a fraction `stuck` never do. */
export function oldShare(weeks, { update, stuck }) {
  if (weeks <= 0) return 1;
  return stuck + (1 - stuck) * (1 - update) ** weeks;
}

/* Share of active users broken at `week`. Each move ships in an app release at the
   move's week; the old endpoint is deleted `keep` weeks later. Pure, so the argument
   is pinned by tests/api-gateway-mobile.test.js. */
export function broken(arch, week, params) {
  if (arch === 'gateway') return 0;   // old hostnames route through it; a move is a route change
  const retired = MOVES.filter(m => week >= m + params.keep);
  if (!retired.length) return 0;
  // Direct: each move needs a release with the new address, so anyone older than the
  // latest retired move is broken. Remote config ships with the first move's release;
  // after that, a move reaches everyone on that release or newer.
  let since;
  if (arch === 'direct') since = Math.max(...retired);
  else if (arch === 'config') since = MOVES[0];
  else throw new Error(`unknown setup: ${arch}`);
  return oldShare(week - since, params);
}

/* Places that validate a login token. */
export const tokenChecks = arch => (arch === 'gateway' ? 1 : SERVICES);

export function series(arch, params) {
  const out = [];
  for (let w = 0; w <= WEEKS; w++) out.push(broken(arch, w, params));
  return out;
}

const SETUPS = [
  { value: 'direct', label: { en: 'Hostnames in the app', vi: 'Hostname trong app' } },
  { value: 'config', label: { en: 'Remote config', vi: 'Remote config' } },
  { value: 'gateway', label: { en: 'API gateway', vi: 'API gateway' } },
];

const pct = v => `${Math.round(v * 100)}%`;

export function mount(root, { revealed, state }) {
  const s = Object.assign(state, { arch: 'direct', ...DEFAULTS, ...state });
  if (!revealed) s.arch = 'direct';

  const chart = canvas(220);
  const peak = stat(tx({ en: 'Peak users broken', vi: 'Người dùng hỏng nhiều nhất' }));
  const end = stat(tx({ en: 'Still broken at week 52', vi: 'Vẫn hỏng ở tuần 52' }));
  const checks = stat(tx({ en: 'Token checks', vi: 'Chỗ kiểm tra token' }));
  const kept = stat(tx({ en: 'Old code kept per move', vi: 'Giữ code cũ mỗi lần chuyển' }));
  let data, stop = () => {};

  function compute() {
    data = series(s.arch, s);
    const max = Math.max(...data), last = data[WEEKS];
    peak.set(pct(max), max > 0.05 ? 'bad' : max > 0 ? 'warn' : 'ok');
    end.set(pct(last), last > 0.05 ? 'bad' : last > 0 ? 'warn' : 'ok');
    checks.set(String(tokenChecks(s.arch)), tokenChecks(s.arch) > 1 ? 'warn' : 'ok');
    kept.set(s.arch === 'gateway'
      ? tx({ en: '0 weeks', vi: '0 tuần' })
      : tx({ en: `${s.keep} weeks`, vi: `${s.keep} tuần` }));
  }

  function draw(p = 1) {
    const { w, h } = chart.fit();
    const g = chart.g;
    const pad = { l: 40, r: 10, t: 12, b: 24 };
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const x = wk => pad.l + (wk / WEEKS) * pw;
    const y = v => pad.t + ph - v * ph;

    g.clearRect(0, 0, w, h);
    g.font = '11px "IBM Plex Mono", monospace';
    g.fillStyle = css('muted');

    // Axes: share of users up the side, weeks across.
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (const v of [0, 0.5, 1]) {
      g.fillStyle = css('muted');
      g.fillText(pct(v), pad.l - 6, y(v));
      g.strokeStyle = css('line');
      g.beginPath(); g.moveTo(pad.l, y(v)); g.lineTo(w - pad.r, y(v)); g.stroke();
    }
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let wk = 0; wk <= WEEKS; wk += 13) g.fillText(`w${wk}`, Math.min(Math.max(x(wk), pad.l + 10), w - pad.r - 14), h - pad.b + 7);

    // When each endpoint moves, and when its old code is deleted.
    g.setLineDash([4, 4]);
    for (const m of MOVES) {
      g.strokeStyle = css('blue');
      g.beginPath(); g.moveTo(x(m), pad.t); g.lineTo(x(m), pad.t + ph); g.stroke();
      if (s.arch !== 'gateway' && m + s.keep <= WEEKS) {
        g.strokeStyle = css('faint');
        g.beginPath(); g.moveTo(x(m + s.keep), pad.t); g.lineTo(x(m + s.keep), pad.t + ph); g.stroke();
      }
    }
    g.setLineDash([]);

    // Broken users, drawn left to right as the animation runs.
    const shown = Math.round(p * WEEKS);
    const bw = Math.max(1, pw / WEEKS - 1);
    for (let i = 0; i <= Math.min(shown, WEEKS - 1); i++) {
      if (!data[i]) continue;
      g.fillStyle = css('bad');
      g.fillRect(x(i), y(data[i]), bw, pad.t + ph - y(data[i]));
    }
    g.strokeStyle = css('ok');
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(x(0), y(0)); g.lineTo(x(p * WEEKS), y(0)); g.stroke();
    g.lineWidth = 1;
  }

  const replay = () => { stop(); stop = animate(1800, draw); };
  const update = () => { compute(); replay(); };
  const redraw = () => { stop(); compute(); draw(); };

  const locked = tx({ en: 'Make your call below to unlock the other setups.', vi: 'Trả lời câu hỏi bên dưới để mở khoá các cách làm còn lại.' });
  root.append(
    row(
      choice(tx({ en: 'Setup', vi: 'Cách làm' }), SETUPS.map(a => ({
        value: a.value, label: tx(a.label),
        disabled: !revealed && a.value !== 'direct', title: !revealed && a.value !== 'direct' ? locked : null,
      })), s.arch, v => { s.arch = v; update(); }),
    ),
    row(
      slider(tx({ en: 'Keep old code', vi: 'Giữ code cũ' }), { min: 0, max: 30, value: s.keep, format: v => tx({ en: `${v} wk`, vi: `${v} tuần` }) },
        v => { s.keep = v; redraw(); }),
      slider(tx({ en: 'Users updating each week', vi: 'Người dùng cập nhật mỗi tuần' }), { min: 2, max: 40, value: Math.round(s.update * 100), format: v => `${v}%` },
        v => { s.update = v / 100; redraw(); }),
      slider(tx({ en: 'Never update', vi: 'Không bao giờ cập nhật' }), { min: 0, max: 40, value: Math.round(s.stuck * 100), format: v => `${v}%` },
        v => { s.stuck = v / 100; redraw(); }),
    ),
    chart.el,
    el('div', { class: 'sim-legend' }, [
      key(css('bad'), tx({ en: 'users whose app calls a deleted endpoint', vi: 'người dùng có app gọi endpoint đã xoá' })),
      key(css('blue'), tx({ en: 'endpoint moves', vi: 'endpoint được chuyển' })),
      key(css('faint'), tx({ en: 'old code deleted', vi: 'xoá code cũ' })),
    ]),
    el('div', { class: 'sim-stats' }, [peak.el, end.el, checks.el, kept.el]),
    el('p', { class: 'sim-note' }, tx({
      en: 'The update curve is an illustrative model, not measured data. Defaults put about one in five users on a version older than six months.',
      vi: 'Đường cập nhật là mô hình minh hoạ, không phải số liệu đo được. Giá trị mặc định cho khoảng một phần năm người dùng ở bản cũ hơn sáu tháng.',
    })),
    el('div', { class: 'sim-foot' }, [
      revealed ? el('span') : el('p', { class: 'sim-note' }, locked),
      button(tx({ en: 'Replay', vi: 'Chạy lại' }), replay),
    ]),
  );

  const stopResize = onResize(chart.el, () => { stop(); draw(); });
  update();
  return () => { stop(); stopResize(); };
}
