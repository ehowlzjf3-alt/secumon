import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AgentPostgresSelectionSchema } from '../dist/application/agent-profile-contracts.js';
import { FileAgentProfileStore } from '../dist/infrastructure/file-agent-profile.js';
import { provisionAgentPostgresStorage } from '../dist/infrastructure/agent-postgres-storage.js';
import { effectiveAgentPostgresSelection } from '../dist/infrastructure/agent-postgres-migration-profile.js';
import { prepareAgentPostgresMigration, applyAgentPostgresMigration } from '../dist/infrastructure/agent-postgres-migration.js';
import { backupAgentPostgres, inspectAgentPostgresBackup, restoreAgentPostgresBackup } from '../dist/infrastructure/agent-postgres-backup.js';
import { checkAgentPostgresLifecycle, pinAgentPostgresEngine } from '../dist/infrastructure/agent-postgres-lifecycle.js';
import { AgentPostgresRestoreFloorSchema } from '../dist/application/agent-postgres-backup-contracts.js';
import { readProfileJson } from '../dist/infrastructure/agent-profile-files.js';
import { openAgentTurnProfile } from '../dist/presentation/agent-turn-profile.js';

const runtimeRoot = fileURLToPath(new URL('../', import.meta.url));
const help = `PostgreSQL host wiring example (requires a built runtime).
  init --directory DIR --store-id UUID --registration-id UUID [--purposes state,knowledge,channel]
  provision --directory DIR --offline
  open --directory DIR
  prepare-migration --directory DIR --store-id UUID --registration-id UUID --operation-id UUID --offline
  apply-migration --directory DIR --operation-id UUID --digest SNAPSHOT_SHA256 --offline
  backup --directory DIR --destination DIR --operation-id UUID --offline
  inspect-backup --source DIR
  restore --directory ORIGINAL_DIR --source DIR --operation-id UUID --digest BACKUP_SHA256 --restore-floor HOST_JSON --offline
  check --directory DIR --engine INSTALLED_ENGINE --operation-id UUID --offline
  pin --directory DIR --engine INSTALLED_ENGINE --operation-id UUID --offline
  update --directory DIR --engine INSTALLED_ENGINE --previous CURRENT_RELEASE_SHA256 --backup DIR --operation-id UUID --offline
The default command is open. provision/apply-migration explicitly run DDL.
Restore requires an already provisioned empty target and an independently retained host floor.
Engine changes preserve storage; update requires a current combined PostgreSQL/local backup.
SECUMON_POSTGRES_URL is required for database operations. Never pass it as an argument.
The host supplies the optional pg package; this example does not install it.`;

function argumentsFor(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    directory: { type: 'string' }, 'store-id': { type: 'string' }, 'registration-id': { type: 'string' },
    purposes: { type: 'string' }, offline: { type: 'boolean' }, help: { type: 'boolean' },
    'operation-id': { type: 'string' }, digest: { type: 'string' }, destination: { type: 'string' },
    source: { type: 'string' }, 'restore-floor': { type: 'string' },
    engine: { type: 'string' }, previous: { type: 'string' }, backup: { type: 'string' },
  } });
  if (values.help) return { help: true };
  const command = positionals[0] ?? 'open';
  const required = {
    init: ['directory', 'store-id', 'registration-id'], provision: ['directory', 'offline'], open: ['directory'],
    'prepare-migration': ['directory', 'store-id', 'registration-id', 'operation-id', 'offline'],
    'apply-migration': ['directory', 'operation-id', 'digest', 'offline'],
    backup: ['directory', 'destination', 'operation-id', 'offline'], 'inspect-backup': ['source'],
    restore: ['directory', 'source', 'operation-id', 'digest', 'restore-floor', 'offline'],
    check: ['directory', 'engine', 'operation-id', 'offline'],
    pin: ['directory', 'engine', 'operation-id', 'offline'],
    update: ['directory', 'engine', 'previous', 'backup', 'operation-id', 'offline'],
  };
  if (positionals.length > 1 || !Object.hasOwn(required, command) || required[command].some(key => !values[key])) {
    throw new Error('postgres_host_arguments_invalid');
  }
  const allowed = [...required[command], ...(['init', 'prepare-migration'].includes(command) ? ['purposes'] : [])];
  if (Object.keys(values).some(key => !allowed.includes(key))) {
    throw new Error('postgres_host_arguments_invalid');
  }
  return { command, directory: values.directory ? resolve(values.directory) : undefined, values };
}

function savedSelection(profiles, directory, allowPending = false) {
  const ready = profiles.inspect(directory);
  if (ready.status !== 'ready') throw new Error('agent_profile_not_ready');
  if (ready.postgresMigration?.phase === 'pending' && !allowPending) throw new Error('agent_postgres_migration_resume_required');
  const selection = allowPending && ready.postgresMigration ? ready.postgresMigration.selection : effectiveAgentPostgresSelection(ready);
  if (!selection) throw new Error('agent_postgres_selection_required');
  return AgentPostgresSelectionSchema.parse(selection);
}

