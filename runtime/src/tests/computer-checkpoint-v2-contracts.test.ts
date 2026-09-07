import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ArtifactRef, ToolUsage } from '../domain/model.js';
import type { ComputerContinuationClaim } from '../domain/computer-continuation.js';
import type { ComputerCheckpointStep, ComputerCheckpointV1, ComputerCheckpointV2, ComputerLineage } from '../domain/computer-use.js';
import { ComputerCheckpointSchema, ComputerCheckpointV1Schema, ComputerCheckpointV2Schema, ComputerLineageSchema } from '../application/computer-use-contracts.js';

const usage: ToolUsage = { transportCalls: 0, internalOperations: 0, imageBytes: 0, waitMs: 0 };
const artifact = (id: string): ArtifactRef => ({ id, sha256: 'a'.repeat(64), byteLength: 100, mediaType: 'application/json', tenantId: 'synthetic', labels: ['synthetic'] });
function root(): ComputerCheckpointV2 {
  return { schemaVersion: 2, kind: 'computer_checkpoint', workId: 'work', attemptId: 'root', goalRevision: 1, scope: 'synthetic',
    policyDigest: 'b'.repeat(64), lifecycleGeneration: 0, taskDigest: 'c'.repeat(64), contractDigest: 'd'.repeat(64),
    driver: { id: 'synthetic', version: '2' }, sessionId: 'synthetic-document', epoch: 1, deadlineAt: 1000,
    initialObservation: artifact('historical'), latestObservation: artifact('historical'), steps: [], phase: 'running', stopReason: null, usage: { ...usage },
    lineage: { rootAttemptId: 'root', actionDeadlineAt: 1000, maxObservations: 12, maxInputAttempts: 6, maxSuccessors: 8, depth: 0, observationsUsed: 0, inputAttemptsUsed: 0 },
    entryObservation: null, continuation: null };
}
function claim(mode: 'continue' | 'verify' = 'continue'): ComputerContinuationClaim {
  return { sourceAttemptId: 'root', sourceHead: artifact('source-head'), sourceResultArtifact: artifact('source-result'), successorAttemptId: 'child',
    successorTaskDigest: 'e'.repeat(64), mode, reconciliation: { id: 'reconciliation', proofArtifact: artifact('proof') }, rootAttemptId: 'root',
    sourceContractDigest: 'd'.repeat(64), contractDigest: 'f'.repeat(64), goalRevision: 1, scope: 'synthetic', policyDigest: 'b'.repeat(64), generation: 0,
    createdAt: mode === 'continue' ? 100 : 1500, actionDeadlineAt: 1000, maxObservations: 12, maxInputAttempts: 6, maxSuccessors: 8, depth: 1,
    observationsUsed: 4, inputAttemptsUsed: mode === 'continue' ? 2 : 3, nextStep: mode === 'continue' ? 1 : 3, totalSteps: 3 };
}
function child(mode: 'continue' | 'verify' = 'continue'): ComputerCheckpointV2 {
  const parent = root(); const inherited = claim(mode);
  return { ...parent, attemptId: inherited.successorAttemptId, taskDigest: inherited.successorTaskDigest, contractDigest: inherited.contractDigest,
    epoch: 2, deadlineAt: mode === 'verify' ? 2500 : 900, initialObservation: artifact('parent-latest'), latestObservation: artifact('parent-latest'),
    lineage: { ...parent.lineage, depth: inherited.depth, observationsUsed: inherited.observationsUsed, inputAttemptsUsed: inherited.inputAttemptsUsed },
    continuation: { claim: inherited, inheritedObservation: null } };
}
function step(index = 0, status: ComputerCheckpointStep['status'] = 'applied'): ComputerCheckpointStep {
  return { index, operationId: `operation-${index}`, action: { kind: 'fill', target: { role: 'textbox', name: `Field ${index}` }, value: 'synthetic text' },
    condition: { kind: 'element_value', target: { role: 'textbox', name: `Field ${index}` }, value: 'synthetic text' },
    before: artifact(`before-${index}`), after: status === 'applied' ? artifact(`after-${index}`) : null,
    status, verified: status === 'applied', errorCode: null };
}
function entered(checkpoint: ComputerCheckpointV2): ComputerCheckpointV2 {
  checkpoint.entryObservation = artifact('entry'); checkpoint.latestObservation = artifact('entry'); checkpoint.lineage.observationsUsed++;
  return checkpoint;
}
function withSteps(checkpoint: ComputerCheckpointV2, steps: ComputerCheckpointStep[]): ComputerCheckpointV2 {
  entered(checkpoint); checkpoint.steps = steps;
  checkpoint.lineage.inputAttemptsUsed = (checkpoint.continuation?.claim.inputAttemptsUsed ?? 0) + steps.length;
  if (checkpoint.continuation) checkpoint.continuation.inheritedObservation = artifact('inherited-verified');
  return checkpoint;
}
function reject(input: unknown): void { assert.equal(ComputerCheckpointV2Schema.safeParse(input).success, false); }

