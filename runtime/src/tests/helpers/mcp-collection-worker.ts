import assert from 'node:assert/strict';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ArtifactRef, WorkState, TaskSpec } from '../../domain/model.js';
import type { ReadRequest } from '../../domain/read-collection.js';
import type { RuntimeServices } from '../../application/services.js';
import { composeRuntime } from '../../application/compose-runtime.js';
import { asJson } from '../../application/plan-validator.js';
import { ReadCheckpointReader } from '../../application/read-checkpoint-store.js';
import { AjvSchemas } from '../../infrastructure/ajv-schemas.js';
import { FileArtifactStore } from '../../infrastructure/file-artifacts.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../../infrastructure/digest.js';
import { McpStdioClient } from '../../infrastructure/mcp-stdio-client.js';
import { createMcpReadCollection } from '../../infrastructure/mcp-read-collections.js';
import { command, initial, openRepository, type Adapter } from '../state-conformance-helpers.js';
import { collectionBinding } from './mcp-collection-binding.js';
import type { McpCollectionAudit } from './mcp-collection-fixture-contracts.js';

export type McpCollectionCrashStage = 'intent' | 'partial' | 'page';
export interface McpCollectionCrashMarker {
  schemaVersion: 1;
  backend: Adapter;
  stage: McpCollectionCrashStage;
  workId: string;
  workerPid: number;
  peerPid: number;
  owner: string;
  attemptId: string;
  at: number;
  leaseUntil: number;
  deadlineAt: number;
  revision: number;
  head: ArtifactRef;
  checkpointDigest: string;
  request: ReadRequest;
  budget: WorkState['budget'];
  maxCalls: number;
  remainingCalls: number;
  callCount: number;
  acceptedResponses: number;
  completedItemIds: string[];
  serverCalls: number;
}

const directory = process.argv[2];
const backend = process.argv[3];
const stage = process.argv[4];
if (!directory || (backend !== 'sqlite' && backend !== 'file-journal') || !['intent', 'partial', 'page'].includes(stage ?? ''))
  throw new Error('invalid_mcp_collection_worker_arguments');
const selectedStage = stage as McpCollectionCrashStage;
const family = selectedStage === 'partial' ? 'documents' : 'observations';
const mode = selectedStage === 'partial' ? 'partial' : 'normal';
const query = { ids: selectedStage === 'partial' ? ['a', 'b'] : ['a', 'b', 'c', 'd'] };
const maxCalls = selectedStage === 'intent' ? 2 : 3;
const owner = 'mcp-collection-worker-before';
const workId = 'mcp-collection-recovery';
const state = openRepository(backend, directory);
const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
const clock = new FakeClock(1000);
const digester = new Sha256Digester();
const client = new McpStdioClient({ endpointId: 'collection-recovery-fixture', command: process.execPath,
  args: [fileURLToPath(new URL('./mcp-collection-fixture-server.js', import.meta.url)), '--mode', mode,
    '--audit-file', join(directory, 'before-audit.jsonl'), '--delay-ms', '350'],
  cwd: directory, env: { TMPDIR: tmpdir() }, timeoutMs: 10000 });
const services: RuntimeServices = { state, artifacts, clock, digester, ids: new RandomIds(), tools: [],
  sink: new FakeSink(), planner: new ScriptedPlanner([]) };
let attemptId = '';
let peerPid: number | null = null;

