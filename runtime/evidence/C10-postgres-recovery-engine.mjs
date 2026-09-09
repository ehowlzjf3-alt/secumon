import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createEngineUpdateReleases } from '../dist/tests/helpers/agent-engine-update-releases.js';
import { FileAgentProfileStore } from '../dist/infrastructure/file-agent-profile.js';
import { registerAgentEngine } from '../dist/infrastructure/agent-engine-registry.js';
import { inspectEngineRelease, publishLifecycleManifest, readAgentEnginePin } from '../dist/infrastructure/agent-engine-release.js';
import { checkAgentPostgresLifecycle, pinAgentPostgresEngine } from '../dist/infrastructure/agent-postgres-lifecycle.js';
import { backupAgentPostgres, inspectAgentPostgresBackup } from '../dist/infrastructure/agent-postgres-backup.js';
import { acquireAgentMaintenance } from '../dist/infrastructure/agent-lifecycle-lease.js';
import { acquirePostgresMaintenance } from '../dist/infrastructure/postgres-store.js';
import { captureLifecycleTree, copyLifecycleTree, createLifecycleDirectory, lifecycleDigest } from '../dist/infrastructure/agent-lifecycle-files.js';
import { AGENT_LOCAL_RESTORE_COMPLETION } from '../dist/application/agent-lifecycle-contracts.js';
import { AGENT_RESTORE_RECONCILIATION, AGENT_RESTORE_RECONCILIATION_PENDING } from '../dist/application/agent-restore-reconciliation-contracts.js';

// Same temporary/coordination exclusions as the production combined backup; keep raw DB/WAL/files.
const originalInclude = path => path !== '.secumon/runtime-leases' && !path.startsWith('.secumon/runtime-leases/') &&
  path !== '.secumon/lifecycle-maintenance.json' && path !== '.secumon-postgres-restore-complete.json' &&
  path !== AGENT_LOCAL_RESTORE_COMPLETION && path !== AGENT_RESTORE_RECONCILIATION && path !== AGENT_RESTORE_RECONCILIATION_PENDING &&
  path !== '.secumon/engine-pins' && !path.startsWith('.secumon/engine-pins/') &&
  !['.secumon/runtime.sqlite-shm', '.secumon/channel.sqlite-shm', 'memory/memory.sqlite-shm'].includes(path);
const treeSummary = entries => ({ digest: lifecycleDigest(entries), entries: entries.length,
  bytes: entries.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.bytes : 0), 0) });
const pgSummary = manifest => ({ digest: manifest.digest, pages: manifest.pages.length,
  rows: manifest.pages.reduce((sum, page) => sum + page.rows, 0) });
const options = () => ({ operationId: randomUUID(), offline: true });

