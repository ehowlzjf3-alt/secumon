import assert from 'node:assert/strict';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ArtifactRef, TaskSpec, WorkState } from '../../domain/model.js';
import type { ReadRequest } from '../../domain/read-collection.js';
import { composeRuntime } from '../../application/compose-runtime.js';
import { asJson } from '../../application/plan-validator.js';
import { ReadCheckpointReader } from '../../application/read-checkpoint-store.js';
import type { RuntimeServices } from '../../application/services.js';
import { AjvSchemas } from '../../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester } from '../../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../../infrastructure/fakes.js';
import { FileArtifactStore } from '../../infrastructure/file-artifacts.js';
import { createMcpReadCollection } from '../../infrastructure/mcp-read-collections.js';
import { McpStdioClient, type McpSession } from '../../infrastructure/mcp-stdio-client.js';
import { command, initial, openRepository, type Adapter } from '../state-conformance-helpers.js';
import { collectionBinding } from './mcp-collection-binding.js';
import { waitCollectionBinding } from './mcp-wait-fixture-binding.js';

export type McpSettlementStage = 'raw-receipt-complete' | 'raw-receipt-nonfinal' | 'raw-receipt-deferral';
export interface McpSettlementMarker {
  schemaVersion: 1; backend: Adapter; stage: McpSettlementStage; workId: string;
  workerPid: number; peerPid: number; owner: string; attemptId: string; session: McpSession;
  at: number; leaseUntil: number; deadlineAt: number; revision: number; stateDigest: string;
  head: ArtifactRef; checkpointDigest: string; request: ReadRequest;
  responseCommandId: string; responseDigest: string; responseArtifact: ArtifactRef; receivedAt: number;
  budget: WorkState['budget']; maxCalls: number; remainingCalls: number; serverCalls: number;
  retryAt: number | null;
}

const directory = process.argv[2]; const backend = process.argv[3]; const stage = process.argv[4];
if (!directory || (backend !== 'sqlite' && backend !== 'file-journal') ||
  !['raw-receipt-complete', 'raw-receipt-nonfinal', 'raw-receipt-deferral'].includes(stage ?? ''))
  throw new Error('invalid_mcp_settlement_worker_arguments');
const selected = stage as McpSettlementStage; const deferral = selected === 'raw-receipt-deferral';
const state = openRepository(backend, directory); const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
const clock = new FakeClock(1000); const digester = new Sha256Digester();
const workId = 'mcp-settlement-recovery'; const owner = 'mcp-settlement-before';
const client = new McpStdioClient({ endpointId: 'settlement-recovery-fixture', command: process.execPath,
  args: [fileURLToPath(new URL(deferral ? './mcp-wait-fixture-server.js' : './mcp-collection-fixture-server.js', import.meta.url)),
    '--mode', deferral ? 'whole-rate-limit' : 'normal', '--audit-file', join(directory, 'before-audit.jsonl'), '--delay-ms', '350',
    ...(deferral ? ['--retry-after-ms', '45000'] : [])],
  cwd: directory, env: { TMPDIR: tmpdir() }, timeoutMs: 10000 });
const services: RuntimeServices = { state, artifacts, clock, digester, ids: new RandomIds(), tools: [],
  planner: new ScriptedPlanner([]), sink: new FakeSink() };
let attemptId = ''; let session: McpSession | null = null; let peerPid: number | null = null;

