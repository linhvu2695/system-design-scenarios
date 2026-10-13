/* The simulation's model is the scenario's argument, so it is pinned here: after the
   app's 40-request burst, only the token bucket keeps accepting autosaves at once; the
   windows lock the user out, the leaky bucket makes them wait far past the timeout,
   and every new algorithm still holds a script to 40 + 30 a minute. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, limiter, traffic, BURST, RATE, SPAN, WINDOW } from '../scenarios/rate-limit-algorithms/sim.js';

const app = traffic('app');
const run = algo => decide(algo, app);
const rejected = res => res.filter(r => !r.ok).length;
const autosavesRejected = res => rejected(res.slice(BURST));
const maxWait = res => Math.max(...res.map(r => r.wait));

test('today\'s fixed window rejects part of the sync burst', () => {
  assert.ok(rejected(run('fixed').slice(0, BURST)) > 0);
});

test('the token bucket takes the burst and every autosave, at once', () => {
  const res = run('token');
  assert.equal(rejected(res), 0);
  assert.equal(maxWait(res), 0);
});

test('sliding windows take the burst, then lock autosaves out', () => {
  for (const algo of ['log', 'counter']) {
    const res = run(algo);
    assert.equal(rejected(res.slice(0, BURST)), 0, `${algo}: burst`);
    assert.ok(autosavesRejected(res) >= 10, `${algo}: only ${autosavesRejected(res)} autosaves rejected`);
  }
});

test('the leaky bucket rejects nothing but makes requests wait far past 10 s', () => {
  const res = run('leaky');
  assert.equal(rejected(res), 0);
  assert.ok(maxWait(res) > 60, `got ${maxWait(res)}`);
});

test('every new algorithm holds a script to a full bucket plus 30 a minute', () => {
  const script = traffic('script');
  for (const algo of ['log', 'counter', 'token', 'leaky']) {
    const served = decide(algo, script).filter(r => r.ok).length;
    assert.ok(served <= BURST + RATE * SPAN + 1, `${algo}: ${served}`);
    assert.ok(served >= BURST, `${algo}: should still serve the burst, got ${served}`);
  }
});

test('the leaky bucket serves one request every 2 s, in order', () => {
  const res = decide('leaky', [0, 0, 0]);
  assert.deepEqual(res.map(r => r.wait), [0, 2, 4]);
});

test('the token bucket refills at RATE up to BURST', () => {
  const drain = Array.from({ length: BURST }, () => 0);
  assert.equal(rejected(decide('token', [...drain, 0])), 1);
  assert.equal(rejected(decide('token', [...drain, 2])), 0);
  assert.equal(rejected(decide('token', [...drain, 1000, ...Array(BURST).fill(1000)])), 1);
});

test('traffic is deterministic', () => {
  assert.deepEqual(traffic('app'), traffic('app'));
  assert.deepEqual(traffic('script'), traffic('script'));
});

/* view() feeds the drawing, so it must show the same state offer() decides on. */
test('views: token refill, leaky queue, log ageing, counter estimate, fixed reset', () => {
  const token = limiter('token');
  for (let i = 0; i < BURST; i++) token.offer(0);
  assert.equal(token.view(0).tokens, 0);
  assert.equal(token.view(10).tokens, 10 * RATE);
  assert.equal(token.view(10).tokens, 10 * RATE, 'view must not spend or store tokens');

  const leaky = limiter('leaky');
  for (let i = 0; i < 5; i++) leaky.offer(0);
  assert.equal(leaky.view(0).queued, 4, 'the first goes straight out; four wait');
  assert.equal(leaky.view(4.5).queued, 2);

  const log = limiter('log');
  log.offer(0); log.offer(30);
  assert.equal(log.view(50).times.length, 2);
  assert.equal(log.view(WINDOW + 10).times.length, 1);

  const counter = limiter('counter');
  for (let i = 0; i < 10; i++) counter.offer(1);
  assert.equal(counter.view(WINDOW + WINDOW / 4).estimate, 10 * 0.75);

  const fixed = limiter('fixed');
  fixed.offer(5);
  assert.equal(fixed.view(30).count, 1);
  assert.equal(fixed.view(61).count, 0);
});
