/* The simulation's model is the scenario's argument, so it is pinned here: a breaker
   alone lets a hanging API starve the shared pool before it can open, a bulkhead alone
   never stops calling, retries multiply calls to a failing API, and only the two
   together meet all four constraints. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  run, survives, SETUPS, SITUATIONS, CHECKOUTS, POOL, FRAUD_SLOTS, START, FIX, OPEN_WAIT, TIMEOUT, TRICKLE,
} from '../scenarios/circuit-breaker/sim.js';

const EXPECTED = {
  today: [true, false, false],
  retry: [true, false, false],
  breaker: [true, false, true],
  bulkhead: [true, false, false],
  both: [true, true, true],
};

test('scoreboard: normal, hang, errors', () => {
  assert.deepEqual(SITUATIONS, ['normal', 'hang', 'errors']);
  for (const setup of SETUPS)
    assert.deepEqual(SITUATIONS.map(x => survives(setup, x)), EXPECTED[setup], setup);
});

test('each setup fails for the reason the scenario gives', () => {
  const c = (s, x) => run(s, x).checks;
  assert.equal(c('today', 'hang').others, false, 'a hanging API starves the shared pool');
  assert.equal(c('retry', 'hang').trickle, false, 'retries multiply calls to a failing API');
  assert.equal(c('retry', 'errors').trickle, false);
  assert.ok(run('retry', 'errors').callsPerSec >= 3.5 * CHECKOUTS);
  assert.equal(c('breaker', 'hang').others, false, 'the pool fills before the first timeout arrives');
  assert.ok(run('breaker', 'hang').queuedAtTrip > 20, 'fraud calls were queued while the breaker was closed');
  assert.equal(c('bulkhead', 'hang').others, true, 'the wall keeps /cart and /orders fast');
  assert.equal(c('bulkhead', 'hang').checkout, false, 'but every timeout lets 8 more orders hang');
  assert.equal(c('bulkhead', 'errors').trickle, false, 'and fast 503s never fill the bulkhead');
});

test('the bulkhead never lets fraud calls hold more than their share', () => {
  for (const setup of ['bulkhead', 'both']) {
    const r = run(setup, 'hang');
    for (const f of r.frames) {
      assert.equal(f.fenced.length, FRAUD_SLOTS);
      assert.ok(f.shared.every(s => !s || s[0] !== 'fraud'), `${setup} at ${f.t}`);
    }
  }
  assert.equal(run('today', 'hang').at(20).shared.filter(s => s && s[0] === 'fraud').length, POOL);
});

test('the breaker opens on timeouts, probes once per wait, and closes after the fix', () => {
  const r = run('both', 'hang');
  assert.ok(Math.abs(r.trips[0] - (START + TIMEOUT)) < 1.5, `opened at ${r.trips[0]}`);
  assert.ok(Math.abs(r.trips[1] - (r.trips[0] + OPEN_WAIT + TIMEOUT)) < 0.5, 'the hanging probe fails at its timeout');
  assert.equal(r.closes.length, 1);
  assert.ok(r.closes[0] > FIX.hang && r.closes[0] < FIX.hang + 40);
  const probes = r.calls.filter(c => c.probe);
  assert.equal(probes.length, 2);
  const e = run('breaker', 'errors');
  assert.ok(e.trips[0] - START < 1.5, 'fast errors open it within a second or so');
  assert.ok(e.callsPerSec <= TRICKLE * CHECKOUTS);
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
