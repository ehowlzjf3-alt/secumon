import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DocumentKnowledgeRepository } from '../../infrastructure/document-knowledge.js';
import { FileMutationFault } from '../../infrastructure/host-file-mutations.js';
import { hostMetadataFiles } from '../../infrastructure/host-metadata-files.js';
import { documentNamespaceName, encodeDocumentEvent } from '../../infrastructure/document-knowledge-codec.js';
import { personalRecord, ownerScope, storageCommand } from '../personal-knowledge-storage-helpers.js';

const [mode, directory, agentId, gate] = process.argv.slice(2);
if (!mode || !directory || !agentId) throw new Error('missing_document_worker_args');
if (mode === 'orchestration-burst-exit') {
  for (const message of [{ checkpoint: 'early' }, { done: true, sequence: 2 }]) {
    await new Promise<void>((resolve, reject) => process.send!(message, (error: Error | null) => error ? reject(error) : resolve()));
  }
  process.stderr.write('synthetic_document_worker_exit_before_next_message\n');
  process.exitCode = 23; process.disconnect?.();
} else {
const originalLink = fs.linkSync, originalSync = fs.fsyncSync;
const wait = new Int32Array(new SharedArrayBuffer(4)); let linked = false, injected = false, contendSignalled = false;
const fault = Object.assign(new Error('document_directory_sync_fixture'), { code: 'EIO' });
const signal = (value: unknown) => process.send?.(value);
fs.linkSync = (source, target) => {
  const event = String(target).endsWith('00000001.md');
  if (event && mode === 'candidate') { signal({ checkpoint: 'candidate' }); Atomics.wait(wait, 0, 0); }
  if (event && mode.startsWith('contend') && !contendSignalled) {
    contendSignalled = true;
    signal({ checkpoint: 'contend' });
    while (!gate || !fs.existsSync(gate)) Atomics.wait(wait, 0, 0, 10);
  }
  const result = originalLink(source, target);
  if (event) {
    linked = true;
    if (mode === 'event') { signal({ checkpoint: 'event' }); Atomics.wait(wait, 0, 0); }
  }
  return result;
};
fs.fsyncSync = fd => {
  if (mode === 'sync-fault' && linked && !injected && fs.fstatSync(fd).isDirectory()) { injected = true; throw fault; }
  return originalSync(fd);
};
syncBuiltinESMExports();
const metadata = hostMetadataFiles(), originalRead = metadata.readStableRegularFile;
let injectedPendingLink = false;
if (mode === 'namespace-stale-pending-list') {
  const scope = { tenantId: 'tenant-a', ...ownerScope(agentId), namespace: 'personal' as const };
  const records = join(directory, documentNamespaceName(scope)); fs.mkdirSync(records, { mode: 0o700 });
  const pendingName = '.secumon-init-00000000-0000-0000-0000-000000000001.pending';
  const seed = personalRecord(agentId), command = storageCommand(seed, 'seed', ownerScope(agentId));
  fs.writeFileSync(join(records, pendingName), encodeDocumentEvent({ schemaVersion: 1, scope, sequence: 1, previous: null,
    change: { kind: 'record', expectedRevision: 0, commandId: command.commandId, commandDigest: command.commandDigest, next: seed } }), { mode: 0o600 });
  // Isolated worker: a real concurrent-publication schedule, without a product hook or forged metadata.
  metadata.readStableRegularFile = function (ref, name, policy) {
    if (name === pendingName && !injectedPendingLink) {
      originalLink(join(records, pendingName), join(records, '00000001.md')); injectedPendingLink = true;
    }
    return originalRead.call(this, ref, name, policy);
  };
}
const repository = new DocumentKnowledgeRepository(directory, { agentId, storeId: 'store' });
try {
  const record = { ...personalRecord(agentId), ...(mode === 'contend-different' ? { id: `memory-${process.pid}` } :
    mode === 'namespace-stale-pending-list' ? { id: 'second-memory' } : {}) };
  const command = storageCommand(record, mode.startsWith('contend') ? `worker-${process.pid}` : 'create', ownerScope(agentId));
  if (mode === 'sync-fault') {
    let caught: unknown;
    try { await repository.commit(command); } catch (error) { caught = error; }
    assert.ok(caught instanceof FileMutationFault);
    let original: unknown = caught;
    while (original instanceof Error && original.cause !== undefined) original = original.cause;
    assert.equal(original, fault); assert.equal(caught.status.publication, 'published');
    assert.equal(caught.status.directorySynced, false); assert.equal(caught.status.fileSynced, true); assert.equal(injected, true);
    fs.fsyncSync = originalSync; syncBuiltinESMExports();
    const receipt = await repository.receipt('tenant-a', command.next.id, 'create', ownerScope(agentId));
    assert.ok(receipt);
    assert.equal(receipt?.digest, command.commandDigest);
    assert.deepEqual(await repository.commit(command), { kind: 'duplicate', revision: 1 });
    signal({ done: true, publication: caught.status.publication, originalCause: true, receiptRevision: receipt.revision,
      files: fs.readdirSync(directory).sort() });
  } else {
    const result = await repository.commit(command); signal({ done: true, result, ...(mode === 'namespace-stale-pending-list' ? { injectedPendingLink } : {}) });
  }
} finally {
  metadata.readStableRegularFile = originalRead;
  fs.linkSync = originalLink; fs.fsyncSync = originalSync; syncBuiltinESMExports(); await repository.close();
}
process.disconnect?.();
}
