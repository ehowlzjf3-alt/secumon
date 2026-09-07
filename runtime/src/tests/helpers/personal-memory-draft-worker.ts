import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { FilePersonalMemoryDrafts, MemoryDraftFileError } from '../../infrastructure/personal-memory-drafts.js';
import { FileMutationFault } from '../../infrastructure/host-file-mutations.js';
import { MemoryDraftIntentSchema, MemoryDraftOwnerSchema } from '../../application/personal-memory-draft-contracts.js';

const [mode, optionsJSON, ownerJSON, intentJSON, gate] = process.argv.slice(2);
if (!mode || !optionsJSON || !ownerJSON || !intentJSON) throw new Error('missing_draft_worker_args');
const repository = new FilePersonalMemoryDrafts(JSON.parse(optionsJSON)), owner = MemoryDraftOwnerSchema.parse(JSON.parse(ownerJSON)), intent = MemoryDraftIntentSchema.parse(JSON.parse(intentJSON));
const originalLink = fs.linkSync, originalSync = fs.fsyncSync, wait = new Int32Array(new SharedArrayBuffer(4)); let linked = false, injected = false;
const fault = Object.assign(new Error('draft_directory_sync_fixture'), { code: 'EIO' });
fs.linkSync = (source, target) => {
  const matched = String(target).endsWith(`${intent.applyId}.intent.json`);
  if (matched && mode === 'candidate') { process.send?.({ checkpoint: 'candidate' }); Atomics.wait(wait, 0, 0); }
  if (matched && mode === 'contend') { process.send?.({ checkpoint: 'contend' }); while (!gate || !fs.existsSync(gate)) Atomics.wait(wait, 0, 0, 10); }
  const result = originalLink(source, target);
  if (matched) { linked = true; if (mode === 'intent') { process.send?.({ checkpoint: 'intent' }); Atomics.wait(wait, 0, 0); } }
  return result;
};
fs.fsyncSync = fd => {
  if (mode === 'sync-fault' && linked && !injected && fs.fstatSync(fd).isDirectory()) { injected = true; throw fault; }
  return originalSync(fd);
};
syncBuiltinESMExports();
try {
  if (mode === 'sync-fault') {
    let caught: unknown; try { await repository.bind(owner, intent); } catch (error) { caught = error; }
    assert.ok(caught instanceof FileMutationFault); let cause: unknown = caught;
    while (cause instanceof Error && cause.cause !== undefined) cause = cause.cause;
    assert.equal(cause, fault); assert.equal(caught.status.publication, 'published'); assert.equal(caught.status.directorySynced, false);
    assert.equal(caught.status.fileSynced, true); assert.equal(injected, true);
    fs.fsyncSync = originalSync; syncBuiltinESMExports();
    assert.deepEqual(await repository.operation(owner, intent.applyId), intent); assert.deepEqual(await repository.bind(owner, intent), intent);
    process.send?.({ done: true, publication: caught.status.publication, originalCause: true });
  } else {
    try { await repository.bind(owner, intent); process.send?.({ result: 'bound' }); }
    catch (error) { if (mode !== 'contend' || !(error instanceof MemoryDraftFileError)) throw error; process.send?.({ result: error.code }); }
  }
} finally { fs.linkSync = originalLink; fs.fsyncSync = originalSync; syncBuiltinESMExports(); }
process.disconnect?.();
