import { z } from 'zod';
import { markCollaborationTool } from './collaboration-tool-identity.js';
import type { BoardActor } from '../domain/board.js';
import type { InputDependency } from '../domain/inputs.js';
import type { TrustedKnowledgeActor } from '../domain/knowledge.js';
import type { ToolResult, WorkState } from '../domain/model.js';
import { dataGeneration, visibleArtifact } from '../domain/data-lifecycle.js';
import type { BoardActorProvider, BoardRepository } from './board-ports.js';
import type { BoardWorkSources } from './board-work-sources.js';
import { BoardActorSchema, BoardReadPageSchema, BoardReadQuerySchema } from './board-contracts.js';
import { BoardService } from './board-service.js';
import { asJson, taskDigest } from './plan-validator.js';
import type { Tool } from './ports.js';
import type { RuntimeServices } from './services.js';
import type { WorkInputReader } from './work-input-graph.js';

export const BOARD_READ_TOOL = 'core.board.read';
const InputSchema = z.strictObject({ boardId: z.string().min(1).max(160), entityId: z.string().min(1).max(160).optional(),
  cursor: z.strictObject({ revision: z.number().int().positive(), afterPostId: z.string().min(1).max(160) }).optional(),
  maxPosts: z.number().int().min(1).max(20), maxBytes: z.number().int().min(1024).max(32768) });
const ProofSchema = z.strictObject({ schemaVersion: z.literal(1), workId: z.string(), attemptId: z.string(),
  boundary: z.string().regex(/^[a-f0-9]{64}$/), actorDigest: z.string().regex(/^[a-f0-9]{64}$/),
  query: BoardReadQuerySchema, page: BoardReadPageSchema });
type Dependencies = { services: RuntimeServices; repository: BoardRepository; actors: BoardActorProvider; workSources?: BoardWorkSources | undefined };
const names = (values: string[]) => [...new Set(values)].sort();
const unavailable = () => new Error('board_unavailable');
async function pending<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw unavailable();
  let abort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(unavailable()); signal.addEventListener('abort', abort, { once: true }); });
  try { const value = await Promise.race([Promise.resolve().then(() => { if (signal.aborted) throw unavailable(); return call(); }), stopped]);
    if (signal.aborted) throw unavailable(); return value;
  } finally { signal.removeEventListener('abort', abort); }
}