// The host owns pg, its credentials and its lifetime. Core sees only connect/query/release.
async function createHostPool(backgroundErrors) {
  const connectionString = process.env.SECUMON_POSTGRES_URL;
  if (!connectionString) throw new Error('postgres_host_connection_environment_required');
  const { Pool } = await import('pg');
  const nativePool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000, statement_timeout: 30_000, query_timeout: 35_000,
    application_name: 'secumon-postgres-host-example' });
  nativePool.on('error', error => {
    backgroundErrors.push(error);
    process.stderr.write('postgres_host_pool_background_error\n');
  });
  const pool = Object.freeze({
    async connect() {
      const client = await nativePool.connect();
      return Object.freeze({
        async query(sql, values) {
          const result = await client.query(sql, values);
          return { rows: result.rows, rowCount: result.rowCount };
        },
        release(error) { client.release(error); },
      });
    },
  });
  return { pool, end: () => nativePool.end() };
}

export async function runPostgresHost(argv) {
  const parsed = argumentsFor(argv);
  if (parsed.help) { process.stdout.write(`${help}\n`); return; }
  const { command, directory, values } = parsed;
  const profiles = new FileAgentProfileStore(runtimeRoot);
  if (command === 'init' || command === 'prepare-migration') {
    const selection = AgentPostgresSelectionSchema.parse({ storeId: values['store-id'],
      registrationId: values['registration-id'], purposes: (values.purposes ?? 'state,knowledge,channel').split(',') });
    if (command === 'init') {
      const ready = profiles.initialize(directory, { postgres: selection });
      process.stdout.write(`${JSON.stringify({ action: 'initialized', agentId: ready.identity.agentId, postgres: selection })}\n`);
    } else {
      const prepared = await prepareAgentPostgresMigration(profiles, directory,
        { selection, operationId: values['operation-id'], offline: values.offline === true });
      process.stdout.write(`${JSON.stringify({ action: 'migration-prepared', operationId: prepared.operationId,
        snapshotDigest: prepared.snapshot.digest, postgres: prepared.selection })}\n`);
    }
    return;
  }

  const archive = ['inspect-backup', 'restore'].includes(command) ? await inspectAgentPostgresBackup(resolve(values.source)) : undefined;
  if (command === 'inspect-backup') {
    process.stdout.write(`${JSON.stringify({ action: 'backup-inspected', agentId: archive.manifest.agentId,
      backupDigest: archive.manifest.digest, originalRoot: archive.manifest.originalRoot })}\n`);
    return;
  }
  const selection = archive?.manifest.selection ?? savedSelection(profiles, directory, command === 'apply-migration');
  const floor = command === 'restore' ? readProfileJson(resolve(values['restore-floor']), AgentPostgresRestoreFloorSchema, undefined, 65536) : undefined;
  if (command === 'restore' && !floor) throw new Error('postgres_host_restore_floor_required');
  const failures = [];
  let poolOwner, profile, result;
  try {
    poolOwner = await createHostPool(failures);
    const postgres = Object.freeze({ selection, pool: poolOwner.pool });
    if (command === 'provision') {
      // offline asserts every process using this agent is stopped.
      result = { action: 'provisioned', ...await provisionAgentPostgresStorage(profiles, directory, postgres, values.offline === true) };
    } else if (command === 'apply-migration') {
      result = { action: 'migration-applied', ...await applyAgentPostgresMigration(profiles, directory, postgres,
        { operationId: values['operation-id'], expectedSnapshotDigest: values.digest, offline: true }) };
    } else if (command === 'backup') {
      const saved = await backupAgentPostgres(profiles, directory, resolve(values.destination), postgres,
        { operationId: values['operation-id'], offline: true });
      result = { action: 'backup-created', directory: saved.directory, agentId: saved.manifest.agentId, backupDigest: saved.manifest.digest };
    } else if (command === 'restore') {
      result = { action: 'restored', ...await restoreAgentPostgresBackup(profiles, resolve(values.source), directory, postgres,
        { operationId: values['operation-id'], expectedDigest: values.digest, currentFloor: floor, offline: true }) };
    } else if (command === 'check') {
      result = { action: 'engine-checked', ...await checkAgentPostgresLifecycle(profiles, directory, resolve(values.engine), postgres,
        { operationId: values['operation-id'], offline: true }) };
    } else if (command === 'pin' || command === 'update') {
      result = { action: command === 'pin' ? 'engine-pinned' : 'engine-updated',
        ...await pinAgentPostgresEngine(profiles, directory, resolve(values.engine), postgres,
          { operationId: values['operation-id'], offline: true,
            expectedPrevious: command === 'pin' ? null : values.previous,
            ...(command === 'update' ? { backup: resolve(values.backup) } : {}) }) };
    } else {
      profile = await openAgentTurnProfile(directory, { provider: 'synthetic' }, { postgres });
      // A deployment can pass this same host to its CLI/Web entry. No work is accepted here.
      result = { action: 'opened', agentId: profile.agentId, postgres: selection, provider: profile.provider };
    }
  } catch (error) { failures.push(error); }
  finally {
    // Store/runtime draining precedes pool shutdown. Preserve primary and cleanup failures.
    if (profile) try { await profile.close(); } catch (error) { failures.push(error); }
    if (poolOwner) try { await poolOwner.end(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'postgres_host_failed');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runPostgresHost(process.argv.slice(2)); }
  catch {
    // Driver errors may contain credentials, endpoints or SQL values. Do not print them.
    process.stderr.write('postgres_host_failed: check arguments, host registration and database availability.\n');
    process.exitCode = 1;
  }
}