test('checkpoint v2: v1 retains its exact serialized shape and rejects v2 fields', () => {
  const { lineage, entryObservation, continuation, ...common } = root();
  const historical: ComputerCheckpointV1 = { ...common, schemaVersion: 1, phase: 'complete', steps: [step()], latestObservation: artifact('after-0') };
  const parsed = ComputerCheckpointSchema.parse(historical);
  assert.deepEqual(parsed, historical); assert.equal(parsed.schemaVersion, 1);
  const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
  assert.equal(digest(parsed), digest(historical));
  assert.deepEqual(ComputerCheckpointV1Schema.parse(historical), historical);
  for (const extension of [{ lineage }, { entryObservation }, { continuation }]) {
    assert.equal(ComputerCheckpointSchema.safeParse({ ...historical, ...extension }).success, false);
  }
  reject({ ...historical, schemaVersion: 2 });
  assert.equal(ComputerCheckpointV1Schema.safeParse(root()).success, false);
});

test('checkpoint v2: an initial head preserves historical refs before any fresh observation', () => {
  for (const checkpoint of [root(), child(), child('verify')]) {
    assert.deepEqual(ComputerCheckpointV2Schema.parse(checkpoint), checkpoint);
    assert.equal(ComputerCheckpointSchema.parse(checkpoint).schemaVersion, 2);
    const failedObservation = structuredClone(checkpoint); failedObservation.lineage.observationsUsed++;
    failedObservation.phase = 'partial'; failedObservation.stopReason = 'computer_observation_failed';
    assert.deepEqual(ComputerCheckpointV2Schema.parse(failedObservation), failedObservation, 'a reserved observation remains spent even without a new artifact');
    reject({ ...checkpoint, latestObservation: artifact('unexplained-new-observation') });
    reject({ ...checkpoint, steps: [step(0, 'intent')], lineage: { ...checkpoint.lineage, inputAttemptsUsed: checkpoint.lineage.inputAttemptsUsed + 1 } });
  }
});

test('checkpoint v2: fresh observation and input intent each require their retained reservation', () => {
  const fresh = entered(root()); assert.equal(ComputerCheckpointV2Schema.safeParse(fresh).success, true);
  reject({ ...fresh, lineage: { ...fresh.lineage, observationsUsed: 0 } });
  for (const status of ['intent', 'not_applied', 'unknown', 'applied'] as const) {
    const checkpoint = withSteps(root(), [step(0, status)]);
    assert.equal(ComputerCheckpointV2Schema.safeParse(checkpoint).success, true);
    reject({ ...checkpoint, lineage: { ...checkpoint.lineage, inputAttemptsUsed: 0 } });
    reject({ ...checkpoint, lineage: { ...checkpoint.lineage, inputAttemptsUsed: 2 } });
  }
});

test('checkpoint v2: root identity, lifetime and bounded counters cannot be reset or enlarged', () => {
  const original = root();
  const invalid: Partial<ComputerLineage>[] = [{ rootAttemptId: 'another-root' }, { depth: 1 }, { actionDeadlineAt: 1001 },
    { maxObservations: 13 }, { maxInputAttempts: 7 }, { maxSuccessors: 9 }, { observationsUsed: 13 }, { inputAttemptsUsed: 1 },
    { maxObservations: 1, observationsUsed: 2 }, { maxInputAttempts: 1, inputAttemptsUsed: 2 }];
  for (const change of invalid) reject({ ...original, lineage: { ...original.lineage, ...change } });
  reject({ ...original, deadlineAt: 999 });
  assert.equal(ComputerLineageSchema.safeParse({ ...original.lineage, maxSuccessors: 1, depth: 2 }).success, false);
  assert.equal(ComputerLineageSchema.safeParse({ ...original.lineage, observationsUsed: Number.MAX_SAFE_INTEGER + 1 }).success, false);
});

test('checkpoint v2: a child binds its own task and policy basis to the immutable claim', () => {
  const original = child();
  const changes: Partial<ComputerCheckpointV2>[] = [{ attemptId: 'different-child' }, { taskDigest: '1'.repeat(64) }, { contractDigest: '2'.repeat(64) },
    { goalRevision: 2 }, { scope: 'another-scope' }, { policyDigest: '3'.repeat(64) }, { lifecycleGeneration: 1 }];
  for (const change of changes) reject({ ...original, ...change });
  const lineageChanges: Partial<ComputerLineage>[] = [{ rootAttemptId: 'different-root' }, { depth: 2 }, { actionDeadlineAt: 900 },
    { maxObservations: 11 }, { maxInputAttempts: 5 }, { maxSuccessors: 7 }, { observationsUsed: 3 }, { inputAttemptsUsed: 1 }];
  for (const change of lineageChanges) reject({ ...original, lineage: { ...original.lineage, ...change } });
  const fresh = entered(child()); assert.equal(ComputerCheckpointV2Schema.safeParse(fresh).success, true);
  reject({ ...fresh, lineage: { ...fresh.lineage, observationsUsed: fresh.continuation!.claim.observationsUsed } });
});

