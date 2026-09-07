import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { applyPersonalMemoryMigration, previewPersonalMemoryMigration, resumePersonalMemoryMigration } from '../infrastructure/personal-memory-migration.js';
import { migrationActivationPath } from '../infrastructure/personal-memory-migration-profile.js';
import { FileMutationFault } from '../infrastructure/host-file-mutations.js';
import { AgentProfileError } from '../application/agent-profile-contracts.js';
import type { PersonalMemoryMigrationOptions } from '../application/personal-memory-migration-contracts.js';

function causeChain(error: unknown): unknown[] {
  const result: unknown[] = [];
  while (error && !result.includes(error) && result.length < 16) {
    result.push(error); error = error instanceof Error ? error.cause : undefined;
  }
  return result;
}

test('activation publication fsync failure preserves its cause and resume synchronizes the same visible activation before selecting documents', { timeout: 45000 }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'personal-memory-activation-barrier-')));
  const engine = join(base, 'engine'), directory = join(base, 'agent'); fs.mkdirSync(engine, { mode: 0o700 });
  const hostOptions = { identityRegistryDirectory: join(base, 'registry') };
  const profiles = new FileAgentProfileStore(engine);
  const originalLink = fs.linkSync, originalSync = fs.fsyncSync;
  let hooksInstalled = false;
  try {
    const profile = profiles.initialize(directory);
    const stores = await openAgentStores(profiles, directory, undefined, hostOptions); await stores.close();
    const options: PersonalMemoryMigrationOptions = { directory, source: profile.paths.memory, target: join(directory, 'memory', 'documents'),
      operationId: randomUUID(), targetStoreId: randomUUID(), backupDirectory: join(base, 'backup'), from: 'sqlite', to: 'documents', scope: 'all-personal' };
    const preview = previewPersonalMemoryMigration(profiles, options, [engine]);
    const activation = migrationActivationPath(directory), metadata = fs.lstatSync(profile.paths.metadata);
    const injected = Object.assign(new Error('injected_activation_parent_fsync'), { code: 'EIO' });
    let published = false, failures = 0, metadataSyncCalls = 0, successfulMetadataSyncs = 0;
    // Node's test-file process isolates these builtin wrappers. Every non-injected operation is forwarded.
    fs.linkSync = (source, destination) => {
      originalLink(source, destination);
      if (String(destination) === activation) published = true;
    };
    fs.fsyncSync = fd => {
      const stat = fs.fstatSync(fd);
      if (published && stat.isDirectory() && stat.dev === metadata.dev && stat.ino === metadata.ino) {
        metadataSyncCalls++;
        if (failures === 0) { failures++; throw injected; }
        originalSync(fd); successfulMetadataSyncs++; return;
      }
      originalSync(fd);
    };
    hooksInstalled = true; syncBuiltinESMExports();
    let firstError: unknown;
    await assert.rejects(applyPersonalMemoryMigration(profiles, options,
      { expectedSnapshotDigest: preview.snapshot.snapshotDigest, offlineConfirmed: true, effectsReconciled: true }, [engine]), error => {
      firstError = error; return true;
    });
    assert.equal(published, true); assert.equal(failures, 1); assert.equal(metadataSyncCalls, 1);
    assert.ok(firstError instanceof AgentProfileError); assert.equal(firstError.code, 'agent_metadata_publish_unknown');
    const chain = causeChain(firstError), mutation = chain.find(error => error instanceof FileMutationFault);
    assert.ok(mutation instanceof FileMutationFault);
    assert.equal(mutation.status.publication, 'published'); assert.equal(mutation.status.directorySynced, false);
    assert.ok(chain.includes(injected), 'the original EIO object remains in the cause chain');
    assert.ok(mutation.errors.some(entry => causeChain(entry.error).includes(injected)));
    const savedActivation = fs.readFileSync(activation), syncCallsBeforeResume = metadataSyncCalls, successesBeforeResume = successfulMetadataSyncs;
    const result = await resumePersonalMemoryMigration(profiles, directory, options.operationId, [engine]);
    assert.equal(result.phase, 'activated');
    assert.deepEqual(result.effectivePersonalMemory, { backend: 'documents', storeId: options.targetStoreId });
    assert.ok(metadataSyncCalls > syncCallsBeforeResume, 'a visible activation alone must not bypass its directory barrier');
    assert.ok(successfulMetadataSyncs > successesBeforeResume, 'resume must perform an actual successful parent fsync');
    assert.equal(failures, 1); assert.deepEqual(fs.readFileSync(activation), savedActivation);
    const reopened = await openAgentStores(profiles, directory, undefined, hostOptions);
    try { assert.deepEqual(reopened.profile.effectivePersonalMemory, result.effectivePersonalMemory); }
    finally { await reopened.close(); }
    assert.deepEqual(fs.readFileSync(activation), savedActivation);
  } finally {
    if (hooksInstalled) { fs.linkSync = originalLink; fs.fsyncSync = originalSync; syncBuiltinESMExports(); }
    fs.rmSync(base, { recursive: true, force: true });
  }
});
