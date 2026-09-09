// Evidence-only: real commits/publications followed by injected response loss, not process kill.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hostMetadataFiles } from '../dist/infrastructure/host-metadata-files.js';
import { openHostSqliteDatabase } from '../dist/infrastructure/windows-sqlite.js';
import { prepareAgentPostgresMigration, applyAgentPostgresMigration } from '../dist/infrastructure/agent-postgres-migration.js';
import { PostgresMigrationOperationSchema, PostgresMigrationActivationSchema, postgresMigrationPath,
  postgresActivationPath } from '../dist/infrastructure/agent-postgres-migration-profile.js';
import { readPostgresTransferPage } from '../dist/infrastructure/postgres-transfer-files.js';
import { transferPageDigest } from '../dist/infrastructure/postgres-transfer.js';
import { captureLifecycleTree, lifecycleDigest } from '../dist/infrastructure/agent-lifecycle-files.js';
import { canonical, sha256 } from '../dist/infrastructure/digest.js';
import { openAgentStores } from '../dist/infrastructure/agent-stores.js';

const fault = code => Object.assign(new Error(code), { code });
const equal = (left, right, label) => assert.ok(canonical(left) === canonical(right), label);
// Table-level row multisets preserve every scalar/body byte and duplicate; page order is backend-specific.
function rowGroups(pages) {
  const groups = new Map();
  for (const item of pages) {
    const page = item.page ?? item;
    let value = groups.get(page.table);
    if (!value) { value = { table: page.table, columns: page.columns, rows: [] }; groups.set(page.table, value); }
    equal(page.columns, value.columns, 'same_table_columns');
    value.rows.push(...page.rows.map(row => canonical(row)));
  }
  return [...groups.values()].sort((a, b) => a.table < b.table ? -1 : a.table > b.table ? 1 : 0)
    .map(value => ({ ...value, rows: value.rows.sort() }));
}
async function publicationLoss(leaf, operationId, action, expectFailure, code) {
  const files = hostMetadataFiles(), original = files.readStableRegularFile;
  let observed = 0, bytes;
  files.readStableRegularFile = function (directory, name, policy) {
    const result = original.call(this, directory, name, policy);
    if (observed === 0 && name === leaf) {
      const record = JSON.parse(Buffer.from(result).toString('utf8'));
      if (record.operationId === operationId) {
        observed++; bytes = Buffer.from(result); throw fault(code);
      }
    }
    return result;
  };
  try { await expectFailure(action, code); }
  finally { files.readStableRegularFile = original; }
  assert.equal(observed, 1, 'exact_metadata_publication_observed_once');
  return bytes;
}

