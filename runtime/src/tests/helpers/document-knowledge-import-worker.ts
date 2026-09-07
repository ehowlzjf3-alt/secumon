import fs from 'node:fs';
import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import { documentImportFixture } from '../document-knowledge-import-helpers.js';
import { importDocumentKnowledgeSnapshot, previewDocumentKnowledgeImport } from '../../infrastructure/document-knowledge-import.js';
import { FileMutationFault } from '../../infrastructure/host-file-mutations.js';
import { FileBoundaryFault } from '../../infrastructure/host-metadata-files.js';

const [phase, directory, agentId, operationId, storeId] = process.argv.slice(2);
if (!directory || !agentId || !operationId || !storeId || !['seed', 'format', 'fault'].includes(phase ?? '')) throw new Error('missing_import_worker_args');
const original = fs.linkSync, originalSync = fs.fsyncSync, wait = new Int32Array(new SharedArrayBuffer(4));
const fault = Object.assign(new Error('import_seed_sync_fixture'), { code: 'EIO' }); let seeded = false, injected = false;
fs.linkSync = (source, target) => {
  const result = original(source, target);
  if (String(target).endsWith('00000001.md')) seeded = true;
  if (phase !== 'fault' && String(target).endsWith(phase === 'seed' ? '00000001.md' : 'format.json')) {
    // Actual publication and real filesystem state; parent kills this process before witness/format directory durability is reported.
    process.send?.({ checkpoint: phase }); Atomics.wait(wait, 0, 0);
  }
  return result;
};
fs.fsyncSync = fd => {
  if (phase === 'fault' && seeded && !injected && fs.fstatSync(fd).isDirectory()) { injected = true; throw fault; }
  return originalSync(fd);
};
syncBuiltinESMExports();
try {
  const fixture = documentImportFixture(agentId, { operationId, agentId, storeId, backupDigest: 'b'.repeat(64) });
  const preview = previewDocumentKnowledgeImport(fixture.reader, fixture.options);
  const run = () => importDocumentKnowledgeSnapshot(directory, { agentId, storeId }, fixture.reader, { ...fixture.options, expectedManifestDigest: preview.manifestDigest });
  if (phase === 'fault') {
    let caught: unknown; try { run(); } catch (error) { caught = error; }
    assert.ok(caught instanceof FileMutationFault); assert.equal(caught.stage, 'directory_sync');
    assert.ok(caught.cause instanceof FileBoundaryFault); assert.equal(caught.cause.code, 'io'); assert.equal(caught.cause.operation, 'sync');
    assert.equal(caught.cause.cause, fault); assert.equal(caught.errors[0]?.error, caught.cause); assert.equal(caught.status.publication, 'published');
    assert.equal(caught.status.fileSynced, true); assert.equal(caught.status.directorySynced, false); assert.equal(injected, true);
    fs.fsyncSync = originalSync; syncBuiltinESMExports(); assert.deepEqual(run(), preview);
    await new Promise<void>((resolve, reject) => process.send!({ done: true, originalCause: true, publication: caught.status.publication, resumed: true },
      error => error ? reject(error) : resolve()));
  } else { run(); throw new Error('missing_import_checkpoint'); }
} finally { fs.linkSync = original; fs.fsyncSync = originalSync; syncBuiltinESMExports(); process.disconnect?.(); }
