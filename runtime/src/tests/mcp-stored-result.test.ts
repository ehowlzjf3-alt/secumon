import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactRef, TaskSpec, WorkState } from '../domain/model.js';
import type { StateRepository } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { ToolBroker } from '../application/tool-broker.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { transact } from '../application/work-transactions.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { createMcpReadTool, type McpReadBinding } from '../infrastructure/mcp-read-tools.js';
import { McpCallError, type McpSession, type McpStdioClient } from '../infrastructure/mcp-stdio-client.js';
import { MCP_FIXTURE_DOCUMENTS_TOOL, MCP_FIXTURE_PROTOCOL, fixtureRecord, type McpFixtureId } from './helpers/mcp-fixture-contracts.js';
import { adapters, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

type Receipt = NonNullable<Awaited<ReturnType<StateRepository['receipt']>>>;
type ReadReceipt = (commandId: string, receipt: Receipt | null) => Receipt | null;
async function fixture(t: TestContext, adapter: Adapter = 'sqlite') {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-mcp-stored-result-'));
  let state = openRepository(adapter, directory), now = 1000, calls = 0, discoveries = 0;
  t.after(async () => { try { await state.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  const artifacts = new FileArtifactStore(join(directory, 'artifacts')), schemas = new AjvSchemas();
  const services: RuntimeServices = { state, artifacts, clock: { now: () => now }, ids: new RandomIds(), digester: new Sha256Digester(),
    tools: [], sink: new FakeSink(), planner: new ScriptedPlanner([]) };
  const session: McpSession = { endpointId: 'stored-result-fixture', generation: 1, protocolVersion: MCP_FIXTURE_PROTOCOL,
    discoveryDigest: 'd'.repeat(64) };
  const binding: McpReadBinding = { definition: { provider: 'fixture', id: 'fixture.read', version: '1',
    description: 'Stored decoded fixture response', effect: 'read', destination: 'local', labels: ['synthetic'],
    inputSchema: MCP_FIXTURE_DOCUMENTS_TOOL.inputSchema,
    outputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false } },
    remote: structuredClone(MCP_FIXTURE_DOCUMENTS_TOOL), projectorId: 'stored-value', projectorVersion: '1', project(value) {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      const coverage = value['complete'] === true ? 'complete' as const : 'partial' as const;
      return { output: { value: value['value']! }, coverage, observations: [{ sourceId: 'doc-origin', lineageId: 'doc-origin',
        locator: '/structuredContent/value', observedAt: 900, coverage, facts: { value: value['value'] as number } }] };
    } };
  // Only this adapter-level fixture substitutes the decoded transport port. Integration SIGKILL tests use the actual stdio peer.
  const client: Pick<McpStdioClient, 'discover' | 'call'> = {
    async discover() { discoveries++; assert.fail('stored-result fixture does not discover a peer'); },
    async call(captured, name, input, context) {
      await context.authorize(); assert.equal(name, 'documents.read'); calls++; now = 1100;
      if (input['id'] === 'crash') throw new McpCallError('mcp_call_failed', true);
      if (input['id'] === 'slow') throw new McpCallError('mcp_call_not_sent', false);
      return { session: captured, transportCalls: 1, value: input['id'] === 'error'
        ? { isError: true, content: [{ type: 'text', text: 'fixed error' }] }
        : { content: [{ type: 'text', text: 'fixed decoded response' }], structuredContent: { ...fixtureRecord('documents.read', input['id'] as McpFixtureId) } } };
    },
  };
  const tool = createMcpReadTool(binding, session, client, services, schemas), contracts = new ToolContracts([tool], schemas);
  const runtime = new ExecutionRuntime(services, contracts, 'original-worker', 5000);
  const work = initial(); assert.equal((await state.commit(command(work, 'accept'))).kind, 'committed');
  const prepare = async (id: McpFixtureId = 'good') => {
    const current = (await state.get(work.id))!;
    const task: TaskSpec = { id: 'read', description: 'Read one fixed record', toolId: tool.definition.id, toolVersion: tool.definition.version,
      input: { id }, effect: 'read', dependsOn: [], maxAttempts: 2, satisfies: [] };
    await runtime.submitPlan(work.id, 'plan', { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
      basePlanRevision: 0, reason: 'Verify stored response recovery', tasks: [task], hypotheses: [] });
    const attempt = await runtime.reserve(work.id, task.id); await runtime.dispatch(work.id, attempt.id);
    return { task, attempt };
  };
  const invoke = (attemptId: string) => new ToolBroker(state, contracts, services.digester, services.clock)
    .invoke(work.id, attemptId, runtime.owner, new AbortController().signal);
  const saved = async (id: McpFixtureId = 'good') => {
    const prepared = await prepare(id), result = await invoke(prepared.attempt.id);
    const response = await state.receipt(work.id, `mcp-response:${prepared.attempt.id}`); assert.ok(response);
    const ref = response.state.artifacts.at(-1)!;
    return { ...prepared, result, response, ref, current: (await state.get(work.id))! };
  };
  const reader = (override?: ReadReceipt, selectedBinding = binding) => {
    const repository = override ? new Proxy(state, { get(target, key) {
      if (key === 'receipt') return async (workId: string, commandId: string) => override(commandId, await target.receipt(workId, commandId));
      const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } }) : state;
    const forbidden: Pick<McpStdioClient, 'discover' | 'call'> = {
      async discover() { discoveries++; assert.fail('restoration must not discover'); },
      async call() { calls++; assert.fail('restoration must not call the source'); },
    };
    return createMcpReadTool(selectedBinding, { ...session, generation: 9 }, forbidden, { ...services, state: repository }, schemas);
  };
  const reopen = async () => { await state.close(); state = openRepository(adapter, directory); services.state = state; };
  return { directory, services, binding, tool, runtime, work, prepare, invoke, saved, reader, reopen,
    state: () => state, setNow: (value: number) => { now = value; }, calls: () => calls, discoveries: () => discoveries };
}

for (const adapter of adapters) test(`${adapter}: stored v1 MCP response restores after reopen and lease expiry without a remote or any writes`, async t => {
  const f = await fixture(t, adapter), s = await f.saved();
  const original = await f.services.artifacts.get(s.ref, s.current.policy), before = structuredClone(s.current);
  assert.equal(JSON.parse(new TextDecoder().decode(original)).schemaVersion, 1);
  await f.reopen(); f.setNow(10000);
  const reader = f.reader(), input = { attemptId: s.attempt.id, task: s.task };
  assert.deepEqual(reader.definition, f.tool.definition, 'adding a callback or reconnecting must not change the stored contract');
  const restored = await reader.restoreResult!((await f.state().get(f.work.id))!, input);
  assert.equal(restored.kind, 'available'); if (restored.kind !== 'available') assert.fail();
  assert.deepEqual(restored.result, s.result); assert.equal(restored.receivedAt, 1100);
  assert.deepEqual(restored.receipt, { commandId: `mcp-response:${s.attempt.id}`, digest: s.response.digest, artifact: s.ref });
  assert.deepEqual(await reader.restoreResult!(s.current, input), restored);
  assert.equal(await reader.validateResult!(s.current, restored.result), true);
  assert.deepEqual(await f.state().get(f.work.id), before);
  assert.deepEqual(await f.state().receipt(f.work.id, restored.receipt.commandId), s.response);
  assert.equal(await f.state().receipt(f.work.id, `receive:${s.attempt.id}`), null);
  assert.deepEqual(await f.services.artifacts.get(s.ref, s.current.policy), original);
  assert.equal(f.calls(), 1); assert.equal(f.discoveries(), 0);
});

for (const id of ['partial', 'error', 'crash', 'slow'] as const) test(`stored MCP ${id} preserves status and measured or unsent usage without promoting evidence`, async t => {
  const f = await fixture(t), s = await f.saved(id); f.setNow(10000);
  const restored = await f.reader().restoreResult!(s.current, { attemptId: s.attempt.id, task: s.task });
  assert.equal(restored.kind, 'available'); if (restored.kind !== 'available') assert.fail();
  assert.deepEqual(restored.result, s.result);
  assert.equal(restored.result.status, id === 'partial' ? 'partial' : 'error');
  assert.equal(restored.result.usage?.transportCalls, id === 'slow' ? 0 : 1);
  assert.equal(restored.result.usage?.internalOperations, null);
  if (id !== 'partial') { assert.deepEqual(restored.result.evidence, []); assert.deepEqual(restored.result.artifacts, []); }
  assert.equal(f.calls(), 1); assert.equal(f.discoveries(), 0);
});

for (const boundary of ['intent', 'artifact'] as const) test(`MCP ${boundary}-only custody is absent and does not trigger a repeated source call`, async t => {
  const f = await fixture(t), prepared = await f.prepare(), injected = new Error(`stop_after_${boundary}`);
  const commit = f.services.state.commit.bind(f.services.state), put = f.services.artifacts.put.bind(f.services.artifacts);
  let raw: ArtifactRef | undefined;
  if (boundary === 'intent') f.services.state.commit = async request => {
    const result = await commit(request); if (request.commandId === `mcp-intent:${prepared.attempt.id}`) throw injected; return result;
  };
  else f.services.artifacts.put = async (bytes, attributes) => { raw = await put(bytes, attributes); throw injected; };
  try { await assert.rejects(f.invoke(prepared.attempt.id), error => error === injected); }
  finally { f.services.state.commit = commit; f.services.artifacts.put = put; }
  const state = (await f.state().get(f.work.id))!;
  assert.ok(await f.state().receipt(f.work.id, `mcp-intent:${prepared.attempt.id}`));
  assert.equal(await f.state().receipt(f.work.id, `mcp-response:${prepared.attempt.id}`), null);
  if (raw) assert.equal(await f.services.artifacts.exists(raw), true);
  assert.deepEqual(await f.reader().restoreResult!(state, { attemptId: prepared.attempt.id, task: prepared.task }), { kind: 'absent' });
  await assert.rejects(f.invoke(prepared.attempt.id), /mcp_attempt_already_started/);
  assert.equal(f.calls(), boundary === 'intent' ? 0 : 1); assert.equal(f.discoveries(), 0);
});

test('MCP restore finds the exact authenticated response ref and rejects ambiguous or wrong receipt references', async t => {
  const f = await fixture(t), s = await f.saved(), unrelated = await f.services.artifacts.put(new TextEncoder().encode('unrelated'),
    { tenantId: s.current.policy.tenantId, labels: ['synthetic'], mediaType: 'text/plain' });
  const input = { attemptId: s.attempt.id, task: s.task }, commandId = `mcp-response:${s.attempt.id}`;
  const after = (change: (value: Receipt) => void): ReadReceipt => (id, receipt) => {
    if (id === commandId && receipt) { change(receipt); } return receipt;
  };
  const reordered = f.reader(after(value => { value.state.artifacts.push(unrelated); }));
  const restored = await reordered.restoreResult!(s.current, input); assert.equal(restored.kind, 'available');
  assert.equal(await reordered.validateResult!(s.current, s.result), true);
  for (const change of [(value: Receipt) => { value.state.artifacts.push(s.ref); },
    (value: Receipt) => { value.digest = 'f'.repeat(64); }, (value: Receipt) => { value.state.artifacts = [unrelated]; }])
    await assert.rejects(f.reader(after(change)).restoreResult!(s.current, input), /mcp_saved_result_invalid/);
  assert.equal(f.calls(), 1);
});

test('MCP restore rejects receipt ordering, altered original owner and late preparation while legacy proof retains its scope', async t => {
  const f = await fixture(t), s = await f.saved(), input = { attemptId: s.attempt.id, task: s.task };
  const dispatch = (await f.state().receipt(f.work.id, `dispatch:${s.attempt.id}`))!;
  const changes: [string, (value: Receipt) => void][] = [
    ['intent', value => { value.state.revision = dispatch.state.revision; }],
    ['response', value => { value.state.revision = dispatch.state.revision; }],
    ['response', value => { value.state.attempts[0]!.owner = 'foreign-owner'; }],
    ['response', value => { value.state.attempts[0]!.leaseUntil++; }],
    ['response', value => { value.state.attempts[0]!.status = 'failed'; }],
    ['response', value => { value.state.id = 'another-work'; }],
    ['response', value => { value.state.goal.description = 'changed during call'; }],
    ['response', value => { value.state.policy.allowedDestinations.push('external'); }],
    ['intent', value => { value.state.updatedAt = 1101; }],
  ];
  for (const [kind, change] of changes) {
    const reader = f.reader((id, value) => { if (id === `mcp-${kind}:${s.attempt.id}` && value) change(value); return value; });
    await assert.rejects(reader.restoreResult!(s.current, input), /mcp_saved_result_invalid/);
  }
  const late = f.reader((id, value) => {
    if (id === `mcp-response:${s.attempt.id}` && value) value.state.updatedAt = s.attempt.leaseUntil;
    return value;
  });
  f.setNow(10000);
  assert.equal(await late.validateResult!(s.current, s.result), true, 'existing proof did not claim preparation before the lease');
  await assert.rejects(late.restoreResult!(s.current, input), /mcp_saved_result_invalid/);
  assert.equal(f.calls(), 1);
});

test('MCP restoration rejects changed current goal, plan, policy, attempt, successor and clock rollback', async t => {
  const f = await fixture(t), s = await f.saved(), reader = f.reader(), input = { attemptId: s.attempt.id, task: s.task };
  const changes: ((state: WorkState) => void)[] = [
    state => { state.goal.description = 'different request'; }, state => { state.plan!.revision++; },
    state => { state.policy.allowedTools = []; }, state => { state.deadlineAt++; },
    state => { state.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] }; },
    state => { state.attempts[0]!.owner = 'new-owner'; },
    state => { state.attempts[0]!.status = 'failed'; state.attempts[0]!.error = { code: 'invalid_tool_result', retryable: false }; },
    state => { state.attempts[0]!.resultId = 'already-received'; state.attempts[0]!.resultArtifact = s.ref; },
    state => { state.attempts.push({ ...structuredClone(state.attempts[0]!), id: 'new-attempt' }); },
    state => { state.status = 'cancelled'; },
  ];
  for (const change of changes) {
    const state = structuredClone(s.current); change(state);
    await assert.rejects(reader.restoreResult!(state, input), /mcp_saved_result_invalid/);
  }
  await assert.rejects(reader.restoreResult!(s.current, { ...input, task: { ...s.task, input: { id: 'partial' } } }), /mcp_saved_result_invalid/);
  f.setNow(1099); await assert.rejects(reader.restoreResult!(s.current, input), /mcp_saved_result_invalid/);
  f.setNow(s.current.deadlineAt); await assert.rejects(reader.restoreResult!(s.current, input), /mcp_saved_result_invalid/);
  f.setNow(10000);
  const expired = structuredClone(s.current); expired.attempts[0]!.status = 'failed'; expired.attempts[0]!.error = { code: 'lease_expired', retryable: true };
  assert.equal((await reader.restoreResult!(expired, input)).kind, 'available', 'the executor separately validates its actual recover receipt before adoption');
  assert.equal(f.calls(), 1);
});

test('MCP stored raw loss or tampering is an error, while changed projector versions cannot reinterpret old custody', async t => {
  const f = await fixture(t), s = await f.saved(), input = { attemptId: s.attempt.id, task: s.task };
  const revised = f.reader(undefined, { ...f.binding, projectorVersion: '2' });
  await assert.rejects(revised.restoreResult!(s.current, input), /mcp_saved_result_invalid/);
  assert.equal(await revised.validateResult!(s.current, s.result), false);
  const path = join(f.directory, 'artifacts', `${s.ref.id}.blob`), bytes = await readFile(path);
  await writeFile(path, '{}'); await assert.rejects(f.reader().restoreResult!(s.current, input));
  assert.equal(await f.reader().validateResult!(s.current, s.result), false);
  await writeFile(path, bytes); await rm(path); await assert.rejects(f.reader().restoreResult!(s.current, input));
  assert.ok(await f.state().receipt(f.work.id, `mcp-response:${s.attempt.id}`)); assert.equal(f.calls(), 1);
});

test('a newer unrelated artifact does not change the stored MCP response receipt or raw result', async t => {
  const f = await fixture(t), s = await f.saved();
  const unrelated = await f.services.artifacts.put(new TextEncoder().encode('later local artifact'),
    { tenantId: s.current.policy.tenantId, labels: ['synthetic'], mediaType: 'text/plain' });
  await transact(f.services, f.work.id, 'later-artifact', 'local_artifact_added', { id: unrelated.id }, state => { state.artifacts.push(unrelated); });
  f.setNow(10000); const current = (await f.state().get(f.work.id))!;
  const restored = await f.reader().restoreResult!(current, { attemptId: s.attempt.id, task: s.task });
  assert.equal(restored.kind, 'available'); if (restored.kind !== 'available') assert.fail();
  assert.deepEqual(restored.result, s.result); assert.deepEqual(restored.receipt.artifact, s.ref);
  assert.deepEqual(await f.state().receipt(f.work.id, `mcp-response:${s.attempt.id}`), s.response);
  assert.equal(f.calls(), 1);
});
