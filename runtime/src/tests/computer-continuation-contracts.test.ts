import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerContinuationClaim, ComputerResume } from '../domain/computer-continuation.js';
import { continuationTransitionError } from '../domain/computer-continuation.js';
import type { ComputerReconciliation } from '../domain/computer-reconciliation.js';
import type { ArtifactRef, Attempt, ContextPacket, TaskSpec, WorkState } from '../domain/model.js';
import type { Tool } from '../application/ports.js';
import { ComputerContinuationClaimSchema, ComputerContinuationsSchema, ComputerResumeSchema, ContextPacketSchema, TaskSchema, WorkStateSchema } from '../application/contracts.js';
import { asJson, taskDigest, validatePlan } from '../application/plan-validator.js';
import { ToolDefinitionSchema } from '../application/resource-contracts.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { validateStateTransition } from '../application/store-contract.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { adapters, advance, attempt, command, initial, openRepository, snapshot } from './state-conformance-helpers.js';

const digest = new Sha256Digester();
const hash = (value: unknown) => digest.digest(asJson(value));
const originalContract = hash('original-contract'); const continuationContract = hash('continuation-contract');
const notInvoked = () => ({ mode: 'not_invoked' as const, implementationCalls: 0 as const,
  usage: { transportCalls: 0, internalOperations: 0, imageBytes: 0, waitMs: 0 } });
function ref(id: string): ArtifactRef {
  return { id, sha256: hash(id), byteLength: 10, mediaType: 'application/json', tenantId: 'tenant-a', labels: ['synthetic'] };
}
const resume = (): ComputerResume => ({ attemptId: 'attempt', checkpointId: 'original-head', reconciliation: null });
function task(mode: ComputerContinuationClaim['mode'] = 'continue', id = 'successor-task'): TaskSpec {
  return { id, description: 'Continue only unperformed synthetic input', dependsOn: [], toolId: `computer.${mode}`, toolVersion: '1', input: {},
    effect: mode === 'continue' ? 'write' : 'read', computerResume: resume(), maxAttempts: 1, satisfies: ['criterion'] };
}
function base(): WorkState {
  const state = initial(); state.policy.allowWrites = true; state.policy.allowedTools = ['computer.act', 'computer.continue', 'computer.verify'];
  state.attempts = [{ ...attempt('partial'), toolId: 'computer.act', inputDigest: hash('original-task'), contractDigest: originalContract,
    effect: 'write', effectState: 'confirmed', resultId: 'original-result-id', resultArtifact: ref('original-result'), finishedAt: 1000,
    computerUse: { head: ref('original-head'), phase: 'partial', completedSteps: 1, pendingOperationId: null } }];
  state.artifacts = [ref('original-head'), ref('original-result')]; return state;
}
function reservation(prior = base(), mode: ComputerContinuationClaim['mode'] = 'continue', successorId = 'successor'): WorkState {
  const next = advance(prior); const spec = task(mode, `${successorId}-task`);
  const claim: ComputerContinuationClaim = { sourceAttemptId: 'attempt', sourceHead: ref('original-head'), sourceResultArtifact: ref('original-result'),
    successorAttemptId: successorId, successorTaskDigest: taskDigest(spec, digest), mode, reconciliation: null, rootAttemptId: 'attempt',
    sourceContractDigest: originalContract, contractDigest: continuationContract, goalRevision: next.goal.revision, scope: next.goal.scope,
    policyDigest: hash(next.policy), generation: 0, createdAt: next.updatedAt, actionDeadlineAt: 2000, maxObservations: 12,
    maxInputAttempts: 6, maxSuccessors: 8, depth: 1, observationsUsed: 3, inputAttemptsUsed: 1, nextStep: mode === 'continue' ? 1 : 3, totalSteps: 3 };
  next.plan = { revision: 1, goalRevision: next.goal.revision, reason: 'Explicit continuation', tasks: [spec] };
  next.attempts.push({ ...attempt('reserved'), id: successorId, taskId: spec.id, toolId: spec.toolId, effect: spec.effect,
    inputDigest: claim.successorTaskDigest, contractDigest: continuationContract, execution: notInvoked() });
  next.computerContinuations = [claim]; next.budget.reservedToolCalls++; return next;
}
function context(state: WorkState): ContextPacket {
  return { schemaVersion: 1, workId: state.id, stateRevision: state.revision, goal: state.goal, policy: state.policy, plan: state.plan,
    hypotheses: state.hypotheses, obligations: state.obligations, evidence: state.evidence, activeToolIds: [], purpose: 'plan',
    ...(state.computerContinuations ? { computerContinuations: state.computerContinuations } : {}) };
}
function tool(mode: ComputerContinuationClaim['mode'] = 'continue'): Tool {
  return { definition: { provider: 'computer', id: `computer.${mode}`, version: '1', description: 'Synthetic continuation contract',
    effect: mode === 'continue' ? 'write' : 'read', inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' },
    destination: 'local', labels: ['synthetic'], resultValidation: 'artifact-proof-v1', computerContinuation: mode },
    execute: async () => { throw new Error('contract_test_must_not_execute'); }, validateResult: async () => true };
}
const registry = (...tools: Tool[]) => new ToolContracts(tools, new AjvSchemas());

