import test from 'node:test';
import assert from 'node:assert/strict';
import { InputValidationGraph, type InputNode, type InputNodeReader, type InputReference, type InputValidationLimits } from '../application/input-validation.js';
import { FakeClock } from '../infrastructure/fakes.js';

const ref = (key: string, expectedVersion?: string): InputReference => ({ provider: 'source', key, ...(expectedVersion ? { expectedVersion } : {}) });
type Source = { version: string; dependencies: InputReference[]; bytes: number; active: boolean; expiresAt: number | null };
const source = (dependencies: InputReference[] = []): Source => ({ version: '1', dependencies, bytes: 10, active: true, expiresAt: null });
function fixture(initial: Record<string, Source>, limits: Partial<InputValidationLimits> = {}) {
  const clock = new FakeClock(1000), sources = new Map(Object.entries(initial)), reads: string[] = [], guards: string[] = [];
  const hooks: { read?: (key: string) => void | Promise<void>; guard?: (key: string) => void | Promise<void> } = {};
  const reader: InputNodeReader = { provider: 'source', async inspect(key, signal) {
    reads.push(key); const record = sources.get(key); if (!record || !record.active) return null;
    const captured = structuredClone(record); await hooks.read?.(key); if (signal.aborted) return null;
    return { version: captured.version, dependencies: captured.dependencies, bytesRead: captured.bytes, validUntil: captured.expiresAt,
      async current() {
        guards.push(key); await hooks.guard?.(key); const latest = sources.get(key);
        return Boolean(latest?.active && latest.version === captured.version);
      } };
  } };
  return { clock, sources, reads, guards, hooks, reader, graph: new InputValidationGraph([reader], clock, limits) };
}

test('a diamond validates every edge, inspects a shared source once and guards every captured node', async () => {
  const f = fixture({ root: source([ref('left'), ref('right')]), left: source([ref('shared', '1')]), right: source([ref('shared')]), shared: source() });
  const result = await f.graph.validate([ref('root')]);
  assert.equal(result.valid, true); assert.equal(result.reason, 'current'); assert.equal(result.inspectedNodes, 4); assert.equal(result.inspectedReferences, 5);
  assert.deepEqual(f.reads, ['root', 'left', 'right', 'shared']); assert.deepEqual(f.guards, f.reads);
  assert.ok(result.bytes > 40); assert.ok(!JSON.stringify(result).includes('shared'));
});

test('a reference cycle is finite while an invalid member still rejects the whole closure', async () => {
  const f = fixture({ a: source([ref('b')]), b: source([ref('a', '1')]) });
  assert.equal((await f.graph.validate([ref('a')])).valid, true); assert.deepEqual(f.reads, ['a', 'b']);
  f.sources.get('b')!.active = false;
  const invalid = await f.graph.validate([ref('a')]); assert.equal(invalid.valid, false); assert.equal(invalid.reason, 'unavailable');
  assert.deepEqual(f.reads, ['a', 'b', 'a', 'b']);
});

test('a pin encountered after visiting a node is still checked', async () => {
  const f = fixture({ a: source(), b: source([ref('a', '2')]) });
  const result = await f.graph.validate([ref('a'), ref('b')]);
  assert.equal(result.valid, false); assert.equal(result.reason, 'version_conflict'); assert.equal(f.reads.filter(key => key === 'a').length, 1);
});

test('conflicting pending pins fail before dispatch, including across duplicate roots', async () => {
  const f = fixture({ a: source() }); const result = await f.graph.validate([ref('a', '1'), ref('a', '2')]);
  assert.equal(result.reason, 'version_conflict'); assert.deepEqual(f.reads, []);
});

