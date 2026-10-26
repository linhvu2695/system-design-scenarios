/* The shared player's clock: steps play in order, each lingers for DWELL once it has
   finished so its caption can be read, and Step cuts a linger short or finishes the
   step in progress. The scenarios' own tests pin what happens in each run. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start, tick, skip, DWELL } from '../js/sim-player.js';

const steps = [{ d: 1 }, { d: 2 }];
const duration = st => st.d;

test('a step advances by its share of its duration, then lingers', () => {
  let c = tick(start(), 0.5, steps, duration);
  assert.deepEqual(c, { k: 0, p: 0.5, wait: 0 });
  c = tick(c, 0.5, steps, duration);
  assert.deepEqual(c, { k: 1, p: 0, wait: DWELL });
  c = tick(c, DWELL, steps, duration);
  assert.equal(c.wait, 0);
  c = tick(c, 1, steps, duration);
  assert.deepEqual(c, { k: 1, p: 0.5, wait: 0 }, 'the second step takes twice as long');
});

test('the clock stops at the end', () => {
  const end = { k: 2, p: 0, wait: 0 };
  assert.equal(tick(end, 5, steps, duration), end);
  assert.equal(skip(end, steps), end);
});

test('Step cuts a linger short, or finishes the step in progress without lingering', () => {
  assert.deepEqual(skip({ k: 1, p: 0, wait: 0.7 }, steps), { k: 1, p: 0, wait: 0 });
  assert.deepEqual(skip({ k: 0, p: 0.3, wait: 0 }, steps), { k: 1, p: 0, wait: 0 });
});
