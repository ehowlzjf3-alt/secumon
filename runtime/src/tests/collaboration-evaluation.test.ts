import test from 'node:test';
import assert from 'node:assert/strict';
import type { CollaborationTrial } from '../application/collaboration-evaluation.js';
import { compareCollaboration, runCollaborationComparison } from '../application/collaboration-evaluation.js';
import type { BudgetGrant, BudgetVector } from '../domain/budget-delegation.js';
import type { WorkState } from '../domain/model.js';
import { artifact, attempt, initial, modelCall } from './state-conformance-helpers.js';

// Recorded fixture ledgers only. No model, transport, live participant discovery or deployment quality is exercised here.
function charged(id: string, used: BudgetVector = { toolCalls: 0, modelCalls: 0, tokens: 0, replans: 0 }): WorkState {
  const state = initial(id); Object.assign(state.budget.used, used);
  state.attempts = Array.from({ length: used.toolCalls }, (_, index) => ({ ...attempt('succeeded'), id: 'tool-' + index,
    taskId: 'task-' + index, resultId: 'result-' + index, adopted: true }));
  state.modelCalls = Array.from({ length: used.modelCalls }, (_, index) => ({ ...modelCall('accepted'), id: 'model-' + index,
    usageStatus: 'reported' as const, inputTokens: index ? 0 : used.tokens, outputTokens: 0, replyArtifact: artifact(), outcome: 'ok' as const }));
  return state;
}
function trial(id = 'single', wallElapsedMs = 10): CollaborationTrial {
  const state = charged('primary'); state.status = 'completed'; state.statusReason = 'criteria_verified';
  state.evidence = [{ id: 'original', tenantId: state.policy.tenantId, scope: state.goal.scope, sourceId: 'source', lineageId: 'lineage',
    locator: 'fixture://original', observedAt: 900, recordedAt: 950, labels: ['synthetic'], coverage: 'complete', status: 'accepted',
    supersedes: [], derivedFrom: [], facts: { available: true }, artifact: null }];
  return { primary: { case: { id, family: 'observation_review', fixtureId: 'collaboration-ledger-fixture', backend: 'sqlite', mode: 'auto', variant: 'simple',
    oracle: { expectedFinal: 'complete', completionEligible: true, requiredEvidenceIds: ['original'],
      originals: [{ id: 'original', sourceId: 'source', lineageId: 'lineage', observedAt: 900 }], facts: { available: true },
      finalHypothesis: null, forbiddenEvidenceIds: [], noCompletionBefore: null } },
    observations: [{ at: 1000, stage: 'recorded-final', state, eventTypes: [], deliveries: [] }], entries: [],
    finalControl: 'complete', startedAt: 1000, finishedAt: 1000, wallElapsedMs, runError: null },
    participants: [], participantInventoryComplete: true };
}
const final = (value: CollaborationTrial) => value.primary.observations.at(-1)!.state;
function useCharges(value: CollaborationTrial, used: BudgetVector) {
  const current = final(value), source = charged(current.id, used);
  current.budget = source.budget; current.attempts = source.attempts; current.modelCalls = source.modelCalls;
}
function grant(parent: WorkState, child: WorkState): BudgetGrant {
  const { unmeasuredModelCalls: _unknown, ...accounted } = child.budget.used;
  return { id: 'grant', childWorkId: child.id, parentGoalRevision: parent.goal.revision, childScope: child.goal.scope,
    childAddress: { tenantId: child.policy.tenantId, principalId: child.policy.principalId, scope: child.goal.scope, workId: child.id },
    childPolicyDigest: 'a'.repeat(64), allocated: { ...accounted }, accounted: { ...accounted },
    reserved: { toolCalls: 0, modelCalls: 0, tokens: 0, replans: 0 }, deadlineAt: child.deadlineAt,
    status: 'settled', unmeasuredModelCalls: 0, childStateRevision: child.revision };
}

