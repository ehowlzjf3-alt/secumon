import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Attempt, TaskSpec, ToolResult } from '../domain/model.js';
import type { ReadItem, ReadLimits } from '../domain/read-collection.js';
import type { RuntimeServices } from '../application/services.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { ToolBroker } from '../application/tool-broker.js';
import { transact } from '../application/work-transactions.js';
import { ReadCheckpointReader } from '../application/read-checkpoint-store.js';
import { asJson } from '../application/plan-validator.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { Sha256Digester, RandomIds, sha256 } from '../infrastructure/digest.js';
import { McpStdioClient } from '../infrastructure/mcp-stdio-client.js';
import { createMcpReadCollection } from '../infrastructure/mcp-read-collections.js';
import { evaluationCodePin } from '../infrastructure/local-evaluation.js';
import { collectionBinding, type CollectionFamily } from './helpers/mcp-collection-binding.js';
import type { McpCollectionAudit, McpCollectionMode } from './helpers/mcp-collection-fixture-contracts.js';
import { adapters, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const evidenceDirectory = process.env['SECUMON_MCPC_EVIDENCE_DIR'];
const codeDigest = evidenceDirectory ? (await evaluationCodePin(process.cwd())).digest : null;
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
const items = (result: ToolResult) => (result.output as { items: unknown }).items as ReadItem[];
async function setup(t: TestContext, adapter: Adapter, family: CollectionFamily = 'documents', mode: McpCollectionMode = 'normal', limits: Partial<ReadLimits> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-mcp-collections-')); let repository = openRepository(adapter, directory);
  const client = new McpStdioClient({ endpointId: 'synthetic-collection', command: process.execPath,
    args: [fileURLToPath(new URL('./helpers/mcp-collection-fixture-server.js', import.meta.url)), '--audit-file', join(directory, 'audit.jsonl'), '--mode', mode],
    cwd: process.cwd(), env: { TMPDIR: tmpdir() }, timeoutMs: 5000 });
  let pid: number | null = null;
  const audit = async () => (await readFile(join(directory, 'audit.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as McpCollectionAudit);
  t.after(async () => {
    await client.close(); await repository.close();
    if (pid !== null) assert.throws(() => process.kill(pid!, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
    if (evidenceDirectory) { await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(join(evidenceDirectory, `${sha256(t.name).slice(0, 20)}.json`), JSON.stringify({ test: t.name, adapter, family, mode, codeDigest,
        transport: client.snapshot(), audit: await audit(), shutdown: { pid, ownedPeerStopped: true } }, null, 2) + '\n'); }
    await rm(directory, { recursive: true, force: true });
  });
  const services: RuntimeServices = { state: repository, artifacts: new FileArtifactStore(join(directory, 'artifacts')), clock: new FakeClock(1000),
    ids: new RandomIds(), digester: new Sha256Digester(), tools: [], sink: new FakeSink(), planner: new ScriptedPlanner([]) };
  const schemas = new AjvSchemas(); const host = collectionBinding(family, limits);
  const session = await client.discover([host.remote], new AbortController().signal); pid = client.snapshot().pid;
  const source = createMcpReadCollection(host, session, client, services, schemas);
  const compose = async () => composeRuntime({ services, schemas, owner: 'mcp-collection-test', enablePlanning: false, collectionTools: [source],
    guidanceSource: { list: async () => [], read: async () => { throw new Error('unused'); } } });
  let composed = await compose();
  const work = initial(); work.policy.allowedTools = ['fixture.collection'];
  assert.equal((await repository.commit(command(work, 'accept'))).kind, 'committed');
  const task = (id: string, parent?: Attempt, ids = ['a', 'b', 'c', 'd']): TaskSpec => ({ id, description: 'Collect synthetic records via MCP',
    toolId: source.definition.id, toolVersion: source.definition.version, input: { ids }, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [],
    ...(parent ? { readResume: { attemptId: parent.id, checkpointId: parent.readProgress!.head.id } } : {}) });
  const prepare = async (selected: TaskSpec) => {
    const current = (await repository.get(work.id))!;
    await composed.runtime.submitPlan(work.id, `plan:${selected.id}`, { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
      basePlanRevision: current.plan?.revision ?? 0, reason: 'Verify collection records and explicit resume', tasks: [selected], hypotheses: [] });
    const attempt = await composed.runtime.reserve(work.id, selected.id); await composed.runtime.dispatch(work.id, attempt.id); return attempt;
  };
  const broker = () => new ToolBroker(services.state, composed.contracts, services.digester, services.clock);
  const invoke = async (selected: TaskSpec) => {
    const attempt = await prepare(selected); const result = await broker().invoke(work.id, attempt.id, composed.runtime.owner, new AbortController().signal);
    return { attempt, result };
  };
  const adopt = async (result: ToolResult) => { await composed.runtime.receive(work.id, result.attemptId, result, 'invoked'); return composed.runtime.adopt(work.id, result.attemptId); };
  const run = async (selected: TaskSpec) => { const { result } = await invoke(selected); const state = await adopt(result);
    return { result, state, attempt: state.attempts.find(value => value.id === result.attemptId)! }; };
  const checkpoint = async (attemptId: string) => {
    const state = (await repository.get(work.id))!; const head = state.attempts.find(value => value.id === attemptId)!.readProgress!.head;
    return new ReadCheckpointReader(state, services.artifacts, services.digester).load(head);
  };
  return { directory, work, services, host, source, session, client, schemas, audit, task, prepare, invoke, run, adopt, broker, checkpoint,
    current: () => repository.get(work.id), get composed() { return composed; },
    reopen: async () => { await repository.close(); repository = openRepository(adapter, directory); services.state = repository; composed = await compose(); } };
}

for (const adapter of adapters) {
  for (const family of ['documents', 'observations'] as const) {
    test(`${adapter}: MCP collection ${family} preserves individual raw pages and verifies offline`, { timeout: 20000 }, async t => {
      const f = await setup(t, adapter, family); const value = await f.run(f.task('normal'));
      assert.equal(value.result.status, 'success'); assert.equal(value.attempt.adopted, true); assert.equal(items(value.result).length, 4);
      const calls = family === 'documents' ? 1 : 2; assert.equal(f.client.snapshot().toolCalls, calls);
      assert.deepEqual(value.result.usage, { transportCalls: calls, internalOperations: null, imageBytes: null, waitMs: null });
      const checkpoint = await f.checkpoint(value.attempt.id); assert.equal(checkpoint.calls.length, calls);
      assert.equal(new Set(value.result.evidence.map(record => record.lineageId)).size, 1);
      for (const page of checkpoint.collection.pages) {
        assert.ok(page.rawArtifact); assert.ok(checkpoint.artifacts.some(ref => ref.id === page.rawArtifact!.id));
        const raw = JSON.parse(new TextDecoder().decode(await f.services.artifacts.get(page.rawArtifact!, value.state.policy)));
        assert.equal(raw.kind, 'mcp_collection_response'); assert.equal(raw.request.requestId, page.requestId);
        assert.ok(page.items.every(item => item.evidence.every(record => record.artifact!.id === page.rawArtifact!.id)));
      }
      const first = checkpoint.collection.pages[0]!;
      const forged = structuredClone(first); forged.items[0]!.output = { value: 999 };
      assert.equal(await f.source.source.validatePage!((await f.current())!, { attemptId: value.attempt.id,
        task: f.task('normal'), request: checkpoint.calls[0]!.request, page: forged }), false);
      await f.client.close(); await f.reopen();
      assert.equal(await f.composed.readCheckpoints.validateResult((await f.current())!, value.result), true);
      assert.equal(f.client.snapshot().toolCalls, calls);
    });

    test(`${adapter}: MCP collection ${family} resumes only partial items with original success unchanged`, { timeout: 20000 }, async t => {
      const f = await setup(t, adapter, family, 'partial'); const parent = await f.run(f.task('partial'));
      assert.equal(parent.result.status, 'partial'); assert.equal(items(parent.result).find(item => item.id === 'b')!.evidence.length, 0);
      const original = structuredClone(items(parent.result).find(item => item.id === 'a'));
      await f.reopen(); const resumed = await f.run(f.task('resume', parent.attempt));
      assert.equal(resumed.result.status, 'success'); assert.deepEqual(items(resumed.result).find(item => item.id === 'a'), original);
      const audit = (await f.audit()).filter(row => row.event === 'call'); assert.deepEqual(audit[1]!.retryIds, ['b']);
      assert.equal(audit.filter(row => row.retryIds === null && row.cursor === null).length, 1);
      assert.equal(new Set(audit.map(row => row.requestId)).size, audit.length);
      assert.equal(resumed.attempt.readProgress!.callCount, family === 'documents' ? 2 : 3);
      assert.equal(await f.composed.readCheckpoints.validateResult((await f.current())!, resumed.result), true);
    });
  }

  test(`${adapter}: MCP empty page is preserved and losing its original rejects the result`, { timeout: 20000 }, async t => {
    const f = await setup(t, adapter, 'observations', 'empty'); const value = await f.invoke(f.task('empty'));
    assert.equal(value.result.status, 'success'); assert.equal(f.client.snapshot().toolCalls, 3);
    const checkpoint = await f.checkpoint(value.attempt.id); const page = checkpoint.collection.pages.find(page => page.items.length === 0)!;
    assert.ok(page.rawArtifact); assert.ok(value.result.artifacts.some(ref => ref.id === page.rawArtifact!.id));
    await f.composed.runtime.receive(f.work.id, value.attempt.id, value.result, 'invoked'); await f.reopen();
    await rm(join(f.directory, 'artifacts', `${page.rawArtifact.id}.blob`));
    assert.equal(await f.composed.readCheckpoints.validateResult((await f.current())!, value.result), false);
    await assert.rejects(f.composed.runtime.adopt(f.work.id, value.attempt.id), /artifact_unavailable/);
    assert.equal((await f.current())!.evidence.length, 0);
  });

  for (const mode of ['snapshot-change', 'cursor-loop'] as const) test(`${adapter}: MCP collection rejects ${mode} after keeping its first page`, { timeout: 20000 }, async t => {
    const f = await setup(t, adapter, 'observations', mode); const value = await f.run(f.task(mode));
    assert.equal(value.result.status, 'partial'); assert.deepEqual(items(value.result).map(item => item.id), ['a', 'b']);
    const cp = await f.checkpoint(value.attempt.id); assert.deepEqual(cp.calls.map(call => call.status), ['accepted', 'rejected']);
    assert.equal(f.client.snapshot().toolCalls, 2); assert.equal(value.result.usage!.transportCalls, null);
  });

  for (const mode of ['error', 'rate-limit'] as const) test(`${adapter}: MCP ${mode} does not become EOF or automatic retry`, { timeout: 20000 }, async t => {
    const f = await setup(t, adapter, 'documents', mode, { maxCalls: 1 }); const value = await f.run(f.task(mode));
    assert.equal(value.result.status, 'partial'); assert.equal(value.result.evidence.length, 0); assert.equal(f.client.snapshot().toolCalls, 1);
    const next = await f.run(f.task(`${mode}-explicit`, value.attempt)); assert.equal(next.result.status, 'partial');
    assert.equal(next.attempt.readProgress!.remainingCalls, 0); assert.equal(f.client.snapshot().toolCalls, 1);
  });

  test(`${adapter}: MCP accepted raw response substitution blocks parent resume before sending`, { timeout: 20000 }, async t => {
    const f = await setup(t, adapter, 'documents', 'partial'); const parent = await f.run(f.task('parent'));
    const cp = await f.checkpoint(parent.attempt.id); const raw = cp.collection.pending!.rawArtifact!;
    await writeFile(join(f.directory, 'artifacts', `${raw.id}.blob`), '{}'); await f.reopen();
    assert.equal(await f.composed.readCheckpoints.validateResult((await f.current())!, parent.result), false);
    await assert.rejects(f.run(f.task('forged-resume', parent.attempt)), /artifact_unavailable|read_checkpoint_unavailable/);
    assert.equal(f.client.snapshot().toolCalls, 1);
  });

  test(`${adapter}: MCP changed query cannot reuse a partial parent`, { timeout: 20000 }, async t => {
    const f = await setup(t, adapter, 'documents', 'partial'); const parent = await f.run(f.task('parent-query'));
    await assert.rejects(f.run(f.task('other-query', parent.attempt, ['a', 'b'])), /read_resume|read_checkpoint|invalid_plan/);
    assert.equal(f.client.snapshot().toolCalls, 1);
  });

  for (const timing of ['before-send', 'after-reply'] as const) test(`${adapter}: MCP authority change ${timing} prevents page acceptance`, { timeout: 20000 }, async t => {
    const f = await setup(t, adapter); const entered = gate(); const release = gate();
    const delayed = { async call(...args: Parameters<McpStdioClient['call']>) {
      if (timing === 'before-send') { entered.resolve(); await release.promise; return f.client.call(...args); }
      const reply = await f.client.call(...args); entered.resolve(); await release.promise; return reply;
    } };
    const replacement = createMcpReadCollection(f.host, f.session, delayed, f.services, f.schemas);
    // Keep the same registered core tool, changing only this trusted fixture source dispatch.
    const { createReadCollectionTool } = await import('../application/read-collections.js');
    f.composed.contracts.replaceProvider('fixture', [createReadCollectionTool(replacement, () => f.composed.readCollections)],
      { expectedEpoch: f.composed.contracts.providerEpoch('fixture'), sourceRevision: `fixture-${timing}` });
    const attempt = await f.prepare(f.task(timing));
    const invocation = f.broker().invoke(f.work.id, attempt.id, f.composed.runtime.owner, new AbortController().signal);
    const rejected = assert.rejects(invocation, /broker_execution_not_current|read_scope_changed|read_interrupted/);
    await entered.promise;
    await transact(f.services, f.work.id, `change:${timing}`, 'fixture_changed', {}, state => { state.policy.allowedLabels.push('additional'); });
    release.resolve(); await rejected;
    assert.equal(f.client.snapshot().toolCalls, timing === 'before-send' ? 0 : 1);
    const state = (await f.current())!; assert.equal(state.evidence.length, 0);
    const cp = await f.checkpoint(attempt.id); assert.equal(cp.calls.at(-1)!.status, 'intent');
    const request = cp.calls.at(-1)!;
    const receipt = await f.services.state.receipt(f.work.id, `mcp-page:${attempt.id}:${request.request.requestId}`); assert.ok(receipt);
    const usage = await f.composed.contracts.restoreReadUsage(state, { attemptId: attempt.id, task: f.task(timing),
      request: request.request, dispatchedAt: request.dispatchedAt });
    assert.equal(usage.kind, 'available'); if (usage.kind !== 'available') assert.fail('original request proof required');
    assert.equal(usage.usage.transportCalls, timing === 'before-send' ? 0 : 1);
    assert.equal(usage.responseObserved, timing === 'after-reply'); assert.equal(usage.custodyOnly, true);
    assert.deepEqual(usage.receipt.digest, receipt.digest);
    const raw = usage.receipt.artifact, bytes = await f.services.artifacts.get(raw, f.work.policy);
    assert.equal(sha256(bytes), raw.sha256); assert.deepEqual(raw.labels, f.work.policy.allowedLabels);
    const envelope = JSON.parse(new TextDecoder().decode(bytes));
    assert.equal(envelope.workId, f.work.id); assert.equal(envelope.attemptId, attempt.id);
    assert.deepEqual(envelope.request, request.request); assert.deepEqual(envelope.intentHead, cp.calls.length ? state.attempts[0]!.readProgress!.head : null);
    assert.equal(envelope.value === null, timing === 'before-send');
    assert.equal(receipt.digest, f.services.digester.digest(asJson({ type: 'mcp_collection_response_recorded', data: {
      attemptId: attempt.id, requestId: request.request.requestId, artifact: raw,
      custody: { schemaVersion: 1, outcome: timing === 'before-send' ? 'failure' : 'returned',
        transportCalls: timing === 'before-send' ? 0 : 1, recordedAtKind: timing === 'before-send' ? 'response_prepared' : 'decoded_response' },
    } })));
    assert.equal(state.attempts[0]!.adopted, false); assert.equal(state.attempts[0]!.resultArtifact, null);
    assert.deepEqual(await f.current(), state, 'custody proof does not adopt a page or write state');
    assert.ok(!cp.collection.pages.length);
  });
}