async function mark(current: WorkState): Promise<never> {
  const attempt = current.attempts.find(value => value.id === attemptId);
  assert.ok(attempt?.readProgress && peerPid);
  const checkpoint = await new ReadCheckpointReader(current, artifacts, digester).load(attempt.readProgress.head);
  const request = checkpoint.calls.at(-1)?.request;
  assert.ok(request);
  const rows = (await readFile(join(directory!, 'before-audit.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as McpCollectionAudit);
  const marker: McpCollectionCrashMarker = { schemaVersion: 1, backend: backend as Adapter, stage: selectedStage,
    workId, workerPid: process.pid, peerPid, owner, attemptId, at: clock.now(), leaseUntil: attempt.leaseUntil,
    deadlineAt: current.deadlineAt, revision: current.revision, head: structuredClone(attempt.readProgress.head),
    checkpointDigest: digester.digest(asJson(checkpoint)), request: structuredClone(request), callCount: checkpoint.calls.length,
    budget: structuredClone(current.budget), maxCalls: checkpoint.limits.maxCalls,
    remainingCalls: checkpoint.limits.maxCalls - checkpoint.calls.length,
    acceptedResponses: checkpoint.collection.calls,
    completedItemIds: [...checkpoint.collection.pages, ...(checkpoint.collection.pending ? [checkpoint.collection.pending] : [])]
      .flatMap(page => page.items.filter(item => item.status === 'success').map(item => item.id)),
    serverCalls: rows.filter(row => row.event === 'call').length };
  const fd = openSync(join(directory!, 'crash-marker.json'), 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(marker)); fsyncSync(fd); } finally { closeSync(fd); }
  const folder = openSync(directory!, 'r');
  try { fsyncSync(folder); } finally { closeSync(folder); }
  process.send?.({ kind: 'checkpoint-ready' });
  return new Promise<never>(() => {});
}

try {
  const binding = collectionBinding(family, { maxCalls });
  const session = await client.discover([binding.remote], new AbortController().signal);
  peerPid = client.snapshot().pid;
  assert.ok(peerPid);
  process.send?.({ kind: 'peer-ready', pid: peerPid });
  const collection = createMcpReadCollection(binding, session, client, services, new AjvSchemas());
  const work = initial(workId);
  work.policy.allowedTools = [collection.definition.id];
  work.budget.limits.replans = 10;
  assert.equal((await state.commit(command(work, 'accept'))).kind, 'committed');
  const composed = await composeRuntime({ services, schemas: new AjvSchemas(), owner, enablePlanning: false,
    collectionTools: [collection], guidanceSource: { list: async () => [], read: async () => { throw new Error('unused_guidance'); } } });
  const task: TaskSpec = { id: 'before-crash', description: 'Read the fixed collection before a controlled worker interruption',
    toolId: collection.definition.id, toolVersion: collection.definition.version, input: query, effect: 'read',
    dependsOn: [], maxAttempts: 1, satisfies: [] };
  const before = await composed.runtime.state(workId);
  await composed.runtime.submitPlan(workId, 'plan-before-crash', { baseStateRevision: before.revision,
    baseGoalRevision: before.goal.revision, basePlanRevision: before.plan?.revision ?? 0,
    reason: 'Pin the collection and expose one committed recovery boundary', tasks: [task], hypotheses: [] });
  const reserved = await composed.runtime.reserve(workId, task.id);
  attemptId = reserved.id;
  const commit = state.commit.bind(state);
  state.commit = async request => {
    const result = await commit(request);
    if (result.kind === 'committed' && request.events.some(event => event.type === 'read_checkpoint_committed')) {
      const progress = result.state.attempts.find(value => value.id === attemptId)?.readProgress;
      const selected = progress?.callCount === 1 && (
        selectedStage === 'intent' && progress.phase === 'running' && progress.unknownCalls === 1 ||
        selectedStage === 'partial' && progress.phase === 'partial' && progress.completedItems === 1 && progress.pendingItems === 1 ||
        selectedStage === 'page' && progress.phase === 'running' && progress.completedPages === 1 && progress.unknownCalls === 0);
      if (selected) await mark(result.state);
    }
    return result;
  };
  await composed.runtime.execute(workId, attemptId);
  await composed.runtime.settlePending(attemptId);
  throw new Error('mcp_collection_crash_boundary_not_reached');
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  try { await client.close(); } finally { await state.close(); }
  process.exitCode = 1;
}
