import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, linkSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DocumentKnowledgeRepository, registerDocumentKnowledgeStore } from '../infrastructure/document-knowledge.js';
import { importDocumentKnowledgeSnapshot, inspectDocumentKnowledgeImport, previewDocumentKnowledgeImport } from '../infrastructure/document-knowledge-import.js';
import { documentDigest, documentNamespaceName } from '../infrastructure/document-knowledge-codec.js';
import { decodeDocumentSeed } from '../infrastructure/document-knowledge-import-codec.js';
import { documentImportFixture, migrationReader, migrationSeed } from './document-knowledge-import-helpers.js';
import { correctedRecord, ownerScope, personalActor, personalQuery, personalRecord, storageCommand, storageFixture } from './personal-knowledge-storage-helpers.js';

test('v2 seed preserves latest records, every original receipt and audit, logical head, and ordinary CAS after reopen', async () => {
  const f = storageFixture(), source = documentImportFixture(f.agentId), path = join(f.directory, 'documents');
  const binding = { agentId: f.agentId, storeId: source.options.storeId }, preview = previewDocumentKnowledgeImport(source.reader, source.options);
  let repository: DocumentKnowledgeRepository | undefined;
  try {
    assert.equal(existsSync(path), false);
    assert.deepEqual(importDocumentKnowledgeSnapshot(path, binding, source.reader, { ...source.options, expectedManifestDigest: preview.manifestDigest }), preview);
    assert.equal(inspectDocumentKnowledgeImport(path, binding, preview), 'complete');
    const namespace = join(path, documentNamespaceName(source.scope));
    assert.deepEqual(readdirSync(namespace), ['00000001.md', '00000002.md', '00000003.md']);
    const original = readFileSync(join(namespace, '00000001.md')), seeded = decodeDocumentSeed(original);
    assert.equal(seeded.change.kind, 'seed_record');
    if (seeded.change.kind !== 'seed_record') assert.fail('missing_seed');
    assert.deepEqual(seeded.change.receipts, source.seeds[0]!.receipts);
    assert.equal(original.includes(Buffer.from(source.first.body)), false);
    repository = new DocumentKnowledgeRepository(path, binding); const scope = ownerScope(f.agentId);
    assert.deepEqual(await repository.get('tenant-a', source.fourth.id, scope), source.fourth);
    assert.deepEqual(await repository.get('tenant-a', source.forgotten.id, scope), source.forgotten);
    assert.deepEqual(await repository.indexHead('tenant-a', 'personal', scope), { revision: 6, cursor: 6, error: null });
    for (const seed of source.seeds) for (const receipt of seed.receipts) {
      assert.deepEqual(await repository.receipt('tenant-a', seed.record.id, receipt.commandId, scope), { digest: receipt.digest, revision: receipt.revision });
    }
    const oldReceipt = source.seeds[0]!.receipts[0]!;
    assert.deepEqual(await repository.commit({ ...storageCommand(source.first, oldReceipt.commandId, scope), commandDigest: oldReceipt.digest }), { kind: 'duplicate', revision: 1 });
    assert.deepEqual(await repository.commit(storageCommand(source.first, 'late-command', scope)), { kind: 'conflict', actualRevision: 4 });
    const next = correctedRecord(source.fourth, '이관한 다음의 정확한 사용자 발언');
    assert.deepEqual(await repository.commit(storageCommand(next, 'new-command', scope)), { kind: 'committed', revision: 5 });
    await repository.markIndexError('tenant-a', 'personal', 'index_read_failed', scope);
    assert.deepEqual(await repository.indexHead('tenant-a', 'personal', scope), { revision: 7, cursor: 7, error: 'index_read_failed' });
    await repository.rebuildIndex('tenant-a', 'personal', scope); await repository.close(); repository = new DocumentKnowledgeRepository(path, binding);
    assert.deepEqual(await repository.indexHead('tenant-a', 'personal', scope), { revision: 7, cursor: 7, error: null });
    assert.equal(inspectDocumentKnowledgeImport(path, binding, preview), 'complete');
    assert.deepEqual(readFileSync(join(namespace, '00000001.md')), original);
    assert.deepEqual(await repository.candidates(personalActor(f.agentId), personalQuery, 10, scope), { ids: ['memory-a'], truncated: false });
  } finally { await repository?.close(); f.close(); }
});

