import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentTurnInput } from '../application/agent-turn-types.js';
import type { ArchiveContent, ArchiveDescriptor, ArchiveMutation, ArchiveOwner, ArchiveProvider } from '../application/archive-contracts.js';
import { ArchiveService } from '../application/archive-service.js';
import { createArchiveTools } from '../application/archive-tools.js';
import { ToolResultSchema } from '../application/contracts.js';
import type { AgentTurnResult } from '../domain/agent-turn.js';
import type { Json, Policy, TaskSpec } from '../domain/model.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { FileArchiveProvider } from '../infrastructure/file-archive.js';
import { StructuredAgentTurnAdapter } from '../infrastructure/structured-agent-turn.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import type { AgentExecutionHost } from '../presentation/host-tools.js';

export const ARCHIVE_PROFILE = 'archive-acceptance-v1';
export const ARCHIVE_CONTENT: ArchiveContent = { title: 'case archive', body: 'ARCHIVE_ORIGINAL: the prior incident was a failed rollout.',
  path: 'db://fixture/cases/original', sourceVersion: 'source-v1' };
export const ARCHIVE_DESCRIPTOR: ArchiveDescriptor = { id: 'archive', version: '1', destination: 'local', labels: ['public'], access: 'read_register' };
export const ARCHIVE_OWNER: ArchiveOwner = { tenantId: 'company', principalId: 'operator', agentId: 'archive-agent', scope: 'archive-scope' };
export const ARCHIVE_POLICY: Policy = { tenantId: 'company', principalId: 'operator', allowWrites: true,
  allowedTools: ['search', 'get', 'register', 'revise', 'delete'].map(kind => 'archive.' + kind),
  allowedLabels: ['public'], allowedDestinations: ['local'] };
export const freshSignal = () => new AbortController().signal;
export const registration = (id = 'case-1', commandId = 'register-case'): Extract<ArchiveMutation, { kind: 'register' }> =>
  ({ kind: 'register', id, commandId, expectedRevision: 0, content: structuredClone(ARCHIVE_CONTENT) });
export function archiveTask(kind: 'search' | 'get' | 'register' | 'revise' | 'delete', input: Record<string, Json>, id = kind): TaskSpec {
  return { id, description: 'Read or explicitly change archive reference material', toolId: 'archive.' + kind, toolVersion: '1',
    effect: kind === 'search' || kind === 'get' ? 'read' : 'write', input, dependsOn: [], maxAttempts: 1, satisfies: [] };
}

/** The physical source remains writable for fixture setup; the exposed adapter can be read-only. */
export function archiveSource(root: string, owner = ARCHIVE_OWNER, access: ArchiveDescriptor['access'] = 'read_register') {
  const file = new FileArchiveProvider({ root, owner, descriptor: ARCHIVE_DESCRIPTOR });
  const observed = { searches: 0, gets: [] as string[], mutations: [] as ArchiveMutation[], receipts: [] as string[] };
  const controls = { reply: 'normal' as 'normal' | 'lost_after_commit', receipts: 'normal' as 'normal' | 'null' | 'wrong_digest' };
  const provider: ArchiveProvider = { descriptor: { ...ARCHIVE_DESCRIPTOR, access },
    async search(query, signal) { observed.searches++; return file.search(query, signal); },
    async get(id, signal) { observed.gets.push(id); return file.get(id, signal); },
    ...(access === 'read_register' ? { async mutate(command: ArchiveMutation, signal: AbortSignal) {
      observed.mutations.push(structuredClone(command)); const result = await file.mutate(command, signal);
      if (controls.reply === 'lost_after_commit') throw new Error('archive_fixture_response_lost');
      return result;
    } } : {}),
    async receipt(commandId, signal) {
      observed.receipts.push(commandId); const result = await file.receipt(commandId, signal);
      return controls.receipts === 'null' ? null : result && controls.receipts === 'wrong_digest' ? { ...result, commandDigest: '0'.repeat(64) } : result;
    },
  };
  return { file, provider, observed, controls };
}
export function archiveServiceFixture(t: TestContext, options: { access?: ArchiveDescriptor['access']; allowWrites?: boolean } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'archive-service-')));
  const source = archiveSource(base, ARCHIVE_OWNER, options.access);
  const service = new ArchiveService(source.provider, ARCHIVE_OWNER, freshSignal(), new Sha256Digester(), options.allowWrites ?? true);
  t.after(() => { source.file.close(); rmSync(base, { recursive: true, force: true }); });
  const tools = createArchiveTools(service, ARCHIVE_POLICY);
  async function invoke(kind: Parameters<typeof archiveTask>[0], input: Record<string, Json>, attemptId = 'archive-attempt') {
    const task = archiveTask(kind, input), tool = tools.find(item => item.definition.id === task.toolId); assert.ok(tool);
    let authorizations = 0;
    const result = await tool.execute(task, { workId: 'archive-work', attemptId, policy: ARCHIVE_POLICY, signal: freshSignal(),
      authorize: async () => { authorizations++; } });
    assert.ok(authorizations > 0); return result;
  }
  return { base, ...source, service, tools, invoke };
}

