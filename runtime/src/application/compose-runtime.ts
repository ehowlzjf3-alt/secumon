import { ExecutionRuntime } from './execution-runtime.js';
import { GuidanceCatalog, type GuidanceSource } from './guidance.js';
import { createResourceTools } from './resource-tools.js';
import type { ReadCollectionBinding, SchemaCompiler } from './ports.js';
import type { RuntimeServices, EffectProofValidator } from './services.js';
import { ToolCatalog } from './tool-catalog.js';
import { ToolContracts } from './tool-contracts.js';
import { WorkResources, authorizedWork, type WorkActor } from './work-resources.js';
import { PlanningRuntime } from './planning-runtime.js';
import { ContextCompiler } from './context-compiler.js';
import { ContextRecovery } from './context-recovery.js';
import { ConversationService } from './conversation-service.js';
import { OutboxDispatcher } from './outbox.js';
import { WorkflowRuntime } from './workflow-runtime.js';
import { DataLifecycleService } from './data-lifecycle.js';
import { KnowledgeService } from './knowledge-service.js';
import { createKnowledgeTools } from './knowledge-tools.js';
import type { KnowledgeRepository, TrustedKnowledgeActorProvider } from './knowledge-ports.js';
import { WorkspaceCheckpoints, type WorkspaceStore } from './workspace-checkpoints.js';
import { ToolResultReuse } from './tool-result-reuse.js';
import { ExecutionJoin } from './execution-join.js';
import { createReadCollectionTool, ReadCollections } from './read-collections.js';
import { DisclosureService } from './disclosure-service.js';
import type { DisclosureRule } from '../domain/disclosure.js';
import { WorkViewService } from './work-view-service.js';
import { ComputerUse, createComputerTools, prepareComputerBinding } from './computer-use.js';
import { ComputerContinuations } from './computer-continuations.js';
import { ComputerReconciliations } from './computer-reconciliation.js';
import type { ComputerBinding } from './computer-use-ports.js';
import { effectProofsCurrent } from './effect-proofs.js';
import { ReadCoverageProofs } from './read-coverage-proofs.js';
import type { BoardActorProvider, BoardRepository } from './board-ports.js';
import type { InputAuthority } from './knowledge-ports.js';
import { BoardService } from './board-service.js';
import { createBoardTools } from './board-tools.js';
import { BoardCommands } from './board-commands.js';
import { createBoardRequestTool } from './board-request-tools.js';
import { BoardWatch } from './board-watch.js';
import { WorkInputGraph } from './work-input-graph.js';
import type { WorkInputValidator } from './services.js';
import type { SessionRepository } from './session-ports.js';
import { SessionService } from './session-service.js';
import type { SessionCompactLimits } from '../domain/session-compact.js';
import { SessionKnowledgeSources } from './session-knowledge-sources.js';
import { PersonalMemoryService } from './personal-memory-service.js';
import type { PersonalKnowledgeFactory } from './personal-memory-ports.js';
import type { KnowledgeDependency } from '../domain/knowledge.js';
import type { WorkState } from '../domain/model.js';
import { asJson } from './plan-validator.js';
import type { SourceInputInspection } from './source-input-inspection.js';
import { agentTurnRequestCurrent } from './agent-turn-request.js';
import { agentTurnPreviousAnswerCurrent } from './agent-turn-previous.js';
import type { ModelInputRuntimeLimits } from './model-input-budget.js';
import type { ExecutionAuthority } from './execution-authority.js';
import type { BoardWorkSource, BoardWorkSources } from './board-work-sources.js';
import { ArchiveReconciliation } from './archive-reconciliation.js';
import type { ArchiveService } from './archive-service.js';
import { createBudgetTools } from './budget-tools.js';
import { PeerAgents } from './peer-agents.js';
import type { PeerAgent } from './peer-contracts.js';
import { captureEffectReaders, registeredEffectReaders } from './registered-effect-readers.js';

