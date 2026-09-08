import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { A2aMessageSchema, A2aTaskSchema, type A2aMessage } from '../application/a2a-contracts.js';
import type { AgentTurnInput } from '../application/agent-turn-types.js';
import { ToolResultSchema } from '../application/contracts.js';
import type { AgentTurnResult } from '../domain/agent-turn.js';
import type { ArtifactRef, ContextPacket, Json, Policy } from '../domain/model.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { StructuredAgentTurnAdapter } from '../infrastructure/structured-agent-turn.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { createJsonRpcA2aRegistration } from '../presentation/host-a2a.js';
import type { AgentExecutionHost } from '../presentation/host-tools.js';

export type A2aEntryRole = 'sender' | 'receiver';
type Handler = Awaited<ReturnType<AgentTurnProfile['openA2aHandler']>>;
export const A2A_ENTRY_PEER = 'remote-agent', A2A_ENTRY_PROFILE = 'a2a-entry';
export const A2A_ENTRY_ENDPOINT = 'http://127.0.0.1/a2a-local-fixture';
export const A2A_ENTRY_POLICY: Policy = { tenantId: 'a2a-entry-company', principalId: 'same-operator',
  allowedTools: [], allowedLabels: ['public'], allowedDestinations: ['local'], allowWrites: false };
export function a2aObject(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
export function a2aResultTask(value: unknown) { return A2aTaskSchema.parse(a2aObject(value)['task']); }
function answer(text: string): AgentTurnResult {
  return { kind: 'answer', text, evidenceIds: [], assessment: { type: 'model_self_review', verdict: 'satisfied',
    rationale: 'Report only the supplied conversation or the explicit remote response.', missing: [], counterarguments: ['A remote answer is not independent evidence.'] } };
}
function currentMessage(packet: ContextPacket): A2aMessage {
  assert.ok(packet.session);
  const basis = packet.session.basis.input;
  const entry = packet.session.entries.find(value => value.role === 'user' && value.sourceId === basis.messageId && value.sequence === basis.sequence);
  assert.ok(entry, 'the current original A2A input must be visible');
  return A2aMessageSchema.parse(JSON.parse(entry.text));
}
function receiverTurn(packet: ContextPacket): AgentTurnResult {
  const message = currentMessage(packet), data = message.parts.flatMap(part => 'data' in part ? [a2aObject(part.data)] : []);
  if (data.some(value => value['operation'] === 'ask') && !data.some(value => typeof value['answer'] === 'string'))
    return { kind: 'question', question: 'Which date should the note use?' };
  const text = data.find(value => typeof value['answer'] === 'string')?.['answer'] ?? message.parts.filter(part => 'text' in part).map(part => part.text).join(' ');
  return answer(`Receiver response: ${String(text)}`);
}
function senderTurn(packet: ContextPacket): AgentTurnResult {
  const observations = packet.toolObservations ?? [], received = observations.find(value => value.toolId === A2A_ENTRY_PEER + '.get' && value.status === 'success');
  if (received) {
    const task = A2aTaskSchema.parse(a2aObject(received.output)['reply']);
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
    return answer(`The remote agent reported: ${task.artifacts?.flatMap(value => value.parts).filter(value => 'text' in value).map(value => value.text).join(' ')}`);
  }
  const sent = observations.find(value => value.toolId === A2A_ENTRY_PEER + '.send' && value.status === 'success');
  const operation = sent ? 'get' : 'send';
  const input: Record<string, Json> = sent ? { taskId: a2aResultTask(a2aObject(sent.output)['reply']).id } :
    { parts: [{ text: 'Prepare a short reply from this incoming request.' }, { data: { operation: 'echo', assertedAgentId: 'untrusted-agent' } }],
      metadata: { callerId: 'untrusted-caller', endpoint: 'https://untrusted.invalid', scope: 'untrusted-scope' } };
  assert.ok(packet.activeToolIds.includes(A2A_ENTRY_PEER + '.' + operation));
  return { kind: 'plan', proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision,
    basePlanRevision: packet.plan?.revision ?? 0, hypotheses: [], reason: 'Use the registered peer and then inspect its original task.',
    tasks: [{ id: 'a2a-' + operation, description: 'Perform the explicit A2A operation.', toolId: A2A_ENTRY_PEER + '.' + operation,
      toolVersion: '1.0', effect: sent ? 'read' : 'write', input, dependsOn: [], maxAttempts: 1, satisfies: [] }] } };
}

