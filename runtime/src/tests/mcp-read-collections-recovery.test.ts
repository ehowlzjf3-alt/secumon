import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Attempt, TaskSpec } from '../domain/model.js';
import type { ReadCheckpoint } from '../domain/read-checkpoint.js';
import type { RuntimeServices } from '../application/services.js';
import { asJson } from '../application/plan-validator.js';
import { ToolResultSchema } from '../application/contracts.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester, sha256 } from '../infrastructure/digest.js';
import { McpStdioClient } from '../infrastructure/mcp-stdio-client.js';
import { createMcpReadCollection } from '../infrastructure/mcp-read-collections.js';
import { evaluationCodePin } from '../infrastructure/local-evaluation.js';
import { adapters, openRepository, type Adapter } from './state-conformance-helpers.js';
import { collectionBinding } from './helpers/mcp-collection-binding.js';
import type { McpCollectionAudit } from './helpers/mcp-collection-fixture-contracts.js';
import type { McpCollectionCrashMarker, McpCollectionCrashStage } from './helpers/mcp-collection-worker.js';

const evidenceDirectory = process.env['SECUMON_MCPC_EVIDENCE_DIR'];
const codeDigest = evidenceDirectory ? (await evaluationCodePin(process.cwd())).digest : null;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function exited(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() >= deadline) throw new Error('owned_mcp_peer_did_not_exit');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}
async function audit(directory: string, name: 'before' | 'after'): Promise<McpCollectionAudit[]> {
  return (await readFile(join(directory, `${name}-audit.jsonl`), 'utf8')).trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as McpCollectionAudit);
}
async function killedWorker(directory: string, backend: Adapter, stage: McpCollectionCrashStage) {
  const child = fork(new URL('./helpers/mcp-collection-worker.js', import.meta.url), [directory, backend, stage],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout!.resume(); let stderr = ''; let peerPid: number | null = null;
  child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16384); });
  const exit = once(child, 'exit');
  let ready!: () => void;
  const checkpoint = new Promise<void>(resolve => { ready = resolve; });
  const message = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const record = value as { kind?: string; pid?: number };
    if (record.kind === 'peer-ready' && Number.isSafeInteger(record.pid) && record.pid! > 0 && record.pid !== process.pid && record.pid !== child.pid)
      peerPid = record.pid!;
    if (record.kind === 'checkpoint-ready') ready();
  };
  child.on('message', message);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([checkpoint,
      exit.then(([code, signal]) => { throw new Error(`mcp_worker_exited_before_boundary:${String(code)}:${String(signal)}:${stderr}`); }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`mcp_worker_boundary_timeout:${stderr}`)), 30000); })]);
    const marker = JSON.parse(await readFile(join(directory, 'crash-marker.json'), 'utf8')) as McpCollectionCrashMarker;
    assert.equal(marker.schemaVersion, 1); assert.equal(marker.backend, backend); assert.equal(marker.stage, stage);
    assert.equal(marker.workerPid, child.pid); assert.equal(marker.peerPid, peerPid); assert.ok(peerPid);
    assert.equal(marker.workId, 'mcp-collection-recovery'); assert.ok(marker.attemptId && marker.request.requestId);
    assert.equal(marker.callCount, 1); assert.ok(marker.head.id);
    assert.equal(child.kill('SIGKILL'), true);
    const [code, signal] = await exit; assert.equal(code, null, stderr); assert.equal(signal, 'SIGKILL', stderr);
    await exited(peerPid);
    const before = await audit(directory, 'before');
    assert.ok(before.some(row => row.event === 'close' && row.reason === 'stdin-ended'));
    assert.equal(before.filter(row => row.event === 'call').length, marker.serverCalls);
    assert.ok(before.every(row => row.pid === peerPid));
    return { marker, before };
  } finally {
    if (timer) clearTimeout(timer);
    child.off('message', message);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
    if (peerPid !== null && alive(peerPid)) { process.kill(peerPid, 'SIGKILL'); await exited(peerPid); }
  }
}