test('import receipt is exact and idempotent while changed identity/source and an existing v1 store are refused', () => {
  const f = storageFixture(), source = documentImportFixture(f.agentId), path = join(f.directory, 'documents'), binding = { agentId: f.agentId, storeId: source.options.storeId };
  try {
    const receipt = previewDocumentKnowledgeImport(source.reader, source.options), args = { ...source.options, expectedManifestDigest: receipt.manifestDigest };
    importDocumentKnowledgeSnapshot(path, binding, source.reader, args); const manifest = readFileSync(join(path, 'import-manifest.json'));
    assert.deepEqual(importDocumentKnowledgeSnapshot(path, binding, source.reader, args), receipt);
    assert.throws(() => importDocumentKnowledgeSnapshot(path, binding, source.reader, { ...args, backupDigest: 'c'.repeat(64) }), /document_knowledge_import_conflict/);
    assert.throws(() => inspectDocumentKnowledgeImport(path, { ...binding, agentId: f.otherAgentId }, receipt), /document_knowledge_owner_mismatch/);
    assert.deepEqual(readFileSync(join(path, 'import-manifest.json')), manifest);
    const old = join(f.directory, 'v1'); registerDocumentKnowledgeStore(old, binding); const format = readFileSync(join(old, 'format.json'));
    assert.throws(() => importDocumentKnowledgeSnapshot(old, binding, source.reader, args), /document_knowledge_import_conflict/);
    assert.deepEqual(readFileSync(join(old, 'format.json')), format); assert.equal(existsSync(join(old, 'import-manifest.json')), false);
  } finally { f.close(); }
});

test('seeded namespaces remain isolated and a newly introduced scope starts with an ordinary v2 event', async () => {
  const f = storageFixture(), a = documentImportFixture(f.agentId), path = join(f.directory, 'documents'), binding = { agentId: f.agentId, storeId: a.options.storeId };
  const second = { ...a.scope, tenantId: 'tenant-b', principalId: 'user-b' }, record = personalRecord(f.agentId, 'user-b', 'tenant-b', '다른 사용자의 원문');
  const reader = migrationReader(f.agentId, [{ scope: a.scope, records: a.seeds }, { scope: second, records: [migrationSeed([record])] }]);
  const preview = previewDocumentKnowledgeImport(reader, a.options); let repository: DocumentKnowledgeRepository | undefined;
  try {
    importDocumentKnowledgeSnapshot(path, binding, reader, { ...a.options, expectedManifestDigest: preview.manifestDigest });
    repository = new DocumentKnowledgeRepository(path, binding);
    assert.equal(await repository.get('tenant-b', a.fourth.id, ownerScope(f.agentId, 'user-b')), null);
    assert.deepEqual(await repository.get('tenant-b', record.id, ownerScope(f.agentId, 'user-b')), record);
    await assert.rejects(repository.get('tenant-b', record.id, ownerScope(f.otherAgentId, 'user-b')), /knowledge_scope_mismatch/);
    const fresh = personalRecord(f.agentId, 'user-new'); await repository.commit(storageCommand(fresh, 'fresh', ownerScope(f.agentId, 'user-new')));
    const freshPath = join(path, documentNamespaceName({ ...a.scope, principalId: 'user-new' }), '00000001.md');
    assert.match(readFileSync(freshPath, 'utf8'), /^<!-- secumon-memory-v2/);
    assert.equal(inspectDocumentKnowledgeImport(path, binding, preview), 'complete');
  } finally { await repository?.close(); f.close(); }
});

