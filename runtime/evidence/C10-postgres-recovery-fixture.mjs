import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { FileAgentProfileStore } from '../dist/infrastructure/file-agent-profile.js';
import { openAgentStores } from '../dist/infrastructure/agent-stores.js';
import { openAgentLocalProfile } from '../dist/presentation/local-profile.js';
import { LocalWorkbench } from '../dist/presentation/local-workbench.js';
import { postgresAgentBinding } from '../dist/infrastructure/agent-postgres-storage.js';
import { exportPostgresAgent } from '../dist/infrastructure/postgres-transfer.js';
import { readPostgresTransferPage } from '../dist/infrastructure/postgres-transfer-files.js';
import { sameOriginalTransferRows } from './C10-postgres-real-pages.mjs';
import { postgresTransaction } from '../dist/infrastructure/postgres-store.js';
import { captureLifecycleTree, lifecycleDigest } from '../dist/infrastructure/agent-lifecycle-files.js';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';
import { verifyMigrationRecovery } from './C10-postgres-recovery-migration.mjs';
import { verifyEngineRecovery } from './C10-postgres-recovery-engine.mjs';
import { verifyBackupRecovery } from './C10-postgres-recovery-backup.mjs';

let stage = 'configuration';
const pools = [], opened = new Set();
const emit = value => { if (value.stage) stage = value.stage; process.stdout.write(JSON.stringify(value) + '\n'); };
function errorCodes(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return [];
  seen.add(error);
  return [...[error.code, error.message].filter(value => typeof value === 'string' && /^[A-Za-z0-9_]+$/.test(value)),
    ...errorCodes(error.cause, seen), ...(Array.isArray(error.errors) ? error.errors.flatMap(value => errorCodes(value, seen)) : [])];
}
async function expectFailure(action, code) {
  try { await action(); } catch (error) {
    const codes = errorCodes(error);
    if (typeof code === 'string' ? codes.includes(code) : codes.some(value => code.test(value))) return error;
    throw error;
  }
  assert.fail('expected_refusal_not_observed_' + String(code));
}
function interceptPool(pool, hooks) {
  return { async connect() {
    const client = await pool.connect(), state = { queries: [] };
    return {
      async query(sql, values) {
        state.queries.push(sql);
        await hooks.beforeQuery?.({ sql, values, state });
        const result = await client.query(sql, values);
        await hooks.afterQuery?.({ sql, values, result, state });
        return result;
      },
      release(error) { try { hooks.onRelease?.(error, state); } finally { client.release(error); } },
    };
  } };
}
const required = key => { const value = process.env[key]; assert.ok(value, 'missing_' + key); return value; };
async function close(value) { try { await value.close(); } finally { opened.delete(value); } }
try {
  const runtimeRoot = realpathSync(process.cwd()), root = required('SECUMON_PG_CASE_ROOT');
  const resumeAfter = process.env.SECUMON_PG_RESUME_AFTER;
  assert.ok(resumeAfter === undefined || resumeAfter === 'migration', 'supported_resume_stage');
  const resume = resumeAfter === 'migration';
  assert.ok(isAbsolute(root) && existsSync(root) === resume, 'explicit_fresh_or_existing_case_root');
  const nested = (a, b) => { const part = relative(a, b); return part === '' || !part.startsWith('..') && !isAbsolute(part); };
  assert.ok(!nested(runtimeRoot, root) && !nested(root, runtimeRoot), 'engine_case_disjoint');
  const backend = required('SECUMON_PG_STATE_BACKEND'); assert.ok(['sqlite', 'file-journal'].includes(backend));
  const sourceDatabase = required('SECUMON_PG_SOURCE_DATABASE'), restoreDatabase = required('SECUMON_PG_RESTORE_DATABASE');
  assert.notEqual(sourceDatabase, restoreDatabase);
  const socket = required('SECUMON_PG_SOCKET'), port = Number(required('SECUMON_PG_PORT'));
  assert.ok(isAbsolute(socket) && Number.isSafeInteger(port) && port > 0 && port < 65536);
  const { Pool } = createRequire(required('SECUMON_PG_HOST_PACKAGE'))('pg');
  const poolFor = database => {
    const pool = new Pool({ host: socket, port, user: required('SECUMON_PG_USER'), database, ssl: false,
      max: 6, connectionTimeoutMillis: 10000, idleTimeoutMillis: 1000, application_name: 'secumon_c10_recovery' });
    pool.on('error', error => { emit({ kind: 'pool_error', codes: errorCodes(error) }); process.exitCode = 1; });
    pools.push(pool); return pool;
  };
  if (!resume) mkdirSync(root, { mode: 0o700 });
  const build = await verifyEvaluationBuild(runtimeRoot);
  const files = ['C10-postgres-recovery-fixture.mjs', 'C10-postgres-recovery-migration.mjs',
    'C10-postgres-recovery-engine.mjs', 'C10-postgres-recovery-backup.mjs', 'C10-postgres-real-pages.mjs'].map(name => {
      const bytes = readFileSync(join(runtimeRoot, 'evidence', name));
      return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
  const directory = join(root, 'agent');
  const profiles = new FileAgentProfileStore(runtimeRoot, { engineRegistryDirectory: join(root, 'engine-registry') });
  const ready = profiles.initialize(directory, { stateBackend: backend, personalMemory: backend === 'sqlite' ? 'documents' : 'sqlite' });
  const savedMigration = resume ? JSON.parse(readFileSync(join(root, 'migration-result.json'), 'utf8')) : null;
  if (resume) {
    assert.equal(existsSync(join(root, 'engine-recovery')), false, 'resume_before_engine_creation_only');
    assert.equal(existsSync(join(root, 'engine-result.json')), false);
    assert.equal(existsSync(join(root, 'result.json')), false);
    assert.equal(savedMigration.operation.agentId, ready.identity.agentId);
    assert.equal(savedMigration.report.backend, backend);
    assert.equal(savedMigration.report.injectedBoundaries, 4);
    assert.equal(ready.postgresMigration?.phase, 'activated');
    assert.equal(ready.postgresMigration?.operationId, savedMigration.operation.operationId);
  }
  const selection = savedMigration?.operation.selection ?? { storeId: randomUUID(), registrationId: randomUUID(), purposes: ['state', 'knowledge', 'channel'] };
  const host = { selection, pool: poolFor(sourceDatabase) }, restoreHost = { selection, pool: poolFor(restoreDatabase) };
  const bindings = selection.purposes.map(purpose => postgresAgentBinding(ready, selection, purpose));
  const storeOptions = { identityRegistryDirectory: join(root, 'identity-registry') };
  const ctx = { root, runtimeRoot, directory, profiles, ready, host, restoreHost, bindings, storeOptions,
    identityOptions: { registryDirectory: storeOptions.identityRegistryDirectory, engineDirectories: [runtimeRoot] },
    emit, expectFailure, interceptPool };
  ctx.snapshot = async (pool = host.pool, maintenanceId) => {
    const pages = [];
    const manifest = await exportPostgresAgent(pool, bindings, async (id, page) => { pages.push({ id, page }); },
      maintenanceId === undefined ? {} : { maintenanceId });
    return { manifest, pages };
  };
  ctx.fences = async (pool = host.pool) => postgresTransaction(pool, false, async client =>
    (await client.query('SELECT purpose,maintenance_id FROM secumon_pg.bindings WHERE store_id=$1 AND agent_id=$2 ORDER BY purpose',
      [selection.storeId, ready.identity.agentId])).rows);
  emit({ kind: 'recovery_stage', stage: resume ? 'resume_migration_result' : 'seed_original_records', backend, build, files });
  const actor = { tenantId: 'synthetic', principalId: 'learner' }, conversation = 'postgres-recovery-fixture';
  let scope, workIds;
  if (!resume) {
  const original = '[합성 예제] 원문 보존. ' + '중단 후에도 이어갈 대화와 기억. '.repeat(100);
  const tail = '[합성 예제] 원문 보존. ' + 'compact 뒤의 원문. '.repeat(200);
  const local = await openAgentLocalProfile(directory, { compactProvider: 'synthetic' }, undefined, storeOptions); opened.add(local);
  const workbench = new LocalWorkbench(local, actor, conversation);
  const accepted = await workbench.accept({ requestId: 'recovery-original', scenarioId: 'documents-simple', mode: 'auto', rawText: original });
  const remember = { id: 'recovery-memory', requestId: 'recovery-remember', title: '복구 원문',
    source: { kind: 'existing', sessionId: accepted.sessionId, messageId: 'recovery-original', quote: original } };
  await workbench.memoryRemember(remember);
  await workbench.input(accepted.workId, { requestId: 'recovery-tail', expectedGoalRevision: 1, rawText: tail });
  const compact = await workbench.compact(accepted.workId, { requestId: 'recovery-compact', expectedGoalRevision: 1 });
  assert.equal(compact.status.stage, 'ready'); assert.ok(compact.status.summary);
  const completed = await workbench.accept({ requestId: 'recovery-completed', scenarioId: 'documents-simple', mode: 'auto', rawText: '[합성 예제] 원문 보존.' });
  await workbench.command(completed.workId, { requestId: 'recovery-run', kind: 'run', expectedGoalRevision: 1 });
  assert.equal((await local.runtime.state(completed.workId)).status, 'completed');
  scope = (await local.runtime.state(accepted.workId)).conversation.session.scope;
  workIds = [accepted.workId, completed.workId];
  await close(local);
  } else {
    ctx.before = JSON.parse(readFileSync(join(root, 'original-records.json'), 'utf8'));
    assert.equal(lifecycleDigest(ctx.before), savedMigration.report.originalRecordsDigest);
    scope = ctx.before.works[0].state.conversation.session.scope;
    workIds = ctx.before.works.map(value => value.state.id);
  }
  ctx.records = async pgHost => {
    const stores = await openAgentStores(ctx.profiles, directory, pgHost, storeOptions); opened.add(stores);
    try {
      const works = [];
      for (const id of workIds) {
        const state = await stores.state.get(id), events = await stores.state.events(id, 0), receipts = [];
        assert.ok(state);
        for (const commandId of new Set(events.map(event => event.commandId))) {
          const receipt = await stores.state.receipt(id, commandId); assert.ok(receipt); receipts.push({ commandId, receipt });
        }
        works.push({ state, events, receipts, deliveries: await stores.state.deliveries(id) });
      }
      const knowledgeScope = { agentId: ready.identity.agentId, partition: 'personal', principalId: actor.principalId };
      return { works, session: await stores.sessions.get(scope), summary: await stores.sessions.summaryHead(scope),
        inputs: await Promise.all(['recovery-original', 'recovery-tail', 'recovery-completed'].map(id => stores.sessions.input(scope, id))),
        memory: await stores.knowledge.get(actor.tenantId, 'recovery-memory', knowledgeScope),
        memoryReceipt: await stores.knowledge.receipt(actor.tenantId, 'recovery-memory', 'recovery-remember', knowledgeScope),
        artifacts: captureLifecycleTree(ready.paths.artifacts),
        documents: existsSync(join(directory, 'memory', 'documents')) ? captureLifecycleTree(join(directory, 'memory', 'documents')) : null };
    } finally { await close(stores); }
  };
  if (!resume) ctx.before = await ctx.records(undefined);
  assert.ok(ctx.before.memory && ctx.before.memoryReceipt && ctx.before.summary);
  if (!resume) writeFileSync(join(root, 'original-records.json'), JSON.stringify(ctx.before), { flag: 'wx', mode: 0o600 });
  else {
    assert.deepEqual(await ctx.records(host), ctx.before);
    await sameOriginalTransferRows(savedMigration.operation.snapshot,
      id => readPostgresTransferPage(join(directory, '.secumon', 'postgres-transfer'), id), await ctx.snapshot());
    assert.ok((await ctx.fences()).every(row => row.maintenance_id === null));
    emit({ kind: 'recovery_stage', stage: 'saved_migration_and_original_rows_revalidated', originalRecordsDigest: lifecycleDigest(ctx.before) });
  }
  const timings = {}, reports = {};
  let started = performance.now();
  ctx.migration = savedMigration ?? await verifyMigrationRecovery(ctx); reports.migration = ctx.migration.report;
  timings.migrationMs = resume ? null : performance.now() - started;
  if (!resume) writeFileSync(join(root, 'migration-result.json'), JSON.stringify(ctx.migration), { flag: 'wx', mode: 0o600 });
  started = performance.now();
  const engine = await verifyEngineRecovery(ctx); reports.engine = engine.report;
  ctx.profiles = engine.profiles; ctx.identityOptions = engine.identityOptions;
  timings.engineMs = performance.now() - started;
  assert.deepEqual(await ctx.records(host), ctx.before);
  writeFileSync(join(root, 'engine-result.json'), JSON.stringify(engine.report), { flag: 'wx', mode: 0o600 });
  started = performance.now();
  reports.backup = (await verifyBackupRecovery(ctx)).report;
  timings.backupMs = performance.now() - started;
  assert.deepEqual(await verifyEvaluationBuild(runtimeRoot), build);
  const result = { kind: 'postgres_recovery_acceptance', status: 'passed', backend, build, files, reports, timings, resumedAfter: resumeAfter ?? null,
    works: ctx.before.works.length, receipts: ctx.before.works.reduce((total, work) => total + work.receipts.length, 0),
    originalRecordsDigest: lifecycleDigest(ctx.before), externalModelApiCalls: 0, productionEffects: 0,
    finalRestoredFences: await ctx.fences(restoreHost.pool), dataRetained: true,
    limits: ['client/file API exception injection; no process kill, power-loss, or real network-failure claim',
      'synthetic read/channel inventory only; corporate effects, operational volume, and native Windows remain unverified'] };
  writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 }); emit(result);
} catch (error) {
  emit({ kind: 'postgres_recovery_acceptance', status: 'failed', stage, codes: errorCodes(error),
    assertion: error?.code === 'ERR_ASSERTION' ? String(error.message).split('\n')[0] : null,
    frames: typeof error?.stack === 'string' ? error.stack.split('\n').slice(1, 5).filter(line => /^\s+at /.test(line)) : [], dataRetained: true });
  process.exitCode = 1;
} finally {
  for (const value of opened) try { await value.close(); } catch (error) { emit({ kind: 'cleanup_failed', stage: 'stores_close', codes: errorCodes(error) }); process.exitCode = 1; }
  for (const pool of pools) try { await pool.end(); } catch (error) { emit({ kind: 'cleanup_failed', stage: 'pool_close', codes: errorCodes(error) }); process.exitCode = 1; }
}