test('computer continuation contract: optional fields leave legacy state, context and task digests unchanged', () => {
  const state = base(); assert.equal(Object.hasOwn(WorkStateSchema.parse(state), 'computerContinuations'), false);
  assert.equal(Object.hasOwn(ContextPacketSchema.parse(context(state)), 'computerContinuations'), false);
  const plain = task(); delete plain.computerResume;
  assert.equal(Object.hasOwn(TaskSchema.parse(plain), 'computerResume'), false);
  assert.equal(taskDigest(plain, digest), hash({ toolId: plain.toolId, toolVersion: plain.toolVersion, input: plain.input, effect: plain.effect }));
  assert.equal(continuationTransitionError(null, state), null);
  const next = reservation(); assert.deepEqual(ContextPacketSchema.parse(context(next)).computerContinuations, next.computerContinuations);
  const parsed = WorkStateSchema.parse(next); parsed.computerContinuations![0]!.sourceHead.labels.push('mutated');
  assert.deepEqual(next.computerContinuations![0]!.sourceHead.labels, ['synthetic']);
});

test('computer continuation contract: control metadata cannot carry raw actions, offsets or two resume mechanisms', () => {
  for (const value of [{ ...resume(), steps: [] }, { ...resume(), nextStep: 2 }, { ...resume(), reconciliation: { id: 'r' } },
    { ...resume(), reconciliation: { id: 'r', proofId: 'p', outcome: 'applied' } }, { ...resume(), checkpointId: '' }])
    assert.equal(ComputerResumeSchema.safeParse(value).success, false);
  assert.equal(ComputerResumeSchema.safeParse(resume()).success, true);
  assert.equal(TaskSchema.safeParse({ ...task(), readResume: { attemptId: 'a', checkpointId: 'h' } }).success, false);
  const claim = reservation().computerContinuations![0]!;
  assert.equal(ComputerContinuationClaimSchema.safeParse({ ...claim, action: { kind: 'click' } }).success, false);
});

