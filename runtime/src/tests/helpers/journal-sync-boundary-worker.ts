import fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { FileJournalStateRepository, JournalStateError } from '../../infrastructure/file-journal-state.js';
import { sha256 } from '../../infrastructure/digest.js';
import { advance, command, initial } from '../state-conformance-helpers.js';

const [parentInput, scenario] = process.argv.slice(2);
if (!parentInput || !scenario) throw new Error('worker_arguments_required');
const parent = parentInput;
const root = join(parent, 'journal'); const workId = 'sync-work'; const work = join(root, sha256(workId));
const headerPath = join(root, 'format.json'); const firstPath = join(work, '0000000000000001.json'); const secondPath = join(work, '0000000000000002.json');
const original = { open: fs.openSync, close: fs.closeSync, sync: fs.fsyncSync, fstat: fs.fstatSync, rename: fs.renameSync,
  mkdir: fs.mkdirSync, read: fs.readFileSync, write: fs.writeFileSync };
const labels = new Map([[parent, 'parent'], [root, 'root'], [work, 'work']]);
const descriptors = new Map<number, string>(); let opens = 0; let closes = 0;
const directories: string[] = []; let armed = false; let injected = false; let collectStages = false;
const stages: string[] = []; const failure = Object.assign(new Error('injected_journal_sync_failure'), { code: 'EIO' });
let preservedHeader = headerPath; let preservedRecord = firstPath;

function replace(location: string) {
  if (location === 'work') {
    const saved = join(dirname(parent), 'saved-work'); original.rename(work, saved); original.mkdir(work, { mode: 0o700 });
    preservedRecord = join(saved, basename(firstPath)); original.write(firstPath, original.read(preservedRecord), { mode: 0o600 });
  } else if (location === 'root') {
    const saved = join(dirname(parent), 'saved-root'); original.rename(root, saved); original.mkdir(root, { mode: 0o700 });
    preservedHeader = join(saved, 'format.json'); original.write(headerPath, original.read(preservedHeader), { mode: 0o600 });
    original.rename(join(saved, sha256(workId)), work);
  } else if (location === 'parent') {
    const saved = join(dirname(parent), 'saved-parent'); original.rename(parent, saved); original.mkdir(parent, { mode: 0o755 });
    // Keep the exact root/work objects so the parent identity is the only replaced directory.
    original.rename(join(saved, 'journal'), root);
  } else throw new Error('unknown_replacement_location');
}

Reflect.set(fs, 'openSync', ((...args: unknown[]) => {
  const path = String(args[0]); const flags = args[1];
  const label = typeof flags === 'number' && (flags & fs.constants.O_DIRECTORY) !== 0 ? labels.get(path) : undefined;
  if (armed && !injected && label) {
    if (scenario === 'open-error' && label === 'work') { injected = true; throw failure; }
    if (scenario === `replace-on-open-${label}`) { injected = true; replace(label); }
  }
  const fd = Reflect.apply(original.open, fs, args) as number;
  if (label) { descriptors.set(fd, label); opens += 1; }
  return fd;
}) as typeof fs.openSync);
fs.closeSync = fd => { original.close(fd); if (descriptors.delete(fd)) closes += 1; };
fs.fsyncSync = fd => {
  const label = descriptors.get(fd);
  if (label) {
    if (!original.fstat(fd).isDirectory()) throw new Error('tracked_descriptor_is_not_directory');
    directories.push(label);
    if (armed && !injected && label === 'work' && ['fsync-error', 'post-publish-fsync-error'].includes(scenario)) {
      injected = true; throw failure;
    }
  }
  original.sync(fd);
  if (armed && !injected && scenario === 'replace-after-sync-parent' && label === 'parent') { injected = true; replace('parent'); }
};
syncBuiltinESMExports();

