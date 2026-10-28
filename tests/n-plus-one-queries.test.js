/* The simulation's model is the scenario's argument, so it is pinned here as a
   scoreboard: lazy loading costs 1 + 2N round trips; a cache makes each trip quicker
   but not fewer, and serves stale tags; a JOIN under LIMIT loses tickets and tags;
   denormalizing makes a tag rename rewrite millions of rows; batching with IN (...)
   costs 3 round trips, reads fresh data and keeps writes small. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, survives, tickets, SETUPS, SITUATIONS, PAGE, BUDGET, WRITE_BUDGET } from '../scenarios/n-plus-one-queries/sim.js';

const EXPECTED = {
  //       page   retag  rename
  lazy: [false, true, true],
  cache: [true, false, false],
  join: [false, false, false],
  batch: [true, true, true],
  denorm: [true, true, false],
};

for (const setup of SETUPS)
  test(`scoreboard: ${setup}`, () => {
    assert.deepEqual(SITUATIONS.map(x => survives(setup, x)), EXPECTED[setup]);
  });

test('lazy loading makes 1 + 2N round trips, one after another', () => {
  const r = run('lazy', 'page');
  assert.equal(r.trips.length, 1 + 2 * PAGE);
  for (let i = 1; i < r.trips.length; i++) assert.ok(r.trips[i].t0 >= r.trips[i - 1].t1);
  assert.ok(r.loadMs > BUDGET);
});

test('batching makes 3 round trips and fills every ticket with all its tags', () => {
  const r = run('batch', 'page');
  assert.equal(r.trips.length, 3);
  assert.equal(r.trips[2].rows, tickets('page').reduce((s, x) => s + x.tags.length, 0));
  assert.ok(r.complete && r.current && r.loadMs <= BUDGET);
});

test('a cache keeps the number of round trips; only each trip gets quicker', () => {
  const lazy = run('lazy', 'page'), cache = run('cache', 'page');
  assert.equal(cache.trips.length, lazy.trips.length);
  assert.ok(cache.loadMs < lazy.loadMs);
});

test('the cache shows tags from before a change', () => {
  for (const x of ['retag', 'rename']) assert.ok(run('cache', x).shown.some(s => s.stale), x);
});

test('a JOIN with LIMIT 8 runs out of rows inside the ticket with 30 tags', () => {
  const r = run('join', 'page');
  assert.equal(r.trips.length, 1);
  assert.equal(r.trips[0].rows, PAGE);
  assert.ok(r.shown.length < PAGE);
  assert.ok(r.shown.at(-1).cut > 0);
});

test('renaming a tag rewrites one row, unless names are copied onto every ticket', () => {
  assert.equal(run('batch', 'rename').write.rows, 1);
  assert.ok(run('denorm', 'rename').write.rows > WRITE_BUDGET);
});

test('every captioned step has both languages and the steps cover the run', () => {
  for (const setup of SETUPS)
    for (const x of SITUATIONS) {
      const r = run(setup, x);
      assert.equal(r.steps[0].t0, 0);
      assert.equal(r.steps.at(-1).t1, r.end);
      for (const s of r.steps) assert.ok(s.say.en && s.say.vi && s.t1 >= s.t0, `${setup}/${x}`);
    }
});
