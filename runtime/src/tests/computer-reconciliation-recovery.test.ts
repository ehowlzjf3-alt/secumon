import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ComputerDriver } from '../application/computer-use-ports.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { asJson } from '../application/plan-validator.js';
import { summarizeToolExecution } from '../application/tool-execution-usage.js';
import { ComputerReconciliationResponseSchema } from '../application/computer-reconciliation-contracts.js';
import { evaluateCompletion } from '../domain/completion.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FileGuidanceSource } from '../infrastructure/file-guidance.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { Sha256Digester, RandomIds } from '../infrastructure/digest.js';
import { FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { SyntheticComputerClock, SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { computerActor, computerLimits, openComputerStore, type ComputerBackend } from './computer-use-helpers.js';
import type { ReconciliationCrashMarker, ReconciliationCrashStage } from './helpers/computer-reconciliation-crash-child.js';

const backends: ComputerBackend[] = ['sqlite', 'file-journal'];
async function killedChild(directory: string, backend: ComputerBackend, stage: ReconciliationCrashStage): Promise<ReconciliationCrashMarker> {
  const child = fork(new URL('./helpers/computer-reconciliation-crash-child.js', import.meta.url), [directory, backend, stage],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout!.resume(); let stderr = ''; let timedOut = false;
  child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-32768); });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30000);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(timedOut, false, `The selected reconciliation boundary was not reached: ${stderr}`);
    assert.equal(code, null, stderr); assert.equal(signal, 'SIGKILL', stderr);
    const marker = JSON.parse(await readFile(join(directory, 'reconciliation-crash-marker.json'), 'utf8')) as ReconciliationCrashMarker;
    assert.equal(marker.schemaVersion, 1); assert.equal(marker.backend, backend); assert.equal(marker.stage, stage);
    assert.equal(marker.workId, 'computer-work'); assert.ok(marker.record.id && marker.record.sourceAttemptId);
    assert.equal(marker.inputCount, 2); assert.equal(marker.saveCount, 1); assert.equal(marker.lookupCalls, stage === 'reserved' ? 0 : 1);
    const app = JSON.parse(await readFile(join(directory, 'app.json'), 'utf8')) as {
      version: number; epoch: number; app: { inputCount: number; saveCount: number; savedNote: string };
    };
    assert.equal(app.version, 2); assert.equal(app.epoch, marker.epoch);
    assert.equal(app.app.inputCount, 2); assert.equal(app.app.saveCount, 1); assert.equal(app.app.savedNote, 'reviewed');
    return marker;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit').catch(() => {}); }
  }
}

