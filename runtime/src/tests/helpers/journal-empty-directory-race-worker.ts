import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { FileJournalStateRepository, JournalStateError } from '../../infrastructure/file-journal-state.js';
import { sha256 } from '../../infrastructure/digest.js';
import { command, initial } from '../state-conformance-helpers.js';

const [root, scenario] = process.argv.slice(2);
if (!root || !['replace-empty', 'remove-created'].includes(scenario ?? '')) throw new Error('invalid_journal_directory_race_arguments');
const workId = 'directory-race-work'; const folder = join(root, sha256(workId));
const firstRecord = join(folder, '0000000000000001.json'); const preserved = join(dirname(root), 'preserved-empty-work');
const stages: string[] = []; const store = new FileJournalStateRepository(root, { onCommitStage: stage => { stages.push(stage); } });
const header = fs.readFileSync(join(root, 'format.json'));
if (scenario === 'replace-empty') fs.mkdirSync(folder, { mode: 0o700 });
const originals = { open: fs.openSync, mkdir: fs.mkdirSync, lstat: fs.lstatSync, rename: fs.renameSync, rmdir: fs.rmdirSync };
let injections = 0; let observedDirectoriesAtBoundary: number | null = null; let writeOpensAfterBoundary = 0;
let missingAfterCreate: unknown; let replacementIdentityChanged = false;
let result: unknown = null; let failure: unknown;

// Filesystem interception is isolated to this worker; mutations use real rename, mkdir and rmdir operations.
Reflect.set(fs, 'openSync', ((...args: unknown[]) => {
  if (injections > 0 && typeof args[1] === 'number' && (args[1] & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0) {
    writeOpensAfterBoundary += 1;
  }
  try { return Reflect.apply(originals.open, fs, args); }
  catch (error) {
    if (scenario === 'replace-empty' && injections === 0 && String(args[0]) === firstRecord && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      injections += 1; observedDirectoriesAtBoundary = store.metrics().observedDirectories;
      const before = originals.lstat(folder); originals.rename(folder, preserved); originals.mkdir(folder, { mode: 0o700 });
      const after = originals.lstat(folder); replacementIdentityChanged = before.dev !== after.dev || before.ino !== after.ino;
    }
    throw error;
  }
}) as typeof fs.openSync);
Reflect.set(fs, 'mkdirSync', ((...args: unknown[]) => {
  const value = Reflect.apply(originals.mkdir, fs, args);
  if (scenario === 'remove-created' && injections === 0 && String(args[0]) === folder) {
    injections += 1; observedDirectoriesAtBoundary = store.metrics().observedDirectories; originals.rmdir(folder);
  }
  return value;
}) as typeof fs.mkdirSync);
Reflect.set(fs, 'lstatSync', ((...args: unknown[]) => {
  try { return Reflect.apply(originals.lstat, fs, args); }
  catch (error) {
    if (scenario === 'remove-created' && injections === 1 && String(args[0]) === folder && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      missingAfterCreate ??= error;
    }
    throw error;
  }
}) as typeof fs.lstatSync);
syncBuiltinESMExports();
try {
  if (scenario === 'replace-empty') result = await store.conversationWorkPage({
    tenantId: 'tenant-a', principalId: 'person-a', channel: 'test', conversationId: 'synthetic-conversation', limit: 1,
  });
  else result = await store.commit(command(initial(workId), 'must-not-publish'));
} catch (error) { failure = error; }
finally {
  Reflect.set(fs, 'openSync', originals.open); Reflect.set(fs, 'mkdirSync', originals.mkdir); Reflect.set(fs, 'lstatSync', originals.lstat);
  syncBuiltinESMExports(); await store.close();
}
const error = failure as Error & { cause?: NodeJS.ErrnoException } | undefined;
fs.writeSync(1, JSON.stringify({ scenario, injections, observedDirectoriesAtBoundary, result,
  code: failure instanceof JournalStateError ? failure.code : null, errorName: error?.name ?? null,
  message: error?.message ?? null, stack: error?.stack ?? null, causeCode: error?.cause?.code ?? null,
  originalMissingCause: missingAfterCreate !== undefined && error?.cause === missingAfterCreate,
  writeOpensAfterBoundary, stages, replacementIdentityChanged,
  headerPreserved: fs.readFileSync(join(root, 'format.json')).equals(header),
}) + '\n');
