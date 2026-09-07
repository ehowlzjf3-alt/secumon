import type { ArtifactRef, PlanProposal } from './model.js';
import type { AppliedSessionInput } from './session.js';

export interface ResponseRequirement {
  version: 1;
  requestMessageId: string;
  requestTextDigest: string;
  format: 'text';
}

/** A model assessment is a claim about the response, not independent factual evidence. */
export interface AnswerAssessment {
  type: 'model_self_review';
  verdict: 'satisfied' | 'needs_work';
  rationale: string;
  missing: string[];
  counterarguments: string[];
}

export type AgentTurnResult =
  | { kind: 'answer'; text: string; evidenceIds: string[]; assessment: AnswerAssessment }
  | { kind: 'question'; question: string }
  | { kind: 'plan'; proposal: PlanProposal };

export interface GeneratedAnswer {
  id: string;
  callId: string;
  goalRevision: number;
  planRevision: number;
  dataGeneration: number;
  input: AppliedSessionInput;
  inputArtifact: ArtifactRef;
  promptDigest: string;
  basisDigest: string;
  artifact: ArtifactRef;
  evidenceIds: string[];
  observedEvidenceIds: string[];
  assessment: AnswerAssessment;
  createdAt: number;
}
