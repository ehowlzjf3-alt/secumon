import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { validateScenario } from '../application/fixtures.js';
import { FixtureReadTool, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import type { AcceptRequest } from '../application/conversation-service.js';

export const actor = { tenantId: 'synthetic', principalId: 'learner' };
export const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-simple.json', import.meta.url), 'utf8')));
export function request(messageId: string): AcceptRequest {
  return { messageId, binding: { ...actor, channel: 'test', conversationId: 'conversation', recipientId: actor.principalId, destination: 'local' },
    goal: scenario.goal, policy: scenario.policy, limits: { toolCalls: 20, modelCalls: 5, tokens: 1000000, replans: 5, wallTimeMs: 600000 }, completionRequiresDelivery: true };
}
export function initialize(base: string, backend: 'sqlite' | 'file-journal' = 'sqlite', name = 'agent', personalMemory?: 'sqlite' | 'documents') {
  const profiles = new FileAgentProfileStore(join(base, 'engine'));
  const profile = profiles.initialize(join(base, name), personalMemory === undefined ? {} : { personalMemory });
  if (profile.status !== 'ready') throw new Error('fixture_profile_not_ready');
  if (backend === 'file-journal') writeFileSync(join(profile.root, 'config.json'), JSON.stringify({ ...profile.config, storage: { ...profile.config.storage, state: backend } }));
  return profile.root;
}
export async function open(base: string, name = 'agent') {
  const stores = await openAgentStores(new FileAgentProfileStore(join(base, 'engine')), join(base, name), undefined, { identityRegistryDirectory: join(base, 'registry') });
  const tool = new FixtureReadTool(scenario.evidence);
  const composed = await composeRuntime({ services: { state: stores.state, artifacts: stores.artifacts, sink: stores.channel, tools: [tool],
    planner: new ScriptedPlanner([]), ids: new RandomIds(), digester: new Sha256Digester(), clock: { now: () => Date.now() } },
    session: { repository: stores.sessions, agentId: stores.profile.identity.agentId },
    schemas: new AjvSchemas(), guidanceSource: { list: async () => [], read: async () => { throw new Error('no_guidance'); } }, owner: 'session-test', enablePlanning: false });
  return { ...composed, stores, tool, close: stores.close };
}
export async function finish(f: Awaited<ReturnType<typeof open>>, workId: string) {
  const state = await f.runtime.state(workId);
  await f.runtime.submitPlan(workId, 'fixture-plan', { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision, basePlanRevision: 0,
    reason: 'explicit synthetic read', hypotheses: [], tasks: [{ id: 'read', description: 'read synthetic documents', toolId: 'fixture.read', toolVersion: '1',
      input: { evidenceIds: ['doc-current'] }, dependsOn: [], effect: 'read', maxAttempts: 2, satisfies: state.goal.criteria.map(c => c.id) }] });
  await f.workflow.run(workId, actor);
}
