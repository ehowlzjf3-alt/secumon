import type { ArtifactRef, ContextPacket, Delivery, Evidence, ModelCall, ProgressSummary, WorkState } from './model.js';
import type { BudgetSummary } from './budget-delegation.js';

export interface ResumePacket {
  schemaVersion: 1;
  kind: 'runtime_resume';
  builderRevision: '1';
  workId: string;
  stateRevision: number;
  eventCursor: number;
  stateDigest: string;
  toolDigest: string;
  context: ContextPacket;
  runtime: Pick<WorkState, 'subscriptions' | 'status' | 'statusReason' | 'budget' | 'deadlineAt' | 'attempts' | 'hypothesisAssessment' | 'artifacts' | 'conversation' | 'dataLifecycle' | 'workspaceCheckpoints' | 'executionControl' | 'retryWakeAt' | 'computerReconciliations' | 'computerContinuations'> & {
    progress?: ProgressSummary | undefined;
    delegation?: BudgetSummary | undefined;
    modelCalls: (Omit<ModelCall, 'inputArtifact'> & { inputArtifact: ArtifactRef | null })[];
  };
  evidenceIndex: Omit<Evidence, 'facts'>[];
  deliveries: Omit<Delivery, 'text'>[];
}
