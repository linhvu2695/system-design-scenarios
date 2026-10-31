/* The simulation's model is the scenario's argument, so it is pinned here: pull breaks
   when a notification brings readers in, push breaks when one account has a huge
   audience (and holds everyone else's posts behind it), and only the hybrid holds in
   every situation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  run, survives, rush, SETUPS, LAN_AT, TYPICAL, MINH, SITUATIONS, FOLLOWERS, FANOUT, ROWS, OPENS, RAMP, READS, PER_REPLICA, P99, FRESH,
} from '../scenarios/feed-fanout/sim.js';

const EXPECTED = {
  today: [true, true, false],
  replicas: [true, true, false],
  push: [true, false, false],
  table: [true, false, false],
  hybrid: [true, true, true],
};

test('scoreboard: evening, night, notify', () => {
  assert.deepEqual(SITUATIONS, ['evening', 'night', 'notify']);
  for (const setup of SETUPS)
    assert.deepEqual(SITUATIONS.map(x => survives(setup, x)), EXPECTED[setup], setup);
});

test('each setup fails for the reason the scenario gives', () => {
  const c = (s, x) => run(s, x).checks;
  for (const s of ['today', 'replicas']) {
    assert.equal(c(s, 'notify').reads, false, `${s}: the read rush beats the replicas`);
    assert.equal(c(s, 'notify').star, true, `${s}: but the post is never late`);
  }
  assert.ok(run('today', 'evening').maxP99 < 0.1, 'today is fine on an ordinary evening');
  for (const s of ['push', 'table']) {
    assert.equal(c(s, 'notify').reads, true, `${s}: reads stay fast`);
    assert.equal(c(s, 'night').star, false, `${s}: 1.5M copies take longer than 30 s`);
    assert.equal(c(s, 'night').others, false, `${s}: and ordinary posts wait behind them`);
    assert.ok(run(s, 'notify').missed > 100_000, `${s}: notified followers miss the post`);
  }
  assert.ok(Math.abs(run('push', 'night').starLag - FOLLOWERS / FANOUT) < 3);
  assert.ok(FOLLOWERS / ROWS > 4 * FRESH);
});

test('the notification rush peaks above even eight replicas', () => {
  const total = Array.from({ length: 6000 }, (_, i) => rush(i * 0.1) * 0.1).reduce((a, b) => a + b);
  assert.ok(Math.abs(total - OPENS) / OPENS < 0.02, 'the rush adds up to the followers who open the app');
  const peak = READS.notify + rush(RAMP);
  assert.ok(peak > 8 * PER_REPLICA && READS.notify < 4 * PER_REPLICA * 0.6);
});

test('the hybrid writes the big post once and keeps every check', () => {
  const r = run('hybrid', 'notify');
  assert.equal(r.starLag, 0);
  assert.ok(r.frames.every(f => f.queue.every(j => j.who === 'reg')), 'the footballer never enters the fanout queue');
  assert.ok(r.maxP99 <= P99 && r.regLag < 1);
});

test('an ordinary post is copied to its followers, and waits behind a big one', () => {
  for (const setup of ['push', 'table', 'hybrid']) {
    const r = run(setup, 'evening');
    assert.ok(r.lan.lag < 1, `${setup}: Lan's 200 copies land within a second`);
  }
  assert.ok(run('push', 'night').lan.lag > 30, 'behind the footballer, Lan waits too');
  const h = run('hybrid', 'night');
  assert.ok(h.lan.lag < 1, 'the hybrid never queues Lan behind the footballer');
  const after = h.at(LAN_AT + 1);
  assert.equal(after.lanDelivered, TYPICAL);
  assert.ok(MINH.lan < TYPICAL);
  assert.equal(run('today', 'night').lan.lag, 0, 'pull has nothing to copy');
});

test('steps run forward in time, in both languages', () => {
  for (const setup of SETUPS) for (const x of SITUATIONS) {
    const { steps, end, summary } = run(setup, x);
    let t = -Infinity;
    for (const st of steps) {
      assert.ok(st.t0 >= t && st.t1 >= st.t0 && st.t1 <= end + 1e-9, `${setup}/${x}`);
      assert.ok(st.say.en && st.say.vi && st.dur > 0, `${setup}/${x}`);
      t = st.t0;
    }
    assert.ok(summary.en && summary.vi);
  }
});
