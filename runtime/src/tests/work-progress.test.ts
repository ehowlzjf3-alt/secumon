import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Evidence, WorkState } from '../domain/model.js';
import { DEFAULT_PROGRESS_POLICY, observeProgress, type ProgressObservation, type ProgressPolicy, type WorkProgress } from '../domain/work-progress.js';
import { WorkProgressSchema, ProgressPolicySchema } from '../application/work-progress-contracts.js';
import { captureProgress, progressGate } from '../application/work-progress.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { adapters, command, initial, openRepository } from './state-conformance-helpers.js';

const digester = new Sha256Digester();
const observation = (operationId: string, keys: string[] = [], options: Partial<ProgressObservation> = {}): ProgressObservation =>
  ({ goalRevision: 1, operationId, keys, failureKey: null, at: 1000, ...options });
const policy = (options: Partial<ProgressPolicy> = {}): ProgressPolicy => ({ ...DEFAULT_PROGRESS_POLICY, ...options });
type State = WorkState & { progress?: WorkProgress | undefined };
function source(options: Partial<Evidence> = {}): Evidence {
  return { id: 'source-1', tenantId: 'tenant-a', scope: 'fixture', sourceId: 'provider-1', lineageId: 'original-1', locator: 'local:original',
    observedAt: 900, recordedAt: 1000, labels: ['synthetic'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [],
    facts: { available: false }, artifact: null, ...options };
}
function state(): State { return initial('progress-work'); }
function capture(work: State, operationId: string, options: Parameters<typeof captureProgress>[4] = {}) {
  return captureProgress(work, digester, operationId, 1000, options);
}

test('progress: a unique committed operation contributes once and returned state has no mutable aliases', () => {
  const input = observation('op-1', ['new-source', 'new-source']); const first = observeProgress(null, input);
  assert.equal(first.productiveSteps, 1); assert.equal(first.consecutiveUnproductive, 0); assert.deepEqual(first.knownKeys, ['new-source']);
  const duplicate = observeProgress(first, observation('op-1', ['fabricated-new-source'], { goalRevision: 2, failureKey: 'failure', at: 999999 }));
  assert.deepEqual(duplicate, first); duplicate.knownKeys.push('local-mutation'); duplicate.policy.backoffMs = 0;
  assert.deepEqual(first.knownKeys, ['new-source']); assert.equal(first.policy.backoffMs, 100); assert.deepEqual(input.keys, ['new-source', 'new-source']);
});

test('progress: permutations, repeated known keys and new operation IDs cannot fabricate productive steps', () => {
  let value = observeProgress(null, observation('one', ['b', 'a']));
  for (const [id, keys] of [['two', ['a', 'b']], ['three', ['a']], ['four', []]] as const) value = observeProgress(value, observation(id, [...keys]));
  assert.equal(value.productiveSteps, 1); assert.equal(value.unproductiveSteps, 3); assert.equal(value.consecutiveUnproductive, 3);
  assert.deepEqual(progressGate({ progress: value, deadlineAt: 100000 }, 1000), { kind: 'blocked', reason: 'no_progress_limit' });
  value = observeProgress(value, observation('counterevidence', ['new-counterevidence']));
  assert.equal(value.consecutiveUnproductive, 0); assert.equal(value.productiveSteps, 2); assert.equal(progressGate({ progress: value, deadlineAt: 100000 }, 1000), null);
});

test('progress: explicit goal epochs reset only the current streak and preserve deduplication and the original retry window', () => {
  const first = observeProgress(null, observation('failed-1', [], { failureKey: 'same-input' }));
  const second = observeProgress(first, observation('failed-2', [], { failureKey: 'same-input', at: 1100 }));
  const next = observeProgress(second, observation('new-goal', [], { goalRevision: 2, at: 1200 }));
  assert.equal(next.goalRevision, 2); assert.equal(next.consecutiveUnproductive, 1); assert.equal(next.unproductiveSteps, 3);
  assert.deepEqual(next.failures, second.failures); assert.equal(next.failures[0]!.deadlineAt, 31000);
  assert.deepEqual(next.processed, ['failed-1', 'failed-2', 'new-goal']);
  assert.deepEqual(observeProgress(next, observation('failed-1')), next);
  assert.throws(() => observeProgress(next, observation('new-but-stale-operation')), /progress_goal_stale/);
});

for (const cap of ['processed', 'knownKeys'] as const) test(`progress: ${cap} capacity saturates without evicting prior records or resetting on a new goal`, () => {
  const configured = policy({ maxTrackedEntries: 2 });
  let value = observeProgress(null, observation('one', ['source-a']), configured);
  if (cap === 'processed') value = observeProgress(value, observation('two', ['source-a']));
  const before = structuredClone(value);
  value = observeProgress(value, observation('overflow', cap === 'knownKeys' ? ['source-b', 'source-c'] : []));
  assert.equal(value.saturated, true); assert.deepEqual(value.processed, before.processed); assert.deepEqual(value.knownKeys, before.knownKeys);
  assert.equal(value.productiveSteps + value.unproductiveSteps, value.processed.length);
  value = observeProgress(value, observation('new-goal', ['novel'], { goalRevision: 2 }));
  assert.equal(value.saturated, true); assert.equal(value.goalRevision, 2);
  assert.deepEqual(progressGate({ progress: value, deadlineAt: 100000 }, 1000), { kind: 'blocked', reason: 'progress_capacity_exceeded' });
});

test('progress: repeated failures retain their first deadline and use the current backoff without extending the retry window', () => {
  const configured = policy({ retryWindowMs: 500, backoffMs: 100, maxRepeatedFailures: 4 });
  const first = observeProgress(null, observation('attempt-1', [], { failureKey: 'semantic-request' }), configured);
  const second = observeProgress(first, observation('renamed-task-attempt', ['new-other-source'], { failureKey: 'semantic-request', at: 1050 }));
  assert.deepEqual(second.failures, [{ key: 'semantic-request', count: 2, firstAt: 1000, lastAt: 1050, nextEligibleAt: 1150, deadlineAt: 1500 }]);
  assert.deepEqual(progressGate({ progress: second, deadlineAt: 2000 }, 1149, 'semantic-request'), { kind: 'wait', reason: 'retry_backoff', wakeAt: 1150 });
  assert.equal(progressGate({ progress: second, deadlineAt: 2000 }, 1150, 'semantic-request'), null);
  assert.deepEqual(progressGate({ progress: second, deadlineAt: 2000 }, 1500, 'semantic-request'), { kind: 'blocked', reason: 'retry_deadline_exceeded' });
  assert.equal(progressGate({ progress: second, deadlineAt: 2000 }, 1500, 'different-request'), null);
  const late = observeProgress(second, observation('late-result', [], { failureKey: 'semantic-request', at: 2000 }));
  assert.equal(late.failures[0]!.deadlineAt, 1500); assert.equal(late.failures[0]!.nextEligibleAt, 1500); assert.equal(WorkProgressSchema.safeParse(late).success, true);
});

test('progress: retry gate respects the work deadline and specific repeated-failure limits', () => {
  let value = observeProgress(null, observation('one', [], { failureKey: 'failure' }));
  assert.deepEqual(progressGate({ progress: value, deadlineAt: 1050 }, 1000, 'failure'), { kind: 'wait', reason: 'retry_backoff', wakeAt: 1050 });
  assert.deepEqual(progressGate({ progress: value, deadlineAt: 1050 }, 1050, 'failure'), { kind: 'blocked', reason: 'retry_deadline_exceeded' });
  value = observeProgress(value, observation('two', [], { failureKey: 'failure', at: 1100 }));
  value = observeProgress(value, observation('three', [], { failureKey: 'failure', at: 1200 }));
  assert.deepEqual(progressGate({ progress: value, deadlineAt: 100000 }, 1300, 'failure'), { kind: 'blocked', reason: 'repeated_failure_limit' });
  assert.equal(progressGate({ deadlineAt: 100000 }, 1000), null);
});

test('progress: policies remain pinned and invalid counters, times, keys or schema fields fail closed', () => {
  const first = observeProgress(null, observation('one', [], { failureKey: 'failure' }));
  assert.throws(() => observeProgress(first, observation('two'), policy({ maxUnproductiveSteps: 100 })), /progress_policy_changed/);
  assert.throws(() => observeProgress(first, observation('two', [], { failureKey: 'failure', at: 999 })), /progress_time_reversed/);
  for (const invalid of [observation(''), observation('two', ['']), observation('two', [], { at: NaN }), observation('two', [], { goalRevision: 0 })])
    assert.throws(() => observeProgress(first, invalid), /progress_invalid/);
  assert.equal(ProgressPolicySchema.safeParse(policy({ backoffMs: 30001 })).success, false);
  for (const invalid of [{ ...first, extra: true }, { ...first, processed: ['one', 'one'] }, { ...first, productiveSteps: 9 },
    { ...first, failures: [{ ...first.failures[0]!, deadlineAt: 999999 }] }, { ...first, failures: [{ ...first.failures[0]!, nextEligibleAt: 1000 }] },
    { ...first, failures: [first.failures[0]!, { ...first.failures[0]!, key: 'impossible-extra-failure' }] }, { ...first, consecutiveUnproductive: 5 }])
    assert.equal(WorkProgressSchema.safeParse(invalid).success, false);
});

test('capture: a new negative observation is productive while aliases, timestamps and duplicate originals are not', () => {
  const work = state(); work.evidence = [source()];
  assert.equal(capture(work, 'original').productiveSteps, 1);
  work.evidence = [source({ id: 'renamed', sourceId: 'source-alias', locator: 'other-locator', observedAt: 950, recordedAt: 2000 })];
  assert.equal(capture(work, 'renamed').consecutiveUnproductive, 1);
  work.evidence.push(source({ id: 'copy-id', observedAt: 999, recordedAt: 2001 }));
  const next = capture(work, 'duplicate'); assert.equal(next.productiveSteps, 1); assert.equal(next.consecutiveUnproductive, 2);
  assert.equal(next.knownKeys.length, 1); assert.equal(JSON.stringify(next).includes('local:original'), false);
});

test('capture: changed facts, coverage and an authenticated original version can each carry new information', () => {
  const work = state(); work.evidence = [source({ coverage: 'partial' })]; capture(work, 'partial');
  work.evidence[0]!.coverage = 'complete'; assert.equal(capture(work, 'complete-coverage').productiveSteps, 2);
  work.evidence[0]!.facts = { available: true }; assert.equal(capture(work, 'changed-fact').productiveSteps, 3);
  work.evidence[0]!.artifact = { id: 'original-v1', sha256: 'a'.repeat(64), byteLength: 1, mediaType: 'text/plain', tenantId: 'tenant-a', labels: ['synthetic'] };
  assert.equal(capture(work, 'source-version').productiveSteps, 4);
  work.evidence[0]!.artifact.id = 'same-bytes-different-id'; assert.equal(capture(work, 'same-version').productiveSteps, 4);
});

test('capture: derived copies do not add progress or independent completion credit', () => {
  const work = state(); work.evidence = [source()]; capture(work, 'original');
  for (let index = 0; index < 20; index++) work.evidence.push(source({ id: `derived-${index}`, derivedFrom: ['source-1'], facts: { available: true } }));
  const next = capture(work, 'copies'); assert.equal(next.productiveSteps, 1); assert.equal(next.consecutiveUnproductive, 1);
  assert.equal(next.knownKeys.length, 1);
});

for (const denied of ['tenant', 'scope', 'labels', 'retracted', 'deleted', 'blocked-artifact'] as const) test(`capture: ${denied} evidence cannot earn progress`, () => {
  const work = state(); const item = source({ facts: { secretMarker: 'MUST_NOT_BECOME_A_PROGRESS_KEY' } });
  if (denied === 'tenant') item.tenantId = 'other';
  if (denied === 'scope') item.scope = 'other';
  if (denied === 'labels') item.labels = ['restricted'];
  if (denied === 'retracted') item.status = 'retracted';
  if (denied === 'deleted') item.access = 'deleted';
  if (denied === 'blocked-artifact') {
    item.artifact = { id: 'blocked', sha256: 'a'.repeat(64), byteLength: 1, mediaType: 'text/plain', tenantId: 'tenant-a', labels: ['synthetic'] };
    work.dataLifecycle = { generation: 1, blockedArtifactIds: ['blocked'], changes: [] };
  }
  work.evidence = [item]; const next = capture(work, 'denied'); assert.deepEqual(next.knownKeys, []); assert.equal(next.productiveSteps, 0);
});

test('capture: a hypothesis assessment is credited once per semantic evidence basis, not per hypothesis text or evidence ID', () => {
  const work = state(); work.evidence = [source()]; capture(work, 'read');
  work.hypotheses = [{ id: 'h1', question: 'Is the source available?', claim: 'The source is available', predictedObservation: 'Available is true',
    falsifier: 'Available is false', status: 'refuted', supportIds: [], counterIds: ['source-1'], reason: 'Original source contradicts the claim' }];
  work.hypothesisAssessment = { goalRevision: 1, evidenceIds: ['source-1'] };
  assert.equal(capture(work, 'assessment').productiveSteps, 2);
  work.hypotheses[0]!.id = 'h2'; work.hypotheses[0]!.reason = 'Longer explanation'; work.hypotheses[0]!.question = 'Same question rewritten';
  assert.equal(capture(work, 'rewrite').productiveSteps, 2);
  work.evidence[0]!.id = 'renamed-evidence'; work.hypotheses[0]!.counterIds = ['renamed-evidence']; work.hypothesisAssessment.evidenceIds = ['renamed-evidence'];
  assert.equal(capture(work, 'renamed-assessment').productiveSteps, 2);
  work.evidence.push(source({ id: 'counter', lineageId: 'independent', facts: { available: true } }));
  assert.equal(capture(work, 'new-counter').productiveSteps, 3);
  work.hypothesisAssessment.evidenceIds.push('counter'); assert.equal(capture(work, 'new-basis-assessment').productiveSteps, 4);
});

test('capture: no evidence or a stale hypothesis assessment earns a fresh reasoning credit', () => {
  const work = state(); work.hypotheses = [{ id: 'open', question: 'Q', claim: 'Claim', predictedObservation: 'P', falsifier: 'F', status: 'open', supportIds: [], counterIds: [], reason: 'R' }];
  work.hypothesisAssessment = { goalRevision: 1, evidenceIds: [] }; assert.equal(capture(work, 'empty-assessment').productiveSteps, 0);
  work.evidence = [source()]; capture(work, 'new-evidence'); assert.equal(capture(work, 'stale-assessment').productiveSteps, 1);
});

test('capture: only satisfied obligations contribute and identity or explanation rewrites cannot repeat the credit', () => {
  const work = state(); work.obligations = [{ id: 'q1', kind: 'response', status: 'pending', reason: 'Required clarification', wakeKey: 'answer-required', dueAt: null }];
  assert.equal(capture(work, 'waiting').productiveSteps, 0);
  work.obligations[0]!.status = 'satisfied'; assert.equal(capture(work, 'answer').productiveSteps, 1);
  work.obligations[0]!.id = 'q2'; work.obligations[0]!.reason = 'Same clarification rewritten'; assert.equal(capture(work, 'renamed-answer').productiveSteps, 1);
  work.obligations.push({ id: 'waived', kind: 'evidence', status: 'waived', reason: 'Optional', wakeKey: 'waived', dueAt: null });
  assert.equal(capture(work, 'waiver').productiveSteps, 1);
});

test('capture: plan, task, revision, mode, usage and replay changes cannot reset a stalled work', () => {
  const work = state(); capture(work, 'one'); work.revision++; work.updatedAt++;
  work.goal.mode = 'deep'; work.budget.used.modelCalls++; work.plan = { revision: 1, goalRevision: 1, reason: 'New wording', tasks: [] };
  capture(work, 'two'); work.plan.reason = 'Another plan'; work.plan.revision++;
  const stalled = capture(work, 'three'); assert.equal(stalled.consecutiveUnproductive, 3);
  assert.deepEqual(capture(work, 'one', { additionalKeys: ['replay-must-not-be-new'] }), stalled);
  assert.deepEqual(progressGate(work, 1000), { kind: 'blocked', reason: 'no_progress_limit' });
});

test('capture: trusted explicit item progress and returned state copies follow the same deduplication contract', () => {
  const work = state(); const first = capture(work, 'item-1', { additionalKeys: ['collection:operation:item-input-digest'] });
  first.knownKeys.push('caller-mutation'); first.policy.maxTrackedEntries = 1;
  assert.equal(work.progress!.knownKeys.length, 1); assert.equal(work.progress!.policy.maxTrackedEntries, 10000);
  assert.equal(capture(work, 'item-replay', { additionalKeys: ['collection:operation:item-input-digest'] }).productiveSteps, 1);
});

for (const adapter of adapters) test(`progress ${adapter}: reopen and duplicate commit preserve settlement counts and the first retry deadline`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-progress-')); let repository = openRepository(adapter, directory);
  try {
    const work = state(); captureProgress(work, digester, 'settlement-1', 1000, { failureKey: 'same-request' });
    assert.equal((await repository.commit(command(work, 'first'))).kind, 'committed'); await repository.close(); repository = openRepository(adapter, directory);
    const reopened = (await repository.get(work.id))! as State; const before = structuredClone(reopened.progress);
    captureProgress(reopened, digester, 'settlement-1', 9999, { failureKey: 'same-request' }); assert.deepEqual(reopened.progress, before);
    captureProgress(reopened, digester, 'settlement-2', 1100, { failureKey: 'same-request' }); reopened.revision++; reopened.updatedAt = 1100;
    const second = command(reopened, 'second'); assert.equal((await repository.commit(second)).kind, 'committed'); assert.equal((await repository.commit(second)).kind, 'duplicate');
    await repository.close(); repository = openRepository(adapter, directory); const saved = (await repository.get(work.id))! as State;
    assert.deepEqual(saved.progress!.processed, ['settlement-1', 'settlement-2']); assert.equal(saved.progress!.unproductiveSteps, 2);
    assert.equal(saved.progress!.failures[0]!.deadlineAt, 31000);
    assert.deepEqual(progressGate(saved, 1199, 'same-request'), { kind: 'wait', reason: 'retry_backoff', wakeAt: 1200 });
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});
