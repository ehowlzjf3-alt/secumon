import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerReconciliation } from '../domain/computer-reconciliation.js';
import { reconciliationTransitionError } from '../domain/computer-reconciliation.js';
import type { ArtifactRef, Attempt, ContextPacket, ToolExecution, WorkState } from '../domain/model.js';
import { ComputerReconciliationSchema, ComputerReconciliationsSchema, ContextPacketSchema, WorkStateSchema } from '../application/contracts.js';
import { validateStateTransition } from '../application/store-contract.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { adapters, advance, attempt, command, initial, openRepository, snapshot } from './state-conformance-helpers.js';

function ref(id: string): ArtifactRef {
  return { id, sha256: 'a'.repeat(64), byteLength: 10, mediaType: 'application/json', tenantId: 'tenant-a', labels: ['synthetic'] };
}
function execution(mode: ToolExecution['mode']): ToolExecution {
  return mode === 'invoked' ? { mode, implementationCalls: 1, usage: { transportCalls: 1, internalOperations: 1, imageBytes: 0, waitMs: 0 } } :
    mode === 'unreported' ? { mode, implementationCalls: null, usage: { transportCalls: null, internalOperations: null, imageBytes: null, waitMs: null } } :
    { mode, implementationCalls: 0, usage: { transportCalls: 0, internalOperations: 0, imageBytes: 0, waitMs: 0 } };
}
function record(): ComputerReconciliation {
  return { id: 'lookup-1', sourceAttemptId: 'attempt', obligationId: 'effect:attempt', sourceHead: ref('original-head'),
    sourceResultArtifact: ref('original-result'), requestArtifact: ref('request'), responseArtifact: null, proofArtifact: null,
    operationId: 'original-operation', stepIndex: 1, goalRevision: 1, policyDigest: 'b'.repeat(64), generation: 0,
    contractDigest: 'c'.repeat(64), driver: { id: 'synthetic-computer', version: '1' }, owner: 'lookup-worker', leaseUntil: 2000,
    createdAt: 1001, dispatchedAt: null, finishedAt: null, status: 'reserved', execution: execution('not_invoked'),
    reason: null, outcome: null, effectState: 'unknown' };
}
function running(): ComputerReconciliation {
  return { ...record(), status: 'running', dispatchedAt: 1002, execution: execution('unreported') };
}
function received(): ComputerReconciliation {
  return { ...running(), status: 'received', responseArtifact: ref('response'), finishedAt: 1003,
    execution: execution('invoked'), outcome: 'applied' };
}
function settled(): ComputerReconciliation {
  return { ...received(), status: 'settled', proofArtifact: ref('proof'), effectState: 'confirmed' };
}
function invalidated(): ComputerReconciliation {
  return { ...settled(), status: 'failed', reason: 'reconciliation_proof_unavailable' };
}
function state(value?: ComputerReconciliation): WorkState {
  const work = initial(); work.policy.allowWrites = true; work.policy.allowedTools = ['computer.act'];
  work.status = 'blocked'; work.statusReason = 'effect_unknown';
  work.attempts = [{ ...attempt('unknown'), toolId: 'computer.act', contractDigest: 'c'.repeat(64), effect: 'write', effectState: 'unknown',
    resultId: 'original-result-id', resultArtifact: ref('original-result'), finishedAt: 1000,
    computerUse: { head: ref('original-head'), phase: 'unknown', completedSteps: 1, pendingOperationId: 'original-operation' } }];
  work.obligations = [{ id: 'effect:attempt', kind: 'effect_reconciliation', reason: 'input_outcome_unknown', status: 'pending', wakeKey: null, dueAt: null }];
  work.artifacts = [ref('original-head'), ref('original-result')];
  if (value) {
    work.computerReconciliations = [structuredClone(value)];
    work.artifacts.push(value.requestArtifact, ...(value.responseArtifact ? [value.responseArtifact] : []), ...(value.proofArtifact ? [value.proofArtifact] : []));
  }
  return work;
}
function context(work: WorkState): ContextPacket {
  return { schemaVersion: 1, workId: work.id, stateRevision: work.revision, goal: work.goal, policy: work.policy, plan: work.plan,
    hypotheses: work.hypotheses, obligations: work.obligations, evidence: work.evidence, activeToolIds: [], purpose: 'assess',
    ...(work.computerReconciliations ? { computerReconciliations: work.computerReconciliations } : {}) };
}

