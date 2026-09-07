import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('./helpers/metadata-sync-observer-worker.js', import.meta.url));
const scenarios = ['check-failure', 'open-eio', 'opened-object-replaced', 'fsync-eio', 'success', 'after-fsync-replaced', 'observer-throws'] as const;

for (const scenario of scenarios) test(`metadata sync observer: isolated ${scenario} preserves notification, syscall and cleanup boundaries`, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'metadata-sync-observer-'))); const root = join(base, 'metadata');
  try {
    mkdirSync(root, { mode: 0o700 }); writeFileSync(join(root, 'marker.txt'), 'original', { mode: 0o600 });
    const result = JSON.parse((await execute(process.execPath, [worker, root, scenario], { timeout: 15000, maxBuffer: 65536 })).stdout);
    assert.equal(result.scenario, scenario);
    const reachedObserver = ['fsync-eio', 'success', 'after-fsync-replaced', 'observer-throws'].includes(scenario);
    const attemptedFsync = ['fsync-eio', 'success', 'after-fsync-replaced'].includes(scenario);
    const completedFsync = scenario === 'success' || scenario === 'after-fsync-replaced';
    const opened = scenario !== 'check-failure' && scenario !== 'open-eio';
    assert.equal(result.notifications, reachedObserver ? 1 : 0);
    assert.equal(result.diagnosticSyncAttempts, attemptedFsync ? 1 : 0);
    assert.equal(result.fsyncCalls, attemptedFsync ? 1 : 0);
    assert.equal(result.realFsyncCalls, completedFsync ? 1 : 0);
    assert.equal(result.completedFsyncCalls, completedFsync ? 1 : 0);
    assert.equal(result.openAttempts, scenario === 'check-failure' ? 0 : 1);
    assert.equal(result.opens, opened ? 1 : 0); assert.equal(result.closes, result.opens); assert.equal(result.openDescriptors, 0);
    assert.deepEqual(result.observerOpenDescriptors, reachedObserver ? [1] : []);

    if (scenario === 'open-eio' || scenario === 'fsync-eio') {
      assert.equal(result.code, 'io'); assert.equal(result.operation, 'sync');
      assert.equal(result.causeCode, 'EIO'); assert.equal(result.causeSyscall, scenario === 'open-eio' ? 'open' : 'fsync');
      assert.equal(result.originalIoCause, true);
    } else if (scenario === 'check-failure') {
      assert.equal(result.code, 'unsafe'); assert.equal(result.operation, 'directory'); assert.equal(result.rootMode, 0o755);
    } else if (scenario === 'opened-object-replaced' || scenario === 'after-fsync-replaced') {
      assert.equal(result.code, 'changed'); assert.equal(result.operation, scenario === 'opened-object-replaced' ? 'sync' : 'directory');
    } else if (scenario === 'observer-throws') {
      assert.equal(result.originalObserverError, true); assert.equal(result.message, 'injected_metadata_sync_observer_failure');
      assert.equal(result.code, null); assert.equal(result.causeCode, null);
    } else {
      assert.equal(result.code, null); assert.equal(result.message, null); assert.equal(result.operation, null);
    }

    const replaced = scenario === 'opened-object-replaced' || scenario === 'after-fsync-replaced';
    if (replaced) {
      assert.notEqual(result.currentIdentity, result.originalIdentity); assert.equal(result.movedIdentity, result.originalIdentity);
      assert.equal(result.rootMarker, 'replacement'); assert.equal(result.movedMarker, 'original');
    } else {
      assert.equal(result.currentIdentity, result.originalIdentity); assert.equal(result.movedIdentity, null);
      assert.equal(result.rootMarker, 'original'); assert.equal(result.movedMarker, null);
    }
    assert.deepEqual(result.openedIdentities, opened ? [scenario === 'opened-object-replaced' ? result.currentIdentity : result.originalIdentity] : []);

    const expectedEvents: Record<typeof scenario, string[]> = {
      'check-failure': ['chmod-before-check'],
      'open-eio': ['open-attempt'],
      'opened-object-replaced': ['open-attempt', 'rename-before-open', 'opened', 'closed'],
      'fsync-eio': ['open-attempt', 'opened', 'observer', 'fsync-attempt', 'closed'],
      success: ['open-attempt', 'opened', 'observer', 'fsync-attempt', 'fsync-returned', 'closed'],
      'after-fsync-replaced': ['open-attempt', 'opened', 'observer', 'fsync-attempt', 'fsync-returned', 'rename-after-fsync', 'closed'],
      'observer-throws': ['open-attempt', 'opened', 'observer', 'closed'],
    };
    assert.deepEqual(result.events, expectedEvents[scenario]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
