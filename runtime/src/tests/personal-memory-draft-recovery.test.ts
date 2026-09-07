import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { unlinkSync } from 'node:fs';
import { actor, draftFixture, editDraft, edited } from './helpers/personal-memory-draft-flow.js';
import { memoryDraftStatus, resumeMemoryDraft } from '../presentation/local-memory-drafts.js';
import { getPersonal } from '../presentation/local-personal-memory.js';
import type { MemoryDraftStatus } from '../application/personal-memory-draft-contracts.js';

const worker = fileURLToPath(new URL('./helpers/personal-memory-draft-apply-worker.js', import.meta.url));
for (const backend of ['sqlite', 'file-journal'] as const) for (const stage of ['intent', 'source', 'memory']) {
  test(`draft SIGKILL ${backend}/${stage}: resume uses fixed intent and the same source and memory receipts`, { timeout: 30000 }, async t => {
    const f = await draftFixture(t, backend); editDraft(f.draft.path); await f.profile.close();
    const child = fork(worker, [f.directory, JSON.stringify(f.input), stage], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let errors = ''; child.stderr!.on('data', bytes => { errors += String(bytes); });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const stopped = once(child, 'exit');
    const reached = await Promise.race([once(child, 'message').then(([message]) => message), stopped.then(() => { throw new Error(errors || 'worker_exited_before_boundary'); })]);
    assert.deepEqual(reached, { reached: stage }); child.kill('SIGKILL');
    assert.deepEqual(await stopped, [null, 'SIGKILL']);
    await f.reopen();
    const before = await memoryDraftStatus(f.profile, actor, f.resume);
    assert.equal(before.stage, stage === 'intent' ? 'prepared' : stage === 'source' ? 'memory_pending' : 'complete');
    unlinkSync(f.draft.path);
    const result = await resumeMemoryDraft(f.profile, actor, f.resume);
    assert.equal(result.stage, 'complete'); assert.equal(result.appliedRevision, 2);
    assert.equal((await getPersonal(f.profile, actor, 'writing-style')).card.body, edited);
    assert.equal((await f.history()).entries.filter(e => e.role === 'user').length, 2);
    assert.equal((await resumeMemoryDraft(f.profile, actor, f.resume)).appliedRevision, 2);
  });
}

test('two actual processes applying the same draft converge on one source and one revision', { timeout: 30000 }, async t => {
  const f = await draftFixture(t); editDraft(f.draft.path); await f.profile.close();
  const results = await Promise.all([1, 2].map(async () => {
    const child = fork(worker, [f.directory, JSON.stringify(f.input), 'run'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let errors = '', result: MemoryDraftStatus | undefined;
    child.stderr!.on('data', bytes => { errors += String(bytes); });
    child.on('message', message => { result = (message as { result: MemoryDraftStatus }).result; });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const [code] = await once(child, 'exit'); assert.equal(code, 0, errors); assert(result); return result;
  }));
  assert(results.every(result => result.appliedRevision === 2));
  await f.reopen(); assert.equal((await f.history()).entries.filter(e => e.role === 'user').length, 2);
  assert.equal((await getPersonal(f.profile, actor, 'writing-style')).card.revision, 2);
});
