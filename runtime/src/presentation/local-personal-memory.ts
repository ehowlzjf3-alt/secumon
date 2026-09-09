import { z } from 'zod';
import type { LocalProfile } from './local-profile.js';
import { canWritePersonalMemory, type WorkActor } from '../application/work-resources.js';
import type { PersonalMemoryRef } from '../domain/knowledge.js';

const id = z.string().min(1).max(256);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1).max(10000).refine(value => value.trim().length > 0);
const reason = z.string().trim().min(1).max(1000);
export const PersonalSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('existing'), sessionId: id, messageId: id, quote: text }),
  z.strictObject({ kind: z.literal('new_input'), workId: id, messageId: id, expectedGoalRevision: revision, rawText: text }),
]);
const mutation = { requestId: id, id, title: z.string().trim().min(1).max(200), source: PersonalSourceSchema };
export const PersonalRememberSchema = z.strictObject(mutation);
export const PersonalReviseSchema = z.strictObject({ ...mutation, expectedRevision: revision, reason });
export const PersonalForgetSchema = z.strictObject({ requestId: id, id, expectedRevision: revision, reason });
export const PersonalRecallSchema = z.strictObject({ requestId: id, expectedGoalRevision: revision, expectedStateRevision: revision,
  refs: z.array(z.strictObject({ id, revision })).max(5) });
export const PersonalSearchSchema = z.string().max(1000);
export type PersonalRememberInput = z.infer<typeof PersonalRememberSchema>;
export type PersonalReviseInput = z.infer<typeof PersonalReviseSchema>;
export type PersonalForgetInput = z.infer<typeof PersonalForgetSchema>;
export type PersonalRecallInput = z.infer<typeof PersonalRecallSchema>;
function assertWritable(actor: WorkActor) { if (!canWritePersonalMemory(actor)) throw new Error('personal_memory_read_only'); }

async function sourceReference(profile: LocalProfile, actor: WorkActor, source: z.infer<typeof PersonalSourceSchema>) {
  if (source.kind === 'existing') return { sessionId: source.sessionId, messageId: source.messageId, quote: source.quote };
  if (!profile.sessions || !profile.agentId) throw new Error('personal_memory_unavailable');
  const state = await profile.runtime.state(source.workId); const scope = state.conversation?.session?.scope;
  if (!scope || scope.agentId !== profile.agentId || scope.tenantId !== actor.tenantId || scope.principalId !== actor.principalId) throw new Error('session_work_unavailable');
  await profile.sessions.input(actor, { sessionId: scope.sessionId, messageId: source.messageId, workId: source.workId,
    rawText: source.rawText, expectedGoalRevision: source.expectedGoalRevision });
  return { sessionId: scope.sessionId, messageId: source.messageId, quote: source.rawText };
}

/** Source message identity and memory command identity are separate and survive a retry. */
export async function rememberPersonal(profile: LocalProfile, actor: WorkActor, value: PersonalRememberInput) {
  const input = PersonalRememberSchema.parse(value); assertWritable(actor); const service = await profile.personalKnowledge(actor);
  const source = await sourceReference(profile, actor, input.source);
  const result = await service.remember({ id: input.id, commandId: input.requestId, title: input.title, source });
  return { card: result.card };
}
export async function revisePersonal(profile: LocalProfile, actor: WorkActor, value: PersonalReviseInput) {
  const input = PersonalReviseSchema.parse(value); assertWritable(actor); const service = await profile.personalKnowledge(actor);
  const source = await sourceReference(profile, actor, input.source);
  return service.revisePersonal({ id: input.id, commandId: input.requestId, title: input.title, source, expectedRevision: input.expectedRevision, reason: input.reason });
}
export async function forgetPersonal(profile: LocalProfile, actor: WorkActor, value: PersonalForgetInput) {
  const input = PersonalForgetSchema.parse(value); assertWritable(actor); const service = await profile.personalKnowledge(actor);
  const result = await service.forgetPersonal({ id: input.id, commandId: input.requestId, expectedRevision: input.expectedRevision, reason: input.reason });
  return { ...result, originalHistoryPreserved: true as const };
}
export async function getPersonal(profile: LocalProfile, actor: WorkActor, memoryId: string) {
  id.parse(memoryId); const result = await (await profile.personalKnowledge(actor)).get(memoryId); return { card: result.card };
}
export async function searchPersonal(profile: LocalProfile, actor: WorkActor, query: string) {
  const result = await (await profile.personalKnowledge(actor)).search({ namespace: 'personal', scope: 'personal', text: PersonalSearchSchema.parse(query), limit: 5 });
  return { cards: result.cards, index: result.index };
}
export async function recallPersonal(profile: LocalProfile, actor: WorkActor, workId: string, value: PersonalRecallInput) {
  id.parse(workId); const input = PersonalRecallSchema.parse(value);
  const service = await profile.personalKnowledge(actor);
  if (!profile.personalMemories || !profile.agentId) throw new Error('personal_memory_unavailable');
  const refs: PersonalMemoryRef[] = [];
  for (const requested of input.refs) {
    const { card } = await service.get(requested.id);
    if (card.revision !== requested.revision) throw new Error('personal_memory_revision_changed');
    if (!card.owner || card.owner.agentId !== profile.agentId || card.owner.principalId !== actor.principalId) throw new Error('personal_memory_unavailable');
    refs.push({ ...card.owner, tenantId: actor.tenantId, id: card.id, revision: card.revision });
  }
  return profile.personalMemories.select(workId, actor, { commandId: input.requestId, expectedGoalRevision: input.expectedGoalRevision,
    expectedStateRevision: input.expectedStateRevision, refs });
}
