// Evidence-only V10-07: one actual PostgreSQL 64MiB overflow, with valid pending session originals.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { FileAgentProfileStore } from '../dist/infrastructure/file-agent-profile.js';
import { openAgentStores } from '../dist/infrastructure/agent-stores.js';
import { openAgentLocalProfile } from '../dist/presentation/local-profile.js';
import { LocalWorkbench } from '../dist/presentation/local-workbench.js';
import { prepareAgentPostgresMigration, applyAgentPostgresMigration } from '../dist/infrastructure/agent-postgres-migration.js';
import { postgresAgentBinding } from '../dist/infrastructure/agent-postgres-storage.js';
import { postgresTransaction, assertPostgresBindings, postgresInteger } from '../dist/infrastructure/postgres-store.js';
import { TRANSFER_TABLES } from '../dist/infrastructure/postgres-transfer-tables.js';
import { TRANSFER_LIMITS } from '../dist/infrastructure/postgres-transfer.js';
import { backupAgentPostgres, inspectAgentPostgresBackup } from '../dist/infrastructure/agent-postgres-backup.js';
import { captureLifecycleTree, lifecycleDigest } from '../dist/infrastructure/agent-lifecycle-files.js';
import { AGENT_LOCAL_RESTORE_COMPLETION } from '../dist/application/agent-lifecycle-contracts.js';
import { AGENT_RESTORE_RECONCILIATION, AGENT_RESTORE_RECONCILIATION_PENDING } from '../dist/application/agent-restore-reconciliation-contracts.js';
import { canonical, Sha256Digester } from '../dist/infrastructure/digest.js';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

let stage = 'configuration';
const pools = [], opened = new Set();
const emit = value => { if (value.stage) stage = value.stage; process.stdout.write(JSON.stringify(value) + '\n'); };
function errorCodes(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return [];
  seen.add(error);
  return [...[error.code, error.message].filter(value => typeof value === 'string' && /^[A-Za-z0-9_]+$/.test(value)),
    ...errorCodes(error.cause, seen), ...(Array.isArray(error.errors) ? error.errors.flatMap(item => errorCodes(item, seen)) : [])];
}
async function expectFailure(action, code) {
  try { await action(); } catch (error) { if (errorCodes(error).includes(code)) return error; throw error; }
  assert.fail('expected_refusal_not_observed_' + code);
}
const required = key => { const value = process.env[key]; assert.ok(value, 'missing_' + key); return value; };
async function close(value) { try { await value.close(); } finally { opened.delete(value); } }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const treeSummary = entries => ({ digest: lifecycleDigest(entries), entries: entries.length,
  bytes: entries.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.bytes : 0), 0) });
// Match the normal backup's coordination exclusions; original DB/WAL/artifacts and migration receipts remain included.
const backupInclude = path => path !== '.secumon/runtime-leases' && !path.startsWith('.secumon/runtime-leases/') &&
  path !== '.secumon/lifecycle-maintenance.json' && path !== '.secumon-postgres-restore-complete.json' &&
  path !== AGENT_LOCAL_RESTORE_COMPLETION && path !== AGENT_RESTORE_RECONCILIATION && path !== AGENT_RESTORE_RECONCILIATION_PENDING &&
  !['.secumon/runtime.sqlite-shm', '.secumon/channel.sqlite-shm', 'memory/memory.sqlite-shm'].includes(path);

