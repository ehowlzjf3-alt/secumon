import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentTurnInput } from '../application/agent-turn-types.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import type { Tool } from '../application/ports.js';
import type { AgentTurnResult } from '../domain/agent-turn.js';
import type { Evidence, Policy } from '../domain/model.js';
import { StructuredAgentTurnAdapter } from '../infrastructure/structured-agent-turn.js';
import type { AgentExecutionHost, HostToolContext } from '../presentation/host-tools.js';

export const HOST_ENTRY_PROFILE = 'host-entry-v1';
export const HOST_ENTRY_TOOL = 'company.document.read';
export const HOST_ENTRY_TEXT = '이 담당에게 연결한 원본 문서의 내용을 확인해 알려 줘.';
export interface HostEntryOptions { text: string; callsFile?: string; identityRegistryDirectory?: string;
  allowRead?: boolean; principalId?: string; labels?: string[]; toolCalls?: number }
export function hostEntryFixture(options: HostEntryOptions) {
  const identityRegistryDirectory = options.identityRegistryDirectory ?? (options.callsFile ? join(dirname(options.callsFile), 'registry') : undefined);
  if (!identityRegistryDirectory) throw new Error('host_entry_fixture_registry_required');
  const observed = { modelInputs: [] as AgentTurnInput[], toolContexts: [] as HostToolContext[], reads: 0, toolCloses: 0, modelCloses: 0 };
  const identity = { provider: 'local-fixture', model: 'host-entry', revision: '1' };
  const host: AgentExecutionHost = {
    identityRegistryDirectory,
    models: new Map([[HOST_ENTRY_PROFILE, { execution: 'deterministic_fixture', async open(profile) {
      const planner = new StructuredAgentTurnAdapter({ identity, profile, destination: 'local', maxRequestBytes: 65536,
        capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000, maxOutputTokens: 2048 } }, {
        async invoke(request) {
          const input = request.input, packet = input.packet; observed.modelInputs.push(structuredClone(input));
          const evidence = packet.evidence.find(value => value.sourceId === 'host-source');
          const result: AgentTurnResult = evidence ? { kind: 'answer', text: String(evidence.facts.summary), evidenceIds: [evidence.id],
            assessment: { type: 'model_self_review', verdict: 'satisfied', rationale: '명시된 시험 원본의 내용을 그대로 확인했다.', missing: [], counterarguments: [] } } :
            { kind: 'plan', proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision,
              basePlanRevision: packet.plan?.revision ?? 0, reason: '연결된 원본 한 건을 읽는다.', hypotheses: [], tasks: [{
                id: 'read-host-source', description: '담당별 호스트 원본 조회', toolId: HOST_ENTRY_TOOL, toolVersion: '1', effect: 'read',
                input: { document: 'current' }, dependsOn: [], maxAttempts: 1, satisfies: [],
              }] } };
          return { provider: identity.provider, model: identity.model, finish: 'stop', content: JSON.stringify(result), usage: { inputTokens: 200, outputTokens: 50 } };
        },
      });
      return { planner, inputLimits: { maxInputBytes: 65536, maxOutputTokens: 2048 }, async close() { observed.modelCloses++; } };
    } }]]),
    tools: { async open(context) {
      observed.toolContexts.push(structuredClone(context));
      const policy: Policy = { tenantId: 'company', principalId: options.principalId ?? 'operator', allowWrites: false,
        allowedTools: [...(options.allowRead === false ? [] : [HOST_ENTRY_TOOL]), ...RESOURCE_TOOL_IDS],
        allowedLabels: options.labels ?? ['internal', 'public'], allowedDestinations: ['local'] };
      const tool: Tool = { definition: { provider: 'company', id: HOST_ENTRY_TOOL, version: '1', description: '담당의 현재 원본 문서를 읽는다.',
        effect: 'read', destination: 'local', labels: ['internal'],
        inputSchema: { type: 'object', properties: { document: { const: 'current' } }, required: ['document'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } },
      async execute(_task, invocation) {
        if (!invocation.authorize) throw new Error('host_entry_authorize_missing');
        await invocation.authorize(); observed.reads++;
        if (options.callsFile) appendFileSync(options.callsFile, `${context.agentId}\n`, { mode: 0o600 });
        const now = Date.now();
        const evidence: Evidence = { id: `host-doc-${context.agentId}`, tenantId: policy.tenantId, scope: context.scope,
          sourceId: 'host-source', lineageId: `host-lineage-${context.agentId}`, locator: `host-source:${context.agentId}:current`,
          observedAt: now, recordedAt: now, labels: ['internal'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [],
          facts: { summary: options.text }, artifact: null };
        return { resultId: `${invocation.attemptId}:result`, attemptId: invocation.attemptId, status: 'success', effectState: 'none',
          evidence: [evidence], artifacts: [], output: { summary: options.text }, error: null, cursor: null, coverage: 'complete' };
      } };
      return { tools: [tool], policy, limits: { toolCalls: options.toolCalls ?? 8, modelCalls: 8, tokens: 1000000, replans: 4, wallTimeMs: 600000 },
        async close() { observed.toolCloses++; } };
    } },
  };
  return { host, observed };
}
