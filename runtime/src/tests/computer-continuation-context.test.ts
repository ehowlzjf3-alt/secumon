import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComputerContinuationClaim } from '../domain/computer-continuation.js';
import type { ComputerCheckpointV2 } from '../domain/computer-use.js';
import type { ArtifactRef, Attempt, TaskSpec, WorkState } from '../domain/model.js';
import type { ArtifactStore, Tool } from '../application/ports.js';
import { ContextCompiler } from '../application/context-compiler.js';
import { ContextRecovery } from '../application/context-recovery.js';
import { refreshEffectProofs } from '../application/effect-proofs.js';
import { buildContextPacket, computerContinuationContext, computerContinuationOriginalRefs } from '../application/context-packet.js';
import { ComputerCheckpointSchema, ComputerCheckpointV2Schema, ComputerObservationRecordSchema } from '../application/computer-use-contracts.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { toolExecution } from '../application/tool-execution-usage.js';
import { asJson, taskDigest } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { ScriptedPlanner } from '../infrastructure/fakes.js';
import { SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { computerActor, computerActInput, computerHarness, computerResult, mutateComputer, observeComputer, saveNoteSteps,
  submitComputerTask, type ComputerBackend, type ComputerHarness } from './computer-use-helpers.js';

const limits = { callId: 'continuation-context', maxOutputTokens: 100, maxInputBytes: 200000, maxInputTokens: 1000000, forceCompact: true };
const rawAction = 'SYNTHETIC_PARENT_ACTION_CONTEXT_CANARY';

/** Contract-seeded claim and test-only proof reader; these tests never invoke a production continuation runner. */
async function fixture(t: TestContext, backend: ComputerBackend) {
  let current = await computerHarness(backend); const directory = current.directory;
  t.after(async () => { await current.close(false); await rm(directory, { recursive: true, force: true }); });
  const h = current; assert.ok(h.driver instanceof SyntheticComputerDriver); let adapterCalls = 0;
  const continuation: Tool = { definition: { provider: 'fixture', id: 'fixture.continue', version: '1', description: 'Continuation metadata fixture; never executes',
    effect: 'write', destination: 'local', labels: ['public'], computerContinuation: 'continue', resultValidation: 'artifact-proof-v1',
    inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' } },
    execute: async () => { adapterCalls++; throw new Error('context_fixture_must_not_execute'); }, validateResult: async () => false };
  await mutateComputer(h, state => { state.policy.allowedTools.push('fixture.continue'); });
  const legacy = await h.runtime.state(h.workId); assert.equal(Object.hasOwn(buildContextPacket(legacy, h.contracts), 'computerContinuations'), false);
  assert.equal(Object.hasOwn((await h.recovery.restore(h.workId, computerActor)).packet.runtime, 'computerContinuations'), false);
  const observed = await observeComputer(h);
  const steps = structuredClone(saveNoteSteps); steps[0]!.action = { kind: 'fill', target: { role: 'textbox', name: 'Note' }, value: rawAction };
  steps[0]!.condition = { kind: 'element_value', target: { role: 'textbox', name: 'Note' }, value: rawAction };
  h.driver.injectNextAction({}); h.driver.injectNextAction({ outcome: 'not_applied_timeout' });
  const attempt = await submitComputerTask(h, 'act', computerActInput(observed.observationId, steps));
  await h.runtime.execute(h.workId, attempt.id); await h.runtime.settlePending(attempt.id); await h.runtime.adopt(h.workId, attempt.id);
  const original = await h.runtime.state(h.workId); const parent = original.attempts.find(value => value.id === attempt.id)!;
  assert.equal(parent.status, 'partial'); assert.equal(parent.effectState, 'confirmed'); assert.ok(parent.computerUse); assert.ok(parent.resultArtifact);
  const checkpoint = ComputerCheckpointSchema.parse(JSON.parse(new TextDecoder().decode(await h.artifacts.get(parent.computerUse.head, original.policy))));
  assert.ok(checkpoint.schemaVersion === 2); assert.deepEqual(checkpoint.steps.map(step => step.status), ['applied', 'not_applied']);
  const result = await computerResult(h, parent.id); assert.deepEqual(result.evidence, []);
  const refs = [...new Map([parent.computerUse.head, parent.resultArtifact, checkpoint.initialObservation, checkpoint.latestObservation,
    ...checkpoint.steps.flatMap(step => [step.before, ...(step.after ? [step.after] : [])]),
    ...(checkpoint.entryObservation ? [checkpoint.entryObservation] : []), ...result.artifacts].map(ref => [ref.id, ref])).values()];
  const hash = (value: unknown) => h.services.digester.digest(asJson(value));
  const task: TaskSpec = { id: 'fixture-successor-task', toolId: continuation.definition.id, toolVersion: '1', description: 'Preserve a claimed successor',
    input: {}, dependsOn: [], effect: 'write', maxAttempts: 1, satisfies: [],
    computerResume: { attemptId: parent.id, checkpointId: parent.computerUse.head.id, reconciliation: null } };
  const planRevision = (original.plan?.revision ?? 0) + 1;
  const child: Attempt = { id: 'fixture-successor', taskId: task.id, planRevision, goalRevision: original.goal.revision,
    toolId: task.toolId, toolVersion: task.toolVersion, inputDigest: taskDigest(task, h.services.digester), contractDigest: hash(continuation.definition),
    scope: original.goal.scope, effect: 'write', effectState: 'none', status: 'reserved', owner: 'context-fixture', leaseUntil: original.deadlineAt,
    startedAt: h.clock.now(), finishedAt: null, resultId: null, resultArtifact: null, adopted: false, error: null, execution: toolExecution('not_invoked') };
  const claim: ComputerContinuationClaim = { sourceAttemptId: parent.id, sourceHead: parent.computerUse.head, sourceResultArtifact: parent.resultArtifact,
    successorAttemptId: child.id, successorTaskDigest: child.inputDigest, mode: 'continue', reconciliation: null, rootAttemptId: parent.id,
    sourceContractDigest: parent.contractDigest!, contractDigest: child.contractDigest!, goalRevision: original.goal.revision, scope: original.goal.scope,
    policyDigest: hash(original.policy), generation: 0, createdAt: h.clock.now(), actionDeadlineAt: checkpoint.lineage.actionDeadlineAt,
    maxObservations: checkpoint.lineage.maxObservations, maxInputAttempts: checkpoint.lineage.maxInputAttempts,
    maxSuccessors: checkpoint.lineage.maxSuccessors, depth: 1, observationsUsed: checkpoint.lineage.observationsUsed,
    inputAttemptsUsed: checkpoint.lineage.inputAttemptsUsed, nextStep: 1, totalSteps: 2 };
  await transact(h.services, h.workId, 'fixture-claim', 'fixture_claim_stored', {}, state => {
    state.plan = { revision: planRevision, goalRevision: state.goal.revision, reason: 'Stored contract fixture, not an enabled runner', tasks: [task] };
    state.attempts.push(child); state.computerContinuations = [claim]; state.budget.reservedToolCalls++;
    state.obligations.push({ id: 'inspect-before-resume', kind: 'response', reason: 'Review the preserved successor', status: 'pending', wakeKey: null, dueAt: null });
  });
  const compose = (value: ComputerHarness) => {
    const contracts = new ToolContracts([...value.services.tools, continuation], new AjvSchemas());
    const services = { ...value.services, effects: {
      // Authenticates only this fixture's parent refs, not successor eligibility, child artifacts or effects.
      current: async (state: WorkState) => {
        if (hash(state.computerContinuations) !== hash([claim]) || state.goal.revision !== claim.goalRevision || state.goal.scope !== claim.scope ||
          hash(state.policy) !== claim.policyDigest || (state.dataLifecycle?.generation ?? 0) !== claim.generation) return false;
        try {
          for (const ref of refs) {
            if (state.dataLifecycle?.blockedArtifactIds.includes(ref.id)) return false;
            await value.artifacts.get(ref, state.policy);
          }
          return (await value.state.get(value.workId))?.revision === state.revision;
        } catch { return false; }
      }, refresh: async () => (await value.state.get(value.workId))!,
    } };
    return { services, contracts, compiler: new ContextCompiler(services, contracts, value.guidance), recovery: new ContextRecovery(services, contracts) };
  };
  return { h, claim, parent, checkpoint, refs, directory, ...compose(h), adapterCalls: () => adapterCalls,
    async reopen() { await current.close(false); current = await computerHarness(backend, { directory }); return { h: current, ...compose(current) }; } };
}

function assertNoInputs(h: ComputerHarness) {
  assert.ok(h.driver instanceof SyntheticComputerDriver); assert.equal(h.driver.snapshot().inputCount, 1); assert.equal(h.driver.snapshot().saveCount, 0);
  assert.ok(h.services.planner instanceof ScriptedPlanner); assert.equal(h.services.planner.inputs.length, 0);
}

/** Stores a v2 child diagnostic fixture without executing, authorizing or certifying a successor action. */
async function childCheckpoint(f: Awaited<ReturnType<typeof fixture>>) {
  const state = await f.h.runtime.state(f.h.workId); const child = state.attempts.find(attempt => attempt.id === f.claim.successorAttemptId)!;
  const original = ComputerObservationRecordSchema.parse(JSON.parse(new TextDecoder().decode(await f.h.artifacts.get(f.checkpoint.latestObservation, state.policy))));
  const store = (value: unknown) => f.h.artifacts.put(new TextEncoder().encode(JSON.stringify(value)),
    { tenantId: state.policy.tenantId, labels: ['public'], mediaType: 'application/json' });
  const observations: ArtifactRef[] = [];
  for (let n = 1; n <= 3; n++) {
    const observed = ComputerObservationRecordSchema.parse({ ...original, attemptId: child.id,
      view: { ...original.view, epoch: original.view.epoch + 1, observedAt: original.view.observedAt + n } });
    observations.push(await store(observed));
  }
  const [entry, inherited, latest] = observations as [ArtifactRef, ArtifactRef, ArtifactRef];
  const claim = f.claim;
  const checkpoint: ComputerCheckpointV2 = ComputerCheckpointV2Schema.parse({ ...f.checkpoint, attemptId: child.id,
    taskDigest: child.inputDigest, contractDigest: child.contractDigest, epoch: original.view.epoch + 1,
    initialObservation: f.checkpoint.latestObservation, entryObservation: entry, latestObservation: latest, steps: [], phase: 'partial',
    stopReason: 'fixture_paused_before_input', continuation: { claim, inheritedObservation: inherited },
    lineage: { rootAttemptId: claim.rootAttemptId, actionDeadlineAt: claim.actionDeadlineAt,
      maxObservations: claim.maxObservations, maxInputAttempts: claim.maxInputAttempts, maxSuccessors: claim.maxSuccessors,
      depth: claim.depth, observationsUsed: claim.observationsUsed + observations.length, inputAttemptsUsed: claim.inputAttemptsUsed },
    usage: { transportCalls: 0, internalOperations: 0, imageBytes: 0, waitMs: 0 } });
  const head = await store(checkpoint);
  await mutateComputer(f.h, next => {
    next.attempts.find(attempt => attempt.id === child.id)!.computerUse = { head, phase: 'partial', completedSteps: 0, pendingOperationId: null };
    next.artifacts.push(head);
  });
  return { checkpoint, head, entry, inherited, latest, store };
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`continuation context ${backend}: contract-seeded claim and latest parent originals survive five compactions and reopen`, async t => {
    const f = await fixture(t, backend); const before = await f.h.runtime.state(f.h.workId); const protectedDigests = new Set<string>();
    for (let cycle = 1; cycle <= 5; cycle++) {
      const state = await f.h.runtime.state(f.h.workId); const prepared = await f.compiler.prepare(state, { ...limits, callId: `claim-cycle-${cycle}` });
      assert.deepEqual(prepared.packet.computerContinuations, [f.claim]); assert.equal(prepared.frame.memo.cycle, cycle);
      assert.equal(prepared.packet.obligations.find(value => value.id === 'inspect-before-resume')!.status, 'pending');
      assert.equal(JSON.stringify(prepared.packet).includes(rawAction), false); assert.equal(prepared.frame.metrics.extraModelCalls, 0);
      assert.equal(await f.compiler.sourcesCurrent(prepared.packet, state), true); protectedDigests.add(prepared.frame.protectedDigest);
      const omitted = structuredClone(prepared.packet); delete omitted.computerContinuations;
      const rewritten = structuredClone(prepared.packet); rewritten.computerContinuations![0]!.nextStep = 0;
      assert.equal(await f.compiler.sourcesCurrent(omitted, state), false); assert.equal(await f.compiler.sourcesCurrent(rewritten, state), false);
      await transact(f.services, f.h.workId, `claim-compact-${cycle}`, 'context_compacted', {}, next => { next.contextHead = prepared.head; });
    }
    assert.equal(protectedDigests.size, 1); assertNoInputs(f.h); assert.equal(f.adapterCalls(), 0);
    const reopened = await f.reopen(); const state = await reopened.h.runtime.state(reopened.h.workId);
    assert.deepEqual(state.attempts, before.attempts); assert.deepEqual(state.obligations, before.obligations); assert.deepEqual(state.budget, before.budget);
    const prepared = await reopened.compiler.prepare(state, { ...limits, callId: 'reopened-claim' }); assert.equal(prepared.frame.memo.cycle, 6);
    const restored = await reopened.recovery.restore(state.id, computerActor);
    assert.deepEqual(restored.packet.context.computerContinuations, [f.claim]); assert.deepEqual(restored.packet.runtime.computerContinuations, [f.claim]);
    assert.equal(JSON.stringify(restored.packet).includes(rawAction), false);
    for (const ref of f.refs) assert.ok(restored.packet.runtime.artifacts.some(value => value.id === ref.id), ref.id);
    assert.equal((await reopened.recovery.restore(state.id, computerActor, restored.artifact)).disposition, 'reused');
    assert.deepEqual(await reopened.h.state.get(state.id), state); assertNoInputs(reopened.h); assert.equal(f.adapterCalls(), 0);
  });

  test(`continuation context ${backend}: a final v2 child preserves historical, entry and inherited observations through compact and reopen`, async t => {
    const f = await fixture(t, backend); const child = await childCheckpoint(f); const before = await f.h.runtime.state(f.h.workId);
    const original = await f.h.artifacts.get(child.head, before.policy);
    for (const ref of [child.entry, child.inherited, child.latest]) assert.equal(before.artifacts.some(value => value.id === ref.id), false);
    const expected = [...f.refs, child.head, child.entry, child.inherited, child.latest];
    for (let cycle = 1; cycle <= 3; cycle++) {
      const state = await f.h.runtime.state(f.h.workId); const prepared = await f.compiler.prepare(state, { ...limits, callId: `v2-child-${cycle}` });
      assert.equal(JSON.stringify(prepared.packet).includes(rawAction), false); assert.deepEqual(prepared.packet.computerContinuations, [f.claim]);
      assert.equal(await f.compiler.sourcesCurrent(prepared.packet, state), true);
      const refs = await computerContinuationOriginalRefs(state, ref => f.h.artifacts.get(ref, state.policy));
      for (const ref of expected) assert.deepEqual(refs.find(value => value.id === ref.id), ref);
      await transact(f.services, state.id, `v2-compact-${cycle}`, 'context_compacted', {}, next => { next.contextHead = prepared.head; });
    }
    const reopened = await f.reopen(); const state = await reopened.h.runtime.state(reopened.h.workId);
    const restored = await reopened.recovery.restore(state.id, computerActor);
    for (const ref of expected) assert.deepEqual(restored.packet.runtime.artifacts.find(value => value.id === ref.id), ref);
    assert.equal(JSON.stringify(restored.packet).includes(rawAction), false);
    assert.deepEqual(await reopened.h.artifacts.get(child.head, state.policy), original);
    assert.deepEqual(ComputerCheckpointV2Schema.parse(JSON.parse(new TextDecoder().decode(original))), child.checkpoint);
    assert.deepEqual(state.attempts, before.attempts); assert.deepEqual(state.budget, before.budget); assertNoInputs(reopened.h); assert.equal(f.adapterCalls(), 0);
  });

  for (const kind of ['entry', 'inherited'] as const) test(`continuation context ${backend}: missing v2 ${kind} reference invalidates an unchanged final child`, async t => {
    const f = await fixture(t, backend); const child = await childCheckpoint(f); const state = await f.h.runtime.state(f.h.workId);
    const prepared = await f.compiler.prepare(state, limits); await rm(join(f.directory, 'artifacts', `${child[kind].id}.blob`));
    assert.equal(await f.services.effects.current(state), true, 'the test checker authenticates only the parent; the context independently validates the child');
    assert.equal(await f.compiler.sourcesCurrent(prepared.packet, state), false);
    await assert.rejects(f.compiler.prepare(state, limits));
    await assert.rejects(f.recovery.restore(state.id, computerActor), /resume_computer_continuation_unavailable/);
    assert.deepEqual(await f.h.state.get(state.id), state); assertNoInputs(f.h); assert.equal(f.adapterCalls(), 0);
  });

  test(`continuation context ${backend}: v2 child rejects a forged canonical claim, unrelated initial basis and foreign observation owner`, async t => {
    const f = await fixture(t, backend); const child = await childCheckpoint(f); const state = await f.h.runtime.state(f.h.workId);
    const entry = ComputerObservationRecordSchema.parse(JSON.parse(new TextDecoder().decode(await f.h.artifacts.get(child.entry, state.policy))));
    const foreign = await child.store({ ...entry, attemptId: f.parent.id });
    const changes = [
      (value: ComputerCheckpointV2) => { value.continuation!.claim.sourceHead = f.claim.sourceResultArtifact!; },
      (value: ComputerCheckpointV2) => { value.initialObservation = f.checkpoint.initialObservation; },
      (value: ComputerCheckpointV2) => { value.entryObservation = foreign; },
    ];
    for (const change of changes) {
      const invalid = structuredClone(child.checkpoint); change(invalid); const head = await child.store(ComputerCheckpointV2Schema.parse(invalid));
      const changed = structuredClone(state); changed.attempts.find(attempt => attempt.id === f.claim.successorAttemptId)!.computerUse!.head = head;
      changed.artifacts.push(head);
      await assert.rejects(computerContinuationOriginalRefs(changed, ref => f.h.artifacts.get(ref, changed.policy)), /context_continuation_source_unavailable/);
    }
    assert.deepEqual(await f.h.state.get(state.id), state); assertNoInputs(f.h);
  });

  for (const kind of ['model_context', 'runtime_resume'] as const) test(`continuation context ${backend}: v2 inherited observation loss during ${kind} staging prevents return`, async t => {
    const f = await fixture(t, backend); const child = await childCheckpoint(f); const state = await f.h.runtime.state(f.h.workId); let deleted = false;
    const artifacts: ArtifactStore = { get: (...args) => f.h.artifacts.get(...args), exists: ref => f.h.artifacts.exists(ref), put: async (bytes, attributes) => {
      const result = await f.h.artifacts.put(bytes, attributes);
      if (!deleted && (JSON.parse(new TextDecoder().decode(bytes)) as { kind?: string }).kind === kind) {
        deleted = true; await rm(join(f.directory, 'artifacts', `${child.inherited.id}.blob`));
      }
      return result;
    } };
    const services = { ...f.services, artifacts };
    if (kind === 'model_context') await assert.rejects(new ContextCompiler(services, f.contracts, f.h.guidance).prepare(state, limits), /context_guidance_unavailable/);
    else await assert.rejects(new ContextRecovery(services, f.contracts).restore(state.id, computerActor), /resume_computer_checkpoint_unavailable/);
    assert.equal(deleted, true); assert.deepEqual(await f.h.state.get(state.id), state); assertNoInputs(f.h);
  });

  test(`continuation context ${backend}: late malformed parent receive cannot rewrite a claimed source`, async t => {
    const f = await fixture(t, backend); const state = await f.h.runtime.state(f.h.workId);
    const head = await f.h.artifacts.get(f.claim.sourceHead, state.policy);
    const result = await f.h.artifacts.get(f.claim.sourceResultArtifact!, state.policy);
    const returned = await f.h.runtime.receive(state.id, f.parent.id, { malformed: true, output: rawAction, effectState: 'none' });
    assert.deepEqual(returned, state); assert.deepEqual(await f.h.state.get(state.id), state);
    assert.deepEqual(await f.h.artifacts.get(f.claim.sourceHead, state.policy), head);
    assert.deepEqual(await f.h.artifacts.get(f.claim.sourceResultArtifact!, state.policy), result);
    assertNoInputs(f.h); assert.equal(f.adapterCalls(), 0);
  });

  for (const source of ['head', 'result', 'observation'] as const) test(`continuation context ${backend}: missing ${source} fences an otherwise unchanged claim`, async t => {
    const f = await fixture(t, backend); const state = await f.h.runtime.state(f.h.workId); const prepared = await f.compiler.prepare(state, limits);
    const ref = source === 'head' ? f.claim.sourceHead : source === 'result' ? f.claim.sourceResultArtifact! : f.refs.find(value => ![f.claim.sourceHead.id, f.claim.sourceResultArtifact!.id].includes(value.id))!;
    await rm(join(f.directory, 'artifacts', `${ref.id}.blob`)); assert.equal((await f.h.runtime.state(f.h.workId)).revision, state.revision);
    assert.equal(await f.compiler.sourcesCurrent(prepared.packet, state), false);
    await assert.rejects(f.compiler.prepare(state, limits), /context_state_changed/);
    await assert.rejects(f.recovery.restore(state.id, computerActor), /resume_effect_proof_changed/);
    assert.deepEqual(await f.h.state.get(state.id), state); assertNoInputs(f.h); assert.equal(f.adapterCalls(), 0);
  });

  test(`continuation context ${backend}: corrupt parent data and invalid bounded decode never produce a resume`, async t => {
    const f = await fixture(t, backend); const state = await f.h.runtime.state(f.h.workId);
    await assert.rejects(computerContinuationOriginalRefs(state, async ref => ref.id === f.claim.sourceHead.id ?
      new TextEncoder().encode('{}') : f.h.artifacts.get(ref, state.policy)), /context_continuation_source_unavailable/);
    const path = join(f.directory, 'artifacts', `${f.claim.sourceHead.id}.blob`); const bytes = await readFile(path); bytes[0] = 91; await writeFile(path, bytes);
    await assert.rejects(f.compiler.prepare(state, limits), /context_state_changed/);
    await assert.rejects(f.recovery.restore(state.id, computerActor), /resume_effect_proof_changed/); assertNoInputs(f.h);
  });

  for (const kind of ['model_context', 'runtime_resume'] as const) test(`continuation context ${backend}: original loss during ${kind} storage is checked before return`, async t => {
    const f = await fixture(t, backend); const state = await f.h.runtime.state(f.h.workId); let lost = false;
    const artifacts: ArtifactStore = { get: (...args) => f.h.artifacts.get(...args), exists: ref => f.h.artifacts.exists(ref), put: async (bytes, attributes) => {
      const ref = await f.h.artifacts.put(bytes, attributes);
      if (!lost && (JSON.parse(new TextDecoder().decode(bytes)) as { kind?: string }).kind === kind) {
        lost = true; await rm(join(f.directory, 'artifacts', `${f.claim.sourceResultArtifact!.id}.blob`));
      }
      return ref;
    } };
    const services = { ...f.services, artifacts };
    if (kind === 'model_context') await assert.rejects(new ContextCompiler(services, f.contracts, f.h.guidance).prepare(state, limits), /context_guidance_unavailable/);
    else await assert.rejects(new ContextRecovery(services, f.contracts).restore(state.id, computerActor), /resume_effect_proof_changed/);
    assert.equal(lost, true); assert.deepEqual(await f.h.state.get(state.id), state); assertNoInputs(f.h);
  });

  test(`continuation context ${backend}: visibility hides a claim while obligations remain and undeclared raw fields are discarded`, async t => {
    const f = await fixture(t, backend); const state = await f.h.runtime.state(f.h.workId);
    for (const change of [
      (next: WorkState) => { next.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] }; },
      (next: WorkState) => { next.dataLifecycle = { generation: 0, blockedArtifactIds: [f.claim.sourceHead.id], changes: [] }; },
      (next: WorkState) => { next.policy.allowedLabels = []; },
      (next: WorkState) => { next.policy.tenantId = 'another-tenant'; },
    ]) { const restricted = structuredClone(state); change(restricted); assert.deepEqual(computerContinuationContext(restricted), []); assert.deepEqual(restricted.obligations, state.obligations); }
    const extended = structuredClone(state); Object.assign(extended.computerContinuations![0]!, { action: { value: rawAction }, rawResponse: rawAction });
    assert.deepEqual(buildContextPacket(extended, f.contracts).computerContinuations, [f.claim]);
    assert.equal(JSON.stringify(buildContextPacket(extended, f.contracts)).includes(rawAction), false); assertNoInputs(f.h);
  });

  test(`continuation context ${backend}: unavailable continuation proof readers fail closed even without reconciliation records`, async t => {
    const f = await fixture(t, backend); const state = await f.h.runtime.state(f.h.workId);
    assert.equal(state.computerReconciliations?.length ?? 0, 0);
    const prepared = await f.compiler.prepare(state, limits);
    const services = { ...f.services, effects: undefined }; const compiler = new ContextCompiler(services, f.contracts, f.h.guidance);
    assert.equal(await compiler.sourcesCurrent(prepared.packet, state), false); await assert.rejects(compiler.prepare(state, limits), /context_state_changed/);
    await assert.rejects(new ContextRecovery(services, f.contracts).restore(state.id, computerActor), /resume_effect_proof_changed/);
    assert.equal(await f.h.services.effects!.current(state), false, 'production composition cannot certify a contract-seeded fixture adapter');
    const refreshed = await f.h.services.effects!.refresh(state.id);
    assert.equal(refreshed.obligations.find(value => value.id === 'computer-continuations:proof')?.status, 'pending');
    assert.deepEqual(refreshed.attempts.find(value => value.id === f.parent.id), state.attempts.find(value => value.id === f.parent.id));
    assert.deepEqual(refreshed.evidence, state.evidence); assert.deepEqual(refreshed.computerContinuations, state.computerContinuations);
    await assert.rejects(refreshEffectProofs({ ...f.h.services, effects: undefined }, state.id), /computer_continuation_proof_unavailable/);
    assert.deepEqual(await f.h.state.get(state.id), refreshed);
    assertNoInputs(f.h); assert.equal(f.adapterCalls(), 0);
  });
}
