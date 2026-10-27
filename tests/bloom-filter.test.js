/* The simulation's model is the scenario's argument, so it is pinned here as a
   scoreboard: only a Bloom filter turns away random guesses, keeps a brand-new link
   working, and fits 2 billion codes in the memory there is. Caching "not found" and
   rate limits per IP leave the guesses on Postgres; an exact set works but does not fit. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, survives, bitsOf, SETUPS, SITUATIONS, LINKS, M, K, DB_CAP, MEMORY_GB, BUDGET_GB, ALIAS, CREATE_AT, T } from '../scenarios/bloom-filter/sim.js';

const EXPECTED = {
  //          normal scan  launch memory
  today: [true, false, true, true],
  negcache: [true, false, false, true],
  exactset: [true, true, true, false],
  bloom: [true, true, true, true],
  ratelimit: [true, false, true, true],
};

for (const setup of SETUPS)
  test(`scoreboard: ${setup}`, () => {
    assert.deepEqual(SITUATIONS.map(x => survives(setup, x)), EXPECTED[setup]);
  });

test('each code maps to K bit positions inside the array, the same every time', () => {
  for (const c of [...LINKS, ALIAS, 'zzzzzzz']) {
    const b = bitsOf(c);
    assert.equal(b.length, K);
    assert.ok(b.every(x => Number.isInteger(x) && x >= 0 && x < M), c);
    assert.deepEqual(bitsOf(c), b);
  }
});

test('the filter never refuses a real link (no false negatives)', () => {
  for (const x of SITUATIONS) {
    const r = run('bloom', x);
    assert.ok(r.reqs.filter(q => LINKS.includes(q.code)).every(q => q.pass && q.outcome === 'ok'), x);
  }
});

test('a "no" from the filter means at least one of the code’s bits is 0', () => {
  const r = run('bloom', 'scan');
  const no = r.reqs.filter(q => !q.pass);
  assert.ok(no.length > 0);
  assert.ok(no.every(q => q.bitVals.includes(0)));
});

test('the filter turns away most guesses; the few that pass are false positives', () => {
  const r = run('bloom', 'scan');
  assert.ok(r.fps > 0, 'the toy filter should show a false positive');
  assert.ok(r.guessesToDb < r.guesses * 0.25);
  assert.ok(r.reqs.filter(q => q.fp).every(q => q.bitVals.every(Boolean) && q.outcome === 'notfound'));
});

test('caching "not found" and rate limits per IP leave every guess on Postgres', () => {
  for (const setup of ['today', 'negcache', 'ratelimit']) {
    const r = run(setup, 'scan');
    assert.equal(r.guessesToDb, r.guesses, setup);
    assert.ok(r.peak > DB_CAP, setup);
  }
  assert.ok(run('ratelimit', 'scan').reqs.every(q => q.pass), 'no scanner IP reaches the limit');
});

test('a cached "not found" makes a brand-new link answer 404; the filter adds it on create', () => {
  const late = r => r.reqs.filter(q => q.code === ALIAS && q.t >= CREATE_AT);
  assert.ok(late(run('negcache', 'launch')).some(q => q.wrong));
  assert.ok(late(run('bloom', 'launch')).every(q => q.outcome === 'ok'));
});

test('only the exact set is too big for the memory budget', () => {
  assert.ok(MEMORY_GB.exactset > BUDGET_GB);
  assert.ok(MEMORY_GB.bloom <= BUDGET_GB && MEMORY_GB.bloom > 2);
});

test('every captioned step has both languages and the steps cover the run', () => {
  for (const setup of SETUPS)
    for (const x of SITUATIONS) {
      const { steps } = run(setup, x);
      assert.equal(steps[0].t0, 0);
      assert.equal(steps.at(-1).t1, T);
      for (const s of steps) assert.ok(s.say.en && s.say.vi && s.t1 >= s.t0, `${setup}/${x}`);
    }
});
