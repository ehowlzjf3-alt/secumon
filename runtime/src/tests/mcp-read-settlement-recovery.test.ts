import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { TaskSpec } from '../domain/model.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { ReadReconciliation } from '../application/read-reconciliation.js';
import { transact } from '../application/work-transactions.js';
import { asJson } from '../application/plan-validator.js';
import { ToolResultSchema } from '../application/contracts.js';
import { ReadResponseSchema } from '../application/read-collection-contracts.js';
import type { RuntimeServices } from '../application/services.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester, sha256 } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { evaluationCodePin } from '../infrastructure/local-evaluation.js';
import { createMcpReadCollection } from '../infrastructure/mcp-read-collections.js';
import { McpStdioClient, type McpSession } from '../infrastructure/mcp-stdio-client.js';
import { adapters, openRepository, type Adapter } from './state-conformance-helpers.js';
import { collectionBinding } from './helpers/mcp-collection-binding.js';
import { waitCollectionBinding } from './helpers/mcp-wait-fixture-binding.js';
import type { McpWaitAudit } from './helpers/mcp-wait-fixture-contracts.js';
import type { McpSettlementMarker, McpSettlementStage } from './helpers/mcp-settlement-worker.js';

const evidenceDirectory = process.env['SECUMON_MCPS_EVIDENCE_DIR'];
const codeDigest = evidenceDirectory ? (await evaluationCodePin(process.cwd())).digest : null;
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function exited(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (alive(pid)) {
    if (Date.now() >= deadline) throw new Error('owned_settlement_peer_did_not_exit');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}
async function audit(directory: string, label: 'before' | 'after'): Promise<McpWaitAudit[]> {
  try { return (await readFile(join(directory, `${label}-audit.jsonl`), 'utf8')).trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as McpWaitAudit); }
  catch (error) { if (label === 'after' && (error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function stoppedWorker(directory: string, backend: Adapter, stage: McpSettlementStage): Promise<McpSettlementMarker> {
  const child = fork(new URL('./helpers/mcp-settlement-worker.js', import.meta.url), [directory, backend, stage],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout!.resume(); let stderr = ''; let peerPid: number | null = null;
  child.stderr!.on('data', value => { stderr = (stderr + String(value)).slice(-16384); });
  const exit = once(child, 'exit'); let ready!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const message = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const record = value as { kind?: string; pid?: number };
    if (record.kind === 'peer-ready' && Number.isSafeInteger(record.pid) && record.pid! > 0 && record.pid !== child.pid && record.pid !== process.pid)
      peerPid = record.pid!;
    if (record.kind === 'raw-receipt-ready') ready();
  };
  child.on('message', message); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([waiting,
      exit.then(([code, signal]) => { throw new Error(`settlement_worker_exited_before_marker:${String(code)}:${String(signal)}:${stderr}`); }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`settlement_worker_timeout:${stderr}`)), 30000); })]);
    const marker = JSON.parse(await readFile(join(directory, 'settlement-marker.json'), 'utf8')) as McpSettlementMarker;
    assert.equal(marker.schemaVersion, 1); assert.equal(marker.backend, backend); assert.equal(marker.stage, stage);
    assert.equal(marker.workerPid, child.pid); assert.equal(marker.peerPid, peerPid); assert.ok(peerPid);
    assert.equal(marker.responseCommandId, `mcp-page:${marker.attemptId}:${marker.request.requestId}`);
    assert.equal(child.kill('SIGKILL'), true); const [code, signal] = await exit;
    assert.equal(code, null, stderr); assert.equal(signal, 'SIGKILL', stderr);
    await exited(peerPid); assert.equal(alive(marker.workerPid), false);
    const before = await audit(directory, 'before');
    assert.ok(before.every(row => row.pid === peerPid)); assert.equal(before.filter(row => row.event === 'call').length, 1);
    assert.ok(before.some(row => row.event === 'response-sent'));
    assert.ok(before.some(row => row.event === 'close' && row.reason === 'stdin-ended'));
    return marker;
  } finally {
    if (timer) clearTimeout(timer); child.off('message', message);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
    if (peerPid !== null && alive(peerPid)) { process.kill(peerPid, 'SIGKILL'); await exited(peerPid); }
  }
}

