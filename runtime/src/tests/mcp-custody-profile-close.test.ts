import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactRef, TaskSpec } from '../domain/model.js';
import { ToolResultSchema } from '../application/contracts.js';
import { toolExecution } from '../application/tool-execution-usage.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import type { AgentExecutionHost, HostToolAssembly } from '../presentation/host-tools.js';
import { acceptMcpRequest, assertMcpPeersStopped, createMcpFixtureHost, initializeMcpAgent,
  MCP_AGENT_PROFILE, MCP_AGENT_TOOL, mcpFixtureIdentityOptions, readMcpAudit } from './mcp-agent-profile-helper.js';

const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function includesError(error: unknown, expected: unknown): boolean {
  return error === expected || error instanceof AggregateError && error.errors.some(item => includesError(item, expected)) ||
    error instanceof Error && error.cause !== undefined && includesError(error.cause, expected);
}

/** Public host/store methods forward every real operation; no SDK, executor or product test hook is replaced. */
async function fixture(t: TestContext, backend: 'sqlite' | 'file-journal', failures = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-custody-profile-close-')));
  const rawReached = gate(), releaseRaw = gate(), finishEntered = gate(), toolsClosed = gate();
  const trace: string[] = [], lateCommits: string[] = [], committed: string[] = [];
  const errors = { primary: new Error('fixture_model_close_failed'), cleanup: new Error('fixture_tool_cleanup_failed') };
  let profile: AgentTurnProfile | undefined, closing: Promise<void> | undefined, running: Promise<void> | undefined;
  let storeClosed = false, rawRef: ArtifactRef | undefined, assembly: HostToolAssembly | undefined;
  let workId: string | undefined, attemptId: string | undefined;
  let stateAtClose: Awaited<ReturnType<AgentTurnProfile['runtime']['state']>> | undefined;
  t.after(async () => {
    releaseRaw.resolve();
    if (profile) {
      if (!closing) closing = profile.close();
      await Promise.allSettled([closing, ...(running ? [running] : [])]);
      await Promise.allSettled(profile.runtime.pendingExecutions().map(id => profile!.runtime.settlePending(id)));
    }
    rmSync(base, { recursive: true, force: true });
  });
  const ready = initializeMcpAgent(join(base, 'agent'), backend), auditFile = join(base, 'audit.jsonl');
  const configured = createMcpFixtureHost({ auditFile, ...(failures ? { closeError: errors.cleanup } : {}) });
  const model = configured.host.models.get(MCP_AGENT_PROFILE)!;
  const host: AgentExecutionHost = { ...configured.host, models: new Map([[MCP_AGENT_PROFILE, { execution: model.execution, async open(input) {
    const opened = await model.open(input);
    return { ...opened, async close() {
      trace.push('model-close'); assert.equal(assembly!.signal.aborted, true);
      await opened.close(); if (failures) throw errors.primary;
    } };
  } }]]), tools: { async open(context, supplied) {
    assert.ok(supplied); assembly = supplied;
    const state = supplied.custody.state, artifacts = supplied.custody.artifacts;
    const put = artifacts.put.bind(artifacts), commit = state.commit.bind(state), closeState = state.close.bind(state);
    artifacts.put = async (bytes, attributes) => {
      const ref = await put(bytes, attributes);
      let value: unknown; try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { return ref; }
      if (value && typeof value === 'object' && 'kind' in value && value.kind === 'mcp_decoded_response') {
        assert.equal(rawRef, undefined, 'only one original response is produced'); rawRef = ref;
        trace.push('raw-written'); rawReached.resolve(); await releaseRaw.promise; trace.push('raw-released');
      }
      return ref;
    };
    state.commit = async request => {
      if (storeClosed) lateCommits.push(request.commandId);
      const result = await commit(request);
      if (result.kind === 'committed') { committed.push(request.commandId); trace.push(`commit:${request.commandId.split(':')[0]}`); }
      return result;
    };
    state.close = async () => {
      trace.push('stores-close');
      if (workId) stateAtClose = (await state.get(workId)) ?? undefined;
      await closeState(); storeClosed = true; trace.push('stores-closed');
    };
    const opened = await configured.host.tools!.open(context, supplied);
    return { ...opened, async close() {
      trace.push('tools-close'); assert.equal(supplied.signal.aborted, true);
      try { await opened.close(); }
      finally { trace.push('tools-closed'); toolsClosed.resolve(); }
    } };
  } } };
  profile = await openAgentTurnProfile(ready.root, { provider: 'registered' }, host);
  assert.equal(profile.services.state, assembly!.custody.state); assert.equal(profile.services.artifacts, assembly!.custody.artifacts);
  const openedProfile = profile, finish = profile.runtime.finishClose.bind(profile.runtime);
  profile.runtime.finishClose = async (...args) => {
    trace.push('finish-close'); finishEntered.resolve();
    assert.equal(args.length, 0, 'profile.close must use the real bounded default, not a fixture-shortened deadline');
    try { await finish(...args); } finally { trace.push('finish-closed'); }
  };
  const prepare = async () => {
    const accepted = await acceptMcpRequest(openedProfile); workId = accepted.workId;
    const current = await openedProfile.runtime.state(workId), definition = openedProfile.contracts.visible(openedProfile.policy).find(tool => tool.id === MCP_AGENT_TOOL)!;
    assert.ok(definition);
    const task: TaskSpec = { id: 'read-mcp', description: 'Read the exact local fixture before profile shutdown', toolId: definition.id,
      toolVersion: definition.version, effect: 'read', input: { id: 'good' }, dependsOn: [], maxAttempts: 1, satisfies: [] };
    await openedProfile.runtime.submitPlan(workId, 'close-fixture-plan', { baseStateRevision: current.revision,
      baseGoalRevision: current.goal.revision, basePlanRevision: 0, reason: 'Test host lifetime, not model intelligence', tasks: [task], hypotheses: [] });
    const attempt = await openedProfile.runtime.reserve(workId, task.id); attemptId = attempt.id;
    running = openedProfile.runtime.execute(workId, attempt.id);
    await Promise.race([rawReached.promise, running.then(() => { throw new Error('raw_boundary_not_reached'); })]);
    assert.ok(rawRef); assert.equal(await openedProfile.services.state.receipt(workId, `mcp-response:${attempt.id}`), null);
    assert.equal(readMcpAudit(auditFile).filter(row => row.event === 'call').length, 1);
    assert.equal(configured.observed.modelInputs.length, 0, 'no model transport is called in this lifecycle fixture');
    return { workId, attempt, task, running };
  };
  const close = () => {
    closing ??= openedProfile.close(); void closing.catch(() => {}); return closing;
  };
  const inspectStored = async () => {
    assert.ok(workId && attemptId && rawRef);
    const reopened = await openAgentStores(new FileAgentProfileStore(runtimeRoot), ready.root, undefined, mcpFixtureIdentityOptions({ auditFile }));
    try {
      const state = await reopened.state.get(workId); assert.ok(state);
      const response = await reopened.state.receipt(workId, `mcp-response:${attemptId}`);
      const receive = await reopened.state.receipt(workId, `receive:${attemptId}`);
      const events = await reopened.state.events(workId, 0);
      const rawBytes = await reopened.artifacts.get(rawRef, openedProfile.policy);
      const attempt = state.attempts.find(value => value.id === attemptId)!;
      const result = attempt.resultArtifact ? ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(
        await reopened.artifacts.get(attempt.resultArtifact, openedProfile.policy)))) : null;
      return { state, response, receive, events, rawBytes, attempt, result };
    } finally { await reopened.close(); }
  };
  return { base, profile: openedProfile, assembly: assembly!, auditFile, configured, errors, trace, lateCommits, committed,
    rawReached, releaseRaw, finishEntered, toolsClosed, prepare, close, inspectStored,
    rawRef: () => rawRef, storeClosed: () => storeClosed, stateAtClose: () => stateAtClose };
}

