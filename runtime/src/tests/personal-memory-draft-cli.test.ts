import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { actor, draftFixture, editDraft, edited } from './helpers/personal-memory-draft-flow.js';
import { getPersonal } from '../presentation/local-personal-memory.js';
import type { MemoryDraftStatus } from '../application/personal-memory-draft-contracts.js';

const execute = promisify(execFile), cli = fileURLToPath(new URL('../presentation/agent-cli.js', import.meta.url));
test('built CLI exports, applies and resumes one edited document with stable request identity', { timeout: 30000 }, async t => {
  const f = await draftFixture(t); await f.profile.close();
  const run = async <T>(args: string[]) => JSON.parse((await execute(process.execPath, [cli, 'work', ...args, '--directory', f.directory, '--json'],
    { timeout: 20000, maxBuffer: 2097152 })).stdout) as T;
  const draftId = randomUUID(), applyId = randomUUID();
  const draft = await run<{ draftId: string; path: string; baseRevision: number }>(['memory-draft-create', '--memory-id', 'writing-style', '--draft-id', draftId]);
  assert.equal(draft.draftId, draftId); assert.equal(draft.baseRevision, 1); editDraft(draft.path);
  const status = await run<MemoryDraftStatus>(['memory-draft-apply', f.workId, '--draft-id', draftId, '--apply-id', applyId,
    '--session', f.session.scope.sessionId, '--goal-revision', String(f.input.expectedGoalRevision), '--reason', 'CLI에서 편집 적용']);
  assert.equal(status.stage, 'complete'); assert.equal(status.appliedRevision, 2);
  unlinkSync(draft.path);
  const args = ['--apply-id', applyId, '--session', f.session.scope.sessionId];
  assert.equal((await run<MemoryDraftStatus>(['memory-draft-status', ...args])).appliedRevision, 2);
  assert.equal((await run<MemoryDraftStatus>(['memory-draft-resume', ...args])).appliedRevision, 2);
  await assert.rejects(run(['memory-draft-resume', '--apply-id', applyId]), /session_id_required/);
  await f.reopen(); assert.equal((await getPersonal(f.profile, actor, 'writing-style')).card.body, edited);
  assert.equal((await f.history()).entries.filter(e => e.role === 'user').length, 2);
});
