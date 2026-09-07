import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactRef, Scalar, ToolUsage } from '../domain/model.js';
import type { ComputerActInput, ComputerCheckpoint, ComputerCheckpointStep, ComputerLimits, ComputerObservationRecord, ComputerView } from '../domain/computer-use.js';
import { COMPUTER_ACT_INPUT_SCHEMA, COMPUTER_OBSERVE_INPUT_SCHEMA, ComputerActInputSchema, ComputerCheckpointSchema,
  ComputerContractError, ComputerLimitsSchema, ComputerObservationRecordSchema, ComputerObserveInputSchema, ComputerViewSchema,
  conditionMatches, selectTarget, validateView } from '../application/computer-use-contracts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';

const limits: ComputerLimits = { maxSteps: 3, maxObservations: 12, maxElements: 40, maxViewBytes: 32768, maxDurationMs: 30000, pollIntervalMs: 1000 };
const target = { role: 'textbox', name: 'Note' };
const usage: ToolUsage = { transportCalls: 1, internalOperations: 1, imageBytes: 0, waitMs: 0 };
const artifact = (id: string): ArtifactRef => ({ id, sha256: 'a'.repeat(64), byteLength: 500, mediaType: 'application/json', tenantId: 'synthetic', labels: ['synthetic'] });
function view(): ComputerView {
  return { sessionId: 'synthetic-document', epoch: 1, surfaceId: 'document-window', revision: 3, focusRevision: 2, observedAt: 100,
    elements: [{ ref: 'note-ref', ...target, value: 'saved text', visible: true, enabled: true }],
    facts: { saved: true, savedCount: 1, optional: null }, partial: false, omittedCount: 0 };
}
function input(): ComputerActInput {
  return { observationId: 'observation-before', steps: [{ action: { kind: 'fill', target, value: 'saved text' },
    condition: { kind: 'element_value', target, value: 'saved text' } }], timeoutMs: 1000 };
}
function checkpointStep(): ComputerCheckpointStep {
  return { index: 0, operationId: 'operation-1', ...input().steps[0]!, before: artifact('before'), after: artifact('after'),
    status: 'applied', verified: true, errorCode: null };
}
function checkpoint(): ComputerCheckpoint {
  return { schemaVersion: 1, kind: 'computer_checkpoint', workId: 'work-1', attemptId: 'attempt-1', goalRevision: 1, scope: 'synthetic',
    policyDigest: 'b'.repeat(64), lifecycleGeneration: 0, taskDigest: 'c'.repeat(64), contractDigest: 'd'.repeat(64),
    driver: { id: 'synthetic', version: '1' }, sessionId: 'synthetic-document', epoch: 1, deadlineAt: 1000,
    initialObservation: artifact('before'), latestObservation: artifact('after'), steps: [checkpointStep()], phase: 'complete', stopReason: null, usage };
}
function rejects(operation: () => unknown, code: string): void {
  assert.throws(operation, error => error instanceof ComputerContractError && error.code === code && error.message === code);
}

test('computer contracts: tool inputs cannot select a driver address, add hidden actions or exceed a short batch', () => {
  const compiler = new AjvSchemas(); const act = compiler.compile(COMPUTER_ACT_INPUT_SCHEMA); const observe = compiler.compile(COMPUTER_OBSERVE_INPUT_SCHEMA);
  assert.equal(act(input()), true); assert.equal(ComputerActInputSchema.safeParse(input()).success, true);
  assert.equal(observe({}), true); assert.equal(ComputerObserveInputSchema.safeParse({}).success, true);
  const invalid: unknown[] = [
    { ...input(), driverUrl: 'synthetic-unregistered-address' },
    { ...input(), steps: [{ ...input().steps[0], action: { kind: 'fill', target: { ...target, ref: 'replacement' }, value: 'text' } }] },
    { ...input(), steps: [{ ...input().steps[0], action: { kind: 'click', target, value: 'hidden-fill' } }] },
    { ...input(), steps: [] }, { ...input(), steps: Array.from({ length: 4 }, () => input().steps[0]) },
    { ...input(), timeoutMs: 30001 }, { ...input(), timeoutMs: '1000' },
  ];
  for (const value of invalid) { assert.equal(act(value), false); assert.equal(ComputerActInputSchema.safeParse(value).success, false); }
  assert.equal(observe({ sessionId: 'other-session' }), false);
  assert.equal(ComputerObserveInputSchema.safeParse({ sessionId: 'other-session' }).success, false);
  assert.equal(ComputerLimitsSchema.safeParse(limits).success, true);
  for (const key of Object.keys(limits) as (keyof ComputerLimits)[]) {
    assert.equal(ComputerLimitsSchema.safeParse({ ...limits, [key]: limits[key] + 1 }).success, false);
    assert.equal(ComputerLimitsSchema.safeParse({ ...limits, [key]: 0 }).success, false);
  }
});

