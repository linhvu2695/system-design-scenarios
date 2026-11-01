/* The simulation's model is the scenario's argument, so it is pinned here: WebSockets
   are refused by the corporate proxy, long polling costs a request per batch, gRPC-Web
   needs Envoy and restarts a dropped stream from the top, and only SSE meets all four
   constraints. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, survives, SETUPS, SITUATIONS, TOKENS, DROP, RETRY, LIMIT, STREAMS } from '../scenarios/streaming-transport/sim.js';

const EXPECTED = {
  ws: [true, true, false, true],
  sse: [true, true, true, true],
  poll: [true, true, true, false],
  grpc: [false, false, false, false],
};

test('scoreboard: calm, drop, proxy, peak', () => {
  assert.deepEqual(SITUATIONS, ['calm', 'drop', 'proxy', 'peak']);
  for (const setup of SETUPS)
    assert.deepEqual(SITUATIONS.map(x => survives(setup, x)), EXPECTED[setup], setup);
});

test('each setup fails for the reason the scenario gives', () => {
  const ws = run('ws', 'proxy');
  assert.equal(ws.missing, TOKENS, 'the proxy refuses every upgrade');
  assert.ok(ws.msgs.some(m => m.kind === 'fail' && m.from === 'proxy'));
  const poll = run('poll', 'peak');
  assert.ok(poll.perStream > 4, 'a poll per batch, several a second');
  assert.ok(poll.lb > 10 * LIMIT && run('poll', 'calm').lb <= LIMIT);
  const grpc = run('grpc', 'drop');
  assert.ok(grpc.dupes > 0 && grpc.missing === 0, 'a retried call starts over at token 1');
  assert.ok(SITUATIONS.every(x => !run('grpc', x).checks.infra));
});

test('after a drop, SSE resumes from Last-Event-ID with nothing lost or repeated', () => {
  const r = run('sse', 'drop');
  const resume = r.msgs.find(m => m.label.includes('Last-Event-ID') && !m.stop);
  assert.ok(resume, 'EventSource sends Last-Event-ID');
  assert.ok(resume.t0 >= DROP[1] && resume.t0 <= DROP[1] + RETRY);
  assert.equal(resume.label, `GET /m7/stream · Last-Event-ID: ${r.lastBefore}`);
  assert.equal(r.dupes, 0);
  assert.equal(r.missing, 0);
  assert.ok(r.lb * 20000 / STREAMS.drop <= LIMIT);
});

test('every message and token arrives in order of sending', () => {
  for (const setup of SETUPS) for (const x of SITUATIONS) {
    const r = run(setup, x);
    for (const m of r.msgs) assert.ok(m.t1 >= m.t0, `${setup}/${x}`);
    if (x !== 'drop' && r.recv.length) assert.deepEqual(r.recv.map(v => v.seq), Array.from({ length: TOKENS }, (_, i) => i + 1));
  }
});

test('steps run forward in time, in both languages', () => {
  for (const setup of SETUPS) for (const x of SITUATIONS) {
    const { steps, end, summary } = run(setup, x);
    let t = -Infinity;
    for (const st of steps) {
      assert.ok(st.t0 >= t && st.t1 >= st.t0 && st.t1 <= end + 1e-9, `${setup}/${x}`);
      assert.ok(st.say.en && st.say.vi && st.dur > 0, `${setup}/${x}`);
      t = st.t0;
    }
    assert.ok(summary.en && summary.vi);
  }
});
