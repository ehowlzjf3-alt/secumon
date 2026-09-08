import type { ArtifactRef, Delivery, Json, Scalar, WorkState } from './model.js';

export type EvaluationVariant = 'simple' | 'complex' | 'late_counterevidence' | 'partial_result' | 'source_missing' | 'permission_revoked' |
  'tool_errors' | 'model_errors' | 'next_day_reply' | 'mode_change' | 'cancel_running' | 'stored_model_resume' | 'stored_tool_resume' |
  'compact' | 'unknown_delivery' | 'status_only';
export interface EvaluationCase {
  id: string;
  family: 'document_comparison' | 'observation_review';
  fixtureId: string;
  backend: string;
  mode: 'auto' | 'fast' | 'deep';
  variant: EvaluationVariant;
  oracle: {
    expectedFinal: 'complete' | 'blocked' | 'cancelled' | 'wait' | 'unchanged';
    completionEligible: boolean;
    requiredEvidenceIds: string[];
    originals: { id: string; sourceId: string; lineageId: string; observedAt: number }[];
    facts: Record<string, Scalar>;
    finalHypothesis: { id: string; status: 'supported' | 'refuted' | 'inconclusive' } | null;
    forbiddenEvidenceIds: string[];
    noCompletionBefore: number | null;
    /** Fixed fixture answer and its UTF-8 SHA-256, never derived from the observed model output. */
    response?: { kind: 'exact_text'; text: string; sha256: string } | undefined;
  };
}
export interface EvaluationEntry {
  kind: 'model' | 'tool' | 'send' | 'lookup';
  at: number;
  id: string;
  sourceKey: string | null;
}
export interface EvaluationObservation {
  at: number;
  stage: string;
  state: WorkState;
  eventTypes: string[];
  deliveries: Delivery[];
  /** Original stored answer bytes decoded by the collector, alongside their actual artifact reference. */
  response?: { artifact: ArtifactRef; text: string } | undefined;
}
export interface EvaluationSample {
  case: EvaluationCase;
  observations: EvaluationObservation[];
  entries: EvaluationEntry[];
  finalControl: string;
  startedAt: number;
  finishedAt: number;
  wallElapsedMs: number;
  runError: string | null;
}
export interface EvaluationScore {
  caseId: string;
  contractPassed: boolean;
  goalCompleted: boolean;
  falseCompletionRevisions: number[];
  failures: string[];
  finalControl: string;
  usage: WorkState['budget'];
  calls: { modelEntries: number; toolEntries: number; sends: number; lookups: number; uniqueQueries: number; repeatedQueries: number; adoptedTools: number; reusedTools: number };
  context: { requestBytes: number; estimatedTokens: number; sourceReads: number; evictions: number; reloads: number };
  latency: { ackMs: number | null; firstEvidenceMs: number | null; firstUsefulAnswerMs: number | null; verifiedCompletionMs: number | null; simulatedElapsedMs: number; wallElapsedMs: number };
  interventions: number;
  promotions: number;
}

/** Local consistency pins; these are not signatures or third-party provenance. */
export interface EvaluationPins {
  suite: string;
  fixture: string;
  caseDefinition: string;
  code: string;
  configuration: string;
  environment: Json;
}
export interface EvaluationReplayBundle {
  version: 1;
  workId: string;
  pins: EvaluationPins;
  sample: EvaluationSample;
  sampleDigest: string;
  score: EvaluationScore;
  scoreDigest: string;
  finalStateDigest: string;
  eventsDigest: string;
  deliveriesDigest: string;
  receipts: { commandId: string; digest: string; stateRevision: number; stateDigest: string }[];
  artifacts: ArtifactRef[];
  checkpoint: ArtifactRef | null;
}
export interface EvaluationReplayResult {
  available: boolean;
  failures: string[];
  score: EvaluationScore | null;
  checkedReceipts: number;
  checkedArtifacts: number;
}
