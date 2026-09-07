import { createHash } from 'node:crypto';
import type { LocalProfile } from './local-profile.js';
import type { WorkActor } from '../application/work-resources.js';
import { authorizedWork } from '../application/work-resources.js';
import { asJson } from '../application/plan-validator.js';
import { MemoryDraftApplySchema, MemoryDraftCreateSchema, MemoryDraftResumeSchema, MemoryDraftOwnerSchema, MemoryDraftIntentSchema,
  type MemoryDraftApplyInput, type MemoryDraftCreateInput, type MemoryDraftResumeInput, type MemoryDraftIntent,
  type MemoryDraftOrigin, type MemoryDraftStatus } from '../application/personal-memory-draft-contracts.js';

const unavailable = () => new Error('personal_memory_draft_unavailable');
const bodyDigest = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');
const sourceId = (applyId: string) => `draft-source:${applyId}`;
const commandId = (applyId: string) => `draft-memory:${applyId}`;
const same = (profile: LocalProfile, a: unknown, b: unknown) => profile.services.digester.digest(asJson(a)) === profile.services.digester.digest(asJson(b));
function writable(actor: WorkActor) { if (actor.allowWrites === false) throw new Error('personal_memory_read_only'); }
async function retryKnowledgeContention<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) { if (attempt >= 2 || !(error instanceof Error) || error.message !== 'knowledge_contention') throw error; }
  }
}
async function access(profile: LocalProfile, actor: WorkActor) {
  if (!profile.memoryDrafts || !profile.agentId || !profile.sessions) throw unavailable();
  const service = await profile.personalKnowledge(actor);
  return { ...profile.memoryDrafts, service, sessions: profile.sessions,
    owner: MemoryDraftOwnerSchema.parse({ tenantId: actor.tenantId, agentId: profile.agentId, principalId: actor.principalId }) };
}
async function boundWork(profile: LocalProfile, actor: WorkActor, workId: string, sessionId: string) {
  const state = await authorizedWork(profile.services.state, workId, actor), scope = state.conversation?.session?.scope;
  if (!profile.agentId || !profile.sessions || !scope || scope.agentId !== profile.agentId || scope.sessionId !== sessionId ||
    scope.tenantId !== actor.tenantId || scope.principalId !== actor.principalId) throw new Error('session_work_unavailable');
  await profile.sessions.repository.get(scope);
  return { state, scope };
}
function revisionInput(intent: MemoryDraftIntent) {
  return { id: intent.origin.memoryId, commandId: intent.memoryCommandId, expectedRevision: intent.origin.baseRevision,
    title: intent.title, reason: intent.reason, source: { sessionId: intent.sessionId, messageId: intent.sourceMessageId, quote: intent.body } };
}
async function currentBase(context: Awaited<ReturnType<typeof access>>, origin: MemoryDraftOrigin) {
  const { card } = await context.service.get(origin.memoryId);
  if (card.revision !== origin.baseRevision || card.title !== origin.baseTitle || bodyDigest(card.body) !== origin.baseBodyDigest) throw new Error('knowledge_revision_conflict');
  if (card.owner?.agentId !== context.owner.agentId || card.owner.principalId !== context.owner.principalId) throw unavailable();
}
async function inputReceipt(profile: LocalProfile, actor: WorkActor, intent: MemoryDraftIntent) {
  const { scope } = await boundWork(profile, actor, intent.workId, intent.sessionId);
  const receipt = await profile.sessions!.repository.input(scope, intent.sourceMessageId);
  if (receipt) {
    const payload = { expectedGoalRevision: intent.expectedGoalRevision, command: { kind: 'input', reason: 'session_input_received' } };
    const expected = profile.services.digester.digest(asJson({ scope, text: intent.body, payload, kind: 'input', workId: intent.workId }));
    if (receipt.digest !== expected || receipt.workId !== intent.workId || receipt.kind !== 'input' || receipt.text !== intent.body ||
      !same(profile, receipt.scope, scope) || !same(profile, receipt.payload, payload)) throw new Error('personal_memory_draft_source_conflict');
  }
  return receipt;
}
async function savedOperation(profile: LocalProfile, actor: WorkActor, value: MemoryDraftResumeInput) {
  const input = MemoryDraftResumeSchema.parse(value), context = await access(profile, actor);
  const saved = await context.store.operation(context.owner, input.applyId);
  if (!saved) throw new Error('personal_memory_draft_operation_missing');
  const intent = MemoryDraftIntentSchema.parse(saved);
  if (intent.applyId !== input.applyId || intent.sessionId !== input.sessionId || intent.origin.storeId !== context.storeId ||
    !same(profile, intent.origin.owner, context.owner) || intent.sourceMessageId !== sourceId(input.applyId) || intent.memoryCommandId !== commandId(input.applyId)) throw unavailable();
  if ((intent.title === intent.origin.baseTitle && bodyDigest(intent.body) === intent.origin.baseBodyDigest) !== (intent.action === 'unchanged')) throw unavailable();
  await boundWork(profile, actor, intent.workId, intent.sessionId);
  return { context, intent };
}