function object(value: Json | undefined): Record<string, Json> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function answer(text: string): AgentTurnResult {
  return { kind: 'answer', text, evidenceIds: [], assessment: { type: 'model_self_review', verdict: 'satisfied',
    rationale: 'The explicit archive operation returned reference material or its provider receipt, not independent Evidence.', missing: [], counterarguments: [] } };
}
export function archiveProfileFixture(t: TestContext, options: { backend?: 'sqlite' | 'file-journal'; allowWrites?: boolean; seed?: boolean;
  repeatRead?: 'search' | 'get' } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'archive-entry-'))), directory = join(base, 'agent');
  const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
  const ready = new FileAgentProfileStore(runtimeRoot).initialize(directory, { stateBackend: options.backend ?? 'sqlite' });
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...ready.config, model: { profile: ARCHIVE_PROFILE },
    features: { ...ready.config.features, archive: true }, skills: { ...ready.config.skills, mode: 'off' } }), { mode: 0o600 });
  const opened = new Set<AgentTurnProfile>(), sources: ReturnType<typeof archiveSource>[] = [], inputs: AgentTurnInput[] = [];
  const identity = { provider: 'local-fixture', model: 'archive-acceptance', revision: '1' };
  const host: AgentExecutionHost = { identityRegistryDirectory: join(base, 'registry'),
    models: new Map([[ARCHIVE_PROFILE, { execution: 'deterministic_fixture', async open(profile) {
      const planner = new StructuredAgentTurnAdapter({ identity, profile, destination: 'local', maxRequestBytes: 131072,
        capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000, maxOutputTokens: 2048 } }, {
        async invoke(request) {
          const input = request.input, packet = input.packet; inputs.push(structuredClone(input));
          const observations = packet.toolObservations ?? [];
          const mutationKind = (['register', 'revise', 'delete'] as const).find(kind => packet.goal.description.startsWith(kind + ':'));
          let result: AgentTurnResult;
          const receipt = object(observations.find(item => item.toolId === 'archive.' + mutationKind && item.status === 'success')?.output);
          const original = object(object(observations.find(item => item.toolId === 'archive.get' && item.status === 'success')?.output)?.['document']);
          if (mutationKind && receipt) result = answer(JSON.stringify(receipt));
          else if (!mutationKind && original && !options.repeatRead) result = answer(`Archive reference (${original['sourceVersion']}): ${original['body']}`);
          else {
            let task: TaskSpec;
            if (mutationKind) {
              const content = { ...ARCHIVE_CONTENT, ...(mutationKind === 'revise' ? { body: 'Revised archive reference.', sourceVersion: 'source-v2' } : {}) };
              task = archiveTask(mutationKind, mutationKind === 'delete' ? { id: 'case-created', expectedRevision: 2 } :
                { id: 'case-created', expectedRevision: mutationKind === 'register' ? 0 : 1, content });
            } else {
              const search = object(observations.find(item => item.toolId === 'archive.search' && item.status === 'success')?.output);
              const documents = search?.['documents'], card = Array.isArray(documents) ? object(documents[0]) : undefined;
              task = options.repeatRead !== 'search' && card && typeof card['id'] === 'string' ? archiveTask('get', { id: card['id'], maxBytes: 8192 }) :
                archiveTask('search', { query: 'case', limit: 4, maxBytes: 8192 });
              if (options.repeatRead) task.id = `${task.id}-${inputs.length}`;
            }
            result = { kind: 'plan', proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision,
              basePlanRevision: packet.plan?.revision ?? 0, reason: 'Use the registered archive for the explicit request.', hypotheses: [], tasks: [task] } };
          }
          return { provider: identity.provider, model: identity.model, finish: 'stop', content: JSON.stringify(result), usage: { inputTokens: 200, outputTokens: 60 } };
        },
      });
      return { planner, inputLimits: { maxInputBytes: 131072, maxOutputTokens: 2048 }, async close() {} };
    } }]]),
    tools: { async open() { return { tools: [], policy: { ...ARCHIVE_POLICY, allowedTools: [], allowWrites: false },
      limits: { toolCalls: 8, modelCalls: 8, tokens: 1000000, replans: 4, wallTimeMs: 600000 }, async close() {} }; } },
    archive: { allowWrites: options.allowWrites ?? false, async open(context) {
      const source = archiveSource(context.root, { tenantId: context.actor.tenantId, principalId: context.actor.principalId,
        agentId: context.agentId, scope: context.scope }); sources.push(source);
      if (options.seed !== false && !(await source.file.get('case-1', context.signal))) await source.file.mutate(registration(), context.signal);
      return { provider: source.provider, async close() { source.file.close(); } };
    } },
  };
  t.after(async () => { for (const profile of opened) await profile.close(); rmSync(base, { recursive: true, force: true }); });
  async function open() { const profile = await openAgentTurnProfile(directory, { provider: 'registered' }, host); opened.add(profile); return profile; }
  return { base, directory, host, open, inputs, sources, source: () => { const source = sources.at(-1); assert.ok(source); return source; } };
}
export async function acceptArchive(profile: AgentTurnProfile, messageId: string, rawText = 'Find the case archive and read its original reference.') {
  const session = await profile.sessions.open(profile.actor, { channel: 'test', conversationId: 'archive-chat' });
  const accepted = await profile.turns.accept(profile.actor, { sessionId: session.scope.sessionId, messageId, rawText,
    binding: { ...profile.executionActor, channel: 'test', conversationId: 'archive-chat', recipientId: profile.actor.principalId, destination: 'local' },
    scope: profile.scope, mode: 'auto', policy: profile.policy, limits: profile.limits });
  await profile.outbox.flush(accepted.workId, profile.actor); return { ...accepted, sessionId: session.scope.sessionId };
}
export async function prepareArchive(profile: AgentTurnProfile, workId: string, task: TaskSpec) {
  const state = await profile.runtime.state(workId);
  await profile.runtime.submitPlan(workId, 'archive-plan:' + task.id, { baseStateRevision: state.revision,
    baseGoalRevision: state.goal.revision, basePlanRevision: state.plan?.revision ?? 0,
    reason: 'Explicit archive mutation acceptance fixture', hypotheses: [], tasks: [task] });
  return profile.runtime.reserve(workId, task.id);
}
export async function archiveAttemptResult(profile: AgentTurnProfile, workId: string, attemptId: string) {
  const state = await profile.runtime.state(workId), attempt = state.attempts.find(item => item.id === attemptId); assert.ok(attempt?.resultArtifact);
  const bytes = await profile.services.artifacts.get(attempt.resultArtifact, state.policy);
  return { state, attempt, bytes, result: ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(bytes))) };
}
export async function personalArchiveCards(profile: AgentTurnProfile) {
  const memory = await profile.personalKnowledge(profile.actor);
  // The profile selects the agent/principal owner; personal memory uses the fixed personal place across work scopes.
  const result = await memory.search({ namespace: 'personal', scope: 'personal', text: '', kinds: ['personal'], limit: 50 });
  assert.equal(result.index.status, 'ready'); assert.equal(result.index.complete, true);
  return result.cards;
}
