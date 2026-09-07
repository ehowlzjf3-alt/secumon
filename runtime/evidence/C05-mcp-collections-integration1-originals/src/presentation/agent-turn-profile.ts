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
import type { Limits, Policy, ContextPacket } from '../domain/model.js';
import type { TrustedKnowledgeActor } from '../domain/knowledge.js';
import type { SessionCompactLimits } from '../domain/session-compact.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
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
  const stores = await openAgentStores(profiles, ready.root);
  let openedModel: OpenedHostModel | null = null;
  let openedTools: OpenedHostTools | null = null;
  let execution: ExecutionRuntime | undefined;
  const lifetime = new AbortController();
  let closing: Promise<void> | undefined;
  const close = () => {
    lifetime.abort();
    execution?.beginClose();
    return closing ??= closeAgentTurnResources([...(openedModel ? [openedModel.close] : []), ...(openedTools ? [openedTools.close] : []),
      ...(execution ? [() => execution!.finishClose()] : []), stores.close]);
  };
  try {
    const agentId = stores.profile.identity.agentId; const config = stores.profile.config;
    if (registration && config.model?.profile !== profileName) throw new Error('agent_model_registration_changed');
    const scope = `agent:${agentId}`;
    const ids = new RandomIds(), digester = new Sha256Digester(), schemas = new AjvSchemas();
    const clock = Object.freeze({ now: () => Date.now() });
    if (toolRegistration) openedTools = await openRegisteredHostTools(toolRegistration, { agentId, root: stores.profile.root, scope },
      Object.freeze({ custody: Object.freeze({ state: stores.state, artifacts: stores.artifacts, digester, clock }), schemas, signal: lifetime.signal }));
    const allowedTools = ['fixture.read', ...RESOURCE_TOOL_IDS.filter(id => config.skills.mode !== 'off' || !id.startsWith('core.guidance.')), ...KNOWLEDGE_TOOL_IDS];
    const policy: Policy = frozen(openedTools ? { ...structuredClone(openedTools.policy),
      allowedTools: openedTools.policy.allowedTools.filter(id => config.skills.mode !== 'off' || !id.startsWith('core.guidance.')) } :
      { tenantId: 'local', principalId: 'operator', allowedTools, allowedLabels: ['synthetic', 'public'], allowedDestinations: ['local'], allowWrites: false });
    const actor: WorkActor = frozen({ tenantId: policy.tenantId, principalId: policy.principalId,
      allowedTools: [...policy.allowedTools], allowedLabels: [...policy.allowedLabels], allowedDestinations: [...policy.allowedDestinations], allowWrites: false });
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
    if (openedTools) tools = [...openedTools.tools];
    else {
      const fixture = validateScenario(JSON.parse(await readFile(join(runtimeRoot, 'fixtures', 'documents-simple.json'), 'utf8')));
      const record = fixture.evidence.find(item => item.id === 'doc-current'); if (!record) throw new Error('synthetic_source_unavailable');
      tools = [new FixtureReadTool([{ ...record, tenantId: policy.tenantId, scope }])];
    }
    const composed = await composeRuntime({ services: { state: stores.state, sink: stores.channel, artifacts: stores.artifacts,
      clock, ids, digester, planner, tools }, schemas,
      executionAuthority: createExecutionAuthority({ actor: policy, scope, signal: lifetime.signal,
        ...(policy.disclosure ? { disclosure: policy.disclosure } : {}) }),
      ...(openedModel ? { modelInputLimits: openedModel.inputLimits } : {}),
      guidanceSource: guidanceSource(stores.profile.paths.skills, config.skills.mode), owner: ids.next('agent-turn-worker'), enablePlanning: true,
      knowledge: { repository: stores.knowledge, actors: { current: async () => structuredClone(knowledgeActor) } }, workspaceFiles: stores.workspace,
      session: { repository: stores.sessions, agentId, ...(selected.compactLimits ? { compact: selected.compactLimits } : {}) } });
    execution = composed.runtime;
    if (!composed.sessions || !composed.personalKnowledge) throw new Error('agent_turn_services_unavailable');
    for (const registration of openedTools?.providerSources ?? [])
      await refreshProviderTools(composed.contracts, registration.provider, registration.source, { ...registration.limits, signal: lifetime.signal });
    const personal = stores.profile.effectivePersonalMemory.backend === 'documents' ? stores.profile.effectivePersonalMemory : null;
    const memoryDrafts = personal ? { storeId: personal.storeId, store: new FilePersonalMemoryDrafts({ root: stores.profile.root,
      runtimeRoot, agentId, storeId: personal.storeId, memoryDirectory: join(stores.profile.root, 'memory') }) } : null;
    return { ...composed, sessions: composed.sessions, turns: new AgentTurnService(composed.sessions, digester),
      services: { ...composed.services, sink: stores.channel }, agentId, actor, executionActor, policy, scope, limits, provider: selected.provider,
      modelInfo, compactProvider, stateBackend: stores.profile.config.storage.state,
      personalMemoryBackend: stores.profile.effectivePersonalMemory.backend, personalKnowledge: composed.personalKnowledge,
      memoryDrafts, close };
  } catch (error) { await closeAgentTurnResources([close], { error }); throw error; }
}

export type AgentTurnProfile = Awaited<ReturnType<typeof openAgentTurnProfile>>;
