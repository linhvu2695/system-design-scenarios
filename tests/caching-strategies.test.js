/* The simulation's model is the scenario's argument, so it is pinned here as a
   scoreboard: every strategy copes with a normal day and a Redis restart, and only
   write-behind survives breaking news, because it is the only one that stops writing
   Postgres once per view. Its price, views lost when Redis dies, stays within the
   few seconds the scenario allows. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, survives, viewsAt, SETUPS, SITUATIONS, T, PEAK, NORMAL, WRITE_BUDGET, TIMEOUT_MS, FLUSH, TTL, CRASH_AT, LOSS_OK } from '../scenarios/caching-strategies/sim.js';

const EXPECTED = {
  //             normal news  crash
  today: [true, false, true],
  aside: [true, false, true],
  through: [true, false, true],
  readthrough: [true, false, true],
  behind: [true, true, true],
};

for (const setup of SETUPS)
  test(`scoreboard: ${setup}`, () => {
    assert.deepEqual(SITUATIONS.map(x => survives(setup, x)), EXPECTED[setup]);
  });

test('breaking news peaks at the scenario’s 150,000 views a second', () => {
  assert.equal(viewsAt('news', T), PEAK);
  assert.equal(viewsAt('normal', T), NORMAL);
});

test('every strategy but write-behind writes Postgres once per view', () => {
  for (const setup of ['today', 'aside', 'through', 'readthrough']) {
    const r = run(setup, 'news');
    assert.ok(r.samples.every(s => s.writes === s.v), setup);
    assert.ok(r.maxPage >= TIMEOUT_MS, `${setup}: pages should time out`);
  }
});

test('write-behind writes once per article per flush, within the budget, and pages never wait', () => {
  const r = run('behind', 'news');
  assert.ok(r.maxWrites <= WRITE_BUDGET, `got ${r.maxWrites}`);
  assert.ok(r.flushes.every(f => f.t % FLUSH === 0));
  assert.ok(r.samples.every(s => s.queue === 0 && s.pageMs < 5));
});

test('write-behind loses no view on the way: Postgres plus pending is the true count', () => {
  for (const x of ['normal', 'news']) {
    const last = run('behind', x).samples.at(-1);
    assert.ok(Math.abs(last.db + last.pending - last.truth) < 1, x);
  }
});

test('cache-aside deletes the key on every view, so every read goes to Postgres too', () => {
  const r = run('aside', 'news');
  assert.ok(r.samples.every(s => s.dels === s.v && s.reads === s.v));
});

test('read-through reloads every TTL, so the page trails by up to the TTL', () => {
  const r = run('readthrough', 'normal');
  assert.deepEqual(r.loads.map(l => l.t), [TTL, 2 * TTL, 3 * TTL]);
  assert.ok(r.maxTrail > TTL - 1 && r.maxTrail <= TTL + 0.01, `got ${r.maxTrail}`);
  assert.ok(run('behind', 'normal').maxTrail < 0.01, 'write-behind reads include pending views');
});

test('a Redis restart loses views only with write-behind, at most one flush interval', () => {
  for (const setup of SETUPS) {
    const r = run(setup, 'crash');
    if (setup === 'behind') {
      assert.ok(r.lost > 0);
      assert.ok(r.lostSec <= LOSS_OK);
      assert.ok(Math.abs(r.lostSec - (CRASH_AT % FLUSH)) < 0.2);
    } else assert.equal(r.lost, 0, setup);
  }
});

test('every captioned step has both languages and the steps cover the run', () => {
  for (const setup of SETUPS)
    for (const x of SITUATIONS) {
      const r = run(setup, x);
      assert.equal(r.steps[0].t0, 0);
      assert.equal(r.steps.at(-1).t1, T);
      for (const s of r.steps) assert.ok(s.say.en && s.say.vi && s.t1 >= s.t0, `${setup}/${x}`);
    }
});
