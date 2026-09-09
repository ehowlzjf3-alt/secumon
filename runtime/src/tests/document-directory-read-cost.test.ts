import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DocumentFiles } from '../infrastructure/document-knowledge-owner.js';
import { DocumentKnowledgeRepository, registerDocumentKnowledgeStore } from '../infrastructure/document-knowledge.js';
import { documentNamespaceName } from '../infrastructure/document-knowledge-codec.js';
import type { MetadataFileMetrics } from '../infrastructure/host-metadata-files.js';
import { storageFixture, ownerScope, personalRecord, storageCommand } from './personal-knowledge-storage-helpers.js';

test('document directory reuse reduces traversal while retaining exact reads, root access and same-path custody',
  { skip: process.platform === 'win32' ? 'This mode-change and directory-rename acceptance uses POSIX filesystem semantics.' : false }, async t => {
    const f = storageFixture(), directory = join(f.directory, 'memory', 'documents');
    const binding = { agentId: f.agentId, storeId: 'directory-read-cost', root: f.directory }, scope = ownerScope(f.agentId);
    let files: DocumentFiles | undefined;
    try {
      chmodSync(f.directory, 0o755); registerDocumentKnowledgeStore(directory, binding);
      const repository = new DocumentKnowledgeRepository(directory, binding), record = personalRecord(f.agentId);
      try { await repository.commit(storageCommand(record, 'original', scope)); }
      finally { await repository.close(); }
      const records = join(directory, documentNamespaceName({ tenantId: 'tenant-a', ...scope, namespace: 'personal' }));
      const original = readFileSync(join(records, '00000001.md'));
      files = new DocumentFiles(directory, binding);
      let traversals = 0;
      const directoryRef = files.scope.directory.bind(files.scope);
      t.mock.method(files.scope, 'directory', (...args: Parameters<typeof directoryRef>) => { traversals++; return directoryRef(...args); });
      const measuredRead = () => {
        const before = files!.files.diagnostics(), beforeTraversals = traversals;
        const ref = files!.directoryRef(records); assert.ok(ref);
        const names = files!.names(records, ref), bytes = files!.read(records, ref, '00000001.md', names);
        const after = files!.files.diagnostics();
        const metrics = Object.fromEntries((Object.keys(after) as (keyof MetadataFileMetrics)[]).map(key => [key, after[key] - before[key]])) as unknown as MetadataFileMetrics;
        return { bytes, metrics, traversals: traversals - beforeTraversals };
      };
      const cold = measuredRead(), warm = measuredRead();
      assert.deepEqual(cold.bytes, original); assert.deepEqual(warm.bytes, original);
      assert.ok(cold.traversals > 0); assert.equal(warm.traversals, 0);
      assert.ok(warm.metrics.directoryChecks < cold.metrics.directoryChecks);
      for (const key of ['fileStats', 'fileOpens', 'fileCloses', 'dataReads', 'dataBytes'] as const)
        assert.equal(warm.metrics[key], cold.metrics[key], key);
      assert.ok(warm.metrics.dataReads > 0); assert.equal(warm.metrics.dataBytes, original.byteLength);

      assert.ok(files.directoryRef(f.directory)); assert.ok(files.directoryRef(f.directory));
      assert.equal(statSync(f.directory).mode & 0o777, 0o755, 'the supplied root retains owner-writable access');
      const beforeCreate = traversals; assert.ok(files.directoryRef(records, true));
      assert.ok(traversals > beforeCreate, 'creation keeps the ordinary publication and durability path');
      const missing = join(directory, 'uncreated'); assert.equal(files.directoryRef(missing), null);
      mkdirSync(missing, { mode: 0o700 }); assert.ok(files.directoryRef(missing), 'absence is not retained');

      chmodSync(records, 0o755);
      assert.throws(() => files!.directoryRef(records), /metadata_directory_unsafe/);
      chmodSync(records, 0o700); assert.ok(files.directoryRef(records));
      const preserved = records + '.preserved'; renameSync(records, preserved); mkdirSync(records, { mode: 0o700 });
      writeFileSync(join(records, '00000001.md'), original, { mode: 0o600 });
      assert.throws(() => files!.directoryRef(records), /metadata_directory_changed/);
      assert.throws(() => files!.directoryRef(records), /metadata_directory_changed/, 'a failed cached identity is not replaced automatically');
      assert.deepEqual(readFileSync(join(preserved, '00000001.md')), original);
      assert.deepEqual(readFileSync(join(records, '00000001.md')), original);
      files.close(); assert.throws(() => files!.directoryRef(records), /metadata_directory_invalid_request/);
      t.diagnostic(JSON.stringify({ cold: cold.metrics, warm: warm.metrics, coldTraversals: cold.traversals, warmTraversals: warm.traversals,
        measurement: 'Actual POSIX metadata counters for identical original reads; separate from HTTP timing and native Windows acceptance.' }));
    } finally { files?.close(); f.close(); }
  });
