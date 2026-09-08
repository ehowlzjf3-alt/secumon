import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionOriginals, type SessionOriginal } from '../application/session-originals.js';
import { transact } from '../application/work-transactions.js';
import type { WorkState } from '../domain/model.js';
import { windowFixture } from './session-window-helpers.js';

type Fixture = Awaited<ReturnType<typeof windowFixture>>;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
async function read(f: Fixture, state: WorkState, through = state.conversation!.session!.input.sequence) {
  const rows: SessionOriginal[] = [];
  for await (const row of new SessionOriginals(f.services, f.repository).read(state, state.conversation!.session!, 0, through)) rows.push(row);
  return rows;
}
function meter(f: Fixture) {
  let counts = { stateGets: 0, stateBytes: 0, historyPages: 0, historyEntries: 0, historyBytes: 0, inputReads: 0, inputBytes: 0, artifactProbes: 0 };
  const get = f.services.state.get.bind(f.services.state), history = f.repository.history.bind(f.repository), input = f.repository.input.bind(f.repository), exists = f.services.artifacts.exists.bind(f.services.artifacts);
  f.services.state.get = async (...args) => { const value = await get(...args); counts.stateGets++; counts.stateBytes += bytes(value); return value; };
  f.repository.history = async (...args) => { const page = await history(...args); counts.historyPages++; counts.historyEntries += page.entries.length; counts.historyBytes += bytes(page); return page; };
  f.repository.input = async (...args) => { const value = await input(...args); counts.inputReads++; counts.inputBytes += bytes(value); return value; };
  f.services.artifacts.exists = async (...args) => { counts.artifactProbes++; return exists(...args); };
  return { async measure<T>(operation: () => Promise<T>) {
    counts = { stateGets: 0, stateBytes: 0, historyPages: 0, historyEntries: 0, historyBytes: 0, inputReads: 0, inputBytes: 0, artifactProbes: 0 };
    const start = performance.now(), value = await operation();
    return { value, measured: { ...counts, returnedBytes: bytes(value), elapsedMs: performance.now() - start } };
  } };
}

test('session original cost: 129 real inputs retain every original while page reuse bounds repeated state reads across context entry points', async t => {
  const f = await windowFixture(t, 129, { maxContextBytes: 262144 }, 128), state = await f.current(), measured = meter(f);
  const direct = await measured.measure(() => read(f, state));
  assert.equal(direct.value.length, 129); assert.ok(direct.value.every(row => row.eligible && !row.pending));
  assert.deepEqual(direct.value.map(row => row.entry.sourceId), Array.from({ length: 129 }, (_, index) => `source-${index}`));
  assert.equal(direct.measured.stateGets, 5); assert.equal(direct.measured.historyPages, 3); assert.equal(direct.measured.historyEntries, 129);
  assert.equal(direct.measured.inputReads, 129); assert.equal((await f.repository.get(f.session.scope)).head, null);
  const baseline = await measured.measure(async () => {
    for (const row of direct.value) assert.ok(await f.services.state.get(row.entry.workId));
    return { originalEntries: direct.value.length };
  });
  assert.equal(baseline.measured.stateGets, 129);
  assert.equal(direct.measured.stateBytes * 129, baseline.measured.stateBytes * 5);
  const context = await measured.measure(() => f.sessions.context(state)); assert.ok(context.value);
  assert.deepEqual(context.value.entries, direct.value.map(row => row.entry)); assert.equal(context.measured.stateGets, 5);
  const current = await measured.measure(() => f.sessions.current(state, context.value!)); assert.equal(current.value, true);
  assert.equal(current.measured.stateGets, 5, 'a new currentness check starts a fresh page cache');
  const inspection = await measured.measure(() => f.sessions.inspectContext(state)); assert.ok(inspection.value); assert.equal(inspection.value.status, 'complete');
  assert.equal(inspection.measured.stateGets, 7, 'inspection also checks the work itself before and after its source scan');
  const materialized = await measured.measure(() => f.sessions.materializeContext(state, inspection.value!));
  assert.deepEqual(materialized.value, context.value); assert.equal(materialized.measured.stateGets, 14);
  for (const result of [context, current, inspection]) {
    assert.equal(result.measured.historyPages, 3); assert.equal(result.measured.historyEntries, 129);
    assert.equal(result.measured.historyBytes, direct.measured.historyBytes);
  }
  assert.equal(materialized.measured.historyPages, 6); assert.equal(materialized.measured.historyEntries, 258);
  assert.equal((await f.current()).modelCalls.length, 0); assert.equal(f.planner.inputs.length, 0);
  t.diagnostic(JSON.stringify({ perEntryStateReadBaseline: baseline.measured, directRead: direct.measured, context: context.measured,
    current: current.measured, inspect: inspection.measured, materialize: materialized.measured,
    meaning: 'Measured repository calls and serialized returned data; baseline repeats only the old per-entry state access pattern. Timings include instrumentation, not model tokens or physical disk I/O.' }));
});

