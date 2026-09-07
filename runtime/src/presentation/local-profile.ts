import { mkdir, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactStore, StateRepository, Tool, Planner, MessageSink } from '../application/ports.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { authorizedWork } from '../application/work-resources.js';
import { validateScenario } from '../application/fixtures.js';
import { FixtureReadTool, ScriptedPlanner } from '../infrastructure/fakes.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FileGuidanceSource } from '../infrastructure/file-guidance.js';
import { LocalChannel } from '../infrastructure/local-channel.js';
import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';
import { FileJournalStateRepository } from '../infrastructure/file-journal-state.js';
import { resolveStateBackend } from '../infrastructure/local-state-profile.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { SqliteKnowledgeRepository } from '../infrastructure/sqlite-knowledge.js';
import { FileWorkspaceStore } from '../infrastructure/file-workspaces.js';
import type { TrustedKnowledgeActor } from '../domain/knowledge.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import type { Policy } from '../domain/model.js';
import type { SessionRepository } from '../application/session-ports.js';
import type { SessionCompactLimits } from '../domain/session-compact.js';
import { SyntheticSessionCompactPlanner } from './synthetic-session-compact.js';
import type { WorkActor } from '../application/work-resources.js';
import type { KnowledgeRepository } from '../application/knowledge-ports.js';
import type { MemoryDraftRepository } from '../application/personal-memory-draft-contracts.js';
import { FilePersonalMemoryDrafts } from '../infrastructure/personal-memory-drafts.js';

export interface LocalCompactOptions { compactProvider?: 'synthetic'; compactLimits?: Partial<SessionCompactLimits> }
export function localCompactProvider(value: string | undefined): 'synthetic' | undefined {
  if (value !== undefined && value !== 'synthetic') throw new Error('invalid_compact_provider');
  return value;
}