export async function verifyMigrationRecovery(ctx) {
  const { directory, profiles, ready, host, bindings, before, records, snapshot, storeOptions, emit,
    expectFailure, interceptPool, fences } = ctx;
  const options = () => typeof storeOptions === 'function' ? storeOptions() : storeOptions;
  const operationId = randomUUID(), checks = [], pageRoot = join(ready.paths.metadata, 'postgres-transfer');
  const progress = stage => emit({ kind: 'postgres_migration_recovery', stage });
  const prepareInput = { operationId, selection: host.selection, offline: true };
  const metadataPath = postgresMigrationPath(directory), activationPath = postgresActivationPath(directory);
  progress('prepare_publication_loss');
  const operationBytes = await publicationLoss('postgres-migration.json', operationId,
    () => prepareAgentPostgresMigration(profiles, directory, prepareInput), expectFailure, 'fixture_prepare_publication_lost');
  assert.ok(readFileSync(metadataPath).equals(operationBytes), 'published_operation_original_bytes');
  const operation = PostgresMigrationOperationSchema.parse(JSON.parse(operationBytes.toString('utf8')));
  assert.equal(operation.operationId, operationId);
  const originalPageFiles = captureLifecycleTree(pageRoot), sourcePages = [];
  for (const expected of operation.snapshot.pages) {
    const page = await readPostgresTransferPage(pageRoot, expected.id);
    assert.equal(transferPageDigest(page), expected.digest, 'original_transfer_page_digest');
    sourcePages.push({ id: expected.id, page });
  }
  const expectedRows = rowGroups(sourcePages);
  const originalLocalFiles = captureLifecycleTree(directory);
  const originalPaths = new Set(operation.sources.flatMap(source => source.entries.map(entry => entry.path)));
  const originalSelectedFiles = originalLocalFiles.filter(entry => originalPaths.has(entry.path));
  const currentOriginals = () => {
    assert.ok(readFileSync(metadataPath).equals(operationBytes), 'operation_never_rewritten');
    equal(captureLifecycleTree(pageRoot), originalPageFiles, 'transfer_page_files_never_rewritten');
  };
  const pendingOpenDenied = async () => {
    await expectFailure(async () => {
      const stores = await openAgentStores(profiles, directory, host, options()); await stores.close();
    }, 'agent_postgres_migration_resume_required');
  };
  await pendingOpenDenied();
  equal(await prepareAgentPostgresMigration(profiles, directory, prepareInput), operation, 'same_prepare_original_operation');
  currentOriginals();
  equal(captureLifecycleTree(directory).filter(entry => originalPaths.has(entry.path)), originalSelectedFiles, 'prepare_preserves_local_sources');
  checks.push('prepare_record_published_response_lost_same_id_resume');

  const applyInput = { operationId, expectedSnapshotDigest: operation.snapshot.digest, offline: true };
  let importCommits = 0, discardedImportConnection = 0;
  const importPool = interceptPool(host.pool, {
    afterQuery({ sql, values, state }) {
      if (/^INSERT INTO secumon_pg\.transfers\b/.test(sql) && values?.[2] === operationId) state.migrationImported = true;
      if (sql.trim().toUpperCase() === 'COMMIT' && state.migrationImported && importCommits === 0) {
        importCommits++; throw fault('fixture_import_commit_response_lost');
      }
    },
    onRelease(error, state) { if (state.migrationImported && error) discardedImportConnection++; },
  });
  progress('import_commit_response_loss');
  await expectFailure(() => applyAgentPostgresMigration(profiles, directory, { ...host, pool: importPool }, applyInput),
    'postgres_commit_outcome_unknown');
  assert.equal(importCommits, 1, 'actual_import_commit_observed_once');
  assert.equal(discardedImportConnection, 1, 'unknown_import_connection_discarded');
  const expectedFence = bindings.map(binding => ({ purpose: binding.purpose, maintenance_id: operationId }))
    .sort((a, b) => a.purpose.localeCompare(b.purpose));
  const held = async () => equal(await fences(), expectedFence, 'exact_operation_fence_retained');
  const importedRows = async () => {
    currentOriginals(); await held();
    const value = await snapshot(host.pool, operationId);
    equal(rowGroups(value.pages), expectedRows, 'all_imported_original_rows_preserved');
    return value;
  };
  const afterImport = await importedRows();
  equal(captureLifecycleTree(directory).filter(entry => originalPaths.has(entry.path)), originalSelectedFiles, 'unknown_import_does_not_retire_local_sources');
  await pendingOpenDenied();
  checks.push('actual_import_commit_response_lost_rows_and_fence_retained');

  // Selection is sorted by the product. Both source backends retire channel (SQLite) first.
  // Exercise a real partial retirement with one original purpose committed; no synthetic state/header edits.
  const firstPurpose = operation.sources[0]?.purpose;
  assert.equal(firstPurpose, 'channel', 'first_retirement_is_exact_channel_source');
  const firstPath = resolve(join(ready.paths.metadata, 'channel.sqlite'));
  const originalExec = DatabaseSync.prototype.exec, marked = new WeakSet();
  let retirementCommits = 0, retiredRecord;
  DatabaseSync.prototype.exec = function (sql) {
    const result = originalExec.call(this, sql);
    if (sql.startsWith('CREATE TABLE secumon_postgres_retirement(')) marked.add(this);
    if (retirementCommits === 0 && marked.has(this) && sql.trim().toUpperCase() === 'COMMIT') {
      const main = this.prepare('PRAGMA database_list').all().find(value => value.name === 'main');
      if (main && resolve(String(main.file)) === firstPath) {
        const row = this.prepare('SELECT body FROM secumon_postgres_retirement').get();
        const value = row && JSON.parse(String(row.body));
        assert.equal(value?.operationId, operationId, 'retirement_belongs_to_exact_operation');
        assert.equal(value.agentId, ready.identity.agentId, 'retirement_belongs_to_exact_agent');
        assert.equal(value.snapshotDigest, operation.snapshot.digest, 'retirement_binds_exact_snapshot');
        retirementCommits++; retiredRecord = String(row.body); throw fault('fixture_retirement_response_lost');
      }
    }
    return result;
  };
  progress('first_source_retirement_commit_loss');
  try {
    await expectFailure(() => applyAgentPostgresMigration(profiles, directory, host, applyInput), 'fixture_retirement_response_lost');
  } finally { DatabaseSync.prototype.exec = originalExec; }
  assert.equal(retirementCommits, 1, 'one_source_retirement_committed');
  const retired = openHostSqliteDatabase(firstPath, { readOnly: true });
  try { assert.equal(retired.prepare('SELECT body FROM secumon_postgres_retirement').get().body, retiredRecord, 'retired_source_receipt_original'); }
  finally { retired.close(); }
  // Other sources must still match the prepared physical originals at this boundary.
  const otherPaths = new Set(operation.sources.slice(1).flatMap(source => source.entries.map(entry => entry.path)));
  equal(captureLifecycleTree(directory).filter(entry => otherPaths.has(entry.path)),
    originalLocalFiles.filter(entry => otherPaths.has(entry.path)), 'unretired_sources_unchanged');
  equal(await importedRows(), afterImport, 'partial_retirement_preserves_pg_snapshot');
  await pendingOpenDenied();
  checks.push('one_real_channel_retirement_committed_other_sources_preserved');

  progress('activation_publication_loss');
  const activationBytes = await publicationLoss('postgres-activation.json', operationId,
    () => applyAgentPostgresMigration(profiles, directory, host, applyInput), expectFailure, 'fixture_activation_publication_lost');
  assert.ok(readFileSync(activationPath).equals(activationBytes), 'activation_original_bytes');
  const publishedActivation = PostgresMigrationActivationSchema.parse(JSON.parse(activationBytes.toString('utf8')));
  assert.equal(profiles.inspect(directory).postgresMigration?.phase, 'activated', 'activation_is_durably_visible');
  equal(await importedRows(), afterImport, 'activation_preserves_pg_snapshot_and_fence');
  await expectFailure(async () => {
    const stores = await openAgentStores(profiles, directory, host, options()); await stores.close();
  }, 'postgres_store_maintenance');
  checks.push('activation_published_response_lost_runtime_fenced');

  progress('same_operation_final_resume');
  const activation = await applyAgentPostgresMigration(profiles, directory, host, applyInput);
  equal(activation, { ...publishedActivation, phase: 'activated' }, 'resume_returns_original_activation');
  equal(await fences(), expectedFence.map(value => ({ ...value, maintenance_id: null })), 'final_resume_releases_fences');
  currentOriginals(); assert.ok(readFileSync(activationPath).equals(activationBytes), 'activation_never_rewritten');
  equal(await snapshot(), afterImport, 'final_resume_pg_originals_unchanged');
  equal(await records(host), before, 'final_reopen_original_work_memory_session_receipts');
  equal(await applyAgentPostgresMigration(profiles, directory, host, applyInput), activation, 'final_duplicate_apply_no_new_activation');
  equal(await records(host), before, 'duplicate_apply_does_not_replay_work');
  currentOriginals();
  const report = { checks, injectedBoundaries: 4, processKills: 0, backend: ready.config.storage.state,
    partialRetirementPurpose: firstPurpose, operationDigest: lifecycleDigest(operation), operationBytesSha256: sha256(operationBytes),
    activationBytesSha256: sha256(activationBytes), originalRowsDigest: lifecycleDigest(expectedRows),
    tables: expectedRows.length, rows: expectedRows.reduce((total, value) => total + value.rows.length, 0),
    originalRecordsDigest: lifecycleDigest(before),
    limitations: ['Exception injection after real publication/commit; not SIGKILL or power loss',
      'Partial retirement interrupts channel SQLite first in both configurations; file-journal header-specific interruption not exercised'] };
  emit({ kind: 'postgres_migration_recovery', stage: 'complete', report });
  return { operation, activation, report };
}