test('computer continuation contract: counters, depth and mode cannot revive the action window or exceed inherited limits', () => {
  const claim = reservation().computerContinuations![0]!;
  for (const change of [{ maxObservations: 13 }, { maxInputAttempts: 7 }, { maxSuccessors: 9 }, { depth: 0 }, { depth: 3, maxSuccessors: 2 },
    { observationsUsed: 4, maxObservations: 3 }, { inputAttemptsUsed: 3, maxInputAttempts: 2 }, { nextStep: 4 }, { totalSteps: 0 },
    { mode: 'continue', nextStep: 3 }, { mode: 'verify', nextStep: 2 }, { actionDeadlineAt: claim.createdAt },
    { generation: Number.MAX_SAFE_INTEGER + 1 }, { successorAttemptId: claim.sourceAttemptId }])
    assert.equal(ComputerContinuationClaimSchema.safeParse({ ...claim, ...change }).success, false, JSON.stringify(change));
  assert.equal(ComputerContinuationClaimSchema.safeParse({ ...claim, mode: 'verify', nextStep: 3, actionDeadlineAt: 1 }).success, true,
    'a later read lease does not reopen the original input window');
  const claims = Array.from({ length: 1000 }, (_, index) => ({ ...claim, sourceAttemptId: `source-${index}`, successorAttemptId: `child-${index}` }));
  assert.equal(ComputerContinuationsSchema.safeParse(claims).success, true);
  assert.equal(ComputerContinuationsSchema.safeParse([...claims, { ...claim, sourceAttemptId: 'extra' }]).success, false);
  assert.equal(ComputerContinuationsSchema.safeParse([claim, { ...claim, successorAttemptId: 'another' }]).success, false);
  assert.equal(ComputerContinuationsSchema.safeParse([claim, { ...claim, sourceAttemptId: 'another' }]).success, false);
});

test('computer continuation planning: exact parent and proof participate in task identity, including historical plans', () => {
  const state = base(); const original = task(); const tools = registry(tool());
  const proposal = { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision, basePlanRevision: 0,
    reason: 'Continue fixture', tasks: [original], hypotheses: [] };
  assert.doesNotThrow(() => validatePlan(proposal, state, tools, digest));
  for (const computerResume of [{ ...resume(), checkpointId: 'other-head' }, { ...resume(), attemptId: 'other-parent' },
    { ...resume(), reconciliation: { id: 'lookup', proofId: 'proof-a' } }, { ...resume(), reconciliation: { id: 'lookup', proofId: 'proof-b' } }]) {
    const changed = { ...original, computerResume };
    assert.notEqual(taskDigest(original, digest), taskDigest(changed, digest));
    assert.throws(() => validatePlan({ ...proposal, tasks: [changed] }, state, tools, digest, [original]), /task_id_contract_changed/);
  }
});

test('computer continuation tools: proof metadata is mandatory and refresh cannot install an invalid or cacheable adapter', () => {
  const selected = tool(); const tools = registry(selected); const before = tools.get('computer.continue', '1');
  const invalid: Tool['definition'][] = [{ ...selected.definition, resultValidation: undefined }, { ...selected.definition, effect: 'read' },
    { ...tool('verify').definition, effect: 'write' }, { ...tool('verify').definition, reuse: { mode: 'immutable', sourceVersion: '1' } },
    { ...tool('verify').definition, collection: { kind: 'batch', limits: { maxPages: 1, maxItems: 1, maxCalls: 1, maxPageBytes: 100, maxCheckpointBytes: 100, pageSize: 1 } } }];
  for (const definition of invalid) {
    assert.equal(ToolDefinitionSchema.safeParse(definition).success, false);
    assert.throws(() => tools.replaceProvider('computer', [{ ...selected, definition }], { expectedEpoch: 1, sourceRevision: 'invalid' }));
    assert.strictEqual(tools.get('computer.continue', '1'), before); assert.equal(tools.providerEpoch('computer'), 1);
  }
  const missing = tool(); delete missing.validateResult;
  assert.throws(() => registry(missing), /tool_result_validator_required/);
  assert.notEqual(hash(selected.definition), hash({ ...selected.definition, computerContinuation: undefined }));
});

test('computer continuation tools: resume is required exactly for marked tools and verify needs no write permission', () => {
  const plain = tool(); delete plain.definition.computerContinuation; plain.definition.id = 'computer.act';
  const tools = registry(tool(), tool('verify'), plain); const policy = base().policy;
  assert.equal(tools.check(task(), policy), null); assert.equal(tools.check(task('verify'), { ...policy, allowWrites: false }), null);
  assert.equal(tools.check(task(), { ...policy, allowWrites: false }), 'tool_permission_denied');
  const missing = task(); delete missing.computerResume;
  assert.equal(tools.check(missing, policy), 'computer_continuation_resume_required');
  assert.equal(tools.check({ ...task(), toolId: 'computer.act' }, policy), 'computer_resume_requires_continuation');
  assert.equal(tools.check({ ...task(), readResume: { attemptId: 'a', checkpointId: 'h' } }, policy), 'computer_resume_conflict');
  assert.equal(tools.check({ ...task(), input: { nextStep: 2 } }, policy), 'invalid_tool_input');
});

