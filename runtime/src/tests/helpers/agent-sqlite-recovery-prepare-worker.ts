import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { FileAgentProfileStore } from '../../infrastructure/file-agent-profile.js';
import { prepareAgentSqliteRecovery } from '../../infrastructure/agent-sqlite-recovery.js';

export type PrepareCopyPhase = 'original' | 'candidate';
const [engine, root, registry, operationId, phase, attemptText] = process.argv.slice(2);
assert.ok(process.platform !== 'win32' && process.send && engine && root && registry && operationId);
assert.ok(phase === 'original' || phase === 'candidate');
assert.ok(attemptText && /^[1-4]$/.test(attemptText));
const attempt = Number(attemptText), profiles = new FileAgentProfileStore(engine), profile = profiles.inspect(root);
assert.equal(profile.status, 'ready'); assert.ok(profile.status === 'ready');
const target = join(profile.paths.metadata, 'sqlite-recovery', operationId,
  `${phase}-${String(attempt).padStart(4, '0')}`, basename(profile.paths.state));
assert.equal(fs.existsSync(target), false);
const originalOpen = fs.openSync, originalWrite = fs.writeSync;
const wait = new Int32Array(new SharedArrayBuffer(4)); let targetFd: number | undefined, entered = 0;
fs.openSync = (path, flags, mode) => {
  const fd = originalOpen(path, flags, mode);
  if (path === target) {
    assert.equal(targetFd, undefined);
    assert.ok(typeof flags === 'number' && (flags & fs.constants.O_EXCL) !== 0); targetFd = fd;
  }
  return fd;
};
Reflect.set(fs, 'writeSync', ((...args: unknown[]) => {
  const written = Reflect.apply(originalWrite, fs, args) as number;
  if (targetFd !== undefined && args[0] === targetFd) {
    assert.equal(++entered, 1); assert.ok(written > 0);
    const bytes = fs.fstatSync(targetFd).size;
    process.send!({ type: 'prepare-copy', phase, attempt, operationId, target, pid: process.pid, written, bytes });
    // Hold inside the real first copy write, before journal copy, receipts, or a candidate SQLite worker.
    Atomics.wait(wait, 0, 0, 20000);
    throw new Error('sqlite_recovery_prepare_parent_did_not_stop');
  }
  return written;
}) as typeof fs.writeSync);
syncBuiltinESMExports();
try {
  await prepareAgentSqliteRecovery(profiles, root, { operationId, kind: 'state', offline: true },
    { identityRegistryDirectory: registry });
  throw new Error('sqlite_recovery_prepare_copy_not_reached');
} finally {
  fs.openSync = originalOpen; fs.writeSync = originalWrite; syncBuiltinESMExports();
}
