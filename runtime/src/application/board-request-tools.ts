import { z } from 'zod';
import { markCollaborationTool } from './collaboration-tool-identity.js';
import type { BoardActor } from '../domain/board.js';
import type { ToolResult, WorkState } from '../domain/model.js';
import { dataGeneration, visibleArtifact } from '../domain/data-lifecycle.js';
import type { BoardActorProvider, BoardRepository } from './board-ports.js';
import type { BoardWorkSources } from './board-work-sources.js';
import { BoardActorSchema, BoardRequestPageSchema, BoardRequestQuerySchema } from './board-contracts.js';
import { BoardService } from './board-service.js';
import type { Tool } from './ports.js';
import type { RuntimeServices } from './services.js';
import { asJson, taskDigest } from './plan-validator.js';
import { transact } from './work-transactions.js';
import type { InputAuthority } from './knowledge-ports.js';
import { retainedInputDependencies } from './input-validity.js';
import { retainedKnowledgeDependencies } from './knowledge-validity.js';

export const BOARD_REQUEST_READ_TOOL = 'core.board.requests.read';
const id = z.string().min(1).max(160), count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const InputSchema = z.strictObject({ boardId: id, requestId: id.optional(), cursor: z.strictObject({ revision: count.positive(), afterRequestId: id }).optional(),
  maxRequests: count.min(1).max(20), maxBytes: count.min(1024).max(32768) });
const ProofSchema = z.strictObject({ schemaVersion: z.literal(1), workId: id, attemptId: id, boundary: z.string(), actorStamp: z.string(),
  query: BoardRequestQuerySchema, page: BoardRequestPageSchema });
type Dependencies = { services: RuntimeServices; repository: BoardRepository; actors: BoardActorProvider; authority: InputAuthority; workSources?: BoardWorkSources | undefined };
const unavailable = () => new Error('board_request_unavailable');
const names = (values: string[]) => [...new Set(values)].sort();

