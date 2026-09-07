import type { SessionRepository } from '../../application/session-ports.js';
import { openCompact, seedCompletedXAndActiveY } from '../session-compact-flow-helpers.js';

const [base, phase] = process.argv.slice(2);
if (!base || !['reply', 'publication'].includes(phase ?? '') || !process.send) throw new Error('worker_arguments');
const f = await openCompact(base); const { session, y } = await seedCompletedXAndActiveY(f);
const call = await f.compactPlanning!.requestCompact(y.workId, { requestId: 'kill-compact', force: true, expectedGoalRevision: 1 });
if (!call) throw new Error('compact_not_prepared');
async function checkpoint() {
  await new Promise<void>((resolve, reject) => process.send!({ checkpoint: phase, workId: y.workId, callId: call!.id, scope: session.scope }, error => error ? reject(error) : resolve()));
  await new Promise<void>(() => { setInterval(() => {}, 1000); });
}
await f.compactPlanning!.execute(y.workId, call.id);
if (phase === 'reply') await checkpoint();
const publish = f.stores.sessions.publishSummary.bind(f.stores.sessions);
f.stores.sessions.publishSummary = async (...args: Parameters<SessionRepository['publishSummary']>) => {
  const result = await publish(...args); if (!result) throw new Error('compact_not_published'); await checkpoint(); return result;
};
await f.compactPlanning!.adopt(y.workId, call.id);
throw new Error('checkpoint_not_reached');
