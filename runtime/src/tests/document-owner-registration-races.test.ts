import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentFiles, inspectDocumentKnowledgeStore, registerDocumentKnowledgeStore } from '../infrastructure/document-knowledge-owner.js';
import { FileBoundaryFault, hostMetadataFiles } from '../infrastructure/host-metadata-files.js';

const posix = process.platform === 'darwin' || process.platform === 'linux';
function fixture(t: TestContext, partial = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'document-owner-registration-races-'))), directory = join(base, 'documents');
  mkdirSync(directory, { mode: 0o700 }); t.after(() => rmSync(base, { recursive: true, force: true }));
  const binding = { agentId: randomUUID(), storeId: randomUUID() };
  const ownerBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'document-knowledge', ...binding }));
  const pendingName = `.secumon-init-${randomUUID()}.pending`, candidate = join(directory, pendingName), owner = join(directory, 'owner.json');
  writeFileSync(candidate, partial ? Buffer.from('{') : ownerBytes, { flag: 'wx', mode: 0o600 });
  return { base, directory, binding, ownerBytes, pendingName, candidate, owner };
}
function observeReads(read: (args: Parameters<ReturnType<typeof hostMetadataFiles>['readStableRegularFile']>,
  original: () => Buffer) => Buffer) {
  const files = hostMetadataFiles(), original = files.readStableRegularFile;
  const own = Object.getOwnPropertyDescriptor(files, 'readStableRegularFile');
  files.readStableRegularFile = function (...args: Parameters<typeof original>) { return read(args, () => original.apply(this, args)); };
  return () => { if (own) Object.defineProperty(files, 'readStableRegularFile', own); else Reflect.deleteProperty(files, 'readStableRegularFile'); };
}

test('document file reobservation preserves the unsafe cause and requires a fresh validation after the canonical peer is linked', { skip: !posix }, t => {
  const f = fixture(t), documents = new DocumentFiles(f.directory, f.binding);
  const ref = documents.directoryRef(f.directory)!;
  const capturedNames = documents.names(f.directory, ref);
  linkSync(f.candidate, f.owner);
  let originalFault: unknown;
  const restore = observeReads((_args, read) => { try { return read(); } catch (error) { originalFault = error; throw error; } });
  try {
    assert.throws(() => documents.read(f.directory, ref, f.pendingName, capturedNames), error => {
      assert.ok(error instanceof FileBoundaryFault); assert.equal(error.code, 'changed'); assert.equal(error.operation, 'read');
      assert.equal(error.cause, originalFault); assert.ok(originalFault instanceof FileBoundaryFault); assert.equal(originalFault.code, 'unsafe');
      return true;
    });
    assert.deepEqual(documents.read(f.directory, ref, f.pendingName, documents.names(f.directory, ref)), f.ownerBytes);
    assert.deepEqual(readFileSync(f.owner), f.ownerBytes);
  } finally { restore(); documents.close(); }
});

for (const partial of [false, true]) {
  test(`document registration resumes after a ${partial ? 'completed partial' : 'complete'} candidate is linked during its first inspection`, { skip: !posix }, t => {
    const f = fixture(t, partial); let reads = 0, linked = false, unsafe: unknown;
    const restore = observeReads((args, read) => {
      let bytes: Buffer;
      try { bytes = read(); } catch (error) { unsafe = error; throw error; }
      if (args[1] === f.pendingName && ++reads === 1) {
        if (partial) writeFileSync(f.candidate, f.ownerBytes);
        linkSync(f.candidate, f.owner); linked = true;
      }
      return bytes;
    });
    try {
      registerDocumentKnowledgeStore(f.directory, f.binding);
      assert.equal(linked, true); assert.ok(unsafe instanceof FileBoundaryFault); assert.equal(unsafe.code, 'unsafe');
      assert.equal(inspectDocumentKnowledgeStore(f.directory, f.binding), 'registered');
      assert.deepEqual(readFileSync(f.owner), f.ownerBytes); assert.deepEqual(readFileSync(f.candidate), f.ownerBytes);
      const before = readdirSync(f.directory).sort().map(name => ({ name, bytes: readFileSync(join(f.directory, name)) }));
      registerDocumentKnowledgeStore(f.directory, f.binding);
      assert.deepEqual(readdirSync(f.directory).sort().map(name => ({ name, bytes: readFileSync(join(f.directory, name)) })), before);
    } finally { restore(); }
  });
}

test('unchanged external hardlink remains the original unsafe error rather than a contention retry', { skip: !posix }, t => {
  const f = fixture(t), external = join(f.base, 'external-link'); linkSync(f.candidate, external);
  const documents = new DocumentFiles(f.directory, f.binding), ref = documents.directoryRef(f.directory)!;
  let originalFault: unknown, reads = 0;
  const restore = observeReads((_args, read) => {
    reads++; try { return read(); } catch (error) { originalFault = error; throw error; }
  });
  try {
    assert.throws(() => documents.read(f.directory, ref, f.pendingName, documents.names(f.directory, ref)), error => {
      assert.equal(error, originalFault); assert.ok(error instanceof FileBoundaryFault); assert.equal(error.code, 'unsafe'); return true;
    });
    assert.equal(reads, 1); assert.equal(existsSync(f.owner), false);
    assert.deepEqual(readFileSync(f.candidate), f.ownerBytes); assert.deepEqual(readFileSync(external), f.ownerBytes);
  } finally { restore(); documents.close(); }
});

test('an unrelated new pending name cannot authorize an externally linked candidate on registration retry', { skip: !posix }, t => {
  const f = fixture(t), external = join(f.base, 'external-link'); linkSync(f.candidate, external);
  const unrelated = join(f.directory, `.secumon-init-${randomUUID()}.pending`);
  let inserted = false, unsafeReads = 0;
  const restore = observeReads((args, read) => {
    try { return read(); }
    catch (error) {
      if (args[1] === f.pendingName && error instanceof FileBoundaryFault && error.code === 'unsafe') {
        unsafeReads++;
        if (!inserted) { writeFileSync(unrelated, f.ownerBytes, { flag: 'wx', mode: 0o600 }); inserted = true; }
      }
      throw error;
    }
  });
  try {
    assert.throws(() => registerDocumentKnowledgeStore(f.directory, f.binding), error => {
      assert.ok(error instanceof FileBoundaryFault); assert.equal(error.code, 'unsafe'); assert.equal(error.operation, 'read'); return true;
    });
    assert.equal(inserted, true); assert.equal(unsafeReads, 2);
    assert.equal(existsSync(f.owner), false); assert.equal(existsSync(join(f.directory, 'format.json')), false);
    assert.deepEqual(readFileSync(f.candidate), f.ownerBytes); assert.deepEqual(readFileSync(external), f.ownerBytes);
    assert.deepEqual(readFileSync(unrelated), f.ownerBytes);
  } finally { restore(); }
});