export const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
export async function openLocalProfile(directory: string, requestedBackend?: string) {
  const folder = resolve(directory); await mkdir(folder, { recursive: true, mode: 0o700 });
  const stateBackend = resolveStateBackend(folder, requestedBackend);
  const state = stateBackend === 'sqlite' ? new SqliteStateRepository(join(folder, 'state.sqlite')) : new FileJournalStateRepository(join(folder, 'state-journal'));
  let openedSink: LocalChannel | undefined;
  let openedKnowledge: SqliteKnowledgeRepository | undefined; let openedWorkspace: FileWorkspaceStore | undefined; let closed = false;
  async function close() {
    if (closed) return; closed = true;
    const errors: unknown[] = [];
    for (const release of [() => openedWorkspace?.close(), () => openedKnowledge?.close(), () => openedSink?.close(), () => state.close()]) {
      try { await release(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw errors[0];
  }
  try {
    const sink = new LocalChannel(join(folder, 'channel.sqlite')); openedSink = sink;
    const repository = new SqliteKnowledgeRepository(join(folder, 'knowledge.sqlite')); openedKnowledge = repository;
    const workspaceFiles = new FileWorkspaceStore(join(folder, 'workspaces')); openedWorkspace = workspaceFiles;
    const composed = await composeLocalProfile({ state, sink, artifacts: new FileArtifactStore(join(folder, 'artifacts')), repository, workspaceFiles });
    return { ...composed, stateBackend, close };
  } catch (error) { await close().catch(() => {}); throw error; }
}

/** Uses the C01-owned stores; the legacy demo layout is never opened inside an agent directory. */
export async function openAgentLocalProfile(directory: string, options: LocalCompactOptions = {}, postgres?: import('../infrastructure/agent-postgres-storage.js').AgentPostgresHost,
  hostOptions?: import('../infrastructure/agent-stores.js').AgentStoreHostOptions) {
  const profiles = new FileAgentProfileStore(runtimeRoot);
  const ready = profiles.initialize(directory);
  const stores = await openAgentStores(profiles, ready.root, postgres, hostOptions);
  try {
    const personal = stores.profile.effectivePersonalMemory.backend === 'documents' ? stores.profile.effectivePersonalMemory : null;
    const memoryDrafts = personal ? { storeId: personal.storeId, store: new FilePersonalMemoryDrafts({ root: stores.profile.root,
      runtimeRoot, agentId: stores.profile.identity.agentId, storeId: personal.storeId, memoryDirectory: join(stores.profile.root, 'memory') }) } : null;
    const composed = await composeLocalProfile({ state: stores.state, sink: stores.channel, artifacts: stores.artifacts,
      repository: stores.knowledge, workspaceFiles: stores.workspace, agentId: stores.profile.identity.agentId, sessions: stores.sessions, memoryDrafts,
      personalMemoryBackend: stores.profile.effectivePersonalMemory.backend, ...options });
    stores.assertIdentityCurrent();
    return { ...composed, stateBackend: stores.profile.config.storage.state, close: stores.close };
  } catch (error) { await stores.close().catch(() => {}); throw error; }
}

async function composeLocalProfile(input: { state: StateRepository; sink: import('../infrastructure/agent-channel.js').AgentChannel; artifacts: ArtifactStore;
  repository: KnowledgeRepository; workspaceFiles: FileWorkspaceStore; agentId?: string; sessions?: SessionRepository;
  memoryDrafts?: { store: MemoryDraftRepository; storeId: string } | null; personalMemoryBackend?: 'sqlite' | 'documents' | 'postgres' } & LocalCompactOptions) {
    const { state, sink, repository, workspaceFiles } = input;
    const fixtures = join(runtimeRoot, 'fixtures');
    const scenarios = await Promise.all((await readdir(fixtures)).filter(f => f.endsWith('.json')).sort().map(async f => validateScenario(JSON.parse(await readFile(join(fixtures, f), 'utf8')))));
    const readers = new Map(scenarios.map(s => [s.goal.scope, new FixtureReadTool(s.evidence)]));
    const source: Tool = { definition: new FixtureReadTool([]).definition, async execute(task, context) {
      const work = await authorizedWork(state, context.workId, context.policy); const reader = readers.get(work.goal.scope);
      if (!reader) throw new Error('synthetic_scope_unavailable'); return reader.execute(task, context);
    } };
    const ids = new RandomIds();
    const planner: Planner = input.compactProvider === 'synthetic' ? new SyntheticSessionCompactPlanner([]) : new ScriptedPlanner([]);
    const services = { state, sink, artifacts: input.artifacts, clock: { now: () => Date.now() }, ids,
      digester: new Sha256Digester(), planner, tools: [source] };
    const actor: TrustedKnowledgeActor = { tenantId: 'synthetic', principalId: 'learner',
      ...(input.agentId ? { agentId: input.agentId, allowedDestinations: [...new Set(scenarios.flatMap(s => s.policy.allowedDestinations))].sort() } : {}),
      allowedNamespaces: input.agentId ? ['local', 'personal'] : ['local'],
      allowedScopes: [...new Set(scenarios.map(s => s.goal.scope))].sort(),
      allowedLabels: [...new Set(scenarios.flatMap(s => s.policy.allowedLabels))].sort(), canReview: false, canPublish: false };
    const composed = await composeRuntime({ services, schemas: new AjvSchemas(), guidanceSource: new FileGuidanceSource(join(runtimeRoot, 'guidance')), owner: ids.next('cli-worker'), enablePlanning: false,
      knowledge: { repository, actors: { current: async () => structuredClone(actor) } }, workspaceFiles,
      ...(input.agentId === undefined ? {} : { session: { repository: input.sessions!, agentId: input.agentId,
        ...(input.compactLimits ? { compact: input.compactLimits } : {}) } }) });
    const personalKnowledge = async (caller: WorkActor) => {
      if (!input.agentId || !composed.personalKnowledge) throw new Error('personal_memory_unavailable');
      return composed.personalKnowledge(caller);
    };
    return { ...composed, personalKnowledge, services: { ...composed.services, sink }, scenarios, agentId: input.agentId ?? null,
      memoryDrafts: input.memoryDrafts ?? null, personalMemoryBackend: input.personalMemoryBackend ?? null, compactProvider: input.compactProvider ?? null };
}

type OpenedLocalProfile = Awaited<ReturnType<typeof openLocalProfile>>;
export type LocalProfile = Omit<OpenedLocalProfile, 'compactProvider' | 'services'> & {
  services: Omit<OpenedLocalProfile['services'], 'sink'> & { sink: MessageSink & Pick<LocalChannel, 'messages'> };
  compactProvider: 'synthetic' | 'registered' | null;
};

/** Host-selected synthetic disclosure policy for history; request text cannot expand it. */
export function localHistoryPolicy(profile: LocalProfile, actor: { tenantId: string; principalId: string }): Policy {
  const sample = profile.scenarios[0]; if (!sample) throw new Error('synthetic_scenario_unknown');
  return { ...structuredClone(sample.policy), ...actor, allowedLabels: [...new Set(profile.scenarios.flatMap(scenario => scenario.policy.allowedLabels))].sort() };
}
