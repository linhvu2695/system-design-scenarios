/* The simulation's model is the scenario's argument, so it is pinned here: lazy loading
   costs 1 + 2N queries; batching costs 3 whatever N is; a JOIN with LIMIT is one query
   but loses tickets and cuts off tags. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queue, load, time } from '../scenarios/n-plus-one-queries/sim.js';

const tickets = queue(400);

test('lazy loading makes 1 + 2N queries', () => {
  for (const n of [25, 100, 200]) assert.equal(load('lazy', tickets, n).queries.length, 1 + 2 * n);
});

test('batching makes 3 queries whatever the page size', () => {
  for (const n of [25, 100, 200]) assert.equal(load('batch', tickets, n).queries.length, 3);
});

test('lazy and batch return the same tag rows and a full page', () => {
  const tagRows = r => r.queries.filter(q => q.kind === 'tags').reduce((s, q) => s + q.rows, 0);
  const lazy = load('lazy', tickets, 100), batch = load('batch', tickets, 100);
  assert.equal(tagRows(lazy), tagRows(batch));
  for (const r of [lazy, batch]) {
    assert.equal(r.shown.length, 100);
    assert.ok(r.shown.every(v => v === 'ok'));
  }
});

test('a JOIN with LIMIT 100 puts far fewer than 100 tickets on the page', () => {
  const { queries, shown } = load('join', tickets, 100);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].rows, 100);
  assert.ok(shown.length < 50, `got ${shown.length}`);
});

test('a JOIN with LIMIT can cut the last ticket\'s tags', () => {
  const { shown } = load('join', [{ agent: 0, tags: 3 }, { agent: 1, tags: 30 }], 10);
  assert.deepEqual(shown, ['ok', 'partial']);
});

test('a JOIN is exact when no ticket has more than one tag', () => {
  const flat = Array.from({ length: 50 }, (_, i) => ({ agent: i % 3, tags: i % 2 }));
  assert.ok(load('join', flat, 20).shown.every(v => v === 'ok'));
  assert.equal(load('join', flat, 20).shown.length, 20);
});

test('batching is much faster than lazy loading at any realistic round trip', () => {
  for (const rtt of [0.2, 1, 5]) {
    const lazy = time(load('lazy', tickets, 100).queries, rtt);
    const batch = time(load('batch', tickets, 100).queries, rtt);
    assert.ok(batch * 5 < lazy, `rtt ${rtt}: ${batch} vs ${lazy}`);
  }
});

test('the queue is deterministic and has heavily tagged tickets', () => {
  assert.deepEqual(queue(100), queue(100));
  assert.ok(queue(100).some(t => t.tags >= 30));
});
