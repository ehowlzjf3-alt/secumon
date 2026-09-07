import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactRef, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { ComputerObservationRecord, ComputerView } from '../domain/computer-use.js';
import { evaluateCompletion } from '../domain/completion.js';
import { acceptedToolProgressKeys, captureProgress, progressGate } from '../application/work-progress.js';
import { ComputerObservationRecordSchema } from '../application/computer-use-contracts.js';
import { asJson } from '../application/plan-validator.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { attempt, initial } from './state-conformance-helpers.js';

const digester = new Sha256Digester();
const toolId = 'company.ui.observe';
const driver = { id: 'synthetic-document-app', version: '2' };
function state() {
  const value = initial('computer-observation-progress'); value.policy.allowedTools.push(toolId); return value;
}
function view(): ComputerView {
  return { sessionId: 'synthetic-document', epoch: 1, surfaceId: 'synthetic-document-window', revision: 0,
    focusRevision: 0, observedAt: 1000,
    elements: [{ ref: 'e1-0-0', role: 'textbox', name: 'Note', value: '', visible: true, enabled: true },
      { ref: 'e1-0-1', role: 'button', name: 'Save', value: null, visible: true, enabled: true }],
    facts: { savedNote: '', saveCount: 0 }, partial: false, omittedCount: 0 };
}

// The true flag models the caller's completed native-tool/proof check; these unit tests do not perform that check.
function adopted(work: WorkState, screen = view()) {
  const id = `observe-${work.attempts.length}`;
  const task: TaskSpec = { id, description: 'Observe the current document before acting', toolId, toolVersion: '1',
    input: {}, dependsOn: [], effect: 'read', maxAttempts: 1, satisfies: [] };
  const usage = { transportCalls: 1, internalOperations: 1, imageBytes: 0, waitMs: 0 };
  const record: ComputerObservationRecord = ComputerObservationRecordSchema.parse({ schemaVersion: 1, kind: 'computer_observation',
    workId: work.id, attemptId: id, goalRevision: work.goal.revision, scope: work.goal.scope,
    policyDigest: digester.digest(asJson(work.policy)), lifecycleGeneration: 0, driver, view: screen, usage });
  const digest = digester.digest(asJson(record));
  const artifact: ArtifactRef = { id: digest, sha256: digest, byteLength: new TextEncoder().encode(JSON.stringify(record)).byteLength,
    mediaType: 'application/json', tenantId: work.policy.tenantId, labels: ['synthetic'] };
  const result: ToolResult = { resultId: `${id}:computer-observation`, attemptId: id, status: screen.partial ? 'partial' : 'success',
    effectState: 'none', evidence: [], artifacts: [artifact], error: null, cursor: null, coverage: screen.partial ? 'partial' : 'complete', usage,
    output: asJson({ kind: 'computer_observation', sessionId: screen.sessionId, driver, observationId: artifact.id, view: screen }) };
  const ownAttempt = { ...attempt(screen.partial ? 'partial' : 'succeeded'), id, taskId: id, toolId, toolVersion: '1',
    goalRevision: work.goal.revision, scope: work.goal.scope, resultId: result.resultId, adopted: true };
  work.attempts.push(ownAttempt); work.artifacts.push(artifact);
  const keys = (verifiedComputerObservation = true) => acceptedToolProgressKeys(work, task, result, digester, verifiedComputerObservation);
  const capture = () => captureProgress(work, digester, `${id}:settled`, 1000, { additionalKeys: keys() });
  return { task, result, artifact, ownAttempt, keys, capture };
}

test('computer observation progress: a verified adopted view earns preparation without becoming evidence or completing criteria', () => {
  const work = state(), before = structuredClone({ goal: work.goal, policy: work.policy }), item = adopted(work);
  assert.equal(item.keys().length, 1);
  const progress = item.capture();
  assert.equal(progress.productiveSteps, 1); assert.equal(progress.consecutiveUnproductive, 0);
  assert.equal(progress.policy.maxUnproductiveSteps, 3); assert.deepEqual(work.evidence, []);
  assert.deepEqual({ goal: work.goal, policy: work.policy }, before);
  assert.equal(evaluateCompletion(work.goal, work.evidence, work.obligations, work.policy).complete, false);
});

