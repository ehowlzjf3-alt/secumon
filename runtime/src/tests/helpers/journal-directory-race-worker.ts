import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { FileJournalStateRepository, JournalStateError } from '../../infrastructure/file-journal-state.js';
import { sha256 } from '../../infrastructure/digest.js';
import { advance, command, initial } from '../state-conformance-helpers.js';

const [root] = process.argv.slice(2); if (!root) throw new Error('worker_root_required');
const store = new FileJournalStateRepository(root); const first = command(initial('disappearing-work'), 'first');
await store.commit(first);
const folder = join(root, sha256(first.workId)); const parent = dirname(root); const preserved = join(parent, 'preserved-before-publication');
const firstName = '0000000000000001.json'; const secondName = '0000000000000002.json';
const record = fs.readFileSync(join(folder, firstName)); const header = fs.readFileSync(join(root, 'format.json'));
const parentIdentity = fs.lstatSync(parent, { bigint: true }); const originalSync = fs.fsyncSync;
let injected = false; let code: string | null = null;
fs.fsyncSync = fd => {
  originalSync(fd);
  const target = fs.fstatSync(fd, { bigint: true });
  if (!injected && target.isDirectory() && target.dev === parentIdentity.dev && target.ino === parentIdentity.ino) {
    injected = true; fs.renameSync(folder, preserved);
  }
};
syncBuiltinESMExports();
try { await store.commit(command(advance(first.next), 'second')); }
catch (error) { code = error instanceof JournalStateError ? error.code : 'unexpected_error'; }
finally { fs.fsyncSync = originalSync; syncBuiltinESMExports(); }
try {
  fs.writeSync(1, JSON.stringify({ injected, code, folderRecreated: fs.existsSync(folder),
    secondRecordPublished: fs.existsSync(join(folder, secondName)) || fs.existsSync(join(preserved, secondName)),
    originalPreserved: fs.existsSync(join(preserved, firstName)) && fs.readFileSync(join(preserved, firstName)).equals(record),
    headerPreserved: fs.readFileSync(join(root, 'format.json')).equals(header),
  }) + '\n');
} finally { await store.close(); }
