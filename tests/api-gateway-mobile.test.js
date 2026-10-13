/* The simulation's model is the scenario's argument, so it is pinned here: with
   hostnames built into the app, deleting old endpoint code breaks users who have not
   updated; remote config helps only later moves; a gateway breaks nobody. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oldShare, broken, series, tokenChecks, DEFAULTS, MOVES, WEEKS } from '../scenarios/api-gateway-mobile/sim.js';

test('defaults match the scenario: about one in five users on a version over six months old', () => {
  const v = oldShare(26, DEFAULTS);
  assert.ok(v > 0.18 && v < 0.24, `got ${v}`);
});

test('a gateway breaks nobody, whatever the parameters', () => {
  for (const keep of [0, 8, 30])
    for (const stuck of [0, 0.4])
      assert.ok(series('gateway', { update: 0.05, stuck, keep }).every(v => v === 0));
});

test('hostnames in the app: deleting old code the day of the move breaks everyone', () => {
  assert.equal(broken('direct', MOVES[0], { ...DEFAULTS, keep: 0 }), 1);
});

test('hostnames in the app: users who never update stay broken', () => {
  for (const arch of ['direct', 'config'])
    assert.ok(broken(arch, WEEKS, DEFAULTS) >= DEFAULTS.stuck, arch);
});

test('nothing breaks while the old code is still kept', () => {
  for (const arch of ['direct', 'config'])
    for (let w = 0; w < DEFAULTS.keep; w++) assert.equal(broken(arch, w, DEFAULTS), 0, `${arch} week ${w}`);
});

test('remote config does not help the first move, and helps but does not fix later ones', () => {
  const direct = series('direct', DEFAULTS), config = series('config', DEFAULTS);
  for (let w = 0; w < MOVES[1] + DEFAULTS.keep; w++) assert.equal(config[w], direct[w], `week ${w}`);
  const after = MOVES[1] + DEFAULTS.keep;
  assert.ok(config[after] < direct[after]);
  assert.ok(config[after] > 0);
  config.forEach((v, w) => assert.ok(v <= direct[w], `week ${w}`));
});

test('only the gateway checks tokens in one place', () => {
  assert.equal(tokenChecks('gateway'), 1);
  assert.equal(tokenChecks('direct'), 5);
  assert.equal(tokenChecks('config'), 5);
});

test('oldShare starts at everyone and falls toward the stuck share', () => {
  assert.equal(oldShare(0, DEFAULTS), 1);
  assert.ok(oldShare(10, DEFAULTS) > oldShare(20, DEFAULTS));
  assert.ok(Math.abs(oldShare(1000, DEFAULTS) - DEFAULTS.stuck) < 1e-9);
});
