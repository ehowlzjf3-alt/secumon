import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolResultSchema } from '../application/contracts.js';
import { readGeneratedAnswer } from '../application/generated-answer.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { acceptMcpRequest, assertMcpPeersStopped, createMcpFixtureHost, initializeMcpAgent, MCP_AGENT_PROVIDER,
  MCP_AGENT_TEXT, MCP_AGENT_TOOL, mcpFixtureAnswer, readMcpAudit, type McpFixtureHostOptions } from './mcp-agent-profile-helper.js';

function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-agent-profile-'))), active = new Set<AgentTurnProfile>();
  t.after(async () => {
    const errors: unknown[] = [];
    try { for (const profile of active) { try { await profile.close(); } catch (error) { errors.push(error); } } }
    finally { rmSync(base, { recursive: true, force: true }); }
    if (errors.length) throw new AggregateError(errors, 'mcp_profile_fixture_cleanup_failed');
  });
  return { base,
    create(name: string, backend: 'sqlite' | 'file-journal' = 'sqlite') {
      const ready = initializeMcpAgent(join(base, name), backend);
      return { directory: ready.root, agentId: ready.identity.agentId, auditFile: join(base, `${name}.jsonl`) };
    },
    async open(directory: string, options: McpFixtureHostOptions) {
      const host = createMcpFixtureHost(options), profile = await openAgentTurnProfile(directory, { provider: 'registered' }, host.host);
      active.add(profile); return { profile, observed: host.observed };
    },
    async close(profile: AgentTurnProfile) { try { await profile.close(); } finally { active.delete(profile); } },
  };
}
const calls = (path: string) => readMcpAudit(path).filter(row => row.event === 'call');
const methods = (path: string, method: string) => readMcpAudit(path).filter(row => row.event === 'method' && row.method === method);
function chainContains(error: unknown, expected: unknown): boolean {
  return error === expected || error instanceof AggregateError && error.errors.some(value => chainContains(value, expected)) ||
    error instanceof Error && error.cause !== undefined && chainContains(error.cause, expected);
}
async function receiveMcp(profile: AgentTurnProfile, workId: string) {
  assert.ok(profile.planning);
  const call = await profile.planning.reserve(workId);
  await profile.planning.execute(workId, call.id); assert.equal(await profile.planning.adopt(workId, call.id), true);
  const planned = await profile.runtime.state(workId), task = planned.plan!.tasks.find(value => value.toolId === MCP_AGENT_TOOL)!;
  assert.ok(task, 'the model must choose the MCP tool in its actual plan');
  const attempt = await profile.runtime.reserve(workId, task.id); await profile.runtime.execute(workId, attempt.id);
  const state = await profile.runtime.state(workId), received = state.attempts.find(value => value.id === attempt.id)!;
  assert.equal(received.status, 'received'); assert.equal(received.adopted, false); assert.ok(received.resultArtifact);
  const resultBytes = await profile.services.artifacts.get(received.resultArtifact, state.policy);
  const result = ToolResultSchema.parse(JSON.parse(Buffer.from(resultBytes).toString('utf8')));
  assert.equal(result.status, 'success'); assert.equal(result.artifacts.length, 1);
  const rawBytes = await profile.services.artifacts.get(result.artifacts[0]!, state.policy);
  const raw = JSON.parse(Buffer.from(rawBytes).toString('utf8')) as {
    kind: string; workId: string; attemptId: string; contractDigest: string; inputDigest: string;
    session: { endpointId: string; protocolVersion: string }; value: { content: unknown[]; structuredContent: { id: string; source: string; value: number } };
  };
  return { state, attempt: received, task, result, resultBytes, rawBytes, raw };
}

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: a C01 MCP profile preserves received proof and completes after reopen without repeating the read`, { timeout: 60000 }, async t => {
  const f = fixture(t), agent = f.create('agent', backend), options = { auditFile: agent.auditFile, documentValue: 47 };
  let opened = await f.open(agent.directory, options), profile = opened.profile;
  assert.equal(profile.agentId, agent.agentId); assert.equal(profile.stateBackend, backend);
  const assembly = opened.observed.assemblies[0]!;
  assert.equal(assembly.custody.state, profile.services.state); assert.equal(assembly.custody.artifacts, profile.services.artifacts);
  assert.equal(assembly.custody.digester, profile.services.digester); assert.equal(assembly.custody.clock, profile.services.clock);
  assert.equal(assembly.signal, profile.services.executionAuthority!.signal);
  assert.equal(opened.observed.sourceLists, 1); assert.equal(calls(agent.auditFile).length, 0);
  const tool = profile.contracts.visible(profile.policy).find(value => value.id === MCP_AGENT_TOOL)!;
  assert.ok(tool); assert.equal(tool.provider, MCP_AGENT_PROVIDER); assert.match(tool.version, /^1\.[a-f0-9]{24}$/);
  assert.equal(tool.resultValidation, 'artifact-proof-v1');
  assert.equal(profile.contracts.visible(profile.policy).some(value => value.id === 'fixture.read'), false);
  const accepted = await acceptMcpRequest(profile); assert.equal(opened.observed.modelInputs.length, 0);
  const received = await receiveMcp(profile, accepted.workId);
  assert.equal(received.task.toolVersion, tool.version); assert.equal(received.attempt.toolVersion, tool.version);
  assert.equal(opened.observed.modelOptions[0]!.tools.find(value => value.id === MCP_AGENT_TOOL)?.version, tool.version);
  assert.equal(received.raw.kind, 'mcp_decoded_response'); assert.equal(received.raw.workId, accepted.workId);
  assert.equal(received.raw.attemptId, received.attempt.id); assert.equal(received.raw.contractDigest, received.attempt.contractDigest);
  assert.equal(received.raw.inputDigest, received.attempt.inputDigest); assert.equal(received.raw.session.protocolVersion, '2026-07-28');
  assert.deepEqual(received.raw.value.structuredContent, { id: 'good', source: 'doc-origin', observedAt: 900, value: 47, complete: true });
  assert.ok(received.raw.value.content.length > 0); assert.equal(received.result.output && typeof received.result.output === 'object' && !Array.isArray(received.result.output) && received.result.output['value'], 47);
  assert.deepEqual(received.result.usage, { transportCalls: 1, internalOperations: null, imageBytes: null, waitMs: null });
  assert.deepEqual(received.state.evidence, []);
  const receipts = await Promise.all(['dispatch', 'mcp-intent', 'mcp-response', 'receive'].map(name => profile.services.state.receipt(accepted.workId, `${name}:${received.attempt.id}`)));
  assert.ok(receipts.every(Boolean)); assert.equal(await profile.contracts.validateResult(received.state, received.result), true);
  assert.equal(calls(agent.auditFile).length, 1);
  await f.close(profile); assert.equal(assembly.signal.aborted, true); assertMcpPeersStopped(agent.auditFile);
  assert.equal(opened.observed.toolCloses, 1); assert.equal(opened.observed.modelCloses, 1);

  opened = await f.open(agent.directory, options); profile = opened.profile;
  assert.equal(profile.agentId, agent.agentId); assert.equal(opened.observed.modelInputs.length, 0);
  assert.equal(profile.contracts.visible(profile.policy).find(value => value.id === MCP_AGENT_TOOL)?.version, tool.version);
  assert.equal(await profile.contracts.validateResult(await profile.runtime.state(accepted.workId), received.result), true);
  assert.deepEqual(await Promise.all(['dispatch', 'mcp-intent', 'mcp-response', 'receive'].map(name => profile.services.state.receipt(accepted.workId, `${name}:${received.attempt.id}`))), receipts);
  assert.deepEqual(await profile.services.artifacts.get(received.result.artifacts[0]!, received.state.policy), received.rawBytes);
  const result = await profile.workflow.run(accepted.workId, profile.actor); assert.equal(result.control.kind, 'complete');
  const done = await profile.runtime.state(accepted.workId);
  assert.equal(done.attempts.length, 1); assert.equal(done.attempts[0]!.id, received.attempt.id); assert.equal(done.attempts[0]!.adopted, true);
  assert.equal(done.evidence.length, 1); assert.equal(done.evidence[0]!.facts.value, 47); assert.equal(done.evidence[0]!.scope, profile.scope);
  assert.deepEqual(done.evidence[0]!.artifact, received.result.artifacts[0]);
  assert.equal((await readGeneratedAnswer(profile.services, done))?.text, mcpFixtureAnswer(47));
  assert.equal(done.budget.used.toolCalls, 1); assert.equal(done.budget.used.modelCalls, 2); assert.equal(done.budget.used.tokens, 500);
  assert.equal(opened.observed.modelInputs.length, 1); assert.equal(calls(agent.auditFile).length, 1);
  const sessionId = done.conversation!.session!.scope.sessionId;
  const history = await profile.sessions.history(profile.actor, sessionId, profile.policy, { limit: 100 });
  assert.equal(history.entries.filter(value => value.role === 'user' && value.text === MCP_AGENT_TEXT).length, 1);
  assert.equal(history.entries.filter(value => value.role === 'assistant' && value.text === mcpFixtureAnswer(47)).length, 1);
  await f.close(profile); assertMcpPeersStopped(agent.auditFile);

  opened = await f.open(agent.directory, options); profile = opened.profile;
  assert.deepEqual(await profile.sessions.history(profile.actor, sessionId, profile.policy, { limit: 100 }), history);
  assert.equal((await profile.workflow.run(done.id, profile.actor)).control.kind, 'complete');
  assert.deepEqual((await profile.runtime.state(done.id)).budget, done.budget);
  assert.equal(opened.observed.modelInputs.length, 0); assert.equal(calls(agent.auditFile).length, 1);
  assert.equal(methods(agent.auditFile, 'tools/call').length, 1);
  assert.equal(methods(agent.auditFile, 'tools/list').length, 3, 'new profile lifetimes rediscover; this is not offline opening');
  assert.equal(readMcpAudit(agent.auditFile).filter(value => value.event === 'start').length, 3);
  assert.equal((await profile.services.state.deliveries(done.id)).filter(value => value.kind === 'result' && value.status === 'delivered').length, 1);
  await f.close(profile); assertMcpPeersStopped(agent.auditFile);
});

test('two C01 agents keep identical MCP tool names and different originals in their own custody', { timeout: 60000 }, async t => {
  const f = fixture(t), left = f.create('left'), right = f.create('right', 'file-journal');
  const a = await f.open(left.directory, { auditFile: left.auditFile, documentValue: 17 });
  const b = await f.open(right.directory, { auditFile: right.auditFile, documentValue: 29 });
  assert.notEqual(a.profile.agentId, b.profile.agentId); assert.notEqual(a.profile.scope, b.profile.scope);
  assert.notEqual(a.observed.assemblies[0]!.custody.state, b.observed.assemblies[0]!.custody.state);
  assert.notEqual(a.observed.assemblies[0]!.custody.artifacts, b.observed.assemblies[0]!.custody.artifacts);
  const x = await acceptMcpRequest(a.profile, 'same-message-id'), y = await acceptMcpRequest(b.profile, 'same-message-id');
  const first = await receiveMcp(a.profile, x.workId), second = await receiveMcp(b.profile, y.workId);
  assert.equal(first.task.toolVersion, second.task.toolVersion); assert.equal(first.raw.value.structuredContent.value, 17);
  assert.equal(second.raw.value.structuredContent.value, 29); assert.notDeepEqual(first.rawBytes, second.rawBytes);
  assert.equal(await a.profile.services.state.get(y.workId), null); assert.equal(await b.profile.services.state.get(x.workId), null);
  assert.equal(await a.profile.contracts.validateResult(first.state, second.result), false);
  assert.equal(await b.profile.contracts.validateResult(second.state, first.result), false);
  await assert.rejects(a.profile.services.artifacts.get(second.result.artifacts[0]!, first.state.policy), { code: 'ENOENT' });
  await assert.rejects(b.profile.services.artifacts.get(first.result.artifacts[0]!, second.state.policy), { code: 'ENOENT' });
  assert.equal((await a.profile.workflow.run(x.workId, a.profile.actor)).control.kind, 'complete');
  assert.equal((await readGeneratedAnswer(a.profile.services, await a.profile.runtime.state(x.workId)))?.text, mcpFixtureAnswer(17));
  await f.close(a.profile); assertMcpPeersStopped(left.auditFile);
  const livePeer = readMcpAudit(right.auditFile).find(row => row.event === 'start')!.pid!;
  assert.doesNotThrow(() => process.kill(livePeer, 0)); assert.equal(b.observed.toolCloses, 0);
  assert.equal((await b.profile.workflow.run(y.workId, b.profile.actor)).control.kind, 'complete');
  assert.equal((await readGeneratedAnswer(b.profile.services, await b.profile.runtime.state(y.workId)))?.text, mcpFixtureAnswer(29));
  const history = await b.profile.sessions.history(b.profile.actor, second.state.conversation!.session!.scope.sessionId, b.profile.policy, { limit: 100 });
  assert.equal(history.entries.some(row => row.text === mcpFixtureAnswer(17)), false);
  assert.equal(calls(left.auditFile).length, 1); assert.equal(calls(right.auditFile).length, 1);
  await f.close(b.profile); assertMcpPeersStopped(right.auditFile);
});

test('a projector revision change on reopen cannot adopt a prior MCP proof or replace it with a hidden call', { timeout: 60000 }, async t => {
  const f = fixture(t), agent = f.create('agent');
  let opened = await f.open(agent.directory, { auditFile: agent.auditFile });
  const accepted = await acceptMcpRequest(opened.profile), received = await receiveMcp(opened.profile, accepted.workId);
  await f.close(opened.profile); assertMcpPeersStopped(agent.auditFile);
  opened = await f.open(agent.directory, { auditFile: agent.auditFile, projectorVersion: '2' });
  assert.notEqual(opened.profile.contracts.visible(opened.profile.policy).find(tool => tool.id === MCP_AGENT_TOOL)?.version, received.task.toolVersion);
  assert.equal(await opened.profile.contracts.validateResult(await opened.profile.runtime.state(accepted.workId), received.result), false);
  const rejected = await opened.profile.runtime.adopt(accepted.workId, received.attempt.id);
  assert.equal(rejected.attempts[0]!.adopted, false); assert.equal(rejected.attempts[0]!.error?.code, 'tool_proof_unavailable');
  assert.deepEqual(rejected.evidence, []); assert.equal(rejected.generatedAnswer, undefined);
  assert.deepEqual(await opened.profile.services.artifacts.get(received.result.artifacts[0]!, rejected.policy), received.rawBytes);
  assert.equal(calls(agent.auditFile).length, 1); assert.equal(opened.observed.modelInputs.length, 0);
  await f.close(opened.profile); assertMcpPeersStopped(agent.auditFile);
});

test('failed MCP discovery closes the started peer and model without returning a partial C01 profile', { timeout: 30000 }, async t => {
  const f = fixture(t), agent = f.create('agent');
  const configured = createMcpFixtureHost({ auditFile: agent.auditFile, mode: 'schema' });
  await assert.rejects(openAgentTurnProfile(agent.directory, { provider: 'registered' }, configured.host), /provider_listing_failed/);
  assert.equal(configured.observed.modelCloses, 1); assert.equal(configured.observed.toolCloses, 1);
  assert.equal(configured.observed.assemblies[0]!.signal.aborted, true); assert.equal(calls(agent.auditFile).length, 0);
  assertMcpPeersStopped(agent.auditFile);
  await assert.rejects(configured.observed.assemblies[0]!.custody.state.get('closed-profile-probe'));
  const reopened = await f.open(agent.directory, { auditFile: agent.auditFile });
  assert.equal(reopened.profile.agentId, agent.agentId); await f.close(reopened.profile); assertMcpPeersStopped(agent.auditFile);
});

test('a source failure after real discovery preserves its cause and independent cleanup failure and still stops the peer', { timeout: 30000 }, async t => {
  const f = fixture(t), agent = f.create('agent'), sourceError = new Error('fixture_source_failed_after_discovery'), closeError = new Error('fixture_cleanup_failed');
  const configured = createMcpFixtureHost({ auditFile: agent.auditFile, sourceError, closeError });
  await assert.rejects(openAgentTurnProfile(agent.directory, { provider: 'registered' }, configured.host), error => {
    assert.equal(chainContains(error, sourceError), true); assert.equal(chainContains(error, closeError), true); return true;
  });
  assert.equal(configured.observed.sourceLists, 1); assert.equal(configured.observed.modelCloses, 1); assert.equal(configured.observed.toolCloses, 1);
  assert.equal(configured.observed.assemblies[0]!.signal.aborted, true); assert.equal(calls(agent.auditFile).length, 0);
  assertMcpPeersStopped(agent.auditFile);
  await assert.rejects(configured.observed.assemblies[0]!.custody.state.get('closed-profile-probe'));
});

test('normal profile close remains once-only after an MCP cleanup error and closes the model and C01 handles', { timeout: 30000 }, async t => {
  const f = fixture(t), agent = f.create('agent'), closeError = new Error('fixture_close_error');
  const opened = await f.open(agent.directory, { auditFile: agent.auditFile, closeError });
  const closed = assert.rejects(f.close(opened.profile), error => error === closeError); await closed;
  await assert.rejects(opened.profile.close(), error => error === closeError);
  assert.equal(opened.observed.modelCloses, 1); assert.equal(opened.observed.toolCloses, 1); assertMcpPeersStopped(agent.auditFile);
  await assert.rejects(opened.observed.assemblies[0]!.custody.state.get('closed-profile-probe'));
  const reopened = await f.open(agent.directory, { auditFile: agent.auditFile });
  assert.equal(reopened.profile.agentId, agent.agentId); await f.close(reopened.profile); assertMcpPeersStopped(agent.auditFile);
});