function assertCloseOrder(trace: string[]) {
  const names = ['model-close', 'tools-close', 'tools-closed', 'finish-close', 'finish-closed', 'stores-close', 'stores-closed'];
  for (const name of names) assert.equal(trace.filter(value => value === name).length, 1, `${name} must occur exactly once`);
  for (let index = 1; index < names.length; index++) assert.ok(trace.indexOf(names[index - 1]!) < trace.indexOf(names[index]!));
}

for (const backend of ['sqlite', 'file-journal'] as const)
  test(`${backend}: profile close stops the actual MCP peer then drains captured custody before closing C01 stores`, { timeout: 20000 }, async t => {
    const f = await fixture(t, backend), p = await f.prepare();
    const closing = f.close(); assert.equal(f.assembly.signal.aborted, true);
    await f.finishEntered.promise; await p.running; await f.toolsClosed.promise;
    assertMcpPeersStopped(f.auditFile); assert.equal(f.storeClosed(), false);
    await assert.rejects(f.profile.runtime.execute(p.workId, 'another-attempt'), /executor_closed/);
    assert.equal(await f.profile.services.state.receipt(p.workId, `mcp-response:${p.attempt.id}`), null);
    f.releaseRaw.resolve(); await closing; await f.profile.runtime.settlePending(p.attempt.id); await f.close();
    assert.equal(f.storeClosed(), true); assertCloseOrder(f.trace); assert.deepEqual(f.lateCommits, []);
    await assert.rejects(f.profile.services.state.get(p.workId));
    await assert.rejects(f.profile.runtime.recordStoredUsage(p.workId, p.attempt.id), /executor_closed/);
    const stored = await f.inspectStored(); assert.ok(stored.response && stored.receive && stored.result);
    assert.deepEqual(stored.state, f.stateAtClose());
    assert.equal(stored.attempt.status, 'received'); assert.equal(stored.attempt.adopted, false); assert.deepEqual(stored.state.evidence, []);
    assert.equal(stored.result.status, 'error'); assert.deepEqual(stored.result.evidence, []); assert.deepEqual(stored.result.artifacts, []);
    assert.deepEqual(stored.attempt.execution, toolExecution('invoked', { transportCalls: 1, internalOperations: null, imageBytes: null, waitMs: null }));
    assert.equal(stored.events.filter(event => event.type === 'tool_execution_usage_recorded').length, 1);
    assert.equal(stored.state.budget.used.toolCalls, 1); assert.equal(stored.state.budget.used.modelCalls, 0);
    assert.equal(JSON.parse(new TextDecoder().decode(stored.rawBytes)).value.structuredContent.value, 30);
    assert.equal(readMcpAudit(f.auditFile).filter(row => row.event === 'call').length, 1);
    assert.deepEqual([f.configured.observed.modelCloses, f.configured.observed.toolCloses], [1, 1]);
  });

