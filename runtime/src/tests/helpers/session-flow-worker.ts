import { actor, request, open } from '../session-flow-helpers.js';
import type { SessionRepository } from '../../application/session-ports.js';
import type { StateRepository } from '../../application/ports.js';
const [base, phase] = process.argv.slice(2);
if (!base || !phase || !process.send) throw new Error('worker_arguments');
const f = await open(base);
async function checkpoint() {
  await new Promise<void>((resolve, reject) => process.send!({ checkpoint: phase }, error => error ? reject(error) : resolve()));
  await new Promise<void>(() => { setInterval(() => {}, 1000); });
}
const session = await f.sessions!.open(actor, { channel: 'test', conversationId: 'conversation' });
if (phase === 'inbox') {
  const original = f.stores.sessions.receive.bind(f.stores.sessions);
  f.stores.sessions.receive = async (...args: Parameters<SessionRepository['receive']>) => { const result = await original(...args); await checkpoint(); return result; };
} else if (phase === 'work') {
  const original = f.stores.state.commit.bind(f.stores.state);
  f.stores.state.commit = async (...args: Parameters<StateRepository['commit']>) => { const result = await original(...args); if (args[0].commandId === 'conversation.accept') await checkpoint(); return result; };
} else if (phase === 'delivery') {
  const original = f.stores.channel.send.bind(f.stores.channel);
  f.stores.channel.send = async (...args: Parameters<typeof original>) => { const result = await original(...args); await checkpoint(); return result; };
} else throw new Error('worker_phase');
const accepted = await f.sessions!.accept(actor, { sessionId: session.scope.sessionId, rawText: 'exact original before real kill', request: request('kill') });
await f.outbox.flush(accepted.workId, actor);
throw new Error('checkpoint_not_reached');
