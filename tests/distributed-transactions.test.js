/* The simulation's model is the scenario's argument, so it is pinned here as a
   scoreboard: only the saga ends every situation cleanly (all done, or all undone with
   the customer never charged); a local ROLLBACK leaves partners' holds and money
   behind; two-phase commit cannot start with partners that have no prepare; nightly
   reconciliation fixes things too late, after the ticket is irreversible. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, survives, SETUPS, SITUATIONS, ORDER } from '../scenarios/distributed-transactions/sim.js';

const EXPECTED = {
  //       normal noroom declined crash timeout
  today: [true, false, true, false, false],
  twopc: [false, false, false, false, false],
  saga: [true, true, true, true, true],
  recon: [true, false, false, false, true],
};

for (const setup of SETUPS)
  test(`scoreboard: ${setup}`, () => {
    assert.deepEqual(SITUATIONS.map(x => survives(setup, x)), EXPECTED[setup]);
  });

test('today, a missing room leaves the seat held and the money authorized while the customer is told it failed', () => {
  const f = run('today', 'noroom').final;
  assert.equal(f.customer, 'failed');
  assert.equal(f.seat, 'held');
  assert.equal(f.card, 'authorized');
});

test('today, retrying a timed-out ticket call without an idempotency key issues two tickets', () => {
  assert.equal(run('today', 'timeout').final.tickets, 2);
});

test('the saga retries the timed-out ticket with the same key and still holds one ticket', () => {
  const r = run('saga', 'timeout');
  assert.equal(r.final.tickets, 1);
  assert.ok(r.steps.some(h => h.label.startsWith('ISSUE TICKET ↻')));
});

test('the saga undoes earlier steps newest first and never charges a failed booking', () => {
  const r = run('saga', 'declined');
  const undos = r.steps.filter(h => h.kind === 'undo').map(h => h.to);
  assert.deepEqual(undos, ['hotel', 'airline'], 'room released before seat');
  assert.equal(r.final.card, 'declined');
  assert.equal(r.final.customer, 'failed');
});

test('the saga puts every reversible step before the ticket, the point of no return', () => {
  const pivot = ORDER.saga.indexOf('ticket');
  for (const id of ['seat', 'room', 'auth']) assert.ok(ORDER.saga.indexOf(id) < pivot, id);
});

test('the saga resumes after a crash from its saved step instead of starting over', () => {
  const r = run('saga', 'crash');
  const calls = r.steps.filter(h => h.kind === 'call').map(h => h.label);
  assert.equal(new Set(calls).size, calls.length, 'no step is called twice');
  assert.ok(r.steps.some(h => h.label === 'RESUME'));
  assert.equal(r.final.customer, 'confirmed');
});

test('nightly reconciliation cannot undo a ticket issued during the day', () => {
  const f = run('recon', 'noroom').final;
  assert.equal(f.seat, 'ticketed');
  assert.equal(f.night, true);
});

test('every hop has a caption in both languages and a state snapshot', () => {
  for (const setup of SETUPS)
    for (const x of SITUATIONS)
      for (const h of run(setup, x).steps) {
        assert.ok(h.say.en && h.say.vi, `${setup}/${x}: ${h.label}`);
        assert.ok(h.state && Array.isArray(h.state.steps), `${setup}/${x}: ${h.label}`);
      }
});
