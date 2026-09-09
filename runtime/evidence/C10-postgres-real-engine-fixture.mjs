import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createEngineUpdateReleases } from '../dist/tests/helpers/agent-engine-update-releases.js';
import { FileAgentProfileStore } from '../dist/infrastructure/file-agent-profile.js';
import { registerAgentEngine, resolveAgentEngine } from '../dist/infrastructure/agent-engine-registry.js';
import { inspectEngineRelease, readAgentEnginePin } from '../dist/infrastructure/agent-engine-release.js';
import { checkAgentPostgresLifecycle, pinAgentPostgresEngine } from '../dist/infrastructure/agent-postgres-lifecycle.js';
import { backupAgentPostgres, inspectAgentPostgresBackup } from '../dist/infrastructure/agent-postgres-backup.js';
import { captureLifecycleTree, createLifecycleDirectory, lifecycleDigest } from '../dist/infrastructure/agent-lifecycle-files.js';
import { AGENT_LOCAL_RESTORE_COMPLETION } from '../dist/application/agent-lifecycle-contracts.js';
import { AGENT_RESTORE_RECONCILIATION, AGENT_RESTORE_RECONCILIATION_PENDING } from '../dist/application/agent-restore-reconciliation-contracts.js';

// Keep the production backup's exact temporary/coordination exclusions; DB/WAL and raw files remain compared.
const backupInclude = path => path !== '.secumon/runtime-leases' && !path.startsWith('.secumon/runtime-leases/') &&
  path !== '.secumon/lifecycle-maintenance.json' && path !== '.secumon-postgres-restore-complete.json' &&
  path !== AGENT_LOCAL_RESTORE_COMPLETION && path !== AGENT_RESTORE_RECONCILIATION && path !== AGENT_RESTORE_RECONCILIATION_PENDING &&
  !['.secumon/runtime.sqlite-shm', '.secumon/channel.sqlite-shm', 'memory/memory.sqlite-shm'].includes(path);
const originalInclude = path => backupInclude(path) && path !== '.secumon/engine-pins' && !path.startsWith('.secumon/engine-pins/');
const fileSummary = entries => ({ digest: lifecycleDigest(entries), entries: entries.length,
  files: entries.filter(entry => entry.kind === 'file').length,
  bytes: entries.reduce((total, entry) => total + (entry.kind === 'file' ? entry.bytes : 0), 0) });
const transferSummary = manifest => ({ digest: manifest.digest, pages: manifest.pages.length,
  rows: manifest.pages.reduce((total, page) => total + page.rows, 0) });
const management = () => ({ offline: true, operationId: randomUUID() });

/**
 * Actual V10-18 check/pin/update subset, using the existing full installed A/B runtime fixture.
 * Caller supplies a closed, unpinned PG agent and an actual exportPostgresAgent snapshot callback.
 * The isolated runtime's normal native path must already contain the verified host-native addon.
 * No model, workflow, remote transport, PG provisioning or registry outside testRoot is invoked here.
 */