async function fixture(t: TestContext, backend: Adapter, stage: McpSettlementStage) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-mcp-settlement-recovery-'));
  let cleanup = async () => {}; let evidence: (() => Promise<Record<string, unknown>>) | null = null; let passed = false;
  t.after(async () => {
    let record: Record<string, unknown> | null = null;
    try { await cleanup(); if (passed && evidenceDirectory && evidence) record = await evidence(); }
    finally { await rm(directory, { recursive: true, force: true }); await assert.rejects(stat(directory), { code: 'ENOENT' }); }
    if (record && evidenceDirectory) { await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(join(evidenceDirectory, `${sha256(t.name).slice(0, 20)}-settlement-recovery.json`),
        JSON.stringify({ ...record, tempCleaned: true }, null, 2) + '\n'); }
  });
  const marker = await stoppedWorker(directory, backend, stage);
  const deferral = stage === 'raw-receipt-deferral'; const owner = 'mcp-settlement-after';
  let repository = openRepository(backend, directory); const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
  const digester = new Sha256Digester(); const clock = new FakeClock(marker.at);
  const planner = new ScriptedPlanner([]); const sink = new FakeSink();
  const client = new McpStdioClient({ endpointId: marker.session.endpointId, command: process.execPath,
    args: [fileURLToPath(new URL(deferral ? './helpers/mcp-wait-fixture-server.js' : './helpers/mcp-collection-fixture-server.js', import.meta.url)),
      '--mode', 'normal', '--audit-file', join(directory, 'after-audit.jsonl'), '--delay-ms', '350',
      ...(deferral ? ['--retry-after-ms', '45000'] : [])],
    cwd: directory, env: { TMPDIR: tmpdir() }, timeoutMs: 10000 });
  let peerPid: number | null = null; let forbiddenCalls = 0; let discoveryCalls = 0;
  const noWire: Pick<McpStdioClient, 'call'> = { async call() { forbiddenCalls++; throw new Error('settlement_must_not_call_peer'); } };
  const services: RuntimeServices = { state: repository, artifacts, digester, clock, planner, sink, tools: [], ids: new RandomIds() };
  const binding = deferral ? waitCollectionBinding('documents', { maxCalls: 3 }) :
    collectionBinding(stage === 'raw-receipt-complete' ? 'documents' : 'observations', { maxCalls: 3 });
  const compose = (session: McpSession, transport: Pick<McpStdioClient, 'call'>) => composeRuntime({ services,
    schemas: new AjvSchemas(), owner, collectionTools: [createMcpReadCollection(binding, session, transport, services, new AjvSchemas())],
    guidanceSource: { list: async () => [], read: async () => { throw new Error('unused_guidance'); } } });
  let core = await compose(marker.session, noWire); assert.ok(core.planning);
  cleanup = async () => { try { await client.close(); if (peerPid !== null) await exited(peerPid); } finally { await repository.close(); } };
  const current = () => core.runtime.state(marker.workId);
  const reopenOffline = async () => {
    await repository.close(); repository = openRepository(backend, directory); services.state = repository;
    core = await compose(marker.session, noWire);
  };
  const connectExplicitly = async () => {
    discoveryCalls++; const session = await client.discover([binding.remote], new AbortController().signal);
    peerPid = client.snapshot().pid; assert.ok(peerPid); assert.notEqual(peerPid, marker.peerPid);
    core = await compose(session, client);
  };
  const noExternal = async () => {
    assert.equal(forbiddenCalls, 0); assert.equal(discoveryCalls, 0); assert.equal(client.snapshot().processStarts, 0);
    assert.equal(client.snapshot().toolCalls, 0); assert.deepEqual(await audit(directory, 'after'), []);
    assert.equal(planner.inputs.length, 0); assert.equal((await current()).modelCalls.length, 0); assert.equal(sink.delivered.size, 0);
  };
  let recoverySummary: Record<string, unknown> | null = null; let finalSummary: Record<string, unknown> | null = null;
  evidence = async () => {
    const pids = { worker: marker.workerPid, peerBefore: marker.peerPid, peerAfter: peerPid };
    for (const pid of Object.values(pids)) if (pid !== null)
      assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
    return { schemaVersion: 1, kind: 'mcp_stored_response_settlement_recovery', test: t.name, backend, stage, codeDigest,
      marker, beforeAudit: await audit(directory, 'before'), afterAudit: await audit(directory, 'after'),
      recovery: recoverySummary, final: finalSummary, transport: client.snapshot(), forbiddenCalls, discoveryCalls,
      shutdown: { worker: { pid: pids.worker, signal: 'SIGKILL', probe: 'ESRCH' },
        peerBefore: { pid: pids.peerBefore, reason: 'stdin-ended', probe: 'ESRCH' },
        peerAfter: pids.peerAfter === null ? { started: false } : { pid: pids.peerAfter, probe: 'ESRCH' } },
      hostScheduling: 'FakeClock and explicit recover/reserve/execute calls; no background daemon' };
  };
  return { marker, directory, clock, digester, artifacts, planner, client, current, reopenOffline, connectExplicitly, noExternal, owner,
    get core() { return core; }, get repository() { return repository; },
    recordRecovery: async () => { const latest = await current(); recoverySummary = { revision: latest.revision,
      budget: latest.budget, deadlineAt: latest.deadlineAt, attempts: latest.attempts, evidence: latest.evidence,
      transport: client.snapshot(), forbiddenCalls, discoveryCalls }; },
    recordSuccess: async () => { const latest = await current(); finalSummary = { revision: latest.revision, budget: latest.budget,
      deadlineAt: latest.deadlineAt, modelCalls: latest.modelCalls.length, plannerCalls: planner.inputs.length,
      attempts: latest.attempts.map(attempt => ({ id: attempt.id, owner: attempt.owner, status: attempt.status,
        adopted: attempt.adopted, readProgress: attempt.readProgress })) }; passed = true; } };
}