/** Drafts are editable inputs; only the ordinary source-and-revision path changes personal memory. */
export async function createMemoryDraft(profile: LocalProfile, actor: WorkActor, value: MemoryDraftCreateInput) {
  const input = MemoryDraftCreateSchema.parse(value); writable(actor);
  const context = await access(profile, actor), { card } = await context.service.get(input.memoryId);
  if (card.owner?.agentId !== context.owner.agentId || card.owner.principalId !== context.owner.principalId) throw unavailable();
  const draft = await context.store.create(context.owner, { draftId: input.draftId, memoryId: card.id, baseRevision: card.revision, title: card.title, body: card.body });
  return { draftId: draft.origin.draftId, path: draft.path, baseRevision: draft.origin.baseRevision, title: draft.origin.baseTitle };
}

export async function memoryDraftStatus(profile: LocalProfile, actor: WorkActor, value: MemoryDraftResumeInput): Promise<MemoryDraftStatus> {
  const { context, intent } = await savedOperation(profile, actor, value);
  const applied = intent.action === 'revise' ? await context.service.revisePersonalStatus(revisionInput(intent)) : null;
  const source = await inputReceipt(profile, actor, intent);
  let currentRevision = applied?.currentRevision ?? null, currentStatus = applied?.currentStatus ?? null;
  if (!applied) {
    try { const { card } = await context.service.get(intent.origin.memoryId); currentRevision = card.revision; currentStatus = 'active'; }
    catch (error) { if (!(error instanceof Error) || error.message !== 'knowledge_unavailable') throw error; }
  }
  return { applyId: intent.applyId, draftId: intent.origin.draftId, memoryId: intent.origin.memoryId, workId: intent.workId,
    sessionId: intent.sessionId, baseRevision: intent.origin.baseRevision, sourceMessageId: intent.sourceMessageId,
    stage: intent.action === 'unchanged' ? 'unchanged' : applied ? 'complete' : source?.status === 'applied' ? 'memory_pending' :
      source?.status === 'rejected' ? 'source_rejected' : source?.status === 'pending' ? 'source_pending' : 'prepared',
    sourceStatus: source?.status ?? 'not_received', appliedRevision: applied?.revision ?? null, currentRevision, currentStatus,
    reason: source?.status === 'rejected' ? source.rejection : null };
}

