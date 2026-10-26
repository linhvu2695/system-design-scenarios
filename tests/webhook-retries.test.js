/* The simulation's model is the scenario's argument, so it is pinned here as a
   scoreboard: only the inbox ends every situation with exactly one book and Stripe
   answered. Doing the work in the request doubles books when the printer is slow or
   the event arrives twice, and a client timeout does not help; replying before storing
   loses the order on a deploy; recording the event ID before the work turns a deploy
   into a lost order. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, survives, SETUPS, SITUATIONS } from '../scenarios/webhook-retries/sim.js';

const EXPECTED = {
  //          normal slow   crash  dup
  today: [true, false, true, false],
  fast: [true, false, true, false],
  inbox: [true, true, true, true],
  background: [true, true, false, false],
  dedup: [true, true, false, true],
};

for (const setup of SETUPS)
  test(`scoreboard: ${setup}`, () => {
    assert.deepEqual(SITUATIONS.map(x => survives(setup, x)), EXPECTED[setup]);
  });

test('today, a slow printer makes Stripe time out while the handler keeps going, and the retry prints a second book', () => {
  const r = run('today', 'slow');
  assert.deepEqual(r.results, ['timeout', '200']);
  assert.ok(r.hops.some(h => h.label === '200' && h.kind === 'late'), 'the late 200 reaches nobody');
  assert.equal(r.books, 2);
});

test('a client timeout returns 500 but the partner still prints, so the retry prints again', () => {
  const r = run('fast', 'slow');
  assert.deepEqual(r.results, ['500', '200']);
  assert.equal(r.books, 2);
});

test('replying before storing loses the order on a deploy: Stripe has its 200 and never resends', () => {
  const r = run('background', 'crash');
  assert.deepEqual(r.results, ['200']);
  assert.equal(r.final.order, 'paid');
  assert.equal(r.books, 0);
});

test('recording the event ID before the work makes the retry after a deploy skip an order that was never printed', () => {
  const r = run('dedup', 'crash');
  assert.deepEqual(r.results, ['timeout', '200']);
  assert.equal(r.books, 0);
});

test('the inbox stores the event before replying, never times out, and a dead worker’s row is finished by another', () => {
  for (const x of SITUATIONS) {
    const r = run('inbox', x);
    assert.ok(r.results.every(v => v === '200'), x);
    assert.ok(!r.hops.some(h => h.label === 'TIMEOUT'), x);
    const stored = r.hops.findIndex(h => h.label === 'OK' && h.from === 'db' && h.to === 'api');
    const replied = r.hops.findIndex(h => h.label === '200');
    assert.ok(stored >= 0 && stored < replied, `${x}: the 200 must come after the insert`);
  }
  const crash = run('inbox', 'crash');
  assert.ok(crash.hops.some(h => h.label === 'LEASE EXPIRED'));
  assert.equal(crash.final.inbox, 'done');
});

test('every message has a caption in both languages and moves between known boxes', () => {
  const boxes = new Set(['stripe', 'api', 'work', 'db', 'printer']);
  for (const setup of SETUPS)
    for (const x of SITUATIONS)
      for (const h of run(setup, x).hops) {
        assert.ok(boxes.has(h.from) && boxes.has(h.to), `${setup}/${x}: ${h.from} → ${h.to}`);
        assert.ok(h.say.en && h.say.vi, `${setup}/${x}: ${h.label} needs both languages`);
      }
});
