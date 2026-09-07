import { FileJournalStateRepository, type JournalStage } from '../infrastructure/file-journal-state.js';
import type { CommitRequest } from '../application/ports.js';

const [directory, requestedStage] = process.argv.slice(2);
const stages: JournalStage[] = ['candidate_synced', 'published', 'directory_synced'];
if (!directory || !stages.includes(requestedStage as JournalStage)) throw new Error('invalid_journal_worker_arguments');
const repository = new FileJournalStateRepository(directory, {
  onCommitStage(stage) {
    if (stage !== requestedStage) return;
    return new Promise<void>(() => {
      process.send!({ type: 'stage', stage }, () => process.kill(process.pid, 'SIGKILL'));
    });
  },
});
process.once('message', async (request: CommitRequest) => {
  try {
    await repository.commit(request);
    process.send!({ type: 'error', code: 'crash_stage_not_reached' }, () => { process.exitCode = 1; process.disconnect(); });
  } catch (error) {
    process.send!({ type: 'error', code: error instanceof Error ? error.message : 'worker_failure' }, () => { process.exitCode = 1; process.disconnect(); });
  }
});
process.send!({ type: 'ready' });