test('collaboration evaluation: both arms must use the same fixture, mode and oracle; participant agreement cannot replace original truth', () => {
  const single = trial('single-case'), collaborative = trial('collaborative-case', 25);
  const matching = compareCollaboration(single, collaborative);
  assert.equal(matching.single.score.contractPassed, true); assert.equal(matching.collaborative.score.goalCompleted, true);
  assert.equal(matching.interpretation.scope, 'recorded_trial_only');
  assert.equal(matching.interpretation.addedVerifiedCompletion, false);
  assert.deepEqual(matching.delta, { toolCalls: 0, modelCalls: 0, tokens: 0, wallElapsedMs: 15 });
  for (const fault of ['fixture', 'mode', 'oracle'] as const) {
    const other = structuredClone(collaborative);
    if (fault === 'fixture') other.primary.case.fixtureId = 'another-question';
    if (fault === 'mode') other.primary.case.mode = 'deep';
    if (fault === 'oracle') other.primary.case.oracle.facts['available'] = false;
    assert.throws(() => compareCollaboration(single, other), /collaboration_evaluation_case_mismatch/, fault);
  }
  final(collaborative).evidence[0]!.facts['available'] = false;
  collaborative.participants = [{ ...structuredClone(final(single)), id: 'agreeing-peer-one' },
    { ...structuredClone(final(single)), id: 'agreeing-peer-two' }];
  const unsupported = compareCollaboration(single, collaborative);
  assert.equal(unsupported.collaborative.score.goalCompleted, false);
  assert.equal(unsupported.collaborative.score.contractPassed, false);
  assert.equal(unsupported.interpretation.addedVerifiedCompletion, false);
  assert.equal(unsupported.interpretation.scope, 'recorded_trial_only');
  const corrected = compareCollaboration(collaborative, single);
  assert.equal(corrected.interpretation.addedVerifiedCompletion, true);
  assert.equal(corrected.interpretation.eliminatedContractFailure, true);
});

test('collaboration evaluation: original local usage is summed once without recounting sponsor grant snapshots', () => {
  const single = trial(), collaborative = trial('collaborative', 17);
  useCharges(single, { toolCalls: 1, modelCalls: 1, tokens: 20, replans: 1 });
  useCharges(collaborative, { toolCalls: 2, modelCalls: 2, tokens: 50, replans: 2 });
  const sponsor = final(collaborative), child = charged('recipient', { toolCalls: 3, modelCalls: 1, tokens: 30, replans: 1 });
  child.goal.scope = 'recipient-scope'; child.policy.principalId = 'recipient-owner';
  sponsor.budgetGrants = [grant(sponsor, child)];
  child.budgetParent = { parentWorkId: sponsor.id, grantId: 'grant', phase: 'active', parentAddress: {
    tenantId: sponsor.policy.tenantId, principalId: sponsor.policy.principalId, scope: sponsor.goal.scope, workId: sponsor.id } };
  collaborative.participants = [structuredClone(sponsor), child, structuredClone(child)];
  const before = structuredClone({ single, collaborative }), report = compareCollaboration(single, collaborative);
  assert.equal(report.single.score.contractPassed, true); assert.equal(report.collaborative.score.contractPassed, true);
  assert.equal(report.single.participatingWorks, 1); assert.equal(report.collaborative.participatingWorks, 2);
  assert.deepEqual(report.collaborative.usage, { toolCalls: 5, modelCalls: 3, tokens: 80, replans: 3, unmeasuredModelCalls: 0 });
  assert.deepEqual(report.delta, { toolCalls: 4, modelCalls: 2, tokens: 60, wallElapsedMs: 7 });
  assert.equal(report.interpretation.comparableCost, true);
  assert.deepEqual({ single, collaborative }, before, 'reporting cannot change original ledgers or grants');
});

test('collaboration evaluation: owner and scope separate equal work IDs; duplicate or conflicting snapshots are not extra participants', () => {
  const single = trial(), collaborative = trial('collaborative'), base = final(collaborative);
  const differentTenant = structuredClone(base); differentTenant.policy.tenantId = 'another-tenant';
  const differentPrincipal = structuredClone(base); differentPrincipal.policy.principalId = 'another-principal';
  const differentScope = structuredClone(base); differentScope.goal.scope = 'another-agent-scope';
  const reordered = structuredClone(differentScope), used = reordered.budget.used;
  reordered.budget.used = { unmeasuredModelCalls: used.unmeasuredModelCalls, replans: used.replans, tokens: used.tokens,
    modelCalls: used.modelCalls, toolCalls: used.toolCalls };
  assert.notEqual(JSON.stringify(reordered.budget), JSON.stringify(differentScope.budget));
  collaborative.participants = [structuredClone(base), differentTenant, differentPrincipal, differentScope, reordered];
  assert.equal(compareCollaboration(single, collaborative).collaborative.participatingWorks, 4);
  for (const fault of ['revision', 'budget', 'pending-history'] as const) {
    const first = charged('peer', { toolCalls: 1, modelCalls: 0, tokens: 0, replans: 0 });
    first.attempts[0]!.status = 'received';
    const conflict = structuredClone(first);
    if (fault === 'revision') conflict.revision++;
    if (fault === 'budget') conflict.budget.used.tokens++;
    if (fault === 'pending-history') conflict.attempts = [];
    const other = trial('conflict'); other.participants = [first, conflict];
    assert.throws(() => compareCollaboration(single, other), /collaboration_evaluation_conflicting_snapshot/, fault);
  }
});

