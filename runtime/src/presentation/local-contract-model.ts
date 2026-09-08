import type { AgentTurnInput, AgentTurnProfile, AgentTurnReply } from '../application/agent-turn-types.js';
import type { ModelCallOptions, ModelIdentity, SessionCompactReply } from '../application/ports.js';
import type { AgentTurnResult } from '../domain/agent-turn.js';
import { frozen } from '../application/resource-contracts.js';
import { StructuredAgentModel } from '../infrastructure/structured-agent-model.js';
import { StructuredAgentTurnAdapter } from '../infrastructure/structured-agent-turn.js';
import { StructuredSessionCompactAdapter } from '../infrastructure/structured-session-compact.js';
import { SyntheticAgentTurnPlanner, SYNTHETIC_AGENT_TURN_REQUESTS } from '../infrastructure/synthetic-agent-turn.js';
import { SyntheticProfilePlanner } from './agent-turn-profile.js';
import type { AgentTurnHost, HostModelRegistration } from './host-models.js';

export const LOCAL_CONTRACT_MODEL_PROFILE = 'local-contract-v1';

function recallRequestedEvidence(input: AgentTurnInput, options: ModelCallOptions): AgentTurnResult | null {
  const packet = input.packet, session = packet.session;
  const applied = session?.entries.find(entry => entry.role === 'user' && entry.workId === packet.workId &&
    entry.sequence === session.basis.input.sequence && entry.sourceId === session.basis.input.messageId && ['work', 'input', 'command'].includes(entry.kind));
  if (applied?.text !== SYNTHETIC_AGENT_TURN_REQUESTS.read || !(packet.contextView && packet.contextView.omitted.evidence > 0) ||
      packet.evidence.some(item => item.id === 'doc-current')) return null;
  const tool = options.tools.find(item => item.id === 'core.evidence.get' && item.provider === 'core' && item.version === '1' && item.effect === 'read');
  if (!tool) return null;
  return { kind: 'plan', proposal: {
    baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
    reason: '명시된 합성 요청의 근거가 문맥에서 제외되어 기존 근거 저장소에서 현재 값을 다시 읽는다.', hypotheses: [], tasks: [{
      id: 'local-contract-evidence-recall', description: '저장된 doc-current의 현재 근거 조회', dependsOn: [], toolId: tool.id, toolVersion: tool.version,
      input: { evidenceId: 'doc-current', detail: 'evidence', maxBytes: 4096 }, effect: 'read', maxAttempts: 1,
      satisfies: packet.goal.criteria.map(criterion => criterion.id),
    }],
  } };
}

/** Convert a deterministic provider reply to the same wire parsed for registered transports. */
function responseWire(reply: AgentTurnReply | SessionCompactReply, identity: ModelIdentity) {
  const usage = { inputTokens: reply.inputTokens, outputTokens: reply.outputTokens };
  if (reply.status === 'ok') return { provider: reply.provider, model: reply.model, finish: 'stop', usage,
    content: JSON.stringify('result' in reply ? reply.result : reply.candidate) };
  return { provider: identity.provider, model: identity.model, usage, content: null,
    finish: reply.status === 'refused' ? 'refused' : reply.status === 'truncated' ? 'length' : 'error' };
}

/** Explicit finite fixture registration. No SDK, network or arbitrary-language model is started. */
export function createLocalContractHost(): AgentTurnHost {
  const registration: HostModelRegistration = Object.freeze({ engineApi: { version: 1, requires: ['model.turn', 'model.compact'] },
    execution: 'deterministic_fixture', async open(profile: AgentTurnProfile) {
    const fixture = new SyntheticProfilePlanner(new SyntheticAgentTurnPlanner(profile));
    const configuration = { identity: { ...fixture.identity, revision: 'registered-1' }, destination: 'local', maxRequestBytes: 65_536,
      capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true,
        maxInputTokens: 100_000, maxOutputTokens: 2048, maxInputBytes: 65_536 } };
    const turn = new StructuredAgentTurnAdapter({ ...configuration, profile }, {
      async invoke(request, signal) {
        const recall = recallRequestedEvidence(request.input, request.options);
        if (recall) return { provider: configuration.identity.provider, model: configuration.identity.model, finish: 'stop',
          content: JSON.stringify(recall), usage: { inputTokens: 0, outputTokens: 0 } };
        return responseWire(await fixture.turn(request.input, signal, request.options), fixture.identity);
      },
    });
    const compact = new StructuredSessionCompactAdapter(configuration, {
      async invoke(request, signal) { return responseWire(await fixture.compact(request.compact, signal, request.options), fixture.identity); },
    });
    return Object.freeze({ planner: new StructuredAgentModel(turn, compact),
      inputLimits: frozen({ maxInputBytes: 65_536, maxOutputTokens: 2048 }), async close() {} });
  } });
  return Object.freeze({ models: new Map([[LOCAL_CONTRACT_MODEL_PROFILE, registration]]) });
}