for (const backend of adapters) for (const stage of ['raw-receipt-complete', 'raw-receipt-nonfinal', 'raw-receipt-deferral'] as const) {
  test(`${backend}: SIGKILL at ${stage} settles the original response offline before explicit continuation`, { timeout: 90000 }, async t => {
    const f = await fixture(t, backend, stage); const { marker } = f; const stopped = await f.current();
    const parent = stopped.attempts.find(attempt => attempt.id === marker.attemptId)!;
    assert.equal(f.digester.digest(asJson(stopped)), marker.stateDigest); assert.equal(stopped.revision, marker.revision);
    assert.equal(parent.status, 'running'); assert.equal(parent.owner, marker.owner); assert.notEqual(parent.owner, f.owner);
    assert.equal(parent.resultArtifact, null); assert.equal(parent.resultId, null); assert.equal(parent.adopted, false);
    assert.equal(parent.readProgress!.unknownCalls, 1); assert.deepEqual(parent.readProgress!.head, marker.head);
    const original = await f.core.readCheckpoints.read(stopped, parent.id, marker.head);
    assert.equal(f.digester.digest(asJson(original)), marker.checkpointDigest);
    assert.equal(original.calls.length, 1); assert.equal(original.calls[0]!.status, 'intent');
    assert.equal(original.calls[0]!.response, null); assert.equal(original.collection.calls, 0);
    const receipt = await f.repository.receipt(marker.workId, marker.responseCommandId); assert.ok(receipt);
    assert.equal(receipt.digest, marker.responseDigest);
    assert.deepEqual(receipt.state.artifacts.at(-1), marker.responseArtifact);
    await f.noExternal();
    await assert.rejects(f.core.runtime.recover(marker.workId, parent.id), /attempt_not_expired/);
    assert.deepEqual(await f.current(), stopped);
    f.clock.advance(marker.leaseUntil - f.clock.now() + 1); assert.ok(f.clock.now() < marker.deadlineAt);
    await f.core.runtime.recover(marker.workId, parent.id);
    const recovered = await f.current(); const settled = recovered.attempts.find(attempt => attempt.id === parent.id)!;
    assert.equal(settled.status, 'failed'); assert.equal(settled.effectState, 'none'); assert.equal(settled.error?.code, 'lease_expired');
    assert.equal(settled.owner, marker.owner); assert.equal(settled.leaseUntil, marker.leaseUntil); assert.equal(settled.adopted, false);
    assert.equal(settled.resultArtifact, null); assert.equal(settled.resultId, null); assert.deepEqual(recovered.evidence, stopped.evidence);
    assert.deepEqual(recovered.budget, marker.budget); assert.equal(recovered.deadlineAt, marker.deadlineAt);
    assert.equal(settled.readProgress!.successorAttemptId, null); assert.notEqual(settled.readProgress!.head.id, marker.head.id);
    assert.equal(settled.readProgress!.callCount, 1); assert.equal(settled.readProgress!.remainingCalls, marker.remainingCalls);
    assert.equal(settled.readProgress!.unknownCalls, 0); assert.equal(recovered.attempts.length, 1);
    const restored = await f.core.readCheckpoints.read(recovered, parent.id, settled.readProgress!.head);
    assert.equal(restored.operationId, original.operationId); assert.equal(restored.rootAttemptId, original.rootAttemptId);
    assert.deepEqual(restored.limits, original.limits); assert.equal(restored.calls.length, 1);
    const call = restored.calls[0]!; assert.deepEqual(call.request, marker.request); assert.equal(call.attemptId, parent.id);
    assert.equal(call.dispatchedAt, original.calls[0]!.dispatchedAt); assert.equal(call.receivedAt, marker.receivedAt);
    assert.equal(call.status, stage === 'raw-receipt-deferral' ? 'deferred' : 'accepted'); assert.ok(call.response);
    const normalized = ReadResponseSchema.parse(JSON.parse(new TextDecoder().decode(await f.artifacts.get(call.response, recovered.policy))));
    assert.deepEqual(normalized.rawArtifact, marker.responseArtifact); assert.equal(normalized.usage?.transportCalls, 1);
    assert.equal(normalized.requestId, marker.request.requestId);
    const expectedPhase = stage === 'raw-receipt-complete' ? 'complete' : stage === 'raw-receipt-deferral' ? 'partial' : 'running';
    assert.equal(restored.phase, expectedPhase); assert.equal(restored.collection.calls, stage === 'raw-receipt-deferral' ? 0 : 1);
    assert.deepEqual(restored.collection.acceptedRequestIds, stage === 'raw-receipt-deferral' ? [] : [marker.request.requestId]);
    const originalItems = restored.collection.pages.flatMap(page => page.items);
    assert.deepEqual(originalItems.map(item => item.id), stage === 'raw-receipt-deferral' ? [] : ['a', 'b']);
    for (const item of originalItems) { assert.ok(item.evidence.length); assert.equal(item.evidence[0]!.observedAt, 900);
      assert.equal(item.evidence[0]!.recordedAt, marker.receivedAt); assert.deepEqual(item.evidence[0]!.artifact, marker.responseArtifact); }
    await f.noExternal(); await f.recordRecovery();
    await f.reopenOffline(); assert.deepEqual(await f.current(), recovered);
    await f.core.runtime.recover(marker.workId, parent.id);
    assert.deepEqual(await f.current(), recovered); await f.noExternal();
    const successor: TaskSpec = { id: 'explicit-after-settlement', description: 'Consume only the settled head with an explicit successor',
      toolId: parent.toolId, toolVersion: parent.toolVersion,
      input: { ids: stage === 'raw-receipt-nonfinal' ? ['a', 'b', 'c', 'd'] : ['a', 'b'] },
      effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [],
      readResume: { attemptId: parent.id, checkpointId: settled.readProgress!.head.id } };
    await f.core.runtime.submitPlan(marker.workId, 'plan-explicit-successor', { baseStateRevision: recovered.revision,
      baseGoalRevision: recovered.goal.revision, basePlanRevision: recovered.plan?.revision ?? 0,
      reason: 'Resume after original response settlement; never resend its request', tasks: [successor], hypotheses: [] });
    if (stage === 'raw-receipt-deferral') {
      assert.equal(marker.retryAt, marker.receivedAt + 45000); assert.equal(restored.retryAt, marker.retryAt);
      assert.ok(f.clock.now() < marker.retryAt!); assert.ok('dueAt' in normalized); assert.equal(normalized.dueAt, marker.retryAt);
      const noEarlySuccessor = async () => {
        const before = await f.current(); await assert.rejects(f.core.runtime.reserve(marker.workId, successor.id));
        await assert.rejects(f.core.planning!.reserve(marker.workId));
        const after = await f.current(); assert.equal(after.attempts.length, 1); assert.equal(after.modelCalls.length, 0);
        assert.equal(after.attempts[0]!.readProgress!.successorAttemptId, null); assert.deepEqual(after.budget, before.budget);
        assert.equal(after.attempts[0]!.readProgress!.retryAt, marker.retryAt); await f.noExternal();
      };
      await noEarlySuccessor(); const wait = await f.core.runtime.step(marker.workId);
      assert.equal(wait.kind, 'wait'); if (wait.kind === 'wait') assert.equal(wait.wakeAt, marker.retryAt);
      assert.deepEqual(await f.repository.runnable(f.clock.now()), []);
      f.clock.advance(marker.retryAt! - f.clock.now() - 1); await f.reopenOffline(); await noEarlySuccessor();
      f.clock.advance(1); assert.equal(f.clock.now(), marker.retryAt);
      assert.deepEqual(await f.repository.runnable(f.clock.now()), [marker.workId]);
    }
    if (stage !== 'raw-receipt-complete') await f.connectExplicitly();
    const child = await f.core.runtime.reserve(marker.workId, successor.id);
    await f.core.runtime.execute(marker.workId, child.id); await f.core.runtime.settlePending(child.id);
    await f.core.runtime.adopt(marker.workId, child.id);
    const finished = await f.current(); const adopted = finished.attempts.find(attempt => attempt.id === child.id)!;
    assert.equal(adopted.status, 'succeeded'); assert.equal(adopted.adopted, true); assert.equal(adopted.owner, f.owner);
    assert.ok(adopted.resultArtifact); assert.equal(finished.attempts.length, 2);
    const old = finished.attempts.find(attempt => attempt.id === parent.id)!;
    assert.equal(old.status, 'failed'); assert.equal(old.adopted, false); assert.equal(old.owner, marker.owner);
    assert.deepEqual(old.readProgress!.head, settled.readProgress!.head); assert.equal(old.readProgress!.successorAttemptId, child.id);
    const resumed = await f.core.readCheckpoints.read(finished, child.id, adopted.readProgress!.head);
    assert.deepEqual(resumed.parent, { attemptId: parent.id, checkpoint: settled.readProgress!.head });
    assert.deepEqual(resumed.calls[0], call); assert.equal(resumed.operationId, restored.operationId);
    assert.equal(resumed.phase, 'complete'); assert.equal(resumed.collection.exhausted, true);
    const physicalCalls = stage === 'raw-receipt-complete' ? 0 : 1;
    assert.equal(resumed.calls.length, 1 + physicalCalls); assert.equal(adopted.readProgress!.remainingCalls, marker.remainingCalls - physicalCalls);
    const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await f.artifacts.get(adopted.resultArtifact, finished.policy))));
    assert.equal(result.status, 'success'); assert.equal(result.usage?.transportCalls, physicalCalls);
    assert.equal(f.client.snapshot().toolCalls, physicalCalls); assert.equal(finished.modelCalls.length, 0); assert.equal(f.planner.inputs.length, 0);
    assert.equal(finished.budget.used.toolCalls, marker.budget.used.toolCalls + 1); assert.equal(finished.budget.reservedToolCalls, 0);
    assert.equal(finished.deadlineAt, marker.deadlineAt);
    const items = resumed.collection.pages.flatMap(page => page.items);
    for (const item of originalItems) assert.deepEqual(items.find(value => value.id === item.id), item);
    const calls = (await audit(f.directory, 'after')).filter(row => row.event === 'call'); assert.equal(calls.length, physicalCalls);
    if (physicalCalls) {
      const later = resumed.calls[1]!; assert.notEqual(later.request.requestId, marker.request.requestId);
      assert.equal(calls[0]!.requestId, later.request.requestId); assert.equal(later.attemptId, child.id);
      assert.deepEqual(calls[0]!.retryIds, null);
      assert.equal(calls[0]!.cursor, stage === 'raw-receipt-nonfinal' ? restored.collection.nextCursor : null);
      assert.equal(calls[0]!.snapshot, stage === 'raw-receipt-nonfinal' ? restored.collection.snapshot : null);
      const returned = (await audit(f.directory, 'after')).filter(row => row.event === 'handler-ready').flatMap(row => row.returnedIds ?? []);
      assert.deepEqual(returned, stage === 'raw-receipt-nonfinal' ? ['c', 'd'] : ['a', 'b']);
      if (stage === 'raw-receipt-deferral') { assert.equal(later.dispatchedAt, marker.retryAt); assert.equal(later.receivedAt, marker.retryAt); }
    } else await f.noExternal();
    assert.equal((await f.repository.receipt(marker.workId, marker.responseCommandId))?.digest, marker.responseDigest);
    await f.recordSuccess();
  });
}