test('session original reuse: changed full state and withdrawn source policy reject the context before publishing a head', async t => {
  for (const change of ['state', 'policy', 'same-revision'] as const) {
    const f = await windowFixture(t, 4), state = await f.current(), get = f.services.state.get.bind(f.services.state); let reads = 0;
    f.services.state.get = async workId => {
      const value = await get(workId);
      if (workId !== f.workId || ++reads !== 2) return value;
      assert.ok(value);
      if (change === 'same-revision') return { ...value, statusReason: 'changed without a new revision in the repository response' };
      await transact(f.services, workId, `concurrent-${change}`, 'source_changed', {}, next => {
        if (change === 'policy') next.policy.allowedDestinations = [];
        else next.statusReason = 'concurrent original state update';
      });
      return get(workId);
    };
    await assert.rejects(f.sessions.context(state), /session_source_changed/);
    assert.equal((await f.repository.get(f.session.scope)).head, null);
    assert.equal((await get(f.workId))!.modelCalls.length, 0); assert.equal(f.planner.inputs.length, 0);
  }
});

test('session original reuse: pending and rejected inputs keep receipt validation without unused cache rechecks', async t => {
  const f = await windowFixture(t, 6), state = await f.current(), input = f.repository.input.bind(f.repository), get = f.services.state.get.bind(f.services.state);
  let receiptReads = 0, stateReads = 0;
  f.repository.input = async (...args) => {
    receiptReads++; const value = await input(...args); assert.ok(value);
    return value.messageId === 'source-0' ? value : { ...value, status: value.messageId === 'source-1' ? 'pending' : 'rejected', rejection: null };
  };
  f.services.state.get = async (...args) => { stateReads++; return get(...args); };
  const rows = await read(f, state);
  assert.equal(receiptReads, 6); assert.equal(stateReads, 1, 'one source read was never reused and needs no extra fence');
  assert.deepEqual(rows.map(row => [row.eligible, row.pending]), [[true, false], [false, true], [false, false], [false, false], [false, false], [false, false]]);
  const history = f.repository.history.bind(f.repository);
  f.repository.history = async (...args) => { const page = await history(...args); return { ...page, entries: page.entries.map(entry =>
    entry.sourceId === 'source-3' ? { ...entry, text: 'altered rejected original' } : entry) }; };
  await assert.rejects(read(f, state), /session_original_invalid/);
  assert.equal((await f.repository.get(f.session.scope)).head, null); assert.equal(f.planner.inputs.length, 0);
});

function paddedSource(template: WorkState, id: string, paddingCharacters: number): WorkState {
  const source = structuredClone(template); source.id = id;
  if (paddingCharacters) source.evidence.push({ id: 'sizing-evidence', tenantId: source.policy.tenantId, scope: 'fixture', sourceId: 'source', lineageId: 'lineage',
    locator: 'fixture:local', observedAt: 1000, recordedAt: 1000, labels: ['synthetic'], coverage: 'complete', status: 'accepted',
    supersedes: [], derivedFrom: [], facts: { padding: '한'.repeat(paddingCharacters) }, artifact: null });
  return source;
}

