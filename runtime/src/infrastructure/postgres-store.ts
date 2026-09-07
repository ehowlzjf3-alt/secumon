import { z } from 'zod';

/** Structural node-postgres Pool boundary. Credentials and pool lifetime belong to the host. */
export interface PostgresClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
export interface PostgresConnection extends PostgresClient { release(error?: Error | boolean): void }
export interface PostgresPool { connect(): Promise<PostgresConnection> }
const id = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value));
export const PostgresBindingSchema = z.strictObject({ storeId: z.uuid(), agentId: id,
  purpose: z.enum(['state', 'knowledge', 'channel', 'board']), registrationId: z.uuid() });
export type PostgresBinding = z.infer<typeof PostgresBindingSchema>;
export const POSTGRES_INSTALLATION_VERSION = 2;
export class PostgresStorageError extends Error {
  constructor(readonly code: string, cause?: unknown) { super(code, cause === undefined ? undefined : { cause }); }
}
export function postgresInteger(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))) throw new PostgresStorageError('postgres_invalid_integer');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new PostgresStorageError('postgres_invalid_integer');
  return result;
}
export function postgresJson(value: unknown): unknown {
  if (typeof value !== 'string') throw new PostgresStorageError('postgres_invalid_record');
  return JSON.parse(value);
}
export async function postgresTransaction<T>(pool: PostgresPool, write: boolean, operation: (client: PostgresClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let begun = false, committing = false, discard = false;
  let result: T | undefined, failure: unknown, failed = false;
  try {
    await client.query(write ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun = true;
    await client.query("SELECT pg_catalog.set_config('statement_timeout', '30000', true), pg_catalog.set_config('lock_timeout', '5000', true)");
    result = await operation(client);
    committing = true;
    await client.query('COMMIT'); begun = false;
  } catch (error) {
    failed = true; failure = write && committing ? new PostgresStorageError('postgres_commit_outcome_unknown', error) : error;
    discard = committing;
    if (begun) try { await client.query('ROLLBACK'); } catch (rollback) {
      discard = true; failure = new AggregateError([failure, rollback], 'postgres_transaction_cleanup_failed');
    }
  }
  try { client.release(discard); } catch (error) {
    failure = failed ? new AggregateError([failure, error], 'postgres_connection_release_failed') : new PostgresStorageError('postgres_connection_release_failed', error); failed = true;
  }
  if (failed) throw failure;
  return result as T;
}
async function assertBinding(client: PostgresClient, binding: PostgresBinding, lock: boolean, maintenanceId?: string) {
  const installed = await client.query('SELECT version FROM secumon_pg.installation WHERE singleton=true');
  if (installed.rows.length !== 1 || postgresInteger(installed.rows[0]!['version']) !== POSTGRES_INSTALLATION_VERSION) throw new PostgresStorageError('postgres_schema_mismatch');
  const rows = await client.query(`SELECT registration_id, schema_version, maintenance_id FROM secumon_pg.bindings WHERE store_id=$1 AND agent_id=$2 AND purpose=$3${lock ? ' FOR UPDATE' : ''}`,
    [binding.storeId, binding.agentId, binding.purpose]);
  const row = rows.rows[0];
  if (rows.rows.length !== 1 || row?.['registration_id'] !== binding.registrationId || postgresInteger(row['schema_version']) !== 1) throw new PostgresStorageError('postgres_binding_mismatch');
  if (row['maintenance_id'] !== (maintenanceId ?? null)) throw new PostgresStorageError('postgres_store_maintenance');
}

function orderedBindings(raw: readonly PostgresBinding[]): PostgresBinding[] {
  const values = raw.map(value => PostgresBindingSchema.parse(value));
  if (!values.length || values.length > 4 || new Set(values.map(v => JSON.stringify([v.storeId, v.agentId, v.purpose]))).size !== values.length) throw new PostgresStorageError('postgres_bindings_invalid');
  return values.sort((a, b) => JSON.stringify([a.storeId, a.agentId, a.purpose]).localeCompare(JSON.stringify([b.storeId, b.agentId, b.purpose]), 'en'));
}
/** Used by host-only snapshot/import operations sharing a single transaction across storage purposes. */
export async function assertPostgresBindings(client: PostgresClient, bindings: readonly PostgresBinding[], options: { maintenanceId?: string; lock?: boolean } = {}) {
  if (options.maintenanceId !== undefined) z.uuid().parse(options.maintenanceId);
  for (const binding of orderedBindings(bindings)) await assertBinding(client, binding, options.lock ?? false, options.maintenanceId);
}
/** Persistent database-side fence. A failed or uncertain caller can resume with the same operation identity. */
export async function acquirePostgresMaintenance(pool: PostgresPool, raw: readonly PostgresBinding[], rawOperationId: string) {
  const bindings = orderedBindings(raw), operationId = z.uuid().parse(rawOperationId);
  await postgresTransaction(pool, true, async client => {
    for (const binding of bindings) {
      const key = [binding.storeId, binding.agentId, binding.purpose];
      const row = (await client.query('SELECT registration_id,schema_version,maintenance_id FROM secumon_pg.bindings WHERE store_id=$1 AND agent_id=$2 AND purpose=$3 FOR UPDATE', key)).rows[0];
      if (!row || row['registration_id'] !== binding.registrationId || postgresInteger(row['schema_version']) !== 1) throw new PostgresStorageError('postgres_binding_mismatch');
      if (row['maintenance_id'] !== null && row['maintenance_id'] !== operationId) throw new PostgresStorageError('postgres_store_maintenance');
      await client.query('UPDATE secumon_pg.bindings SET maintenance_id=$4 WHERE store_id=$1 AND agent_id=$2 AND purpose=$3', [...key, operationId]);
    }
  });
  let released: Promise<void> | undefined;
  return { release(): Promise<void> {
    return released ??= postgresTransaction(pool, true, async client => {
      for (const binding of bindings) {
        const key = [binding.storeId, binding.agentId, binding.purpose];
        const row = (await client.query('SELECT registration_id,maintenance_id FROM secumon_pg.bindings WHERE store_id=$1 AND agent_id=$2 AND purpose=$3 FOR UPDATE', key)).rows[0];
        if (!row || row['registration_id'] !== binding.registrationId || row['maintenance_id'] !== null && row['maintenance_id'] !== operationId) throw new PostgresStorageError('postgres_maintenance_owner_changed');
        if (row['maintenance_id'] === operationId) await client.query('UPDATE secumon_pg.bindings SET maintenance_id=NULL WHERE store_id=$1 AND agent_id=$2 AND purpose=$3', key);
      }
    });
  } };
}

/** Explicit administrative provisioning. Ordinary open/read never creates a schema or a binding. */
export async function provisionPostgresStore(pool: PostgresPool, raw: PostgresBinding, schema: readonly string[], options: { maintenanceId?: string } = {}): Promise<void> {
  const binding = PostgresBindingSchema.parse(raw);
  if (options.maintenanceId !== undefined) z.uuid().parse(options.maintenanceId);
  await postgresTransaction(pool, true, async client => {
    // Serializes schema installation; this constant contains no agent or model supplied SQL.
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(732913, 1)");
    await client.query('CREATE SCHEMA IF NOT EXISTS secumon_pg');
    await client.query('CREATE TABLE IF NOT EXISTS secumon_pg.installation(singleton boolean PRIMARY KEY CHECK(singleton),version integer NOT NULL)');
    await client.query('INSERT INTO secumon_pg.installation VALUES(true,2) ON CONFLICT DO NOTHING');
    const version = await client.query('SELECT version FROM secumon_pg.installation WHERE singleton=true');
    if (version.rows.length !== 1 || ![1, 2].includes(postgresInteger(version.rows[0]!['version']))) throw new PostgresStorageError('postgres_schema_mismatch');
    await client.query(`CREATE TABLE IF NOT EXISTS secumon_pg.bindings(store_id text NOT NULL,agent_id text NOT NULL,purpose text NOT NULL,
      registration_id text NOT NULL,schema_version integer NOT NULL,maintenance_id text,PRIMARY KEY(store_id,agent_id,purpose))`);
    await client.query('ALTER TABLE secumon_pg.bindings ADD COLUMN IF NOT EXISTS maintenance_id text');
    await client.query('CREATE TABLE IF NOT EXISTS secumon_pg.transfers(store_id text NOT NULL,agent_id text NOT NULL,operation_id text NOT NULL,snapshot_digest text NOT NULL,purposes text NOT NULL,PRIMARY KEY(store_id,agent_id,operation_id))');
    await client.query('UPDATE secumon_pg.installation SET version=2 WHERE singleton=true');
    await client.query('INSERT INTO secumon_pg.bindings(store_id,agent_id,purpose,registration_id,schema_version) VALUES($1,$2,$3,$4,1) ON CONFLICT DO NOTHING', [binding.storeId, binding.agentId, binding.purpose, binding.registrationId]);
    const fence = (await client.query('SELECT maintenance_id FROM secumon_pg.bindings WHERE store_id=$1 AND agent_id=$2 AND purpose=$3 FOR UPDATE',
      [binding.storeId, binding.agentId, binding.purpose])).rows[0]?.['maintenance_id'];
    if (fence !== null && fence !== options.maintenanceId) throw new PostgresStorageError('postgres_store_maintenance');
    await assertBinding(client, binding, true, typeof fence === 'string' ? fence : undefined);
    for (const sql of schema) await client.query(sql);
  });
}

export class PostgresStore {
  readonly binding: Readonly<PostgresBinding>;
  readonly key: readonly [string, string];
  readonly #pool: PostgresPool;
  readonly #pending = new Set<Promise<unknown>>();
  #closed = false;
  #closing: Promise<void> | undefined;
  private constructor(pool: PostgresPool, binding: PostgresBinding) {
    this.#pool = pool; this.binding = Object.freeze(PostgresBindingSchema.parse(binding));
    this.key = Object.freeze([this.binding.storeId, this.binding.agentId]);
  }
  static async open(pool: PostgresPool, binding: PostgresBinding): Promise<PostgresStore> {
    const store = new PostgresStore(pool, binding);
    await store.read(async () => undefined);
    return store;
  }
  #run<T>(write: boolean, fn: (client: PostgresClient) => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new PostgresStorageError('postgres_store_closed'));
    const pending = postgresTransaction(this.#pool, write, async client => {
      await assertBinding(client, this.binding, write);
      return fn(client);
    });
    this.#pending.add(pending);
    void pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending));
    return pending;
  }
  read<T>(fn: (client: PostgresClient) => Promise<T>): Promise<T> { return this.#run(false, fn); }
  write<T>(fn: (client: PostgresClient) => Promise<T>): Promise<T> { return this.#run(true, fn); }
  close(): Promise<void> {
    this.#closed = true;
    return this.#closing ??= Promise.allSettled([...this.#pending]).then(() => undefined);
  }
}
