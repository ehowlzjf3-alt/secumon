import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';
import type { CommitRequest } from '../application/ports.js';

const path = process.argv[2];
if (!path) throw new Error('missing_test_database');
const store = new SqliteStateRepository(path);
process.send?.({ ready: true });
process.once('message', async (message: { operation: 'commit' | 'read'; request?: CommitRequest; workId?: string; crashAfterCommit?: boolean }) => {
  if (message.operation === 'read') {
    const state = await store.get(message.workId!);
    process.send?.({ state });
  } else {
    const result = await store.commit(message.request!);
    process.send?.({ result }, () => { if (message.crashAfterCommit) process.kill(process.pid, 'SIGKILL'); });
    if (message.crashAfterCommit) return;
  }
  await store.close();
  process.disconnect();
});