test('captured source or authority changes during another read invalidate the result', async () => {
  for (const change of ['version', 'authority'] as const) {
    const f = fixture({ a: source([ref('b')]), b: source() });
    f.hooks.read = key => { if (key === 'b') { if (change === 'version') f.sources.get('a')!.version = '2'; else f.sources.get('a')!.active = false; } };
    const result = await f.graph.validate([ref('a')]); assert.equal(result.valid, false); assert.equal(result.reason, 'changed');
    assert.deepEqual(f.guards, ['a']);
  }
});

test('application invariants can reject a semantic cycle before guard I/O without changing generic cycle handling', async () => {
  const f = fixture({ a: source([ref('b')]), b: source([ref('a')]) });
  const result = await f.graph.validate([ref('a')], { accept: () => false });
  assert.equal(result.reason, 'unavailable'); assert.deepEqual(f.reads, ['a', 'b']); assert.deepEqual(f.guards, []);
});

test('expiry of an earlier node during a later guard is checked again before return', async () => {
  const f = fixture({ a: { ...source([ref('b')]), expiresAt: 1010 }, b: source() });
  f.hooks.guard = key => { if (key === 'b') f.clock.advance(10); };
  const result = await f.graph.validate([ref('a')]); assert.equal(result.reason, 'changed'); assert.deepEqual(f.guards, ['a', 'b']);
});

test('already expired nodes cannot be inputs', async () => {
  const f = fixture({ a: { ...source(), expiresAt: 1000 } });
  assert.equal((await f.graph.validate([ref('a')])).reason, 'changed'); assert.deepEqual(f.guards, []);
});

test('node, edge and byte budgets stop excessive reads before dispatching the next node', async () => {
  for (const limits of [{ nodes: 1 }, { references: 1 }, { bytes: 50 }]) {
    const f = fixture({ a: source([ref('b')]), b: source() }, limits);
    assert.equal((await f.graph.validate([ref('a')])).reason, 'limit'); assert.deepEqual(f.reads, ['a']);
  }
  const f = fixture({ a: source() }, { references: 1 });
  assert.equal((await f.graph.validate([ref('a'), ref('a')])).reason, 'limit'); assert.deepEqual(f.reads, []);
});

test('a long chain uses an iterative queue and visits every source exactly once', async () => {
  const values = Object.fromEntries(Array.from({ length: 200 }, (_v, index) => [String(index), source(index < 199 ? [ref(String(index + 1))] : [])]));
  const f = fixture(values); const result = await f.graph.validate([ref('0')]);
  assert.equal(result.valid, true); assert.equal(result.inspectedNodes, 200); assert.equal(new Set(f.reads).size, 200);
});

test('pre-aborted validation never invokes a reader', async () => {
  const f = fixture({ a: source() }), controller = new AbortController(); controller.abort();
  assert.equal((await f.graph.validate([ref('a')], { signal: controller.signal })).reason, 'cancelled'); assert.deepEqual(f.reads, []);
});

test('cancellation ends a blocked validation and contains a late reader rejection', async () => {
  let entered!: () => void, reject!: (error: Error) => void, activeSignal: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const reader: InputNodeReader = { provider: 'source', inspect: async (_key, signal) => {
    activeSignal = signal; entered(); return new Promise<InputNode | null>((_resolve, fail) => { reject = fail; });
  } };
  const graph = new InputValidationGraph([reader], new FakeClock(1000)); const controller = new AbortController();
  const validating = graph.validate([ref('private-source')], { signal: controller.signal });
  await started; controller.abort(); const result = await validating;
  assert.equal(result.reason, 'cancelled'); assert.equal(activeSignal?.aborted, true);
  reject(new Error('PRIVATE source service failure')); await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private-source/);
});

test('the elapsed deadline bounds a reader that ignores cancellation', async () => {
  let observed: AbortSignal | undefined;
  const reader: InputNodeReader = { provider: 'source', inspect: async (_key, signal) => {
    observed = signal; return new Promise<InputNode | null>(() => {});
  } };
  const graph = new InputValidationGraph([reader], new FakeClock(1000), { durationMs: 20 });
  const result = await graph.validate([ref('a')]); assert.equal(result.reason, 'limit'); assert.equal(observed?.aborted, true);
});

