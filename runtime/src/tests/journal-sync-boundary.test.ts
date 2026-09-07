import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('./helpers/journal-sync-boundary-worker.js', import.meta.url));
async function run(scenario: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'journal-sync-')));
  const parent = join(base, 'public-parent'); mkdirSync(parent, { mode: 0o755 }); chmodSync(parent, 0o755);
  try { return JSON.parse((await execute(process.execPath, [worker, parent, scenario], { timeout: 20000 })).stdout); }
  finally { rmSync(base, { recursive: true, force: true }); }
}

test('journal sync: public-parent initialization and read/commit fences retain directory order and attempt accounting', async () => {
  const result = await run('order');
  assert.equal(result.parentMode, 0o755);
  assert.deepEqual(result.steps, [
    { operation: 'constructor', directories: ['root', 'parent'], attempts: 2 },
    { operation: 'missing-read', directories: ['root', 'parent'], attempts: 2 },
    { operation: 'first-commit', directories: ['root', 'parent', 'work', 'root', 'parent'], attempts: 5 },
    { operation: 'existing-read', directories: ['work', 'root', 'parent'], attempts: 3 },
    { operation: 'duplicate-commit', directories: ['work', 'root', 'parent'], attempts: 3 },
  ]);
  assert.deepEqual(result.outcomes, [null, 'committed', true, 'duplicate']);
  assert.equal(result.openDescriptors, 0); assert.equal(result.opens, result.closes);
});

for (const scenario of ['open-error', 'fsync-error'] as const) {
  test(`journal sync: ${scenario} retains the original error and counts only an actual fsync attempt`, async () => {
    const result = await run(scenario);
    assert.equal(result.injected, true); assert.equal(result.code, 'EIO'); assert.equal(result.originalError, true);
    assert.equal(result.attempts, scenario === 'open-error' ? 0 : 1);
    assert.deepEqual(result.directories, scenario === 'open-error' ? [] : ['work']);
    assert.equal(result.headerPreserved, true); assert.equal(result.recordPreserved, true);
    assert.equal(result.openDescriptors, 0); assert.equal(result.opens, result.closes);
    assert.equal(result.recovered, true);
  });
}

for (const location of ['work', 'root', 'parent'] as const) {
  test(`journal sync: ${location} replacement between path inspection and directory open is rejected before its fsync`, async () => {
    const result = await run(`replace-on-open-${location}`);
    const prior = location === 'work' ? [] : location === 'root' ? ['work'] : ['work', 'root'];
    assert.equal(result.injected, true); assert.equal(result.code, 'journal_directory_changed');
    assert.deepEqual(result.directories, prior); assert.equal(result.attempts, prior.length);
    assert.equal(result.headerPreserved, true); assert.equal(result.recordPreserved, true); assert.equal(result.originalBytesPreserved, true);
    if (location === 'parent') { assert.equal(result.rootIdentityPreserved, true); assert.equal(result.workIdentityPreserved, true); }
    assert.equal(result.openDescriptors, 0); assert.equal(result.opens, result.closes);
  });
}

test('journal sync: a parent replacement after fsync remains a counted attempt and fails the final identity check', async () => {
  const result = await run('replace-after-sync-parent');
  assert.equal(result.injected, true); assert.equal(result.code, 'journal_directory_changed');
  assert.deepEqual(result.directories, ['work', 'root', 'parent']); assert.equal(result.attempts, 3);
  assert.equal(result.headerPreserved, true); assert.equal(result.recordPreserved, true); assert.equal(result.originalBytesPreserved, true);
  assert.equal(result.rootIdentityPreserved, true); assert.equal(result.workIdentityPreserved, true);
  assert.equal(result.openDescriptors, 0); assert.equal(result.opens, result.closes);
});

test('journal sync: a published commit with fsync EIO retains its cause, record and exactly one receipt on retry', async () => {
  const result = await run('post-publish-fsync-error');
  assert.equal(result.injected, true); assert.equal(result.code, 'journal_commit_unknown'); assert.equal(result.originalCause, true);
  assert.deepEqual(result.stages, ['candidate_synced', 'published']);
  assert.deepEqual(result.directories, ['work', 'root', 'parent', 'work']); assert.equal(result.attempts, 4);
  assert.equal(result.headerPreserved, true); assert.equal(result.recordPreserved, true);
  assert.equal(result.publishedRecordPreserved, true); assert.equal(result.receiptConfirmed, true);
  assert.equal(result.retryKind, 'duplicate'); assert.equal(result.eventCount, 2); assert.equal(result.recordCount, 2);
  assert.equal(result.openDescriptors, 0); assert.equal(result.opens, result.closes);
});