test('profile close deadline closes C01 stores and a subsequently released raw cannot publish response, usage or receive', { timeout: 20000 }, async t => {
  const f = await fixture(t, 'file-journal'), p = await f.prepare();
  const closing = f.close(); await f.finishEntered.promise; await p.running;
  await assert.rejects(closing, /executor_close_unconfirmed/);
  assertMcpPeersStopped(f.auditFile); assert.equal(f.storeClosed(), true); assertCloseOrder(f.trace);
  const before = await f.inspectStored(); assert.equal(before.response, null); assert.equal(before.receive, null);
  assert.equal(before.attempt.resultArtifact, null); assert.deepEqual(before.state, f.stateAtClose());
  const committedBefore = [...f.committed];
  f.releaseRaw.resolve(); await assert.rejects(f.profile.runtime.settlePending(p.attempt.id), /result_persistence_failed/);
  const after = await f.inspectStored(); assert.deepEqual(after, before);
  assert.deepEqual(f.committed, committedBefore); assert.deepEqual(f.lateCommits, []);
  assert.equal(after.events.filter(event => event.type === 'tool_execution_usage_recorded').length, 0);
  await assert.rejects(f.profile.services.state.get(p.workId));
  await assert.rejects(f.profile.runtime.execute(p.workId, 'another-attempt'), /executor_closed/);
  await assert.rejects(f.profile.runtime.recordStoredUsage(p.workId, p.attempt.id), /executor_closed/);
  await assert.rejects(f.close(), /executor_close_unconfirmed/);
  assert.equal(readMcpAudit(f.auditFile).filter(row => row.event === 'call').length, 1);
  assert.deepEqual([f.configured.observed.modelCloses, f.configured.observed.toolCloses], [1, 1]);
});

test('profile close preserves the first model-close error and MCP cleanup error while still draining raw and closing stores', { timeout: 20000 }, async t => {
  const f = await fixture(t, 'sqlite', true), p = await f.prepare();
  const closing = f.close(); await f.finishEntered.promise; await p.running;
  assertMcpPeersStopped(f.auditFile); assert.equal(f.storeClosed(), false);
  f.releaseRaw.resolve();
  let captured: unknown;
  await assert.rejects(closing, error => {
    captured = error; assert.ok(error instanceof AggregateError); assert.equal(error.cause, f.errors.primary);
    assert.equal(includesError(error, f.errors.primary), true); assert.equal(includesError(error, f.errors.cleanup), true); return true;
  });
  await f.profile.runtime.settlePending(p.attempt.id);
  await assert.rejects(f.close(), error => error === captured);
  assert.equal(f.storeClosed(), true); assertCloseOrder(f.trace); assert.deepEqual(f.lateCommits, []);
  const stored = await f.inspectStored(); assert.ok(stored.response && stored.receive); assert.deepEqual(stored.state, f.stateAtClose());
  assert.equal(stored.attempt.execution?.usage.transportCalls, 1); assert.deepEqual(stored.state.evidence, []);
  assert.equal(stored.attempt.adopted, false); assert.equal(stored.events.filter(event => event.type === 'tool_execution_usage_recorded').length, 1);
  await assert.rejects(f.profile.runtime.execute(p.workId, 'another-attempt'), /executor_closed/);
  assert.equal(readMcpAudit(f.auditFile).filter(row => row.event === 'call').length, 1);
  assert.deepEqual([f.configured.observed.modelCloses, f.configured.observed.toolCloses], [1, 1]);
});