test('preview rejects unsupported receipts, discontinuous audit, head mismatch and oversize seed before target creation', () => {
  const f = storageFixture(), source = documentImportFixture(f.agentId);
  try {
    for (const mutation of [
      (seed: typeof source.seeds[number]) => { seed.receipts[1]!.revision = 1; },
      (seed: typeof source.seeds[number]) => { seed.receipts[1]!.digest = 'legacy-unbounded'; },
      (seed: typeof source.seeds[number]) => { seed.receipts[1]!.auditJson = '{"revision":2}'; },
      (seed: typeof source.seeds[number]) => { const audit = JSON.parse(seed.receipts[1]!.auditJson); audit.previousSources = []; seed.receipts[1]!.auditJson = JSON.stringify(audit); },
    ]) {
      const seeds = structuredClone(source.seeds); mutation(seeds[0]!);
      const reader = migrationReader(f.agentId, [{ scope: source.scope, records: seeds }]);
      assert.throws(() => previewDocumentKnowledgeImport(reader, source.options));
    }
    const reader = migrationReader(f.agentId, [{ scope: source.scope, records: source.seeds }]); reader.snapshot.namespaces[0]!.head.cursor--;
    reader.snapshot.snapshotDigest = documentDigest(reader.snapshot.namespaces);
    assert.throws(() => previewDocumentKnowledgeImport(reader, source.options), /document_knowledge_import_invalid/);
    const history = Array.from({ length: 600 }, (_, i) => ({ ...source.first, revision: i + 1, updatedAt: source.first.updatedAt + i }));
    const huge = migrationReader(f.agentId, [{ scope: source.scope, records: [migrationSeed(history)] }]);
    assert.throws(() => previewDocumentKnowledgeImport(huge, source.options), /document_knowledge_limit_exceeded/);
    assert.deepEqual(readdirSync(f.directory), []);
  } finally { f.close(); }
});

test('missing seed tail or a complete namespace is refused even when corresponding witnesses were also removed', async () => {
  for (const loss of ['tail', 'namespace'] as const) {
    const f = storageFixture(), source = documentImportFixture(f.agentId), path = join(f.directory, 'documents'), binding = { agentId: f.agentId, storeId: source.options.storeId };
    try {
      const preview = previewDocumentKnowledgeImport(source.reader, source.options);
      importDocumentKnowledgeSnapshot(path, binding, source.reader, { ...source.options, expectedManifestDigest: preview.manifestDigest });
      const ns = join(path, documentNamespaceName(source.scope)), witness = join(path, `witness-${documentDigest(source.scope)}`);
      if (loss === 'tail') { unlinkSync(join(ns, '00000003.md')); unlinkSync(join(witness, '00000003.json')); }
      else { rmSync(ns, { recursive: true }); rmSync(witness, { recursive: true }); }
      assert.throws(() => inspectDocumentKnowledgeImport(path, binding, preview), /document_knowledge_history_missing/);
      if (loss === 'namespace') assert.throws(() => new DocumentKnowledgeRepository(path, binding), /document_knowledge_history_missing/);
      else {
        const repository = new DocumentKnowledgeRepository(path, binding);
        try { await assert.rejects(repository.get('tenant-a', 'memory-b', ownerScope(f.agentId)), /document_knowledge_history_missing/); }
        finally { await repository.close(); }
      }
    } finally { f.close(); }
  }
});

test('seed checksum corruption and external hard links remain unsafe; foreign bytes are not overwritten on resume', () => {
  for (const damage of ['body', 'link', 'foreign'] as const) {
    const f = storageFixture(), source = documentImportFixture(f.agentId), path = join(f.directory, 'documents'), binding = { agentId: f.agentId, storeId: source.options.storeId };
    try {
      const preview = previewDocumentKnowledgeImport(source.reader, source.options), args = { ...source.options, expectedManifestDigest: preview.manifestDigest };
      importDocumentKnowledgeSnapshot(path, binding, source.reader, args);
      const file = join(path, documentNamespaceName(source.scope), '00000001.md');
      if (damage === 'link') linkSync(file, join(f.directory, 'external'));
      else writeFileSync(file, damage === 'body' ? Buffer.concat([readFileSync(file), Buffer.from('tamper')]) : Buffer.from('foreign'), { mode: 0o600 });
      const actual = readFileSync(file);
      assert.throws(() => importDocumentKnowledgeSnapshot(path, binding, source.reader, args));
      assert.deepEqual(readFileSync(file), actual);
    } finally { f.close(); }
  }
});

