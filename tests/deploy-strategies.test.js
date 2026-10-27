/* The simulation's model is the scenario's argument, so it is pinned here as a
   scoreboard: only a feature flag evaluated per account keeps a bug to your own staff,
   keeps enterprise accounts on the old engine, and keeps each pay run on one engine.
   Blue/green and replacing everything expose every customer at once; a weighted canary
   limits exposure but splits accounts and pay runs; a rolling update does neither well
   and rolls back slowly. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, survives, SETUPS, SITUATIONS, ACCOUNTS, PAYRUN, EXPOSED_BUDGET, T } from '../scenarios/deploy-strategies/sim.js';

const EXPECTED = {
  //          healthy bug   enterprise payrun
  today: [true, false, false, true],
  flag: [true, true, true, true],
  bluegreen: [true, false, false, true],
  canary: [true, true, false, false],
  rolling: [true, false, false, false],
};

for (const setup of SETUPS)
  test(`scoreboard: ${setup}`, () => {
    assert.deepEqual(SITUATIONS.map(x => survives(setup, x)), EXPECTED[setup]);
  });

const kind = id => ACCOUNTS.find(a => a.id === id).kind;

test('a feature flag sends your staff first, so a bug never reaches a customer', () => {
  const r = run('flag', 'bug');
  assert.equal(r.firstWrong.acc, 'staff');
  assert.equal(r.customerExposed, 0);
  assert.ok(r.rollbackAt - r.alertAt < 0.1, 'the kill switch acts within seconds');
});

test('blue/green switches back fast, but everyone was on the new engine until then', () => {
  const r = run('bluegreen', 'bug');
  assert.ok(r.rollbackAt - r.alertAt < 0.5);
  assert.ok(r.customerExposed > EXPOSED_BUDGET);
  const accounts = new Set(r.reqs.filter(q => q.engine === 'new').map(q => q.acc));
  assert.ok(ACCOUNTS.filter(a => a.kind === 'enterprise').every(a => accounts.has(a.id)));
});

test('a rolling update keeps serving the new engine while it redeploys the old one', () => {
  const r = run('rolling', 'bug');
  assert.ok(r.reqs.some(q => q.engine === 'new' && q.t > r.rollbackAt + 1));
  assert.ok(r.customerExposed > run('canary', 'bug').customerExposed);
});

test('after the rollback, nothing reaches the new engine (once the redeploy finishes)', () => {
  for (const setup of ['flag', 'bluegreen', 'canary']) {
    const r = run(setup, 'bug');
    assert.ok(r.reqs.filter(q => q.t >= r.rollbackAt).every(q => q.engine === 'old'), setup);
  }
});

test('the flag never routes an enterprise account to the new engine; the load balancer does', () => {
  assert.equal(run('flag', 'enterprise').enterpriseNew, 0);
  for (const setup of ['today', 'bluegreen', 'canary', 'rolling']) assert.ok(run(setup, 'enterprise').enterpriseNew > 0, setup);
});

test('a pay run stays on one engine when routing is per account or all at once, and splits otherwise', () => {
  assert.deepEqual(run('flag', 'payrun').payrunEngines, ['old']);
  assert.deepEqual(run('bluegreen', 'payrun').payrunEngines, ['new']);
  assert.equal(run('canary', 'payrun').payrunEngines.length, 2);
  assert.equal(run('rolling', 'payrun').payrunEngines.length, 2);
  assert.equal(run('canary', 'payrun').reqs.filter(q => q.payrun).length, PAYRUN.size);
});

test('every strategy ends with regular accounts on the new engine when nothing breaks', () => {
  for (const setup of SETUPS)
    assert.ok(run(setup, 'healthy').reqs.filter(q => kind(q.acc) === 'regular' && q.t > 18).every(q => q.engine === 'new'), setup);
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
