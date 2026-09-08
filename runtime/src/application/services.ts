import type { ArtifactStore, Clock, Digester, IdGenerator, MessageSink, Planner, StateRepository, Tool } from './ports.js';
import type { KnowledgeDependency } from '../domain/knowledge.js';
import type { Policy, TaskSpec, WorkState } from '../domain/model.js';
import type { ComputerContinuationClaim } from '../domain/computer-continuation.js';
import type { ComputerActInput, ComputerCheckpointV2 } from '../domain/computer-use.js';
import type { SourceInputInspection } from './source-input-inspection.js';
import type { InputDependency } from '../domain/inputs.js';
import type { BudgetAuthority, BudgetChildRuntime } from './budget-authority.js';
import type { BudgetWorkLedgers } from './budget-work-ledgers.js';
import type { SessionContextProvider } from './session-ports.js';
import type { SessionCompactSource } from './session-compact-ports.js';
import type { PersonalMemoryContextProvider } from './personal-memory-ports.js';
import type { AgentTurnInput } from './agent-turn-types.js';
import type { ModelCallOptions } from './ports.js';
import type { ExecutionAuthority } from './execution-authority.js';

export interface WorkInputValidator {
  current(state: WorkState, signal?: AbortSignal): Promise<boolean>;
  validate(dependencies: InputDependency[], state: WorkState, signal?: AbortSignal): Promise<boolean>;
}

export interface KnowledgeValidator {
  validate(dependencies: KnowledgeDependency[], workId: string, policy: Policy): Promise<boolean>;
}

export interface EffectProofValidator {
  current(state: WorkState): Promise<boolean>;
  refresh(workId: string): Promise<WorkState>;
  recover?(workId: string, attemptId: string): Promise<WorkState>;
}
export interface ExternalObligationValidator {
  current(state: WorkState): Promise<boolean>;
  refresh(workId: string): Promise<WorkState>;
}
export interface ExternalNotificationValidator {
  current(state: WorkState): Promise<boolean>;
  refresh(workId: string): Promise<WorkState>;
}
export interface ReadCoverageProofValidator {
  current(state: WorkState): Promise<boolean>;
  inspect?(state: WorkState): Promise<SourceInputInspection>;
}

export interface ComputerContinuationService {
  prepare(state: WorkState, task: TaskSpec, successorAttemptId: string): Promise<ComputerContinuationClaim>;
  resolve(state: WorkState, successorAttemptId: string): Promise<{ claim: ComputerContinuationClaim; rootInput: ComputerActInput; sourceCheckpoint: ComputerCheckpointV2 }>;
  current(state: WorkState): Promise<boolean>;
  refresh(workId: string): Promise<WorkState>;
}

export interface RuntimeServices {
  /** Local execution lifetime only; registration neither grants authority nor proves an operation stopped. */
  workCancellation?: {
    register(workId: string, operationId: string, controller: AbortController): () => void;
    interrupt(workId: string): void;
  } | undefined;
  executionAuthority?: ExecutionAuthority | undefined;
  generatedAnswers?: { current(state: WorkState, input: AgentTurnInput, options: ModelCallOptions): Promise<boolean> } | undefined;
  personalMemories?: PersonalMemoryContextProvider | undefined;
  state: StateRepository;
  artifacts: ArtifactStore;
  planner: Planner;
  clock: Clock;
  ids: IdGenerator;
  digester: Digester;
  tools: Tool[];
  sink: MessageSink;
  knowledge?: KnowledgeValidator | undefined;
  effects?: EffectProofValidator | undefined;
  continuations?: ComputerContinuationService | undefined;
  readCoverage?: ReadCoverageProofValidator | undefined;
  inputs?: WorkInputValidator | undefined;
  obligations?: ExternalObligationValidator | undefined;
  notifications?: ExternalNotificationValidator | undefined;
  sessions?: SessionContextProvider | undefined;
  sessionCompacts?: SessionCompactSource | undefined;
  budgetAuthority?: BudgetAuthority | undefined;
  budgetChildren?: BudgetChildRuntime | undefined;
  budgetLedgers?: BudgetWorkLedgers | undefined;
}
