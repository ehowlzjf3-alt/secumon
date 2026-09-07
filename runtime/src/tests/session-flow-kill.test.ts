import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { actor, request, initialize, open } from './session-flow-helpers.js';

for (const backend of ['sqlite', 'file-journal'] as const) for (const phase of ['inbox', 'work', 'delivery']) test(`${backend}: real SIGKILL after ${phase} resumes the same input/work/delivery`, { timeout: 30000 }, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'session-kill-'))); mkdirSync(join(base, 'engine'), { mode: 0o700 }); initialize(base, backend);
  const child = fork(new URL('./helpers/session-flow-worker.js', import.meta.url), [base, phase], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; child.stderr!.on('data', data => { output += data.toString(); }); child.stdout!.on('data', data => { output += data.toString(); });
  const exit = once(child, 'exit');
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`checkpoint timeout: ${output}`)), 20000);
      child.once('message', message => { clearTimeout(timer); try { assert.deepEqual(message, { checkpoint: phase }); resolve(); } catch (error) { reject(error); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`checkpoint missing: ${output}`)); });
      child.once('error', reject);
    });
    child.kill('SIGKILL'); const [code, signal] = await exit; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    const f = await open(base);
    try {
      const session = await f.sessions!.open(actor, { channel: 'test', conversationId: 'conversation' });
      const pending = await f.stores.sessions.input(session.scope, 'kill'); assert(pending);
      const result = await f.sessions!.accept(actor, { sessionId: session.scope.sessionId, rawText: 'exact original before real kill', request: request('kill') });
      assert.equal(result.workId, pending.workId); assert.equal(result.accepted, false);
      // A receipt exists even while the dead sender's lease has not expired; lookup uses that exact delivery.
      const deliveries = await f.stores.state.deliveries(result.workId);
      if (phase === 'delivery') {
        assert.equal((await f.stores.channel.lookup(deliveries[0]!)).status, 'delivered');
        f.services.clock.now = () => Date.now() + 31000; // The dead sender's lease expires without waiting in the test.
        f.stores.channel.send = async () => { throw new Error('unexpected_duplicate_send'); };
      }
      await f.outbox.flush(result.workId, actor);
      assert.equal((await f.stores.state.deliveries(result.workId))[0]!.status, 'delivered');
      const history = await f.sessions!.history(actor, session.scope.sessionId, request('kill').policy, { limit: 100 });
      assert.equal(history.entries.filter(entry => entry.role === 'user').length, 1);
      assert.equal(history.entries.filter(entry => entry.kind === 'ack').length, 1);
      assert.equal((await f.stores.state.events(result.workId, 0)).filter(event => event.type === 'request_accepted').length, 1);
      assert.equal((await f.stores.sessions.pending(session.scope, 100)).length, 0);
    } finally { await f.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
    rmSync(base, { recursive: true, force: true });
  }
});
