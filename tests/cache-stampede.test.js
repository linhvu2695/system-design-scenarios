/* The simulation's model is the scenario's argument, so it is pinned here as a
   scoreboard: without help, an expiring hot key sends hundreds of queries to Postgres;
   a lock keeps it to one but makes everyone wait; early refresh avoids the wait but
   cannot stop duplicate rebuilds at peak; coalescing still sends one query per pod; only
   refreshing ahead keeps one query, no waiting and a fresh feed, even when its worker
   dies for a while. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, survives, SETUPS, SITUATIONS, PODS, POOL, P99, MAX_AGE, REFRESH, EXPIRES, BUILD } from '../scenarios/cache-stampede/sim.js';

const EXPECTED = {
  //           night  peak  slow  worker
  today: [false, false, false, false],
  lock: [false, false, false, false],
  early: [true, false, false, false],
  coalesce: [false, false, false, false],
  ahead: [true, true, true, true],
};

for (const setup of SETUPS)
  test(`scoreboard: ${setup}`, () => {
    assert.deepEqual(SITUATIONS.map(x => survives(setup, x)), EXPECTED[setup]);
  });

test('today, every request that misses queries Postgres, up to the pods’ connection pools', () => {
  const r = run('today', 'peak');
  assert.equal(r.maxQueries, PODS * POOL);
  assert.ok(r.timeouts > 0);
});

test('a lock runs one query, and the requests behind it wait as long as the rebuild', () => {
  for (const x of ['peak', 'slow']) {
    const r = run('lock', x);
    assert.equal(r.maxQueries, 1, x);
    assert.ok(r.worstP99 >= BUILD[x] - 0.05, `${x}: ${r.worstP99}`);
  }
});

test('early refresh never misses, but at peak more than one reader rebuilds', () => {
  const r = run('early', 'peak');
  assert.ok(r.frames.every(f => f.has), 'the key never expires');
  assert.ok(r.worstP99 <= P99);
  assert.ok(r.maxQueries > 1);
  assert.ok(run('early', 'slow').maxQueries > r.maxQueries, 'a slower rebuild opens the window wider');
});

test('coalescing sends one query per pod', () => {
  assert.equal(run('coalesce', 'peak').maxQueries, PODS);
});

test('refreshing ahead: one query every 20 s, the key never missing, the feed young', () => {
  const r = run('ahead', 'peak');
  assert.ok(r.frames.every(f => f.has));
  const starts = r.queries.map(q => q.start);
  starts.slice(1).forEach((s, i) => assert.ok(Math.abs(s - starts[i] - REFRESH) < 0.05));
  assert.ok(r.maxAge <= REFRESH + 1);
  const w = run('ahead', 'worker');
  assert.ok(w.maxAge > REFRESH + 5 && w.maxAge <= MAX_AGE, `worker down: ${w.maxAge}`);
});

test('every captioned step has both languages and the steps cover the run', () => {
  for (const setup of SETUPS)
    for (const x of SITUATIONS) {
      const r = run(setup, x);
      assert.equal(r.steps[0].t0, 0);
      assert.equal(r.steps.at(-1).t1, 34);
      for (const s of r.steps) assert.ok(s.say.en && s.say.vi && s.t1 >= s.t0 && s.t0 <= EXPIRES + 10, `${setup}/${x}`);
    }
});