for (const damage of ['missing-response', 'changed-policy', 'callback-replaced'] as const) {
  test(`stored MCP response: ${damage} cannot be silently treated as absent or retransmitted`, { timeout: 90000 }, async t => {
    const f = await fixture(t, 'sqlite', 'raw-receipt-complete'); const before = await f.current();
    const attempt = before.attempts[0]!;
    if (damage === 'missing-response') await rm(join(f.directory, 'artifacts', `${f.marker.responseArtifact.id}.blob`));
    if (damage === 'changed-policy') await transact(f.core.services, f.marker.workId, 'revoke', 'policy_changed', {}, state => { state.policy.allowedTools = []; });
    if (damage === 'callback-replaced') {
      const contracts = f.core.contracts; const tool = contracts.get(attempt.toolId, attempt.toolVersion)!.tool;
      contracts.replaceProvider(tool.definition.provider, [{ ...tool, async restoreReadResponse(state, input) {
        const result = await tool.restoreReadResponse!(state, input);
        contracts.replaceProvider(tool.definition.provider, [tool], { expectedEpoch: contracts.providerEpoch(tool.definition.provider), sourceRevision: 'replaced-during-restore' });
        return result;
      } }], { expectedEpoch: contracts.providerEpoch(tool.definition.provider), sourceRevision: 'restore-wrapper' });
    }
    f.clock.advance(f.marker.leaseUntil - f.clock.now() + 1);
    await assert.rejects(f.core.runtime.recover(f.marker.workId, attempt.id),
      damage === 'missing-response' ? /artifact_unavailable/ : /read_reconciliation_invalid/);
    const after = await f.current(); assert.equal(after.attempts[0]!.status, damage === 'missing-response' ? 'running' : 'failed');
    assert.deepEqual(after.attempts[0]!.readProgress, attempt.readProgress); assert.deepEqual(after.budget, before.budget);
    assert.deepEqual(after.evidence, []); await f.noExternal();
  });
}