/** Separate real SQLite profiles; fetch delivers serialized JSON to the actual handler without opening a network listener. */
export async function a2aEntryFixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-entry-'))), runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
  const profiles = new FileAgentProfileStore(runtimeRoot), roles = ['sender', 'receiver'] as const;
  const ready = Object.fromEntries(roles.map(role => [role, profiles.initialize(join(base, role),
    { purpose: role === 'sender' ? 'Coordinate an explicitly requested remote reply.' : 'Respond to incoming generic tasks.', stateBackend: 'sqlite', personalMemory: 'sqlite' })]));
  for (const role of roles) writeFileSync(join(base, role, 'config.json'), JSON.stringify({ ...ready[role]!.config,
    model: { profile: A2A_ENTRY_PROFILE }, features: { ...ready[role]!.config.features, a2a: true }, skills: { mode: 'off' } }), { mode: 0o600 });
  const opened = new Map<A2aEntryRole, AgentTurnProfile>(), handlers = new Map<string, Handler>(), raw = new Map<A2aEntryRole, ArtifactRef>();
  const observed = { inputs: { sender: [] as AgentTurnInput[], receiver: [] as AgentTurnInput[] },
    exchanges: [] as { request: Record<string, unknown>; response: unknown; url: string }[], modelsClosed: [] as A2aEntryRole[] };
  const controls: { loseSendResponse: boolean; beforeReceiverReply?: (signal: AbortSignal) => Promise<void> } = { loseSendResponse: false };
  const current = (role: A2aEntryRole) => { const value = opened.get(role); assert.ok(value); return value; };
  const callerId = () => 'registered:' + current('sender').agentId;
  async function handler(role: A2aEntryRole = 'receiver', caller = callerId()) {
    const key = role + ':' + caller; let value = handlers.get(key);
    if (!value) {
      const profile = current(role);
      value = await profile.openA2aHandler({ callerId: caller, actor: profile.actor, policy: profile.policy, destination: 'local', maxSteps: 30 });
      handlers.set(key, value);
    }
    return value;
  }
  const transport: typeof fetch = async (url, init) => {
    assert.equal(String(url), A2A_ENTRY_ENDPOINT); assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('A2A-Version'), '1.0'); assert.equal(typeof init?.body, 'string');
    const request = a2aObject(JSON.parse(init!.body as string)), selected = await handler();
    const response = await selected.handle('1.0', request);
    observed.exchanges.push({ request: structuredClone(request), response: structuredClone(response), url: String(url) });
    if (controls.loseSendResponse && request['method'] === 'SendMessage') throw new Error('injected_after_actual_a2a_acceptance');
    return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  function host(role: A2aEntryRole): AgentExecutionHost {
    const identity = { provider: 'local-fixture', model: 'a2a-entry-' + role, revision: '1' };
    return { identityRegistryDirectory: join(base, 'registry'), a2aInbound: true,
      ...(role === 'sender' ? { a2a: createJsonRpcA2aRegistration({ id: A2A_ENTRY_PEER, endpoint: A2A_ENTRY_ENDPOINT,
        destination: 'local', labels: ['public'], fetch: transport }, { allowWrites: true }) } : {}),
      models: new Map([[A2A_ENTRY_PROFILE, { execution: 'deterministic_fixture', async open(profile) {
        const planner = new StructuredAgentTurnAdapter({ identity, profile, destination: 'local', maxRequestBytes: 131072,
          capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000, maxOutputTokens: 2048 } },
        { async invoke(request, signal) {
          observed.inputs[role].push(structuredClone(request.input));
          if (role === 'receiver') await controls.beforeReceiverReply?.(signal);
          signal.throwIfAborted();
          const result = role === 'sender' ? senderTurn(request.input.packet) : receiverTurn(request.input.packet);
          return { provider: identity.provider, model: identity.model, finish: 'stop', content: JSON.stringify(result), usage: { inputTokens: 200, outputTokens: 60 } };
        } });
        return { planner, inputLimits: { maxInputBytes: 131072, maxOutputTokens: 2048 }, async close() { observed.modelsClosed.push(role); } };
      } }]]),
      tools: { async open(_context, assembly) {
        assert.ok(assembly);
        if (!raw.has(role)) raw.set(role, await assembly.custody.artifacts.put(new TextEncoder().encode(role + '_PRIVATE_ORIGINAL'),
          { tenantId: A2A_ENTRY_POLICY.tenantId, labels: ['public'], mediaType: 'text/plain' }));
        return { tools: [], policy: A2A_ENTRY_POLICY,
          limits: { toolCalls: 30, modelCalls: 16, tokens: 1000000, replans: 8, wallTimeMs: 3600000 }, async close() {} };
      } } };
  }
  async function open() { for (const role of ['receiver', 'sender'] as const) opened.set(role, await openAgentTurnProfile(join(base, role), { provider: 'registered' }, host(role))); }
  async function close() { handlers.clear(); for (const role of roles) { const profile = opened.get(role); if (profile) { await profile.close(); opened.delete(role); } } }
  t.after(async () => { await close(); rmSync(base, { recursive: true, force: true }); }); await open();
  async function acceptSender(messageId = 'sender-original') {
    const profile = current('sender'), session = await profile.sessions.open(profile.actor, { channel: 'test', conversationId: 'sender-resident' });
    const accepted = await profile.turns.accept(profile.actor, { sessionId: session.scope.sessionId, messageId,
      rawText: 'Ask the registered remote agent for a reply and report what it said.', mode: 'auto', scope: profile.scope,
      policy: profile.policy, limits: profile.limits,
      binding: { ...profile.executionActor, channel: 'test', conversationId: 'sender-resident', recipientId: profile.actor.principalId, destination: 'local' } });
    await profile.outbox.flush(accepted.workId, profile.actor); return { ...accepted, sessionId: session.scope.sessionId };
  }
  async function through(workId: string, operation: 'send' | 'get') {
    const profile = current('sender');
    for (let step = 0; step < 40; step++) {
      const state = await profile.runtime.state(workId), attempt = state.attempts.find(value => value.toolId === A2A_ENTRY_PEER + '.' + operation &&
        !['reserved', 'running', 'received'].includes(value.status));
      if (attempt) {
        const result = attempt.resultArtifact ? ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await profile.services.artifacts.get(attempt.resultArtifact, state.policy)))) : null;
        return { state, attempt, result };
      }
      const run = await profile.workflow.run(workId, profile.executionActor, { maxSteps: 1 });
      if (['blocked', 'failed', 'cancelled', 'paused', 'complete'].includes(run.control.kind)) {
        const latest = await profile.runtime.state(workId);
        if (!latest.attempts.some(value => value.toolId === A2A_ENTRY_PEER + '.' + operation && !['reserved', 'running', 'received'].includes(value.status)))
          assert.fail(JSON.stringify({ run, progress: latest.progress,
            calls: latest.modelCalls.map(value => ({ status: value.status, reason: value.reason, outcome: value.outcome })),
            attempts: latest.attempts.map(value => ({ toolId: value.toolId, status: value.status, error: value.error })) }));
      }
    }
    throw new Error('a2a_entry_step_limit');
  }
  async function memory(role: A2aEntryRole) {
    const profile = current(role), knowledge = await profile.personalKnowledge(profile.actor);
    return (await knowledge.search({ namespace: 'personal', scope: 'personal', text: '', kinds: ['personal'], limit: 50 })).cards;
  }
  return { base, profiles, current, handler, observed, controls, callerId, acceptSender, through, memory,
    raw(role: A2aEntryRole) { const value = raw.get(role); assert.ok(value); return value; },
    async reopen() { await close(); await open(); } };
}