/** Metadata snapshots are recorded once. Normal request advancement does not rewrite a prior observation. */
export function createBoardRequestTool(deps: Dependencies): Tool {
  const digest = (value: unknown) => deps.services.digester.digest(asJson(value));
  const boundary = (state: WorkState) => digest({ workId: state.id, generation: dataGeneration(state), scope: state.goal.scope, policy: state.policy });
  const stamp = ({ canManageBoards: _manage, ...actor }: BoardActor) => digest({ ...actor, allowedLabels: names(actor.allowedLabels),
    allowedScopes: names(actor.allowedScopes), allowedNamespaces: names(actor.allowedNamespaces) });
  const scoped = async (state: WorkState) => {
    const actor = BoardActorSchema.parse(await deps.actors.current());
    const raw = await deps.authority.resolve({ tenantId: state.policy.tenantId, principalId: state.policy.principalId });
    if (!raw) throw unavailable();
    const trusted = BoardActorSchema.parse({ ...raw, canManageBoards: false });
    if (actor.tenantId !== state.policy.tenantId || actor.principalId !== state.policy.principalId || !actor.allowedScopes.includes(state.goal.scope)) throw unavailable();
    if (trusted.tenantId !== actor.tenantId || trusted.principalId !== actor.principalId || !trusted.allowedScopes.includes(state.goal.scope)) throw unavailable();
    return { ...actor, allowedScopes: names(actor.allowedScopes.filter(scope => trusted.allowedScopes.includes(scope))), allowedLabels: names(actor.allowedLabels.filter(label => state.policy.allowedLabels.includes(label) && trusted.allowedLabels.includes(label))),
      allowedNamespaces: names(actor.allowedNamespaces.filter(value => trusted.allowedNamespaces.includes(value))), canPublish: actor.canPublish && trusted.canPublish, canReview: actor.canReview && trusted.canReview };
  };
  const service = (actor: BoardActor) => new BoardService({ ...deps, actors: { current: async () => structuredClone(actor) } });
  const descriptor = async (state: WorkState, attemptId: string) => {
    const dispatch = await deps.services.state.receipt(state.id, `dispatch:${attemptId}`);
    const attempt = state.attempts.find(value => value.id === attemptId), original = dispatch?.state.attempts.find(value => value.id === attemptId);
    const task = dispatch?.state.plan?.tasks.find(value => value.id === attempt?.taskId);
    if (!attempt || !original || !task || !dispatch || original.status !== 'running' || attempt.effect !== 'read' || task.effect !== 'read' ||
      attempt.toolId !== BOARD_REQUEST_READ_TOOL || task.toolId !== BOARD_REQUEST_READ_TOOL || attempt.toolVersion !== '1' || task.toolVersion !== '1' ||
      attempt.inputDigest !== taskDigest(task, deps.services.digester) || original.inputDigest !== attempt.inputDigest ||
      original.contractDigest !== attempt.contractDigest || attempt.contractDigest !== digest(tool.definition) ||
      boundary(dispatch.state) !== boundary(state) || attempt.scope !== dispatch.state.goal.scope || attempt.goalRevision !== dispatch.state.goal.revision ||
      !state.policy.allowedTools.includes(BOARD_REQUEST_READ_TOOL)) throw unavailable();
    return { attempt, task, dispatch: dispatch.state, query: { ...InputSchema.parse(task.input), workId: state.id } };
  };
  const data = (proof: z.infer<typeof ProofSchema>, artifact: ToolResult['artifacts'][number]) => asJson({ workId: proof.workId, attemptId: proof.attemptId,
    boundary: proof.boundary, artifact, proofDigest: digest(proof) });
  const tool: Tool = {
    definition: { provider: 'core', id: BOARD_REQUEST_READ_TOOL, version: '1', effect: 'read', destination: 'local', labels: [], resultValidation: 'artifact-proof-v1',
      description: 'Observe a bounded page of requests for this role, or one request by ID. Includes the observed board revision for later commands. Status is historical; read the referenced posts for content.',
      inputSchema: asJson(z.toJSONSchema(InputSchema, { target: 'draft-7' })), outputSchema: { type: ['object', 'null'] } },
    async execute(task, context): Promise<ToolResult> {
      const base = { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, effectState: 'none' as const, evidence: [], artifacts: [], cursor: null };
      try {
        const state = await deps.services.state.get(context.workId); if (!state || context.signal.aborted || digest(context.policy) !== digest(state.policy)) throw unavailable();
        const checked = await descriptor(state, context.attemptId);
        if (digest(task) !== digest(checked.task)) throw unavailable();
        const actor = await scoped(state), page = await service(actor).requestPage(checked.query);
        const proof = ProofSchema.parse({ schemaVersion: 1, workId: state.id, attemptId: context.attemptId,
          boundary: boundary(state), actorStamp: stamp(actor), query: checked.query, page });
        const bytes = new TextEncoder().encode(JSON.stringify(proof)); if (bytes.byteLength > 65536) throw unavailable();
        const artifact = await deps.services.artifacts.put(bytes, { tenantId: state.policy.tenantId, labels: [...state.policy.allowedLabels], mediaType: 'application/json' });
        const guard = async () => {
          await context.authorize?.();
          const latest = await deps.services.state.get(state.id); if (!latest || context.signal.aborted || latest.goal.revision !== state.goal.revision ||
            boundary(latest) !== proof.boundary || stamp(await scoped(latest)) !== proof.actorStamp) throw unavailable();
          const active = latest.attempts.find(value => value.id === context.attemptId);
          if (!active || active.status !== 'running' || active.leaseUntil <= deps.services.clock.now() || latest.deadlineAt <= deps.services.clock.now() ||
            ['paused', 'cancelled', 'failed', 'completed'].includes(latest.status) ||
            !(await service(await scoped(latest)).requestMetadataPermitted(proof.query.boardId, latest.id, page.requests.map(value => value.id)))) throw unavailable();
          if ((await deps.repository.get(state.policy.tenantId, proof.query.boardId))?.revision !== page.revision) throw unavailable();
          if (context.signal.aborted) throw unavailable();
        };
        await guard();
        await transact(deps.services, state.id, `board-observe:${context.attemptId}`, 'board_request_observed', data(proof, artifact), next => {
          if (next.goal.revision !== state.goal.revision || boundary(next) !== proof.boundary) throw unavailable();
          if (!next.artifacts.some(value => value.id === artifact.id)) next.artifacts.push(artifact);
        }, guard);
        const result: ToolResult = { ...base, status: page.nextCursor ? 'partial' : 'success', coverage: page.nextCursor ? 'partial' : 'complete',
          error: null, output: asJson(page), artifacts: [artifact] };
        const latest = await deps.services.state.get(state.id);
        if (!latest || context.signal.aborted || !(await tool.validateResult!(latest, result))) throw unavailable();
        return result;
      } catch { return { ...base, status: context.signal.aborted ? 'cancelled' : 'error', coverage: 'unknown', output: null,
        error: { code: 'board_request_unavailable', retryable: false } }; }
    },
    async validateResult(state, result) {
      try {
        if (result.resultId !== `${result.attemptId}:result` || result.effectState !== 'none' || result.effectReceipt || result.evidence.length ||
          result.cursor !== null || result.reuse || result.collection) return false;
        if (!['success', 'partial'].includes(result.status)) return ['error', 'cancelled'].includes(result.status) && result.artifacts.length === 0 &&
          result.output === null && result.coverage === 'unknown' && result.error?.code === 'board_request_unavailable';
        if (result.error !== null || result.artifacts.length !== 1) return false;
        const artifact = result.artifacts[0]!; if (!visibleArtifact(state, artifact) || artifact.byteLength > 65536) return false;
        const checked = await descriptor(state, result.attemptId), actor = await scoped(state);
        const inheritedInputs = new Set(retainedInputDependencies(checked.dispatch).map(digest));
        const inheritedKnowledge = new Set(retainedKnowledgeDependencies(checked.dispatch).map(digest));
        if (result.inputDependencies?.some(value => !inheritedInputs.has(digest(value))) ||
          result.knowledgeDependencies?.some(value => !inheritedKnowledge.has(digest(value)))) return false;
        const bytes = await deps.services.artifacts.get(artifact, state.policy); if (bytes.byteLength !== artifact.byteLength) return false;
        const proof = ProofSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        const receipt = await deps.services.state.receipt(state.id, `board-observe:${result.attemptId}`);
        if (!receipt || receipt.digest !== digest({ type: 'board_request_observed', data: data(proof, artifact) }) ||
          !receipt.state.artifacts.some(value => digest(value) === digest(artifact)) || proof.workId !== state.id || proof.attemptId !== result.attemptId ||
          proof.boundary !== boundary(state) || proof.actorStamp !== stamp(actor) || digest(proof.query) !== digest(checked.query) ||
          proof.page.boardId !== proof.query.boardId || proof.page.observedAt < checked.attempt.startedAt || proof.page.observedAt > deps.services.clock.now() ||
          digest(result.output) !== digest(proof.page) || result.status !== (proof.page.nextCursor ? 'partial' : 'success') ||
          result.coverage !== (proof.page.nextCursor ? 'partial' : 'complete')) return false;
        if (!(await service(actor).requestMetadataPermitted(proof.query.boardId, state.id, proof.page.requests.map(value => value.id)))) return false;
        const latest = await deps.services.state.get(state.id);
        return !!latest && boundary(latest) === proof.boundary && stamp(await scoped(latest)) === proof.actorStamp;
      } catch { return false; }
    },
  };
  return markCollaborationTool(tool, 'board-requests');
}