test('stored MCP response: concurrent restorers commit one original-head settlement without additional budget', { timeout: 90000 }, async t => {
  const f = await fixture(t, 'file-journal', 'raw-receipt-complete'); f.clock.advance(f.marker.leaseUntil - f.clock.now() + 1);
  const service = f.core.runtime.readReconciliation; const reconcile = service.reconcile.bind(service);
  service.reconcile = async () => f.current();
  await f.core.runtime.recover(f.marker.workId, f.marker.attemptId); service.reconcile = reconcile;
  const before = await f.current(); const second = new ReadReconciliation(f.core.services, f.core.contracts);
  const states = await Promise.all([reconcile(f.marker.workId, f.marker.attemptId), second.reconcile(f.marker.workId, f.marker.attemptId)]);
  assert.deepEqual(states[0], states[1]); assert.equal(states[0]!.revision, before.revision + 1);
  assert.deepEqual(states[0]!.budget, before.budget); assert.equal(states[0]!.attempts[0]!.readProgress!.phase, 'complete');
  assert.equal((await f.repository.events(f.marker.workId, 0)).filter(event => event.type === 'read_response_reconciled').length, 1);
  await f.noExternal();
});

test('stored MCP response: next workflow step repairs a crash after expiration was committed', { timeout: 90000 }, async t => {
  const f = await fixture(t, 'sqlite', 'raw-receipt-complete'); f.clock.advance(f.marker.leaseUntil - f.clock.now() + 1);
  const commit = f.repository.commit.bind(f.repository);
  f.repository.commit = async request => {
    const result = await commit(request);
    if (request.events.some(event => event.type === 'attempt_recovered')) throw new Error('simulated_ack_loss');
    return result;
  };
  await assert.rejects(f.core.runtime.recover(f.marker.workId, f.marker.attemptId), /simulated_ack_loss/);
  f.repository.commit = commit; await f.reopenOffline();
  const before = await f.current(); assert.equal(before.attempts[0]!.readProgress!.unknownCalls, 1);
  await f.core.runtime.step(f.marker.workId); const after = await f.current();
  assert.equal(after.attempts[0]!.readProgress!.phase, 'complete'); assert.equal(after.attempts[0]!.readProgress!.unknownCalls, 0);
  assert.equal(after.attempts[0]!.adopted, false); assert.deepEqual(after.budget, before.budget); await f.noExternal();
});