/** Real PG with deterministic client exceptions; no network loss, process signal or engine execution is claimed. */
export async function verifyEngineRecovery(ctx) {
  const { root, runtimeRoot, directory, profiles, host, bindings, snapshot, fences, expectFailure, interceptPool, emit } = ctx;
  assert.equal(readAgentEnginePin(directory), null);
  assert.deepEqual(await ctx.records(host), ctx.before, 'engine_entry_original_records');
  const originalRecordsDigest = lifecycleDigest(ctx.before);
  const originalPg = pgSummary((await snapshot()).manifest);
  const originalFiles = treeSummary(captureLifecycleTree(directory, originalInclude));
  const originalProfile = lifecycleDigest(profiles.inspect(directory));
  const expectedFences = bindings.map(binding => ({ purpose: binding.purpose, maintenance_id: null }))
    .sort((left, right) => left.purpose.localeCompare(right.purpose));
  assert.deepEqual(await fences(), expectedFences);
  const base = join(root, 'engine-recovery'), registryDirectory = join(root, 'engine-registry');
  createLifecycleDirectory(base);
  emit({ kind: 'engine_recovery_stage', stage: 'prepare_actual_engine_releases' });
  const { a, b } = createEngineUpdateReleases(base);
  for (const engine of [a, b]) registerAgentEngine(engine.directory, engine.release.digest, { registryDirectory });
  const profileOptions = { engineRegistryDirectory: registryDirectory };
  const profilesA = new FileAgentProfileStore(a.directory, profileOptions), profilesB = new FileAgentProfileStore(b.directory, profileOptions);
  const originalRegistry = treeSummary(captureLifecycleTree(registryDirectory));
  const checks = [];
  const preserved = async (name, maintenanceId) => {
    assert.deepEqual(pgSummary((await snapshot(host.pool, maintenanceId)).manifest), originalPg, `${name}:pg_original_digest`);
    assert.deepEqual(treeSummary(captureLifecycleTree(directory, originalInclude)), originalFiles, `${name}:local_original_digest`);
    assert.equal(lifecycleDigest(profiles.inspect(directory)), originalProfile, `${name}:profile_digest`);
    assert.deepEqual(treeSummary(captureLifecycleTree(registryDirectory)), originalRegistry, `${name}:registry_digest`);
    checks.push(name); emit({ kind: 'engine_recovery_check', name });
  };
  const query = async (sql, values) => {
    const client = await host.pool.connect();
    try { return await client.query(sql, values); } finally { client.release(); }
  };
  const check = (engine = a.directory, selectedHost = host, selectedOptions = options()) =>
    checkAgentPostgresLifecycle(profiles, directory, engine, selectedHost, selectedOptions);

  // Change only this fresh case's administrative metadata and restore the exact value even after a failed assertion.
  const installation = await query('SELECT version FROM secumon_pg.installation WHERE singleton=true');
  assert.equal(installation.rows.length, 1); assert.equal(Number(installation.rows[0].version), 2);
  try {
    assert.equal((await query('UPDATE secumon_pg.installation SET version=$1 WHERE singleton=true AND version=$2', [1, 2])).rowCount, 1);
    await expectFailure(() => check(), 'postgres_schema_mismatch');
    assert.equal(readAgentEnginePin(directory), null);
  } finally {
    assert.equal((await query('UPDATE secumon_pg.installation SET version=$1 WHERE singleton=true AND version=$2', [2, 1])).rowCount, 1);
  }
  await preserved('actual_installation_version_mismatch');

  const binding = bindings[0]; assert.ok(binding);
  const key = [binding.storeId, binding.agentId, binding.purpose];
  const priorBinding = await query('SELECT registration_id,schema_version,maintenance_id FROM secumon_pg.bindings WHERE store_id=$1 AND agent_id=$2 AND purpose=$3', key);
  assert.equal(priorBinding.rows.length, 1); assert.equal(Number(priorBinding.rows[0].schema_version), 1);
  assert.equal(priorBinding.rows[0].registration_id, binding.registrationId); assert.equal(priorBinding.rows[0].maintenance_id, null);
  try {
    assert.equal((await query('UPDATE secumon_pg.bindings SET schema_version=$4 WHERE store_id=$1 AND agent_id=$2 AND purpose=$3 AND schema_version=$5', [...key, 2, 1])).rowCount, 1);
    await expectFailure(() => check(), 'postgres_binding_mismatch');
    assert.equal(readAgentEnginePin(directory), null);
  } finally {
    assert.equal((await query('UPDATE secumon_pg.bindings SET schema_version=$4 WHERE store_id=$1 AND agent_id=$2 AND purpose=$3 AND schema_version=$5', [...key, 1, 2])).rowCount, 1);
  }
  assert.equal(lifecycleDigest((await query('SELECT registration_id,schema_version,maintenance_id FROM secumon_pg.bindings WHERE store_id=$1 AND agent_id=$2 AND purpose=$3', key)).rows), lifecycleDigest(priorBinding.rows));
  await preserved('actual_binding_version_mismatch');

  // Full real engine files are copied. Only isolated declaration fixtures differ; original release/bundle is immutable.
  for (const variant of ['no-postgres-declaration', 'unsupported-selected-purpose']) {
    const target = join(base, variant); createLifecycleDirectory(target);
    copyLifecycleTree(a.directory, target, a.release.entries);
    const { digest: ignoredDigest, ...body } = structuredClone(a.release);
    if (variant === 'no-postgres-declaration') delete body.compatibility.postgres;
    else body.compatibility.postgres[binding.purpose] = [2];
    const candidate = { ...body, digest: lifecycleDigest(body) };
    publishLifecycleManifest(target, 'release.json', candidate);
    assert.equal(inspectEngineRelease(target).digest, candidate.digest);
    await expectFailure(() => check(target), 'engine_postgres_incompatible');
    assert.equal(readAgentEnginePin(directory), null);
    await preserved(variant);
  }

  const local = acquireAgentMaintenance(directory, true); let databaseQueries = 0;
  const countPool = interceptPool(host.pool, { beforeQuery() { databaseQueries++; } });
  try {
    await expectFailure(() => check(a.directory, { ...host, pool: countPool }), 'agent_maintenance_active');
    assert.equal(databaseQueries, 0); assert.equal(readAgentEnginePin(directory), null);
  } finally { local.close(); }
  assert.equal(existsSync(join(directory, '.secumon', 'lifecycle-maintenance.json')), false);
  await preserved('existing_local_maintenance_refuses_engine_check');

  const lockId = randomUUID(), held = await acquirePostgresMaintenance(host.pool, bindings, lockId);
  try {
    await expectFailure(() => check(), 'postgres_store_maintenance');
    assert.deepEqual(await fences(), expectedFences.map(row => ({ ...row, maintenance_id: lockId })));
    assert.equal(readAgentEnginePin(directory), null);
    assert.equal(existsSync(join(directory, '.secumon', 'lifecycle-maintenance.json')), false);
    await preserved('existing_database_maintenance_owner_preserved', lockId);
  } finally { await held.release(); }
  assert.deepEqual(await fences(), expectedFences);

  // Only the initial pin and current combined backup needed for the post-publication recovery branch.
  const first = await pinAgentPostgresEngine(profiles, directory, a.directory, host, { ...options(), expectedPrevious: null });
  assert.equal(first.applied, true); assert.equal(first.pin.sequence, 1);
  const firstPinFiles = treeSummary(captureLifecycleTree(join(directory, '.secumon', 'engine-pins')));
  const backup = await backupAgentPostgres(profilesA, directory, join(base, 'backup-before-update'), host, options());
  const saved = await inspectAgentPostgresBackup(backup.directory);
  assert.equal(saved.manifest.releaseDigest, a.release.digest); assert.deepEqual(pgSummary(saved.transfer), originalPg);
  const backupTree = treeSummary(captureLifecycleTree(backup.directory));
  const updateId = randomUUID(); let injected = false;
  const pool = interceptPool(host.pool, {
    afterQuery({ sql, state }) {
      if (sql.startsWith('BEGIN ')) state.engineRelease = false;
      if (sql.startsWith('UPDATE secumon_pg.bindings SET maintenance_id=NULL ')) state.engineRelease = true;
    },
    beforeQuery({ sql, state }) {
      if (sql === 'COMMIT' && state.engineRelease && !injected) {
        const head = readAgentEnginePin(directory);
        assert.equal(head?.releaseDigest, b.release.digest); assert.equal(head?.sequence, 2);
        injected = true;
        // UPDATE really ran; this COMMIT is deliberately not sent. Product conservatively marks the outcome unknown.
        throw new Error('fixture_engine_release_commit_not_sent');
      }
    },
  });
  await expectFailure(() => pinAgentPostgresEngine(profilesA, directory, b.directory, { ...host, pool },
    { offline: true, operationId: updateId, expectedPrevious: a.release.digest, backup: backup.directory }), 'postgres_commit_outcome_unknown');
  assert.equal(injected, true);
  const published = readAgentEnginePin(directory);
  assert.equal(published?.releaseDigest, b.release.digest); assert.equal(published?.sequence, 2);
  assert.equal(published.previous, lifecycleDigest(first.pin)); assert.equal(published.backupDigest, saved.manifest.digest);
  assert.deepEqual(treeSummary(captureLifecycleTree(join(directory, '.secumon', 'engine-pins'), path => path === '00000001.json')), firstPinFiles);
  assert.deepEqual(await fences(), expectedFences.map(row => ({ ...row, maintenance_id: updateId })));
  assert.equal(existsSync(join(directory, '.secumon', 'lifecycle-maintenance.json')), false);
  await expectFailure(() => snapshot(), 'postgres_store_maintenance');
  await preserved('published_pin_and_persistent_fence_after_commit_exception', updateId);

  // Explicit host reconciliation: inspect the durable head, then re-enter the same fence through the existing check API.
  const recovered = await checkAgentPostgresLifecycle(profilesB, directory, b.directory, host, { offline: true, operationId: updateId });
  assert.equal(lifecycleDigest(recovered.pin), lifecycleDigest(published));
  assert.equal(lifecycleDigest(readAgentEnginePin(directory)), lifecycleDigest(published));
  assert.deepEqual(await fences(), expectedFences);
  profilesB.assertRuntimeCompatible(directory);
  assert.deepEqual(treeSummary(captureLifecycleTree(backup.directory)), backupTree);
  for (const engine of [a, b]) assert.equal(inspectEngineRelease(engine.directory).digest, engine.release.digest);
  await preserved('same_operation_check_releases_fence_without_another_pin');

  return {
    profiles: profilesB,
    identityOptions: { registryDirectory: ctx.storeOptions.identityRegistryDirectory, engineDirectories: [runtimeRoot, a.directory, b.directory] },
    report: { scope: 'V10-18 real PG mismatch/maintenance and post-pin client-exception recovery', checks,
      originalRecordsDigest, postgres: originalPg, localOriginals: originalFiles,
      engines: [a, b].map(engine => ({ version: engine.release.version, digest: engine.release.digest })),
      currentPinDigest: lifecycleDigest(published), pinSequence: published.sequence,
      backupDigest: saved.manifest.digest, injection: 'after real release UPDATE; before sending COMMIT; ordinary ROLLBACK',
      networkFailureInjected: false, processSignalInjected: false, modelCalls: 0, workflowExecutions: 0 },
  };
}