test('computer continuation transition: claim and a new reserved attempt plus budget must be committed together', () => {
  const prior = base(); const next = reservation(prior);
  assert.equal(continuationTransitionError(prior, next), null);
  for (const change of [
    (value: WorkState) => { value.attempts.pop(); }, (value: WorkState) => { value.attempts[1]!.status = 'running'; },
    (value: WorkState) => { value.attempts[1]!.execution = undefined; }, (value: WorkState) => { value.budget.reservedToolCalls = 0; },
    (value: WorkState) => { value.plan!.tasks[0]!.computerResume = { ...resume(), checkpointId: 'unbound' }; },
    (value: WorkState) => { value.plan!.tasks[0]!.input = { steps: [] }; }, (value: WorkState) => { value.goal.revision++; },
  ]) { const changed = structuredClone(next); change(changed); assert.notEqual(continuationTransitionError(prior, changed), null); }
  const existing = structuredClone(prior); existing.attempts.push(structuredClone(next.attempts[1]!));
  assert.equal(continuationTransitionError(existing, next), 'computer_continuation_reservation_invalid');
  const active = structuredClone(prior); active.attempts[0]!.status = 'running';
  assert.equal(continuationTransitionError(active, next), 'computer_continuation_reservation_invalid');
  assert.notEqual(continuationTransitionError(null, next), null);
});

test('computer continuation transition: a claimed parent cannot be replaced, removed or assigned a second sibling', () => {
  const original = reservation(); const claim = original.computerContinuations![0]!;
  const changes: Partial<ComputerContinuationClaim>[] = [{ sourceHead: ref('other-head') }, { sourceResultArtifact: null },
    { successorAttemptId: 'other' }, { successorTaskDigest: hash('other') }, { mode: 'verify' }, { reconciliation: { id: 'lookup', proofArtifact: ref('proof') } },
    { rootAttemptId: 'other' }, { sourceContractDigest: hash('other') }, { contractDigest: hash('other') }, { goalRevision: 2 }, { scope: 'other' },
    { policyDigest: hash('other') }, { generation: 1 }, { createdAt: 1002 }, { actionDeadlineAt: 3000 }, { maxObservations: 11 },
    { maxInputAttempts: 5 }, { maxSuccessors: 7 }, { depth: 2 }, { observationsUsed: 4 }, { inputAttemptsUsed: 2 }, { nextStep: 2 }, { totalSteps: 2 }];
  for (const change of changes) {
    const next = advance(original); Object.assign(next.computerContinuations![0]!, change);
    assert.notEqual(continuationTransitionError(original, next), null, JSON.stringify(change));
  }
  const removed = advance(original); delete removed.computerContinuations;
  assert.equal(continuationTransitionError(original, removed), 'computer_continuation_history_removed');
  const sibling = advance(original); sibling.computerContinuations!.push({ ...claim, successorAttemptId: 'sibling' });
  assert.equal(continuationTransitionError(original, sibling), 'computer_continuation_duplicate');
  const cancelled = advance(original); cancelled.attempts[1]!.status = 'cancelled'; cancelled.attempts[1]!.finishedAt = cancelled.updatedAt;
  cancelled.budget.reservedToolCalls--; assert.equal(continuationTransitionError(original, cancelled), null);
  assert.deepEqual(cancelled.computerContinuations, original.computerContinuations, 'cancellation does not return the parent to an unclaimed state');
});