test('checkpoint v2: child actions use local indexes and cannot prepend the parent prefix or skip intent accounting', () => {
  const original = withSteps(child(), [step(0), step(1, 'intent')]);
  assert.equal(original.continuation!.claim.nextStep, 1);
  assert.equal(ComputerCheckpointV2Schema.safeParse(original).success, true, 'original batch indexes are nextStep + each local index');
  reject({ ...original, steps: [step(1), step(2, 'intent')] });
  reject(withSteps(child(), [step(0), step(1), step(2)]));
  reject({ ...original, lineage: { ...original.lineage, inputAttemptsUsed: original.steps.length } });
  reject({ ...original, steps: [step(0, 'intent'), step(1)] });
  reject({ ...original, steps: [step(0), { ...step(1), operationId: 'operation-0' }] });
});

test('checkpoint v2: inherited conditions must be observed before a successor can issue an input', () => {
  const original = withSteps(child(), [step(0, 'not_applied')]);
  assert.equal(ComputerCheckpointV2Schema.safeParse(original).success, true);
  reject({ ...original, entryObservation: null });
  reject({ ...original, continuation: { ...original.continuation!, inheritedObservation: null } });
  const noActionsYet = entered(child());
  assert.equal(ComputerCheckpointV2Schema.safeParse(noActionsYet).success, true, 'fresh entry may precede inherited condition verification');
  reject({ ...child(), continuation: { ...child().continuation!, inheritedObservation: artifact('unobserved-inheritance') } });
});

test('checkpoint v2: only verification may get a fresh read deadline after the root input deadline', () => {
  const continuing = child(); assert.equal(ComputerCheckpointV2Schema.safeParse(continuing).success, true);
  reject({ ...continuing, deadlineAt: continuing.lineage.actionDeadlineAt + 1 });
  const verifying = child('verify'); assert.ok(verifying.deadlineAt > verifying.lineage.actionDeadlineAt);
  assert.ok(verifying.continuation!.claim.createdAt > verifying.lineage.actionDeadlineAt);
  assert.equal(ComputerCheckpointV2Schema.safeParse(verifying).success, true);
  reject(withSteps(verifying, [step(0, 'intent')]));
});

test('checkpoint v2: completing a suffix requires every own input and every condition to be confirmed', () => {
  const complete = withSteps(child(), [step(0), step(1)]); complete.phase = 'complete';
  assert.equal(ComputerCheckpointV2Schema.safeParse(complete).success, true);
  const incomplete = withSteps(child(), [step(0)]); incomplete.phase = 'complete'; reject(incomplete);
  for (const status of ['intent', 'not_applied', 'unknown'] as const) {
    reject({ ...complete, steps: [step(0), step(1, status)] });
  }
  reject({ ...complete, steps: [step(0), { ...step(1), verified: false }] });
  reject({ ...complete, steps: [step(0), { ...step(1), after: null }] });
  reject({ ...complete, stopReason: 'computer_condition_not_verified' });
  const partial = withSteps(child(), [{ ...step(0), verified: false }]); partial.phase = 'partial'; partial.stopReason = 'computer_condition_not_verified';
  assert.equal(ComputerCheckpointV2Schema.safeParse(partial).success, true);
});

test('checkpoint v2: zero-input completion requires a fully applied parent and fresh inheritance verification', () => {
  const complete = entered(child('verify')); complete.phase = 'complete';
  complete.continuation!.inheritedObservation = artifact('inherited-verified');
  assert.equal(ComputerCheckpointV2Schema.safeParse(complete).success, true);
  assert.equal(complete.lineage.inputAttemptsUsed, complete.continuation!.claim.inputAttemptsUsed);
  reject({ ...complete, entryObservation: null });
  reject({ ...complete, continuation: { ...complete.continuation!, inheritedObservation: null } });
  reject({ ...complete, continuation: { ...complete.continuation!, claim: { ...complete.continuation!.claim, nextStep: 2 } } });
  reject({ ...entered(root()), phase: 'complete' });
  const continuing = entered(child()); continuing.continuation!.inheritedObservation = artifact('inherited-verified');
  reject({ ...continuing, phase: 'complete' });
});

test('checkpoint v2: strict parsing detaches the lineage and claim without silently accepting extra capabilities', () => {
  const original = child(); const parsed = ComputerCheckpointV2Schema.parse(original);
  parsed.lineage.observationsUsed++; parsed.continuation!.claim.sourceHead.labels.push('changed');
  assert.equal(original.lineage.observationsUsed, 4); assert.deepEqual(original.continuation!.claim.sourceHead.labels, ['synthetic']);
  reject({ ...original, driverAddress: 'unregistered' });
  reject({ ...original, lineage: { ...original.lineage, resetBudget: true } });
  reject({ ...original, continuation: { ...original.continuation!, trusted: true } });
  reject({ ...original, continuation: { ...original.continuation!, claim: { ...original.continuation!.claim, rawParentActions: [step()] } } });
});
