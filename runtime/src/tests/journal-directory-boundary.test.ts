import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { FileJournalStateRepository, JournalStateError } from '../infrastructure/file-journal-state.js';
import { sha256 } from '../infrastructure/digest.js';
import { command, initial } from './state-conformance-helpers.js';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('./helpers/journal-directory-boundary-worker.js', import.meta.url));
const disappearanceWorker = fileURLToPath(new URL('./helpers/journal-directory-race-worker.js', import.meta.url));
const firstRecord = '0000000000000001.json';
const unavailable = (error: unknown) => error instanceof JournalStateError && error.code === 'journal_directory_unavailable';
const changed = (error: unknown) => error instanceof JournalStateError && error.code === 'journal_directory_changed';
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'journal-directory-')));
  const root = join(base, 'journal'); const store = new FileJournalStateRepository(root);
  return { base, root, store, close: async () => { await store.close(); rmSync(base, { recursive: true, force: true }); } };
}

test('journal directories: an unobserved absent work remains absent and a later external creation can be discovered', async () => {
  const f = fixture(); let writer: FileJournalStateRepository | undefined;
  try {
    const state = initial('created-later'); const folder = join(f.root, sha256(state.id));
    assert.equal(await f.store.get(state.id), null); assert.equal(existsSync(folder), false);
    assert.equal(f.store.metrics().observedDirectories, 0);
    writer = new FileJournalStateRepository(f.root); assert.equal((await writer.commit(command(state, 'later'))).kind, 'committed');
    assert.deepEqual(await f.store.get(state.id), state); assert.equal(f.store.metrics().observedDirectories, 1);
  } finally { await writer?.close(); await f.close(); }
});

test('journal directories: deletion of an observed empty folder cannot be mistaken for an unobserved absent work', async () => {
  const f = fixture(); try {
    const state = initial('empty-but-observed'); const folder = join(f.root, sha256(state.id));
    mkdirSync(folder, { mode: 0o700 }); assert.equal(await f.store.get(state.id), null);
    assert.equal(f.store.metrics().observedDirectories, 1); const header = readFileSync(join(f.root, 'format.json'));
    rmdirSync(folder);
    await assert.rejects(f.store.get(state.id), unavailable);
    await assert.rejects(f.store.commit(command(state, 'must-not-recreate')), unavailable);
    assert.equal(existsSync(folder), false); assert.deepEqual(readFileSync(join(f.root, 'format.json')), header);
  } finally { await f.close(); }
});

for (const mutation of ['replacement', 'deletion'] as const) {
  test(`journal directories: a limited listing observes unread work folders and rejects later ${mutation}`, async () => {
    const f = fixture(); let reader: FileJournalStateRepository | undefined;
    try {
      const states = [initial('listed-alpha'), initial('listed-beta')].sort((a, b) => sha256(a.id).localeCompare(sha256(b.id)));
      for (const state of states) assert.equal((await f.store.commit(command(state, `accept-${state.id}`))).kind, 'committed');
      reader = new FileJournalStateRepository(f.root);
      const query = { tenantId: 'tenant-a', principalId: 'person-a', channel: 'test', conversationId: 'unbound', limit: 1 };
      const page = await reader.conversationWorkPage(query);
      assert.deepEqual(page.workIds, []); assert.ok(page.nextCursor);
      assert.equal(reader.metrics().observedDirectories, 2); assert.equal(reader.metrics().inspectedWorks, 1);
      const unread = states[1]!; const folder = join(f.root, sha256(unread.id)); const preserved = join(f.base, 'preserved-unread-work');
      const record = readFileSync(join(folder, firstRecord)); const header = readFileSync(join(f.root, 'format.json'));
      renameSync(folder, preserved);
      if (mutation === 'replacement') {
        mkdirSync(folder, { mode: 0o700 }); writeFileSync(join(folder, firstRecord), record, { mode: 0o600 });
      }
      const rejected = mutation === 'replacement' ? changed : unavailable;
      await assert.rejects(reader.conversationWorkPage(query), rejected);
      await assert.rejects(reader.get(unread.id), rejected);
      assert.deepEqual(readFileSync(join(preserved, firstRecord)), record); assert.deepEqual(readFileSync(join(f.root, 'format.json')), header);
      if (mutation === 'replacement') assert.deepEqual(readFileSync(join(folder, firstRecord)), record);
      else assert.equal(existsSync(folder), false);
    } finally { await reader?.close(); await f.close(); }
  });
}

test('journal directories: root inspection I/O failures preserve the original cause and never acknowledge or alter stored work', async () => {
  const f = fixture(); try {
    const result = JSON.parse((await execute(process.execPath, [worker, f.root], { timeout: 15000 })).stdout);
    assert.deepEqual(result.operations, ['get', 'commit', 'open']);
    assert.deepEqual(result.codes, ['journal_directory_unavailable', 'journal_directory_unavailable', 'journal_directory_unavailable']);
    assert.deepEqual(result.originalCauses, [true, true, true]); assert.equal(result.injections, 3);
    assert.equal(result.bytesPreserved, true); assert.equal(result.recovered, true);
  } finally { await f.close(); }
});

test('journal directories: disappearance after replay does not recreate the observed folder before publication', async () => {
  const f = fixture(); try {
    const result = JSON.parse((await execute(process.execPath, [disappearanceWorker, f.root], { timeout: 15000 })).stdout);
    assert.equal(result.injected, true); assert.equal(result.code, 'journal_directory_unavailable');
    assert.equal(result.folderRecreated, false); assert.equal(result.secondRecordPublished, false);
    assert.equal(result.originalPreserved, true); assert.equal(result.headerPreserved, true);
  } finally { await f.close(); }
});
