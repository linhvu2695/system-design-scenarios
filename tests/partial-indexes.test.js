/* The simulation's model is the scenario's argument, so it is pinned here as a
   scoreboard: only the partial index keeps every inbox under budget, keeps the import
   at today's index writes per row, and fits in the spare cache. The org_id index
   visits every row of a big organisation; the full-table indexes are fast to read but
   cost an extra write per imported row and do not fit in memory; a replica has the
   same indexes as the primary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, survives, latencyMs, indexesOf, SETUPS, SITUATIONS, NEW, CELLS, IMPORTED, ORGS, SPARE_MB, SLO_MS } from '../scenarios/partial-indexes/sim.js';

const EXPECTED = {
  //          small  big    insert import peak
  today: [true, false, true, true, true],
  partial: [true, true, true, true, true],
  composite: [true, true, true, false, false],
  covering: [true, true, true, false, false],
  replica: [true, false, true, true, true],
};

for (const setup of SETUPS)
  test(`scoreboard: ${setup}`, () => {
    assert.deepEqual(SITUATIONS.map(x => survives(setup, x)), EXPECTED[setup]);
  });

test('the org_id index visits every row of the organisation; a matching index reads only its newest open rows', () => {
  const visits = (setup, x) => run(setup, x).steps.flatMap(s => s.act.scan || []);
  const all = visits('today', 'big');
  assert.ok(all.every(i => CELLS[i].org === 'big'));
  assert.equal(all.length, CELLS.filter(c => c.org === 'big').length);
  for (const setup of ['partial', 'composite']) {
    const few = visits(setup, 'big');
    assert.ok(few.length <= 3 && few.every(i => CELLS[i].org === 'big' && CELLS[i].open), setup);
  }
  assert.ok(run('today', 'big').ms > SLO_MS * 10);
  assert.ok(run('partial', 'big').ms < SLO_MS);
});

test('a new open ticket is written to every index, the partial one included', () => {
  const r = run('partial', 'insert');
  assert.equal(r.writesPerRow, indexesOf('partial').length);
  assert.ok(r.steps.some(s => s.act.write === NEW.partial.name));
});

test('imported closed tickets skip the partial index and cost what they cost today', () => {
  const r = run('partial', 'import');
  assert.equal(r.writesPerRow, run('today', 'import').writesPerRow);
  assert.ok(r.steps.some(s => s.act.skip === NEW.partial.name));
  assert.equal(run('composite', 'import').writesPerRow, r.writesPerRow + 1);
  assert.equal(IMPORTED.length > 1, true);
});

test('only the partial index fits in the spare cache', () => {
  assert.deepEqual(Object.keys(NEW).filter(s => NEW[s].mb <= SPARE_MB), ['partial']);
  assert.ok(run('covering', 'peak').steps.some(s => s.act.evict));
  assert.ok(!run('partial', 'peak').steps.some(s => s.act.evict));
});

test('the covering index still visits the table for most rows', () => {
  assert.ok(run('covering', 'small').steps.some(s => s.act.heap && s.act.count > 25));
});

test('the cost model grows with rows read', () => {
  assert.ok(latencyMs({ entries: 50, rows: 50 }) < latencyMs({ entries: ORGS.small.tickets, rows: ORGS.small.tickets }));
});

test('every step has a caption in both languages', () => {
  for (const setup of SETUPS)
    for (const x of SITUATIONS)
      for (const s of run(setup, x).steps) assert.ok(s.say.en && s.say.vi, `${setup}/${x}: ${s.label}`);
});
