import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const marker = process.env['SECUMON_BACKUP_TEST_MARKER'];
if (basename(process.argv[1] ?? '') === 'personal-memory-backup-worker.js' && marker) {
  const parent = Number(process.env['SECUMON_BACKUP_TEST_PARENT']);
  if (!Number.isSafeInteger(parent) || parent <= 1 || process.ppid !== parent) throw new Error('invalid synthetic supervisor');
  writeFileSync(join(marker, 'worker-start.json'), JSON.stringify({ pid: process.pid, parent }), { mode: 0o600, flag: 'wx' });
  process.once('exit', code => writeFileSync(join(marker, 'worker-exit.json'), JSON.stringify({ pid: process.pid, code }), { mode: 0o600, flag: 'wx' }));
  const original = sqlite.backup; let observed = false;
  Reflect.set(sqlite, 'backup', ((db, path, options) => original(db, path, {
    ...options,
    // One page makes a progress observation deterministic for the small fixture. The real native backup still runs.
    rate: 1,
    progress(value) {
      options?.progress?.(value);
      if (!observed && value.remainingPages > 0) {
        observed = true;
        writeFileSync(join(marker, 'backup-in-progress.json'), JSON.stringify({ pid: process.pid, parent,
          candidatePath: String(path), remainingPages: value.remainingPages, totalPages: value.totalPages,
          configuredRate: options?.rate, observedRate: 1, sourceTransaction: db.isTransaction }), { mode: 0o600, flag: 'wx' });
        process.kill(parent, 'SIGKILL');
      }
    },
  })) as typeof sqlite.backup);
  syncBuiltinESMExports();
} else if (process.argv[2] === 'supervisor') {
  const options = JSON.parse(readFileSync(process.argv[3]!, 'utf8'));
  process.env['SECUMON_BACKUP_TEST_PARENT'] = String(process.pid);
  const { createOrResumePersonalMemoryBackup } = await import('../../infrastructure/personal-memory-backup.js');
  await createOrResumePersonalMemoryBackup(options);
  throw new Error('supervisor survived expected native progress SIGKILL');
}