test('computer continuation transition: source result, checkpoint and task identity stay immutable while the child progresses', () => {
  const original = reservation();
  const changes: Partial<Attempt>[] = [{ taskId: 'other' }, { planRevision: 2 }, { goalRevision: 2 }, { toolId: 'other' }, { toolVersion: '2' },
    { inputDigest: hash('other') }, { contractDigest: hash('other') }, { scope: 'other' }, { effect: 'read' }, { resultId: 'late-result' },
    { resultArtifact: null }, { computerUse: { ...original.attempts[0]!.computerUse!, head: ref('late-head') } }];
  for (const change of changes) {
    const next = advance(original); Object.assign(next.attempts[0]!, change);
    assert.equal(continuationTransitionError(original, next), 'computer_continuation_source_changed');
  }
  const running = advance(original); running.attempts[1]!.status = 'running'; running.attempts[1]!.effectState = 'unknown';
  running.attempts[1]!.computerUse = { head: ref('child-head'), phase: 'running', completedSteps: 0, pendingOperationId: null };
  assert.equal(continuationTransitionError(original, running), null);
  const rewritten = advance(original); rewritten.attempts[1]!.taskId = 'replacement-task';
  assert.equal(continuationTransitionError(original, rewritten), 'computer_continuation_successor_changed');
});

test('computer continuation transition: an unknown parent requires the exact settled proof and source basis', () => {
  const prior = base(); const source = prior.attempts[0]!; source.status = 'unknown'; source.effectState = 'unknown';
  source.computerUse!.phase = 'unknown'; source.computerUse!.pendingOperationId = 'op';
  const record: ComputerReconciliation = { id: 'lookup', sourceAttemptId: source.id, obligationId: 'effect:attempt', sourceHead: source.computerUse!.head,
    sourceResultArtifact: source.resultArtifact, requestArtifact: ref('request'), responseArtifact: ref('response'), proofArtifact: ref('proof'),
    operationId: 'op', stepIndex: 1, goalRevision: prior.goal.revision, policyDigest: hash(prior.policy), generation: 0, contractDigest: originalContract,
    driver: { id: 'driver', version: '1' }, owner: 'worker', leaseUntil: 2000, createdAt: 1000, dispatchedAt: 1000, finishedAt: 1000,
    status: 'settled', execution: { mode: 'invoked', implementationCalls: 1, usage: { transportCalls: 1, internalOperations: 1, imageBytes: 0, waitMs: 0 } },
    reason: null, outcome: 'not_applied', effectState: 'confirmed' };
  prior.computerReconciliations = [record];
  const next = reservation(prior);
  assert.equal(continuationTransitionError(prior, next), 'computer_continuation_proof_changed');
  next.computerContinuations![0]!.reconciliation = { id: record.id, proofArtifact: ref('proof') };
  next.plan!.tasks[0]!.computerResume!.reconciliation = { id: record.id, proofId: 'proof' };
  next.attempts[1]!.inputDigest = taskDigest(next.plan!.tasks[0]!, digest); next.computerContinuations![0]!.successorTaskDigest = next.attempts[1]!.inputDigest;
  assert.equal(continuationTransitionError(prior, next), null);
  for (const change of [{ status: 'failed' as const }, { proofArtifact: ref('replacement') }, { sourceHead: ref('replacement') },
    { sourceAttemptId: 'other' }, { policyDigest: hash('other') }, { generation: 1 }]) {
    const altered = structuredClone(next); Object.assign(altered.computerReconciliations![0]!, change);
    assert.equal(continuationTransitionError(prior, altered), 'computer_continuation_proof_changed');
  }
});