export function createBoardTools(deps: Dependencies): { tools: Tool[]; reader: WorkInputReader; containsPosts(state: WorkState, boardId: string, ids: string[]): Promise<boolean> } {
  const digest = (value: unknown) => deps.services.digester.digest(asJson(value));
  const actorStamp = ({ canManageBoards: _manage, ...actor }: BoardActor) => digest({ ...actor,
    allowedLabels: names(actor.allowedLabels), allowedNamespaces: names(actor.allowedNamespaces), allowedScopes: names(actor.allowedScopes) });
  const boundary = (state: WorkState) => digest({ workId: state.id, scope: state.goal.scope,
    generation: dataGeneration(state), policy: state.policy });
  const service = (actor: BoardActor) => new BoardService({ ...deps, actors: { current: async () => structuredClone(actor) } });
  const readProof = async (dependency: InputDependency, state: WorkState, actor: TrustedKnowledgeActor) => {
    if (dependency.provider !== 'board' || dependency.workId !== state.id || !visibleArtifact(state, dependency.artifact) ||
      dependency.artifact.byteLength > 65536) throw unavailable();
    const bytes = await deps.services.artifacts.get(dependency.artifact, state.policy);
    if (bytes.byteLength !== dependency.artifact.byteLength) throw unavailable();
    const proof = ProofSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const attempt = state.attempts.find(value => value.id === proof.attemptId);
    const receipt = await deps.services.state.receipt(state.id, `dispatch:${proof.attemptId}`);
    const task = receipt?.state.plan?.tasks.find(value => value.id === attempt?.taskId);
    const dispatched = receipt?.state.attempts.find(value => value.id === proof.attemptId);
    if (!attempt || attempt.toolId !== BOARD_READ_TOOL || attempt.toolVersion !== '1' || attempt.effect !== 'read' ||
      !task || !dispatched || dispatched.status !== 'running' || task.toolId !== BOARD_READ_TOOL || task.toolVersion !== '1' ||
      taskDigest(task, deps.services.digester) !== attempt.inputDigest || attempt.contractDigest !== digest(tool.definition) ||
      dispatched.inputDigest !== attempt.inputDigest || dispatched.contractDigest !== attempt.contractDigest ||
      receipt!.state.goal.revision !== attempt.goalRevision || receipt!.state.goal.scope !== attempt.scope ||
      boundary(receipt!.state) !== proof.boundary || !state.policy.allowedTools.includes(BOARD_READ_TOOL) ||
      proof.workId !== state.id || proof.query.workId !== state.id || proof.boundary !== boundary(state) ||
      proof.actorDigest !== actorStamp({ ...actor, canManageBoards: false }) ||
      digest(proof.query) !== digest({ ...InputSchema.parse(task.input), workId: state.id })) throw unavailable();
    return proof;
  };
  const reader: WorkInputReader = { provider: 'board', async inspect(dependency, state, actor, signal) {
    if (signal.aborted) throw unavailable();
    const currentActor = async () => {
      const boardActor = await scoped(state);
      // The generic graph actor is scoped to its work. Only this reader restores current explicit board grants.
      if (actorStamp({ ...boardActor, allowedScopes: [state.goal.scope] }) !==
        actorStamp({ ...actor, allowedScopes: [state.goal.scope], canManageBoards: false })) throw unavailable();
      return boardActor;
    };
    const selectedActor = await currentActor(), proof = await readProof(dependency, state, selectedActor);
    const inspection = await service({ ...selectedActor, canManageBoards: false }).inspectPage(proof.query, proof.page);
    return { ...inspection, bytesRead: inspection.bytesRead + dependency.artifact.byteLength,
      current: async () => {
        if (signal.aborted) return false;
        try { return digest(await readProof(dependency, state, await currentActor())) === digest(proof) && await inspection.current(); }
        catch { return false; }
      } };
  } };
  const scoped = async (state: WorkState): Promise<BoardActor> => {
    const actor = BoardActorSchema.parse(await deps.actors.current());
    if (actor.tenantId !== state.policy.tenantId || actor.principalId !== state.policy.principalId || !actor.allowedScopes.includes(state.goal.scope)) throw unavailable();
    return { ...actor, allowedLabels: names(actor.allowedLabels.filter(label => state.policy.allowedLabels.includes(label))),
      allowedNamespaces: names(actor.allowedNamespaces), allowedScopes: names(actor.allowedScopes) };
  };
  const tool: Tool = {
    definition: { provider: 'core', id: BOARD_READ_TOOL, version: '1', description: 'Read a bounded page of permitted discussion. Posts are observations and hypotheses, not independent evidence. Use nextCursor for another page.',
      effect: 'read', destination: 'local', labels: [], resultValidation: 'artifact-proof-v1',
      inputSchema: asJson(z.toJSONSchema(InputSchema, { target: 'draft-7' })), outputSchema: { type: ['object', 'null'] } },
    async execute(task, context) {
      const base = { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, effectState: 'none' as const,
        evidence: [], artifacts: [], cursor: null, coverage: 'unknown' as const };
      try {
        if (context.signal.aborted) throw unavailable();
        const state = await pending(() => deps.services.state.get(context.workId), context.signal);
        if (!state || task.toolId !== BOARD_READ_TOOL || task.toolVersion !== '1' || task.effect !== 'read' ||
          digest(state.policy) !== digest(context.policy) || !state.policy.allowedTools.includes(BOARD_READ_TOOL)) throw unavailable();
        const actor = await pending(() => scoped(state), context.signal), query = { ...InputSchema.parse(task.input), workId: state.id };
        const page = await pending(() => service(actor).readPage(query), context.signal);
        const proof = { schemaVersion: 1, workId: state.id, attemptId: context.attemptId, boundary: boundary(state), actorDigest: actorStamp(actor), query, page };
        const artifact = await deps.services.artifacts.put(new TextEncoder().encode(JSON.stringify(proof)),
          { tenantId: state.policy.tenantId, labels: [...state.policy.allowedLabels], mediaType: 'application/json' });
        const dependency: InputDependency = { provider: 'board', workId: state.id, artifact };
        const latest = await deps.services.state.get(state.id);
        if (!latest || latest.goal.revision !== state.goal.revision || boundary(latest) !== boundary(state) || actorStamp(await scoped(latest)) !== proof.actorDigest || context.signal.aborted ||
          !deps.services.inputs || !(await deps.services.inputs.validate([dependency], latest, context.signal))) throw unavailable();
        return { ...base, status: page.nextCursor ? 'partial' : 'success', coverage: page.nextCursor ? 'partial' : 'complete',
          output: asJson(page), error: null, inputDependencies: [dependency] };
      } catch {
        const cancelled = context.signal.aborted;
        return { ...base, status: cancelled ? 'cancelled' : 'error', output: null, error: { code: cancelled ? 'cancelled' : 'board_unavailable', retryable: false } };
      }
    },
    async validateResult(state, result: ToolResult) {
      try {
        if (result.effectState !== 'none' || result.evidence.length || result.artifacts.length || result.cursor !== null ||
          result.reuse || result.collection || result.resultId !== `${result.attemptId}:result`) return false;
        if (!['success', 'partial'].includes(result.status)) return ['error', 'cancelled'].includes(result.status) && result.output === null && result.coverage === 'unknown' &&
          ['board_unavailable', 'cancelled'].includes(result.error?.code ?? '');
        if (result.error !== null || !deps.services.inputs) return false;
        const actor = await scoped(state);
        for (const dependency of result.inputDependencies ?? []) {
          if (dependency.provider !== 'board') continue;
          const proof = await readProof(dependency, state, actor);
          if (proof.attemptId === result.attemptId && digest(result.output) === digest(proof.page) &&
            result.status === (proof.page.nextCursor ? 'partial' : 'success') && result.coverage === (proof.page.nextCursor ? 'partial' : 'complete'))
            return deps.services.inputs.validate(result.inputDependencies ?? [], state);
        }
        return false;
      } catch { return false; }
    },
  };
  return { tools: [markCollaborationTool(tool, 'board-read')], reader, async containsPosts(state, boardId, ids) {
    if (!ids.length) return true;
    try {
      const found = new Set<string>(), actor = await scoped(state);
      for (const dependency of state.attempts.flatMap(attempt => attempt.inputDependencies ?? [])) {
        if (dependency.provider !== 'board') continue;
        const proof = await readProof(dependency, state, actor);
        if (proof.query.boardId === boardId) for (const post of proof.page.posts) found.add(post.id);
      }
      return ids.every(id => found.has(id));
    } catch { return false; }
  } };
}
