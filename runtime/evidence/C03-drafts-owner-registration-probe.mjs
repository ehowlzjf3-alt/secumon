// Deterministic synthetic filesystem probe; imports the existing dist without rebuilding it.
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostMetadataFiles } from '../dist/infrastructure/host-metadata-files.js';
import { registerDocumentKnowledgeStore } from '../dist/infrastructure/document-knowledge-owner.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'document-owner-registration-probe-')));
const binding = { agentId: 'diagnostic-agent', storeId: 'diagnostic-store' };
const pending = '.secumon-init-11111111-1111-4111-8111-111111111111.pending';
const expected = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'document-knowledge', ...binding }));
const files = hostMetadataFiles(), originalRead = files.readStableRegularFile;
const failure = error => ({ name: error?.name ?? null, code: error?.code ?? null,
  message: error?.message ?? null, cause: error?.cause ? failure(error.cause) : null });
const results = [];
try {
  for (const mode of ['owner-linked-after-first-read', 'owner-linked-after-partial-read', 'stable-partial', 'stable-foreign']) {
    const directory = join(root, mode); mkdirSync(directory, { mode: 0o700 });
    const candidate = join(directory, pending), owner = join(directory, 'owner.json');
    const bytes = mode.includes('partial') ? Buffer.from('{') : mode === 'stable-foreign' ?
      Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'document-knowledge', agentId: 'other-agent', storeId: 'other-store' })) : expected;
    writeFileSync(candidate, bytes, { flag: 'wx', mode: 0o600 });
    let reads = 0, injected = false, error = null;
    files.readStableRegularFile = function (...args) {
      const value = Reflect.apply(originalRead, this, args);
      if (args[1] === pending && ++reads === 1 && mode.startsWith('owner-linked')) {
        if (mode === 'owner-linked-after-partial-read') writeFileSync(candidate, expected);
        linkSync(candidate, owner); injected = true;
      }
      return value;
    };
    try { registerDocumentKnowledgeStore(directory, binding); }
    catch (cause) { error = failure(cause); }
    finally { files.readStableRegularFile = originalRead; }
    results.push({ mode, injected, reads, outcome: error ? 'rejected' : 'registered', failure: error,
      entries: readdirSync(directory).sort(), candidatePreserved: readFileSync(candidate).equals(injected ? expected : bytes),
      ownerPreserved: injected ? readFileSync(owner).equals(expected) : null });
  }
  const result = { schemaVersion: 1, node: process.version, platform: process.platform, nativeWindows: false,
    source: 'existing dist; no build performed by probe',
    injection: 'After the first real stable pending read, publish the same candidate inode as owner.json with an actual hardlink; captured sibling names still omit owner.json.',
    notEstablished: 'The original NAS failure did not include its nested cause; this proves the matching stale-name failure route, not that it was the only cause of that run.',
    results };
  const destination = process.argv[2];
  if (destination) writeFileSync(destination, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  assert.ok(results.every(value => value.candidatePreserved));
} finally { files.readStableRegularFile = originalRead; rmSync(root, { recursive: true, force: true }); }
