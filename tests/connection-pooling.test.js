/* The simulation's model is the scenario's argument, so it is pinned here as a
   scoreboard: only transaction pooling with SET LOCAL survives Monday morning without
   leaking a clinic's data. Connecting directly runs out of max_connections; raising it
   lets a burst put hundreds of busy processes on 16 cores; session pooling starves the
   clients that never get a server connection; transaction pooling with a plain SET
   hands clinics each other's setting. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, survives, SETUPS, SITUATIONS, SLOTS, SCALE, SWEET, LINES, MAX_CONN, END } from '../scenarios/connection-pooling/sim.js';

const EXPECTED = {
  //          quiet  monday twoclinics
  today: [true, false, true],
  raise: [true, false, true],
  txnlocal: [true, true, true],
  session: [true, false, true],
  txn: [true, false, false],
};

for (const setup of SETUPS)
  test(`scoreboard: ${setup}`, () => {
    assert.deepEqual(SITUATIONS.map(x => survives(setup, x)), EXPECTED[setup]);
  });

test('with no pooler, Monday asks for more connections than max_connections allows', () => {
  const r = run('today', 'monday');
  assert.equal((LINES.monday - r.refused.length) * SCALE, MAX_CONN.today);
});

test('raising max_connections lets a burst run hundreds of processes at once', () => {
  const r = run('raise', 'monday');
  assert.equal(r.refused.length, 0);
  assert.ok(r.busyReal > SWEET * 4, `${r.busyReal}`);
});

test('in transaction mode a server connection is held for one transaction, then returned', () => {
  const r = run('txnlocal', 'monday');
  assert.ok(r.holds.every(h => h.kind === 'tx' && h.t1 - h.t0 < 1));
  const lines = slot => new Set(r.holds.filter(h => h.slot === slot).map(h => h.line));
  assert.ok(lines(0).size > 5, 'one server connection serves many clients in turn');
  assert.ok(r.waits.every(w => w.outcome === 'served' && w.t1 - w.t0 < 1.5), 'the burst queues briefly and drains');
});

test('in session mode a client keeps its server connection, and the rest time out', () => {
  const r = run('session', 'monday');
  const sessions = r.holds.filter(h => h.kind === 'session');
  assert.equal(sessions.length, SLOTS.session);
  assert.ok(sessions.every(h => h.t1 > END));
  assert.ok(r.waits.some(w => w.outcome === 'timeout'));
});

test('with a plain SET, the two clinics’ transactions run on each other’s setting', () => {
  const r = run('txn', 'twoclinics');
  assert.deepEqual(r.leaks.map(l => [l.want, l.got]), [[17, 42], [42, 17]]);
  assert.ok(run('txnlocal', 'twoclinics').leaks.length === 0);
});

test('with one request at a time, a plain SET happens to work', () => {
  assert.equal(run('txn', 'quiet').leaks.length, 0);
});

test('SET LOCAL leaves nothing on the server connection after COMMIT', () => {
  const r = run('txnlocal', 'twoclinics');
  for (let slot = 0; slot < SLOTS.txnlocal; slot++) {
    const last = r.settings.filter(s => s.slot === slot).at(-1);
    assert.ok(!last || last.value === null, `server ${slot + 1}`);
  }
});

test('every captioned step has both languages and the steps cover the run', () => {
  for (const setup of SETUPS)
    for (const x of SITUATIONS) {
      const { steps } = run(setup, x);
      assert.equal(steps[0].t0, 0);
      assert.equal(steps.at(-1).t1, END);
      for (const s of steps) assert.ok(s.say.en && s.say.vi && s.t1 >= s.t0, `${setup}/${x}`);
    }
});

test('row-level security returns the rows of the clinic set on the connection the transaction ran on', () => {
  const served = setup => run(setup, 'twoclinics').jobs.filter(j => j.kind === 'tx').map(j => [j.clinic, j.served]);
  assert.deepEqual(served('txn'), [[17, 42], [42, 17]], 'a plain SET: each clinic gets the other’s rows');
  assert.deepEqual(served('txnlocal'), [[17, 17], [42, 42]], 'SET LOCAL: each clinic gets its own');
  assert.deepEqual(served('session'), [[17, 17], [42, 42]]);
});

test('every request belongs to one of the four clinics, and a connection nobody set is not counted as a leak', () => {
  for (const setup of SETUPS)
    for (const x of SITUATIONS) {
      const r = run(setup, x);
      for (const j of r.jobs) assert.ok([17, 42, 8, 23].includes(j.clinic), `${setup}/${x}: clinic ${j.clinic}`);
      for (const l of r.leaks) assert.ok(l.got != null, `${setup}/${x}: a leak needs another clinic's setting`);
    }
});