test('logical clock deadline changes and backwards clock readings cannot extend validation', async () => {
  const f = fixture({ a: source() }, { durationMs: 50 }); f.hooks.read = () => f.clock.advance(50);
  assert.equal((await f.graph.validate([ref('a')])).reason, 'limit'); assert.deepEqual(f.guards, []);
  let reads = 0;
  const graph = new InputValidationGraph([f.reader], { now: () => ++reads === 1 ? 1000 : 999 });
  assert.equal((await graph.validate([ref('a')])).reason, 'limit');
  for (const first of [NaN, -1, Number.MAX_SAFE_INTEGER]) {
    let called = 0;
    const invalid = new InputValidationGraph([f.reader], { now: () => ++called === 1 ? first : 1000 });
    assert.equal((await invalid.validate([ref('a')])).reason, 'limit');
  }
});

test('reader exceptions, unknown providers and malformed replies return fixed errors without source data', async () => {
  const clock = new FakeClock(1000);
  const graph = new InputValidationGraph([{ provider: 'source', async inspect() { throw new Error('PRIVATE file body'); } }], clock);
  const failure = await graph.validate([ref('PRIVATE')]); assert.equal(failure.reason, 'unavailable'); assert.doesNotMatch(JSON.stringify(failure), /PRIVATE/);
  assert.equal((await graph.validate([{ provider: 'unknown', key: 'a' }])).reason, 'unavailable');
  for (const node of [null, { version: '', dependencies: [], bytesRead: 1 }, { version: '1', dependencies: [], bytesRead: -1, current: async () => true }]) {
    const invalid = new InputValidationGraph([{ provider: 'source', inspect: async () => node as InputNode | null }], clock);
    assert.equal((await invalid.validate([ref('a')])).valid, false);
  }
});

test('registration captures the callback and rejects duplicate providers and invalid limits', async () => {
  const f = fixture({ a: source() }); f.reader.inspect = async () => { throw new Error('replaced'); };
  assert.equal((await f.graph.validate([ref('a')])).valid, true);
  assert.throws(() => new InputValidationGraph([f.reader, f.reader], f.clock), /input_reader_invalid/);
  for (const limits of [{ nodes: 0 }, { references: 32769 }, { bytes: NaN }, { durationMs: 30001 }])
    assert.throws(() => new InputValidationGraph([], f.clock, limits), /input_validation_limits_invalid/);
});

test('overlapping validations keep separate snapshots, queues and cancellation', async () => {
  const f = fixture({ a: source() }); let release!: () => void, entered!: () => void, blocked = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.hooks.read = async () => { if (!blocked) { blocked = true; entered(); await gate; } };
  const controller = new AbortController(); const first = f.graph.validate([ref('a')], { signal: controller.signal }); await started;
  const second = await f.graph.validate([ref('a')]); assert.equal(second.valid, true);
  controller.abort(); assert.equal((await first).reason, 'cancelled'); release();
  assert.deepEqual(f.reads, ['a', 'a']); assert.deepEqual(f.guards, ['a']);
  f.sources.get('a')!.active = false; assert.equal((await f.graph.validate([ref('a')])).valid, false);
});

test('provider and key jointly identify a node', async () => {
  const inspected: string[] = [];
  const readers = ['work', 'record'].map(provider => ({ provider, inspect: async (key: string): Promise<InputNode> => {
    inspected.push(`${provider}:${key}`); return { version: '1', dependencies: provider === 'work' ? [{ provider: 'record', key }] : [], bytesRead: 1, current: async () => true };
  } }));
  const graph = new InputValidationGraph(readers, new FakeClock(1000));
  assert.equal((await graph.validate([{ provider: 'work', key: 'same' }])).valid, true);
  assert.deepEqual(inspected, ['work:same', 'record:same']);
});
