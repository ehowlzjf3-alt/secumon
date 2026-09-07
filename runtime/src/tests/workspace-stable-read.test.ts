import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('./helpers/workspace-stable-read-worker.js', import.meta.url));
async function run(operation: 'read' | 'list', scenario: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-stable-read-')));
  try { return JSON.parse((await execute(process.execPath, [worker, base, operation, scenario], { timeout: 20000 })).stdout); }
  finally { rmSync(base, { recursive: true, force: true }); }
}
function cleaned(result: { openDescriptors: number; opens: number; closes: number; lockRemains: boolean; bytesPreserved: boolean }) {
  assert.equal(result.openDescriptors, 0); assert.equal(result.opens, result.closes);
  assert.equal(result.lockRemains, false); assert.equal(result.bytesPreserved, true);
}

for (const operation of ['read', 'list'] as const) {
  test(`workspace stable ${operation}: one concurrent change retries once and validates the final complete record`, async () => {
    const result = await run(operation, 'change-once');
    assert.equal(result.success, true); assert.equal(result.injected, 1); assert.equal(result.opens, 2);
    assert.equal(result.returnedFinalRecord, true); assert.equal(result.code, null); cleaned(result);
  });

  test(`workspace stable ${operation}: two changing attempts fail with a file-change cause without a third read`, async () => {
    const result = await run(operation, 'change-twice');
    assert.equal(result.success, false); assert.equal(result.injected, 2); assert.equal(result.opens, 2);
    assert.equal(result.code, 'workspace_file_changed'); assert.equal(result.causeCode, 'changed'); assert.equal(result.causeOperation, 'read'); cleaned(result);
  });

  test(`workspace stable ${operation}: losing the named file after open is changed data, not an initially absent file`, async () => {
    const result = await run(operation, 'missing-during-read');
    assert.equal(result.success, false); assert.equal(result.injected, 1); assert.equal(result.opens, 1);
    assert.equal(result.code, 'workspace_file_changed'); assert.equal(result.causeCode, 'missing'); assert.equal(result.causeOperation, 'read');
    assert.equal(result.nestedCauseCode, 'ENOENT'); assert.equal(result.targetExists, false); cleaned(result);
  });

  test(`workspace stable ${operation}: replacing the containing files directory during read preserves the directory error`, async () => {
    const result = await run(operation, 'directory-replaced');
    assert.equal(result.success, false); assert.equal(result.injected, 1);
    assert.equal(result.code, 'workspace_directory_changed'); assert.equal(result.causeCode, 'changed'); assert.equal(result.causeOperation, 'directory'); cleaned(result);
  });

  test(`workspace stable ${operation}: the first open ENOENT retains the existing public error distinction`, async () => {
    const result = await run(operation, 'first-open-missing');
    assert.equal(result.success, false); assert.equal(result.injected, 1); assert.equal(result.opens, 0);
    assert.equal(result.code, operation === 'read' ? 'workspace_file_unavailable' : 'workspace_file_unsafe');
    assert.equal(result.originalCause, true); cleaned(result);
  });

  test(`workspace stable ${operation}: open access denial remains a file safety error with its original cause`, async () => {
    const result = await run(operation, 'open-access-denied');
    assert.equal(result.success, false); assert.equal(result.injected, 1); assert.equal(result.opens, 0);
    assert.equal(result.code, 'workspace_file_unsafe'); assert.equal(result.originalCause, true); cleaned(result);
  });

  for (const stage of ['read', 'fstat'] as const) {
    test(`workspace stable ${operation}: ${stage} EIO is propagated as the original I/O error and releases the lock`, async () => {
      const result = await run(operation, `${stage}-error`);
      assert.equal(result.success, false); assert.equal(result.injected, 1); assert.equal(result.opens, 1);
      assert.equal(result.code, 'EIO'); assert.equal(result.originalError, true);
      if (stage === 'fstat') assert.equal(result.reads, 0);
      cleaned(result);
    });
  }

  test(`workspace stable ${operation}: cleanup failure retains the new file-change error and both original causes`, async () => {
    const result = await run(operation, 'change-and-cleanup-error');
    assert.equal(result.success, false); assert.equal(result.injected, 2); assert.equal(result.opens, 2);
    assert.equal(result.code, 'workspace_file_changed'); assert.equal(result.causeCode, 'workspace_file_changed');
    assert.equal(result.nestedCauseCode, 'changed'); assert.equal(result.originalCleanupError, true);
    assert.equal(result.lockRemains, true); assert.equal(result.sameLock, true); assert.equal(result.bytesPreserved, true);
    assert.equal(result.openDescriptors, 0); assert.equal(result.opens, result.closes);
  });
}

test('workspace stable read: disappearance before a retry open retains the changed-file error instead of initial absence', async () => {
  const result = await run('read', 'retry-open-missing');
  assert.equal(result.success, false); assert.equal(result.injected, 2); assert.equal(result.opens, 1);
  assert.equal(result.code, 'workspace_file_changed'); assert.equal(result.causeCode, 'missing'); assert.equal(result.causeOperation, 'open');
  assert.equal(result.nestedCauseCode, 'ENOENT'); assert.equal(result.targetExists, false); cleaned(result);
});
