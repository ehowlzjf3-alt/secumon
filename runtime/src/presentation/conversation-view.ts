import type { WorkActor } from '../application/work-resources.js';
import type { LocalProfile } from './local-profile.js';

export async function conversationView(profile: LocalProfile, workId: string, actor: WorkActor, conversationId: string) {
  for (let retry = 0; retry < 8; retry++) {
    const state = await profile.runtime.state(workId);
    const [messages, deliveries, snapshot] = await Promise.all([profile.services.sink.messages(actor, 'cli', conversationId), profile.services.state.deliveries(workId), profile.conversation.snapshot(workId, actor)]);
    if (snapshot.revision !== state.revision || (await profile.runtime.state(workId)).revision !== state.revision) continue;
    const latest = messages.filter(m => !['cancelled', 'paused'].includes(state.status) && m.workId === workId && m.goalRevision === state.goal.revision && m.kind !== 'ack' && deliveries.some(d => d.id === m.id && d.status === 'delivered' &&
      (d.kind === 'result' ? !['failed', 'blocked'].includes(state.status) && snapshot.resultReady && state.conversation?.result?.id === d.id : d.kind === 'question' ? d.context?.obligationIds.every(id => state.obligations.some(o => o.id === id && o.status === 'pending')) : ['failed', 'blocked'].includes(state.status)))).at(-1);
    return { snapshot, latest };
  }
  throw new Error('conversation_view_contention');
}
