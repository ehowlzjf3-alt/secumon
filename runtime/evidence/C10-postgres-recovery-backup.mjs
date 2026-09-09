// Evidence-only real PostgreSQL exception-injection scenarios. No model or workflow execution.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export async function verifyBackupRecovery(ctx) {
  const { root, runtimeRoot, directory, profiles, host, restoreHost, bindings, before,
    records, snapshot, identityOptions, emit, expectFailure, interceptPool, fences, migration } = ctx;
  const load = path => import(pathToFileURL(join(runtimeRoot, 'dist', path)).href);
  const [backupApi, transferApi, storeApi, stateApi, knowledgeApi, channelApi, metadataApi,
    lifecycleApi, storesApi, identityApi, rebindApi, reconcileApi, migrationApi] = await Promise.all([
    load('infrastructure/agent-postgres-backup.js'), load('infrastructure/postgres-transfer.js'),
    load('infrastructure/postgres-store.js'), load('infrastructure/postgres-state.js'),
    load('infrastructure/postgres-knowledge.js'), load('infrastructure/postgres-channel.js'),
    load('infrastructure/host-metadata-files.js'), load('infrastructure/agent-lifecycle-files.js'),
    load('infrastructure/agent-stores.js'), load('infrastructure/agent-host-identities.js'),
    load('infrastructure/agent-host-identity-recovery.js'), load('infrastructure/agent-restore-reconciliation.js'),
    load('infrastructure/agent-postgres-migration.js'),
  ]);
  const { backupAgentPostgres, inspectAgentPostgresBackup, restoreAgentPostgresBackup } = backupApi;
  const { captureLifecycleTree, lifecycleDigest } = lifecycleApi;
  const options = () => typeof ctx.storeOptions === 'function' ? ctx.storeOptions() : ctx.storeOptions;
  const openPublicStores = async selectedHost => {
    const stores = await storesApi.openAgentStores(profiles, directory, selectedHost, options());
    await stores.close();
  };
  const checks = [], stage = name => emit({ kind: 'postgres_recovery_backup_stage', stage: name });
  const same = (actual, expected, name) => { assert.deepEqual(actual, expected, name); checks.push(name); };
  const check = (value, name) => { assert.ok(value, name); checks.push(name); };
  const injected = code => Object.assign(new Error(code), { code });
  const allFenced = (rows, id) => rows.length === bindings.length && rows.every(row => row.maintenance_id === id);
  const raw = async (pool, sql, values = []) => {
    const client = await pool.connect();
    try { return await client.query(sql, values); } finally { client.release(); }
  };
  const area = join(root, 'backup-recovery');
  assert.equal(existsSync(area), false, 'fresh backup recovery evidence directory');
  mkdirSync(area, { mode: 0o700 });
  same(await records(host), before, 'starting_original_records');
  const original = await snapshot();
  check(allFenced(await fences(), null), 'starting_source_fences_clear');

  stage('snapshot_during_committed_change');
  // A new alias for an existing session is a valid independent row. Its unique route is removed
  // by exact owner/session/key in finally; none of the pre-existing originals are rewritten.
  const aliasPage = original.pages.find(entry => entry.page.table === 'session_aliases' && entry.page.rows.length);
  assert.ok(aliasPage, 'seeded session alias required');
  const alias = Object.fromEntries(aliasPage.page.columns.map((column, index) => [column, aliasPage.page.rows[0][index]]));
  const channelBinding = bindings.find(binding => binding.purpose === 'channel');
  assert.ok(channelBinding, 'channel binding required');
  const temporaryRoute = `cp406-snapshot-${randomUUID()}`;
  const aliasKey = [channelBinding.storeId, channelBinding.agentId, alias.tenant_id, alias.principal_id, temporaryRoute, alias.session_id];
  let aliasInserted = false, changedDuringSnapshot = null;
  const collected = [];
  try {
    const manifest = await transferApi.exportPostgresAgent(host.pool, bindings, async (id, page) => {
      collected.push({ id, page });
      if (aliasInserted) return;
      assert.equal(page.table, 'works', 'change occurs before later session table is read');
      const added = await raw(host.pool,
        'INSERT INTO secumon_pg.session_aliases(store_id,agent_id,tenant_id,principal_id,route,session_id) VALUES($1,$2,$3,$4,$5,$6)', aliasKey);
      aliasInserted = true;
      assert.equal(added.rowCount, 1);
      const changed = await snapshot();
      check(changed.manifest.digest !== original.manifest.digest, 'separate_connection_sees_committed_alias');
      const aliasRows = changed.pages.filter(value => value.page.table === 'session_aliases')
        .flatMap(value => value.page.rows.map(row => Object.fromEntries(value.page.columns.map((column, i) => [column, row[i]]))));
      check(aliasRows.some(row => row.route === temporaryRoute && row.session_id === alias.session_id), 'changed_alias_is_present_in_fresh_snapshot');
      changedDuringSnapshot = changed.manifest.digest;
    });
    same({ manifest, pages: collected }, original, 'repeatable_read_excludes_later_committed_change');
  } finally {
    if (aliasInserted) {
      const removed = await raw(host.pool,
        'DELETE FROM secumon_pg.session_aliases WHERE store_id=$1 AND agent_id=$2 AND tenant_id=$3 AND principal_id=$4 AND route=$5 AND session_id=$6', aliasKey);
      assert.equal(removed.rowCount, 1, 'only this scenario alias removed');
    }
  }
  same(await snapshot(), original, 'all_original_pg_pages_restored_after_temporary_alias');

  stage('backup_manifest_last_and_writer_fence');
  const partial = join(area, 'partial-before-manifest'), partialId = randomUUID();
  const normalStore = await storeApi.PostgresStore.open(host.pool, bindings.find(binding => binding.purpose === 'state'));
  let writeDenied = false, writeBodyEntered = false, manifestInterrupted = false;
  const partialPool = interceptPool(host.pool, {
    async afterQuery({ sql }) {
      if (writeDenied || !/^FETCH FORWARD /.test(sql)) return;
      writeDenied = true;
      await expectFailure(() => normalStore.write(async () => { writeBodyEntered = true; }), 'postgres_store_maintenance');
      assert.equal(writeBodyEntered, false, 'ordinary write body never starts while backup fence owns bindings');
    },
  });
  const metadata = metadataApi.hostMetadataFiles();
  const originalInspect = metadata.inspectDirectory, originalRead = metadata.readStableRegularFile;
  const directoryPaths = new Map();
  const objectKey = reference => `${reference.identity.volume}:${reference.identity.object}`;
  metadata.inspectDirectory = function(path, access, expected) {
    const reference = originalInspect.call(this, path, access, expected);
    if (reference) directoryPaths.set(objectKey(reference), resolve(path));
    return reference;
  };
  metadata.readStableRegularFile = function(reference, leaf, policy) {
    if (!manifestInterrupted && leaf === 'identity.json' &&
      directoryPaths.get(objectKey(reference)) === join(partial, 'data', '.secumon')) {
      check(writeDenied && !writeBodyEntered, 'normal_storage_write_rejected_during_backup');
      check(!existsSync(join(partial, 'backup.json')), 'manifest_absent_after_copy_and_pg_export');
      check(readdirSync(join(partial, 'pages')).length === original.manifest.pages.length, 'all_exported_pages_precede_manifest');
      check(existsSync(join(partial, 'data', 'config.json')), 'local_copy_precedes_manifest');
      manifestInterrupted = true;
      throw injected('cp406_before_backup_manifest');
    }
    return originalRead.call(this, reference, leaf, policy);
  };
  try {
    await expectFailure(() => backupAgentPostgres(profiles, directory, partial,
      { selection: host.selection, pool: partialPool }, { offline: true, operationId: partialId }), 'cp406_before_backup_manifest');
  } finally {
    metadata.inspectDirectory = originalInspect;
    metadata.readStableRegularFile = originalRead;
    await normalStore.close();
  }
  check(manifestInterrupted, 'manifest_interruption_reached');
  await expectFailure(() => inspectAgentPostgresBackup(partial), 'lifecycle_backup_missing');
  const partialTree = captureLifecycleTree(partial);
  check(partialTree.length > 0, 'incomplete_backup_preserved_as_evidence');
  check(allFenced(await fences(), null), 'ordinary_backup_failure_releases_db_fences');
  same(await records(host), before, 'manifest_failure_preserves_original_records');

  stage('backup_maintenance_commit_response_lost');
  const archive = join(area, 'backup-after-unknown'), backupId = randomUUID();
  let backupCommitLost = false;
  const uncertainBackupPool = interceptPool(host.pool, {
    beforeQuery({ sql, state }) {
      if (/^BEGIN /.test(sql)) state.cp406Acquire = false;
      if (sql.startsWith('UPDATE secumon_pg.bindings SET maintenance_id=$4')) state.cp406Acquire = true;
    },
    afterQuery({ sql, state }) {
      if (sql === 'COMMIT' && state.cp406Acquire && !backupCommitLost) {
        backupCommitLost = true;
        throw injected('cp406_backup_commit_response_lost');
      }
    },
  });
  await expectFailure(() => backupAgentPostgres(profiles, directory, archive,
    { selection: host.selection, pool: uncertainBackupPool }, { offline: true, operationId: backupId }), 'postgres_commit_outcome_unknown');
  check(backupCommitLost, 'actual_backup_acquire_commit_precedes_response_loss');
  check(!existsSync(archive), 'unknown_acquire_does_not_publish_backup_directory');
  const unknownBackupFences = await fences();
  check(allFenced(unknownBackupFences, backupId), 'unknown_backup_commit_keeps_exact_db_fence');
  await expectFailure(async () => {
    const store = await storeApi.PostgresStore.open(host.pool, bindings[0]); await store.close();
  }, 'postgres_store_maintenance');
  same(await snapshot(host.pool, backupId), original, 'unknown_backup_commit_preserves_all_pg_originals');
  const backup = await backupAgentPostgres(profiles, directory, archive, host, { offline: true, operationId: backupId });
  const inspected = await inspectAgentPostgresBackup(archive);
  same(inspected.manifest, backup.manifest, 'same_backup_operation_publishes_valid_manifest');
  same(inspected.transfer, original.manifest, 'resumed_backup_keeps_original_pg_snapshot');
  check(allFenced(await fences(), null), 'resumed_backup_releases_db_fences');
  same(await records(host), before, 'backup_unknown_retry_preserves_original_records');
  same(captureLifecycleTree(partial), partialTree, 'partial_backup_evidence_remains_unchanged');

  stage('restore_import_commit_response_lost');
  const schemas = { state: stateApi.POSTGRES_STATE_SCHEMA, knowledge: knowledgeApi.POSTGRES_KNOWLEDGE_SCHEMA,
    channel: channelApi.POSTGRES_CHANNEL_SCHEMA };
  for (const binding of bindings) {
    assert.ok(schemas[binding.purpose]);
    await storeApi.provisionPostgresStore(restoreHost.pool, binding, schemas[binding.purpose]);
  }
  check((await snapshot(restoreHost.pool)).manifest.pages.every(page => page.rows === 0), 'restore_database_has_empty_bound_tables');
  const identityHead = identityApi.inspectAgentHostIdentity(profiles.inspect(directory), identityOptions);
  assert.ok(identityHead, 'registered original host identity');
  const archiveTree = captureLifecycleTree(archive), originalTree = captureLifecycleTree(directory);
  const preserved = join(area, 'preserved-original-agent');
  const floorPath = join(area, 'host-restore-floor.json');
  writeFileSync(floorPath, JSON.stringify({ agentId: backup.manifest.agentId, backupDigest: backup.manifest.digest }), { flag: 'wx', mode: 0o600 });
  const restoreId = randomUUID(), restoreInput = { operationId: restoreId, expectedDigest: backup.manifest.digest,
    offline: true, currentFloor: JSON.parse(readFileSync(floorPath, 'utf8')) };
  renameSync(directory, preserved);
  let restoreCommitLost = false;
  const uncertainRestorePool = interceptPool(restoreHost.pool, {
    beforeQuery({ sql, state }) {
      if (/^BEGIN /.test(sql)) state.cp406Import = false;
      if (sql.startsWith('INSERT INTO secumon_pg.transfers')) state.cp406Import = true;
    },
    afterQuery({ sql, state }) {
      if (sql === 'COMMIT' && state.cp406Import && !restoreCommitLost) {
        restoreCommitLost = true;
        throw injected('cp406_restore_import_response_lost');
      }
    },
  });
  await expectFailure(() => restoreAgentPostgresBackup(profiles, archive, directory,
    { selection: restoreHost.selection, pool: uncertainRestorePool }, restoreInput), 'postgres_commit_outcome_unknown');
  check(restoreCommitLost, 'actual_restore_import_commit_precedes_response_loss');
  const markerPath = join(directory, '.secumon-restore-in-progress.json');
  const markerBytes = readFileSync(markerPath), marker = JSON.parse(markerBytes.toString('utf8'));
  check(marker.operationId === restoreId && Boolean(marker.restorationId), 'interrupted_restore_preserves_operation_and_nonce');
  check(!existsSync(join(directory, '.secumon-postgres-restore-complete.json')), 'interrupted_restore_has_no_completion_marker');
  await expectFailure(() => openPublicStores(restoreHost), 'agent_restore_incomplete');
  same(readFileSync(markerPath), markerBytes, 'rejected_open_keeps_original_pending_marker_bytes');
  const unknownRestoreFences = await fences(restoreHost.pool);
  check(allFenced(unknownRestoreFences, restoreId), 'unknown_import_keeps_exact_restore_fence');
  same(await snapshot(restoreHost.pool, restoreId), original, 'unknown_import_retains_exact_original_pg_rows');
  const restored = await restoreAgentPostgresBackup(profiles, archive, directory, restoreHost, restoreInput);
  check(restored.restorationId === marker.restorationId, 'same_restore_operation_keeps_original_nonce');
  check(!existsSync(markerPath), 'successful_retry_removes_pending_marker');
  check(allFenced(await fences(restoreHost.pool), null), 'successful_restore_retry_releases_db_fences');
  same(await snapshot(restoreHost.pool), original, 'restore_retry_does_not_duplicate_imported_rows');
  same(captureLifecycleTree(preserved), originalTree, 'whole_original_agent_preserved_after_retry');
  same(captureLifecycleTree(archive), archiveTree, 'whole_backup_preserved_after_retry');

  stage('restore_rebind_and_original_inventory_reconciliation');
  await expectFailure(() => openPublicStores(restoreHost), 'agent_host_identity_duplicate_identity');
  await rebindApi.rebindRestoredAgentHostIdentity({ kind: 'postgres', directory, backupDirectory: archive,
    operationId: restoreId, expectedBackupDigest: backup.manifest.digest, expectedHeadDigest: identityHead.digest, offline: true }, identityOptions);
  await expectFailure(() => openPublicStores(restoreHost), 'agent_restore_reconciliation_required');
  const sourceId = 'cp406-preserved-pg-local-originals';
  const reportOriginals = async (basis, signal) => {
    signal.throwIfAborted();
    const source = await snapshot(), restoredSnapshot = await snapshot(restoreHost.pool);
    const kept = captureLifecycleTree(preserved), saved = captureLifecycleTree(archive);
    const consistent = isDeepStrictEqual(source, original) && isDeepStrictEqual(restoredSnapshot, original) &&
      isDeepStrictEqual(kept, originalTree) && isDeepStrictEqual(saved, archiveTree);
    signal.throwIfAborted();
    return { sourceId, sourceRevision: '1', basisDigest: basis.digest, status: consistent ? 'consistent' : 'unresolved',
      sourceHead: lifecycleDigest({ source, restored: restoredSnapshot, preserved: kept, archive: saved }), evidence: [
        { reference: 'fixture:live-source-pg', digest: lifecycleDigest(source) },
        { reference: 'fixture:live-restored-pg', digest: lifecycleDigest(restoredSnapshot) },
        { reference: 'fixture:preserved-local-originals', digest: lifecycleDigest(kept) },
        { reference: 'fixture:original-backup', digest: lifecycleDigest(saved) }],
      unresolved: consistent ? [] : ['cp406_original_inventory_changed'] };
  };
  const source = { revision: '1', inspect: reportOriginals,
    async verify(basis, previous, signal) { return isDeepStrictEqual(await reportOriginals(basis, signal), previous); } };
  check((await reconcileApi.reconcileAgentRestore(profiles, { directory, offline: true },
    { ...identityOptions, sources: new Map([[sourceId, source]]) })).status === 'reconciled', 'fresh_actual_original_inventory_reconciled');
  check(reconcileApi.inspectAgentRestoreReconciliation(profiles, directory, identityOptions).status === 'reconciled', 'fresh_reconciliation_is_durable');
  same(await records(restoreHost), before, 'restored_task_memory_conversation_and_context_originals');
  same(await snapshot(restoreHost.pool), original, 'reopened_stores_do_not_replay_work');

  stage('old_migration_command_refused_and_fence_preserved');
  // Last on purpose: this old management operation keeps a durable fence on the restored DB.
  // Do not turn a missing management receipt into clearance or remove its fence in the fixture.
  const beforeOldCommand = captureLifecycleTree(directory), oldOperation = migration.operation;
  await expectFailure(() => migrationApi.applyAgentPostgresMigration(profiles, directory, restoreHost, {
    operationId: oldOperation.operationId, expectedSnapshotDigest: oldOperation.snapshot.digest, offline: true,
  }), 'agent_postgres_migration_receipt_missing');
  const oldMigrationFences = await fences(restoreHost.pool);
  check(allFenced(oldMigrationFences, oldOperation.operationId), 'old_migration_refusal_retains_its_management_fence');
  same(await snapshot(restoreHost.pool, oldOperation.operationId), original, 'old_management_refusal_keeps_original_pg_rows_and_work_receipts');
  same(captureLifecycleTree(directory), beforeOldCommand, 'old_management_refusal_keeps_restored_local_originals');
  same(captureLifecycleTree(preserved), originalTree, 'preserved_original_agent_unchanged_at_end');
  same(captureLifecycleTree(archive), archiveTree, 'original_backup_unchanged_at_end');
  same(captureLifecycleTree(partial), partialTree, 'partial_backup_unchanged_at_end');
  same(await snapshot(), original, 'source_pg_originals_unchanged_at_end');
  check(allFenced(await fences(), null), 'source_pg_fences_clear_at_end');
  return { report: { scope: 'V10-07/08 actual PostgreSQL snapshot and exception recovery subset', checks,
    injection: 'actual database COMMIT followed by a host response exception; no SIGKILL or physical network cut',
    snapshot: { originalDigest: original.manifest.digest, changedDuringSnapshot, restoredToOriginal: true },
    backup: { operationId: backupId, digest: backup.manifest.digest, partial, archive, unknownFences: unknownBackupFences },
    restore: { operationId: restoreId, restorationId: restored.restorationId, preserved, unknownFences: unknownRestoreFences,
      rebindAndFreshReconciliation: true, originalRecordsDigest: lifecycleDigest(before) },
    oldMigration: { refused: 'agent_postgres_migration_receipt_missing', operationId: oldOperation.operationId,
      retainedFences: oldMigrationFences, automaticFenceRemoval: false },
    modelCalls: 0, workflowExecutions: 0, productionServiceEffects: 0,
    remaining: ['SIGKILL/power-loss and native Windows', 'capacity boundaries', 'late production effects and deletion/retraction reconciliation'],
  } };
}
