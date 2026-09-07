import { adapters, openRepository, snapshot, type Adapter, type WorkerRequest } from './state-conformance-helpers.js';

const [adapter, directory] = process.argv.slice(2);
if (!directory || !adapters.includes(adapter as Adapter)) throw new Error('invalid_worker_arguments');
const repository = openRepository(adapter as Adapter, directory);
process.once('message', async (message: WorkerRequest) => {
  try {
    const result = message.operation === 'commit' ? await repository.commit(message.request) : await snapshot(repository, message.workId, message.commandIds);
    if (message.operation === 'commit' && message.crashAfterCommit) {
      process.send!({ type: 'result', result }, () => process.kill(process.pid, 'SIGKILL'));
      return;
    }
    await repository.close();
    process.send!({ type: 'result', result }, () => process.disconnect());
  } catch (error) {
    process.send!({ type: 'error', code: error instanceof Error ? error.message : 'worker_failure' }, () => {
      process.exitCode = 1; process.disconnect();
    });
  }
});
process.send!({ type: 'ready' });
