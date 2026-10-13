/* The simulation's model is the scenario's argument, so it is pinned here as a
   scoreboard: which setup keeps the parcel correct in which situation. Only checking
   seq on write survives all of them; FIFO fixes only what happens inside your queue;
   the buffer fixes only the burst; a single worker fixes nothing and falls behind. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeline, survives, STRATEGIES, SITUATIONS, HOLD, BACKLOG } from '../scenarios/event-ordering/sim.js';

const EXPECTED = {
  //        normal offline retry  crash  dup
  today:  [true, false, false, false, false],
  single: [true, false, false, false, false],
  fifo:   [true, false, false, true, false],
  buffer: [true, true, false, false, false],
  seq:    [true, true, true, true, true],
};

for (const st of STRATEGIES)
  test(`scoreboard: ${st}`, () => {
    assert.deepEqual(SITUATIONS.map(x => survives(st, x)), EXPECTED[st]);
  });

test('a run that goes wrong goes backwards and leaves the wrong status', () => {
  const t = timeline('today', 'offline');
  assert.equal(t.backwards, true);
  assert.equal(t.final, 3);
});

test('checking seq skips the late scan instead of applying it', () => {
  for (const x of SITUATIONS) {
    const t = timeline('seq', x);
    assert.equal(t.final, 4, x);
    assert.ok(t.applies.every(a => a.result !== 'backwards'), x);
  }
  assert.ok(timeline('seq', 'retry').applies.some(a => a.seq === 3 && a.result === 'skipped'));
});

test('every copy is picked up and applied exactly once', () => {
  for (const st of STRATEGIES)
    for (const x of SITUATIONS) {
      const t = timeline(st, x);
      assert.equal(t.applies.length, t.copies.length, `${st}/${x}`);
      for (const c of t.copies) assert.ok(c.apply > c.arrive, `${st}/${x} copy ${c.id}`);
    }
});

test('a crashed message is retried; FIFO holds the parcel’s next event until it is done', () => {
  const t = timeline('fifo', 'crash');
  const [three, four] = t.copies;
  assert.equal(three.picks.length, 2);
  assert.ok(four.picks[0].at >= three.done);
});

test('the buffer and a single worker cost time', () => {
  const four = st => timeline(st, 'normal').copies.find(c => c.seq === 4).apply;
  assert.ok(four('buffer') - four('today') >= HOLD - 1e-9);
  assert.ok(four('single') - four('today') >= BACKLOG);
  assert.equal(four('seq'), four('today'), 'the seq check adds no delay');
});