let store: FileJournalStateRepository | undefined;
let result: Record<string, unknown> = {};
try {
  store = new FileJournalStateRepository(root, { onCommitStage: stage => {
    if (collectStages) {
      stages.push(stage);
      if (scenario === 'post-publish-fsync-error' && stage === 'published') armed = true;
    }
  } });
  const first = command(initial(workId), 'first');
  if (scenario === 'order') {
    const steps: Array<{ operation: string; directories: string[]; attempts: number }> = [
      { operation: 'constructor', directories: [...directories], attempts: store.metrics().directorySyncs },
    ];
    const outcomes: unknown[] = [];
    async function observe(operation: string, action: () => Promise<unknown>) {
      const offset = directories.length; const before = store!.metrics().directorySyncs; const value = await action();
      steps.push({ operation, directories: directories.slice(offset), attempts: store!.metrics().directorySyncs - before }); return value;
    }
    outcomes.push(await observe('missing-read', () => store!.get('not-created')));
    const committed = await observe('first-commit', () => store!.commit(first)) as { kind: string }; outcomes.push(committed.kind);
    outcomes.push(isDeepStrictEqual(await observe('existing-read', () => store!.get(workId)), first.next));
    const duplicate = await observe('duplicate-commit', () => store!.commit(first)) as { kind: string }; outcomes.push(duplicate.kind);
    result = { steps, outcomes };
  } else {
    await store.commit(first);
    const header = original.read(headerPath); const record = original.read(firstPath);
    const rootIdentity = fs.lstatSync(root, { bigint: true }); const workIdentity = fs.lstatSync(work, { bigint: true });
    const second = command(advance(first.next), 'second');
    directories.length = 0; const before = store.metrics().directorySyncs; let error: unknown;
    collectStages = scenario === 'post-publish-fsync-error'; armed = !collectStages;
    try { if (collectStages) await store.commit(second); else await store.get(workId); }
    catch (caught) { error = caught; }
    armed = false; collectStages = false;
    const currentRoot = fs.lstatSync(root, { bigint: true }); const currentWork = fs.lstatSync(work, { bigint: true });
    result = {
      injected, code: error instanceof JournalStateError ? error.code : (error as NodeJS.ErrnoException | undefined)?.code ?? null,
      originalError: error === failure, originalCause: error instanceof Error && error.cause === failure,
      attempts: store.metrics().directorySyncs - before, directories: [...directories], stages: [...stages],
      headerPreserved: original.read(headerPath).equals(header), recordPreserved: original.read(firstPath).equals(record),
      originalBytesPreserved: original.read(preservedHeader).equals(header) && original.read(preservedRecord).equals(record),
      rootIdentityPreserved: rootIdentity.dev === currentRoot.dev && rootIdentity.ino === currentRoot.ino,
      workIdentityPreserved: workIdentity.dev === currentWork.dev && workIdentity.ino === currentWork.ino,
    };
    if (scenario === 'open-error' || scenario === 'fsync-error') result.recovered = isDeepStrictEqual(await store.get(workId), first.next);
    if (scenario === 'post-publish-fsync-error') {
      const published = original.read(secondPath);
      result.receiptConfirmed = isDeepStrictEqual(await store.receipt(workId, second.commandId), { digest: second.commandDigest, state: second.next });
      result.retryKind = (await store.commit(second)).kind;
      result.eventCount = (await store.events(workId, 0)).length;
      result.recordCount = fs.readdirSync(work).filter(name => /^\d{16}\.json$/.test(name)).length;
      result.publishedRecordPreserved = original.read(secondPath).equals(published);
    }
  }
} finally {
  Reflect.set(fs, 'openSync', original.open); fs.closeSync = original.close; fs.fsyncSync = original.sync;
  syncBuiltinESMExports(); await store?.close();
}
fs.writeSync(1, JSON.stringify({ ...result, parentMode: fs.lstatSync(parent).mode & 0o777, openDescriptors: descriptors.size, opens, closes }) + '\n');
