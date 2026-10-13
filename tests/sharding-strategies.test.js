/* The simulation's model is the scenario's argument, so it is pinned here: sharding on
   the order id scatters every merchant (and a range puts every new order on one shard);
   consistent hashing keeps merchants whole and moves little, but cannot keep EU data in
   the EU or give the largest merchant its own server; only the directory does all of it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merchants, orders, place, analyze, moved, ranges, directory, hash, START, MAX_SHARDS } from '../scenarios/sharding-strategies/sim.js';

const ms = merchants(), ords = orders(ms), n = START.length;
const run = (strategy, k = n) => analyze(place(strategy, ms, ords, k), ms, ords, k);

test('range on order id puts every new order on one shard', () => {
  assert.equal(run('range').hottest, 1);
});

test('sharding on order id scatters a merchant over every shard', () => {
  for (const strategy of ['range', 'hash'])
    for (const id of [0, 1]) assert.equal(run(strategy).spread(id), n, `${strategy}, merchant ${id}`);
});

test('hash mod N moves most orders when a shard is added', () => {
  for (let k = n; k < MAX_SHARDS; k++) assert.ok(moved('hash', ms, ords, k) > 0.6, `${k} -> ${k + 1}`);
});

test('consistent hashing keeps merchants whole and moves only a small share', () => {
  for (let k = n; k < MAX_SHARDS; k++) {
    const r = run('consistent', k);
    assert.ok(ms.every(m => r.spread(m.id) === 1), `${k} shards`);
    assert.ok(moved('consistent', ms, ords, k) < 0.35, `${k} -> ${k + 1}`);
  }
});

test('consistent hashing cannot keep EU orders in the EU or the largest merchant alone', () => {
  const r = run('consistent');
  assert.ok(r.euOutside > 0);
  assert.ok(r.neighbours > 0);
});

test('the directory keeps merchants whole, EU data in the EU, and the largest merchant alone', () => {
  for (let k = n; k <= MAX_SHARDS; k++) {
    const r = run('directory', k);
    assert.ok(ms.every(m => r.spread(m.id) === 1), `${k} shards`);
    assert.equal(r.euOutside, 0, `${k} shards`);
    assert.equal(r.neighbours, 0, `${k} shards`);
  }
});

test('the directory fills a new shard by moving a few whole merchants', () => {
  for (let k = n; k < MAX_SHARDS; k++) {
    const share = moved('directory', ms, ords, k);
    assert.ok(share > 0 && share < 0.3, `${k} -> ${k + 1}: ${share}`);
  }
  const before = directory(ms, n), after = directory(ms, n + 1);
  const movedIds = ms.filter(m => before.get(m.id) !== after.get(m.id));
  assert.ok(movedIds.every(m => after.get(m.id) === n), 'merchants only move onto the new shard');
});

test('ranges cover every id exactly once', () => {
  for (let k = n; k <= MAX_SHARDS; k++) {
    const rs = ranges(ords.length, k).sort((a, b) => a.from - b.from);
    assert.equal(rs[0].from, 0);
    assert.equal(rs.at(-1).to, ords.length);
    rs.slice(1).forEach((r, i) => assert.equal(r.from, rs[i].to));
    assert.equal(new Set(rs.map(r => r.shard)).size, k);
  }
});

test('data is deterministic and the hash is stable', () => {
  assert.deepEqual(merchants(), merchants());
  assert.deepEqual(orders(ms), orders(ms));
  assert.equal(hash('merchant-1'), hash('merchant-1'));
  assert.notEqual(hash('merchant-1'), hash('merchant-2'));
});
