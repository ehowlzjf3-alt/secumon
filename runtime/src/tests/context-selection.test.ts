import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContextItem, ContextMemo } from '../domain/context.js';
import { selectContextItems } from '../application/context-selection.js';

const digest = 'a'.repeat(64);
const item = (key: string, overrides: Partial<ContextItem> = {}): ContextItem => ({ key, kind: 'result', version: '1', digest,
  fullBytes: 40, referenceBytes: 5, minimum: 'omitted', priority: 1, useMarker: null, ...overrides });
const representation = (selected: ReturnType<typeof selectContextItems>, key: string) => selected.decisions.find(d => d.key === key)!.representation;

test('required full and reference information survives optional content pressure', () => {
  const items = [item('optional', { fullBytes: 500, priority: 100 }), item('counterevidence', { minimum: 'full', fullBytes: 50 }),
    item('unknown-effect', { minimum: 'reference', fullBytes: 500, referenceBytes: 15 }), item('wait', { minimum: 'reference', fullBytes: 500, referenceBytes: 15 })];
  const selected = selectContextItems(items, null, { budgetBytes: 80, forceCompact: true });
  assert.equal(selected.bytes, 80); assert.equal(representation(selected, 'counterevidence'), 'full');
  assert.equal(representation(selected, 'unknown-effect'), 'reference'); assert.equal(representation(selected, 'wait'), 'reference');
  assert.equal(representation(selected, 'optional'), 'omitted');
  assert.throws(() => selectContextItems(items, null, { budgetBytes: 79 }), /context_required_overflow/);
});

test('a full value cheaper than its required reference satisfies the minimum without overflow', () => {
  const selected = selectContextItems([item('tiny', { minimum: 'reference', fullBytes: 2, referenceBytes: 30 })], null, { budgetBytes: 2 });
  assert.equal(selected.bytes, 2); assert.equal(representation(selected, 'tiny'), 'full');
  const empty = selectContextItems([item('optional')], null, { budgetBytes: 0 });
  assert.equal(empty.bytes, 0); assert.equal(representation(empty, 'optional'), 'omitted');
});

test('a required reference cap rejects contradictory bounds and never substitutes a cheaper full payload', () => {
  const value = item('reference-only', { minimum: 'reference', maximum: 'reference', fullBytes: 1, referenceBytes: 30 });
  const selected = selectContextItems([value], null, { budgetBytes: 30 });
  assert.equal(representation(selected, value.key), 'reference'); assert.equal(selected.bytes, 30);
  assert.equal(selected.decisions[0]!.reason, 'required_reference'); assert.equal(selected.memo.entries[0]!.lastIncludedCycle, 0);
  assert.throws(() => selectContextItems([value], null, { budgetBytes: 29 }), /context_required_overflow/);
  assert.throws(() => selectContextItems([{ ...value, minimum: 'full' }], null, { budgetBytes: 100 }), /context_invalid_items/);
});

test('optional reference caps consume only reference bytes and remain omitted when that representation does not fit', () => {
  for (const fullBytes of [1, 10000]) {
    const value = item('copy-reference', { maximum: 'reference', fullBytes, referenceBytes: 10, useMarker: 'new-read' });
    const selected = selectContextItems([value], null, { budgetBytes: 100 });
    assert.equal(representation(selected, value.key), 'reference'); assert.equal(selected.bytes, 10); assert.equal(selected.memo.mode, 'full');
    assert.equal(selected.decisions[0]!.bytes, 10); assert.equal(selected.memo.entries[0]!.admittedCycle, 0);
    const omitted = selectContextItems([value], null, { budgetBytes: 9 });
    assert.equal(representation(omitted, value.key), 'omitted'); assert.equal(omitted.bytes, 0);
  }
});

test('a reference cap overrides full residency and new use without counting references as full reloads', () => {
  const value = item('resident-body', { useMarker: 'first-read' });
  const initial = selectContextItems([value], null, { budgetBytes: 100 });
  assert.equal(representation(initial, value.key), 'full');
  const capped = selectContextItems([{ ...value, maximum: 'reference' }], initial.memo, { budgetBytes: 100 });
  assert.equal(representation(capped, value.key), 'reference'); assert.equal(capped.memo.evictions, 1); assert.equal(capped.memo.reloads, 0);
  assert.equal(capped.memo.entries[0]!.lastIncludedCycle, 1); assert.equal(capped.memo.entries[0]!.lastEvictedCycle, 2);
  const requested = selectContextItems([{ ...value, maximum: 'reference', useMarker: 'second-read' }], capped.memo, { budgetBytes: 100 });
  assert.equal(representation(requested, value.key), 'reference'); assert.equal(requested.memo.evictions, 1); assert.equal(requested.memo.reloads, 0);
  assert.equal(requested.memo.entries[0]!.lastUsedCycle, 3); assert.equal(requested.memo.entries[0]!.lastIncludedCycle, 1);
  const full = selectContextItems([{ ...value, useMarker: 'third-read' }], requested.memo, { budgetBytes: 100 });
  assert.equal(representation(full, value.key), 'full'); assert.equal(full.memo.reloads, 1); assert.equal(full.memo.entries[0]!.lastIncludedCycle, 4);
});

