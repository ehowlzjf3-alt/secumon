import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { composeRuntime } from '../application/compose-runtime.js';
import { asJson } from '../application/plan-validator.js';
import { ToolResultSchema } from '../application/contracts.js';
import type { RuntimeServices } from '../application/services.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester, sha256 } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { evaluationCodePin } from '../infrastructure/local-evaluation.js';
import { createMcpReadCollection } from '../infrastructure/mcp-read-collections.js';
import { McpStdioClient } from '../infrastructure/mcp-stdio-client.js';
import { adapters, openRepository, type Adapter } from './state-conformance-helpers.js';
import { waitCollectionBinding } from './helpers/mcp-wait-fixture-binding.js';
import type { McpWaitAudit } from './helpers/mcp-wait-fixture-contracts.js';
import type { McpWaitMarker, WaitRecoveryKind } from './helpers/mcp-wait-worker.js';

const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
const evidenceDirectory = process.env['SECUMON_MCPW_EVIDENCE_DIR'];
const codeDigest = evidenceDirectory ? (await evaluationCodePin(process.cwd())).digest : null;
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function exited(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (alive(pid)) {
    if (Date.now() >= deadline) throw new Error('owned_wait_peer_did_not_exit');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}
async function audit(directory: string, label: 'before' | 'after'): Promise<McpWaitAudit[]> {
  return (await readFile(join(directory, `${label}-audit.jsonl`), 'utf8')).trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as McpWaitAudit);
}
async function stoppedWorker(directory: string, backend: Adapter, kind: WaitRecoveryKind): Promise<McpWaitMarker> {
  const child = fork(new URL('./helpers/mcp-wait-worker.js', import.meta.url), [directory, backend, kind],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout!.resume(); let stderr = ''; let peerPid: number | null = null;
  child.stderr!.on('data', value => { stderr = (stderr + String(value)).slice(-16384); });
  const exit = once(child, 'exit'); let ready!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const message = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const record = value as { kind?: string; pid?: number };
    if (record.kind === 'peer-ready' && Number.isSafeInteger(record.pid) && record.pid! > 0 && record.pid !== child.pid && record.pid !== process.pid) peerPid = record.pid!;
    if (record.kind === 'wait-ready') ready();
  };
  child.on('message', message); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([waiting,
      exit.then(([code, signal]) => { throw new Error(`wait_worker_exited_before_marker:${String(code)}:${String(signal)}:${stderr}`); }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`wait_worker_timeout:${stderr}`)), 30000); })]);
    const marker = JSON.parse(await readFile(join(directory, 'wait-marker.json'), 'utf8')) as McpWaitMarker;
    assert.equal(marker.schemaVersion, 1); assert.equal(marker.backend, backend); assert.equal(marker.kind, kind);
    assert.equal(marker.workerPid, child.pid); assert.equal(marker.peerPid, peerPid); assert.ok(peerPid);
    assert.equal(child.kill('SIGKILL'), true); const [code, signal] = await exit;
    assert.equal(code, null, stderr); assert.equal(signal, 'SIGKILL', stderr);
    await exited(peerPid); assert.equal(alive(marker.workerPid), false);
    const before = await audit(directory, 'before');
    assert.ok(before.every(row => row.pid === peerPid)); assert.equal(before.filter(row => row.event === 'call').length, 1);
    assert.ok(before.some(row => row.event === 'close' && row.reason === 'stdin-ended'));
    return marker;
  } finally {
    if (timer) clearTimeout(timer); child.off('message', message);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
    if (peerPid !== null && alive(peerPid)) { process.kill(peerPid, 'SIGKILL'); await exited(peerPid); }
  }
}

