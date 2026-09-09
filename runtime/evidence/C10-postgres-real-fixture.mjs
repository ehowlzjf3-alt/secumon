// Evidence-only host harness. Run once per supplied fresh source/restore database pair.
// Uses real PostgreSQL and existing local synthetic workflow/compact APIs; no model/API transport.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

let stage = 'configuration';
const pools = [], opened = new Set(), checks = [];
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
function check(value, name) { assert.ok(value, name); checks.push(name); }
function same(left, right, name) { check(isDeepStrictEqual(left, right), name); }
function codes(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return [];
  seen.add(error);
  return [...(typeof error.code === 'string' && /^[A-Za-z0-9_]+$/.test(error.code) ? [error.code] : []),
    ...codes(error.cause, seen), ...(Array.isArray(error.errors) ? error.errors.flatMap(item => codes(item, seen)) : [])];
}
async function refusal(action, pattern, name) {
  let failed = false;
  try { await action(); } catch (error) {
    failed = pattern.test([error?.message, ...codes(error)].join(' '));
    if (!failed) throw error;
  }
  check(failed, name);
}
function env(name) { const value = process.env[name]; assert.ok(value, `missing_${name}`); return value; }
async function close(value) { try { await value.close(); } finally { opened.delete(value); } }

try {
  const runtimeRoot = realpathSync(process.cwd());
  const backend = env('SECUMON_PG_STATE_BACKEND');
  check(['sqlite', 'file-journal'].includes(backend), 'supported_state_backend');
  const testRoot = resolve(env('SECUMON_PG_CASE_ROOT'));
  check(isAbsolute(env('SECUMON_PG_CASE_ROOT')) && !existsSync(testRoot), 'fresh_absolute_case_root');
  const nested = (a, b) => { const part = relative(a, b); return part === '' || !part.startsWith('..') && !isAbsolute(part); };
  check(!nested(runtimeRoot, testRoot) && !nested(testRoot, runtimeRoot), 'case_and_engine_disjoint');
  mkdirSync(testRoot, { mode: 0o700 });
  const socket = env('SECUMON_PG_SOCKET'), port = Number(env('SECUMON_PG_PORT'));
  check(isAbsolute(socket) && Number.isSafeInteger(port) && port > 0 && port < 65536, 'explicit_unix_socket');
  const sourceDatabase = env('SECUMON_PG_SOURCE_DATABASE'), restoreDatabase = env('SECUMON_PG_RESTORE_DATABASE');
  check(sourceDatabase !== restoreDatabase, 'distinct_host_databases');
  const { Pool } = createRequire(env('SECUMON_PG_HOST_PACKAGE'))('pg');
  const poolFor = database => {
    const pool = new Pool({ host: socket, port, user: env('SECUMON_PG_USER'), database, ssl: false,
      max: 4, connectionTimeoutMillis: 10000, idleTimeoutMillis: 1000, application_name: 'secumon_c10_acceptance' });
    pool.on('error', error => { emit({ kind: 'pool_error', stage, codes: codes(error) }); process.exitCode = 1; });
    pools.push(pool); return pool;
  };
  const sourcePool = poolFor(sourceDatabase), restorePool = poolFor(restoreDatabase);
  const load = path => import(pathToFileURL(join(runtimeRoot, 'dist', path)).href);
  const { FileAgentProfileStore } = await load('infrastructure/file-agent-profile.js');
  const { openAgentStores } = await load('infrastructure/agent-stores.js');
  const { openAgentLocalProfile } = await load('presentation/local-profile.js');
  const { LocalWorkbench } = await load('presentation/local-workbench.js');
  const { prepareAgentPostgresMigration, applyAgentPostgresMigration } = await load('infrastructure/agent-postgres-migration.js');
  const { backupAgentPostgres, inspectAgentPostgresBackup, restoreAgentPostgresBackup } = await load('infrastructure/agent-postgres-backup.js');
  const { postgresAgentBinding } = await load('infrastructure/agent-postgres-storage.js');
  const { provisionPostgresStore } = await load('infrastructure/postgres-store.js');
  const { exportPostgresAgent } = await load('infrastructure/postgres-transfer.js');
  const { readPostgresTransferPage } = await load('infrastructure/postgres-transfer-files.js');
  const { sameOriginalTransferRows } = await import('./C10-postgres-real-pages.mjs');
  const { POSTGRES_STATE_SCHEMA } = await load('infrastructure/postgres-state.js');
  const { POSTGRES_KNOWLEDGE_SCHEMA } = await load('infrastructure/postgres-knowledge.js');
  const { POSTGRES_CHANNEL_SCHEMA } = await load('infrastructure/postgres-channel.js');
  const { inspectAgentHostIdentity } = await load('infrastructure/agent-host-identities.js');
  const { rebindRestoredAgentHostIdentity } = await load('infrastructure/agent-host-identity-recovery.js');
  const { reconcileAgentRestore, inspectAgentRestoreReconciliation } = await load('infrastructure/agent-restore-reconciliation.js');
  const { captureLifecycleTree, lifecycleDigest } = await load('infrastructure/agent-lifecycle-files.js');
  const { openHostSqliteDatabase } = await load('infrastructure/windows-sqlite.js');
  const { FileJournalStateRepository } = await load('infrastructure/file-journal-state.js');
  const directory = join(testRoot, 'agent'), archive = join(testRoot, 'backup'), preserved = join(testRoot, 'preserved-agent');
  let profiles = new FileAgentProfileStore(runtimeRoot, { engineRegistryDirectory: join(testRoot, 'engine-registry') });
  let identityOptions = { registryDirectory: join(testRoot, 'identity-registry'), engineDirectories: [runtimeRoot] };
  const storeOptions = () => ({ identityRegistryDirectory: identityOptions.registryDirectory });
  const ready = profiles.initialize(directory, { stateBackend: backend, personalMemory: backend === 'sqlite' ? 'documents' : 'sqlite' });
  const selection = { storeId: randomUUID(), registrationId: randomUUID(), purposes: ['state', 'knowledge', 'channel'] };
  const host = { selection, pool: sourcePool }, restoredHost = { selection, pool: restorePool };
  const bindings = selection.purposes.map(purpose => postgresAgentBinding(ready, selection, purpose));
  const snapshot = async (pool = sourcePool) => {
    const pages = [];
    const manifest = await exportPostgresAgent(pool, bindings, async (id, page) => { pages.push({ id, page }); });
    return { manifest, pages };
  };
  const actor = { tenantId: 'synthetic', principalId: 'learner' }, conversation = 'postgres-real-fixture';
  const original = '[합성 예제] 원문 보존. ' + '이관 전 대화와 기억의 원문. '.repeat(100);
  const tail = '[합성 예제] 원문 보존. ' + 'compact 뒤에도 이어갈 원문. '.repeat(200);
  const remember = { id: 'pg-original-memory', requestId: 'pg-remember', title: '이관 원문',
    source: { kind: 'existing', messageId: 'pg-original', quote: original } };
  const run = { requestId: 'pg-run', kind: 'run', expectedGoalRevision: 1 };
  stage = 'seed_local_originals';
  let local = await openAgentLocalProfile(directory, { compactProvider: 'synthetic' }, undefined, storeOptions()); opened.add(local);
  let workbench = new LocalWorkbench(local, actor, conversation);
  const accepted = await workbench.accept({ requestId: 'pg-original', scenarioId: 'documents-simple', mode: 'auto', rawText: original });
  check(Boolean(accepted.sessionId), 'persistent_session_created'); remember.source.sessionId = accepted.sessionId;
  const memory = await workbench.memoryRemember(remember);
  await workbench.input(accepted.workId, { requestId: 'pg-tail', expectedGoalRevision: 1, rawText: tail });
  const compacted = await workbench.compact(accepted.workId, { requestId: 'pg-compact', expectedGoalRevision: 1 });
  check(compacted.status.stage === 'ready' && Boolean(compacted.status.summary), 'real_compact_head_published');
  const completed = await workbench.accept({ requestId: 'pg-completed', scenarioId: 'documents-simple', mode: 'auto', rawText: '[합성 예제] 원문 보존.' });
  await workbench.command(completed.workId, run);
  check((await local.runtime.state(completed.workId)).status === 'completed', 'real_fixture_work_completed');
  const history = await workbench.history();
  const workIds = [accepted.workId, completed.workId];
  const scope = (await local.runtime.state(accepted.workId)).conversation.session.scope;
  await close(local);
  async function records(pg) {
    const stores = await openAgentStores(profiles, directory, pg, storeOptions()); opened.add(stores);
    try {
      const works = [];
      for (const id of workIds) {
        const state = await stores.state.get(id), events = await stores.state.events(id, 0), receipts = [];
        check(Boolean(state), 'original_work_exists');
        for (const commandId of new Set(events.map(event => event.commandId))) {
          const receipt = await stores.state.receipt(id, commandId); check(Boolean(receipt), 'original_receipt_exists');
          receipts.push({ commandId, receipt });
        }
        works.push({ state, events, receipts, deliveries: await stores.state.deliveries(id) });
      }
      const knowledgeScope = { agentId: ready.identity.agentId, partition: 'personal', principalId: actor.principalId };
      return { works, session: await stores.sessions.get(scope), summary: await stores.sessions.summaryHead(scope),
        inputs: await Promise.all(['pg-original', 'pg-tail', 'pg-completed'].map(id => stores.sessions.input(scope, id))),
        memory: await stores.knowledge.get(actor.tenantId, remember.id, knowledgeScope),
        memoryReceipt: await stores.knowledge.receipt(actor.tenantId, remember.id, remember.requestId, knowledgeScope),
        artifacts: captureLifecycleTree(ready.paths.artifacts),
        documents: existsSync(join(directory, 'memory', 'documents')) ? captureLifecycleTree(join(directory, 'memory', 'documents')) : null };
    } finally { await close(stores); }
  }
  const before = await records();
  check(Boolean(before.memory && before.memoryReceipt && before.summary), 'memory_receipt_summary_originals_present');
  stage = 'prepare_migration';
  const migrationId = randomUUID();
  const operation = await prepareAgentPostgresMigration(profiles, directory, { operationId: migrationId, selection, offline: true });
  same(await prepareAgentPostgresMigration(profiles, directory, { operationId: migrationId, selection, offline: true }), operation, 'prepare_retry_exact_operation');
  await refusal(() => openAgentStores(profiles, directory, host, storeOptions()), /agent_postgres_migration_resume_required/, 'pending_migration_blocks_open');
  stage = 'apply_migration';
  const applyInput = { operationId: migrationId, expectedSnapshotDigest: operation.snapshot.digest, offline: true };
  const activation = await applyAgentPostgresMigration(profiles, directory, host, applyInput);
  same(await applyAgentPostgresMigration(profiles, directory, host, applyInput), activation, 'activated_retry_exact_receipt');
  const migrated = await snapshot();
  await sameOriginalTransferRows(operation.snapshot,
    id => readPostgresTransferPage(join(ready.paths.metadata, 'postgres-transfer'), id), migrated);
  checks.push('imported_pg_original_rows_match_local_snapshot');
  same(await records(host), before, 'pg_reopen_preserves_full_originals');
  stage = 'retired_writer_refusal';
  if (backend === 'sqlite') {
    const db = openHostSqliteDatabase(ready.paths.state);
    try { await refusal(() => db.prepare('UPDATE works SET body=body WHERE id=?').run(accepted.workId),
      /agent_storage_migrated_to_postgres/, 'old_sqlite_writer_blocked'); } finally { db.close(); }
  } else await refusal(async () => { const repository = new FileJournalStateRepository(ready.paths.state,
    { owner: { agentId: ready.identity.agentId, kind: 'state' } }); await repository.close(); },
    /journal_format_invalid/, 'old_journal_writer_blocked');
  same(await snapshot(), migrated, 'writer_refusal_leaves_pg_unchanged');
  stage = 'pg_profile_reopen_and_duplicate';
  local = await openAgentLocalProfile(directory, { compactProvider: 'synthetic' }, host, storeOptions()); opened.add(local);
  workbench = new LocalWorkbench(local, actor, conversation, { sessionId: accepted.sessionId });
  same(await workbench.memoryGet(remember.id), memory, 'public_memory_after_pg_reopen');
  same(await workbench.history(), history, 'public_history_after_pg_reopen');
  check((await workbench.command(completed.workId, run)).duplicate, 'original_run_receipt_replayed');
  await close(local);
  same(await records(host), before, 'duplicate_run_preserves_state_receipts_usage');
  same(await snapshot(), migrated, 'duplicate_run_preserves_all_pg_rows');
  emit({ kind: 'postgres_real_migration', status: 'passed', backend, checks: [...new Set(checks)],
    snapshotDigest: migrated.manifest.digest, originalRecordsDigest: lifecycleDigest(before) });
  stage = 'engine_lifecycle';
  const { verifyPostgresEngineLifecycle } = await import('./C10-postgres-real-engine-fixture.mjs');
  const engine = await verifyPostgresEngineLifecycle({ testRoot, profiles, directory, host, identityOptions, snapshot,
    onProgress: name => { stage = `engine_${name}`; } });
  profiles = engine.profiles; identityOptions = engine.identityOptions;
  same(await records(host), before, 'engine_pin_does_not_recreate_original_records');
  stage = 'combined_backup';
  const backup = await backupAgentPostgres(profiles, directory, archive, host, { offline: true, operationId: randomUUID() });
  const inspected = await inspectAgentPostgresBackup(archive), sourceSnapshot = await snapshot();
  same(inspected.manifest, backup.manifest, 'backup_inspection_exact_manifest');
  same(inspected.transfer, sourceSnapshot.manifest, 'combined_backup_exact_pg_manifest');
  for (const { id, page } of sourceSnapshot.pages) same(await readPostgresTransferPage(join(archive, 'pages'), id), page, 'backup_page_original_bytes');
  const archiveTree = captureLifecycleTree(archive), currentTree = captureLifecycleTree(directory);
  const identityHead = inspectAgentHostIdentity(profiles.inspect(directory), identityOptions); check(Boolean(identityHead), 'registered_original_identity');
  // Host keeps this floor outside both archive and restored agent; the restore API never derives it from the archive.
  const floorPath = join(testRoot, 'host-restore-floor.json');
  writeFileSync(floorPath, JSON.stringify({ agentId: ready.identity.agentId, backupDigest: backup.manifest.digest }), { flag: 'wx', mode: 0o600 });
  const currentFloor = JSON.parse(readFileSync(floorPath, 'utf8'));
  stage = 'restore_target_provision';
  const schemas = { state: POSTGRES_STATE_SCHEMA, knowledge: POSTGRES_KNOWLEDGE_SCHEMA, channel: POSTGRES_CHANNEL_SCHEMA };
  for (const binding of bindings) await provisionPostgresStore(restorePool, binding, schemas[binding.purpose]);
  const empty = await snapshot(restorePool); check(empty.manifest.pages.every(page => page.rows === 0), 'restore_target_binding_has_no_rows');
  renameSync(directory, preserved);
  stage = 'restore_with_independent_floor';
  const restoreInput = { operationId: randomUUID(), expectedDigest: backup.manifest.digest, offline: true, currentFloor };
  const restored = await restoreAgentPostgresBackup(profiles, archive, directory, restoredHost, restoreInput);
  check(Boolean(restored.restorationId), 'restore_occurrence_nonce_persisted');
  same(await restoreAgentPostgresBackup(profiles, archive, directory, restoredHost, restoreInput), restored, 'restore_retry_preserves_occurrence');
  same(await snapshot(restorePool), sourceSnapshot, 'restored_pg_original_pages');
  same(captureLifecycleTree(preserved), currentTree, 'whole_previous_agent_preserved');
  same(captureLifecycleTree(archive), archiveTree, 'backup_originals_unchanged');
  await refusal(() => openAgentStores(profiles, directory, restoredHost, storeOptions()), /agent_host_identity_duplicate_identity/, 'restored_object_requires_explicit_rebind');
  stage = 'explicit_rebind';
  await rebindRestoredAgentHostIdentity({ kind: 'postgres', directory, backupDirectory: archive,
    operationId: restoreInput.operationId, expectedBackupDigest: backup.manifest.digest, expectedHeadDigest: identityHead.digest, offline: true }, identityOptions);
  await refusal(() => openAgentStores(profiles, directory, restoredHost, storeOptions()), /agent_restore_reconciliation_required/, 'rebind_is_not_effect_clearance');
  stage = 'read_only_effect_reconciliation';
  // The fixture's complete external inventory is the preserved source PG store and local synthetic read/channel originals.
  // No external write tool was registered. Both full live inventories must still equal the independently retained snapshot.
  const sourceId = 'fixture-pg-and-local-originals';
  const report = async (basis, signal) => {
    signal.throwIfAborted();
    const latest = await snapshot(), actual = await snapshot(restorePool);
    const consistent = isDeepStrictEqual(latest, sourceSnapshot) && isDeepStrictEqual(actual, sourceSnapshot) &&
      isDeepStrictEqual(captureLifecycleTree(preserved), currentTree) && isDeepStrictEqual(captureLifecycleTree(archive), archiveTree);
    signal.throwIfAborted();
    return { sourceId, sourceRevision: '1', basisDigest: basis.digest, status: consistent ? 'consistent' : 'unresolved',
      sourceHead: lifecycleDigest({ source: latest, restored: actual }), evidence: [
        { reference: 'fixture:original-live-pg-pages', digest: lifecycleDigest(latest) },
        { reference: 'fixture:restored-pg-pages', digest: lifecycleDigest(actual) },
        { reference: 'fixture:preserved-local-originals', digest: lifecycleDigest(currentTree) }],
      unresolved: consistent ? [] : ['fixture_original_inventory_changed'] };
  };
  const source = { revision: '1', inspect: report, async verify(basis, previous, signal) { return isDeepStrictEqual(await report(basis, signal), previous); } };
  check((await reconcileAgentRestore(profiles, { directory, offline: true }, { ...identityOptions, sources: new Map([[sourceId, source]]) })).status === 'reconciled', 'exact_local_inventory_reconciled');
  check(inspectAgentRestoreReconciliation(profiles, directory, identityOptions).status === 'reconciled', 'durable_restore_clearance');
  stage = 'restored_stores_reopen';
  same(await records(restoredHost), before, 'restored_public_stores_preserve_every_original');
  same(await records(restoredHost), before, 'second_restored_open_preserves_every_original');
  same(await snapshot(restorePool), sourceSnapshot, 'restored_open_does_not_replay_work');
  same(captureLifecycleTree(preserved), currentTree, 'retired_source_still_unchanged');
  same(captureLifecycleTree(archive), archiveTree, 'original_archive_still_unchanged');
  emit({ kind: 'postgres_real_acceptance', status: 'passed', backend, personalMemory: ready.effectivePersonalMemory.backend,
    checks: [...new Set(checks)], works: before.works.length, receipts: before.works.reduce((n, work) => n + work.receipts.length, 0),
    sessionHeadPresent: Boolean(before.session.head), compactHeadPresent: Boolean(before.summary),
    snapshotDigest: sourceSnapshot.manifest.digest, pages: sourceSnapshot.manifest.pages.length,
    rows: sourceSnapshot.manifest.pages.reduce((n, page) => n + page.rows, 0), originalRecordsDigest: lifecycleDigest(before),
    backupDigest: backup.manifest.digest, restorationId: restored.restorationId, engine: engine.report,
    externalModelApiCalls: 0, productionEffects: 0, dataRetained: true,
    limits: ['normal real PostgreSQL flow; no injected COMMIT loss or SIGKILL in this script',
      'synthetic compact and local read/channel effects only; no real service reconciliation claim', 'native Windows not executed'] });
} catch (error) {
  emit({ kind: 'postgres_real_acceptance', status: 'failed', stage, codes: codes(error),
    messageCode: /^[a-z][a-z0-9_]+$/.test(error?.message ?? '') ? error.message : null,
    frames: typeof error?.stack === 'string' ? error.stack.split('\n').slice(1, 5).filter(line => /^\s+at /.test(line)) : [],
    assertion: error?.code === 'ERR_ASSERTION' && /^[A-Za-z0-9_]+$/.test(error.message ?? '') ? error.message : null, dataRetained: true });
  process.exitCode = 1;
} finally {
  for (const value of opened) try { await value.close(); } catch (error) { emit({ kind: 'cleanup_failed', stage: 'profile_close', codes: codes(error) }); process.exitCode = 1; }
  for (const pool of pools) try { await pool.end(); } catch (error) { emit({ kind: 'cleanup_failed', stage: 'pool_close', codes: codes(error) }); process.exitCode = 1; }
}