test('computer observation progress: volatile observation metadata cannot renew credit and three unchanged views reach the default guard', () => {
  const work = state(), first = adopted(work), originalKeys = first.keys(); first.capture();
  for (let index = 1; index <= 3; index++) {
    const screen = view();
    screen.epoch += index; screen.revision = index; screen.focusRevision = index; screen.observedAt += index;
    screen.elements = screen.elements.map((element, offset) => ({ ...element, ref: `e${screen.epoch}-${index}-${offset}` }));
    if (index % 2) screen.elements.reverse();
    const current = adopted(work, screen);
    assert.notEqual(current.result.attemptId, first.result.attemptId);
    assert.notEqual(current.result.resultId, first.result.resultId);
    assert.notEqual(current.artifact.id, first.artifact.id);
    assert.deepEqual(current.keys(), originalKeys);
    const progress = current.capture();
    assert.equal(progress.productiveSteps, 1); assert.equal(progress.consecutiveUnproductive, index);
    assert.equal(progress.policy.maxUnproductiveSteps, 3);
    assert.deepEqual(progressGate(work, 1000), index < 3 ? null : { kind: 'blocked', reason: 'no_progress_limit' });
  }
});

test('computer observation progress: changed visible values or facts earn a new preparation key', () => {
  for (const change of ['element', 'fact'] as const) {
    const work = state(), first = adopted(work), originalKeys = first.keys(); first.capture();
    const screen = view();
    if (change === 'element') screen.elements[0]!.value = 'reviewed note';
    else screen.facts.savedNote = 'reviewed note';
    const updated = adopted(work, screen);
    assert.equal(updated.keys().length, 1); assert.notDeepEqual(updated.keys(), originalKeys, change);
    assert.equal(updated.capture().productiveSteps, 2, change); assert.equal(work.progress!.consecutiveUnproductive, 0);
    assert.deepEqual(work.evidence, []);
  }
});

test('computer observation progress: empty views earn no credit and still stop at the default three-step limit', () => {
  const work = state();
  for (let index = 1; index <= 3; index++) {
    const screen = view(); screen.elements = []; screen.facts = {}; screen.observedAt += index; screen.revision = index;
    const item = adopted(work, screen); assert.deepEqual(item.keys(), []);
    const progress = item.capture();
    assert.equal(progress.productiveSteps, 0); assert.equal(progress.consecutiveUnproductive, index);
    assert.deepEqual(progress.knownKeys, []); assert.equal(progress.policy.maxUnproductiveSteps, 3);
  }
  assert.deepEqual(progressGate(work, 1000), { kind: 'blocked', reason: 'no_progress_limit' });
});

test('computer observation progress: the output kind and indexed artifact alone cannot supply trusted proof', () => {
  const work = state(), item = adopted(work);
  assert.deepEqual(item.keys(false), []);
  assert.deepEqual(acceptedToolProgressKeys(work, item.task, item.result, digester), []);
  assert.equal(item.keys(true).length, 1);
});

test('computer observation progress: verified preparation does not require an unrelated local destination permission', () => {
  const work = state(); work.policy.allowedDestinations = ['intranet-desktop'];
  const item = adopted(work);
  // Runtime authenticates the binding destination; this unit only checks progress after that accepted proof.
  assert.equal(item.keys(true).length, 1);
  assert.deepEqual(item.keys(false), []);
  assert.deepEqual(acceptedToolProgressKeys(work, item.task, item.result, digester), []);
  assert.equal(item.capture().productiveSteps, 1);
  assert.deepEqual(work.policy.allowedDestinations, ['intranet-desktop']);
});

test('computer observation progress: reuse, rejection, errors and changed execution authority never earn credit', () => {
  for (const fault of ['result-reuse', 'attempt-reuse', 'not-adopted', 'foreign-goal', 'foreign-scope', 'wrong-result', 'error', 'unknown-effect', 'denied-tool'] as const) {
    const work = state(), item = adopted(work);
    const reuse = { attemptId: 'prior', resultId: 'prior-result', resultArtifact: item.artifact, observedAt: 999, cacheKey: 'a'.repeat(64) };
    if (fault === 'result-reuse') item.result.reuse = reuse;
    if (fault === 'attempt-reuse') item.ownAttempt.reuse = reuse;
    if (fault === 'not-adopted') item.ownAttempt.adopted = false;
    if (fault === 'foreign-goal') item.ownAttempt.goalRevision++;
    if (fault === 'foreign-scope') item.ownAttempt.scope = 'other';
    if (fault === 'wrong-result') item.ownAttempt.resultId = 'other';
    if (fault === 'error') item.result.status = 'error';
    if (fault === 'unknown-effect') item.result.effectState = 'unknown';
    if (fault === 'denied-tool') work.policy.allowedTools = [];
    assert.deepEqual(item.keys(), [], fault);
  }
});
