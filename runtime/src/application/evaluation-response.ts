import type { EvaluationCase, EvaluationObservation } from '../domain/execution-evaluation.js';
import type { ArtifactRef, Delivery, Evidence } from '../domain/model.js';

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const sameArtifact = (left: ArtifactRef | null | undefined, right: ArtifactRef) => !!left &&
  left.id === right.id && left.sha256 === right.sha256 && left.byteLength === right.byteLength &&
  left.mediaType === right.mediaType && left.tenantId === right.tenantId && same([...left.labels].sort(), [...right.labels].sort());

/** Independent fixed-answer scoring over captured originals; runtime completion and model self-review are not the oracle. */
export function responseOracleFailures(observation: EvaluationObservation, oracle: EvaluationCase['oracle'],
  delivery: Delivery | null, readable: Evidence[]): string[] {
  const expected = oracle.response; if (!expected) return [];
  const { state, at, response } = observation, answer = state.generatedAnswer, requirement = state.goal.responseRequirement;
  const failures: string[] = [];
  if (expected.kind !== 'exact_text' || !expected.text.trim() || !/^[a-f0-9]{64}$/.test(expected.sha256)) failures.push('response_oracle_invalid');
  if (!requirement || requirement.version !== 1 || requirement.format !== 'text' || !requirement.requestMessageId || !requirement.requestTextDigest)
    failures.push('response_requirement_missing');
  if (!answer || !response) return [...failures, 'response_original_missing'];
  const permitted = (ref: ArtifactRef) => ref.tenantId === state.policy.tenantId &&
    ref.labels.every(label => state.policy.allowedLabels.includes(label)) && !state.dataLifecycle?.blockedArtifactIds.includes(ref.id);
  const bytes = new TextEncoder().encode(response.text).byteLength;
  if (!sameArtifact(response.artifact, answer.artifact) || response.text !== expected.text || answer.artifact.sha256 !== expected.sha256 ||
    answer.artifact.byteLength !== bytes || bytes > 256 * 1024 || answer.artifact.mediaType !== 'text/plain' || !permitted(answer.artifact))
    failures.push('response_original_invalid');
  if (answer.goalRevision !== state.goal.revision || answer.planRevision !== (state.plan?.revision ?? 0) ||
    answer.dataGeneration !== (state.dataLifecycle?.generation ?? 0) || !same(answer.input, state.conversation?.session) ||
    answer.input.scope.tenantId !== state.policy.tenantId || answer.input.scope.principalId !== state.policy.principalId ||
    state.conversation?.sessionReviewRequired || state.personalMemoryReviewRequired || answer.createdAt > at)
    failures.push('response_basis_invalid');
  const calls = state.modelCalls.filter(call => call.id === answer.callId), call = calls[0];
  if (calls.length !== 1 || !call || call.purpose !== 'agent_turn' || call.semanticVersion !== 4 || call.status !== 'accepted' ||
    call.expired || call.outcome !== 'ok' || call.reason !== 'agent_answer_stored' || !call.replyArtifact || !permitted(call.replyArtifact) ||
    call.goalRevision !== answer.goalRevision || call.basePlanRevision !== answer.planRevision || call.agentTurnPromptDigest !== answer.promptDigest ||
    !sameArtifact(call.inputArtifact, answer.inputArtifact) || !permitted(answer.inputArtifact) || call.finishedAt === null ||
    call.finishedAt > answer.createdAt) failures.push('response_call_invalid');
  if (answer.assessment.type !== 'model_self_review' || answer.assessment.verdict !== 'satisfied' || answer.assessment.missing.length)
    failures.push('response_review_unresolved');
  if (state.notifications?.length || state.plan?.goalRevision === state.goal.revision && state.plan.tasks.some(task =>
    !state.attempts.some(attempt => attempt.taskId === task.id && attempt.goalRevision === state.goal.revision && attempt.scope === state.goal.scope &&
      attempt.toolId === task.toolId && attempt.toolVersion === task.toolVersion && attempt.effect === task.effect && attempt.status === 'succeeded' && attempt.adopted)))
    failures.push('response_work_unfinished');
  const visible = readable.map(record => record.id);
  if (!same([...answer.observedEvidenceIds].sort(), [...visible].sort()) ||
    new Set(answer.evidenceIds).size !== answer.evidenceIds.length || answer.evidenceIds.some(id => !visible.includes(id)) ||
    oracle.requiredEvidenceIds.some(id => !answer.evidenceIds.includes(id)) || oracle.forbiddenEvidenceIds.some(id => answer.evidenceIds.includes(id)))
    failures.push('response_citations_invalid');
  if (delivery) {
    const projected = expected.text.length <= 12000 ? expected.text :
      `${expected.text.slice(0, 11000)}\n… 일부 결과를 줄여 표시했습니다. 전체 결과 산출물: ${answer.artifact.id}`;
    if (delivery.text !== projected || !sameArtifact(delivery.context?.artifact, answer.artifact) ||
      delivery.context?.dataGeneration !== answer.dataGeneration || !same(delivery.context?.binding.session, answer.input.scope) ||
      !same([...(delivery.context?.evidenceIds ?? [])].sort(), [...answer.evidenceIds].sort())) failures.push('response_delivery_invalid');
  }
  return failures;
}
