import type { TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Evidence, Limits, Policy, ToolResult } from '../domain/model.js';
import type { AgentTurnInput, AgentTurnProfile as PromptProfile } from '../application/agent-turn-types.js';
import type { ModelCallOptions, Tool } from '../application/ports.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { FixtureReadTool } from '../infrastructure/fakes.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { createLocalContractHost, LOCAL_CONTRACT_MODEL_PROFILE } from '../presentation/local-contract-model.js';
import type { AgentExecutionHost, HostToolContext } from '../presentation/host-tools.js';

const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
export const hostPolicy: Policy = { tenantId: 'host-test', principalId: 'reader', allowedTools: ['fixture.read'],
  allowedLabels: ['synthetic'], allowedDestinations: ['local'], allowWrites: false };
export const hostLimits: Limits = { toolCalls: 8, modelCalls: 12, tokens: 1_000_000, replans: 4, wallTimeMs: 600_000 };

export function hostToolFixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'host-tool-profile-')));
  const hostOptions = { identityRegistryDirectory: join(base, 'registry') };
  const profiles = new FileAgentProfileStore(runtimeRoot);
  const active = new Set<AgentTurnProfile>();
  t.after(async () => {
    const errors: unknown[] = [];
    try { for (const profile of active) { try { await profile.close(); } catch (error) { errors.push(error); } } }
    finally { rmSync(base, { recursive: true, force: true }); }
    if (errors.length) throw new AggregateError(errors, 'host_tool_fixture_cleanup_failed');
  });
  function create(name: string, backend: 'sqlite' | 'file-journal' = 'sqlite', skills: 'off' | 'on-demand' = 'off') {
    const ready = profiles.initialize(join(base, name), { purpose: '호스트 도구 연결을 검사하는 범용 담당' });
    writeFileSync(join(ready.root, 'config.json'), JSON.stringify({ ...ready.config, model: { profile: LOCAL_CONTRACT_MODEL_PROFILE },
      storage: { ...ready.config.storage, state: backend }, skills: { mode: skills } }), { mode: 0o600 });
    return ready;
  }
  return { base, profiles, create, hostOptions,
    async open(directory: string, host: AgentExecutionHost) {
      const profile = await openAgentTurnProfile(directory, { provider: 'registered' }, { ...host, ...hostOptions }); active.add(profile); return profile;
    },
    async close(profile: AgentTurnProfile) { try { await profile.close(); } finally { active.delete(profile); } },
    untrack(profile: AgentTurnProfile) { active.delete(profile); },
  };
}

export function toolHost() {
  const controls = {
    policy: structuredClone(hostPolicy), limits: structuredClone(hostLimits), empty: false, foreignScope: false,
    toolOpenError: null as Error | null, toolCloseError: null as Error | null,
    modelOpenError: null as Error | null, modelCloseError: null as Error | null,
  };
  const days = new Map<string, number>();
  const toolOpens: HostToolContext[] = [], toolCloses: string[] = [], modelOpens: PromptProfile[] = [], modelCloses: string[] = [];
  const toolCalls: { agentId: string; workId: string; attemptId: string; sourceText: string }[] = [];
  const returnedResults: ToolResult[] = [];
  const modelCalls: { agentId: string; input: AgentTurnInput; options: ModelCallOptions }[] = [];
  const rawPolicies: Policy[] = [];
  const model = createLocalContractHost().models.get(LOCAL_CONTRACT_MODEL_PROFILE)!;
  const host: AgentExecutionHost = {
    models: new Map([[LOCAL_CONTRACT_MODEL_PROFILE, { execution: model.execution, async open(profile) {
      modelOpens.push(structuredClone(profile));
      if (controls.modelOpenError) throw controls.modelOpenError;
      const opened = await model.open(profile), source = opened.planner, closeError = controls.modelCloseError;
      return { ...opened, planner: {
        identity: source.identity, destination: source.destination, capabilities: source.capabilities,
        prompt: source.prompt, inputEstimation: source.inputEstimation,
        propose: source.propose.bind(source), estimateTurnInput: source.estimateTurnInput.bind(source),
        estimateContextPreview: source.estimateContextPreview.bind(source),
        ...(source.compact && source.estimateCompactInput ? { compact: source.compact.bind(source), estimateCompactInput: source.estimateCompactInput.bind(source) } : {}),
        async turn(input, signal, options) {
          modelCalls.push({ agentId: profile.agentId, input: structuredClone(input), options: structuredClone(options) });
          return source.turn(input, signal, options);
        },
      }, async close() { modelCloses.push(profile.agentId); await opened.close(); if (closeError) throw closeError; } };
    } }]]),
    tools: { async open(context) {
      toolOpens.push(structuredClone(context));
      if (controls.toolOpenError) throw controls.toolOpenError;
      const policy = structuredClone(controls.policy), limits = structuredClone(controls.limits), closeError = controls.toolCloseError;
      rawPolicies.push(policy);
      const period = days.get(context.agentId) ?? 45;
      const sourceText = `담당 ${context.agentId}의 고정 원문: 보존기간 ${period}일.`;
      const evidence: Evidence = { id: 'doc-current', tenantId: policy.tenantId, scope: controls.foreignScope ? 'foreign-agent-scope' : context.scope,
        sourceId: `source:${context.agentId}`, lineageId: `lineage:${context.agentId}`, locator: `fixture://host/${context.agentId}`,
        observedAt: 1788566400000, recordedAt: 1788566400000, labels: ['synthetic'], coverage: 'complete', status: 'accepted',
        supersedes: [], derivedFrom: [], facts: { 'retention.days': period }, artifact: null };
      const fixture = new FixtureReadTool([evidence]); let closed = false;
      const tool: Tool = { definition: fixture.definition, async execute(task, execution) {
        if (closed) throw new Error('host_tool_lease_closed');
        toolCalls.push({ agentId: context.agentId, workId: execution.workId, attemptId: execution.attemptId, sourceText });
        const result = await fixture.execute(task, execution);
        const returned = result.status === 'success' ? { ...result, output: { sourceText, evidenceIds: result.evidence.map(item => item.id) } } : result;
        returnedResults.push(structuredClone(returned));
        return returned;
      } };
      return { tools: controls.empty ? [] : [tool], policy, limits, async close() {
        closed = true; toolCloses.push(context.agentId); if (closeError) throw closeError;
      } };
    } },
  };
  return { host, controls, days, toolOpens, toolCloses, modelOpens, modelCloses, toolCalls, returnedResults, modelCalls, rawPolicies };
}

export async function acceptHostRequest(profile: AgentTurnProfile, messageId: string, rawText: string, sessionId?: string) {
  const session = sessionId ? { scope: { sessionId } } : await profile.sessions.open(profile.actor, { channel: 'test', conversationId: 'host-tools' });
  return profile.turns.accept(profile.actor, { sessionId: session.scope.sessionId, messageId, rawText, mode: 'auto',
    binding: { ...profile.executionActor, channel: 'test', conversationId: 'host-tools', recipientId: profile.actor.principalId, destination: 'local' },
    scope: profile.scope, policy: profile.policy, limits: profile.limits });
}

export function errorLeaves(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(errorLeaves) : [error];
}