test('high and low watermarks retain compact mode until the lower boundary is crossed', () => {
  const first = selectContextItems([item('a', { fullBytes: 91 })], null, { budgetBytes: 100 });
  assert.equal(first.memo.mode, 'compact'); assert.equal(first.bytes, 5);
  const between = selectContextItems([item('a', { fullBytes: 80 })], first.memo, { budgetBytes: 100 });
  assert.equal(between.memo.mode, 'compact');
  const below = selectContextItems([item('a', { fullBytes: 70 })], between.memo, { budgetBytes: 100 });
  assert.equal(below.memo.mode, 'full'); assert.equal(representation(below, 'a'), 'full');
  const forced = selectContextItems([item('a')], null, { budgetBytes: 100, forceCompact: true });
  assert.equal(forced.memo.mode, 'compact');
});

test('mere inclusion is not actual use and an idle full value does not automatically reload', () => {
  const value = item('old-body'); let memo: ContextMemo | null = null;
  const selected = [];
  for (let n = 0; n < 8; n++) { const next = selectContextItems([value], memo, { budgetBytes: 100 }); selected.push(next); memo = next.memo; }
  assert.ok(selected.slice(0, 4).every(s => representation(s, value.key) === 'full'));
  assert.ok(selected.slice(4).every(s => representation(s, value.key) === 'omitted'));
  assert.ok(selected.every(s => s.memo.entries[0]!.lastUsedCycle === 0));
  assert.equal(memo!.evictions, 1); assert.equal(memo!.reloads, 0);
});

test('a new actual use marker refreshes usage and reloads the same digest once', () => {
  let memo: ContextMemo | null = null;
  for (let n = 0; n < 5; n++) memo = selectContextItems([item('body', { useMarker: 'call-1' })], memo, { budgetBytes: 100 }).memo;
  assert.equal(memo!.entries[0]!.lastUsedCycle, 1); assert.equal(memo!.evictions, 1);
  const reloaded = selectContextItems([item('body', { useMarker: 'call-2' })], memo, { budgetBytes: 100 });
  assert.equal(representation(reloaded, 'body'), 'full'); assert.equal(reloaded.memo.entries[0]!.lastUsedCycle, 6);
  assert.equal(reloaded.memo.reloads, 1);
  const included = selectContextItems([item('body', { useMarker: 'call-2' })], reloaded.memo, { budgetBytes: 100 });
  assert.equal(included.memo.entries[0]!.lastUsedCycle, 6); assert.equal(included.memo.reloads, 1);
});

test('minimum residency delays idle eviction for two cycles while the hard budget still wins', () => {
  const first = selectContextItems([item('body')], null, { budgetBytes: 100, idleCycles: 0 });
  const second = selectContextItems([item('body')], first.memo, { budgetBytes: 100, idleCycles: 0, forceCompact: true });
  assert.equal(representation(second, 'body'), 'full'); assert.equal(second.decisions[0]!.reason, 'minimum_residency');
  const third = selectContextItems([item('body')], second.memo, { budgetBytes: 100, idleCycles: 0 });
  assert.equal(representation(third, 'body'), 'omitted');
  const pressure = selectContextItems([item('body'), item('mandatory', { minimum: 'full', fullBytes: 70 })], first.memo, { budgetBytes: 100 });
  assert.equal(representation(pressure, 'mandatory'), 'full'); assert.notEqual(representation(pressure, 'body'), 'full'); assert.ok(pressure.bytes <= 100);
});

test('five changing working sets preserve old counterevidence, pending and unknown references', () => {
  const protectedItems = [item('counter', { minimum: 'full', fullBytes: 15, priority: -10, useMarker: 'initial-counter' }),
    item('pending', { kind: 'attempt', minimum: 'reference', fullBytes: 1000 }), item('unknown', { kind: 'attempt', minimum: 'reference', fullBytes: 1000 })];
  let memo: ContextMemo | null = null;
  for (let cycle = 1; cycle <= 5; cycle++) {
    const selected = selectContextItems([...protectedItems, item(`stage-${cycle}`, { fullBytes: 1000, useMarker: `use-${cycle}` })], memo, { budgetBytes: 30, forceCompact: true });
    assert.equal(selected.memo.cycle, cycle); assert.equal(representation(selected, 'counter'), 'full');
    assert.equal(representation(selected, 'pending'), 'reference'); assert.equal(representation(selected, 'unknown'), 'reference');
    assert.equal(selected.memo.entries.find(e => e.key === 'counter')!.lastUsedCycle, 1);
    assert.ok(selected.bytes <= 30); memo = selected.memo;
  }
});

