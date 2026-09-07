import assert from 'node:assert/strict';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ArtifactRef, TaskSpec, WorkState } from '../../domain/model.js';
import type { ReadCheckpoint } from '../../domain/read-checkpoint.js';
import { composeRuntime } from '../../application/compose-runtime.js';
import { asJson } from '../../application/plan-validator.js';
import type { RuntimeServices } from '../../application/services.js';
import { AjvSchemas } from '../../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester } from '../../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../../infrastructure/fakes.js';
import { FileArtifactStore } from '../../infrastructure/file-artifacts.js';
import { createMcpReadCollection } from '../../infrastructure/mcp-read-collections.js';
import { McpStdioClient } from '../../infrastructure/mcp-stdio-client.js';
import { command, initial, openRepository, type Adapter } from '../state-conformance-helpers.js';
import { waitCollectionBinding } from './mcp-wait-fixture-binding.js';

export type WaitRecoveryKind = 'whole' | 'item';
export interface McpWaitMarker {
  schemaVersion: 1;
  backend: Adapter;
  kind: WaitRecoveryKind;
  workId: string;
  workerPid: number;
  peerPid: number;
  owner: string;
  parentAttemptId: string;
  successorTaskId: string;
  head: ArtifactRef;
  resume: ArtifactRef;
  checkpointDigest: string;
  stateDigest: string;
  at: number;
  retryAt: number;
  deadlineAt: number;
  revision: number;
  budget: WorkState['budget'];
  calls: ReadCheckpoint['calls'];
  acceptedResponses: number;
  completedItemIds: string[];
}

const directory = process.argv[2];
const backend = process.argv[3];
const kind = process.argv[4];
if (!directory || (backend !== 'sqlite' && backend !== 'file-journal') || (kind !== 'whole' && kind !== 'item'))
  throw new Error('invalid_mcp_wait_worker_arguments');
const family = kind === 'whole' ? 'documents' : 'observations';
const state = openRepository(backend, directory);
const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
const clock = new FakeClock(1000);
const digester = new Sha256Digester();
const planner = new ScriptedPlanner([]);
const owner = 'mcp-wait-before';
const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
const workId = 'mcp-wait-recovery';
const client = new McpStdioClient({ endpointId: 'wait-recovery-fixture', command: process.execPath,
  args: [fileURLToPath(new URL('./mcp-wait-fixture-server.js', import.meta.url)), '--mode', `${kind}-rate-limit`,
    '--retry-after-ms', '2500', '--audit-file', join(directory, 'before-audit.jsonl')],
  cwd: directory, env: { TMPDIR: tmpdir() }, timeoutMs: 10000 });
const services: RuntimeServices = { state, artifacts, clock, digester, planner, sink: new FakeSink(), tools: [], ids: new RandomIds() };

try {
  const binding = waitCollectionBinding(family, { maxCalls: 3 });
  const session = await client.discover([binding.remote], new AbortController().signal);
  const peerPid = client.snapshot().pid; assert.ok(peerPid);
  process.send?.({ kind: 'peer-ready', pid: peerPid });
  const collection = createMcpReadCollection(binding, session, client, services, new AjvSchemas());
  const core = await composeRuntime({ services, schemas: new AjvSchemas(), owner, collectionTools: [collection],
    guidanceSource: { list: async () => [], read: async () => { throw new Error('unused_guidance'); } } });
  assert.ok(core.planning);
  const work = initial(workId); work.policy.allowedTools = [collection.definition.id];
  assert.equal((await state.commit(command(work, 'accept'))).kind, 'committed');
  const first: TaskSpec = { id: 'rate-limited-source', description: 'Read fixed records with an explicit source wait',
    toolId: collection.definition.id, toolVersion: collection.definition.version, input: { ids: ['a', 'b'] },
    effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] };
  const plan = async (task: TaskSpec, id: string) => {
    const current = await core.runtime.state(workId);
    await core.runtime.submitPlan(workId, id, { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
      basePlanRevision: current.plan?.revision ?? 0, reason: 'Host-approved explicit collection continuation', tasks: [task], hypotheses: [] });
  };
  await plan(first, 'plan-parent');
  const reserved = await core.runtime.reserve(workId, first.id);
  await core.runtime.execute(workId, reserved.id); await core.runtime.settlePending(reserved.id); await core.runtime.adopt(workId, reserved.id);
  const settled = await core.runtime.state(workId); const parent = settled.attempts.find(value => value.id === reserved.id)!;
  assert.equal(parent.status, 'partial'); assert.equal(parent.adopted, true); assert.equal(parent.readProgress?.retryAt, 3500);
  const checkpoint = await core.readCheckpoints.read(settled, parent.id, parent.readProgress!.head);
  assert.equal(checkpoint.retryAt, 3500); assert.equal(checkpoint.calls.length, 1);
  assert.equal(checkpoint.calls[0]!.status, kind === 'whole' ? 'deferred' : 'accepted');
  const successor: TaskSpec = { ...first, id: 'resume-after-wait', readResume: { attemptId: parent.id, checkpointId: parent.readProgress!.head.id } };
  await plan(successor, 'plan-explicit-successor');
  const waiting = await core.workflow.run(workId, actor, { maxSteps: 3 });
  assert.equal(waiting.control.kind, 'wait');
  if (waiting.control.kind === 'wait') assert.equal(waiting.control.wakeAt, 3500);
  const current = await core.runtime.state(workId);
  assert.equal(current.status, 'waiting'); assert.equal(current.retryWakeAt, 3500);
  assert.equal(current.attempts.length, 1); assert.equal(current.modelCalls.length, 0); assert.equal(planner.inputs.length, 0);
  assert.equal(current.attempts[0]!.readProgress!.successorAttemptId, null); assert.equal(client.snapshot().toolCalls, 1);
  const marker: McpWaitMarker = { schemaVersion: 1, backend, kind, workId, workerPid: process.pid, peerPid, owner,
    parentAttemptId: parent.id, successorTaskId: successor.id, head: structuredClone(parent.readProgress!.head), resume: waiting.checkpoint,
    checkpointDigest: digester.digest(asJson(checkpoint)), stateDigest: digester.digest(asJson(current)), at: clock.now(), retryAt: 3500,
    deadlineAt: current.deadlineAt, revision: current.revision, budget: structuredClone(current.budget), calls: structuredClone(checkpoint.calls),
    acceptedResponses: checkpoint.collection.calls,
    completedItemIds: [...checkpoint.collection.pages, ...(checkpoint.collection.pending ? [checkpoint.collection.pending] : [])]
      .flatMap(page => page.items.filter(item => item.status === 'success').map(item => item.id)) };
  const fd = openSync(join(directory, 'wait-marker.json'), 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(marker)); fsyncSync(fd); } finally { closeSync(fd); }
  const folder = openSync(directory, 'r'); try { fsyncSync(folder); } finally { closeSync(folder); }
  process.send?.({ kind: 'wait-ready' });
  await new Promise<never>(() => {});
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  try { await client.close(); } finally { await state.close(); }
  process.exitCode = 1;
}
