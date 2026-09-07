import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { adapters, openRepository, type Adapter } from './state-conformance-helpers.js';
import { LocalChannel } from '../infrastructure/local-channel.js';

type WorkerMessage = { type: 'checkpoint' | 'finished'; workId: string; stage?: string; control?: string; reason?: string; status?: string; sourceCalls?: number; resultSends?: number };
async function child(directory: string, family: string, checkpoint: string, effect = 'read', adapter: Adapter = 'sqlite') {
  const process = fork(new URL('./workflow-crash-worker.js', import.meta.url), [directory, family, checkpoint, effect, adapter], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; const messages: WorkerMessage[] = [];
  process.stderr!.on('data', chunk => { stderr += String(chunk); });
  process.on('message', message => { messages.push(message as WorkerMessage); });
  const timer = setTimeout(() => process.kill('SIGKILL'), 10000);
  try {
    const [code, signal] = await once(process, 'exit');
    if (checkpoint === 'resume') assert.equal(code, 0, stderr);
    else assert.equal(signal, 'SIGKILL', stderr);
    assert.equal(messages.length, 1, stderr);
    assert.equal(messages[0]!.type, checkpoint === 'resume' ? 'finished' : 'checkpoint');
    return messages[0]!;
  } finally { clearTimeout(timer); if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); }
}

for (const adapter of adapters) {
for (const family of ['documents-simple', 'observations-simple']) {
  for (const [checkpoint, expectedCalls] of [['before-execution', 1], ['response-before-store', 2], ['response-stored', 1], ['receiver-committed', 1]] as const) {
    test(`${adapter}/${family}: SIGKILL at ${checkpoint} resumes from reopened stores with ${expectedCalls} source call(s) and one result send`, { timeout: 15000 }, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'workflow-crash-'));
      try {
        const stopped = await child(directory, family, checkpoint, 'read', adapter); assert.equal(stopped.stage, checkpoint);
        const persisted = openRepository(adapter, directory);
        try {
          const state = (await persisted.get(stopped.workId))!; assert.notEqual(state.status, 'completed');
          if (checkpoint === 'before-execution') { assert.equal(state.attempts[0]!.status, 'reserved'); assert.equal(state.budget.used.toolCalls, 0); }
          if (checkpoint === 'response-before-store') { assert.equal(state.attempts[0]!.status, 'running'); assert.equal(state.attempts[0]!.resultArtifact, null); }
          if (checkpoint === 'response-stored') { assert.equal(state.attempts[0]!.status, 'received'); assert.ok(state.attempts[0]!.resultArtifact); assert.equal(state.attempts[0]!.adopted, false); }
          if (checkpoint === 'receiver-committed') assert.equal((await persisted.deliveries(stopped.workId)).find(d => d.kind === 'result')!.status, 'sending');
        } finally { await persisted.close(); }
        const resumed = await child(directory, family, 'resume', 'read', adapter);
        assert.equal(resumed.workId, stopped.workId); assert.equal(resumed.control, 'complete'); assert.equal(resumed.status, 'completed');
        assert.equal(resumed.sourceCalls, expectedCalls); assert.equal(resumed.resultSends, 1);
        const repeated = await child(directory, family, 'resume', 'read', adapter); assert.equal(repeated.control, 'complete');
        assert.equal(repeated.sourceCalls, expectedCalls); assert.equal(repeated.resultSends, 1);
        const channel = new LocalChannel(join(directory, 'channel.sqlite'));
        try {
          const messages = await channel.messages({ tenantId: 'synthetic', principalId: 'learner' }, 'test', 'crash-chat');
          assert.equal(messages.filter(message => message.kind === 'ack').length, 1); assert.equal(messages.filter(message => message.kind === 'result').length, 1);
        } finally { channel.close(); }
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  }
}

test(`${adapter}: SIGKILL after a synthetic write effect but before response storage preserves unknown and never repeats the write or claims completion`, { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-write-crash-'));
  try {
    const stopped = await child(directory, 'documents-simple', 'response-before-store', 'write', adapter);
    const resumed = await child(directory, 'documents-simple', 'resume', 'write', adapter);
    assert.equal(resumed.workId, stopped.workId); assert.equal(resumed.control, 'blocked'); assert.equal(resumed.reason, 'effect_unknown');
    assert.equal(resumed.sourceCalls, 1); assert.equal(resumed.resultSends, 0); assert.notEqual(resumed.status, 'completed');
    const repeated = await child(directory, 'documents-simple', 'resume', 'write', adapter);
    assert.equal(repeated.sourceCalls, 1); assert.equal(repeated.resultSends, 0); assert.equal(repeated.reason, 'effect_unknown');
    const state = openRepository(adapter, directory);
    try {
      const work = (await state.get(stopped.workId))!;
      assert.equal(work.attempts[0]!.status, 'unknown'); assert.equal(work.attempts[0]!.effectState, 'unknown');
      assert.ok(work.obligations.some(obligation => obligation.kind === 'effect_reconciliation' && obligation.status === 'pending'));
    } finally { await state.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

}