test('computer contracts: malformed observations cannot acquire trustworthy refs or silently omit their usage', () => {
  const baseline = view();
  const malformed: unknown[] = [
    { ...baseline, elements: [...baseline.elements, { ...baseline.elements[0], name: 'Other target' }] },
    { ...baseline, partial: false, omittedCount: 1 },
    { ...baseline, facts: { saved: Number.NaN } },
    { ...baseline, elements: [{ ...baseline.elements[0], visible: 'true' }] },
    { ...baseline, privileged: 'SYNTHETIC_SOURCE_TEXT_MUST_NOT_APPEAR_IN_ERROR' },
  ];
  for (const value of malformed) rejects(() => validateView(value, limits), 'computer_view_invalid');
  const record: ComputerObservationRecord = { schemaVersion: 1, kind: 'computer_observation', workId: 'work-1', attemptId: 'attempt-1',
    goalRevision: 1, scope: 'synthetic', policyDigest: 'a'.repeat(64), lifecycleGeneration: 0, driver: { id: 'synthetic', version: '1' }, view: baseline, usage };
  assert.deepEqual(ComputerObservationRecordSchema.parse(record), record);
  const { usage: omittedUsage, ...withoutUsage } = record; assert.ok(omittedUsage);
  assert.equal(ComputerObservationRecordSchema.safeParse(withoutUsage).success, false);
  assert.equal(ComputerObservationRecordSchema.safeParse({ ...record, usage: { ...usage, imageBytes: -1 } }).success, false);
});

test('computer contracts: a name match is insufficient when another hidden target shares that name', () => {
  const unique = view(); const selected = selectTarget(unique, target); selected.name = 'mutated-copy';
  assert.equal(unique.elements[0]!.name, target.name);
  const duplicate = { ...view(), elements: [...view().elements, { ...view().elements[0]!, ref: 'hidden-duplicate', visible: false }] };
  assert.equal(ComputerViewSchema.safeParse(duplicate).success, true, 'valid refs can still have ambiguous semantic selectors');
  rejects(() => selectTarget(duplicate, target), 'computer_target_ambiguous');
  assert.equal(conditionMatches(duplicate, input().steps[0]!.condition), false);
  rejects(() => selectTarget(view(), { ...target, name: 'note' }), 'computer_target_missing');
  for (const key of ['visible', 'enabled'] as const) {
    const unavailable = view(); unavailable.elements[0]![key] = false;
    rejects(() => selectTarget(unavailable, target), 'computer_target_unavailable');
  }
});

test('computer contracts: a truncated view cannot prove a unique target or element condition', () => {
  const partial = validateView({ ...view(), partial: true, omittedCount: 1 }, limits);
  rejects(() => selectTarget(partial, target), 'computer_view_partial');
  assert.equal(conditionMatches(partial, input().steps[0]!.condition), false, 'an omitted matching element may contradict the visible value');
  assert.equal(conditionMatches(partial, { kind: 'fact_equals', key: 'saved', value: true }), true, 'explicit own facts remain positive observations');
  assert.equal(conditionMatches(partial, { kind: 'fact_equals', key: 'unobserved', value: null }), false);
  assert.equal(partial.partial, true, 'checking a fact must not upgrade observation coverage');
});