for (const phase of ['seed', 'format'] as const) test(`actual SIGKILL after ${phase} publication resumes exact import and preserves canonical bytes`, { timeout: 20_000 }, async () => {
  const f = storageFixture(), source = documentImportFixture(f.agentId), path = join(f.directory, 'documents'), binding = { agentId: f.agentId, storeId: source.options.storeId };
  const child = fork(new URL('./helpers/document-knowledge-import-worker.js', import.meta.url), [phase, path, f.agentId, source.options.operationId, source.options.storeId], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', chunk => { if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length); });
  try {
    const checkpoint = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(8000) }), once(child, 'exit').then(([code]) => { throw new Error(`worker_exit_${code}: ${stderr}`); })]);
    assert.deepEqual(checkpoint[0], { checkpoint: phase }); const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    const ns = join(path, documentNamespaceName(source.scope)), before = readFileSync(join(ns, '00000001.md'));
    const preview = previewDocumentKnowledgeImport(source.reader, source.options);
    if (phase === 'seed') {
      assert.equal(existsSync(join(path, 'format.json')), false);
      assert.throws(() => new DocumentKnowledgeRepository(path, binding), /document_knowledge_registration_incomplete/);
      assert.equal(inspectDocumentKnowledgeImport(path, binding, preview), 'incomplete');
    }
    assert.deepEqual(importDocumentKnowledgeSnapshot(path, binding, source.reader, { ...source.options, expectedManifestDigest: preview.manifestDigest }), preview);
    assert.deepEqual(readFileSync(join(ns, '00000001.md')), before);
    const repository = new DocumentKnowledgeRepository(path, binding);
    try { assert.deepEqual(await repository.get('tenant-a', source.fourth.id, ownerScope(f.agentId)), source.fourth); }
    finally { await repository.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
    f.close();
  }
});

test('post-seed fsync EIO keeps the original cause and published status, then exact resume restores witnesses', { timeout: 20_000 }, async () => {
  const f = storageFixture(), source = documentImportFixture(f.agentId), path = join(f.directory, 'documents');
  const child = fork(new URL('./helpers/document-knowledge-import-worker.js', import.meta.url), ['fault', path, f.agentId, source.options.operationId, source.options.storeId], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', chunk => { if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length); });
  try {
    const close = once(child, 'exit');
    const [message] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(8000) }), close.then(([code]) => { throw new Error(`worker_exit_${code}: ${stderr}`); })]);
    assert.deepEqual(message, { done: true, originalCause: true, publication: 'published', resumed: true });
    const [code, signal] = await close; assert.equal(code, 0, stderr); assert.equal(signal, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
    f.close();
  }
});

test('an empty ready namespace imports its original zero head and leaves room for its first ordinary memory', async () => {
  const f = storageFixture(), source = documentImportFixture(f.agentId), path = join(f.directory, 'documents'), binding = { agentId: f.agentId, storeId: source.options.storeId };
  const reader = migrationReader(f.agentId, [{ scope: source.scope, records: [] }]); let repository: DocumentKnowledgeRepository | undefined;
  try {
    const preview = previewDocumentKnowledgeImport(reader, source.options); importDocumentKnowledgeSnapshot(path, binding, reader, { ...source.options, expectedManifestDigest: preview.manifestDigest });
    repository = new DocumentKnowledgeRepository(path, binding);
    assert.deepEqual(await repository.indexHead('tenant-a', 'personal', ownerScope(f.agentId)), { revision: 0, cursor: 0, error: null });
    await repository.commit(storageCommand(source.first, 'first-after-import', ownerScope(f.agentId)));
    assert.deepEqual(await repository.indexHead('tenant-a', 'personal', ownerScope(f.agentId)), { revision: 1, cursor: 1, error: null });
  } finally { await repository?.close(); f.close(); }
});