export async function composeRuntime(input: { services: RuntimeServices; schemas: SchemaCompiler; guidanceSource: GuidanceSource; owner: string; leaseMs?: number; enablePlanning?: boolean;
  executionAuthority?: ExecutionAuthority;
  effectReaders?: ReadonlyMap<string, EffectProofValidator>;
  modelInputLimits?: ModelInputRuntimeLimits;
  personalKnowledge?: PersonalKnowledgeFactory;
  collectionTools?: ReadCollectionBinding[];
  computerTools?: ComputerBinding[];
  disclosureRules?: DisclosureRule[];
  board?: { repository: BoardRepository; actors: BoardActorProvider; authority: InputAuthority; workSources?: BoardWorkSources };
  archive?: { service: ArchiveService; actor: WorkActor };
  enableBudgetTools?: boolean;
  peers?: { agents: ReadonlyMap<string, PeerAgent>; agentId: string };
  session?: { repository: SessionRepository; agentId: string; compact?: Partial<SessionCompactLimits> };
  knowledge?: { repository: KnowledgeRepository; actors: TrustedKnowledgeActorProvider }; workspaceFiles?: WorkspaceStore }) {
  const capturedEffectReaders = captureEffectReaders(input.effectReaders);
  if (input.executionAuthority && input.services.executionAuthority && input.executionAuthority !== input.services.executionAuthority) throw new Error('runtime_execution_authority_conflict');
  const guidance = await GuidanceCatalog.create(input.guidanceSource, { digester: input.services.digester, clock: input.services.clock, ids: input.services.ids });
  const effects = { current: (state: Parameters<typeof effectProofsCurrent>[1]) => effectProofsCurrent(services, state) };
  if (input.board && input.services.inputs) throw new Error('runtime_inputs_conflict');
  const inputs: WorkInputValidator | undefined = input.board ? {
    current: (state, signal) => services.inputs!.current(state, signal), validate: (dependencies, state, signal) => services.inputs!.validate(dependencies, state, signal),
  } : input.services.inputs;
  const userSources = input.session ? new SessionKnowledgeSources(input.services, input.session.repository, input.session.agentId) : undefined;
  const knowledgeDependencies = input.knowledge ? { ...input.knowledge, states: input.services.state, clock: input.services.clock, digester: input.services.digester, effects, inputs,
    ...(userSources ? { userSources } : {}) } : null;
  const knowledgeTools = knowledgeDependencies ? createKnowledgeTools(knowledgeDependencies) : null;
  const knowledge = knowledgeDependencies ? new KnowledgeService(knowledgeDependencies) : null;
  const personalKnowledge: PersonalKnowledgeFactory | undefined = input.personalKnowledge ?? (knowledge && input.session ? async (actor, workId) => {
    const work = workId ? await authorizedWork(input.services.state, workId, actor) : null;
    if (work && work.conversation?.session?.scope.agentId !== input.session!.agentId) throw new Error('personal_memory_unavailable');
    const restriction = work?.policy ?? actor;
    return knowledge.forPersonal(restriction);
  } : undefined);
  const personalActor = (actor: WorkActor, dependency: KnowledgeDependency, work?: WorkState): WorkActor => {
    const digest = (value: unknown) => input.services.digester.digest(asJson(value));
    const selected = work?.personalMemorySelection;
    if (!selected?.entries.some(entry => digest(entry.dependency) === digest(dependency))) return actor;
    return { ...actor,
      allowedLabels: selected.policy.allowedLabels.filter(label => actor.allowedLabels === undefined || actor.allowedLabels.includes(label)),
      allowedDestinations: selected.policy.allowedDestinations.filter(destination => actor.allowedDestinations === undefined || actor.allowedDestinations.includes(destination)) };
  };
  let catalog: ToolCatalog; let resources: WorkResources; let readCollections: ReadCollections; let computerUse: ComputerUse;
  const resourceTools = createResourceTools({ state: input.services.state, artifacts: input.services.artifacts, guidance,
    catalog: () => catalog, resources: () => resources });
  const collectionTools = (input.collectionTools ?? []).map(binding => createReadCollectionTool(binding, () => readCollections));
  const boundComputerBindings = (input.computerTools ?? []).map(prepareComputerBinding);
  const computerTools = boundComputerBindings.flatMap(binding => createComputerTools(binding, () => computerUse));
  const services: RuntimeServices = { ...input.services, tools: [...input.services.tools, ...collectionTools, ...computerTools, ...resourceTools, ...(knowledgeTools?.tools ?? [])],
    ...(input.executionAuthority ? { executionAuthority: input.executionAuthority } : {}),
    ...(knowledgeTools ? { knowledge: { validate: knowledgeTools.validate } } : {}) };
  if (knowledgeTools && personalKnowledge) services.knowledge = { async validate(dependencies, workId, policy) {
    const personal = dependencies.filter(dependency => dependency.owner !== undefined), legacy = dependencies.filter(dependency => dependency.owner === undefined);
    if (legacy.length && !(await knowledgeTools.validate(legacy, workId, policy))) return false;
    try {
      const work = await authorizedWork(services.state, workId, policy);
      for (const dependency of personal) if (!(await (await personalKnowledge(personalActor(policy, dependency, work), workId)).validateDependencies([dependency]))) return false;
      return true;
    } catch { return false; }
  } };
  if (input.session && services.sessions) throw new Error('runtime_sessions_conflict');
  const conversation = new ConversationService(services);
  const sessions = input.session ? new SessionService(services, input.session.repository, input.session.agentId, conversation, input.session.compact) : null;
  if (sessions) { services.sessions = sessions; services.sessionCompacts = sessions; }
  const board = input.board ? new BoardService({ ...input.board, services }) : null;
  const boardTools = input.board ? createBoardTools({ ...input.board, services }) : null;
  const boardCommands = input.board && boardTools ? new BoardCommands({ ...input.board, services, containsPosts: boardTools.containsPosts }) : null;
  const boardWatch = input.board ? new BoardWatch({ ...input.board, services }) : null;
  if (boardCommands) services.obligations = { current: state => boardCommands.obligationsCurrent(state), refresh: workId => boardCommands.refreshObligations(workId) };
  if (boardWatch) {
    const external = services.notifications;
    services.notifications = external ? {
      current: async state => await boardWatch.current(state) && await external.current(state),
      refresh: async workId => { await boardWatch.refresh(workId); return external.refresh(workId); },
    } : boardWatch;
  }
  let workInputGraph: WorkInputGraph | undefined;
  if (boardTools && input.board) {
    services.tools.push(...boardTools.tools);
    services.tools.push(...boardCommands!.tools);
    services.tools.push(createBoardRequestTool({ ...input.board, services }));
    services.inputs = workInputGraph = new WorkInputGraph({ services, sourceId: input.session ? `agent:${input.session.agentId}` : `runtime:${input.owner}`,
      authority: input.board.authority, readers: [boardTools.reader],
      memory: knowledgeDependencies ? async (dependencies, actor, signal, work) => {
        const legacy = dependencies.filter(dependency => dependency.owner === undefined), personal = dependencies.filter(dependency => dependency.owner !== undefined);
        const inspected: SourceInputInspection[] = [];
        if (legacy.length || !personal.length) inspected.push(await new KnowledgeService({ ...knowledgeDependencies,
          inputs: undefined, actors: { current: async () => structuredClone(actor) }, signal }).inspectDependencies(legacy));
        for (const dependency of personal) {
          if (!personalKnowledge || !work || signal.aborted) throw new Error('personal_memory_unavailable');
          inspected.push(await (await personalKnowledge(personalActor(actor, dependency, work), work.id)).inspectDependencies([dependency]));
        }
        const expiries = inspected.flatMap(value => value.validUntil == null ? [] : [value.validUntil]);
        return { version: services.digester.digest(asJson(inspected.map(value => value.version))), sourceWorkIds: [...new Set(inspected.flatMap(value => value.sourceWorkIds))],
          sourceWorks: inspected.flatMap(value => value.sourceWorks ?? []),
          knowledgeDependencies: inspected.flatMap(value => value.knowledgeDependencies), bytesRead: inspected.reduce((sum, value) => sum + value.bytesRead, 0),
          validUntil: expiries.length ? Math.min(...expiries) : null,
          current: async () => { for (const value of inspected) if (signal.aborted || !(await value.current())) return false; return true; } };
      } : undefined });
  }
  const peers = input.peers ? new PeerAgents(services, input.peers.agents, input.peers.agentId) : null;
  if (peers) services.tools.push(...peers.tools);
  if (input.enableBudgetTools) services.tools.push(...createBudgetTools({ services, execution: () => runtime, workflow: () => workflow }));
  const contracts = new ToolContracts(services.tools, input.schemas);
  services.readCoverage = new ReadCoverageProofs(services, contracts);
  readCollections = new ReadCollections(services, contracts, input.owner);
  computerUse = new ComputerUse(services, contracts, input.owner);
  catalog = new ToolCatalog(contracts, services.digester, { clock: services.clock, ids: services.ids }); resources = new WorkResources(services.state, services.artifacts, contracts, services.digester, services.knowledge, guidance, effects, services.inputs);
  const resultReuse = new ToolResultReuse(services, contracts, resources);
  const runtime = new ExecutionRuntime(services, contracts, input.owner, input.leaseMs, resultReuse, readCollections);
  if (services.workCancellation) throw new Error('runtime_work_cancellation_conflict');
  services.workCancellation = Object.freeze({ register: runtime.registerCancellation.bind(runtime), interrupt: runtime.interrupt.bind(runtime) });
  if (personalKnowledge && services.personalMemories) throw new Error('runtime_personal_memory_conflict');
  const personalMemories = personalKnowledge ? new PersonalMemoryService(services, personalKnowledge, id => runtime.interrupt(id)) : null;
  if (personalMemories) services.personalMemories = personalMemories;
  sessions?.bindCommands(runtime);
  const computerReconciliations = new ComputerReconciliations(services, contracts, computerUse, runtime, boundComputerBindings);
  const computerContinuations = new ComputerContinuations(services, contracts, computerUse, computerReconciliations, boundComputerBindings, id => runtime.interrupt(id));
  services.continuations = computerContinuations;
  const archiveReconciliation = input.archive ? new ArchiveReconciliation({ services, execution: runtime, archive: input.archive.service, actor: input.archive.actor }) : null;
  const registeredEffects = registeredEffectReaders(services, contracts, capturedEffectReaders);
  const unknownReceipts = (state: WorkState) => state.attempts.some(attempt => attempt.effectReceipt &&
    !(attempt.effectReceipt.provider === 'board' && boardCommands) && !(attempt.effectReceipt.provider === 'archive' && archiveReconciliation) &&
    !registeredEffects.has(attempt.effectReceipt.provider));
  services.effects = {
    current: async state => await computerReconciliations.proofsCurrent(state) && await computerContinuations.current(state) &&
      !unknownReceipts(state) && (!boardCommands || await boardCommands.proofsCurrent(state)) &&
      (!archiveReconciliation || await archiveReconciliation.current(state)) && await registeredEffects.current(state),
    async refresh(workId) {
      await computerReconciliations.refresh(workId);
      await computerContinuations.refresh(workId);
      if (archiveReconciliation) await archiveReconciliation.refresh(workId);
      const state = capturedEffectReaders.size ? await registeredEffects.refresh(workId) : await runtime.state(workId);
      if (unknownReceipts(state)) throw new Error('effect_receipt_reader_unavailable');
      if (boardCommands) {
        await boardCommands.refresh(workId); await boardCommands.refreshObligations(workId); await boardWatch!.refresh(workId);
        return runtime.state(workId);
      }
      return state;
    },
    recover: async (workId, attemptId) => {
      const state = await runtime.state(workId), attempt = state.attempts.find(value => value.id === attemptId);
      if (archiveReconciliation && attempt && (attempt.effectReceipt?.provider === 'archive' ||
        ['register', 'revise', 'delete'].some(operation => attempt.toolId === `${input.archive!.service.descriptor.id}.${operation}`)))
        return archiveReconciliation.recover(workId, attemptId);
      if (boardCommands && attempt && (attempt.effectReceipt?.provider === 'board' || boardCommands.tools.some(tool => tool.definition.id === attempt.toolId))) {
        await boardCommands.reconcile(workId, attemptId); await boardCommands.refreshObligations(workId); await boardWatch!.refresh(workId);
        return runtime.state(workId);
      }
      return capturedEffectReaders.size ? registeredEffects.recover(workId, attemptId) : runtime.state(workId);
    },
  };
  const executionJoin = new ExecutionJoin(services, runtime);
  const context = new ContextCompiler(services, contracts, guidance);
  if (services.generatedAnswers) throw new Error('runtime_generated_answers_conflict');
  if (services.planner.turn) services.generatedAnswers = { current: async (state, turn, options) => {
    const digest = (value: unknown) => services.digester.digest(asJson(value));
    if (!services.planner.prompt || digest(turn.prompt) !== digest(services.planner.prompt) ||
      turn.prompt.profile.agentId !== state.conversation?.session?.scope.agentId ||
      turn.prompt.profile.skillsMode === 'off' && (turn.packet.activeGuidance?.length ?? 0) > 0) return false;
    return !!input.session && await agentTurnRequestCurrent(services, input.session.repository, state) &&
      await agentTurnPreviousAnswerCurrent(services, state, turn) &&
      context.definitionsCurrent(turn.packet, options, state) &&
      await context.sourcesCurrent(turn.packet, state, undefined, { ignoreDeliveryObligations: true });
  } };
  const planningOptions = { ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }), ...input.modelInputLimits };
  const planning = services.planner.identity && input.enablePlanning !== false ? new PlanningRuntime(services, contracts, runtime, input.owner, planningOptions, context) : null;
  const compactPlanning = services.planner.identity && services.planner.compact && services.sessionCompacts
    ? planning ?? new PlanningRuntime(services, contracts, runtime, input.owner, planningOptions, context) : null;
  const recovery = new ContextRecovery(services, contracts); const outbox = new OutboxDispatcher(services, input.owner, input.leaseMs);
  const workflow = new WorkflowRuntime(services, runtime, planning, conversation, outbox, recovery, compactPlanning);
  const dataLifecycle = new DataLifecycleService(services, workId => runtime.interrupt(workId));
  const workspace = input.workspaceFiles ? new WorkspaceCheckpoints(services, input.workspaceFiles) : null;
  const disclosure = new DisclosureService(services, input.disclosureRules ?? []);
  const workView = new WorkViewService({
    state: { get: workId => services.state.get(workId), deliveries: workId => services.state.deliveries(workId), recentEventMetadata: (workId, query) => services.state.recentEventMetadata(workId, query) },
    artifacts: { get: (ref, policy) => services.artifacts.get(ref, policy) }, digester: services.digester, knowledge: services.knowledge,
    effects, readCoverage: services.readCoverage, inputs: services.inputs, obligations: services.obligations, notifications: services.notifications,
    sessions: services.sessions, personalMemories: services.personalMemories, generatedAnswers: services.generatedAnswers,
  });
  const boardWorkSource: BoardWorkSource | null = workInputGraph ? Object.freeze({
    inputs: workInputGraph.source,
    artifacts: Object.freeze({ get: services.artifacts.get.bind(services.artifacts), exists: services.artifacts.exists.bind(services.artifacts) }),
    current: (state: WorkState) => workInputGraph!.current(state),
  }) : null;
  return { runtime, planning, compactPlanning, workflow, recovery, conversation, sessions, personalKnowledge, personalMemories, outbox, catalog, resources, guidance, contracts, dataLifecycle, knowledge, board, boardCommands, boardWatch, boardWorkSource, archiveReconciliation, peers, workspace, context, resultReuse, executionJoin, readCollections, readCheckpoints: readCollections.checkpoints, computerUse, computerReconciliations, computerContinuations, disclosure, workView, services };
}