test('computer reconciliation contract: optional index preserves legacy states and contexts without adding empty metadata', () => {
  const work = state();
  assert.equal(Object.hasOwn(WorkStateSchema.parse(work), 'computerReconciliations'), false);
  assert.equal(Object.hasOwn(ContextPacketSchema.parse(context(work)), 'computerReconciliations'), false);
  const next = structuredClone(work); next.obligations[0]!.status = 'satisfied';
  assert.doesNotThrow(() => validateStateTransition(work, next));
  const parsed = WorkStateSchema.parse(state(record()));
  parsed.computerReconciliations![0]!.driver.id = 'mutated-return';
  assert.equal(record().driver.id, 'synthetic-computer');
});

test('computer reconciliation contract: metadata remains strict and bounded without accepting raw action or duplicate ids', () => {
  for (const malformed of [
    { ...record(), action: { kind: 'fill', value: 'RAW_INPUT' } }, { ...record(), driver: { id: 'driver', version: '1', url: 'unregistered' } },
    { ...record(), stepIndex: 3 }, { ...record(), stepIndex: -1 }, { ...record(), generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...record(), goalRevision: 0 }, { ...record(), policyDigest: 'unbound' }, { ...record(), leaseUntil: 1000 },
    { ...running(), dispatchedAt: 2001 }, { ...received(), finishedAt: 1001 },
  ]) assert.equal(ComputerReconciliationSchema.safeParse(malformed).success, false);
  assert.equal(ComputerReconciliationsSchema.safeParse([record(), record()]).success, false);
  assert.equal(WorkStateSchema.safeParse({ ...state(), computerReconciliations: [record(), record()] }).success, false);
  assert.equal(ContextPacketSchema.safeParse({ ...context(state()), computerReconciliations: [record(), record()] }).success, false);
  const limit = Array.from({ length: 1000 }, (_, index) => ({ ...record(), id: `lookup-${index}` }));
  assert.equal(ComputerReconciliationsSchema.safeParse(limit).success, true);
  assert.equal(ComputerReconciliationsSchema.safeParse([...limit, { ...record(), id: 'overflow' }]).success, false);
});

test('computer reconciliation contract: received and settled require different proof stages and a timed response', () => {
  for (const value of [record(), running(), received(), settled(), invalidated(),
    { ...record(), status: 'failed', finishedAt: 1002, reason: 'not_dispatched' }]) assert.equal(ComputerReconciliationSchema.safeParse(value).success, true);
  for (const malformed of [
    { ...record(), responseArtifact: ref('response') }, { ...record(), dispatchedAt: 1002 }, { ...running(), finishedAt: 1003 },
    { ...received(), responseArtifact: null }, { ...received(), finishedAt: null }, { ...received(), proofArtifact: ref('proof') },
    { ...settled(), proofArtifact: null }, { ...settled(), outcome: 'unknown' }, { ...settled(), effectState: 'unknown' },
    { ...invalidated(), finishedAt: null }, { ...invalidated(), reason: null },
  ]) assert.equal(ComputerReconciliationSchema.safeParse(malformed).success, false);
});

test('computer reconciliation contract: lookup outcome does not erase an earlier applied prefix or invent a known absence', () => {
  assert.equal(ComputerReconciliationSchema.safeParse({ ...settled(), outcome: 'not_applied', effectState: 'confirmed' }).success, true);
  assert.equal(ComputerReconciliationSchema.safeParse({ ...settled(), outcome: 'not_applied', effectState: 'none' }).success, true);
  assert.equal(ComputerReconciliationSchema.safeParse({ ...received(), outcome: 'unknown' }).success, true);
  for (const malformed of [
    { ...settled(), outcome: 'applied', effectState: 'none' }, { ...received(), outcome: 'unknown', effectState: 'none' },
    { ...received(), outcome: null, effectState: 'confirmed' }, { ...invalidated(), responseArtifact: null },
  ]) assert.equal(ComputerReconciliationSchema.safeParse(malformed).success, false);
});