async function reopened(t: TestContext, backend: Adapter, stage: McpCollectionCrashStage) {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-collection-recovery-'));
  let cleanup = async () => {};
  let successful = false;
  let finalSummary: Record<string, unknown> | null = null;
  let collectEvidence: (() => Promise<Record<string, unknown>>) | null = null;
  t.after(async () => {
    let record: Record<string, unknown> | null = null;
    try {
      await cleanup();
      if (successful && evidenceDirectory && collectEvidence) record = await collectEvidence();
    } finally {
      await rm(directory, { recursive: true, force: true });
      await assert.rejects(stat(directory), { code: 'ENOENT' });
    }
    if (record && evidenceDirectory) {
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(join(evidenceDirectory, `${sha256(t.name).slice(0, 20)}-recovery.json`),
        JSON.stringify({ ...record, tempCleaned: true }, null, 2) + '\n');
    }
  });
  const { marker, before } = await killedWorker(directory, backend, stage);
  const state = openRepository(backend, directory);
  const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
  const clock = new FakeClock(marker.at);
  const digester = new Sha256Digester();
  const owner = 'mcp-collection-worker-after';
  const family = stage === 'partial' ? 'documents' : 'observations';
  const mode = stage === 'partial' ? 'partial' : 'normal';
  const binding = collectionBinding(family, { maxCalls: stage === 'intent' ? 2 : 3 });
  const client = new McpStdioClient({ endpointId: 'collection-recovery-fixture', command: process.execPath,
    args: [fileURLToPath(new URL('./helpers/mcp-collection-fixture-server.js', import.meta.url)), '--mode', mode,
      '--audit-file', join(directory, 'after-audit.jsonl'), '--delay-ms', '350'],
    cwd: directory, env: { TMPDIR: tmpdir() }, timeoutMs: 10000 });
  let peerPid: number | null = null;
  cleanup = async () => {
    try { await client.close(); if (peerPid !== null) await exited(peerPid); } finally { await state.close(); }
  };
  const services: RuntimeServices = { state, artifacts, clock, digester, ids: new RandomIds(), tools: [],
    sink: new FakeSink(), planner: new ScriptedPlanner([]) };
  const session = await client.discover([binding.remote], new AbortController().signal);
  peerPid = client.snapshot().pid; assert.ok(peerPid); assert.notEqual(peerPid, marker.peerPid);
  collectEvidence = async () => {
    const probes = { worker: marker.workerPid, peerBefore: marker.peerPid, peerAfter: peerPid! };
    for (const pid of Object.values(probes))
      assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
    return { schemaVersion: 1, kind: 'mcp_collection_recovery', test: t.name, codeDigest, backend, stage,
      marker, beforeAudit: await audit(directory, 'before'), afterAudit: await audit(directory, 'after'),
      final: finalSummary, transport: client.snapshot(),
      shutdown: { worker: { pid: probes.worker, signal: 'SIGKILL', probe: 'ESRCH' },
        peerBefore: { pid: probes.peerBefore, reason: 'stdin-ended', probe: 'ESRCH' },
        peerAfter: { pid: probes.peerAfter, probe: 'ESRCH' } } };
  };
  const collection = createMcpReadCollection(binding, session, client, services, new AjvSchemas());
  const composed = await composeRuntime({ services, schemas: new AjvSchemas(), owner, enablePlanning: false,
    collectionTools: [collection], guidanceSource: { list: async () => [], read: async () => { throw new Error('unused_guidance'); } } });
  const current = () => composed.runtime.state(marker.workId);
  const checkpoint = async (attempt: Attempt): Promise<ReadCheckpoint> => composed.readCheckpoints.read(await current(), attempt.id, attempt.readProgress!.head);
  const run = async (id: string, parent: Attempt) => {
    const prior = await current();
    const task: TaskSpec = { id, description: 'Explicitly continue the pinned collection after worker recovery',
      toolId: collection.definition.id, toolVersion: collection.definition.version,
      input: { ids: stage === 'partial' ? ['a', 'b'] : ['a', 'b', 'c', 'd'] }, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [],
      readResume: { attemptId: parent.id, checkpointId: parent.readProgress!.head.id } };
    await composed.runtime.submitPlan(marker.workId, `plan:${id}`, { baseStateRevision: prior.revision, baseGoalRevision: prior.goal.revision,
      basePlanRevision: prior.plan?.revision ?? 0, reason: 'Use only the committed collection tip', tasks: [task], hypotheses: [] });
    const reserved = await composed.runtime.reserve(marker.workId, task.id);
    await composed.runtime.execute(marker.workId, reserved.id); await composed.runtime.settlePending(reserved.id);
    await composed.runtime.adopt(marker.workId, reserved.id);
    const finished = await current(); const attempt = finished.attempts.find(value => value.id === reserved.id)!;
    assert.ok(attempt.resultArtifact);
    const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await artifacts.get(attempt.resultArtifact, finished.policy))));
    return { state: finished, attempt, result, checkpoint: await checkpoint(attempt) };
  };
  const recordSuccess = async () => {
    if (!evidenceDirectory) return;
    const latest = await current();
    finalSummary = { revision: latest.revision, deadlineAt: latest.deadlineAt, budget: structuredClone(latest.budget),
      attempts: latest.attempts.map(value => ({ id: value.id, owner: value.owner, status: value.status,
        adopted: value.adopted, readProgress: value.readProgress })) };
    successful = true;
  };
  return { marker, before, directory, state, artifacts, clock, digester, client, composed, current, checkpoint, run, owner, recordSuccess };
}

