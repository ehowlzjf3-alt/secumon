import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocumentKnowledgeRepository, registerDocumentKnowledgeStore } from '../dist/infrastructure/document-knowledge.js';
import { documentNamespaceName, encodeDocumentEvent } from '../dist/infrastructure/document-knowledge-codec.js';
import { hostMetadataFiles } from '../dist/infrastructure/host-metadata-files.js';
import { storageFixture, ownerScope, personalRecord, storageCommand } from '../dist/tests/personal-knowledge-storage-helpers.js';

assert.equal(process.version, 'v24.20.0');
const path = fileURLToPath(new URL('./C03-drafts-namespace-stale-list-probe.json', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { kind: 'single-deterministic-original-dist-namespace-stale-list-probe', status: 'running', node: process.version,
  startedAt: new Date().toISOString(), scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
  ownerModuleSha256: hash(readFileSync(fileURLToPath(new URL('../dist/infrastructure/document-knowledge-owner.js', import.meta.url)))),
  namespaceModuleSha256: hash(readFileSync(fileURLToPath(new URL('../dist/infrastructure/document-knowledge.js', import.meta.url)))),
  fixtures: 1, automaticRetries: 0, originalNASFailureCauseEstablished: false, externalCalls: false, cleanup: false };
writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
const f = storageFixture(), directory = join(f.directory, 'documents'), binding = { agentId: f.agentId, storeId: 'store' };
const metadata = hostMetadataFiles(), original = metadata.readStableRegularFile; let repository, injected = false;
try {
  registerDocumentKnowledgeStore(directory, binding);
  const scope = { tenantId: 'tenant-a', ...ownerScope(f.agentId), namespace: 'personal' };
  const records = join(directory, documentNamespaceName(scope)), pendingName = '.secumon-init-00000000-0000-0000-0000-000000000001.pending';
  mkdirSync(records, { mode: 0o700 });
  const seed = personalRecord(f.agentId), command = storageCommand(seed, 'seed', ownerScope(f.agentId));
  writeFileSync(join(records, pendingName), encodeDocumentEvent({ schemaVersion: 1, scope, sequence: 1, previous: null,
    change: { kind: 'record', expectedRevision: 0, commandId: command.commandId, commandDigest: command.commandDigest, next: seed } }), { mode: 0o600 });
  metadata.readStableRegularFile = function (ref, name, policy) {
    if (name === pendingName && !injected) { linkSync(join(records, pendingName), join(records, '00000001.md')); injected = true; }
    return original.call(this, ref, name, policy);
  };
  repository = new DocumentKnowledgeRepository(directory, binding);
  let failure;
  try { await repository.commit(storageCommand({ ...seed, id: 'second-memory' }, 'create-second', ownerScope(f.agentId))); }
  catch (error) { failure = error; report.actualError = { name: error.name, message: error.message, code: error.code, operation: error.operation, stack: error.stack }; }
  assert.equal(injected, true); assert.equal(failure?.code, 'unsafe'); assert.equal(failure?.operation, 'read');
  report.status = 'baseline_defect_reproduced'; report.injectedRealLink = true;
  report.interpretation = 'The public commit fails on a valid pending/canonical inode pair when enumeration predates the link. This establishes the namespace defect, not the missing child error from NAS #113.';
} catch (error) { report.status = 'unexpected_result'; report.error = { name: error.name, message: error.message, stack: error.stack }; }
finally {
  metadata.readStableRegularFile = original; await repository?.close(); f.close(); report.cleanup = true;
  report.finishedAt = new Date().toISOString(); writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2)); process.exitCode = report.status === 'baseline_defect_reproduced' ? 0 : 1;
}
