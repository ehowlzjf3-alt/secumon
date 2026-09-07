import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentTurnService } from '../application/agent-turn-service.js';
import type { ExecutionRuntime } from '../application/execution-runtime.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { createExecutionAuthority } from '../application/execution-authority.js';
import { validateScenario } from '../application/fixtures.js';
import type { GuidanceSource } from '../application/guidance.js';
import { KNOWLEDGE_TOOL_IDS } from '../application/knowledge-tools.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import { frozen } from '../application/resource-contracts.js';
import type { ModelCallOptions, ModelIdentity, Planner, Tool } from '../application/ports.js';
import { refreshProviderTools } from '../application/provider-tool-snapshot.js';
import type { WorkActor } from '../application/work-resources.js';
import type { AgentTurnInput } from '../application/agent-turn-types.js';
import type { Limits, Policy, ContextPacket, WorkState } from '../domain/model.js';
import type { TrustedKnowledgeActor } from '../domain/knowledge.js';
import type { SessionCompactLimits } from '../domain/session-compact.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { captureKnoxRegistration, KnoxChannel } from '../infrastructure/knox-channel.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { FixtureReadTool } from '../infrastructure/fakes.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { FileGuidanceSource } from '../infrastructure/file-guidance.js';
import { FilePersonalMemoryDrafts } from '../infrastructure/personal-memory-drafts.js';
import { SyntheticAgentTurnPlanner, SYNTHETIC_AGENT_TURN_REQUESTS, SYNTHETIC_AGENT_TURN_CORRECTION } from '../infrastructure/synthetic-agent-turn.js';
import { SyntheticSessionCompactPlanner } from './synthetic-session-compact.js';
import { closeAgentTurnResources, openRegisteredHostModel, resolveHostModelRegistration,
  type AgentTurnModelInfo, type OpenedHostModel } from './host-models.js';
import { openRegisteredHostTools, resolveHostToolRegistration, type AgentExecutionHost, type OpenedHostTools } from './host-tools.js';
import { openRegisteredHostBoard, resolveHostBoardRegistration, type OpenedHostBoard } from './host-board.js';
import { openHostArchive, type OpenedHostArchive } from './host-archive.js';
import { BUDGET_TOOL_IDS } from '../application/budget-tools.js';
import { openRegisteredHostPeers, resolveHostPeerRegistration, type OpenedHostPeers } from './host-peers.js';
import { openHostA2a, type OpenedHostA2a } from './host-a2a.js';
import { openHostMissions, type OpenedHostMissions } from './host-missions.js';
import { createHostResidentMissions, type HostResidentMissionDefaults } from './host-resident-missions.js';
import { openA2aRequestHandler, type A2aRequestHost } from './host-a2a-server.js';
import { createHostWorkspaceRecovery } from './host-workspace-recovery.js';

export interface AgentTurnProfileOptions {
  provider?: 'synthetic' | 'registered';
  compactProvider?: 'synthetic';
  compactLimits?: Partial<SessionCompactLimits>;
}
const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));

// One explicit synthetic model identity covers both deterministic purposes; no second SDK or ledger exists.
export class SyntheticProfilePlanner extends SyntheticSessionCompactPlanner {
  override readonly identity: ModelIdentity;
  readonly prompt;
  constructor(private readonly main: SyntheticAgentTurnPlanner) {
    const correction = `[합성 규칙 결과] ${SYNTHETIC_AGENT_TURN_CORRECTION}`;
    const requests = SYNTHETIC_AGENT_TURN_REQUESTS;
    super([], { userTexts: Object.values(requests), rules: [
      ...Object.entries(requests).map(([name, text]) => ({ role: 'user' as const, quote: text, exactText: text,
        text: `합성 주턴 요청 참조: ${name}`, kind: 'reference' as const })),
      { role: 'assistant', quote: correction, exactText: correction, entryKind: 'result',
        text: `합성 교정 결과: ${SYNTHETIC_AGENT_TURN_CORRECTION}`, kind: 'outcome' },
    ] });
    this.identity = main.identity; this.prompt = main.prompt; Object.freeze(this);
  }
  estimateTurnInput(input: AgentTurnInput, options: ModelCallOptions) { return this.main.estimateTurnInput(input, options); }
  turn(input: AgentTurnInput, signal: AbortSignal, options: ModelCallOptions) { return this.main.turn(input, signal, options); }
  override propose(packet: ContextPacket, signal: AbortSignal, options?: ModelCallOptions) { return this.main.propose(packet, signal, options); }
}

