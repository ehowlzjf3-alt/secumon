export type WorkKind = 'lookup' | 'transform' | 'compare' | 'investigate' | 'followup';
export interface MethodChoice {
  id: string;
  version: string;
  reason: string;
  guidanceIds: string[];
  requiresHypothesisReview: boolean;
}
export interface MethodNeeds {
  kind: WorkKind;
  hasContradictions: boolean;
  needsIndependentSources: boolean;
  awaitsResponse: boolean;
}
export function selectMethod(needs: MethodNeeds): MethodChoice {
  if (needs.hasContradictions || needs.kind === 'investigate') return { id: 'core.hypothesis-inquiry', version: '1', reason: 'discriminate_competing_explanations', guidanceIds: ['core.evidence-review'], requiresHypothesisReview: true };
  if (needs.awaitsResponse || needs.kind === 'followup') return { id: 'core.response-followup', version: '1', reason: 'persist_pending_response', guidanceIds: ['core.evidence-review'], requiresHypothesisReview: false };
  if (needs.needsIndependentSources || needs.kind === 'compare') return { id: 'core.evidence-comparison', version: '1', reason: 'compare_independent_sources', guidanceIds: ['core.evidence-review'], requiresHypothesisReview: false };
  if (needs.kind === 'transform') return { id: 'core.checked-transformation', version: '1', reason: 'verify_output_against_input', guidanceIds: ['core.evidence-review'], requiresHypothesisReview: false };
  return { id: 'core.direct-lookup', version: '1', reason: 'answer_from_named_evidence', guidanceIds: [], requiresHypothesisReview: false };
}