test('removed authority and changed digests cannot be revived by resident or use history', () => {
  const first = selectContextItems([item('revoked', { useMarker: 'used' }), item('versioned')], null, { budgetBytes: 200 });
  const removed = selectContextItems([item('versioned', { digest: 'b'.repeat(64), version: '2', fullBytes: 500 })], first.memo, { budgetBytes: 100 });
  assert.deepEqual(removed.decisions.map(d => d.key), ['versioned']); assert.equal(removed.memo.entries.some(e => e.key === 'revoked'), false);
  assert.equal(removed.memo.entries[0]!.digest, 'b'.repeat(64)); assert.equal(removed.memo.entries[0]!.lastUsedCycle, 0);
  assert.equal(removed.memo.reloads, 0); assert.equal(removed.memo.evictions, 2);
  const empty = selectContextItems([], removed.memo, { budgetBytes: 100 }); assert.deepEqual(empty.decisions, []); assert.deepEqual(empty.memo.entries, []);
});

test('decisions are stable by minimum, priority, real use, recency, residence and key', () => {
  const before = selectContextItems([item('resident', { useMarker: 'old' }), item('older', { useMarker: 'old' })], null, { budgetBytes: 1000 });
  const values = [item('z'), item('a'), item('resident', { useMarker: 'old' }), item('older', { useMarker: 'new' }),
    item('priority', { priority: 20 }), item('required', { minimum: 'reference', priority: -1 })];
  const selected = selectContextItems(values, before.memo, { budgetBytes: 1000 });
  assert.deepEqual(selected.decisions.map(d => d.key), ['required', 'priority', 'older', 'resident', 'a', 'z']);
  assert.deepEqual(selectContextItems([...values].reverse(), before.memo, { budgetBytes: 1000 }), selected);
});

test('recently evicted content waits through cooldown unless actual use or a minimum requires it', () => {
  const first = selectContextItems([item('body', { useMarker: 'read' })], null, { budgetBytes: 100 });
  const evicted = selectContextItems([item('body', { useMarker: 'read', fullBytes: 150 })], first.memo, { budgetBytes: 100 });
  assert.equal(evicted.memo.evictions, 1);
  const cooldown = selectContextItems([item('body', { useMarker: 'read' })], evicted.memo, { budgetBytes: 100 });
  assert.notEqual(representation(cooldown, 'body'), 'full'); assert.equal(cooldown.memo.reloads, 0);
  const requested = selectContextItems([item('body', { useMarker: 'read', minimum: 'full' })], evicted.memo, { budgetBytes: 100 });
  assert.equal(representation(requested, 'body'), 'full'); assert.equal(requested.memo.reloads, 1);
});

test('memo storage is bounded and prioritizes selected residents without changing decisions', () => {
  const values = Array.from({ length: 180 }, (_, n) => item(`key-${n.toString().padStart(3, '0')}`, { priority: n, fullBytes: 1, referenceBytes: 0 }));
  const selected = selectContextItems(values, null, { budgetBytes: 60 });
  assert.equal(selected.decisions.length, 180); assert.equal(selected.memo.entries.length, 128); assert.ok(selected.bytes <= 60);
  for (const decision of selected.decisions.filter(d => d.representation === 'full')) assert.ok(selected.memo.entries.some(e => e.key === decision.key));
});

test('inputs and previous memo stay immutable and byte sums match selected representations', () => {
  const values = [item('a'), item('b', { minimum: 'reference', fullBytes: 1000 })];
  const prior = selectContextItems(values, null, { budgetBytes: 100 }).memo; const before = structuredClone({ values, prior });
  const selected = selectContextItems(values, prior, { budgetBytes: 100 });
  assert.deepEqual({ values, prior }, before); assert.equal(selected.bytes, selected.decisions.reduce((total, decision) => total + decision.bytes, 0));
});

test('duplicate keys, malformed items, invalid budgets and inconsistent memo are rejected', () => {
  assert.throws(() => selectContextItems([item('same'), item('same')], null, { budgetBytes: 100 }), /context_duplicate_item/);
  for (const bad of [item('x', { fullBytes: -1 }), item('x', { referenceBytes: 1.5 }), item('x', { priority: Infinity }), item('x', { digest: 'bad' })]) {
    assert.throws(() => selectContextItems([bad], null, { budgetBytes: 100 }), /context_invalid_items/);
  }
  for (const config of [{ budgetBytes: -1 }, { budgetBytes: 1.5 }, { budgetBytes: 100, highWatermark: 0.5, lowWatermark: 0.7 }, { budgetBytes: 100, minResidentCycles: -1 }]) {
    assert.throws(() => selectContextItems([], null, config), /context_invalid_config/);
  }
  const memo = selectContextItems([item('x')], null, { budgetBytes: 100 }).memo;
  assert.throws(() => selectContextItems([], { ...memo, entries: [...memo.entries, ...memo.entries] }, { budgetBytes: 100 }), /context_invalid_memo/);
  assert.throws(() => selectContextItems([], { ...memo, entries: [{ ...memo.entries[0]!, lastUsedCycle: 2 }] }, { budgetBytes: 100 }), /context_invalid_memo/);
  assert.throws(() => selectContextItems([], { ...memo, cycle: Number.MAX_SAFE_INTEGER }, { budgetBytes: 100 }), /context_invalid_memo/);
  assert.throws(() => selectContextItems([], { ...memo, evictions: Number.MAX_SAFE_INTEGER }, { budgetBytes: 100 }), /context_invalid_memo/);
});