function guidanceSource(directory: string, mode: 'off' | 'explicit' | 'on-demand'): GuidanceSource {
  if (mode === 'off') return { list: async () => [], read: async () => { throw new Error('agent_skills_disabled'); } };
  const source = new FileGuidanceSource(directory); let observed = false;
  async function present() {
    try {
      if (!(await lstat(join(directory, 'catalog.json'))).isFile()) throw new Error('guidance_catalog_invalid');
      observed = true; return true;
    } catch (error) {
      if (!observed && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  return {
    list: async () => await present() ? source.list() : [],
    listSnapshot: async input => await present() ? source.listSnapshot(input) :
      { revision: 'agent-skills-empty', manifests: [], nextCursor: null },
    read: (id, version, signal) => source.read(id, version, signal),
    validate: (manifest, signal) => source.validate(manifest, signal),
  };
}

/** C01 stores and host authority for the generic entry; a provider must be explicitly selected. */
export async function openAgentTurnProfile(directory: string, options: AgentTurnProfileOptions = {}, host?: AgentExecutionHost) {
  const selected = structuredClone(options);
  if (selected.provider !== 'synthetic' && selected.provider !== 'registered') throw new Error('agent_turn_provider_unavailable');
  if (selected.compactProvider !== undefined && (selected.provider === 'registered' || selected.compactProvider !== 'synthetic')) throw new Error('invalid_compact_provider');
  const profiles = new FileAgentProfileStore(runtimeRoot); const ready = profiles.initialize(directory);
  const profileName = selected.provider === 'registered' ? ready.config.model?.profile ?? null : null;
  const registration = selected.provider === 'registered' ? resolveHostModelRegistration(host, profileName) : null;
  const toolRegistration = resolveHostToolRegistration(host);
  const knoxRegistration = captureKnoxRegistration(host?.knox);
  const boardRegistration = ready.config.features.board ? resolveHostBoardRegistration(host) : null;
  if (ready.config.features.board && !boardRegistration) throw new Error('agent_board_registration_required');
  const archiveRegistration = ready.config.features.archive ? host?.archive : undefined;
  if (ready.config.features.archive && !archiveRegistration) throw new Error('agent_archive_registration_required');
  const peerRegistration = ready.config.features.peers === true ? resolveHostPeerRegistration(host) : null;
  if (ready.config.features.peers === true && !peerRegistration) throw new Error('agent_peer_registration_required');
  const a2aRegistration = ready.config.features.a2a === true ? host?.a2a : undefined;
  const missionRegistration = ready.config.features.missions === true ? host?.missions : undefined;
  const a2aInbound = ready.config.features.a2a === true && host?.a2aInbound === true;
  if (ready.config.features.a2a === true && !a2aRegistration && !a2aInbound) throw new Error('agent_a2a_registration_required');
  if (ready.config.features.missions === true && !missionRegistration) throw new Error('agent_mission_registration_required');
  const stores = await openAgentStores(profiles, ready.root, host?.postgres,
    host?.identityRegistryDirectory === undefined ? {} : { identityRegistryDirectory: host.identityRegistryDirectory });
  let openedModel: OpenedHostModel | null = null;
  let openedTools: OpenedHostTools | null = null;
  let openedBoard: OpenedHostBoard | null = null;
  let openedArchive: OpenedHostArchive | null = null;
  let openedPeers: OpenedHostPeers | null = null;
  let openedA2a: OpenedHostA2a | null = null;
  let openedMissions: OpenedHostMissions | null = null;
  let workspaceRecovery: ReturnType<typeof createHostWorkspaceRecovery> | null = null;
  const residentDrivers = new Set<ReturnType<typeof createHostResidentMissions>>();
  const a2aHandlers = new Set<Awaited<ReturnType<typeof openA2aRequestHandler>>>();
  let execution: ExecutionRuntime | undefined;
  let settlePlanning: (() => Promise<void>) | undefined;
  const lifetime = new AbortController();
  let closing: Promise<void> | undefined;
  const close = () => {
    lifetime.abort();
    const closeResidents = [...residentDrivers].map(driver => async () => { await driver.close(); });
    residentDrivers.clear();
    const closeA2aHandlers = [...a2aHandlers].map(handler => async () => { await handler.close(); });
    a2aHandlers.clear();
    execution?.beginClose();
    return closing ??= closeAgentTurnResources([...(openedModel ? [openedModel.close] : []), ...(openedTools ? [openedTools.close] : []),
      ...(execution ? [() => execution!.finishClose()] : []), ...(settlePlanning ? [settlePlanning] : []), ...(openedArchive ? [openedArchive.close] : []),
      ...(openedBoard ? [openedBoard.close] : []), ...(openedPeers ? [openedPeers.close] : []),
      ...closeResidents, ...closeA2aHandlers, ...(openedMissions ? [openedMissions.close] : []), ...(openedA2a ? [openedA2a.close] : []),
      ...(workspaceRecovery ? [workspaceRecovery.close] : []), stores.close]);
  };
  try {
    const agentId = stores.profile.identity.agentId; const config = stores.profile.config;
    if (config.features.board !== ready.config.features.board || config.features.archive !== ready.config.features.archive ||
      config.features.peers !== ready.config.features.peers || config.features.missions !== ready.config.features.missions || config.features.a2a !== ready.config.features.a2a)
      throw new Error('agent_feature_registration_changed');
    if (registration && config.model?.profile !== profileName) throw new Error('agent_model_registration_changed');
    const scope = `agent:${agentId}`;
    const ids = new RandomIds(), digester = new Sha256Digester(), schemas = new AjvSchemas();
    const clock = Object.freeze({ now: () => Date.now() });
    if (toolRegistration) openedTools = await openRegisteredHostTools(toolRegistration, { agentId, root: stores.profile.root, scope },
      Object.freeze({ custody: Object.freeze({ state: stores.state, artifacts: stores.artifacts, digester, clock }), schemas, signal: lifetime.signal }));
    const allowedTools = ['fixture.read', ...RESOURCE_TOOL_IDS.filter(id => config.skills.mode !== 'off' || !id.startsWith('core.guidance.')), ...KNOWLEDGE_TOOL_IDS];
    const basePolicy: Policy = openedTools ? { ...structuredClone(openedTools.policy),
      allowedTools: openedTools.policy.allowedTools.filter(id => config.skills.mode !== 'off' || !id.startsWith('core.guidance.')) } :
      { tenantId: 'local', principalId: 'operator', allowedTools, allowedLabels: ['synthetic', 'public'], allowedDestinations: ['local'], allowWrites: false };
    const channelPolicy: Policy = frozen({ ...basePolicy, allowedDestinations: [...new Set([
      ...basePolicy.allowedDestinations, ...(knoxRegistration ? [knoxRegistration.destination] : []),
    ])] });
    if (boardRegistration) openedBoard = await openRegisteredHostBoard(boardRegistration,
      { agentId, root: stores.profile.root, scope, policy: channelPolicy, signal: lifetime.signal });
    if (archiveRegistration) openedArchive = await openHostArchive(archiveRegistration,
      { agentId, root: stores.profile.root, scope, actor: channelPolicy, signal: lifetime.signal });
    if (peerRegistration) openedPeers = await openRegisteredHostPeers(peerRegistration,
      { agentId, root: stores.profile.root, scope, policy: channelPolicy, signal: lifetime.signal });
    if (a2aRegistration) openedA2a = await openHostA2a(a2aRegistration,
      { agentId, root: stores.profile.root, scope, actor: channelPolicy, signal: lifetime.signal });
    const policy: Policy = frozen({ ...channelPolicy,
      allowedTools: [...new Set([...channelPolicy.allowedTools, ...(openedBoard?.allowedTools ?? []), ...(openedArchive?.allowedTools ?? []),
        ...(config.features.peers === true ? BUDGET_TOOL_IDS : []), ...(openedPeers?.allowedTools ?? []),
        ...(openedA2a?.allowedTools ?? []), ...(missionRegistration ? ['mission.events'] : [])])],
      allowWrites: channelPolicy.allowWrites || (openedBoard?.allowWrites ?? false) || (openedArchive?.allowWrites ?? false) || (openedA2a?.allowWrites ?? false) });
    const actor: WorkActor = frozen({ tenantId: policy.tenantId, principalId: policy.principalId,
      allowedTools: [...policy.allowedTools], allowedLabels: [...policy.allowedLabels], allowedDestinations: [...policy.allowedDestinations], allowWrites: policy.allowWrites });
    // Identity-only channel binding; execution entry points pass the full actor above.
    const executionActor = frozen({ tenantId: actor.tenantId, principalId: actor.principalId });
    const knowledgeActor: TrustedKnowledgeActor = frozen({ tenantId: actor.tenantId, principalId: actor.principalId, agentId,
      allowedLabels: [...policy.allowedLabels], allowedDestinations: [...policy.allowedDestinations],
      allowedNamespaces: ['local', 'personal'], allowedScopes: [scope], canReview: false, canPublish: false });
    const limits: Limits = openedTools?.limits ?? frozen({ toolCalls: 30, modelCalls: 16, tokens: 1_000_000, replans: 8, wallTimeMs: 3_600_000 });
    const promptProfile = { agentId, purpose: config.purpose, skillsMode: config.skills.mode };
    let planner: Planner;
    if (registration) {
      openedModel = await openRegisteredHostModel(registration, promptProfile);
      planner = openedModel.planner;
    } else {
      const main = new SyntheticAgentTurnPlanner(promptProfile);
      planner = selected.compactProvider === 'synthetic' ? new SyntheticProfilePlanner(main) : main;
    }
    const modelInfo: AgentTurnModelInfo = frozen({ selection: selected.provider, profileName,
      identity: structuredClone(planner.identity!), compact: typeof planner.compact === 'function',
      execution: registration?.execution ?? 'deterministic_fixture' });
    const compactProvider = modelInfo.compact ? selected.provider : null;
    let tools: Tool[];
    if (openedTools) tools = [...openedTools.tools, ...(openedTools.writeTools ?? [])];
    else {
      const fixture = validateScenario(JSON.parse(await readFile(join(runtimeRoot, 'fixtures', 'documents-simple.json'), 'utf8')));
      const record = fixture.evidence.find(item => item.id === 'doc-current'); if (!record) throw new Error('synthetic_source_unavailable');
      tools = [new FixtureReadTool([{ ...record, tenantId: policy.tenantId, scope }])];
    }
    const sink = knoxRegistration ? new KnoxChannel(stores.channel, knoxRegistration,
      { agentId, tenantId: actor.tenantId, principalId: actor.principalId }, lifetime.signal) : stores.channel;
    const composed = await composeRuntime({ services: { state: stores.state, sink, artifacts: stores.artifacts,
      clock, ids, digester, planner, tools: [...tools, ...(openedArchive?.tools ?? []), ...(openedA2a?.tools ?? [])],
      ...(missionRegistration ? { notifications: {
        current: async (state: WorkState) => {
          if ([...(state.subscriptions ?? []), ...(state.notifications ?? [])].some(value => value.provider !== 'mission' && !(value.provider === 'board' && openedBoard))) return false;
          return openedMissions !== null && await openedMissions.missions.current(state);
        },
        refresh: async (workId: string) => {
          if (!openedMissions) throw new Error('mission_registration_unavailable');
          return openedMissions.missions.refresh(workId);
        },
      } } : {}),
      ...(config.features.peers === true && host?.budget ? { budgetAuthority: host.budget.authority, budgetChildren: host.budget.children, budgetLedgers: host.budget.ledgers } : {}) }, schemas,
      enableBudgetTools: config.features.peers === true,
      ...(openedPeers ? { peers: { agents: openedPeers.peers, agentId } } : {}),
      executionAuthority: createExecutionAuthority({ actor: policy, scope, signal: lifetime.signal,
        ...(policy.disclosure ? { disclosure: policy.disclosure } : {}) }),
      ...(openedModel ? { modelInputLimits: openedModel.inputLimits } : {}),
      ...(openedTools?.collectionTools === undefined ? {} : { collectionTools: [...openedTools.collectionTools] }),
      ...(openedTools?.computerTools === undefined ? {} : { computerTools: [...openedTools.computerTools] }),
      ...(openedTools?.effectReaders === undefined ? {} : { effectReaders: new Map(openedTools.effectReaders.map(value => [value.provider, value.reader])) }),
      ...(openedBoard ? { board: { repository: openedBoard.repository, actors: openedBoard.actors, authority: openedBoard.authority,
        ...(openedBoard.workSources ? { workSources: openedBoard.workSources } : {}) } } : {}),
      ...(openedArchive ? { archive: { service: openedArchive.service, actor } } : {}),
      guidanceSource: guidanceSource(stores.profile.paths.skills, config.skills.mode), owner: ids.next('agent-turn-worker'), enablePlanning: true,
      knowledge: { repository: stores.knowledge, actors: { current: async () => structuredClone(knowledgeActor) } }, workspaceFiles: stores.workspace,
      session: { repository: stores.sessions, agentId, ...(selected.compactLimits ? { compact: selected.compactLimits } : {}) } });
    execution = composed.runtime;
    settlePlanning = async () => {
      await composed.planning?.settlePending();
      if (composed.compactPlanning !== composed.planning) await composed.compactPlanning?.settlePending();
    };
    if (!composed.sessions || !composed.personalKnowledge) throw new Error('agent_turn_services_unavailable');
    if (missionRegistration) {
      openedMissions = await openHostMissions(missionRegistration, { agentId, root: stores.profile.root, scope, actor, signal: lifetime.signal },
        { services: composed.services }, openedA2a?.sources ?? []);
      if (!openedMissions || composed.contracts.providerEpoch('mission') !== 0) throw new Error('mission_provider_conflict');
      composed.contracts.replaceProvider('mission', [...openedMissions.tools], { expectedEpoch: 0, sourceRevision: '1', signal: lifetime.signal });
      composed.services.tools.push(...openedMissions.tools);
    }
    for (const registration of openedTools?.providerSources ?? [])
      await refreshProviderTools(composed.contracts, registration.provider, registration.source, { ...registration.limits, signal: lifetime.signal });
    const personal = stores.profile.effectivePersonalMemory.backend === 'documents' ? stores.profile.effectivePersonalMemory : null;
    const memoryDrafts = personal ? { storeId: personal.storeId, store: new FilePersonalMemoryDrafts({ root: stores.profile.root,
      runtimeRoot, agentId, storeId: personal.storeId, memoryDirectory: join(stores.profile.root, 'memory') }) } : null;
    const recoverySource = JSON.stringify({ identity: stores.profile.identity, storage: config.storage, memory: stores.profile.effectivePersonalMemory });
    workspaceRecovery = createHostWorkspaceRecovery({ agentId, root: stores.profile.root, services: composed.services, actor, signal: lifetime.signal,
      assertCurrent() {
        stores.assertIdentityCurrent();
        const current = profiles.inspect(stores.profile.root);
        if (current.status !== 'ready' || current.root !== stores.profile.root || current.personalMemoryMigration?.phase === 'pending' ||
          current.postgresMigration?.phase === 'pending' ||
          JSON.stringify({ identity: current.identity, storage: current.config.storage, memory: current.effectivePersonalMemory }) !== recoverySource)
          throw new Error('workspace_recovery_source_changed');
      } });
    stores.assertIdentityCurrent();
    return { ...composed, sessions: composed.sessions, turns: new AgentTurnService(composed.sessions, digester),
      services: { ...composed.services, sink }, agentId, actor, executionActor, policy, scope, limits, provider: selected.provider,
      knoxDestination: knoxRegistration?.destination ?? null,
      archive: openedArchive?.service ?? null,
      missions: openedMissions?.missions ?? null, missionSources: openedMissions?.sources ?? [], a2a: openedA2a?.peer ?? null,
      createResidentMissions(defaults: HostResidentMissionDefaults) {
        if (!openedMissions || lifetime.signal.aborted) throw new Error('agent_mission_registration_required');
        const driver = createHostResidentMissions({ services: composed.services, sessions: composed.sessions!, workflow: composed.workflow,
          agentId, scope, actor, signal: lifetime.signal, sources: openedMissions.sources }, defaults);
        residentDrivers.add(driver); return driver;
      },
      async openA2aHandler(caller: Pick<A2aRequestHost, 'callerId' | 'actor' | 'policy' | 'destination' | 'maxSteps' | 'mode'>) {
        if (!a2aInbound || lifetime.signal.aborted) throw new Error('agent_a2a_inbound_registration_required');
        const handler = await openA2aRequestHandler({ ...caller, agentId, scope, limits, signal: lifetime.signal,
          services: composed.services, sessions: composed.sessions!, turns: new AgentTurnService(composed.sessions!, digester),
          conversation: composed.conversation, workflow: composed.workflow });
        if (lifetime.signal.aborted) { handler.close(); throw new Error('agent_a2a_inbound_closed'); }
        a2aHandlers.add(handler); return handler;
      },
      modelInfo, compactProvider, stateBackend: stores.profile.config.storage.state,
      personalMemoryBackend: stores.profile.effectivePersonalMemory.backend, personalKnowledge: composed.personalKnowledge,
      memoryDrafts, workspaceRecovery, close };
  } catch (error) { await closeAgentTurnResources([close], { error }); throw error; }
}

export type AgentTurnProfile = Awaited<ReturnType<typeof openAgentTurnProfile>>;