test('computer reconciliation transition: intent identity and the first response, proof, and timestamps cannot be replaced', () => {
  const changes: Partial<ComputerReconciliation>[] = [
    { sourceAttemptId: 'different' }, { obligationId: 'effect:different' }, { sourceHead: ref('replacement-head') },
    { sourceResultArtifact: null }, { requestArtifact: ref('replacement-request') }, { operationId: 'different-operation' },
    { stepIndex: 2 }, { goalRevision: 2 }, { policyDigest: 'd'.repeat(64) }, { generation: 1 },
    { contractDigest: 'd'.repeat(64) }, { driver: { id: 'replacement-driver', version: '1' } }, { owner: 'another-worker' },
    { leaseUntil: 3000 }, { createdAt: 1000 },
  ];
  for (const change of changes) assert.notEqual(reconciliationTransitionError(state(record()), state({ ...record(), ...change })), null);
  for (const change of [{ responseArtifact: null }, { responseArtifact: ref('other-response') }, { dispatchedAt: null }, { dispatchedAt: 1001 }, { finishedAt: 1004 }]) {
    assert.equal(reconciliationTransitionError(state(received()), state({ ...received(), ...change })), 'computer_reconciliation_history_changed');
  }
  for (const proofArtifact of [null, ref('other-proof')]) {
    assert.equal(reconciliationTransitionError(state(settled()), state({ ...settled(), proofArtifact })), 'computer_reconciliation_history_changed');
  }
});

test('computer reconciliation transition: new records cannot skip dispatch and existing records cannot disappear or restart', () => {
  assert.equal(reconciliationTransitionError(state(), state(record())), null);
  assert.equal(reconciliationTransitionError(state(), state(settled())), 'computer_reconciliation_initial_status');
  assert.equal(reconciliationTransitionError(state(record()), state()), 'computer_reconciliation_history_removed');
  assert.equal(reconciliationTransitionError(state(record()), { ...state(record()), computerReconciliations: [record(), record()] }), 'computer_reconciliation_duplicate');
  for (const [before, after] of [[record(), received()], [record(), settled()], [running(), settled()], [received(), running()], [settled(), received()], [invalidated(), record()]]) {
    assert.equal(reconciliationTransitionError(state(before), state(after)), 'computer_reconciliation_status_invalid');
  }
  const terminal = invalidated();
  assert.equal(reconciliationTransitionError(state(terminal), state({ ...terminal, reason: 'rewritten' })), 'computer_reconciliation_terminal_changed');
});

test('computer reconciliation transition: known claims remain historical even when the proof is invalidated', () => {
  assert.equal(reconciliationTransitionError(state(record()), state(running())), null);
  assert.equal(reconciliationTransitionError(state(running()), state(received())), null);
  assert.equal(reconciliationTransitionError(state(received()), state(settled())), null);
  assert.equal(reconciliationTransitionError(state(settled()), state(invalidated())), null);
  const unknown = { ...received(), outcome: 'unknown' as const };
  assert.equal(reconciliationTransitionError(state(unknown), state(settled())), null);
  assert.equal(reconciliationTransitionError(state(unknown), state({ ...invalidated(), proofArtifact: null })), 'computer_reconciliation_claim_changed');
  for (const change of [{ outcome: 'unknown' as const }, { outcome: 'not_applied' as const }, { effectState: 'unknown' as const }, { effectState: 'none' as const }]) {
    assert.equal(reconciliationTransitionError(state(settled()), state({ ...invalidated(), ...change })), 'computer_reconciliation_claim_changed');
  }
});

