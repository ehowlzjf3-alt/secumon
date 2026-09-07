import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { FileWorkspaceStore } from '../infrastructure/file-workspaces.js';
import { WorkspaceError } from '../application/workspace-checkpoints.js';
import { sha256 } from '../infrastructure/digest.js';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('./helpers/workspace-directory-lock-worker.js', import.meta.url));
const attributes = { tenantId: 'tenant-a', labels: ['synthetic'], lifecycleGeneration: 0 };
const bytes = Buffer.from('original workspace bytes');
const workspaceFault = (code: string) => (error: unknown) => error instanceof WorkspaceError && error.code === code;
async function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-directory-lock-')));
  const root = join(base, 'workspace'); const work = join(root, sha256('work')); const attempt = join(work, sha256('attempt')); const files = join(attempt, 'files');
  const store = new FileWorkspaceStore(root); await store.stage('work', 'attempt', 'original.txt', bytes, attributes);
  return { base, root, work, attempt, files, store, lock: join(attempt, '.lock'), record: join(files, `${sha256('original.txt')}.json`),
    close: async () => { await store.close(); rmSync(base, { recursive: true, force: true }); } };
}

for (const location of ['root', 'work', 'attempt', 'files'] as const) {
  test(`workspace directories: a removed observed ${location} is not recreated by listing or staging`, async () => {
    const f = await fixture(); try {
      const target = f[location]; const saved = join(f.base, 'preserved'); const record = readFileSync(f.record); const recordWithin = relative(target, f.record);
      renameSync(target, saved);
      await assert.rejects(f.store.list('work', 'attempt'), (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT');
      await assert.rejects(f.store.stage('work', 'attempt', 'new.txt', Buffer.from('new'), attributes), (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT');
      assert.equal(existsSync(target), false); assert.deepEqual(readFileSync(join(saved, recordWithin)), record);
      assert.equal(existsSync(f.lock), false);
    } finally { await f.close(); }
  });
}

for (const location of ['work', 'attempt', 'files'] as const) {
  test(`workspace directories: an observed ${location} replacement is rejected without altering foreign contents`, async () => {
    const f = await fixture(); try {
      const target = f[location]; const saved = join(f.base, 'preserved'); const record = readFileSync(f.record); const recordWithin = relative(target, f.record);
      renameSync(target, saved); mkdirSync(target, { mode: 0o700 }); writeFileSync(join(target, 'foreign.txt'), 'foreign bytes', { mode: 0o600 });
      await assert.rejects(f.store.list('work', 'attempt'), workspaceFault('workspace_directory_changed'));
      assert.equal(readFileSync(join(target, 'foreign.txt'), 'utf8'), 'foreign bytes');
      assert.deepEqual(readFileSync(join(saved, recordWithin)), record); assert.equal(existsSync(f.lock), false);
    } finally { await f.close(); }
  });
}

test('workspace directories: private access remains enforced independently at each observed scope', async () => {
  for (const location of ['root', 'work', 'attempt', 'files'] as const) {
    const f = await fixture(); try {
      const record = readFileSync(f.record); chmodSync(f[location], 0o770);
      await assert.rejects(f.store.list('work', 'attempt'), workspaceFault('workspace_directory_unsafe'));
      assert.equal(lstatSync(f[location]).mode & 0o777, 0o770); assert.deepEqual(readFileSync(f.record), record);
    } finally { await f.close(); }
  }
});

test('workspace directories: a descendant symlink is rejected without traversing the preserved original', async () => {
  const f = await fixture(); try {
    const saved = join(f.base, 'original-work'); const record = readFileSync(f.record); const inside = relative(f.work, f.record);
    renameSync(f.work, saved); symlinkSync(saved, f.work);
    await assert.rejects(f.store.list('work', 'attempt'), workspaceFault('workspace_directory_unsafe'));
    assert.equal(lstatSync(f.work).isSymbolicLink(), true); assert.deepEqual(readFileSync(join(saved, inside)), record);
  } finally { await f.close(); }
});

async function runWorker(scenario: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-lock-worker-')));
  try { return JSON.parse((await execute(process.execPath, [worker, base, scenario], { timeout: 20000 })).stdout); }
  finally { rmSync(base, { recursive: true, force: true }); }
}

test('workspace locks: consecutive successful calls accept distinct lock objects and release every acquired lock', async () => {
  const result = await runWorker('repeat');
  assert.equal(result.success, true); assert.equal(result.acquisitions, 3); assert.equal(result.distinctIdentities, 3);
  assert.equal(result.lockRemains, false); assert.equal(result.retainedDescriptors, 0);
});

for (const [scenario, expected] of [
  ['lock-removed', 'workspace_lock_lost'],
  ['lock-replaced', 'workspace_directory_changed'],
  ['lock-unsafe', 'workspace_directory_unsafe'],
  ['attempt-replaced', 'workspace_directory_changed'],
] as const) {
  test(`workspace locks: ${scenario} after acquisition prevents success and never deletes an unowned lock`, async () => {
    const result = await runWorker(scenario);
    assert.equal(result.injected, true); assert.equal(result.success, false); assert.equal(result.code, expected);
    if (scenario === 'lock-removed') assert.equal(result.lockRemains, false);
    else {
      assert.equal(result.lockRemains, true); assert.equal(result.currentLockPreserved, true);
      if (scenario === 'lock-unsafe') assert.equal(result.lockMode, 0o770);
      else { assert.equal(result.currentLockIsForeign, true); assert.equal(result.originalLockRemains, true); }
    }
    assert.equal(result.retainedDescriptors, 0);
  });
}

test('workspace directories: files replacement or disappearance after the final parent sync still prevents success', async () => {
  for (const scenario of ['files-replaced-after-sync', 'files-removed-after-sync']) {
    const result = await runWorker(scenario);
    assert.equal(result.injected, true); assert.equal(result.success, false);
    assert.equal(result.code, scenario === 'files-replaced-after-sync' ? 'workspace_directory_changed' : 'ENOENT');
    assert.equal(result.originalFilesRemain, true); assert.equal(result.lockRemains, false);
    assert.equal(result.filesRemain, scenario === 'files-replaced-after-sync');
    if (scenario === 'files-replaced-after-sync') assert.equal(result.currentFilesPreserved, true);
    assert.equal(result.retainedDescriptors, 0);
  }
});

test('workspace directories: changes during the final cleanup sync prevent success without removing a later owner lock', async () => {
  for (const scenario of ['files-replaced-after-cleanup-sync', 'files-removed-after-cleanup-sync']) {
    const result = await runWorker(scenario);
    assert.equal(result.injected, true); assert.equal(result.success, false);
    assert.equal(result.code, scenario === 'files-replaced-after-cleanup-sync' ? 'workspace_directory_changed' : 'ENOENT');
    assert.equal(result.originalFilesRemain, true); assert.equal(result.filesRemain, scenario === 'files-replaced-after-cleanup-sync');
    if (scenario === 'files-replaced-after-cleanup-sync') assert.equal(result.currentFilesPreserved, true);
    assert.equal(result.lockRemains, true); assert.equal(result.currentLockPreserved, true); assert.equal(result.currentLockIsForeign, true);
    assert.equal(result.retainedDescriptors, 0);
  }
});

test('workspace locks: acquisition inspection failure preserves the unconfirmed lock and vanished new files fail before use', async () => {
  const inspection = await runWorker('initial-lock-inspect-error');
  assert.equal(inspection.injected, true); assert.equal(inspection.success, false); assert.equal(inspection.code, 'EIO');
  assert.equal(inspection.originalInspectionError, true); assert.equal(inspection.lockRemains, true);
  assert.equal(inspection.unconfirmedLockPreserved, true); assert.equal(inspection.lockRemovalAttempts, 0);
  const vanished = await runWorker('files-disappeared-after-create');
  assert.equal(vanished.injected, true); assert.equal(vanished.success, false); assert.equal(vanished.code, 'ENOENT');
  assert.equal(vanished.filesRemain, false); assert.equal(vanished.lockRemains, false); assert.equal(vanished.lockRemovalAttempts, 1);
});