for (const backend of adapters) for (const stage of ['intent', 'partial', 'page'] as const) {
  test(`${backend}: MCP collection SIGKILL at ${stage} resumes with a new owner and preserves the committed budget and items`, { timeout: 60000 }, async t => {
    const f = await reopened(t, backend, stage); const { marker } = f;
    const stopped = await f.current(); const parent = stopped.attempts.find(value => value.id === marker.attemptId)!;
    assert.equal(parent.owner, marker.owner); assert.notEqual(parent.owner, f.owner);
    assert.equal(parent.status, 'running'); assert.equal(parent.resultArtifact, null); assert.equal(parent.adopted, false);
    assert.equal(stopped.revision, marker.revision); assert.equal(stopped.deadlineAt, marker.deadlineAt);
    assert.deepEqual(stopped.budget, marker.budget);
    assert.equal(parent.readProgress!.remainingCalls, marker.remainingCalls);
    assert.deepEqual(parent.readProgress!.head, marker.head);
    const original = await f.checkpoint(parent);
    assert.equal(f.digester.digest(asJson(original)), marker.checkpointDigest);
    assert.equal(original.calls.length, 1); assert.deepEqual(original.calls[0]!.request, marker.request);
    assert.equal(await f.state.receipt(marker.workId, `receive:${parent.id}`), null);
    assert.equal(f.client.snapshot().toolCalls, 0);
    await assert.rejects(f.composed.runtime.recover(marker.workId, parent.id), /attempt_not_expired/);
    assert.deepEqual(await f.current(), stopped);
    f.clock.advance(marker.leaseUntil - f.clock.now() + 1);
    assert.ok(f.clock.now() < marker.deadlineAt);
    const recovered = await f.composed.runtime.recover(marker.workId, parent.id);
    const terminal = recovered.attempts.find(value => value.id === parent.id)!;
    assert.equal(terminal.status, 'failed'); assert.equal(terminal.effectState, 'none'); assert.equal(terminal.error?.code, 'lease_expired');
    assert.equal(terminal.leaseUntil, marker.leaseUntil); assert.equal(recovered.deadlineAt, marker.deadlineAt);
    assert.equal(recovered.budget.used.toolCalls, 1); assert.equal(recovered.budget.reservedToolCalls, 0);
    assert.equal(recovered.obligations.some(value => value.kind === 'effect_reconciliation' && value.status === 'pending'), false);
    const resumed = await f.run('after-crash', terminal);
    assert.equal(resumed.attempt.owner, f.owner); assert.equal(resumed.attempt.adopted, true);
    assert.equal(resumed.checkpoint.operationId, original.operationId); assert.equal(resumed.checkpoint.rootAttemptId, original.rootAttemptId);
    assert.deepEqual(resumed.checkpoint.parent, { attemptId: terminal.id, checkpoint: marker.head });
    assert.equal(resumed.state.attempts.find(value => value.id === terminal.id)!.readProgress!.successorAttemptId, resumed.attempt.id);
    assert.equal(resumed.checkpoint.calls.length, 2);
    assert.notEqual(resumed.checkpoint.calls[1]!.request.requestId, marker.request.requestId);
    assert.equal(resumed.state.budget.used.toolCalls, 2); assert.equal(resumed.state.budget.reservedToolCalls, 0);
    assert.equal(resumed.state.deadlineAt, marker.deadlineAt); assert.equal(resumed.state.modelCalls.length, 0);
    const calls = (await audit(f.directory, 'after')).filter(row => row.event === 'call');
    assert.equal(calls.length, 1); assert.equal(f.client.snapshot().toolCalls, 1);
    assert.equal(calls[0]!.requestId, resumed.checkpoint.calls[1]!.request.requestId);
    if (stage === 'intent') {
      assert.equal(marker.serverCalls, 0); assert.equal(marker.acceptedResponses, 0);
      assert.deepEqual(original.calls.map(call => call.status), ['intent']);
      assert.deepEqual(resumed.checkpoint.calls.map(call => call.status), ['unknown', 'accepted']);
      assert.equal(resumed.checkpoint.calls[0]!.errorCode, 'read_response_unknown'); assert.equal(resumed.checkpoint.calls[0]!.response, null);
      assert.equal(resumed.checkpoint.collection.calls, 1); assert.equal(resumed.attempt.readProgress!.unknownCalls, 1);
      assert.equal(resumed.attempt.readProgress!.remainingCalls, 0); assert.equal(resumed.result.status, 'partial');
      assert.equal(resumed.checkpoint.stopReason, 'read_call_limit');
      assert.deepEqual(calls[0]!.retryIds, null); assert.equal(calls[0]!.cursor, null);
      const limited = await f.run('explicit-resume-with-no-budget', resumed.attempt);
      assert.equal(limited.result.status, 'partial'); assert.equal(limited.checkpoint.stopReason, 'read_call_limit');
      assert.deepEqual(limited.checkpoint.calls, resumed.checkpoint.calls); assert.deepEqual(limited.checkpoint.collection, resumed.checkpoint.collection);
      assert.equal(limited.attempt.readProgress!.remainingCalls, 0);
      assert.equal(f.client.snapshot().toolCalls, 1); assert.equal((await audit(f.directory, 'after')).filter(row => row.event === 'call').length, 1);
    } else {
      assert.equal(marker.serverCalls, 1); assert.equal(marker.acceptedResponses, 1);
      assert.deepEqual(resumed.checkpoint.calls[0], original.calls[0]);
      assert.equal(resumed.result.status, 'success'); assert.equal(resumed.checkpoint.collection.exhausted, true);
      assert.equal(resumed.attempt.readProgress!.unknownCalls, 0); assert.equal(resumed.attempt.readProgress!.remainingCalls, 1);
      const originals = [...original.collection.pages, ...(original.collection.pending ? [original.collection.pending] : [])]
        .flatMap(page => page.items.filter(item => item.status === 'success'));
      const currentItems = resumed.checkpoint.collection.pages.flatMap(page => page.items);
      for (const item of originals) {
        assert.deepEqual(currentItems.find(value => value.id === item.id), item);
        assert.ok(item.evidence.length); assert.equal(item.evidence[0]!.observedAt, 900);
        assert.equal(item.evidence[0]!.recordedAt, marker.at);
        assert.ok(item.evidence[0]!.artifact && await f.artifacts.exists(item.evidence[0]!.artifact));
      }
      const returned = (await audit(f.directory, 'after')).filter(row => row.event === 'handler-ready').flatMap(row => row.returnedIds ?? []);
      if (stage === 'partial') {
        assert.deepEqual(marker.completedItemIds, ['a']); assert.deepEqual(calls[0]!.retryIds, ['b']); assert.equal(calls[0]!.cursor, null);
        assert.deepEqual(returned, ['b']); assert.equal(currentItems.length, 2);
        assert.equal(calls[0]!.snapshot, original.collection.snapshot);
      } else {
        assert.deepEqual(marker.completedItemIds, ['a', 'b']); assert.deepEqual(calls[0]!.retryIds, null);
        assert.equal(calls[0]!.cursor, original.collection.nextCursor); assert.ok(calls[0]!.cursor);
        assert.equal(calls[0]!.snapshot, original.collection.snapshot); assert.deepEqual(returned, ['c', 'd']); assert.equal(currentItems.length, 4);
      }
    }
    await f.recordSuccess();
  });
}
