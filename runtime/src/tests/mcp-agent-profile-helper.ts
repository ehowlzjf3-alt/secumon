import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentTurnInput } from '../application/agent-turn-types.js';
import type { ModelCallOptions } from '../application/ports.js';
import type { ProviderToolSource } from '../application/provider-tool-snapshot.js';
import type { AgentTurnResult } from '../domain/agent-turn.js';
import type { Limits, Policy } from '../domain/model.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import type { McpReadBinding } from '../infrastructure/mcp-read-tools.js';
import { StructuredAgentTurnAdapter } from '../infrastructure/structured-agent-turn.js';
import type { AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import type { AgentExecutionHost, HostToolAssembly, HostToolContext } from '../presentation/host-tools.js';
import { createMcpHostTools } from '../presentation/mcp-host-tools.js';
import { MCP_FIXTURE_DOCUMENTS_TOOL, type McpFixtureAudit, type McpFixtureMode } from './helpers/mcp-fixture-contracts.js';

const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
export const MCP_AGENT_PROFILE = 'mcp-agent-fixture-v1';
export const MCP_AGENT_TOOL = 'company.mcp.document.read';
export const MCP_AGENT_TEXT = '[합성 MCP] company.mcp.document.read로 good 자료를 읽고 값을 알려 줘.';
export const MCP_AGENT_PROVIDER = 'company';
export const mcpFixtureAnswer = (value: number) => `[합성 MCP 결과] 원자료 값은 ${value}입니다.`;
export interface McpFixtureHostOptions {
  auditFile: string; documentValue?: number; mode?: McpFixtureMode; projectorVersion?: string; endpointId?: string;
  sourceError?: Error; closeError?: Error;
}
export function initializeMcpAgent(directory: string, backend: 'sqlite' | 'file-journal' = 'sqlite') {
  const ready = new FileAgentProfileStore(runtimeRoot).initialize(directory, { purpose: '로컬 MCP 원문을 검증하는 합성 범용 담당' });
  writeFileSync(join(ready.root, 'config.json'), JSON.stringify({ ...ready.config, storage: { ...ready.config.storage, state: backend },
    model: { profile: MCP_AGENT_PROFILE }, skills: { mode: 'off' } }), { mode: 0o600 });
  return ready;
}
export function readMcpAudit(path: string): (McpFixtureAudit & { pid?: number })[] {
  try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as McpFixtureAudit & { pid?: number }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export function assertMcpPeersStopped(path: string) {
  const rows = readMcpAudit(path), starts = rows.filter(row => row.event === 'start');
  assert.ok(starts.length > 0, 'the fixture process must actually have started');
  for (const row of starts) {
    assert.ok(Number.isSafeInteger(row.pid) && row.pid! > 0);
    assert.ok(rows.some(value => value.event === 'close' && value.pid === row.pid), 'the peer must acknowledge shutdown');
    assert.throws(() => process.kill(row.pid!, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
  }
}

/** A host-only deterministic transport; it understands this exact fixture request, not arbitrary user language. */
export function createMcpFixtureHost(options: McpFixtureHostOptions) {
  const observed = { modelInputs: [] as AgentTurnInput[], modelOptions: [] as ModelCallOptions[],
    contexts: [] as HostToolContext[], assemblies: [] as HostToolAssembly[], modelCloses: 0, toolCloses: 0, sourceLists: 0 };
  const identity = { provider: 'local-fixture', model: 'mcp-agent-turn', revision: '1' };
  const policy: Policy = { tenantId: 'mcp-company', principalId: 'reader', allowWrites: false,
    allowedTools: [MCP_AGENT_TOOL], allowedLabels: ['synthetic', 'public'], allowedDestinations: ['local'] };
  const limits: Limits = { toolCalls: 8, modelCalls: 8, tokens: 1_000_000, replans: 4, wallTimeMs: 600_000 };
  const remote = structuredClone(MCP_FIXTURE_DOCUMENTS_TOOL);
  const binding: McpReadBinding = { definition: { provider: MCP_AGENT_PROVIDER, id: MCP_AGENT_TOOL, version: '1',
    description: 'Read the host-selected good MCP document and its value.', effect: 'read', destination: 'local', labels: ['synthetic'],
    inputSchema: remote.inputSchema, outputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false } },
    remote, projectorId: 'mcp-agent-value', projectorVersion: options.projectorVersion ?? '1',
    project(value, task) {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      assert.equal(value.id, task.input['id']); assert.equal(value.source, 'doc-origin'); assert.equal(value.observedAt, 900);
      assert.equal(typeof value.value, 'number');
      const coverage = value.complete === true ? 'complete' as const : 'partial' as const;
      return { output: { value: value.value! }, coverage, observations: [{ sourceId: 'doc-origin', lineageId: 'doc-origin',
        locator: '/value/structuredContent', observedAt: 900, coverage, facts: { value: value.value as number } }] };
    },
  };
  const registration = createMcpHostTools({ config: { endpointId: options.endpointId ?? 'mcp-agent-local', command: process.execPath,
    args: [fileURLToPath(new URL('./helpers/mcp-fixture-server.js', import.meta.url)), '--audit-file', options.auditFile, '--audit-process',
      '--document-value', String(options.documentValue ?? 30), '--mode', options.mode ?? 'normal'],
    cwd: runtimeRoot, env: { TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir() }, timeoutMs: 5000 }, bindings: [binding], policy, limits });
  const host: AgentExecutionHost = {
    models: new Map([[MCP_AGENT_PROFILE, { execution: 'deterministic_fixture', async open(profile) {
      const planner = new StructuredAgentTurnAdapter({ identity, profile, destination: 'local', maxRequestBytes: 65536,
        capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000, maxOutputTokens: 2048 } }, {
        async invoke(request) {
          const input = request.input, packet = input.packet, session = packet.session;
          observed.modelInputs.push(structuredClone(input)); observed.modelOptions.push(structuredClone(request.options));
          const applied = session?.entries.find(entry => entry.role === 'user' && entry.workId === packet.workId &&
            entry.sourceId === session.basis.input.messageId && entry.sequence === session.basis.input.sequence);
          if (applied?.text !== MCP_AGENT_TEXT) return { provider: identity.provider, model: identity.model,
            finish: 'refused', content: null, usage: { inputTokens: 200, outputTokens: 0 } };
          const evidence = packet.evidence.find(value => value.sourceId === 'doc-origin' && value.coverage === 'complete' &&
            value.status === 'accepted' && value.scope === packet.goal.scope && typeof value.facts.value === 'number');
          const selected = request.options.tools.find(tool => tool.id === MCP_AGENT_TOOL && tool.provider === MCP_AGENT_PROVIDER && tool.effect === 'read');
          const result: AgentTurnResult = evidence ? { kind: 'answer', text: mcpFixtureAnswer(evidence.facts.value as number), evidenceIds: [evidence.id],
            assessment: { type: 'model_self_review', verdict: 'satisfied', rationale: '현재 입력의 MCP 근거 값을 그대로 출력하는 합성 규칙이다.', missing: [], counterarguments: [] } } :
            selected ? { kind: 'plan', proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision,
              basePlanRevision: packet.plan?.revision ?? 0, reason: '명시된 로컬 MCP 자료 한 건을 읽는다.', hypotheses: [], tasks: [{
                id: 'read-mcp-source', description: 'MCP good 원자료 조회', toolId: selected.id, toolVersion: selected.version, effect: 'read',
                input: { id: 'good' }, dependsOn: [], maxAttempts: 1, satisfies: [],
              }] } } : { kind: 'question', question: '이 합성 요청에 필요한 MCP 읽기 계약이 없습니다.' };
          return { provider: identity.provider, model: identity.model, finish: 'stop', content: JSON.stringify(result), usage: { inputTokens: 200, outputTokens: 50 } };
        },
      });
      return { planner, inputLimits: { maxInputBytes: 65536, maxOutputTokens: 2048 }, async close() { observed.modelCloses++; } };
    } }]]),
    tools: { async open(context, assembly) {
      assert.ok(assembly, 'the general profile must pass its existing C01 custody ports');
      observed.contexts.push(context); observed.assemblies.push(assembly);
      const opened = await registration.open(context, assembly);
      return { ...opened, providerSources: opened.providerSources!.map(source => ({ ...source, source: { async list(input: Parameters<ProviderToolSource['list']>[0]) {
        observed.sourceLists++; const page = await source.source.list(input);
        if (options.sourceError) throw options.sourceError;
        return page;
      } } })), async close() { observed.toolCloses++; await opened.close(); if (options.closeError) throw options.closeError; } };
    } },
  };
  return { host, observed };
}

export async function acceptMcpRequest(profile: AgentTurnProfile, messageId = 'read-mcp', sessionId?: string) {
  const session = sessionId ? { scope: { sessionId } } : await profile.sessions.open(profile.actor, { channel: 'test', conversationId: 'mcp-host' });
  return profile.turns.accept(profile.actor, { sessionId: session.scope.sessionId, messageId, rawText: MCP_AGENT_TEXT, mode: 'auto',
    binding: { ...profile.executionActor, channel: 'test', conversationId: 'mcp-host', recipientId: profile.actor.principalId, destination: 'local' },
    scope: profile.scope, policy: profile.policy, limits: profile.limits });
}
