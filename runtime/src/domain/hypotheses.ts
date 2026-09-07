import type { WorkState } from './model.js';
import { accessibleEvidence } from './completion.js';

export function currentEvidenceIds(state: WorkState): string[] {
  return accessibleEvidence(state.evidence, state.policy, state.goal.scope).map(e => e.id).sort();
}
export function hypothesesRequireReview(state: WorkState): boolean {
  if (!state.hypotheses.length) return false;
  const assessment = state.hypothesisAssessment;
  return !assessment || assessment.goalRevision !== state.goal.revision || JSON.stringify(assessment.evidenceIds) !== JSON.stringify(currentEvidenceIds(state));
}