export async function verifyPostgresEngineLifecycle({ testRoot, profiles, directory, host, identityOptions, snapshot,
  onProgress = () => {} }) {
  assert.equal(typeof snapshot, 'function');
  const initial = profiles.inspect(directory); assert.equal(initial.status, 'ready');
  assert.equal(readAgentEnginePin(directory), null, 'V10-18 fixture requires a development-initialized agent with no existing pin');
  const engineRoot = join(testRoot, 'engine-lifecycle'), registryDirectory = join(testRoot, 'engine-registry');
  createLifecycleDirectory(engineRoot);
  onProgress('V10-18 prepare actual installed A/B engines');
  const { a, b } = createEngineUpdateReleases(engineRoot);
  const profileOptions = { engineRegistryDirectory: registryDirectory };
  for (const engine of [a, b]) registerAgentEngine(engine.directory, engine.release.digest, { registryDirectory });
  const profilesA = new FileAgentProfileStore(a.directory, profileOptions);
  const profilesB = new FileAgentProfileStore(b.directory, profileOptions);
  const registryBefore = fileSummary(captureLifecycleTree(registryDirectory));
  const originalsBefore = fileSummary(captureLifecycleTree(directory, originalInclude));
  const profileBefore = lifecycleDigest(initial);
  const pgBefore = transferSummary((await snapshot()).manifest);
  const checks = [];
  const preserved = async label => {
    // Export revalidates the current bindings and fails if a normal management operation left its fence held.
    assert.deepEqual(transferSummary((await snapshot()).manifest), pgBefore, `${label}: PostgreSQL originals changed`);
    assert.deepEqual(fileSummary(captureLifecycleTree(directory, originalInclude)), originalsBefore, `${label}: local originals changed`);
    assert.equal(lifecycleDigest(profiles.inspect(directory)), profileBefore, `${label}: profile or registration changed`);
    assert.deepEqual(fileSummary(captureLifecycleTree(registryDirectory)), registryBefore, `${label}: engine registry changed`);
    checks.push(label); onProgress(label);
  };
  const reject = async (action, code) => assert.rejects(action, error => {
    assert.equal(error?.message, code); return true;
  });

  const checkedA = await checkAgentPostgresLifecycle(profiles, directory, a.directory, host, management());
  assert.equal(checkedA.release.digest, a.release.digest); assert.equal(checkedA.pin, null);
  assert.equal(checkedA.agentId, initial.identity.agentId);
  assert.equal(checkedA.storage.postgres.installation, 2);
  assert.deepEqual(checkedA.storage.postgres.purposes.map(value => value.purpose).sort(), [...host.selection.purposes].sort());
  await preserved('check before first pin');

  const first = await pinAgentPostgresEngine(profiles, directory, a.directory, host,
    { ...management(), expectedPrevious: null });
  assert.equal(first.applied, true); assert.equal(first.recoveryRequired, true);
  assert.equal(first.pin.sequence, 1); assert.equal(first.pin.releaseDigest, a.release.digest);
  assert.equal(first.pin.previous, null); assert.equal(first.pin.backupDigest, null);
  assert.deepEqual(readAgentEnginePin(directory), first.pin);
  profilesA.assertRuntimeCompatible(directory);
  await preserved('first PG engine pin');

  const originalFirstPin = captureLifecycleTree(join(directory, '.secumon', 'engine-pins'));
  assert.equal(originalFirstPin.length, 1);
  const pinnedA = fileSummary(captureLifecycleTree(directory, backupInclude));
  const sameA = await pinAgentPostgresEngine(profilesA, directory, a.directory, host,
    { ...management(), expectedPrevious: a.release.digest });
  assert.equal(sameA.applied, false); assert.deepEqual(sameA.pin, first.pin);
  assert.deepEqual(fileSummary(captureLifecycleTree(directory, backupInclude)), pinnedA);
  await preserved('same pin is unchanged');

  const checkedB = await checkAgentPostgresLifecycle(profilesA, directory, b.directory, host, management());
  assert.equal(checkedB.release.digest, b.release.digest); assert.deepEqual(checkedB.pin, first.pin);
  await preserved('candidate B check preserves current A pin');
  const backupA = await backupAgentPostgres(profilesA, directory, join(engineRoot, 'backup-a'), host, management());
  const savedA = await inspectAgentPostgresBackup(backupA.directory);
  assert.equal(savedA.manifest.digest, backupA.manifest.digest);
  assert.equal(savedA.manifest.releaseDigest, a.release.digest);
  assert.equal(savedA.manifest.agentId, initial.identity.agentId); assert.equal(savedA.manifest.originalRoot, directory);
  assert.deepEqual(transferSummary(savedA.transfer), pgBefore);
  assert.deepEqual(fileSummary(savedA.manifest.entries), fileSummary(captureLifecycleTree(directory, backupInclude)));
  const backupATree = fileSummary(captureLifecycleTree(backupA.directory));
  await preserved('current A combined backup revalidated');

  await reject(() => pinAgentPostgresEngine(profilesA, directory, b.directory, host,
    { ...management(), expectedPrevious: '0'.repeat(64), backup: backupA.directory }), 'engine_pin_conflict');
  assert.deepEqual(readAgentEnginePin(directory), first.pin);
  assert.deepEqual(fileSummary(captureLifecycleTree(directory, backupInclude)), pinnedA);
  await preserved('wrong expectedPrevious rejected');

  const updated = await pinAgentPostgresEngine(profilesA, directory, b.directory, host,
    { ...management(), expectedPrevious: a.release.digest, backup: backupA.directory });
  assert.equal(updated.applied, true); assert.equal(updated.recoveryRequired, true);
  assert.equal(updated.pin.sequence, 2); assert.equal(updated.pin.releaseDigest, b.release.digest);
  assert.equal(updated.pin.engineDirectory, b.directory);
  assert.equal(updated.pin.previous, lifecycleDigest(first.pin)); assert.equal(updated.pin.backupDigest, savedA.manifest.digest);
  assert.deepEqual(readAgentEnginePin(directory), updated.pin);
  assert.deepEqual(captureLifecycleTree(join(directory, '.secumon', 'engine-pins')).filter(entry => entry.path === '00000001.json'), originalFirstPin);
  profilesB.assertRuntimeCompatible(directory);
  assert.equal(resolveAgentEngine(directory, profiles.engineDirectories[0], { registryDirectory }).directory, b.directory);
  assert.deepEqual(fileSummary(captureLifecycleTree(backupA.directory)), backupATree);
  await preserved('update uses the verified current combined backup');

  const pinnedB = fileSummary(captureLifecycleTree(directory, backupInclude));
  const sameB = await pinAgentPostgresEngine(profilesB, directory, b.directory, host,
    { ...management(), expectedPrevious: b.release.digest, backup: backupA.directory });
  assert.equal(sameB.applied, false); assert.deepEqual(sameB.pin, updated.pin);
  assert.deepEqual(fileSummary(captureLifecycleTree(directory, backupInclude)), pinnedB);
  await preserved('same updated pin does not append another record');

  await reject(() => pinAgentPostgresEngine(profilesB, directory, a.directory, host,
    { ...management(), expectedPrevious: b.release.digest, backup: backupA.directory }), 'engine_update_backup_stale');
  assert.deepEqual(readAgentEnginePin(directory), updated.pin);
  assert.deepEqual(fileSummary(captureLifecycleTree(directory, backupInclude)), pinnedB);
  await preserved('backup of prior pin rejected for a new transition');

  const backupB = await backupAgentPostgres(profilesB, directory, join(engineRoot, 'backup-b'), host, management());
  const savedB = await inspectAgentPostgresBackup(backupB.directory);
  assert.equal(savedB.manifest.digest, backupB.manifest.digest);
  assert.equal(savedB.manifest.releaseDigest, b.release.digest);
  assert.equal(savedB.manifest.agentId, initial.identity.agentId); assert.equal(savedB.manifest.originalRoot, directory);
  assert.deepEqual(transferSummary(savedB.transfer), pgBefore);
  assert.deepEqual(fileSummary(savedB.manifest.entries), fileSummary(captureLifecycleTree(directory, backupInclude)));
  assert.deepEqual(fileSummary(captureLifecycleTree(join(backupB.directory, 'data'), originalInclude)), originalsBefore);
  assert.deepEqual(readAgentEnginePin(join(backupB.directory, 'data')), updated.pin);
  assert.deepEqual(fileSummary(captureLifecycleTree(backupA.directory)), backupATree);
  assert.equal((await inspectAgentPostgresBackup(backupA.directory)).manifest.digest, savedA.manifest.digest);
  for (const engine of [a, b]) assert.equal(inspectEngineRelease(engine.directory).digest, engine.release.digest);
  await preserved('new B backup includes current pin and unchanged original PG pages/local files');

  return {
    profiles: profilesB, engineDirectory: b.directory,
    identityOptions: { ...identityOptions, engineDirectories: [...new Set([...(identityOptions?.engineDirectories ?? []), a.directory, b.directory])] },
    report: {
      scope: 'V10-18 actual PostgreSQL check/pin/update and original preservation subset',
      checks, before: { postgres: pgBefore, localOriginals: originalsBefore },
      engines: [a, b].map(engine => ({ version: engine.release.version, digest: engine.release.digest, entries: engine.release.entries.length })),
      pins: { first: lifecycleDigest(first.pin), current: lifecycleDigest(updated.pin), sequence: updated.pin.sequence },
      backups: [savedA, savedB].map(saved => ({ digest: saved.manifest.digest, releaseDigest: saved.manifest.releaseDigest,
        postgres: transferSummary(saved.transfer), local: fileSummary(saved.manifest.entries) })),
      remaining: ['unsupported PG release/schema/purpose declarations', 'concurrent local and DB maintenance contention',
        'interrupted no-replace pin publication and unknown DB commit/fence recovery'],
      modelCalls: 0, workflowExecutions: 0,
    },
  };
}