async function executeAttempt(profile: LocalProfile, actor: WorkActor, value: MemoryDraftResumeInput): Promise<MemoryDraftStatus> {
  writable(actor);
  const { context, intent } = await savedOperation(profile, actor, value);
  if (intent.action === 'unchanged') return memoryDraftStatus(profile, actor, value);
  const input = revisionInput(intent);
  if (await context.service.revisePersonalStatus(input)) return memoryDraftStatus(profile, actor, value);
  const source = await inputReceipt(profile, actor, intent);
  if (!source) {
    try {
      const { state } = await boundWork(profile, actor, intent.workId, intent.sessionId);
      if (['completed', 'cancelled', 'failed'].includes(state.status)) throw new Error('work_terminal');
      if (state.goal.revision !== intent.expectedGoalRevision) throw new Error('stale_user_command');
      await currentBase(context, intent.origin);
    } catch (error) {
      if (!(error instanceof Error) || !['work_terminal', 'stale_user_command', 'knowledge_revision_conflict'].includes(error.message) ||
        !(await context.service.revisePersonalStatus(input))) throw error;
      return memoryDraftStatus(profile, actor, value);
    }
  }
  if (source?.status === 'rejected') throw new Error(source.rejection ?? 'session_input_rejected');
  if (source?.status !== 'applied') await context.sessions.inputOnly(actor, { sessionId: intent.sessionId, messageId: intent.sourceMessageId,
    workId: intent.workId, rawText: intent.body, expectedGoalRevision: intent.expectedGoalRevision });
  await context.service.revisePersonal(input);
  const result = await memoryDraftStatus(profile, actor, value);
  if (result.stage !== 'complete') throw new Error('personal_memory_draft_outcome_unknown');
  return result;
}

function execute(profile: LocalProfile, actor: WorkActor, value: MemoryDraftResumeInput): Promise<MemoryDraftStatus> {
  // Only a changed knowledge snapshot is retried, with the same immutable intent and IDs.
  // Publication failures and conflicts keep their original outcome for explicit recovery.
  return retryKnowledgeContention(() => executeAttempt(profile, actor, value));
}

export async function applyMemoryDraft(profile: LocalProfile, actor: WorkActor, value: MemoryDraftApplyInput): Promise<MemoryDraftStatus> {
  const input = MemoryDraftApplySchema.parse(value); writable(actor);
  const context = await access(profile, actor), draft = await context.store.read(context.owner, input.draftId);
  if (draft.origin.storeId !== context.storeId || !same(profile, draft.origin.owner, context.owner)) throw unavailable();
  const { state } = await boundWork(profile, actor, input.workId, input.sessionId);
  const prior = await context.store.operation(context.owner, input.applyId);
  if (!prior) {
    try {
      if (['completed', 'cancelled', 'failed'].includes(state.status)) throw new Error('work_terminal');
      if (state.goal.revision !== input.expectedGoalRevision) throw new Error('stale_user_command');
      await retryKnowledgeContention(() => currentBase(context, draft.origin));
    } catch (error) {
      if (!(error instanceof Error) || !['work_terminal', 'stale_user_command', 'knowledge_revision_conflict'].includes(error.message) ||
        !(await context.store.operation(context.owner, input.applyId))) throw error;
      // Another caller may have published this request while the first snapshot was empty.
      // The immutable bind below still rejects different arguments for the same apply ID.
    }
  }
  const intent = MemoryDraftIntentSchema.parse({ schemaVersion: 1, applyId: input.applyId, origin: draft.origin,
    title: draft.title, body: draft.body, reason: input.reason, sessionId: input.sessionId, workId: input.workId,
    expectedGoalRevision: input.expectedGoalRevision, sourceMessageId: sourceId(input.applyId), memoryCommandId: commandId(input.applyId),
    action: draft.title === draft.origin.baseTitle && bodyDigest(draft.body) === draft.origin.baseBodyDigest ? 'unchanged' : 'revise' });
  await context.store.bind(context.owner, intent);
  return execute(profile, actor, { applyId: input.applyId, sessionId: input.sessionId });
}

export async function resumeMemoryDraft(profile: LocalProfile, actor: WorkActor, value: MemoryDraftResumeInput): Promise<MemoryDraftStatus> {
  return execute(profile, actor, MemoryDraftResumeSchema.parse(value));
}