test('computer reconciliation transition: original task identity, result, and checkpoint remain fixed across late updates', () => {
  const changes: Partial<Attempt>[] = [
    { id: 'another' }, { taskId: 'another' }, { planRevision: 2 }, { goalRevision: 2 }, { toolId: 'another.act' }, { toolVersion: '2' },
    { inputDigest: 'another' }, { contractDigest: 'd'.repeat(64) }, { scope: 'another' }, { effect: 'read' },
    { resultId: 'late-result' }, { resultArtifact: null }, { resultArtifact: ref('late-result') },
    { computerUse: undefined }, { computerUse: { ...state().attempts[0]!.computerUse!, head: ref('late-head') } },
    { computerUse: { ...state().attempts[0]!.computerUse!, phase: 'complete', pendingOperationId: null } },
  ];
  for (const change of changes) {
    const next = state(record()); Object.assign(next.attempts[0]!, change);
    assert.equal(reconciliationTransitionError(state(record()), next), 'computer_reconciliation_source_changed');
    assert.equal(reconciliationTransitionError(state(), next), 'computer_reconciliation_source_changed');
  }
  const next = state(record()); next.attempts[0]!.status = 'cancelled'; next.attempts[0]!.leaseUntil = 1000;
  assert.equal(reconciliationTransitionError(state(record()), next), null);
  const late = state(record()); late.attempts[0]!.resultId = null; late.attempts[0]!.resultArtifact = null;
  late.computerReconciliations![0]!.sourceResultArtifact = null;
  const receivedLate = structuredClone(late); receivedLate.attempts[0]!.resultId = 'late'; receivedLate.attempts[0]!.resultArtifact = ref('late');
  assert.equal(reconciliationTransitionError(late, receivedLate), 'computer_reconciliation_source_changed');
});

for (const adapter of ['memory', ...adapters] as const) {
  test(`${adapter}: reconciliation CAS retains original results, rejects rollback atomically, and preserves historical receipts`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'computer-reconciliation-contract-'));
    const store = adapter === 'memory' ? new MemoryStateRepository() : openRepository(adapter, directory);
    t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
    let current = state(); assert.equal((await store.commit(command(current, 'accept'))).kind, 'committed');
    const original = structuredClone(current.attempts[0]);
    const ids = ['accept'];
    for (const value of [record(), running(), received(), settled(), invalidated()]) {
      const next = advance(current); next.computerReconciliations = [value]; next.artifacts = state(value).artifacts;
      const id = value.status; const request = command(next, id);
      assert.equal((await store.commit(request)).kind, 'committed'); ids.push(id); current = next;
      assert.deepEqual((await store.get(current.id))!.attempts[0], original);
      assert.deepEqual(await store.commit(request), { kind: 'duplicate', state: next });
    }
    const before = await snapshot(store, current.id, [...ids, 'rollback', 'rewrite', 'alter']);
    const removed = advance(current); delete removed.computerReconciliations;
    await assert.rejects(store.commit(command(removed, 'rollback')), /computer_reconciliation_history_removed/);
    const altered = advance(current); altered.attempts[0]!.resultArtifact = ref('replacement');
    await assert.rejects(store.commit(command(altered, 'rewrite')), /computer_reconciliation_source_changed/);
    const changed = advance(current); changed.computerReconciliations![0]!.responseArtifact = ref('replacement-response');
    await assert.rejects(store.commit(command(changed, 'alter')), /computer_reconciliation_history_changed/);
    assert.deepEqual(await snapshot(store, current.id, [...ids, 'rollback', 'rewrite', 'alter']), before);
    assert.equal((await store.receipt(current.id, 'received'))!.state.computerReconciliations![0]!.proofArtifact, null);
    assert.deepEqual((await store.receipt(current.id, 'settled'))!.state.computerReconciliations![0], settled());
    if (adapter !== 'memory') {
      const reopened = openRepository(adapter, directory);
      try { assert.deepEqual(await snapshot(reopened, current.id, ids), await snapshot(store, current.id, ids)); }
      finally { await reopened.close(); }
    }
  });
}
