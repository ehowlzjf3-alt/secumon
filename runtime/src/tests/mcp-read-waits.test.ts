import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Attempt, TaskSpec, ToolResult } from '../domain/model.js';
import type { ReadDeferral, ReadItem } from '../domain/read-collection.js';
import type { RuntimeServices } from '../application/services.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { ToolBroker } from '../application/tool-broker.js';
import { asJson } from '../application/plan-validator.js';
import { ReadCheckpointReader } from '../application/read-checkpoint-store.js';
import { transact } from '../application/work-transactions.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { Sha256Digester, RandomIds } from '../infrastructure/digest.js';
import { McpStdioClient } from '../infrastructure/mcp-stdio-client.js';
import { createMcpReadCollection } from '../infrastructure/mcp-read-collections.js';
import { collectionBinding } from './helpers/mcp-collection-binding.js';
import { waitCollectionBinding, type WaitCollectionFamily } from './helpers/mcp-wait-fixture-binding.js';
import { MCPW_INVALID_CASES, type McpWaitAudit, type McpWaitMode, type McpWaitInvalidCase } from './helpers/mcp-wait-fixture-contracts.js';
import { adapters, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const items = (value: ToolResult) => (value.output as { items: unknown }).items as ReadItem[];
async function setup(t: TestContext, adapter: Adapter, family: WaitCollectionFamily, mode: McpWaitMode,
  invalid: McpWaitInvalidCase = 'negative', maxDelayMs?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-mcp-waits-')); let repository = openRepository(adapter, directory);
  const auditPath = join(directory, 'audit.jsonl');
  const client = new McpStdioClient({ endpointId: 'synthetic-waits', command: process.execPath,
    args: [fileURLToPath(new URL('./helpers/mcp-wait-fixture-server.js', import.meta.url)), '--audit-file', auditPath,
      '--mode', mode, '--invalid-case', invalid], cwd: process.cwd(), env: { TMPDIR: tmpdir() }, timeoutMs: 5000 });
  let pid: number | null = null;
  const audit = async () => (await readFile(auditPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as McpWaitAudit);
  t.after(async () => {
    await client.close(); await repository.close();
    if (pid !== null) assert.throws(() => process.kill(pid!, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
    assert.equal((await audit()).filter(row => row.event === 'error').length, 0);
    await rm(directory, { recursive: true, force: true });
  });
  const clock = new FakeClock(1000); const planner = new ScriptedPlanner([]);
  const services: RuntimeServices = { state: repository, artifacts: new FileArtifactStore(join(directory, 'artifacts')), clock,
    ids: new RandomIds(), digester: new Sha256Digester(), tools: [], sink: new FakeSink(), planner };
  const schemas = new AjvSchemas(); const host = waitCollectionBinding(family);
  if (maxDelayMs !== undefined) host.deferral!.maxDelayMs = maxDelayMs;
  const session = await client.discover([host.remote], new AbortController().signal); pid = client.snapshot().pid;
  const source = createMcpReadCollection(host, session, client, services, schemas);
  const compose = () => composeRuntime({ services, schemas, owner: 'mcp-wait-test', leaseMs: 60000, enablePlanning: false, collectionTools: [source],
    guidanceSource: { list: async () => [], read: async () => { throw new Error('unused'); } } });
  let composed = await compose(); const work = initial(); work.policy.allowedTools = ['fixture.collection'];
  assert.equal((await repository.commit(command(work, 'accept'))).kind, 'committed');
  const task = (id: string, parent?: Attempt): TaskSpec => ({ id, description: 'Read bounded local wait fixture records',
    toolId: source.definition.id, toolVersion: source.definition.version, input: { ids: ['a', 'b', 'c', 'd'] }, effect: 'read',
    dependsOn: [], maxAttempts: 1, satisfies: [],
    ...(parent ? { readResume: { attemptId: parent.id, checkpointId: parent.readProgress!.head.id } } : {}) });
  const plan = async (selected: TaskSpec) => {
    const current = (await repository.get(work.id))!;
    await composed.runtime.submitPlan(work.id, `plan:${selected.id}`, { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
      basePlanRevision: current.plan?.revision ?? 0, reason: 'Read fixture and explicitly resume after its barrier', tasks: [selected], hypotheses: [] });
  };
  const prepare = async (selected: TaskSpec) => {
    await plan(selected);
    const attempt = await composed.runtime.reserve(work.id, selected.id); await composed.runtime.dispatch(work.id, attempt.id); return attempt;
  };
  const invoke = async (selected: TaskSpec) => {
    const attempt = await prepare(selected);
    const broker = new ToolBroker(services.state, composed.contracts, services.digester, clock);
    const result = await broker.invoke(work.id, attempt.id, composed.runtime.owner, new AbortController().signal);
    return { attempt, result };
  };
  const run = async (selected: TaskSpec) => {
    const { attempt, result } = await invoke(selected);
    await composed.runtime.receive(work.id, attempt.id, result, 'invoked'); const state = await composed.runtime.adopt(work.id, attempt.id);
    return { result, state, attempt: state.attempts.find(value => value.id === attempt.id)! };
  };
  const checkpoint = async (attemptId: string) => {
    const state = (await repository.get(work.id))!; const head = state.attempts.find(value => value.id === attemptId)!.readProgress!.head;
    return new ReadCheckpointReader(state, services.artifacts, services.digester).load(head);
  };
  return { directory, work, services, clock, planner, host, source, session, schemas, client, task, plan, prepare, invoke, run, audit, checkpoint,
    current: () => repository.get(work.id), get composed() { return composed; },
    reopen: async () => { await repository.close(); repository = openRepository(adapter, directory); services.state = repository; composed = await compose(); } };
}

for (const adapter of adapters) for (const family of ['documents', 'observations'] as const) {
  test(`${adapter}: MCP wait ${family} normal records retain lineage and bind the stored-response recovery contract`, { timeout: 30000 }, async t => {
    const f = await setup(t, adapter, family, 'normal');
    const legacy = collectionBinding(family);
    const previousDigest = f.services.digester.digest(asJson({ remote: legacy.remote, projectorId: legacy.projectorId, projectorVersion: legacy.projectorVersion,
      endpointId: f.session.endpointId, protocolVersion: f.session.protocolVersion, responseRecovery: 'stored-response-v1' }));
    const compatible = createMcpReadCollection(legacy, f.session, f.client, f.services, f.schemas);
    assert.equal(compatible.definition.version, `1.${previousDigest.slice(0, 24)}`);
    assert.equal('deferralValidation' in compatible.definition.collection!, false); assert.equal('validateDeferral' in compatible.source, false);
    assert.equal(f.source.definition.collection!.deferralValidation, 'artifact-proof-v1');
    const value = await f.run(f.task('normal')); assert.equal(value.result.status, 'success'); assert.equal(items(value.result).length, 4);
    assert.equal(new Set(value.result.evidence.map(record => record.lineageId)).size, 1);
    assert.ok(items(value.result).every(item => !('retryAt' in item)));
    assert.equal(f.client.snapshot().toolCalls, family === 'documents' ? 1 : 2); assert.equal(f.planner.inputs.length, 0);
    assert.equal(await f.composed.readCheckpoints.validateResult(value.state, value.result), true);
  });

  test(`${adapter}: MCP whole wait ${family} binds fixed origin and protects its original error proof`, { timeout: 30000 }, async t => {
    const f = await setup(t, adapter, family, 'whole-rate-limit'); const selected = f.task('whole'); const value = await f.run(selected);
    assert.equal(value.result.status, 'partial'); assert.equal(value.result.evidence.length, 0); assert.deepEqual(items(value.result), []);
    assert.equal(f.client.snapshot().toolCalls, 1); assert.equal(f.planner.inputs.length, 0);
    let cp = await f.checkpoint(value.attempt.id); assert.equal(cp.calls.length, 1); assert.equal(cp.calls[0]!.status, 'deferred');
    assert.equal(cp.retryAt, 3500); assert.equal(value.attempt.readProgress!.retryAt, 3500);
    assert.equal(cp.collection.calls, 0); assert.equal(cp.collection.pages.length, 0); assert.equal(cp.collection.snapshot, null);
    assert.equal(cp.collection.nextCursor, null); assert.equal(cp.collection.exhausted, false);
    assert.equal(value.attempt.readProgress!.callCount, 1); assert.equal(value.attempt.readProgress!.remainingCalls, 5);
    const deferral = JSON.parse(new TextDecoder().decode(await f.services.artifacts.get(cp.calls[0]!.response!, value.state.policy))) as ReadDeferral;
    assert.equal(deferral.kind, 'read_deferral'); assert.equal(deferral.dueAt, 3500); assert.ok(deferral.rawArtifact);
    assert.ok(cp.artifacts.some(ref => ref.id === deferral.rawArtifact!.id));
    const raw = JSON.parse(new TextDecoder().decode(await f.services.artifacts.get(deferral.rawArtifact!, value.state.policy)));
    assert.equal(raw.recordedAt, 1000); assert.equal(raw.value.isError, true); assert.equal(raw.value.structuredContent.retryAfterMs, 2500);
    assert.deepEqual(deferral.usage, { transportCalls: 1, internalOperations: null, imageBytes: null, waitMs: null });
    const input = { attemptId: value.attempt.id, task: selected, request: cp.calls[0]!.request, deferral };
    assert.equal(await f.source.source.validateDeferral!(value.state, input), true);
    assert.equal(await f.source.source.validateDeferral!(value.state, { ...input, deferral: { ...deferral, dueAt: 3501 } }), false);
    f.clock.advance(1000); await f.reopen(); cp = await f.checkpoint(value.attempt.id); assert.equal(cp.retryAt, 3500);
    assert.equal(await f.source.source.validateDeferral!((await f.current())!, input), true);
    assert.equal(await f.composed.readCheckpoints.validateResult((await f.current())!, value.result), true);
    await rm(join(f.directory, 'artifacts', `${deferral.rawArtifact!.id}.blob`));
    assert.equal(await f.source.source.validateDeferral!((await f.current())!, input), false);
    assert.equal(await f.composed.readCheckpoints.validateResult((await f.current())!, value.result), false);
    assert.equal(f.client.snapshot().toolCalls, 1);
  });

  test(`${adapter}: MCP item wait ${family} retries the unfinished item with original success unchanged`, { timeout: 30000 }, async t => {
    const f = await setup(t, adapter, family, 'item-rate-limit'); const parent = await f.run(f.task('items'));
    assert.equal(parent.result.status, 'partial'); const first = structuredClone(items(parent.result).find(item => item.id === 'a'));
    const pending = items(parent.result).find(item => item.id === 'b')!;
    assert.equal(pending.status, 'error'); assert.equal(pending.retryAt, 3500); assert.equal(pending.evidence.length, 0);
    assert.equal(parent.attempt.readProgress!.retryAt, 3500); assert.equal(f.client.snapshot().toolCalls, 1);
    f.clock.advance(2500); const resumed = await f.run(f.task('resume', parent.attempt));
    assert.equal(resumed.result.status, 'success'); assert.deepEqual(items(resumed.result).find(item => item.id === 'a'), first);
    assert.ok(items(resumed.result).every(item => item.status === 'success' && !('retryAt' in item)));
    const calls = (await f.audit()).filter(row => row.event === 'call'); assert.deepEqual(calls[1]!.retryIds, ['b']);
    assert.equal(new Set(calls.map(row => row.requestId)).size, calls.length); assert.equal(f.client.snapshot().toolCalls, family === 'documents' ? 2 : 3);
    assert.equal(resumed.attempt.readProgress!.callCount, family === 'documents' ? 2 : 3);
    assert.equal(await f.composed.readCheckpoints.validateResult(resumed.state, resumed.result), true); assert.equal(f.planner.inputs.length, 0);
  });
}

// The wire/schema path is storage-independent; malformed protocol cases need one backend each.
for (const invalid of MCPW_INVALID_CASES) test(`MCP wait rejects ${invalid} without inventing a retry barrier`, { timeout: 30000 }, async t => {
  const f = await setup(t, 'sqlite', 'documents', 'invalid-delay', invalid); const value = await f.run(f.task(`invalid-${invalid}`));
  assert.equal(value.result.status, 'partial'); assert.equal(value.result.evidence.length, 0); assert.deepEqual(items(value.result), []);
  const cp = await f.checkpoint(value.attempt.id); assert.equal(cp.calls.length, 1); assert.equal(cp.calls[0]!.status, 'rejected');
  assert.equal(cp.retryAt ?? null, null); assert.equal(cp.collection.pages.length, 0);
  assert.equal(f.client.snapshot().toolCalls, 1); assert.equal(f.planner.inputs.length, 0);
  const audit = (await f.audit()).filter(row => row.event === 'call'); assert.equal(audit.length, 1);
});

test('MCP wait rejects a second conflicting metadata hint after preserving one actual response', { timeout: 30000 }, async t => {
  const f = await setup(t, 'sqlite', 'documents', 'conflicting'); const value = await f.run(f.task('conflict'));
  assert.equal(value.result.status, 'partial'); assert.equal(value.result.evidence.length, 0);
  const cp = await f.checkpoint(value.attempt.id); assert.equal(cp.calls[0]!.status, 'rejected'); assert.equal(cp.retryAt ?? null, null);
  assert.ok(await f.services.state.receipt(f.work.id, `mcp-page:${value.attempt.id}:${cp.calls[0]!.request.requestId}`));
  assert.equal(f.client.snapshot().toolCalls, 1); assert.equal(f.planner.inputs.length, 0);
});

test('MCP wait enforces the approved host delay cap even when the remote schema permits the value', { timeout: 30000 }, async t => {
  const f = await setup(t, 'sqlite', 'documents', 'whole-rate-limit', 'negative', 1000);
  const value = await f.run(f.task('host-cap')); const cp = await f.checkpoint(value.attempt.id);
  assert.equal(value.result.status, 'partial'); assert.equal(cp.calls[0]!.status, 'rejected'); assert.equal(cp.retryAt ?? null, null);
  assert.equal(value.result.evidence.length, 0); assert.equal(f.client.snapshot().toolCalls, 1);
  assert.equal((await f.audit()).find(row => row.event === 'handler-ready')!.retryAfterMs, 2500);
});

const summaryMutations = [
  { kind: 'completed-phase', adapter: 'sqlite', mode: 'whole-rate-limit' },
  { kind: 'fake-successor', adapter: 'file-journal', mode: 'whole-rate-limit' },
  { kind: 'missing-item-clock-and-query', adapter: 'file-journal', mode: 'item-rate-limit' },
] as const;
for (const scenario of summaryMutations) test(`MCP wait original checkpoint rejects ${scenario.kind} before a fresh same-query reservation`, { timeout: 30000 }, async t => {
  const f = await setup(t, scenario.adapter, 'documents', scenario.mode);
  const parent = await f.run(f.task('original-wait')); const checkpoint = await f.checkpoint(parent.attempt.id);
  assert.equal(checkpoint.retryAt, 3500); assert.ok(f.clock.now() < checkpoint.retryAt!);
  assert.equal(await f.composed.readCheckpoints.validateResult(parent.state, parent.result), true);
  const fresh = f.task('fresh-name-same-query'); assert.equal(fresh.readResume, undefined); await f.plan(fresh);
  await transact(f.services, f.work.id, `tamper-summary:${scenario.kind}`, 'fixture_summary_changed', {}, state => {
    const progress = state.attempts.find(attempt => attempt.id === parent.attempt.id)!.readProgress!;
    if (scenario.kind === 'completed-phase') { progress.phase = 'complete'; progress.retryAt = null; }
    else if (scenario.kind === 'fake-successor') progress.successorAttemptId = 'nonexistent-successor';
    else { delete progress.retryAt; delete progress.queryDigest; }
  });
  const before = (await f.current())!;
  await assert.rejects(f.composed.runtime.reserve(f.work.id, fresh.id), /read_checkpoint_unavailable|read_retry_not_due|read_wait_state_changed/);
  const after = (await f.current())!;
  assert.deepEqual(after.attempts, before.attempts); assert.equal(after.attempts.length, 1);
  assert.equal(after.budget.reservedToolCalls, 0); assert.equal(after.budget.used.toolCalls, before.budget.used.toolCalls);
  assert.equal(after.modelCalls.length, 0); assert.equal(f.planner.inputs.length, 0);
  assert.equal(f.client.snapshot().toolCalls, 1); assert.equal((await f.audit()).filter(row => row.event === 'call').length, 1);
  assert.equal(f.clock.now(), 1000);
});
