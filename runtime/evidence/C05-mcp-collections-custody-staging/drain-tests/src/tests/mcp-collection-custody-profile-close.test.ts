import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactSchema, ToolResultSchema } from '../application/contracts.js';
import { toolExecution } from '../application/tool-execution-usage.js';
import type { ArtifactRef, TaskSpec, WorkState } from '../domain/model.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import type { AgentExecutionHost, HostToolAssembly } from '../presentation/host-tools.js';
import { initializeMcpAgent, MCP_AGENT_PROFILE } from './mcp-agent-profile-helper.js';
import { COLLECTION_ENTRY_TEXT, createCollectionEntryHost, entryAudit, entryObservations, runtimeRoot,
  type CollectionEntryOptions } from './mcp-collection-entry-fixture.js';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function stopped(options: CollectionEntryOptions) {
  const audit = entryAudit(options), starts = audit.filter(row => row.event === 'start');
  assert.equal(starts.length, 1, 'the profile opened exactly one real stdio peer');
  for (const row of starts) {
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0);
    assert.equal(audit.filter(value => value.event === 'close' && value.pid === row.pid).length, 1);
    assert.throws(() => process.kill(row.pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
  }
  assert.equal(audit.filter(row => row.event === 'method' && row.method === 'tools/list').length, 1);
  assert.equal(audit.filter(row => row.event === 'call').length, 1);
}

/** The real profile owns runtime, stdio peer and C01 stores; wrappers only observe and hold its public artifact put. */
async function fixture(t: TestContext, backend: 'sqlite' | 'file-journal') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-collection-profile-close-')));
  const options: CollectionEntryOptions = { directory: join(base, 'agent'), backend, scenario: 'complete', now: Date.now(),
    auditFile: join(base, 'peer.jsonl'), hostAuditFile: join(base, 'host.jsonl') };
  const rawReached = gate(), releaseRaw = gate(), finishEntered = gate(), toolsClosed = gate();
  const trace: string[] = [], lateCommits: string[] = [], commits: string[] = [];
  let profile: AgentTurnProfile | undefined, closing: Promise<void> | undefined, running: Promise<void> | undefined;
  let assembly: HostToolAssembly | undefined, storesClosed = false, stateAtClose: WorkState | undefined;
  let workId: string | undefined, attemptId: string | undefined;
  let raw: { ref: ArtifactRef; bytes: Uint8Array; requestId: string; intentHead: ArtifactRef; recordedAt: number } | undefined;
  t.after(async () => {
    releaseRaw.resolve();
    try {
      if (profile) {
        closing ??= profile.close();
        await Promise.allSettled([closing, ...(running ? [running] : [])]);
        await Promise.allSettled(profile.runtime.pendingExecutions().map(id => profile!.runtime.settlePending(id)));
      }
      if (existsSync(options.auditFile)) {
        for (const row of entryAudit(options).filter(value => value.event === 'start'))
          assert.throws(() => process.kill(row.pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  const ready = initializeMcpAgent(options.directory, backend);
  const configured = createCollectionEntryHost(options, 'online'), model = configured.models.get(MCP_AGENT_PROFILE)!;
  const host: AgentExecutionHost = { models: new Map([[MCP_AGENT_PROFILE, { execution: model.execution, async open(input) {
    const opened = await model.open(input);
    return { ...opened, async close() {
      trace.push('model-close'); assert.equal(assembly!.signal.aborted, true); await opened.close();
    } };
  } }]]), tools: { async open(context, supplied) {
    assert.ok(supplied); assembly = supplied;
    const { state, artifacts } = supplied.custody;
    const put = artifacts.put.bind(artifacts), commit = state.commit.bind(state), closeState = state.close.bind(state);
    artifacts.put = async (bytes, attributes) => {
      const ref = await put(bytes, attributes);
      let value: Record<string, unknown>;
      try { value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>; } catch { return ref; }
      if (value?.kind !== 'mcp_collection_response') return ref;
      assert.equal(raw, undefined); assert.equal(value.workId, workId); assert.equal(value.attemptId, attemptId);
      assert.equal(value.failure, null); assert.equal(value.transportCalls, 1);
      const request = value.request as { requestId?: unknown };
      assert.equal(typeof request.requestId, 'string'); assert.equal(typeof value.recordedAt, 'number');
      raw = { ref, bytes: new Uint8Array(bytes), requestId: request.requestId as string,
        intentHead: ArtifactSchema.parse(value.intentHead), recordedAt: value.recordedAt as number };
      trace.push('raw-written'); rawReached.resolve(); await releaseRaw.promise; trace.push('raw-released');
      return ref;
    };
    state.commit = async request => {
      if (storesClosed) lateCommits.push(request.commandId);
      const result = await commit(request);
      if (result.kind === 'committed') { commits.push(request.commandId); trace.push(`commit:${request.commandId}`); }
      return result;
    };
    state.close = async () => {
      trace.push('stores-close'); if (workId) stateAtClose = (await state.get(workId)) ?? undefined;
      await closeState(); storesClosed = true; trace.push('stores-closed');
    };
    const opened = await configured.tools!.open(context, supplied);
    return { ...opened, async close() {
      trace.push('tools-close'); assert.equal(supplied.signal.aborted, true);
      try { await opened.close(); } finally { trace.push('tools-closed'); toolsClosed.resolve(); }
    } };
  } } };
  profile = await openAgentTurnProfile(ready.root, { provider: 'registered' }, host);
  const p = profile, finish = p.runtime.finishClose.bind(p.runtime);
  assert.equal(p.services.state, assembly!.custody.state); assert.equal(p.services.artifacts, assembly!.custody.artifacts);
  p.runtime.finishClose = async (...args) => {
    trace.push('finish-close'); finishEntered.resolve();
    assert.equal(args.length, 0, 'the real profile uses its bounded default; this test does not shorten it');
    try { await finish(...args); } finally { trace.push('finish-closed'); }
  };
  const prepare = async () => {
    const session = await p.sessions.open(p.actor, { channel: 'test', conversationId: 'collection-close' });
    const accepted = await p.turns.accept(p.actor, { sessionId: session.scope.sessionId, messageId: 'collection-close',
      rawText: COLLECTION_ENTRY_TEXT, mode: 'auto', scope: p.scope, policy: p.policy, limits: p.limits,
      binding: { ...p.executionActor, channel: 'test', conversationId: 'collection-close', recipientId: p.actor.principalId, destination: 'local' } });
    workId = accepted.workId;
    const before = await p.runtime.state(workId), definition = p.contracts.visible(p.policy).find(tool => tool.id === 'fixture.collection');
    assert.ok(definition);
    const task: TaskSpec = { id: 'collection-close', description: 'Read original collection records before profile shutdown',
      toolId: definition.id, toolVersion: definition.version, effect: 'read', input: { ids: ['a', 'b'] },
      dependsOn: [], maxAttempts: 1, satisfies: [] };
    await p.runtime.submitPlan(workId, 'collection-close-plan', { baseStateRevision: before.revision,
      baseGoalRevision: before.goal.revision, basePlanRevision: before.plan?.revision ?? 0,
      reason: 'Explicit lifecycle fixture; no model inference', tasks: [task], hypotheses: [] });
    const attempt = await p.runtime.reserve(workId, task.id); attemptId = attempt.id;
    running = p.runtime.execute(workId, attempt.id);
    await Promise.race([rawReached.promise, running.then(() => { throw new Error('collection_raw_boundary_not_reached'); })]);
    assert.ok(raw); assert.ok(raw.recordedAt < attempt.leaseUntil);
    const state = await p.runtime.state(workId), current = state.attempts.find(value => value.id === attempt.id)!;
    assert.equal(current.status, 'running'); assert.equal(current.execution?.mode, 'unreported');
    assert.deepEqual(current.readProgress!.head, raw.intentHead); assert.equal(current.readProgress!.unknownCalls, 1);
    const dispatch = await p.services.state.receipt(workId, `dispatch:${attempt.id}`);
    const intent = await p.services.state.receipt(workId, `read:${attempt.id}:${raw.intentHead.id}`);
    assert.ok(dispatch); assert.ok(intent);
    const responseId = `mcp-page:${attempt.id}:${raw.requestId}`;
    assert.equal(await p.services.state.receipt(workId, responseId), null);
    assert.equal(entryAudit(options).filter(row => row.event === 'call').length, 1);
    assert.equal(entryObservations(options).filter(row => row.kind === 'turn' || row.kind === 'compact' || row.kind === 'project').length, 0);
    return { workId, attempt, running, before: state, dispatch, intent, responseId, raw };
  };
  const close = () => { closing ??= p.close(); void closing.catch(() => {}); return closing; };
  const inspectStored = async () => {
    assert.ok(workId && attemptId && raw);
    const stores = await openAgentStores(new FileAgentProfileStore(runtimeRoot), ready.root);
    try {
      const state = await stores.state.get(workId); assert.ok(state);
      const attempt = state.attempts.find(value => value.id === attemptId)!;
      return { state, attempt, response: await stores.state.receipt(workId, `mcp-page:${attemptId}:${raw.requestId}`),
        receive: await stores.state.receipt(workId, `receive:${attemptId}`),
        dispatch: await stores.state.receipt(workId, `dispatch:${attemptId}`),
        intent: await stores.state.receipt(workId, `read:${attemptId}:${raw.intentHead.id}`),
        events: await stores.state.events(workId, 0), rawBytes: new Uint8Array(await stores.artifacts.get(raw.ref, p.policy)),
        result: attempt.resultArtifact ? ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(
          await stores.artifacts.get(attempt.resultArtifact, p.policy)))) : null };
    } finally { await stores.close(); }
  };
  return { profile: p, options, assembly: assembly!, trace, lateCommits, commits, releaseRaw, finishEntered, toolsClosed,
    prepare, close, inspectStored, storesClosed: () => storesClosed, stateAtClose: () => stateAtClose };
}

function closeOrder(trace: string[]) {
  const names = ['model-close', 'tools-close', 'tools-closed', 'finish-close', 'finish-closed', 'stores-close', 'stores-closed'];
  for (const name of names) assert.equal(trace.filter(value => value === name).length, 1, name);
  for (let n = 1; n < names.length; n++) assert.ok(trace.indexOf(names[n - 1]!) < trace.indexOf(names[n]!));
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: actual profile close drains a captured collection original and accounting before C01 closes`, { timeout: 20000 }, async t => {
    const f = await fixture(t, backend), p = await f.prepare();
    const closing = f.close(); assert.equal(f.assembly.signal.aborted, true);
    await f.finishEntered.promise; await p.running; await f.toolsClosed.promise;
    stopped(f.options); assert.equal(f.storesClosed(), false);
    assert.equal(await f.profile.services.state.receipt(p.workId, p.responseId), null);
    await assert.rejects(f.profile.runtime.execute(p.workId, 'another-attempt'), /executor_closed/);
    f.releaseRaw.resolve(); await closing; await f.profile.runtime.settlePending(p.attempt.id); await f.close();
    closeOrder(f.trace); assert.equal(f.storesClosed(), true); assert.deepEqual(f.lateCommits, []);
    const stored = await f.inspectStored(); assert.ok(stored.response && stored.receive && stored.result);
    assert.deepEqual(stored.state, f.stateAtClose()); assert.deepEqual(stored.rawBytes, p.raw.bytes);
    assert.deepEqual(stored.dispatch, p.dispatch); assert.deepEqual(stored.intent, p.intent);
    assert.deepEqual(stored.attempt.readProgress, p.before.attempts[0]!.readProgress);
    assert.equal(stored.attempt.owner, p.attempt.owner); assert.equal(stored.attempt.leaseUntil, p.attempt.leaseUntil);
    assert.equal(stored.attempt.status, 'received'); assert.equal(stored.attempt.adopted, false);
    assert.equal(stored.result.status, 'error'); assert.deepEqual(stored.result.evidence, []); assert.deepEqual(stored.result.artifacts, []);
    assert.deepEqual(stored.state.evidence, []); assert.equal(stored.state.attempts.length, 1); assert.equal(stored.state.modelCalls.length, 0);
    assert.deepEqual(stored.attempt.execution, toolExecution('invoked', { transportCalls: 1, internalOperations: null, imageBytes: null, waitMs: null }));
    const usage = stored.events.filter(event => event.type === 'tool_execution_usage_recorded'); assert.equal(usage.length, 1);
    assert.equal(stored.events.filter(event => event.type === 'read_response_reconciled').length, 0);
    assert.equal(stored.state.budget.used.toolCalls, 1); assert.equal(stored.state.budget.used.modelCalls, 0);
    assert.deepEqual(entryObservations(f.options).filter(row => row.kind === 'turn' || row.kind === 'compact' || row.kind === 'project'), []);
    assert.equal(entryObservations(f.options).filter(row => row.kind === 'fetch').length, 1);
    for (const commandId of [p.responseId, `receive:${p.attempt.id}`]) {
      const position = f.trace.indexOf(`commit:${commandId}`);
      assert.ok(position >= 0 && position < f.trace.indexOf('finish-closed'));
    }
    assert.equal(f.commits.filter(id => id.startsWith(`tool-usage:${p.attempt.id}:`)).length, 1);
    stopped(f.options);
    await assert.rejects(f.profile.services.state.get(p.workId));
    await assert.rejects(f.profile.runtime.recordStoredUsage(p.workId, p.attempt.id), /executor_closed/);
  });

  test(`${backend}: profile drain expiry revokes collection publication before stores close and rejects a later raw release`, { timeout: 20000 }, async t => {
    const f = await fixture(t, backend), p = await f.prepare();
    const closing = f.close(); await f.finishEntered.promise; await p.running;
    await assert.rejects(closing, /executor_close_unconfirmed/);
    closeOrder(f.trace); stopped(f.options); assert.equal(f.storesClosed(), true);
    const before = await f.inspectStored(); assert.deepEqual(before.state, f.stateAtClose());
    assert.equal(before.response, null); assert.equal(before.receive, null); assert.equal(before.result, null);
    assert.deepEqual(before.rawBytes, p.raw.bytes); assert.deepEqual(before.dispatch, p.dispatch); assert.deepEqual(before.intent, p.intent);
    assert.deepEqual(before.attempt.readProgress, p.before.attempts[0]!.readProgress);
    assert.equal(before.attempt.resultArtifact, null); assert.equal(before.attempt.execution?.mode, 'unreported');
    const committed = [...f.commits], audit = entryAudit(f.options);
    f.releaseRaw.resolve();
    await assert.rejects(f.profile.runtime.settlePending(p.attempt.id), /result_persistence_failed/);
    const after = await f.inspectStored(); assert.deepEqual(after, before);
    assert.deepEqual(f.commits, committed); assert.deepEqual(f.lateCommits, []); assert.deepEqual(entryAudit(f.options), audit);
    assert.equal(after.events.filter(event => event.type === 'tool_execution_usage_recorded' || event.type === 'read_response_reconciled').length, 0);
    assert.deepEqual(after.state.evidence, []); assert.equal(after.state.attempts.length, 1); assert.equal(after.state.modelCalls.length, 0);
    assert.equal(after.state.budget.used.toolCalls, 1); assert.equal(after.state.budget.used.modelCalls, 0);
    assert.deepEqual(entryObservations(f.options).filter(row => row.kind === 'turn' || row.kind === 'compact' || row.kind === 'project'), []);
    await assert.rejects(f.profile.services.state.get(p.workId));
    await assert.rejects(f.profile.runtime.execute(p.workId, 'another-attempt'), /executor_closed/);
    await assert.rejects(f.profile.runtime.recordStoredUsage(p.workId, p.attempt.id), /executor_closed/);
    await assert.rejects(f.close(), /executor_close_unconfirmed/);
  });
}