test('collaboration evaluation: an incomplete inventory, unfinished operation or unknown usage withholds cost comparability', () => {
  const single = trial(), missing = trial('missing-participant'); missing.participantInventoryComplete = false;
  assert.equal(compareCollaboration(single, missing).collaborative.usageComplete, false);
  assert.equal(compareCollaboration(single, missing).interpretation.comparableCost, false);
  assert.equal(compareCollaboration(missing, single).interpretation.comparableCost, false);
  for (const kind of ['reserved-tool', 'received-tool', 'received-model', 'unknown-model'] as const) {
    const other = trial(kind), child = charged('unfinished-peer');
    if (kind === 'reserved-tool') { child.attempts = [attempt('reserved')]; child.budget.reservedToolCalls = 1; }
    if (kind === 'received-tool') { child.attempts = [attempt('received')]; child.budget.used.toolCalls = 1; }
    if (kind === 'received-model') {
      const call = modelCall('received'); call.usageStatus = 'reported'; call.inputTokens = 7; call.outputTokens = 3; call.replyArtifact = artifact();
      child.modelCalls = [call]; child.budget.used.modelCalls = 1; child.budget.used.tokens = 10;
    }
    if (kind === 'unknown-model') {
      const call = modelCall('unknown'); call.usageStatus = 'unknown'; child.modelCalls = [call];
      child.budget.used.modelCalls = 1; child.budget.used.unmeasuredModelCalls = 1; child.budget.reservedTokens = call.tokenReservation;
    }
    other.participants = [child]; const report = compareCollaboration(single, other);
    assert.equal(report.collaborative.participatingWorks, 2);
    assert.equal(report.collaborative.usageComplete, false, kind); assert.equal(report.interpretation.comparableCost, false, kind);
    assert.equal(report.collaborative.usage.unmeasuredModelCalls, kind === 'unknown-model' ? 1 : 0);
    assert.equal(report.interpretation.scope, 'recorded_trial_only');
  }
});

test('collaboration evaluation: invalid or overflowing participant usage is rejected instead of producing a numeric cost comparison', () => {
  for (const amount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const other = trial('invalid'), child = charged('peer'); child.budget.used.tokens = amount; other.participants = [child];
    assert.throws(() => compareCollaboration(trial(), other), /collaboration_evaluation_invalid_usage/);
  }
  const other = trial('overflow'), first = charged('first-peer'), second = charged('second-peer');
  first.budget.used.tokens = Number.MAX_SAFE_INTEGER; second.budget.used.tokens = 1; other.participants = [first, second];
  assert.throws(() => compareCollaboration(trial(), other), /collaboration_evaluation_invalid_usage/);
});

test('collaboration evaluation: the optional runner executes each arm once and stops at every abort boundary', async () => {
  const live = new AbortController(), order: string[] = [];
  const report = await runCollaborationComparison(async (mode, signal) => {
    assert.equal(signal, live.signal); order.push(mode); return trial(mode);
  }, live.signal);
  assert.deepEqual(order, ['single', 'collaborative']); assert.equal(report.interpretation.scope, 'recorded_trial_only');
  for (const boundary of ['before-single', 'after-single', 'after-collaborative'] as const) {
    const controller = new AbortController(), calls: string[] = [], reason = new Error('stop-' + boundary);
    if (boundary === 'before-single') controller.abort(reason);
    await assert.rejects(runCollaborationComparison(async (mode, signal) => {
      assert.equal(signal, controller.signal); calls.push(mode);
      if (boundary === 'after-single' && mode === 'single' || boundary === 'after-collaborative' && mode === 'collaborative') controller.abort(reason);
      return trial(mode);
    }, controller.signal), error => error === reason);
    assert.deepEqual(calls, boundary === 'before-single' ? [] : boundary === 'after-single' ? ['single'] : ['single', 'collaborative']);
  }
});