async function marker(current: WorkState, commandId: string): Promise<never> {
  const attempt = current.attempts.find(value => value.id === attemptId);
  assert.ok(attempt?.readProgress && peerPid && session); assert.equal(attempt.status, 'running');
  assert.equal(attempt.resultArtifact, null); assert.equal(attempt.adopted, false);
  const checkpoint = await new ReadCheckpointReader(current, artifacts, digester).load(attempt.readProgress.head);
  assert.equal(checkpoint.calls.length, 1); assert.equal(checkpoint.calls[0]!.status, 'intent');
  assert.equal(checkpoint.calls[0]!.response, null); assert.equal(checkpoint.collection.calls, 0);
  const receipt = await state.receipt(workId, commandId); assert.ok(receipt);
  const raw = receipt.state.artifacts.at(-1); assert.ok(raw);
  const envelope = JSON.parse(new TextDecoder().decode(await artifacts.get(raw, current.policy))) as {
    kind: string; request: ReadRequest; recordedAt: number; transportCalls: number; failure: unknown;
  };
  assert.equal(envelope.kind, 'mcp_collection_response'); assert.equal(envelope.failure, null);
  assert.equal(envelope.transportCalls, 1); assert.deepEqual(envelope.request, checkpoint.calls[0]!.request);
  const rows = (await readFile(join(directory!, 'before-audit.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { event: string; pid: number });
  assert.equal(rows.filter(row => row.event === 'call').length, 1);
  assert.ok(rows.some(row => row.event === 'response-sent')); assert.ok(rows.every(row => row.pid === peerPid));
  const value: McpSettlementMarker = { schemaVersion: 1, backend: backend as Adapter, stage: selected, workId,
    workerPid: process.pid, peerPid, owner, attemptId, session: structuredClone(session), at: clock.now(),
    leaseUntil: attempt.leaseUntil, deadlineAt: current.deadlineAt, revision: current.revision,
    stateDigest: digester.digest(asJson(current)), head: structuredClone(attempt.readProgress.head),
    checkpointDigest: digester.digest(asJson(checkpoint)), request: structuredClone(checkpoint.calls[0]!.request),
    responseCommandId: commandId, responseDigest: receipt.digest, responseArtifact: structuredClone(raw), receivedAt: envelope.recordedAt,
    budget: structuredClone(current.budget), maxCalls: checkpoint.limits.maxCalls,
    remainingCalls: checkpoint.limits.maxCalls - checkpoint.calls.length, serverCalls: 1,
    retryAt: deferral ? envelope.recordedAt + 45000 : null };
  const fd = openSync(join(directory!, 'settlement-marker.json'), 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  const folder = openSync(directory!, 'r'); try { fsyncSync(folder); } finally { closeSync(folder); }
  process.send?.({ kind: 'raw-receipt-ready' });
  return new Promise<never>(() => {});
}

try {
  const binding = deferral ? waitCollectionBinding('documents', { maxCalls: 3 }) :
    collectionBinding(selected === 'raw-receipt-complete' ? 'documents' : 'observations', { maxCalls: 3 });
  session = await client.discover([binding.remote], new AbortController().signal);
  peerPid = client.snapshot().pid; assert.ok(peerPid); process.send?.({ kind: 'peer-ready', pid: peerPid });
  const collection = createMcpReadCollection(binding, session, client, services, new AjvSchemas());
  const work = initial(workId); work.policy.allowedTools = [collection.definition.id];
  assert.equal((await state.commit(command(work, 'accept'))).kind, 'committed');
  const core = await composeRuntime({ services, schemas: new AjvSchemas(), owner, collectionTools: [collection],
    guidanceSource: { list: async () => [], read: async () => { throw new Error('unused_guidance'); } } });
  const task: TaskSpec = { id: 'before-interruption', description: 'Read records until the raw response receipt is durable',
    toolId: collection.definition.id, toolVersion: collection.definition.version,
    input: { ids: selected === 'raw-receipt-nonfinal' ? ['a', 'b', 'c', 'd'] : ['a', 'b'] },
    effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] };
  const before = await core.runtime.state(workId);
  await core.runtime.submitPlan(workId, 'plan-before-interruption', { baseStateRevision: before.revision,
    baseGoalRevision: before.goal.revision, basePlanRevision: before.plan?.revision ?? 0,
    reason: 'Expose the response receipt before normalization and checkpoint settlement', tasks: [task], hypotheses: [] });
  attemptId = (await core.runtime.reserve(workId, task.id)).id;
  const commit = state.commit.bind(state);
  state.commit = async request => {
    const result = await commit(request);
    if (result.kind === 'committed' && request.events.some(event => event.type === 'mcp_collection_response_recorded'))
      await marker(result.state, request.commandId);
    return result;
  };
  await core.runtime.execute(workId, attemptId); await core.runtime.settlePending(attemptId);
  throw new Error('mcp_settlement_boundary_not_reached');
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  try { await client.close(); } finally { await state.close(); }
  process.exitCode = 1;
}