async function reopen(directory: string, backend: ComputerBackend, marker: ReconciliationCrashMarker) {
  const state = openComputerStore(backend, directory); const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
  const clock = new SyntheticComputerClock(marker.at);
  const driver = new SyntheticComputerDriver({ clock, stateFile: join(directory, 'app.json') }); let lookupCalls = 0;
  const adapter: ComputerDriver = { identity: driver.identity, acquire: driver.acquire.bind(driver), observe: driver.observe.bind(driver),
    act: driver.act.bind(driver), wait: driver.wait.bind(driver), release: driver.release.bind(driver),
    async lookup(...args) { lookupCalls++; return driver.lookup(...args); } };
  const services = { state, artifacts, clock, planner: new ScriptedPlanner([]), tools: [], digester: new Sha256Digester(), ids: new RandomIds(), sink: new FakeSink() };
  try {
    const core = await composeRuntime({ services, owner: 'reopened-reconciliation-worker', leaseMs: 10000, enablePlanning: false,
      schemas: new AjvSchemas(), guidanceSource: new FileGuidanceSource(fileURLToPath(new URL('../../guidance/', import.meta.url))),
      computerTools: [{ provider: 'synthetic', id: 'synthetic.ui', version: '1', description: 'Read and edit a local synthetic document form',
        destination: 'local', labels: ['public'], sessionId: 'synthetic-document', driver: adapter, limits: computerLimits }] });
    assert.notEqual(core.runtime.owner, marker.record.owner); assert.ok(driver.snapshot().epoch > marker.epoch);
    return { ...core, state, artifacts, clock, driver, workId: marker.workId, lookupCalls: () => lookupCalls,
      async close() { await core.runtime.settlePending('none'); await state.close(); } };
  } catch (error) { await state.close(); throw error; }
}
type Reopened = Awaited<ReturnType<typeof reopen>>;
async function fixture(t: TestContext, backend: ComputerBackend, stage: ReconciliationCrashStage) {
  const directory = await mkdtemp(join(tmpdir(), 'computer-reconciliation-recovery-')); let h: Reopened | null = null;
  t.after(async () => { try { if (h) await h.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  const marker = await killedChild(directory, backend, stage); h = await reopen(directory, backend, marker);
  const stored = await h.computerReconciliations.inspect(h.workId, marker.record.id, computerActor);
  assert.deepEqual(stored, marker.record);
  return { h, marker };
}
function input(marker: ReconciliationCrashMarker) { return { attemptId: marker.record.sourceAttemptId, checkpointId: marker.record.sourceHead.id }; }
async function unchangedSource(h: Reopened, marker: ReconciliationCrashMarker) {
  const state = await h.state.get(h.workId); assert.ok(state);
  const source = state.attempts.find(value => value.id === marker.record.sourceAttemptId); assert.ok(source);
  assert.equal(h.services.digester.digest(asJson(source)), marker.sourceDigest);
  assert.ok(source.computerUse); assert.ok(source.resultArtifact); assert.equal(source.adopted, false); assert.equal(source.effectState, 'unknown');
  assert.equal(createHash('sha256').update(await h.artifacts.get(source.computerUse.head, state.policy)).digest('hex'), marker.sourceHeadDigest);
  assert.equal(createHash('sha256').update(await h.artifacts.get(source.resultArtifact, state.policy)).digest('hex'), marker.sourceResultDigest);
  assert.deepEqual(state.evidence, []); assert.equal(state.modelCalls.length, 0);
  assert.equal(evaluateCompletion(state.goal, state.evidence, state.obligations, state.policy).complete, false);
  assert.equal(h.driver.snapshot().inputCount, 2); assert.equal(h.driver.snapshot().saveCount, 1);
  assert.deepEqual(h.driver.snapshot().invocations, []);
  return state;
}
function noDriverEntry(h: Reopened) {
  assert.equal(h.lookupCalls(), 0); assert.equal(h.driver.snapshot().usage.transportCalls, 0);
  assert.deepEqual(h.driver.snapshot().sessionCalls, { acquire: 0, release: 0 });
}

for (const backend of backends) {
  test(`${backend}: SIGKILL after reconciliation reservation preserves its owner and refunds only on expiry before an explicit new command`, { timeout: 45000 }, async t => {
    const { h, marker } = await fixture(t, backend, 'reserved'); const record = marker.record;
    const before = await unchangedSource(h, marker); assert.equal(before.budget.used.toolCalls, 2); assert.equal(before.budget.reservedToolCalls, 1);
    assert.equal(record.dispatchedAt, null); assert.equal(record.responseArtifact, null); assert.equal(record.execution.mode, 'not_invoked');
    assert.deepEqual(await h.computerReconciliations.reserve(h.workId, marker.commandId, computerActor, input(marker)), record);
    await assert.rejects(h.computerReconciliations.execute(h.workId, record.id, computerActor), /computer_reconciliation_owner_changed/);
    assert.deepEqual(await h.computerReconciliations.refresh(h.workId), before); noDriverEntry(h);
    h.clock.advance(record.leaseUntil - h.clock.now() + 1);
    const expired = await h.computerReconciliations.refresh(h.workId); const failed = expired.computerReconciliations!.find(value => value.id === record.id)!;
    assert.equal(failed.status, 'failed'); assert.equal(failed.reason, 'computer_reconciliation_expired');
    assert.equal(failed.leaseUntil, record.leaseUntil); assert.equal(failed.execution.mode, 'not_invoked');
    assert.equal(expired.budget.used.toolCalls, 2); assert.equal(expired.budget.reservedToolCalls, 0);
    assert.equal(expired.obligations.find(value => value.id === record.obligationId)!.status, 'pending');
    assert.deepEqual(await h.computerReconciliations.reconcile(h.workId, marker.commandId, computerActor, input(marker)), failed);
    assert.deepEqual(await h.state.get(h.workId), expired); noDriverEntry(h);
    const settled = await h.computerReconciliations.reconcile(h.workId, 'explicit-after-reservation-expiry', computerActor, input(marker));
    assert.equal(settled.status, 'settled'); assert.equal(settled.outcome, 'applied'); assert.equal(settled.owner, h.runtime.owner);
    assert.notEqual(settled.id, record.id); assert.equal(h.lookupCalls(), 1);
    const final = await unchangedSource(h, marker); assert.equal(final.budget.used.toolCalls, 3); assert.equal(final.budget.reservedToolCalls, 0);
    assert.equal(final.computerReconciliations!.length, 2); assert.equal(await h.computerReconciliations.current(final), true);
  });

  test(`${backend}: SIGKILL during dispatched lookup retains unknown usage and never reissues that command across expiry`, { timeout: 45000 }, async t => {
    const { h, marker } = await fixture(t, backend, 'dispatched'); const record = marker.record;
    const before = await unchangedSource(h, marker); assert.equal(record.status, 'running'); assert.equal(record.execution.mode, 'unreported');
    assert.equal(record.responseArtifact, null); assert.equal(record.finishedAt, null);
    assert.equal(before.budget.used.toolCalls, 3); assert.equal(before.budget.reservedToolCalls, 0);
    assert.ok(await h.state.receipt(h.workId, `reconcile-dispatch:${record.id}`));
    assert.equal(await h.state.receipt(h.workId, `reconcile-receive:${record.id}`), null);
    assert.deepEqual(await h.computerReconciliations.reconcile(h.workId, marker.commandId, computerActor, input(marker)), record);
    assert.deepEqual(await h.computerReconciliations.execute(h.workId, record.id, computerActor), record);
    assert.deepEqual(await h.state.get(h.workId), before); noDriverEntry(h);
    h.clock.advance(record.leaseUntil - h.clock.now() + 1);
    const expired = await h.computerReconciliations.refresh(h.workId); const failed = expired.computerReconciliations!.find(value => value.id === record.id)!;
    assert.equal(failed.status, 'failed'); assert.equal(failed.reason, 'computer_reconciliation_expired');
    assert.equal(failed.execution.mode, 'unreported'); assert.equal(failed.execution.usage.transportCalls, null);
    assert.equal(failed.responseArtifact, null); assert.equal(failed.proofArtifact, null); assert.equal(failed.outcome, null);
    assert.equal(expired.budget.used.toolCalls, 3); assert.equal(expired.budget.reservedToolCalls, 0);
    assert.equal(summarizeToolExecution(expired).unknownInvocations, 1);
    assert.equal(expired.obligations.find(value => value.id === record.obligationId)!.status, 'pending');
    assert.deepEqual(await h.computerReconciliations.reconcile(h.workId, marker.commandId, computerActor, input(marker)), failed); noDriverEntry(h);
    const settled = await h.computerReconciliations.reconcile(h.workId, 'explicit-after-lookup-loss', computerActor, input(marker));
    assert.equal(settled.status, 'settled'); assert.equal(settled.effectState, 'confirmed'); assert.equal(h.lookupCalls(), 1);
    const final = await unchangedSource(h, marker); assert.equal(final.budget.used.toolCalls, 4);
    assert.equal(summarizeToolExecution(final).unknownInvocations, 1, 'a later successful read does not erase earlier unreported cost');
    assert.equal(await h.computerReconciliations.current(final), true);
  });

  test(`${backend}: SIGKILL after received reconciliation settles the stored timely response after lease expiry with no new lookup or input`, { timeout: 45000 }, async t => {
    const { h, marker } = await fixture(t, backend, 'received'); const record = marker.record;
    const before = await unchangedSource(h, marker); assert.ok(record.responseArtifact); assert.equal(record.proofArtifact, null);
    assert.equal(record.outcome, 'applied'); assert.equal(record.effectState, 'unknown'); assert.equal(before.budget.used.toolCalls, 3);
    const responseBytes = await h.artifacts.get(record.responseArtifact, before.policy);
    const response = ComputerReconciliationResponseSchema.parse(JSON.parse(new TextDecoder().decode(responseBytes)));
    assert.equal(response.result.status, 'found'); assert.ok(response.respondedAt < record.leaseUntil);
    assert.equal(response.lease.epoch, marker.epoch); assert.ok(response.lease.epoch < h.driver.snapshot().epoch);
    h.clock.advance(record.leaseUntil - h.clock.now() + 1);
    assert.deepEqual(await h.computerReconciliations.refresh(h.workId), before);
    assert.deepEqual(await h.computerReconciliations.execute(h.workId, record.id, computerActor), record); noDriverEntry(h);
    const settled = await h.computerReconciliations.settle(h.workId, record.id, computerActor);
    assert.equal(settled.status, 'settled'); assert.equal(settled.outcome, 'applied'); assert.equal(settled.effectState, 'confirmed');
    assert.equal(settled.finishedAt, record.finishedAt); assert.equal(settled.owner, record.owner); assert.equal(settled.leaseUntil, record.leaseUntil);
    assert.deepEqual(settled.responseArtifact, record.responseArtifact); assert.ok(settled.proofArtifact);
    const final = await unchangedSource(h, marker); assert.equal(final.budget.used.toolCalls, 3); assert.equal(final.budget.reservedToolCalls, 0);
    assert.equal(final.obligations.find(value => value.id === record.obligationId)!.status, 'satisfied');
    assert.deepEqual(await h.artifacts.get(record.responseArtifact, final.policy), responseBytes);
    assert.equal(await h.computerReconciliations.current(final), true);
    assert.deepEqual(await h.computerReconciliations.reconcile(h.workId, marker.commandId, computerActor, input(marker)), settled);
    assert.deepEqual(await h.state.get(h.workId), final); noDriverEntry(h);
  });

  test(`${backend}: SIGKILL after settlement reopens a current separate proof and duplicate commands remain read-only`, { timeout: 45000 }, async t => {
    const { h, marker } = await fixture(t, backend, 'settled'); const record = marker.record;
    const before = await unchangedSource(h, marker); assert.equal(record.status, 'settled'); assert.ok(record.responseArtifact); assert.ok(record.proofArtifact);
    const events = await h.state.events(h.workId, 0); const budget = structuredClone(before.budget);
    assert.ok(await h.state.receipt(h.workId, `reconcile-settle:${record.id}`));
    assert.equal(await h.computerReconciliations.current(before), true);
    h.clock.advance(record.leaseUntil - h.clock.now() + 1);
    assert.deepEqual(await h.computerReconciliations.refresh(h.workId), before);
    assert.deepEqual(await h.computerReconciliations.inspect(h.workId, record.id, computerActor), record);
    assert.deepEqual(await h.computerReconciliations.reserve(h.workId, marker.commandId, computerActor, input(marker)), record);
    assert.deepEqual(await h.computerReconciliations.execute(h.workId, record.id, computerActor), record);
    assert.deepEqual(await h.computerReconciliations.settle(h.workId, record.id, computerActor), record);
    assert.deepEqual(await h.computerReconciliations.reconcile(h.workId, marker.commandId, computerActor, input(marker)), record);
    const final = await unchangedSource(h, marker); assert.deepEqual(final, before); assert.deepEqual(final.budget, budget);
    assert.deepEqual(await h.state.events(h.workId, 0), events); assert.equal(await h.computerReconciliations.current(final), true);
    assert.equal(final.obligations.find(value => value.id === record.obligationId)!.status, 'satisfied'); noDriverEntry(h);
  });
}
