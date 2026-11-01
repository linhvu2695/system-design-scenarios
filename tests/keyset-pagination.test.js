/* The simulation's model is the scenario's argument, so it is pinned here as a
   scoreboard: only the cursor on (created_at, id) is fast at any depth and returns every
   payment exactly once. OFFSET, with or without a deferred join, slows down with depth
   and repeats rows when new payments arrive at the top; walking oldest first fixes the
   repeats but not the depth; a cursor on the timestamp alone loses the rows of a batch
   that shares one timestamp. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, survives, work, pageMs, SETUPS, SITUATIONS, DEPTH, BUDGET_MS, BATCH_IDS, NEW_ROWS } from '../scenarios/keyset-pagination/sim.js';

const EXPECTED = {
  //        shallow deep   arrive batch
  offset: [true, false, false, true],
  deferred: [true, false, false, true],
  stamp: [true, true, true, false],
  cursor: [true, true, true, true],
  oldest: [true, false, true, true],
};

for (const setup of SETUPS)
  test(`scoreboard: ${setup}`, () => {
    assert.deepEqual(SITUATIONS.map(x => survives(setup, x)), EXPECTED[setup]);
  });

test('OFFSET reads every row before the page; a cursor reads only the page', () => {
  const deep = DEPTH.deep;
  assert.equal(work('offset', deep).entries, deep * 100);
  assert.equal(work('offset', deep).thrown, (deep - 1) * 100);
  assert.equal(work('cursor', deep).entries, 100);
  assert.equal(work('cursor', deep).thrown, 0);
  // A deferred join skips the table for the skipped rows, not the index entries.
  assert.equal(work('deferred', deep).entries, work('offset', deep).entries);
  assert.equal(work('deferred', deep).rows, 100);
});

test('shallow pages are fast for every setup; OFFSET slows down with depth and the cursor does not', () => {
  for (const setup of SETUPS) assert.ok(pageMs(setup, DEPTH.shallow) < 5, setup);
  assert.ok(pageMs('offset', 3_500) > BUDGET_MS);
  assert.ok(pageMs('offset', 3_400) < BUDGET_MS);
  assert.ok(pageMs('deferred', 3_500) < BUDGET_MS);
  assert.ok(pageMs('deferred', DEPTH.deep) > BUDGET_MS);
  assert.equal(pageMs('cursor', DEPTH.deep), pageMs('cursor', 1));
  assert.ok(pageMs('offset', DEPTH.deep) > 6000);
});

test('with OFFSET, payments that arrive at the top come back again on the next page', () => {
  const r = run('offset', 'arrive');
  assert.deepEqual(r.dups, [118, 117, 116]);
  assert.equal(r.dups.length, NEW_ROWS.length);
  assert.deepEqual(run('cursor', 'arrive').received, [120, 119, 118, 117, 116, 115, 114, 113, 112, 111]);
});

test('a cursor on the timestamp alone skips the rest of a batch; the id tie-breaker keeps it', () => {
  const r = run('stamp', 'batch');
  assert.deepEqual(r.missing, BATCH_IDS.slice(3));
  const c = run('cursor', 'batch');
  assert.deepEqual(c.missing, []);
  assert.deepEqual(c.received.slice(5), [213, 212, 211, 210, 209]);
});

test('every step has a caption in both languages', () => {
  for (const setup of SETUPS)
    for (const x of SITUATIONS)
      for (const s of run(setup, x).steps) assert.ok(s.say.en && s.say.vi, `${setup}/${x}: ${s.label}`);
});