test('computer contracts: byte limits count UTF-8 bytes and successful validation detaches the source', () => {
  const source = view(); source.elements[0]!.value = '가'.repeat(100);
  const size = Buffer.byteLength(JSON.stringify(source)); assert.ok(size > JSON.stringify(source).length);
  const parsed = validateView(source, { maxElements: 1, maxViewBytes: size });
  rejects(() => validateView(source, { maxElements: 1, maxViewBytes: size - 1 }), 'computer_view_too_large');
  parsed.elements[0]!.value = 'changed'; parsed.facts.saved = false;
  assert.equal(source.elements[0]!.value, '가'.repeat(100)); assert.equal(source.facts.saved, true);
  const two = { ...view(), elements: [...view().elements, { ...view().elements[0]!, ref: 'second' }] };
  rejects(() => validateView(two, { maxElements: 1, maxViewBytes: 32768 }), 'computer_view_too_large');
  rejects(() => validateView(source, { maxElements: 40, maxViewBytes: Number.POSITIVE_INFINITY }), 'computer_limits_invalid');
  const oversized = { ...view(), facts: { a: '가'.repeat(8000), b: '가'.repeat(8000) } };
  rejects(() => validateView(oversized, limits), 'computer_view_invalid');
});

test('computer contracts: observations cannot move backwards or switch sessions behind the same task', () => {
  const before = view();
  assert.deepEqual(validateView(before, limits, before), before);
  const advanced = { ...view(), revision: 4, focusRevision: 3, observedAt: 101 };
  assert.deepEqual(validateView(advanced, limits, before), advanced);
  const incompatible: Partial<ComputerView>[] = [{ sessionId: 'another-session' }, { epoch: 2 }, { surfaceId: 'another-window' },
    { revision: 2 }, { focusRevision: 1 }, { observedAt: 99 }];
  for (const change of incompatible) rejects(() => validateView({ ...view(), ...change }, limits, before), 'computer_view_changed');
  rejects(() => validateView({ ...view(), epoch: 0 }, limits), 'computer_view_invalid');
});

test('computer contracts: conditions require explicit own values and never use prototype facts or coercion', () => {
  const observed = view(); observed.facts = Object.assign(Object.create({ inherited: true }) as Record<string, Scalar>, observed.facts);
  assert.equal(conditionMatches(observed, { kind: 'fact_equals', key: 'inherited', value: true }), false);
  assert.equal(conditionMatches(observed, { kind: 'fact_equals', key: 'constructor', value: null }), false);
  assert.equal(conditionMatches(observed, { kind: 'fact_equals', key: 'missing', value: null }), false);
  assert.equal(conditionMatches(observed, { kind: 'fact_equals', key: 'optional', value: null }), true);
  assert.equal(conditionMatches(observed, { kind: 'fact_equals', key: 'savedCount', value: '1' }), false);
  assert.equal(conditionMatches(observed, { kind: 'fact_equals', key: 'saved', value: 'true' }), false);
  assert.equal(conditionMatches(observed, input().steps[0]!.condition), true);
  observed.elements[0]!.visible = false;
  assert.equal(conditionMatches(observed, input().steps[0]!.condition), false);
});

test('computer contracts: intent, application and observation verification cannot be collapsed into complete', () => {
  const complete = checkpoint(); assert.deepEqual(ComputerCheckpointSchema.parse(complete), complete);
  const intent: ComputerCheckpointStep = { ...checkpointStep(), after: null, status: 'intent', verified: false };
  const pending = { ...checkpoint(), phase: 'running', steps: [intent] };
  assert.equal(ComputerCheckpointSchema.safeParse(pending).success, true);
  const contradictions: unknown[] = [
    { ...complete, steps: [] }, { ...complete, steps: [{ ...checkpointStep(), verified: false }] },
    { ...complete, steps: [{ ...checkpointStep(), status: 'not_applied' }] },
    { ...complete, steps: [{ ...checkpointStep(), after: null }] },
    { ...complete, stopReason: 'condition_not_verified' },
    { ...pending, steps: [{ ...intent, after: artifact('after') }] },
    { ...pending, steps: [intent, { ...checkpointStep(), index: 1, operationId: 'operation-2' }] },
    { ...complete, steps: [checkpointStep(), { ...checkpointStep(), index: 1 }] },
    { ...complete, steps: [{ ...checkpointStep(), index: 1 }] },
  ];
  for (const value of contradictions) assert.equal(ComputerCheckpointSchema.safeParse(value).success, false);
  const appliedButUnverified = { ...checkpoint(), phase: 'partial', stopReason: 'condition_not_verified', steps: [{ ...checkpointStep(), verified: false }] };
  assert.equal(ComputerCheckpointSchema.safeParse(appliedButUnverified).success, true);
});
