// Diagnostic preload for one bounded target-suite run. No filesystem result is changed.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const originalLstat = fs.lstatSync;
const ring = [];
const callerUid = process.getuid?.() ?? null;
let emitted = false;

function selectedPath(input) {
  let path;
  try { path = input instanceof URL ? fileURLToPath(input) : Buffer.isBuffer(input) ? input.toString() : typeof input === 'string' ? input : null; }
  catch { return null; }
  if (path === null) return null;
  const normalized = path.replaceAll('\\', '/');
  return /\/agent-backend-binding-[^/]+\/.+\.sqlite3?(?:-(?:wal|shm|journal))?$/.test(normalized) ? path : null;
}
function append(entry) {
  ring.push(entry);
  if (ring.length > 64) ring.shift();
}
function latestIdentity(path) {
  for (let index = ring.length - 1; index >= 0; index--) {
    const entry = ring[index];
    if (entry.path === path && entry.exists) return { dev: entry.dev, ino: entry.ino };
  }
  return null;
}
function emit(reason, stack) {
  if (emitted || ring.length === 0) return;
  emitted = true;
  try {
    fs.writeSync(2, JSON.stringify({ diagnostic: 'C03-drafts-owner-cli-trace', pid: process.pid, node: process.version,
      platform: process.platform, callerUid, reason, ...(stack ? { stack } : {}), metadataTrace: ring }) + '\n');
  } catch { /* Diagnostic output cannot replace the original result or exception. */ }
}

fs.lstatSync = function (input, options) {
  const path = selectedPath(input);
  let value;
  try { value = originalLstat.call(fs, input, options); }
  catch (error) {
    if (path !== null) {
      try { append({ at: performance.now(), path, exists: false, previousIdentity: latestIdentity(path),
        error: { name: error?.name ?? null, code: error?.code ?? null, syscall: error?.syscall ?? null } }); }
      catch { /* Preserve the exact exception even if observation fails. */ }
    }
    throw error;
  }
  if (path !== null) {
    try {
      const previousIdentity = latestIdentity(path);
      if (value === undefined) append({ at: performance.now(), path, exists: false, previousIdentity });
      else {
        const dev = String(value.dev), ino = String(value.ino), regular = value.isFile(), symbolicLink = value.isSymbolicLink();
        const unsafe = !regular || symbolicLink || Number(value.nlink) !== 1 || (Number(value.mode) & 0o077) !== 0 ||
          callerUid !== null && Number(value.uid) !== callerUid;
        append({ at: performance.now(), path, exists: true, dev, ino, mode: Number(value.mode).toString(8),
          nlink: String(value.nlink), uid: String(value.uid), size: String(value.size), regular, symbolicLink,
          ...(previousIdentity && (previousIdentity.dev !== dev || previousIdentity.ino !== ino) ? { previousIdentity, identityChanged: true } : {}), unsafe });
        if (unsafe) emit('unsafe_lstat_return', new Error('observed_unsafe_sqlite_path').stack);
      }
    } catch { /* Preserve the exact Stats object if diagnostic observation fails. */ }
  }
  return value;
};
syncBuiltinESMExports();
process.once('exit', code => { if (code !== 0) emit('nonzero_exit'); });
