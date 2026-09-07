import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactRef, TaskSpec } from '../domain/model.js';
import type { ComputerCheckpoint, ComputerCheckpointV2 } from '../domain/computer-use.js';
import type { CommitRequest, StateRepository } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { ComputerContinuations } from '../application/computer-continuations.js';
import { prepareComputerBinding, type ComputerUse } from '../application/computer-use.js';
import { SyntheticComputerClock, SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { computerActInput, computerHarness, mutateComputer, observeComputer, saveNoteSteps, submitComputerTask, type ComputerBackend } from './computer-use-helpers.js';

async function fixture(t: TestContext, backend: ComputerBackend) {
  const clock = new SyntheticComputerClock(1000); const denied = new Set<string>(); let gets = 0;
  const h = await computerHarness(backend, { clock, store: backing => new Proxy(backing, {
    get(target, key) {
      if (key === 'commit') return async (input: CommitRequest) => {
        const request = structuredClone(input);
        if (request.expectedRevision === 0) request.next.policy.allowedTools.push('synthetic.ui.continue', 'synthetic.ui.verify');
        return target.commit(request);
      };
      const value: unknown = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    },
  }), artifacts: backing => ({ put: backing.put.bind(backing),
    async get(ref, policy) { gets++; if (denied.has(ref.id)) throw new Error('fixture_original_missing'); return backing.get(ref, policy); },
    async exists(ref) { return !denied.has(ref.id) && backing.exists(ref); },
  }) });
  t.after(() => h.close());
  const driver = h.driver as SyntheticComputerDriver; driver.injectNextAction({}); driver.injectNextAction({ outcome: 'not_applied_timeout' });
  const observation = await observeComputer(h);
  const source = await submitComputerTask(h, 'act', computerActInput(observation.observationId, saveNoteSteps));
  await h.runtime.execute(h.workId, source.id); await h.runtime.settlePending(source.id); await h.runtime.adopt(h.workId, source.id);
  const state = await h.runtime.state(h.workId); const parent = state.attempts.find(attempt => attempt.id === source.id)!;
  assert.equal(parent.status, 'partial'); assert.ok(parent.computerUse); assert.ok(parent.resultArtifact);
  const verified = await h.computerUse.inspectCheckpoint(state, parent.id, parent.computerUse.head);
  assert.equal(verified.cp.schemaVersion, 2); const cp = verified.cp as ComputerCheckpointV2;
  assert.deepEqual(cp.steps.map(step => step.status), ['applied', 'not_applied']);
  const task: TaskSpec = { id: `continuation-${state.revision}`, toolId: 'synthetic.ui.continue', toolVersion: '1', description: 'Resume the original suffix',
    input: {}, dependsOn: [], effect: 'write', maxAttempts: 1, satisfies: ['saved'], computerResume: { attemptId: parent.id,
      checkpointId: parent.computerUse.head.id, reconciliation: null } };
  await h.runtime.submitPlan(h.workId, `continuation-plan-${state.revision}`, { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
    basePlanRevision: state.plan!.revision, reason: 'Explicit bounded continuation', tasks: [task], hypotheses: [] });
  const binding = prepareComputerBinding(h.binding); let interrupts = 0;
  const make = (services: RuntimeServices = h.services, computer: Pick<ComputerUse, 'inspectCheckpoint' | 'validateResult'> = h.computerUse) =>
    new ComputerContinuations(services, h.contracts, computer, h.computerReconciliations, [binding], () => { interrupts++; });
  return { h, task, cp, parent, driver, denied, make, service: make(), gets: () => gets, interrupts: () => interrupts };
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: continuation prepare pins only the unperformed suffix and preserves canonical state and driver input`, async t => {
    const f = await fixture(t, backend); const state = await f.h.runtime.state(f.h.workId); const app = f.driver.snapshot();
    const claim = await f.service.prepare(state, f.task, 'candidate');
    assert.equal(claim.nextStep, 1); assert.equal(claim.totalSteps, 2); assert.equal(claim.depth, 1);
    assert.equal(claim.rootAttemptId, f.parent.id); assert.equal(claim.actionDeadlineAt, f.cp.lineage.actionDeadlineAt);
    assert.equal(claim.observationsUsed, f.cp.lineage.observationsUsed); assert.equal(claim.inputAttemptsUsed, f.cp.lineage.inputAttemptsUsed);
    assert.deepEqual(claim.sourceHead, f.parent.computerUse!.head); assert.deepEqual(claim.sourceResultArtifact, f.parent.resultArtifact);
    assert.deepEqual(await f.h.runtime.state(f.h.workId), state); assert.deepEqual(f.driver.snapshot(), app);
    const forged = structuredClone(state); forged.policy.allowedTools = ['synthetic.ui.continue'];
    await assert.rejects(f.service.prepare(forged, f.task, 'foreign-view'), /computer_continuation_state_changed/);
    await assert.rejects(f.service.prepare(state, { ...f.task, input: { steps: [] } }, 'caller-steps'), /computer_continuation_not_ready|computer_continuation_task_invalid/);
    const changed = structuredClone(f.task); changed.computerResume!.checkpointId = 'different-head';
    await assert.rejects(f.service.prepare(state, changed, 'different-head'), /computer_continuation_not_ready|computer_continuation_source_not_ready/);
  });

  test(`${backend}: continuation prepare refuses legacy checkpoint counters without upgrading or resetting the original deadline`, async t => {
    const f = await fixture(t, backend); let reads = 0;
    const legacy = f.make(f.h.services, {
      async inspectCheckpoint(...args) {
        reads++; const value = await f.h.computerUse.inspectCheckpoint(...args);
        const { lineage: _lineage, entryObservation: _entry, continuation: _continuation, ...old } = value.cp as ComputerCheckpointV2;
        return { ...value, cp: { ...old, schemaVersion: 1 } as ComputerCheckpoint };
      },
      validateResult: f.h.computerUse.validateResult.bind(f.h.computerUse),
    });
    const state = await f.h.runtime.state(f.h.workId);
    await assert.rejects(legacy.prepare(state, f.task, 'legacy'), /computer_continuation_legacy_checkpoint/); assert.equal(reads, 1);
    f.h.clock.advance(Math.max(0, f.cp.lineage.actionDeadlineAt - f.h.clock.now()));
    await assert.rejects(f.service.prepare(state, f.task, 'expired'));
    assert.deepEqual(await f.h.runtime.state(f.h.workId), state);
  });

  test(`${backend}: continuation preparation rechecks canonical state after original checkpoint I/O`, async t => {
    const f = await fixture(t, backend); let changed = false;
    const racing = f.make(f.h.services, {
      async inspectCheckpoint(...args) {
        const value = await f.h.computerUse.inspectCheckpoint(...args);
        if (!changed) { changed = true; await mutateComputer(f.h, state => { state.status = 'paused'; state.statusReason = 'paused during proof read'; }); }
        return value;
      },
      validateResult: f.h.computerUse.validateResult.bind(f.h.computerUse),
    });
    const state = await f.h.runtime.state(f.h.workId); const app = f.driver.snapshot();
    await assert.rejects(racing.prepare(state, f.task, 'late'), /computer_continuation_state_changed|computer_continuation_result_unavailable/);
    assert.equal(changed, true); assert.equal((await f.h.runtime.state(f.h.workId)).computerContinuations?.length ?? 0, 0);
    assert.deepEqual(f.driver.snapshot(), app);
  });

  test(`${backend}: continuation resolve authenticates the canonical reservation receipt and never inspects the child's checkpoint`, async t => {
    const f = await fixture(t, backend); const child = await f.h.runtime.reserve(f.h.workId, f.task.id);
    const state = await f.h.runtime.state(f.h.workId); const visited: string[] = [];
    const service = f.make(f.h.services, {
      async inspectCheckpoint(current, attemptId, head) { visited.push(attemptId); assert.notEqual(attemptId, child.id); return f.h.computerUse.inspectCheckpoint(current, attemptId, head); },
      validateResult: f.h.computerUse.validateResult.bind(f.h.computerUse),
    });
    const resolved = await service.resolve(state, child.id);
    assert.deepEqual(resolved.rootInput.steps, saveNoteSteps); assert.equal(resolved.claim.successorAttemptId, child.id);
    assert.ok(visited.length > 0); assert.equal(resolved.claim.createdAt, child.startedAt);
    await assert.rejects(service.prepare(state, f.task, 'sibling'), /computer_continuation_successor_exists/);
    for (const corrupt of ['missing', 'digest', 'budget', 'task'] as const) {
      const store = new Proxy(f.h.state, { get(target, key) {
        if (key === 'receipt') return async (...args: Parameters<StateRepository['receipt']>) => {
          const receipt = await target.receipt(...args);
          if (args[1] !== `reserve:${child.id}` || !receipt) return receipt;
          if (corrupt === 'missing') return null;
          const copy = structuredClone(receipt);
          if (corrupt === 'digest') copy.digest = 'altered';
          if (corrupt === 'budget') copy.state.budget.reservedToolCalls = 0;
          if (corrupt === 'task') copy.state.plan!.tasks[0]!.computerResume!.checkpointId = 'altered';
          return copy;
        };
        const value: unknown = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      await assert.rejects(f.make({ ...f.h.services, state: store }).resolve(state, child.id), /computer_continuation_reservation_unproven/);
    }
    assert.deepEqual(await f.h.runtime.state(f.h.workId), state);
  });

  test(`${backend}: invalid claim graph is rejected before recursive original reads and raw proof checks never call knowledge`, async t => {
    const f = await fixture(t, backend); const child = await f.h.runtime.reserve(f.h.workId, f.task.id); const state = await f.h.runtime.state(f.h.workId);
    let knowledge = 0;
    f.h.services.knowledge = { async validate() { knowledge++; throw new Error('unexpected_knowledge_recursion'); } };
    const service = f.make();
    assert.equal(await service.current(state), true); assert.equal(knowledge, 0);
    const corrupt = structuredClone(state); corrupt.computerContinuations![0]!.depth = 2;
    const before = f.gets(); await assert.rejects(service.resolve(corrupt, child.id), /computer_continuation_graph_invalid/);
    assert.equal(f.gets(), before); assert.equal(await service.current(corrupt), false); assert.equal(knowledge, 0);
  });

  test(`${backend}: missing originals install a durable blocking obligation, cancel reservations, and recover without rewriting claims`, async t => {
    const f = await fixture(t, backend); const child = await f.h.runtime.reserve(f.h.workId, f.task.id);
    await mutateComputer(f.h, state => { state.obligations.push({ id: 'unrelated', kind: 'response', reason: 'Await a separate user answer', status: 'pending', wakeKey: null, dueAt: null }); });
    const before = await f.h.runtime.state(f.h.workId); const claims = structuredClone(before.computerContinuations);
    const app = f.driver.snapshot(); const head: ArtifactRef = f.parent.computerUse!.head;
    f.denied.add(head.id); assert.equal(await f.service.current(before), false);
    const blocked = await f.service.refresh(f.h.workId);
    assert.equal(blocked.obligations.find(value => value.id === 'computer-continuations:proof')!.status, 'pending');
    assert.equal(blocked.attempts.find(value => value.id === child.id)!.status, 'cancelled');
    assert.equal(blocked.budget.reservedToolCalls, before.budget.reservedToolCalls - 1); assert.ok(f.interrupts() > 0);
    assert.deepEqual(blocked.computerContinuations, claims); assert.deepEqual(blocked.attempts.find(value => value.id === f.parent.id), f.parent);
    assert.deepEqual(await f.service.refresh(f.h.workId), blocked, 'already blocked idle work does not commit again');
    f.denied.clear(); assert.equal(await f.service.current(blocked), true);
    const recovered = await f.service.refresh(f.h.workId);
    assert.equal(recovered.obligations.find(value => value.id === 'computer-continuations:proof')!.status, 'satisfied');
    assert.equal(recovered.obligations.find(value => value.id === 'unrelated')!.status, 'pending');
    assert.deepEqual(recovered.computerContinuations, claims); assert.equal(recovered.attempts.find(value => value.id === child.id)!.status, 'cancelled');
    assert.deepEqual(f.driver.snapshot(), app);
  });
}