test('computer continuation transition: a later generation inherits root limits and cannot reset counters, depth or the action deadline', () => {
  const prior = reservation(); const parent = prior.computerContinuations![0]!;
  prior.attempts[1]!.status = 'partial'; prior.attempts[1]!.finishedAt = 1002;
  prior.attempts[1]!.computerUse = { head: ref('child-head'), phase: 'partial', completedSteps: 1, pendingOperationId: null };
  const spec = task(); spec.id = 'grandchild-task'; spec.computerResume = { attemptId: 'successor', checkpointId: 'child-head', reconciliation: null };
  const next = advance(prior); next.plan = { revision: 2, goalRevision: next.goal.revision, reason: 'Only remaining input', tasks: [spec] };
  const claim: ComputerContinuationClaim = { ...parent, sourceAttemptId: 'successor', sourceHead: ref('child-head'), sourceResultArtifact: null,
    sourceContractDigest: continuationContract, successorAttemptId: 'grandchild', successorTaskDigest: taskDigest(spec, digest), createdAt: next.updatedAt,
    depth: 2, observationsUsed: 4, inputAttemptsUsed: 2, nextStep: 2 };
  next.computerContinuations!.push(claim); next.attempts.push({ ...attempt('reserved'), id: 'grandchild', taskId: spec.id,
    planRevision: 2, toolId: spec.toolId, effect: 'write', contractDigest: continuationContract, inputDigest: claim.successorTaskDigest, execution: notInvoked() });
  next.budget.reservedToolCalls++; assert.equal(continuationTransitionError(prior, next), null);
  for (const change of [{ rootAttemptId: 'successor' }, { depth: 1 }, { actionDeadlineAt: 3000 }, { maxObservations: 11 }, { maxInputAttempts: 5 },
    { maxSuccessors: 7 }, { observationsUsed: 2 }, { inputAttemptsUsed: 0 }, { nextStep: 0 }, { totalSteps: 2 }]) {
    const altered = structuredClone(next); Object.assign(altered.computerContinuations![1]!, change);
    assert.equal(continuationTransitionError(prior, altered), 'computer_continuation_lineage_changed', JSON.stringify(change));
  }
});

for (const adapter of ['memory', ...adapters] as const) {
  test(`${adapter}: continuation CAS admits one sibling, preserves its receipt on retry and rejects history edits atomically`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'computer-continuation-contract-'));
    const store = adapter === 'memory' ? new MemoryStateRepository() : openRepository(adapter, directory);
    t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
    const prior = base(); assert.equal((await store.commit(command(prior, 'accept'))).kind, 'committed');
    const a = reservation(prior, 'continue', 'child-a'); const b = reservation(prior, 'continue', 'child-b');
    const first = command(a, 'claim-a'); const second = command(b, 'claim-b');
    const outcomes = await Promise.all([store.commit(first), store.commit(second)]);
    assert.deepEqual(outcomes.map(value => value.kind).sort(), ['committed', 'conflict']);
    const committed = outcomes.findIndex(value => value.kind === 'committed'); const request = committed === 0 ? first : second;
    assert.equal((await store.commit(request)).kind, 'duplicate');
    const current = (await store.get(prior.id))!; assert.equal(current.computerContinuations!.length, 1);
    assert.equal(current.attempts.length, 2); assert.equal(current.budget.reservedToolCalls, 1); assert.deepEqual(current.attempts[0], prior.attempts[0]);
    const before = await snapshot(store, prior.id, ['accept', 'claim-a', 'claim-b', 'remove', 'rewrite', 'sibling']);
    const removed = advance(current); delete removed.computerContinuations;
    await assert.rejects(store.commit(command(removed, 'remove')), /computer_continuation_history_removed/);
    const changed = advance(current); changed.attempts[0]!.resultArtifact = ref('replacement');
    await assert.rejects(store.commit(command(changed, 'rewrite')), /computer_continuation_source_changed/);
    const sibling = advance(current); sibling.computerContinuations!.push({ ...sibling.computerContinuations![0]!, successorAttemptId: 'sibling' });
    await assert.rejects(store.commit(command(sibling, 'sibling')));
    assert.deepEqual(await snapshot(store, prior.id, ['accept', 'claim-a', 'claim-b', 'remove', 'rewrite', 'sibling']), before);
    assert.doesNotThrow(() => validateStateTransition(current, advance(current)));
    if (adapter !== 'memory') {
      const reopened = openRepository(adapter, directory);
      try { assert.deepEqual(await snapshot(reopened, prior.id, ['accept', request.commandId]), await snapshot(store, prior.id, ['accept', request.commandId])); }
      finally { await reopened.close(); }
    }
  });
}
