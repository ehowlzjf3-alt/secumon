import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { FileWorkspaceStore } from '../../infrastructure/file-workspaces.js';
import { sha256 } from '../../infrastructure/digest.js';

const [root, stage] = process.argv.slice(2);
if (!root || !['lock-created', 'candidate-synced', 'file-published'].includes(stage ?? '')) throw new Error('invalid_workspace_interruption_arguments');
const workId = 'interrupted-work'; const attemptId = 'interrupted-attempt'; const path = 'report.txt';
const attempt = join(root, sha256(workId), sha256(attemptId)); const files = join(attempt, 'files');
const lock = join(attempt, '.lock'); const published = join(files, `${sha256(path)}.json`);
const store = new FileWorkspaceStore(root);
const original = { mkdir: fs.mkdirSync, open: fs.openSync, close: fs.closeSync, sync: fs.fsyncSync, link: fs.linkSync };
const opened = new Map<number, string>(); const blocked = new Int32Array(new SharedArrayBuffer(4));
function pause(): never {
  process.send!({ type: 'boundary', stage });
  Atomics.wait(blocked, 0, 0);
  throw new Error('workspace_interruption_resumed_without_termination');
}
// Only this isolated process intercepts fs calls. Each operation completes before the parent receives the kill boundary.
Reflect.set(fs, 'mkdirSync', ((...args: unknown[]) => {
  const result = Reflect.apply(original.mkdir, fs, args);
  if (stage === 'lock-created' && String(args[0]) === lock) pause();
  return result;
}) as typeof fs.mkdirSync);
Reflect.set(fs, 'openSync', ((...args: unknown[]) => {
  const fd = Reflect.apply(original.open, fs, args) as number; opened.set(fd, String(args[0])); return fd;
}) as typeof fs.openSync);
fs.closeSync = (fd: number) => { original.close(fd); opened.delete(fd); };
fs.fsyncSync = (fd: number) => {
  original.sync(fd); const path = opened.get(fd);
  if (stage === 'candidate-synced' && path && dirname(path) === files && path.endsWith('.pending')) pause();
};
fs.linkSync = (source, destination) => {
  original.link(source, destination);
  if (stage === 'file-published' && String(destination) === published) pause();
};
syncBuiltinESMExports();
process.once('message', () => {
  void (async () => {
    try {
      await store.stage(workId, attemptId, path, Buffer.from('Synthetic interruption content\n'),
        { tenantId: 'tenant-a', labels: ['synthetic'], lifecycleGeneration: 0 });
      process.exitCode = 1;
      process.send!({ type: 'unexpected-completion' }, () => process.disconnect());
    } catch (error) {
      process.exitCode = 1;
      process.send!({ type: 'unexpected-error', message: error instanceof Error ? error.message : String(error) }, () => process.disconnect());
    } finally { await store.close(); }
  })();
});
process.send!({ type: 'ready' });