async function fixture(t: TestContext, backend: Adapter, kind: WaitRecoveryKind) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-mcp-wait-recovery-'));
  let cleanup = async () => {}; let evidence: (() => Promise<Record<string, unknown>>) | null = null; let passed = false;
  t.after(async () => {
    let record: Record<string, unknown> | null = null;
    try { await cleanup(); if (passed && evidenceDirectory && evidence) record = await evidence(); }
    finally { await rm(directory, { recursive: true, force: true }); await assert.rejects(stat(directory), { code: 'ENOENT' }); }
    if (record && evidenceDirectory) { await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(join(evidenceDirectory, `${sha256(t.name).slice(0, 20)}-wait-recovery.json`), JSON.stringify({ ...record, tempCleaned: true }, null, 2) + '\n'); }
  });
  const marker = await stoppedWorker(directory, backend, kind);
  let repository = openRepository(backend, directory);
  const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
  const digester = new Sha256Digester(); const clock = new FakeClock(marker.at); const planner = new ScriptedPlanner([]);
  const client = new McpStdioClient({ endpointId: 'wait-recovery-fixture', command: process.execPath,
    args: [fileURLToPath(new URL('./helpers/mcp-wait-fixture-server.js', import.meta.url)), '--mode', kind === 'whole' ? 'normal' : 'item-rate-limit',
      '--retry-after-ms', '2500', '--audit-file', join(directory, 'after-audit.jsonl')],
    cwd: directory, env: { TMPDIR: tmpdir() }, timeoutMs: 10000 });
  let peerPid: number | null = null;
  cleanup = async () => { try { await client.close(); if (peerPid !== null) await exited(peerPid); } finally { await repository.close(); } };
  const services: RuntimeServices = { state: repository, artifacts, digester, clock, planner, sink: new FakeSink(), tools: [], ids: new RandomIds() };
  const binding = waitCollectionBinding(kind === 'whole' ? 'documents' : 'observations', { maxCalls: 3 });
  const session = await client.discover([binding.remote], new AbortController().signal);
  peerPid = client.snapshot().pid; assert.ok(peerPid); assert.notEqual(peerPid, marker.peerPid);
  const source = createMcpReadCollection(binding, session, client, services, new AjvSchemas()); let generation = 0;
  const compose = () => composeRuntime({ services, schemas: new AjvSchemas(), owner: `mcp-wait-after-${++generation}`, collectionTools: [source],
    guidanceSource: { list: async () => [], read: async () => { throw new Error('unused_guidance'); } } });
  let core = await compose(); assert.ok(core.planning);
  const current = () => core.runtime.state(marker.workId);
  const reopen = async () => { await repository.close(); repository = openRepository(backend, directory); services.state = repository; core = await compose(); };
  let summary: Record<string, unknown> | null = null;
  evidence = async () => {
    const pids = { worker: marker.workerPid, peerBefore: marker.peerPid, peerAfter: peerPid! };
    for (const pid of Object.values(pids)) assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
    return { schemaVersion: 1, kind: 'mcp_wait_recovery', test: t.name, backend, waitKind: kind, codeDigest, marker,
      beforeAudit: await audit(directory, 'before'), afterAudit: await audit(directory, 'after'), transport: client.snapshot(),
      shutdown: { pids, probe: 'ESRCH' }, hostScheduling: 'FakeClock and explicit runnable/workflow calls; no background daemon', final: summary };
  };
  return { marker, directory, clock, digester, artifacts, planner, client, current, reopen,
    get core() { return core; }, get repository() { return repository; },
    recordSuccess: async () => { const latest = await current(); summary = { revision: latest.revision, retryWakeAt: latest.retryWakeAt,
      deadlineAt: latest.deadlineAt, budget: latest.budget, attempts: latest.attempts.map(attempt => ({ id: attempt.id, owner: attempt.owner,
        status: attempt.status, adopted: attempt.adopted, readProgress: attempt.readProgress })) }; passed = true; } };
}

