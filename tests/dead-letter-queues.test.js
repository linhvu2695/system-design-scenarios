/* The simulation's model is the scenario's argument, so it is pinned here as a
   scoreboard: today's quick retries drop messages; retrying in place blocks a
   partition behind a bad message and bursts past the provider's limit afterwards;
   scaling out drops faster; retrying from memory loses what a restart wipes; only a
   rate cap with a retry topic and a dead-letter queue loses nothing, stays fast and
   stays under the limit. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, survives, SETUPS, SITUATIONS, POISON, LIMIT, CAP, MAX_REJECT, ATTEMPTS, RETRY_DELAY } from '../scenarios/dead-letter-queues/sim.js';

const EXPECTED = {
  //         steady outage poison deploy
  today: [true, false, false, false],
  inplace: [true, false, false, false],
  scale: [true, false, false, false],
  memory: [true, false, false, false],
  dlq: [true, true, true, true],
};

for (const setup of SETUPS)
  test(`scoreboard: ${setup}`, () => {
    assert.deepEqual(SITUATIONS.map(x => survives(setup, x)), EXPECTED[setup]);
  });

test('every message ends delivered, in the dead-letter queue, lost, or still in flight', () => {
  for (const setup of SETUPS)
    for (const x of SITUATIONS)
      for (const m of run(setup, x).msgs) assert.ok(['delivered', 'dlq', 'lost', 'queued', 'waiting', 'memory', 'retry', 'sending'].includes(m.state), `${setup}/${x}: ${m.state}`);
});

test('quick retries drop what fails during an outage; scaling out drops more', () => {
  const today = run('today', 'outage'), scale = run('scale', 'outage');
  assert.ok(today.lost > 0);
  assert.ok(scale.lost > today.lost);
});

test('retrying in place loses nothing, but a bad message stops its partition', () => {
  assert.equal(run('inplace', 'outage').lost, 0);
  const r = run('inplace', 'poison');
  assert.equal(r.poison, 'waiting');
  const behind = r.msgs.filter(m => m.part === r.msgs[POISON - 1].part && m.id > POISON);
  assert.ok(behind.every(m => m.state !== 'delivered'), 'nothing behind the bad message gets through');
});

test('uncapped consumers catching up after an outage run past the provider’s limit', () => {
  for (const setup of ['inplace', 'memory']) assert.ok(run(setup, 'outage').share > MAX_REJECT, setup);
});

test('a restart wipes the retries kept in memory', () => {
  assert.ok(run('memory', 'deploy').lost > 0);
  assert.equal(run('memory', 'poison').poison, 'memory', 'the bad message is retried forever and never reported');
});

test('the dead-letter setup never exceeds its cap, and the cap is under the provider’s limit', () => {
  assert.ok(CAP < LIMIT);
  for (const x of SITUATIONS) {
    const r = run('dlq', x);
    assert.equal(r.rejected, 0, x);
    for (const q of r.requests) assert.ok(r.requests.filter(o => o.t > q.t - 1 + 1e-6 && o.t <= q.t).length <= CAP, `${x} at ${q.t}`);
  }
});

test('a 400 goes straight to the dead-letter queue; transient errors are retried after the delay', () => {
  const p = run('dlq', 'poison').msgs[POISON - 1];
  assert.equal(p.state, 'dlq');
  assert.equal(p.attempts, 1);
  const retried = run('dlq', 'outage').msgs.filter(m => m.log.length > 1);
  assert.ok(retried.length > 0);
  for (const m of retried) {
    assert.ok(m.log.length <= ATTEMPTS);
    m.log.slice(1).forEach((a, i) => assert.ok(a.t - m.log[i].t >= RETRY_DELAY - 1e-9));
  }
});

test('every captioned step has both languages and the steps cover the run', () => {
  for (const setup of SETUPS)
    for (const x of SITUATIONS) {
      const r = run(setup, x);
      assert.equal(r.steps[0].t0, 0);
      assert.equal(r.steps.at(-1).t1, 45);
      for (const s of r.steps) assert.ok(s.say.en && s.say.vi && s.t1 >= s.t0, `${setup}/${x}`);
    }
});