test('session original reuse: eight-work and combined UTF-8 byte caps fall back to direct reads without evicting cached originals', async t => {
  const f = await windowFixture(t, 27, {}, 40), state = await f.current(), history = f.repository.history.bind(f.repository), get = f.services.state.get.bind(f.services.state);
  try {
    for (const scenario of [{ name: 'eight-work', workCount: 9, padding: 0 }, { name: 'combined-bytes', workCount: 2, padding: 750000 },
      { name: 'single-oversize', workCount: 1, padding: 1500000 }]) {
      const sources = Array.from({ length: scenario.workCount }, (_, index) => paddedSource(state, `fixture-source-${index}`, scenario.padding));
      const calls = new Map<string, number>();
      f.repository.history = async (...args) => { const page = await history(...args); return { ...page, entries: page.entries.map(entry => ({ ...entry,
        role: 'assistant' as const, status: 'delivered' as const, kind: 'result' as const,
        sourceId: `fixture-delivery-${entry.sequence}`, workId: sources[Math.floor((entry.sequence - 1) / 3)]!.id })) }; };
      f.services.state.get = async workId => {
        const source = sources.find(value => value.id === workId); assert.ok(source); calls.set(workId, (calls.get(workId) ?? 0) + 1); return structuredClone(source);
      };
      const rows = await read(f, state, scenario.workCount * 3); assert.equal(rows.length, scenario.workCount * 3); assert.ok(rows.every(row => row.eligible));
      const expected = scenario.name === 'eight-work' ? [...Array<number>(8).fill(2), 3] : scenario.name === 'combined-bytes' ? [2, 3] : [3];
      assert.deepEqual(sources.map(source => calls.get(source.id)), expected, scenario.name);
      if (scenario.name === 'combined-bytes') {
        assert.ok(bytes(sources[0]) < 4 * 1024 * 1024); assert.ok(sources.reduce((sum, source) => sum + bytes(source), 0) > 4 * 1024 * 1024);
        assert.ok(JSON.stringify(sources[0]).length < 2 * 1024 * 1024, 'the cap measures UTF-8 bytes rather than string length');
      }
      if (scenario.name === 'single-oversize') assert.ok(bytes(sources[0]) > 4 * 1024 * 1024);
    }
  } finally { f.repository.history = history; f.services.state.get = get; }
  assert.equal((await f.repository.get(f.session.scope)).head, null); assert.equal(f.planner.inputs.length, 0);
});

test('session original reuse: each original artifact remains checked even when its work state is reused', async t => {
  const f = await windowFixture(t, 3), state = await f.current(), history = f.repository.history.bind(f.repository);
  const artifact = await f.services.artifacts.put(new TextEncoder().encode('original fixture'), { tenantId: state.policy.tenantId, labels: ['synthetic'], mediaType: 'text/plain' });
  f.repository.history = async (...args) => { const page = await history(...args); return { ...page, entries: page.entries.map(entry => ({ ...entry,
    role: 'assistant' as const, status: 'delivered' as const, kind: 'result' as const, sourceId: `fixture-delivery-${entry.sequence}`, artifact })) }; };
  const exists = f.services.artifacts.exists.bind(f.services.artifacts); let probes = 0, missingAt = Number.POSITIVE_INFINITY;
  f.services.artifacts.exists = async value => { probes++; return probes === missingAt ? false : exists(value); };
  assert.equal((await read(f, state)).length, 3); assert.equal(probes, 3);
  probes = 0; missingAt = 3; await assert.rejects(read(f, state), /session_source_unavailable/); assert.equal(probes, 3);
  assert.equal((await f.repository.get(f.session.scope)).head, null); assert.equal(f.planner.inputs.length, 0);
});
