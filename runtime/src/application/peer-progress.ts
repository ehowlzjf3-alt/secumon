import { z } from 'zod';
import type { TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import { visibleArtifact } from '../domain/data-lifecycle.js';
import type { Tool } from './ports.js';
import { ArtifactSchema } from './contracts.js';
import { PeerIdentitySchema, PeerRequestSchema, PeerReviewSchema } from './peer-contracts.js';
import { ModelIdentitySchema } from './model-contracts.js';

const id = z.string().min(1).max(256), count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const output = z.strictObject({ requestId: id, peerId: id, peer: PeerIdentitySchema, target: PeerRequestSchema.shape.from,
  interpretation: z.literal('peer_assessment_not_independent_evidence'), cost: z.literal('recipient_own_budget'),
  status: z.literal('answer'), reason: id, recipientWorkId: id, model: ModelIdentitySchema, observedAt: count,
  text: z.string().min(1).max(32000), review: PeerReviewSchema.nullable() });
const prose = (value: string) => value.normalize('NFC').trim().replace(/\s+/gu, ' ');

/** Classification follows native current-source and original-result validation during adoption; it performs no I/O or evidence promotion. */
export function peerProgressKeys(state: WorkState, task: TaskSpec, result: ToolResult, tool: Tool,
  key: (kind: string, value: unknown) => string): string[] {
  if (!['core.peer.consult', 'core.peer.resume'].includes(task.toolId) || tool.definition.provider !== 'core' ||
    tool.definition.destination !== 'local' || task.toolVersion !== '1' || tool.definition.resultValidation !== 'artifact-proof-v1' || !tool.validateResult ||
    result.status !== 'success' || result.coverage !== 'complete' || result.artifacts.length !== 1 || result.evidence.length ||
    result.cursor !== null || result.effectReceipt || result.collection) return [];
  const page = output.safeParse(result.output), artifact = ArtifactSchema.safeParse(result.artifacts[0]);
  if (!page.success || !artifact.success || !prose(page.data.text) || !visibleArtifact(state, artifact.data) ||
    !state.artifacts.some(ref => key('peer-proof', ref) === key('peer-proof', artifact.data))) return [];
  const value = page.data, from = value.target, session = state.conversation?.session?.scope;
  if (from.workId !== state.id || from.tenantId !== state.policy.tenantId || from.principalId !== state.policy.principalId ||
    from.goalRevision !== state.goal.revision || from.planRevision > (state.plan?.revision ?? 0) || session && from.agentId !== session.agentId) return [];
  if (task.toolId === 'core.peer.consult') {
    if (task.input.peerId !== value.peerId || !['consult', 'review'].includes(String(task.input.kind)) ||
      (task.input.kind === 'review') !== (value.review !== null) || typeof task.input.request !== 'string') return [];
    if (task.input.kind === 'review' && !state.hypotheses.some(hypothesis => hypothesis.id === task.input.targetHypothesisId)) return [];
  } else if (task.input.requestId !== value.requestId) return [];
  // Request/work/session IDs, aliases, plan revisions, model metadata and receipt times cannot mint another credit for copied text.
  if (!value.review) return [key('peer-answer', { kind: 'consult', text: prose(value.text) })];
  let decoded;
  try { decoded = PeerReviewSchema.safeParse(JSON.parse(value.text)); } catch { return []; }
  if (!decoded.success || key('peer-review', decoded.data) !== key('peer-review', value.review)) return [];
  const review = value.review;
  // Reviewer references remain claims checked by the original peer proof. Renaming their addresses is not new argument content.
  const basis = review.basis.kind === 'none' ? { kind: 'none', reason: prose(review.basis.reason) }
    : { kind: 'references', caveat: prose(review.basis.caveat) };
  return [key('peer-answer', { kind: 'review', target: prose(review.target), alternative: prose(review.alternative), basis,
    discriminatingQuestions: [...new Set(review.discriminatingQuestions.map(prose))].sort(), impact: prose(review.impact) })];
}
