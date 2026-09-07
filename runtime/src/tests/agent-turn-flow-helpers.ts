import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import type { AgentTurnInput, AgentTurnReply } from '../application/agent-turn-types.js';

export async function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-turn-flow-')));
  const hostOptions = { models: new Map(), identityRegistryDirectory: join(base, 'registry') };
  const profile = await openAgentTurnProfile(join(base, 'agent'), { provider: 'synthetic' }, hostOptions);
  const session = await profile.sessions.open(profile.actor, { channel: 'test', conversationId: 'main' });
  async function accept(text: string, messageId = 'request', mode: 'auto' | 'fast' | 'deep' = 'auto') {
    return profile.turns.accept(profile.actor, { sessionId: session.scope.sessionId, messageId, rawText: text, mode,
      binding: { ...profile.executionActor, channel: 'test', conversationId: 'main', recipientId: profile.actor.principalId, destination: 'local' },
      scope: profile.scope, policy: profile.policy, limits: profile.limits });
  }
  return { profile, session, accept, base, hostOptions, close: async () => { await profile.close(); rmSync(base, { recursive: true, force: true }); } };
}
export function replaceTurn(profile: AgentTurnProfile, turn: (input: AgentTurnInput) => Promise<AgentTurnReply>) {
  const planner = profile.planning!.services.planner;
  profile.planning!.services.planner = { identity: planner.identity!, destination: planner.destination, capabilities: planner.capabilities,
    prompt: planner.prompt!, propose: planner.propose.bind(planner), estimateTurnInput: planner.estimateTurnInput!.bind(planner), turn };
}
export function answer(_input: AgentTurnInput, text: string, needsWork = false): AgentTurnReply {
  return { status: 'ok', result: { kind: 'answer', text, evidenceIds: [], assessment: { type: 'model_self_review',
    verdict: needsWork ? 'needs_work' : 'satisfied', rationale: 'deterministic lifecycle test', missing: needsWork ? ['revise the response'] : [],
    counterarguments: ['considered alternative wording'] } }, inputTokens: 7, outputTokens: 3, provider: 'synthetic', model: 'local-agent-turn-rules' };
}

