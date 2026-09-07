import test from 'node:test';
import assert from 'node:assert/strict';
import { posix, win32, parse } from 'node:path';
import { isJournalRecordPath, storageRootParts } from '../infrastructure/local-file-paths.js';
import { FileWorkspaceStore } from '../infrastructure/file-workspaces.js';
import { FileJournalStateRepository } from '../infrastructure/file-journal-state.js';

for (const [flavor, paths, cases] of [
  ['posix', posix, [
    ['/agent', '/', 'agent'], ['/자료 담당', '/', '자료 담당'], ['/opt/work/../agent', '/opt', 'agent'],
  ]],
  ['win32', win32, [
    ['C:\\agent', 'C:\\', 'agent'], ['C:\\자료 담당', 'C:\\', '자료 담당'], ['C:\\work\\..\\agent', 'C:\\', 'agent'],
    ['\\\\server\\share\\agent', '\\\\server\\share\\', 'agent'],
  ]],
] as const) {
  for (const [input, parent, name] of cases) test(`storage root preserves leaf at volume boundaries (${flavor}): ${input}`, () => {
    assert.deepEqual(storageRootParts(input, paths), { parent, name });
  });
}

test('storage root refuses whole filesystem, drive and UNC share roots after normalization', () => {
  for (const input of ['/', '/work/..']) assert.equal(storageRootParts(input, posix), null);
  for (const input of ['C:\\', 'C:\\work\\..', '\\\\server\\share\\', '\\\\server\\share\\work\\..']) assert.equal(storageRootParts(input, win32), null);
});

test('workspace and journal reject the host filesystem root before opening storage', () => {
  const root = parse(process.cwd()).root;
  assert.throws(() => new FileWorkspaceStore(root), /workspace_root_invalid/);
  assert.throws(() => new FileJournalStateRepository(root), /journal_root_invalid/);
});

for (const [flavor, paths, folder] of [['posix', posix, '/agent/journal'], ['win32', win32, 'C:\\agent\\journal']] as const) {
  test(`journal record accounting identifies file names using ${flavor} separators`, () => {
    assert.equal(isJournalRecordPath(paths.join(folder, '0000000000000001.json'), paths), true);
    for (const name of ['format.json', '0000000000000001.json.pending', 'x0000000000000001.json', '000000000000001.json']) {
      assert.equal(isJournalRecordPath(paths.join(folder, name), paths), false);
    }
  });
}