try {
  const runtimeRoot = realpathSync(process.cwd()), root = required('SECUMON_PG_CASE_ROOT');
  assert.ok(isAbsolute(root) && !existsSync(root), 'fresh_absolute_case_root');
  const nested = (a, b) => { const part = relative(a, b); return part === '' || !part.startsWith('..') && !isAbsolute(part); };
  assert.ok(!nested(root, runtimeRoot) && !nested(runtimeRoot, root), 'engine_case_disjoint');
  const database = required('SECUMON_PG_SOURCE_DATABASE');
  assert.equal(database, 'secumon407_capacity_source', 'dedicated_capacity_database');
  const socket = required('SECUMON_PG_SOCKET'), port = Number(required('SECUMON_PG_PORT'));
  assert.ok(isAbsolute(socket) && Number.isSafeInteger(port) && port > 0 && port < 65536, 'explicit_unix_socket');
  const { Pool } = createRequire(required('SECUMON_PG_HOST_PACKAGE'))('pg');
  const pool = new Pool({ host: socket, port, user: required('SECUMON_PG_USER'), database, ssl: false,
    max: 4, connectionTimeoutMillis: 10000, idleTimeoutMillis: 1000, application_name: 'secumon_c10_capacity' });
  pool.on('error', error => { emit({ kind: 'pool_error', codes: errorCodes(error) }); process.exitCode = 1; });
  pools.push(pool);
  const initialDatabase = await postgresTransaction(pool, false, async client =>
    (await client.query("SELECT current_database() AS database, to_regnamespace('secumon_pg')::text AS schema, current_setting('server_version') AS version")).rows[0]);
  assert.equal(initialDatabase.database, database); assert.equal(initialDatabase.schema, null, 'fresh_database_schema');
  mkdirSync(root, { mode: 0o700 });
  const build = await verifyEvaluationBuild(runtimeRoot);
  const runnerPath = join(runtimeRoot, 'evidence', 'C10-postgres-capacity-fixture.mjs'), runnerBytes = readFileSync(runnerPath);
  const runner = { name: 'C10-postgres-capacity-fixture.mjs', bytes: runnerBytes.length, sha256: sha256(runnerBytes) };
  const configuration = { backend: 'sqlite', personalMemory: 'sqlite', postgresVersion: initialDatabase.version,
    sourceDatabase: database, transport: 'private_unix_socket', inputCount: 224, charactersPerInput: 100000,
    transferLimitBytes: TRANSFER_LIMITS.totalBytes };
  assert.equal(TRANSFER_LIMITS.totalBytes, 64 * 1024 * 1024, 'existing_64MiB_limit');
  emit({ kind: 'capacity_stage', stage: 'seed_minimal_public_originals', configuration, build, runner });
  const timings = {}, checks = [];
  let started = performance.now();
  const directory = join(root, 'agent'), archive = join(root, 'overflow-backup');
  const profiles = new FileAgentProfileStore(runtimeRoot, { engineRegistryDirectory: join(root, 'engine-registry') });
  const ready = profiles.initialize(directory, { stateBackend: 'sqlite', personalMemory: 'sqlite' });
  const storeOptions = { identityRegistryDirectory: join(root, 'identity-registry') };
  const actor = { tenantId: 'synthetic', principalId: 'learner' }, conversation = 'postgres-capacity-fixture';
  const original = '[합성 예제] 원문 보존. 용량 초과 이후에도 원 대화와 개인기억을 보존한다.';
  const local = await openAgentLocalProfile(directory, { compactProvider: 'synthetic' }, undefined, storeOptions); opened.add(local);
  const workbench = new LocalWorkbench(local, actor, conversation);
  const accepted = await workbench.accept({ requestId: 'capacity-original', scenarioId: 'documents-simple', mode: 'auto', rawText: original });
  await workbench.memoryRemember({ id: 'capacity-memory', requestId: 'capacity-remember', title: '용량 원문',
    source: { kind: 'existing', sessionId: accepted.sessionId, messageId: 'capacity-original', quote: original } });
  const scope = (await local.runtime.state(accepted.workId)).conversation.session.scope;
  await close(local);
  const records = async pgHost => {
    const stores = await openAgentStores(profiles, directory, pgHost, storeOptions); opened.add(stores);
    try {
      const state = await stores.state.get(accepted.workId), events = await stores.state.events(accepted.workId, 0), receipts = [];
      assert.ok(state, 'original_work_exists');
      for (const commandId of new Set(events.map(event => event.commandId))) {
        const receipt = await stores.state.receipt(accepted.workId, commandId); assert.ok(receipt, 'original_receipt_exists'); receipts.push({ commandId, receipt });
      }
      const knowledgeScope = { agentId: ready.identity.agentId, partition: 'personal', principalId: actor.principalId };
      return { state, events, receipts, deliveries: await stores.state.deliveries(accepted.workId),
        originalInput: await stores.sessions.input(scope, 'capacity-original'),
        memory: await stores.knowledge.get(actor.tenantId, 'capacity-memory', knowledgeScope),
        memoryReceipt: await stores.knowledge.receipt(actor.tenantId, 'capacity-memory', 'capacity-remember', knowledgeScope),
        artifacts: captureLifecycleTree(ready.paths.artifacts) };
    } finally { await close(stores); }
  };
  const beforeMigration = await records(undefined);
  assert.ok(beforeMigration.memory && beforeMigration.memoryReceipt && beforeMigration.originalInput, 'real_memory_and_original_input');
  assert.equal(beforeMigration.state.budget.used.modelCalls, 0, 'no_model_calls');
  assert.equal(beforeMigration.state.budget.used.toolCalls, 0, 'no_tool_execution');
  assert.equal(beforeMigration.state.attempts.length, 0, 'no_workflow_attempts');
  const selection = { storeId: randomUUID(), registrationId: randomUUID(), purposes: ['state', 'knowledge', 'channel'] };
  const host = { selection, pool }, bindings = selection.purposes.map(purpose => postgresAgentBinding(ready, selection, purpose));
  const operationId = randomUUID();
  const prepared = await prepareAgentPostgresMigration(profiles, directory, { selection, operationId, offline: true });
  await applyAgentPostgresMigration(profiles, directory, host, { operationId, expectedSnapshotDigest: prepared.snapshot.digest, offline: true });
  assert.deepEqual(await records(host), beforeMigration, 'minimal_migration_preserves_public_originals');
  timings.prepareMs = performance.now() - started;
  checks.push('public_work_memory_session_seed_and_minimal_migration_preserved');

  emit({ kind: 'capacity_stage', stage: 'receive_224_valid_pending_inputs' });
  started = performance.now();
  const text = '가'.repeat(100000), textBytes = Buffer.byteLength(text), textSha256 = sha256(text), inputCount = 224;
  assert.equal(textBytes, 300000, 'actual_utf8_input_bytes');
  assert.ok(inputCount * textBytes > TRANSFER_LIMITS.totalBytes, 'text_alone_exceeds_total_limit');
  const stores = await openAgentStores(profiles, directory, host, storeOptions); opened.add(stores);
  const work = await stores.state.get(accepted.workId); assert.ok(work);
  assert.deepEqual(work.conversation.session.scope, scope, 'actual_bound_scope');
  const payload = { expectedGoalRevision: work.goal.revision, command: { kind: 'input', reason: 'queued' } };
  const digester = new Sha256Digester(), intakeDigest = digester.digest({ scope, text, payload, kind: 'input', workId: work.id });
  const originalSession = await stores.sessions.get(scope), intakeMetadata = [];
  for (let index = 0; index < inputCount; index++) {
    const messageId = `capacity-pending-${String(index + 1).padStart(3, '0')}`;
    const received = await stores.sessions.receive({ scope, messageId, digest: intakeDigest, text, payload,
      kind: 'input', workId: work.id, labels: work.policy.allowedLabels, receivedAt: Date.now() });
    assert.equal(received.created, true, 'new_valid_pending_input');
    assert.equal(received.input.status, 'pending', 'input_remains_pending');
    assert.equal(received.input.text, text, 'received_original_text');
    assert.equal(received.input.digest, intakeDigest, 'received_original_digest');
    assert.equal(received.input.sequence, originalSession.lastSequence + index + 1, 'normal_session_sequence');
    intakeMetadata.push({ messageId, sequence: received.input.sequence, receivedAt: received.input.receivedAt });
  }
  const receivedSession = await stores.sessions.get(scope);
  assert.equal(receivedSession.lastSequence, originalSession.lastSequence + inputCount, 'all_pending_intakes_recorded');
  assert.equal(receivedSession.activeInputSequence, originalSession.activeInputSequence, 'no_pending_input_applied');
  await close(stores);
  assert.deepEqual(await records(host), beforeMigration, 'pending_intakes_do_not_change_work_memory_receipts');
  timings.receiveMs = performance.now() - started;
  checks.push('224_original_pending_inputs_without_workflow_or_settlement');

  // No export manifest can cover an over-limit source. Read fixed tables with an ordinary read-only cursor instead.
  const databaseOriginals = () => postgresTransaction(pool, false, async client => {
    await assertPostgresBindings(client, bindings);
    const tables = [];
    for (const table of TRANSFER_TABLES.filter(table => selection.purposes.includes(table.purpose))) {
      const binding = bindings.find(value => value.purpose === table.purpose), hash = createHash('sha256');
      let rows = 0, rowBytes = 0;
      await client.query(`DECLARE capacity_original_cursor NO SCROLL CURSOR FOR SELECT ${table.columns.join(',')} FROM secumon_pg.${table.name} WHERE store_id=$1 AND agent_id=$2 ORDER BY ${table.key.join(',')}`, [binding.storeId, binding.agentId]);
      for (;;) {
        const batch = await client.query('FETCH FORWARD 16 FROM capacity_original_cursor');
        for (const row of batch.rows) {
          const values = table.columns.map(column => table.integers.includes(column) && row[column] !== null ? postgresInteger(row[column]) : row[column]);
          const encoded = canonical(values), bytes = Buffer.byteLength(encoded);
          hash.update(String(bytes) + ':'); hash.update(encoded); rows++; rowBytes += bytes;
        }
        if (batch.rows.length < 16) break;
      }
      await client.query('CLOSE capacity_original_cursor');
      tables.push({ table: table.name, rows, rowBytes, sha256: hash.digest('hex') });
    }
    const transfers = (await client.query('SELECT operation_id,snapshot_digest,purposes FROM secumon_pg.transfers WHERE store_id=$1 AND agent_id=$2 ORDER BY operation_id', [selection.storeId, ready.identity.agentId])).rows;
    const registrations = (await client.query('SELECT purpose,registration_id,schema_version,maintenance_id FROM secumon_pg.bindings WHERE store_id=$1 AND agent_id=$2 ORDER BY purpose', [selection.storeId, ready.identity.agentId])).rows;
    await assertPostgresBindings(client, bindings);
    return { tables, transferReceipts: { rows: transfers.length, sha256: sha256(canonical(transfers)) },
      registrations: { rows: registrations.length, sha256: sha256(canonical(registrations)) } };
  });
  const fences = () => postgresTransaction(pool, false, async client =>
    (await client.query('SELECT purpose,maintenance_id FROM secumon_pg.bindings WHERE store_id=$1 AND agent_id=$2 ORDER BY purpose', [selection.storeId, ready.identity.agentId])).rows);
  started = performance.now();
  const rowsBefore = await databaseOriginals();
  assert.ok(rowsBefore.tables.find(table => table.table === 'session_inbox').rowBytes > TRANSFER_LIMITS.totalBytes, 'actual_session_inbox_rows_exceed_limit');
  const localBefore = treeSummary(captureLifecycleTree(directory, backupInclude));
  const registryBefore = treeSummary(captureLifecycleTree(storeOptions.identityRegistryDirectory));
  const expectedFences = bindings.map(binding => ({ purpose: binding.purpose, maintenance_id: null })).sort((a, b) => a.purpose.localeCompare(b.purpose));
  assert.deepEqual(await fences(), expectedFences, 'no_management_fence_before_backup');
  timings.beforeReadMs = performance.now() - started;

  emit({ kind: 'capacity_stage', stage: 'existing_backup_rejects_total_transfer_overflow', inputBytes: inputCount * textBytes });
  assert.equal(existsSync(archive), false, 'fresh_backup_destination');
  started = performance.now();
  const overflow = await expectFailure(() => backupAgentPostgres(profiles, directory, archive, host,
    { operationId: randomUUID(), offline: true }), 'postgres_transfer_limit');
  timings.rejectedBackupMs = performance.now() - started;
  assert.equal(existsSync(archive), true, 'unfinished_backup_directory_preserved');
  assert.equal(existsSync(join(archive, 'backup.json')), false, 'no_completed_backup_manifest');
  assert.equal(existsSync(join(archive, 'data')), true, 'copied_local_data_preserved');
  assert.equal(existsSync(join(archive, 'pages')), true, 'partial_page_directory_preserved');
  const partialTree = captureLifecycleTree(archive), partial = treeSummary(partialTree);
  const copiedLocal = treeSummary(captureLifecycleTree(join(archive, 'data')));
  assert.deepEqual(copiedLocal, localBefore, 'incomplete_backup_local_copy_matches_original');
  const pageFiles = partialTree.filter(entry => entry.kind === 'file' && /^pages\/page-[0-9]{8}\.json$/.test(entry.path));
  const partialPageBytes = pageFiles.reduce((sum, entry) => sum + entry.bytes, 0);
  assert.ok(pageFiles.length > 0 && partialPageBytes > 0, 'already_written_pages_preserved');
  await expectFailure(() => inspectAgentPostgresBackup(archive), 'lifecycle_backup_missing');
  assert.deepEqual(treeSummary(captureLifecycleTree(archive)), partial, 'inspection_preserves_incomplete_backup');
  assert.deepEqual(await fences(), expectedFences, 'management_fences_released_after_overflow');
  assert.equal(existsSync(join(directory, '.secumon', 'lifecycle-maintenance.json')), false, 'local_management_lease_released');
  checks.push('total_transfer_limit_refusal_and_incomplete_backup_preservation');

  emit({ kind: 'capacity_stage', stage: 'recheck_all_original_rows_and_pending_inputs' });
  started = performance.now();
  assert.deepEqual(await databaseOriginals(), rowsBefore, 'all_table_original_rows_and_registrations_unchanged');
  assert.deepEqual(await records(host), beforeMigration, 'original_work_memory_conversation_receipts_unchanged');
  const after = await openAgentStores(profiles, directory, host, storeOptions); opened.add(after);
  assert.deepEqual(await after.sessions.get(scope), receivedSession, 'session_head_unchanged_after_refusal');
  for (const expected of intakeMetadata) {
    const input = await after.sessions.input(scope, expected.messageId); assert.ok(input, 'pending_original_exists');
    assert.deepEqual(input, { scope, messageId: expected.messageId, digest: intakeDigest, text, payload, kind: 'input', workId: work.id,
      labels: work.policy.allowedLabels, receivedAt: expected.receivedAt, sequence: expected.sequence, status: 'pending', rejection: null }, 'pending_original_exactly_preserved');
  }
  await close(after);
  assert.deepEqual(treeSummary(captureLifecycleTree(directory, backupInclude)), localBefore, 'local_raw_files_unchanged');
  assert.deepEqual(treeSummary(captureLifecycleTree(storeOptions.identityRegistryDirectory)), registryBefore, 'host_identity_registry_unchanged');
  assert.deepEqual(await fences(), expectedFences, 'final_management_fences_clear');
  assert.deepEqual(await verifyEvaluationBuild(runtimeRoot), build, 'runtime_build_unchanged');
  assert.equal(sha256(readFileSync(runnerPath)), runner.sha256, 'runner_unchanged_during_execution');
  timings.afterReadMs = performance.now() - started;
  checks.push('all_pending_originals_and_work_memory_session_receipts_preserved');
  const result = { kind: 'postgres_capacity_acceptance', status: 'passed', scope: 'existing_V10_07_total_64MiB_overflow_only',
    configuration, build, runner, checks, timings,
    inputs: { count: inputCount, charactersEach: text.length, utf8BytesEach: textBytes, totalUtf8Bytes: inputCount * textBytes,
      textSha256, intakeDigest, allPending: true },
    refusalCodes: errorCodes(overflow), backup: { completeManifest: false, partialPages: pageFiles.length, partialPageBytes,
      partialTree: partial, localCopy: copiedLocal },
    preservation: { originalRecordsDigest: sha256(canonical(beforeMigration)), database: rowsBefore,
      local: localBefore, identityRegistry: registryBefore, finalFences: expectedFences },
    actualModelApiCalls: 0, workflowRuns: 0, toolExecutions: 0, productionEffects: 0, dataRetained: true };
  // Close real owners before publishing success. Oversized originals and the incomplete backup remain on disk/DB.
  await pool.end(); pools.splice(pools.indexOf(pool), 1);
  assert.notEqual(process.exitCode, 1, 'no_background_pool_error');
  writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  emit(result);
} catch (error) {
  emit({ kind: 'postgres_capacity_acceptance', status: 'failed', stage, codes: errorCodes(error),
    assertion: error?.code === 'ERR_ASSERTION' && /^[A-Za-z0-9_]+$/.test(String(error.message).split('\n')[0]) ? String(error.message).split('\n')[0] : null,
    frames: typeof error?.stack === 'string' ? error.stack.split('\n').slice(1, 5).filter(line => /^\s+at /.test(line)) : [], dataRetained: true });
  process.exitCode = 1;
} finally {
  for (const value of opened) try { await value.close(); } catch (error) { emit({ kind: 'cleanup_failed', stage: 'stores_close', codes: errorCodes(error) }); process.exitCode = 1; }
  for (const pool of pools) try { await pool.end(); } catch (error) { emit({ kind: 'cleanup_failed', stage: 'pool_close', codes: errorCodes(error) }); process.exitCode = 1; }
}
