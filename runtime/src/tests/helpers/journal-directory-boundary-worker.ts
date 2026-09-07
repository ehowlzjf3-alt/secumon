import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { FileJournalStateRepository, JournalStateError } from '../../infrastructure/file-journal-state.js';
import { sha256 } from '../../infrastructure/digest.js';
import { command, initial } from '../state-conformance-helpers.js';

const [root] = process.argv.slice(2); if (!root) throw new Error('worker_root_required');
const store = new FileJournalStateRepository(root); const request = command(initial('io-preserved-work'), 'accept');
await store.commit(request);
const headerPath = join(root, 'format.json'); const recordPath = join(root, sha256(request.workId), '0000000000000001.json');
const header = fs.readFileSync(headerPath); const record = fs.readFileSync(recordPath);
const original = fs.lstatSync; const injected = Object.assign(new Error('injected_root_inspection_failure'), { code: 'EIO' });
let injections = 0;
Reflect.set(fs, 'lstatSync', ((...args: unknown[]) => {
  if (String(args[0]) === root) { injections += 1; throw injected; }
  return Reflect.apply(original, fs, args);
}) as typeof fs.lstatSync);
syncBuiltinESMExports();
const operations: string[] = []; const codes: Array<string | null> = []; const originalCauses: boolean[] = [];
try {
  for (const [operation, action] of [
    ['get', () => store.get(request.workId)],
    ['commit', () => store.commit(request)],
    ['open', () => new FileJournalStateRepository(root)],
  ] as const) {
    operations.push(operation);
    try { await action(); codes.push(null); originalCauses.push(false); }
    catch (error) { codes.push(error instanceof JournalStateError ? error.code : 'unexpected_error'); originalCauses.push(error instanceof Error && error.cause === injected); }
  }
} finally { Reflect.set(fs, 'lstatSync', original); syncBuiltinESMExports(); }
try {
  const recovered = isDeepStrictEqual(await store.get(request.workId), request.next);
  const bytesPreserved = fs.readFileSync(headerPath).equals(header) && fs.readFileSync(recordPath).equals(record);
  fs.writeSync(1, JSON.stringify({ operations, codes, originalCauses, injections, bytesPreserved, recovered }) + '\n');
} finally { await store.close(); }
