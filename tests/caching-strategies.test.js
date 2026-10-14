/* The simulation's model is the scenario's argument, so it is pinned here: only
   write-behind takes the per-view writes off Postgres; cache-aside deletes the key on
   every view so reads keep missing; read-through serves stale counts until its TTL;
   write-behind is the only one that can lose views when Redis dies. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { system, atScale, STRATEGIES, START, TTL, PROD } from '../scenarios/caching-strategies/sim.js';

/* 100 views, reading the count after every 10. */
function run(strategy) {
  const sys = system(strategy);
  let t = 0;
  for (let i = 0; i < 10; i++) {
    for (let k = 0; k < 10; k++) sys.view((t += 0.01));
    sys.read((t += 0.01));
  }
  return sys;
}

test('every strategy except write-behind writes Postgres once per view', () => {
  for (const st of ['today', 'aside', 'through', 'readthrough']) assert.equal(run(st).state.writes, 100, st);
});

test('write-behind writes Postgres once per flush, with every pending view', () => {
  const sys = run('behind');
  assert.equal(sys.state.writes, 0);
  assert.equal(sys.state.db, START);
  assert.equal(sys.state.pending, 100);
  sys.flush();
  assert.equal(sys.state.writes, 1);
  assert.equal(sys.state.db, START + 100);
  assert.equal(sys.state.pending, 0);
  assert.deepEqual(sys.flush(), [], 'nothing to flush, no write');
});

test('cache-aside deletes the key on every view, so a read after a view always misses', () => {
  const sys = run('aside');
  assert.equal(sys.state.hits, 0);
  assert.equal(sys.state.misses, 10);
  assert.equal(sys.state.reads, 10);
});

test('write-through and write-behind keep the cache fresh: readers see the true count', () => {
  for (const st of ['through', 'behind']) {
    const sys = run(st);
    assert.equal(sys.state.seen, sys.state.truth, st);
    assert.equal(sys.state.hits, 10, st);
    assert.equal(sys.state.reads, 0, st);
  }
});

test('read-through serves the old count until the TTL, then reloads', () => {
  const sys = system('readthrough');
  sys.view(0.1);
  sys.read(0.2);
  assert.equal(sys.state.seen, START, 'stale within the TTL');
  sys.read(TTL + 0.1);
  assert.equal(sys.state.seen, START + 1, 'reloaded after the TTL');
  assert.equal(sys.state.reads, 1);
});

test('crashing Redis loses pending views only with write-behind', () => {
  for (const st of STRATEGIES) {
    const sys = system(st);
    for (let i = 0; i < 7; i++) sys.view(i * 0.1);
    sys.crash(1);
    assert.equal(sys.state.lost, st === 'behind' ? 7 : 0, st);
    sys.read(1.1);
    if (st !== 'behind') assert.equal(sys.state.seen, START + 7, `${st}: Postgres had every view`);
  }
});

test('every hop carries a caption in both languages and a state snapshot', () => {
  for (const st of STRATEGIES) {
    const sys = system(st);
    for (const hop of [...sys.view(0), ...sys.read(0.1), ...sys.crash(0.2), ...sys.read(0.3)]) {
      assert.ok(hop.say.en && hop.say.vi, `${st}: ${hop.label}`);
      assert.ok(hop.state && typeof hop.state.db === 'number', `${st}: ${hop.label}`);
    }
  }
});

test('at the scenario’s scale only write-behind brings Postgres writes to a few hundred a second', () => {
  for (const st of STRATEGIES) {
    const w = atScale(st).dbWrites;
    if (st === 'behind') assert.ok(w <= 300, `${st}: ${w}`);
    else assert.equal(w, 150000, st);
  }
  assert.equal(atScale('behind').viewWaitsOnDb, false);
  assert.equal(atScale('behind').lostUpTo, PROD.flush, 'matches the scenario: every 5 seconds');
  assert.equal(atScale('readthrough').staleUpTo, PROD.ttl, 'matches option D: kept for 10 seconds');
});
