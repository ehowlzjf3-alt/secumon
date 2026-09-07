import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { FileJournalStateRepository } from '../infrastructure/file-journal-state.js';

const [root, agentId, stage = 'open', marker] = process.argv.slice(2);
if (!root || !agentId || !['open', 'candidate_synced', 'published', 'directory_synced'].includes(stage) || stage !== 'open' && !marker) {
  throw new Error('invalid_journal_owner_worker_arguments');
}
const directory = root; const owner = { agentId, kind: 'state' as const }; const format = join(directory, 'format.json');
const originalLink = fs.linkSync; const originalOpen = fs.openSync; const originalSync = fs.fsyncSync;
const opened = new Map<number, string>();
function killAtBoundary() {
  fs.writeFileSync(marker!, JSON.stringify({ stage, owner }), { mode: 0o600 });
  process.kill(process.pid, 'SIGKILL');
  throw new Error('journal_owner_worker_kill_failed');
}
if (stage !== 'open') {
  fs.openSync = (path, flags, mode) => { const fd = originalOpen(path, flags, mode); opened.set(fd, String(path)); return fd; };
  fs.linkSync = (source, target) => {
    if (String(target) === format && stage === 'candidate_synced') killAtBoundary();
    originalLink(source, target);
    if (String(target) === format && stage === 'published') killAtBoundary();
  };
  fs.fsyncSync = fd => {
    originalSync(fd);
    if (stage === 'directory_synced' && opened.get(fd) === directory && fs.existsSync(format)) killAtBoundary();
  };
  syncBuiltinESMExports();
}
process.once('message', () => {
  void (async () => {
    try {
      const store = new FileJournalStateRepository(directory, { owner });
      const header = JSON.parse(fs.readFileSync(format, 'utf8')); await store.close();
      process.send!({ type: 'opened', header }, () => process.disconnect());
    } catch (error) {
      process.exitCode = 1;
      process.send!({ type: 'rejected', code: error instanceof Error ? error.message : 'worker_failure' }, () => process.disconnect());
    }
  })();
});
process.send!({ type: 'ready' });