for (const backend of adapters) for (const kind of ['whole', 'item'] as const) {
  test(`${backend}: MCP ${kind} wait survives SIGKILL and reopens without resetting its due time or consuming an early successor`, { timeout: 60000 }, async t => {
    const f = await fixture(t, backend, kind); const { marker } = f; const stopped = await f.current();
    assert.equal(f.digester.digest(asJson(stopped)), marker.stateDigest); assert.equal(stopped.revision, marker.revision);
    assert.equal(stopped.status, 'waiting'); assert.equal(stopped.retryWakeAt, 3500); assert.equal(marker.retryAt, marker.at + 2500);
    assert.deepEqual(stopped.budget, marker.budget); assert.equal(stopped.attempts.length, 1);
    const original = await f.core.readCheckpoints.read(stopped, marker.parentAttemptId, marker.head);
    assert.equal(f.digester.digest(asJson(original)), marker.checkpointDigest); assert.equal(original.retryAt, marker.retryAt);
    assert.equal(original.calls[0]!.status, kind === 'whole' ? 'deferred' : 'accepted');
    assert.deepEqual(marker.completedItemIds, kind === 'whole' ? [] : ['a']);
    const beforeProgress = structuredClone(stopped.progress);
    const noAllocation = async () => {
      assert.deepEqual(await f.repository.runnable(f.clock.now()), []);
      for (let index = 0; index < 2; index++) {
        const result = await f.core.workflow.run(marker.workId, actor, { maxSteps: 3, previousPacket: marker.resume });
        assert.equal(result.control.kind, 'wait'); if (result.control.kind === 'wait') assert.equal(result.control.wakeAt, marker.retryAt);
      }
      await assert.rejects(f.core.runtime.reserve(marker.workId, marker.successorTaskId));
      await assert.rejects(f.core.planning!.reserve(marker.workId));
      const state = await f.current();
      assert.equal(state.retryWakeAt, marker.retryAt); assert.equal(state.attempts.length, 1);
      assert.equal(state.attempts[0]!.readProgress!.retryAt, marker.retryAt); assert.equal(state.attempts[0]!.readProgress!.successorAttemptId, null);
      assert.equal(state.modelCalls.length, 0); assert.equal(f.planner.inputs.length, 0); assert.equal(f.client.snapshot().toolCalls, 0);
      assert.deepEqual(state.budget, marker.budget); assert.deepEqual(state.progress, beforeProgress);
      assert.equal(state.deadlineAt, marker.deadlineAt);
    };
    await noAllocation(); f.clock.advance(1000); await f.reopen(); await noAllocation();
    f.clock.advance(marker.retryAt - f.clock.now() - 1); await noAllocation();
    const beforeDue = await f.current(); await f.reopen(); assert.deepEqual(await f.current(), beforeDue);
    f.clock.advance(1); assert.equal(f.clock.now(), marker.retryAt);
    assert.deepEqual(await f.repository.runnable(f.clock.now()), [marker.workId]);
    // The host explicitly drives the due candidate; the runtime does not start a timer daemon.
    await f.core.workflow.run(marker.workId, actor, { maxSteps: 3, previousPacket: marker.resume,
      onStep: async () => { for (const id of f.core.runtime.pendingExecutions()) await f.core.runtime.settlePending(id); } });
    const finished = await f.current(); assert.equal(finished.attempts.length, 2);
    const parent = finished.attempts.find(attempt => attempt.id === marker.parentAttemptId)!;
    const child = finished.attempts.find(attempt => attempt.id !== marker.parentAttemptId)!;
    assert.equal(parent.readProgress!.successorAttemptId, child.id); assert.equal(child.adopted, true); assert.equal(child.status, 'succeeded');
    assert.notEqual(child.owner, marker.owner); assert.ok(child.resultArtifact); assert.equal(child.readProgress!.retryAt ?? null, null);
    const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await f.artifacts.get(child.resultArtifact, finished.policy))));
    assert.equal(result.status, 'success'); assert.equal(result.usage?.transportCalls, 1);
    const resumed = await f.core.readCheckpoints.read(finished, child.id, child.readProgress!.head);
    assert.equal(resumed.operationId, original.operationId); assert.equal(resumed.rootAttemptId, original.rootAttemptId);
    assert.deepEqual(resumed.parent, { attemptId: marker.parentAttemptId, checkpoint: marker.head });
    assert.deepEqual(resumed.calls[0], original.calls[0]); assert.equal(resumed.calls.length, 2);
    assert.notEqual(resumed.calls[1]!.request.requestId, marker.calls[0]!.request.requestId);
    assert.equal(resumed.calls[1]!.dispatchedAt, marker.retryAt); assert.equal(resumed.calls[1]!.receivedAt, marker.retryAt);
    assert.equal(resumed.collection.calls, kind === 'whole' ? 1 : 2); assert.equal(child.readProgress!.remainingCalls, 1);
    assert.equal(finished.budget.used.toolCalls, 2); assert.equal(finished.budget.reservedToolCalls, 0);
    assert.equal(finished.budget.used.replans, marker.budget.used.replans); assert.equal(finished.deadlineAt, marker.deadlineAt);
    assert.equal(finished.modelCalls.length, 0); assert.equal(f.planner.inputs.length, 0);
    const calls = (await audit(f.directory, 'after')).filter(row => row.event === 'call');
    assert.equal(calls.length, 1); assert.equal(f.client.snapshot().toolCalls, 1);
    assert.deepEqual(calls[0]!.retryIds, kind === 'whole' ? null : ['b']);
    assert.equal(calls[0]!.requestId, resumed.calls[1]!.request.requestId);
    const earlier = [...original.collection.pages, ...(original.collection.pending ? [original.collection.pending] : [])]
      .flatMap(page => page.items.filter(item => item.status === 'success'));
    const items = resumed.collection.pages.flatMap(page => page.items); assert.equal(items.length, 2);
    for (const item of earlier) {
      assert.deepEqual(items.find(value => value.id === item.id), item);
      assert.ok(item.evidence.length); assert.equal(item.evidence[0]!.observedAt, 900); assert.equal(item.evidence[0]!.recordedAt, marker.at);
    }
    for (const item of items.filter(value => !earlier.some(prior => prior.id === value.id))) {
      assert.equal(item.evidence[0]!.observedAt, 900); assert.equal(item.evidence[0]!.recordedAt, marker.retryAt);
    }
    const stable = await f.current(); await f.reopen();
    assert.deepEqual(await f.current(), stable); assert.equal(f.client.snapshot().toolCalls, 1);
    await f.core.readCheckpoints.read(stable, child.id, child.readProgress!.head);
    await f.recordSuccess();
  });
}
