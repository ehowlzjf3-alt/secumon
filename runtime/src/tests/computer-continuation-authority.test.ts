import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactStore } from '../application/ports.js';
import type { ComputerDriver } from '../application/computer-use-ports.js';
import type { ComputerResume } from '../domain/computer-continuation.js';
import type { ArtifactRef, Attempt, TaskSpec } from '../domain/model.js';
import { executionControl } from '../domain/execution-policy.js';
import { SyntheticComputerClock, SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { computerActor, computerActInput, computerHarness, computerResult, mutateComputer, observeComputer, saveNoteSteps, submitComputerTask,
  type ComputerBackend, type ComputerHarness } from './computer-use-helpers.js';

const limits = { callId: 'continuation-authority', maxOutputTokens: 100, maxInputBytes: 200000, maxInputTokens: 1000000, forceCompact: true };

// Only the synthetic driver runs. The artifact wrapper makes one exact original temporarily unreadable; disk bytes remain intact.
async function fixture(t: TestContext, backend: ComputerBackend, unknown = false) {
  const clock = new SyntheticComputerClock(1000); const app = new SyntheticComputerDriver({ clock });
  const blocked = new Set<string>(); let deniedReads = 0; let raw!: ArtifactStore;
  let inputHook: (() => Promise<void>) | null = null; let childId: string | null = null; let inputHookCalls = 0;
  const adapter: ComputerDriver = { identity: app.identity, acquire: app.acquire.bind(app), release: app.release.bind(app),
    observe: app.observe.bind(app), wait: app.wait.bind(app), lookup: app.lookup.bind(app),
    act: (lease, request, signal, authorizeInput) => app.act(lease, request, signal, async () => {
      if (inputHook && lease.attemptId === childId) { inputHookCalls++; await inputHook(); }
      await authorizeInput();
    }) };
  const h = await computerHarness(backend, { continuations: true, leaseMs: 60000, clock, driver: adapter,
    artifacts: original => {
      raw = original;
      return { put: (...args) => original.put(...args), async get(ref, policy) {
        if (blocked.has(ref.id)) { deniedReads++; throw new Error('fixture_original_unavailable'); }
        return original.get(ref, policy);
      }, async exists(ref) { if (blocked.has(ref.id)) { deniedReads++; return false; } return original.exists(ref); } };
    } });
  t.after(() => h.close());
  const observed = await observeComputer(h);
  if (unknown) app.injectNextAction({ outcome: 'applied_unknown' });
  else { app.injectNextAction({}); app.injectNextAction({ outcome: 'not_applied_timeout' }); }
  const reserved = await submitComputerTask(h, 'act', computerActInput(observed.observationId, saveNoteSteps));
  await h.runtime.execute(h.workId, reserved.id); await h.runtime.settlePending(reserved.id); await h.runtime.adopt(h.workId, reserved.id);
  const state = (await h.state.get(h.workId))!; const source = structuredClone(state.attempts.find(value => value.id === reserved.id)!);
  assert.ok(source.computerUse); assert.ok(source.resultArtifact); assert.equal(app.snapshot().inputCount, 1); assert.equal(app.snapshot().saveCount, 0);
  assert.equal(source.effectState, unknown ? 'unknown' : 'confirmed');
  const headBytes = await raw.get(source.computerUse.head, state.policy); const resultBytes = await raw.get(source.resultArtifact, state.policy);
  let proof: ArtifactRef | null = null;
  const resume: ComputerResume = { attemptId: source.id, checkpointId: source.computerUse.head.id, reconciliation: null };
  if (unknown) {
    const record = await h.computerReconciliations.reconcile(h.workId, 'authority-reconcile', computerActor,
      { attemptId: source.id, checkpointId: source.computerUse.head.id });
    assert.equal(record.status, 'settled'); assert.equal(record.outcome, 'applied'); assert.ok(record.proofArtifact); proof = record.proofArtifact;
    resume.reconciliation = { id: record.id, proofId: proof.id };
  }
  return { h, app, source, proof, resume, raw, headBytes, resultBytes,
    block(ref: ArtifactRef) { blocked.add(ref.id); }, deniedReads: () => deniedReads,
    beforeInput(attemptId: string, hook: () => Promise<void>) { childId = attemptId; inputHook = hook; }, inputHookCalls: () => inputHookCalls };
}
async function child(h: ComputerHarness, resume: ComputerResume): Promise<Attempt> {
  const state = (await h.state.get(h.workId))!;
  const task: TaskSpec = { id: `authority-child-${state.revision}`, toolId: 'synthetic.ui.continue', toolVersion: '1',
    description: 'Continue the original remaining input', input: {}, computerResume: resume, dependsOn: [], effect: 'write', maxAttempts: 1, satisfies: ['saved'] };
  await h.runtime.submitPlan(h.workId, `authority-plan-${state.revision}`, { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
    basePlanRevision: state.plan?.revision ?? 0, reason: 'Explicit synthetic continuation', tasks: [task], hypotheses: [] });
  return h.runtime.reserve(h.workId, task.id);
}
async function settle(h: ComputerHarness, attemptId: string): Promise<string[]> {
  const errors: string[] = [];
  for (const operation of [() => h.runtime.execute(h.workId, attemptId), () => h.runtime.settlePending(attemptId)]) {
    try { await operation(); } catch (error) { assert.ok(error instanceof Error); errors.push(error.message); }
  }
  return errors;
}
async function sourceUnchanged(f: Awaited<ReturnType<typeof fixture>>) {
  const state = (await f.h.state.get(f.h.workId))!;
  assert.deepEqual(state.attempts.find(value => value.id === f.source.id), f.source);
  assert.deepEqual(await f.raw.get(f.source.computerUse!.head, state.policy), f.headBytes);
  assert.deepEqual(await f.raw.get(f.source.resultArtifact!, state.policy), f.resultBytes);
  assert.equal(state.modelCalls.length, 0); return state;
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: source loss during the awaited knowledge check is caught by the second resolution before input`, async t => {
    const f = await fixture(t, backend); let armed = false; let blocked = false; const order: string[] = [];
    // A retained dependency and a synthetic validator activate the real knowledge await; this does not test a knowledge repository.
    f.h.services.knowledge = { async validate(dependencies) {
      assert.ok(dependencies.some(value => value.knowledgeId === 'authority-fixture-memory'));
      if (armed && !blocked) {
        assert.equal(order.at(-1), 'resolve:ok', 'the initial source check must have completed while its head was still readable');
        await Promise.resolve(); f.block(f.source.computerUse!.head); blocked = true; order.push('knowledge:block');
      }
      return true;
    } };
    await mutateComputer(f.h, state => {
      const observed = state.attempts.find(value => value.toolId === 'synthetic.ui.observe')!;
      observed.knowledgeDependencies = [{ tenantId: state.policy.tenantId, knowledgeId: 'authority-fixture-memory', knowledgeRevision: 1,
        actorDigest: 'a'.repeat(64), parents: [], sources: [{ workId: 'fixture-source-work', evidenceId: 'fixture-source-evidence',
          sourceVersion: 'b'.repeat(64), generation: 0, workRevision: 1, policyDigest: 'c'.repeat(64) }] }];
    });
    const attempt = await child(f.h, f.resume); const continuations = f.h.services.continuations!;
    const resolve = continuations.resolve.bind(continuations);
    continuations.resolve = async (state, successorId) => {
      const trace = armed && successorId === attempt.id; if (trace) order.push('resolve:start');
      try { const value = await resolve(state, successorId); if (trace) order.push('resolve:ok'); return value; }
      catch (error) { if (trace) order.push('resolve:denied'); throw error; }
    };
    f.beforeInput(attempt.id, async () => { armed = true; }); const before = f.app.snapshot();
    const errors = await settle(f.h, attempt.id);
    assert.equal(f.inputHookCalls(), 1); assert.equal(blocked, true);
    assert.deepEqual(order.slice(0, 5), ['resolve:start', 'resolve:ok', 'knowledge:block', 'resolve:start', 'resolve:denied']);
    assert.ok(f.deniedReads() > 0); assert.equal(f.app.snapshot().inputCount, before.inputCount); assert.equal(f.app.snapshot().saveCount, 0);
    const invocation = f.app.snapshot().invocations.filter(value => value.attemptId === attempt.id);
    assert.equal(invocation.length, 1); assert.equal(invocation[0]!.status, 'not_applied');
    assert.equal(invocation[0]!.reason, 'computer_input_authorization_failed');
    for (const error of errors) assert.equal(error, 'result_persistence_failed');
    const state = await sourceUnchanged(f); assert.equal(state.attempts.find(value => value.id === attempt.id)!.adopted, false);
    assert.deepEqual(state.evidence, []);
  });

  for (const change of ['source-head', 'reconciliation-proof', 'pause', 'goal'] as const) {
    test(`${backend}: ${change} changing inside final input authorization prevents the successor input`, async t => {
      const f = await fixture(t, backend, change === 'reconciliation-proof'); const attempt = await child(f.h, f.resume);
      const before = f.app.snapshot();
      f.beforeInput(attempt.id, async () => {
        if (change === 'source-head') f.block(f.source.computerUse!.head);
        else if (change === 'reconciliation-proof') { assert.ok(f.proof); f.block(f.proof); }
        else {
          const state = (await f.h.state.get(f.h.workId))!;
          await f.h.runtime.command(f.h.workId, `late-${change}`, computerActor, state.goal.revision,
            change === 'pause' ? { kind: 'pause', reason: 'Pause before the synthetic Save input' } :
              { kind: 'goal', goal: { ...state.goal, revision: state.goal.revision + 1, description: 'A new explicit goal excludes the pending Save' },
                expectedControlRevision: executionControl(state).revision });
        }
      });
      const errors = await settle(f.h, attempt.id);
      assert.equal(f.inputHookCalls(), 1, 'the change happens inside the driver callback, after the input intent was stored');
      assert.equal(f.app.snapshot().inputCount, before.inputCount); assert.equal(f.app.snapshot().saveCount, 0);
      const invocation = f.app.snapshot().invocations.filter(value => value.attemptId === attempt.id);
      assert.equal(invocation.length, 1); assert.equal(invocation[0]!.status, 'not_applied');
      assert.equal(invocation[0]!.reason, 'computer_input_authorization_failed');
      for (const error of errors) assert.equal(error, 'result_persistence_failed');
      const state = await sourceUnchanged(f); const stored = state.attempts.find(value => value.id === attempt.id)!;
      assert.equal(stored.adopted, false); assert.deepEqual(state.evidence, []);
      assert.equal(state.computerContinuations!.length, 1); assert.ok(stored.computerUse, 'the input intent cannot disappear on authorization failure');
      if (change === 'pause') assert.equal(state.status, 'paused');
      else if (change === 'goal') assert.equal(state.goal.revision, 2);
      else { assert.ok(f.deniedReads() > 0); assert.equal(await f.h.computerContinuations.current(state), false); }
    });
  }

  test(`${backend}: losing a parent proof after a successful child result blocks adoption, proof consumption and compaction`, async t => {
    const f = await fixture(t, backend, true); const attempt = await child(f.h, f.resume);
    assert.deepEqual(await settle(f.h, attempt.id), []);
    const result = await computerResult(f.h, attempt.id); assert.equal(result.status, 'success'); assert.equal(result.effectState, 'confirmed');
    const state = (await f.h.state.get(f.h.workId))!; const stored = state.attempts.find(value => value.id === attempt.id)!;
    assert.equal(stored.status, 'received'); assert.equal(stored.adopted, false); assert.deepEqual(state.evidence, []);
    assert.equal(await f.h.computerContinuations.current(state), true); assert.equal(await f.h.services.effects!.current(state), true);
    const prepared = await f.h.context.prepare(state, limits); assert.equal(await f.h.context.sourcesCurrent(prepared.packet, state), true);
    const before = f.app.snapshot(); assert.equal(before.inputCount, 2); assert.equal(before.saveCount, 1);
    assert.ok(f.proof); const proofBytes = await f.raw.get(f.proof, state.policy); f.block(f.proof);
    assert.equal(await f.h.computerContinuations.current(state), false); assert.equal(await f.h.services.effects!.current(state), false);
    assert.equal(await f.h.context.sourcesCurrent(prepared.packet, state), false);
    await assert.rejects(f.h.context.prepare(state, { ...limits, callId: 'after-proof-loss' }));
    await assert.rejects(f.h.recovery.restore(f.h.workId, computerActor));
    assert.deepEqual(await f.h.state.get(f.h.workId), state, 'read-side proof rejection does not itself settle the received result');
    await f.h.runtime.adopt(f.h.workId, attempt.id);
    const after = await sourceUnchanged(f); const rejected = after.attempts.find(value => value.id === attempt.id)!;
    assert.equal(rejected.adopted, false); assert.deepEqual(rejected.resultArtifact, stored.resultArtifact);
    assert.deepEqual(rejected.computerUse, stored.computerUse); assert.deepEqual(after.evidence, []);
    assert.ok(after.obligations.some(value => value.kind === 'effect_reconciliation' && value.status === 'pending'));
    assert.equal(await f.h.computerContinuations.current(after), false); assert.deepEqual(f.app.snapshot(), before);
    assert.deepEqual(await f.raw.get(f.proof, after.policy), proofBytes, 'the test did not delete or rewrite the original proof');
  });

  test(`${backend}: a child acquires a fresh epoch and rechecks conditions without replaying the old field input`, async t => {
    const f = await fixture(t, backend); const parent = await f.h.computerUse.inspect(f.h.workId, computerActor, f.source.id);
    const originalEpoch = parent.checkpoint.epoch; f.app.restart(); assert.ok(f.app.snapshot().epoch > originalEpoch);
    const before = f.app.snapshot(); assert.equal(before.note, 'reviewed'); const attempt = await child(f.h, f.resume);
    assert.deepEqual(await settle(f.h, attempt.id), []); const result = await computerResult(f.h, attempt.id);
    assert.equal(result.status, 'success'); await f.h.runtime.adopt(f.h.workId, attempt.id);
    const inspected = await f.h.computerUse.inspect(f.h.workId, computerActor, attempt.id); assert.ok(inspected.checkpoint.schemaVersion === 2);
    assert.equal(inspected.checkpoint.epoch, f.app.snapshot().epoch); assert.notEqual(inspected.checkpoint.epoch, originalEpoch);
    assert.deepEqual(inspected.checkpoint.initialObservation, parent.checkpoint.latestObservation);
    assert.ok(inspected.checkpoint.entryObservation); assert.ok(inspected.checkpoint.continuation!.inheritedObservation);
    assert.deepEqual(inspected.checkpoint.steps.map(value => value.action), [saveNoteSteps[1]!.action]);
    assert.equal(f.app.snapshot().inputCount, before.inputCount + 1); assert.equal(f.app.snapshot().saveCount, 1);
    const state = await sourceUnchanged(f); assert.equal(state.attempts.find(value => value.id === attempt.id)!.adopted, true);
    assert.equal(await f.h.computerContinuations.current(state), true); assert.equal((await f.h.runtime.step(f.h.workId)).kind, 'complete');
  });
}
