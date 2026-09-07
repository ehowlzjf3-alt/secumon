import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('./helpers/workspace-directory-sync-worker.js', import.meta.url));
const scenarios = ['order', 'constructor-sync-eio', 'open-eio', 'files-fsync-eio', 'cleanup-sync-eio',
  'action-only', 'action-unlock-eio', 'action-cleanup-sync-eio', 'cleanup-new-lock', 'cleanup-new-lock-sync-eio', 'unsupported-platform'] as const;

for (const scenario of scenarios) test(`workspace directory sync: isolated ${scenario} preserves order, original errors and cleanup`, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-directory-sync-'))); const parent = join(base, 'parent');
  try {
    mkdirSync(parent, { mode: 0o755 }); chmodSync(parent, 0o755);
    const result = JSON.parse((await execute(process.execPath, [worker, parent, scenario], { timeout: 15000, maxBuffer: 65536 })).stdout);
    assert.equal(result.scenario, scenario); assert.equal(result.parentMode, 0o755);
    assert.equal(result.opens, result.closes); assert.equal(result.openDescriptors, 0);

    if (scenario === 'order') {
      assert.equal(result.code, null); assert.equal(result.bytesEqual, true); assert.deepEqual(result.listedPaths, ['report.bin']);
      assert.equal(result.removed, true); assert.equal(result.lockExists, false);
      assert.deepEqual(result.steps.map((step: { operation: string }) => step.operation), ['constructor', 'stage', 'read', 'list', 'remove']);
      assert.deepEqual(result.steps[0], { operation: 'constructor', directories: ['root', 'parent'], events: ['sync:root', 'sync:parent'], fileSyncs: 0 });
      for (const step of result.steps.slice(1)) {
        assert.deepEqual(step.directories, ['files', 'attempt', 'work', 'root', 'parent', 'attempt']);
        assert.deepEqual(step.events, ['sync:files', 'sync:attempt', 'sync:work', 'sync:root', 'sync:parent', 'unlock-attempt', 'unlocked', 'sync:attempt']);
        assert.equal(step.fileSyncs, step.operation === 'stage' ? 1 : 0);
      }
    } else if (scenario === 'unsupported-platform') {
      assert.equal(result.platformEmulated, true); assert.notEqual(result.actualPlatform, 'win32');
      assert.equal(result.code, 'workspace_platform_unsupported'); assert.equal(result.workspaceError, true);
      assert.equal(result.mkdirCalls, 0); assert.equal(result.opens, 0); assert.equal(result.rootExists, false);
      assert.deepEqual(result.directorySyncs, []); assert.deepEqual(result.events, []);
    } else if (scenario === 'constructor-sync-eio') {
      assert.equal(result.injected, true); assert.equal(result.originalSyncError, true); assert.equal(result.code, 'EIO');
      assert.deepEqual(result.directorySyncs, ['root', 'parent']); assert.equal(result.rootExists, true);
      assert.equal(result.fileSyncs, 0); assert.equal(result.hasCleanupDetail, false);
    } else if (scenario === 'cleanup-new-lock' || scenario === 'cleanup-new-lock-sync-eio') {
      assert.equal(result.lockExists, true); assert.equal(result.newLockPreserved, true); assert.equal(result.newLockOwner, 'next-owner');
      assert.equal(result.persistedBytesEqual, true); assert.equal(result.fileSyncs, 1);
      assert.equal(result.operationSucceeded, scenario === 'cleanup-new-lock');
      assert.equal(result.code, scenario === 'cleanup-new-lock' ? null : 'EIO'); assert.equal(result.hasCleanupDetail, false);
      assert.equal(result.cleanupInjected, scenario === 'cleanup-new-lock-sync-eio');
      assert.equal(result.originalCleanupError, scenario === 'cleanup-new-lock-sync-eio');
      assert.deepEqual(result.directorySyncs, ['files', 'attempt', 'work', 'root', 'parent', 'attempt']);
      assert.deepEqual(result.events, ['sync:files', 'sync:attempt', 'sync:work', 'sync:root', 'sync:parent', 'unlock-attempt', 'unlocked', 'next-owner-lock', 'sync:attempt']);
    } else if (scenario === 'action-only') {
      assert.equal(result.actionInjected, true); assert.equal(result.originalActionError, true);
      assert.equal(result.code, 'workspace_layout_invalid'); assert.equal(result.message, 'workspace_layout_invalid');
      assert.equal(result.workspaceError, true); assert.equal(result.hasCleanupDetail, false); assert.equal(result.lockExists, false);
      assert.deepEqual(result.events, ['action-failure', 'unlock-attempt', 'unlocked', 'sync:attempt']);
      assert.equal(result.fileSyncs, 0);
    } else if (scenario === 'action-unlock-eio' || scenario === 'action-cleanup-sync-eio') {
      assert.equal(result.actionInjected, true); assert.equal(result.cleanupInjected, true);
      assert.equal(result.workspaceError, true); assert.equal(result.originalActionError, false);
      assert.equal(result.code, 'workspace_layout_invalid'); assert.equal(result.message, 'workspace_layout_invalid');
      assert.equal(result.originalActionCause, true); assert.equal(result.originalCleanupDetail, true);
      assert.equal(result.lockExists, scenario === 'action-unlock-eio'); assert.equal(result.fileSyncs, 0);
      assert.deepEqual(result.events, scenario === 'action-unlock-eio' ?
        ['action-failure', 'unlock-attempt', 'unlock-eio'] : ['action-failure', 'unlock-attempt', 'unlocked', 'sync:attempt']);
    } else {
      assert.equal(result.code, 'EIO'); assert.equal(result.hasCleanupDetail, false); assert.equal(result.lockExists, false);
      assert.equal(result.persistedBytesEqual, true); assert.equal(result.recovered, true); assert.equal(result.fileSyncs, 1);
      if (scenario === 'cleanup-sync-eio') {
        assert.equal(result.cleanupInjected, true); assert.equal(result.originalCleanupError, true);
        assert.deepEqual(result.events, ['sync:files', 'sync:attempt', 'sync:work', 'sync:root', 'sync:parent', 'unlock-attempt', 'unlocked', 'sync:attempt']);
      } else {
        assert.equal(result.injected, true); assert.equal(result.originalSyncError, true);
        assert.deepEqual(result.events, [scenario === 'open-eio' ? 'open-eio:files' : 'sync:files', 'unlock-attempt', 'unlocked', 'sync:attempt']);
        assert.deepEqual(result.directorySyncs, scenario === 'open-eio' ? ['attempt'] : ['files', 'attempt']);
      }
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});
