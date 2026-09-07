import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkSync } from 'node:fs';
import { z } from 'zod';
import type { AgentProfileStore, AgentProfileStatus } from '../application/agent-profile-contracts.js';
import { SQLITE_RECOVERY_PENDING, SqliteRecoveryKindSchema, SqliteRecoveryIntentSchema, SqliteRecoveryPreservedSchema,
  SqliteRecoveryPreparedSchema, SqliteRecoveryPendingSchema, SqliteRecoveryCompleteSchema,
  type SqliteRecoveryKind, type SqliteRecoveryIntent, type SqliteRecoveryPending } from '../application/agent-sqlite-recovery-contracts.js';
import { SqliteRecoveryValidationInputSchema } from '../application/agent-sqlite-recovery-validation-contracts.js';
import { acquireAgentMaintenance } from './agent-lifecycle-lease.js';
import { claimAgentHostIdentity } from './agent-host-identities.js';
import type { AgentStoreHostOptions } from './agent-stores.js';
import { effectiveAgentPostgresSelection } from './agent-postgres-migration-profile.js';
import { openProfileMutationScope, readProfileBytes, readProfileJson, publishProfileJson, syncProfileDirectory } from './agent-profile-files.js';
import { lifecycleDigest, lifecycleExists, lifecycleFail } from './agent-lifecycle-files.js';
import { sameFileIdentity } from './host-metadata-files.js';
import { removeWindowsLifecycleMarker } from './windows-lifecycle-files.js';
import { assertSqliteRecoveryFile, assertSqliteRecoveryJournal, assertSqliteRecoveryLayout, captureSqliteRecoveryFile,
  copySqliteRecoveryFile, retireSqliteRecoveryFile, publishSqliteRecoveryCandidate } from './agent-sqlite-recovery-files.js';
import { runSqliteRecoveryWorker } from './agent-sqlite-recovery-process.js';

type Ready = Extract<AgentProfileStatus, { status: 'ready' }>;
const currentEngine = fileURLToPath(new URL('../../', import.meta.url));
const metadataLimit = 65536;
export const sqliteRecoveryLimits = Object.freeze({ fileBytes: 1024 ** 3, attempts: 4, workerMs: 60000 });
const PrepareSchema = z.strictObject({ operationId: z.uuid(), kind: SqliteRecoveryKindSchema, offline: z.boolean() });
const ApplySchema = z.strictObject({ operationId: z.uuid(), expectedPreparedDigest: z.string().regex(/^[a-f0-9]{64}$/), offline: z.boolean() });
const same = (a: unknown, b: unknown) => lifecycleDigest(a) === lifecycleDigest(b);
const fail = (suffix: string): never => lifecycleFail(`sqlite_recovery_${suffix}`);
function ready(profiles: AgentProfileStore, directory: string) {
  const profile = profiles.inspect(directory);
  if (profile.status !== 'ready') return fail('profile_not_ready');
  if (profile.personalMemoryMigration?.phase === 'pending' || profile.postgresMigration?.phase === 'pending') return fail('migration_pending');
  return profile;
}
function binding(profile: Ready) {
  return lifecycleDigest({ identity: profile.identity, storage: profile.config.storage, personalMemory: profile.effectivePersonalMemory,
    memoryMigration: profile.personalMemoryMigration ?? null, postgresMigration: profile.postgresMigration ?? null });
}
function location(profile: Ready, kind: SqliteRecoveryKind) {
  const purpose = kind === 'memory' ? 'knowledge' : kind;
  if (effectiveAgentPostgresSelection(profile)?.purposes.includes(purpose)) return fail('local_database_not_selected');
  if (kind === 'state' && profile.config.storage.state !== 'sqlite') return fail('local_database_not_selected');
  if (kind === 'state' && lifecycleExists(join(profile.paths.metadata, 'state-journal'))) return fail('state_backend_ambiguous');
  const relativePath: SqliteRecoveryIntent['relativePath'] = kind === 'state' ? '.secumon/runtime.sqlite' : kind === 'memory' ? 'memory/memory.sqlite' : '.secumon/channel.sqlite';
  const validation = SqliteRecoveryValidationInputSchema.parse({ agentId: profile.identity.agentId, kind,
    ...(kind === 'memory' ? { personalMemory: profile.effectivePersonalMemory.backend === 'documents' ? {
      backend: 'documents', storeId: profile.effectivePersonalMemory.storeId,
      ...(profile.personalMemoryMigration?.phase === 'activated' ? { migrationOperationId: profile.personalMemoryMigration.operationId } : {}),
    } : { backend: 'sqlite' } } : {}) });
  return { relativePath, main: join(profile.root, relativePath), validation };
}
function signed<T extends { digest: string }>(schema: z.ZodType<T>, value: Omit<T, 'digest'>): T {
  const parsed = schema.parse({ ...value, digest: '0'.repeat(64) }); const { digest: _, ...body } = parsed;
  return schema.parse({ ...body, digest: lifecycleDigest(body) });
}
function readSigned<T extends { digest: string }>(path: string, schema: z.ZodType<T>): T | null {
  const value = readProfileJson(path, schema, [1], metadataLimit); if (!value) return null;
  const { digest, ...body } = value; if (lifecycleDigest(body) !== digest) return fail('receipt_digest_mismatch');
  return value;
}
function records(folder: string, operationId: string) {
  const intent = readSigned(join(folder, 'intent.json'), SqliteRecoveryIntentSchema);
  const preserved = readSigned(join(folder, 'original.json'), SqliteRecoveryPreservedSchema);
  const prepared = readSigned(join(folder, 'prepared.json'), SqliteRecoveryPreparedSchema);
  const complete = readSigned(join(folder, 'complete.json'), SqliteRecoveryCompleteSchema);
  if ([intent, preserved, prepared, complete].some(value => value && value.operationId !== operationId)) fail('operation_mismatch');
  if (preserved && (!intent || preserved.intentDigest !== intent.digest) ||
      prepared && (!intent || !preserved || prepared.intentDigest !== intent.digest || prepared.preservedDigest !== preserved.digest) ||
      complete && (!prepared || !intent || complete.agentId !== intent.identity.agentId || complete.preparedDigest !== prepared.digest ||
        !same(complete.applied, prepared.candidate) || !same(complete.validation, prepared.validation))) fail('receipt_chain_mismatch');
  return { intent, preserved, prepared, complete };
}
function operationFolder(profile: Ready, operationId: string) { return join(profile.paths.metadata, 'sqlite-recovery', operationId); }

/** Historical receipts only. No DB open, claim, new directory, or current-data completion assertion. */
export function readAgentSqliteRecovery(profiles: AgentProfileStore, directory: string, operationId: string) {
  z.uuid().parse(operationId); const profile = ready(profiles, directory), folder = operationFolder(profile, operationId);
  const pending = readProfileJson(join(profile.paths.metadata, SQLITE_RECOVERY_PENDING), SqliteRecoveryPendingSchema);
  if (!lifecycleExists(folder)) return { operationId, stage: 'not_started' as const, pending };
  const saved = records(folder, operationId);
  if (saved.intent && !same(saved.intent.identity, profile.identity)) fail('owner_mismatch');
  return { operationId, directory: folder, stage: saved.complete ? 'complete' as const : pending?.operationId === operationId ? 'pending' as const :
    saved.prepared ? 'prepared' as const : saved.preserved ? 'preserved' as const : 'preparing' as const, ...saved, pending,
    currentDatabaseVerified: false };
}

async function managed<T>(profiles: AgentProfileStore, directory: string, operationId: string, offline: boolean,
  host: AgentStoreHostOptions, recovery: { operationId: string; preparedDigest: string } | undefined,
  action: (context: ReturnType<typeof openContext>) => Promise<T>) {
  if (offline !== true) return fail('offline_confirmation_required');
  const context = openContext(profiles, directory, operationId, host, recovery); const errors: unknown[] = []; let result: T | undefined;
  try { result = await action(context); } catch (error) { errors.push(error); }
  for (const close of [() => context.scope.close(), () => context.claim.close(), () => { if (!context.workerUnobserved) context.lease.close(); }])
    try { close(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'sqlite_recovery_cleanup_failed', { cause: errors[0] });
  return result!;
}
function openContext(profiles: AgentProfileStore, directory: string, operationId: string, host: AgentStoreHostOptions,
  recovery?: { operationId: string; preparedDigest: string }) {
  const profile = ready(profiles, directory), engines = [...new Set([currentEngine, ...(profiles.engineDirectories ?? [])])];
  const registryDirectory = host.identityRegistryDirectory;
  const claim = claimAgentHostIdentity(profile, { engineDirectories: engines, ...(registryDirectory === undefined ? {} : { registryDirectory }) });
  let lease: ReturnType<typeof acquireAgentMaintenance> | undefined, scope: ReturnType<typeof openProfileMutationScope> | undefined;
  try {
    lease = acquireAgentMaintenance(profile.root, true, recovery); scope = openProfileMutationScope(profile.root, engines);
    const rootRef = scope.directory(profile.root, 'owner-writable') ?? fail('root_missing');
    const folder = operationFolder(profile, operationId), bindingDigest = binding(profile);
    const activeLease = readProfileBytes(join(profile.paths.metadata, 'lifecycle-maintenance.json'), metadataLimit);
    if (!activeLease) return fail('maintenance_missing');
    const current = () => {
      scope!.check(); claim.assertCurrent();
      if (binding(ready(profiles, profile.root)) !== bindingDigest ||
        !readProfileBytes(join(profile.paths.metadata, 'lifecycle-maintenance.json'), metadataLimit)?.equals(activeLease)) fail('source_binding_changed');
    };
    current();
    return { profile, scope, claim, lease, folder, rootRef, current, bindingDigest, workerUnobserved: false };
  } catch (error) {
    const errors = [error];
    for (const close of [() => scope?.close(), () => lease?.close(), () => claim.close()]) try { close(); } catch (e) { errors.push(e); }
    if (errors.length > 1) throw new AggregateError(errors, 'sqlite_recovery_open_failed', { cause: error });
    throw error;
  }
}
type Context = ReturnType<typeof openContext>;
function publish(context: Context, folder: string, leaf: string, value: unknown) {
  context.current();
  const expected = Buffer.from(JSON.stringify(value, null, 2) + '\n'); if (expected.length > metadataLimit) return fail('receipt_capacity');
  publishProfileJson(join(folder, leaf), value, context.scope);
  if (!readProfileBytes(join(folder, leaf), metadataLimit, true, context.scope)?.equals(expected)) fail('publication_conflict');
  syncProfileDirectory(folder, context.scope); context.current();
}
function allocate(context: Context, prefix: 'original' | 'candidate') {
  for (let i = 1; i <= sqliteRecoveryLimits.attempts; i++) {
    const name = `${prefix}-${String(i).padStart(4, '0')}`, folder = join(context.folder, name);
    if (lifecycleExists(folder)) continue;
    context.scope.directory(folder, 'private', true, true); return { name, folder };
  }
  return fail('attempt_limit');
}
function assertIntent(context: Context, intent: SqliteRecoveryIntent) {
  const selected = location(context.profile, intent.databaseKind), parent = context.scope.directory(dirname(selected.main), 'private');
  if (!same(intent.identity, context.profile.identity) || intent.root !== context.profile.root || intent.bindingDigest !== context.bindingDigest ||
    intent.relativePath !== selected.relativePath || !same(intent.validation, selected.validation) ||
    !sameFileIdentity(intent.rootIdentity, context.rootRef.identity) || !parent || !sameFileIdentity(intent.parentIdentity, parent.identity)) fail('intent_binding_mismatch');
  context.current(); return selected.main;
}
function assertSource(main: string, intent: SqliteRecoveryIntent) {
  assertSqliteRecoveryLayout(main);
  assertSqliteRecoveryFile(main, intent.source.main, sqliteRecoveryLimits.fileBytes);
  assertSqliteRecoveryFile(main + '-journal', intent.source.journal, sqliteRecoveryLimits.fileBytes);
}
async function worker(context: Context, mode: 'recover' | 'verify', path: string, intent: SqliteRecoveryIntent) {
  if (lifecycleExists(join(context.folder, 'worker-unobserved.json'))) return fail('worker_cleanup_required');
  context.current();
  try {
    const result = await runSqliteRecoveryWorker({ mode, candidatePath: path, validation: intent.validation });
    context.current(); return result;
  } catch (error) {
    if ((error as { workerExit?: { observed?: boolean } })?.workerExit?.observed === false) {
      context.workerUnobserved = true;
      try { publish(context, context.folder, 'worker-unobserved.json', { schemaVersion: 1, operationId: intent.operationId,
        mode, path, workerExit: (error as { workerExit: unknown }).workerExit, recordedAt: Date.now() }); }
      catch (recording) { throw new AggregateError([error, recording], 'sqlite_recovery_worker_record_failed', { cause: error }); }
    }
    throw error;
  }
}

/** Preserve originals first; only an isolated candidate receives a writable SQLite connection. */
export async function prepareAgentSqliteRecovery(profiles: AgentProfileStore, directory: string,
  value: z.infer<typeof PrepareSchema>, host: AgentStoreHostOptions = {}) {
  const input = PrepareSchema.parse(value);
  return managed(profiles, directory, input.operationId, input.offline, host, undefined, async context => {
    const selected = location(context.profile, input.kind);
    context.scope.directory(dirname(context.folder), 'private', true); context.scope.directory(context.folder, 'private', true);
    let saved = records(context.folder, input.operationId);
    if (saved.intent && saved.intent.databaseKind !== input.kind) return fail('kind_mismatch');
    if (saved.complete) return readAgentSqliteRecovery(profiles, directory, input.operationId);
    if (!saved.intent) {
      assertSqliteRecoveryLayout(selected.main);
      const main = captureSqliteRecoveryFile(selected.main, sqliteRecoveryLimits.fileBytes), journal = captureSqliteRecoveryFile(selected.main + '-journal', sqliteRecoveryLimits.fileBytes);
      if (!main || !journal) return fail('rollback_pair_required');
      assertSqliteRecoveryJournal(selected.main, main, journal, sqliteRecoveryLimits.fileBytes);
      const parent = context.scope.directory(dirname(selected.main), 'private') ?? fail('parent_missing');
      const intent = signed(SqliteRecoveryIntentSchema, { schemaVersion: 1, kind: 'secumon-sqlite-recovery-intent', operationId: input.operationId,
        identity: context.profile.identity, root: context.profile.root, rootIdentity: context.rootRef.identity, parentIdentity: parent.identity,
        databaseKind: input.kind, relativePath: selected.relativePath, bindingDigest: context.bindingDigest,
        source: { main, journal }, validation: selected.validation, createdAt: Date.now() });
      publish(context, context.folder, 'intent.json', intent); saved = records(context.folder, input.operationId);
    }
    const intent = saved.intent ?? fail('intent_missing'); if (intent.databaseKind !== input.kind) return fail('kind_mismatch');
    const source = assertIntent(context, intent), leaf = basename(source); assertSource(source, intent);
    if (!saved.preserved) {
      const original = allocate(context, 'original');
      const main = copySqliteRecoveryFile(source, join(original.folder, leaf), intent.source.main, sqliteRecoveryLimits.fileBytes);
      const journal = copySqliteRecoveryFile(source + '-journal', join(original.folder, leaf + '-journal'), intent.source.journal, sqliteRecoveryLimits.fileBytes);
      assertSource(source, intent);
      const preserved = signed(SqliteRecoveryPreservedSchema, { schemaVersion: 1, kind: 'secumon-sqlite-recovery-original', operationId: input.operationId,
        intentDigest: intent.digest, directory: original.name, main, journal, createdAt: Date.now() });
      publish(context, context.folder, 'original.json', preserved); saved = records(context.folder, input.operationId);
    }
    const preserved = saved.preserved ?? fail('original_missing'), original = join(context.folder, preserved.directory, leaf);
    assertSqliteRecoveryFile(original, preserved.main, sqliteRecoveryLimits.fileBytes);
    assertSqliteRecoveryFile(original + '-journal', preserved.journal, sqliteRecoveryLimits.fileBytes);
    if (!saved.prepared) {
      const attempt = allocate(context, 'candidate'), candidatePath = join(attempt.folder, leaf);
      const initial = copySqliteRecoveryFile(original, candidatePath, preserved.main, sqliteRecoveryLimits.fileBytes);
      copySqliteRecoveryFile(original + '-journal', candidatePath + '-journal', preserved.journal, sqliteRecoveryLimits.fileBytes);
      assertSqliteRecoveryJournal(candidatePath, initial, captureSqliteRecoveryFile(candidatePath + '-journal', sqliteRecoveryLimits.fileBytes) ?? fail('candidate_journal_missing'), sqliteRecoveryLimits.fileBytes);
      const validation = await worker(context, 'recover', candidatePath, intent);
      const candidate = captureSqliteRecoveryFile(candidatePath, sqliteRecoveryLimits.fileBytes) ?? fail('candidate_missing');
      if (!sameFileIdentity(candidate.identity, initial.identity)) return fail('candidate_replaced');
      assertSqliteRecoveryLayout(candidatePath);
      if (lifecycleExists(candidatePath + '-journal')) return fail('candidate_journal_remaining');
      assertSource(source, intent); assertSqliteRecoveryFile(original, preserved.main, sqliteRecoveryLimits.fileBytes);
      assertSqliteRecoveryFile(original + '-journal', preserved.journal, sqliteRecoveryLimits.fileBytes);
      const prepared = signed(SqliteRecoveryPreparedSchema, { schemaVersion: 1, kind: 'secumon-sqlite-recovery-prepared', operationId: input.operationId,
        intentDigest: intent.digest, preservedDigest: preserved.digest, directory: attempt.name, candidate, validation, createdAt: Date.now() });
      publish(context, context.folder, 'prepared.json', prepared); saved = records(context.folder, input.operationId);
    }
    const prepared = saved.prepared ?? fail('prepared_missing');
    assertSqliteRecoveryFile(join(context.folder, prepared.directory, leaf), prepared.candidate, sqliteRecoveryLimits.fileBytes);
    context.current(); return { operationId: input.operationId, stage: 'prepared' as const, directory: context.folder,
      preparedDigest: prepared.digest, originalPath: original, candidatePath: join(context.folder, prepared.directory, leaf), prepared };
  });
}

function clearPending(context: Context, expected: SqliteRecoveryPending) {
  const path = join(context.profile.paths.metadata, SQLITE_RECOVERY_PENDING);
  if (!same(readProfileJson(path, SqliteRecoveryPendingSchema), expected)) return fail('pending_changed');
  const bytes = readProfileBytes(path, metadataLimit) ?? fail('pending_missing'); context.current();
  if (process.platform === 'win32') removeWindowsLifecycleMarker(path, bytes); else unlinkSync(path);
  syncProfileDirectory(context.profile.paths.metadata, context.scope); context.current();
}
/** A pending operation blocks normal starts until this exact candidate has been published and checked. */
export async function applyAgentSqliteRecovery(profiles: AgentProfileStore, directory: string,
  value: z.infer<typeof ApplySchema>, host: AgentStoreHostOptions = {}) {
  const input = ApplySchema.parse(value);
  return managed(profiles, directory, input.operationId, input.offline, host,
    { operationId: input.operationId, preparedDigest: input.expectedPreparedDigest }, async context => {
      context.scope.directory(context.folder, 'private');
      const saved = records(context.folder, input.operationId), intent = saved.intent ?? fail('intent_missing');
      const prepared = saved.prepared ?? fail('prepared_missing'), preserved = saved.preserved ?? fail('original_missing');
      const source = assertIntent(context, intent), leaf = basename(source), candidatePath = join(context.folder, prepared.directory, leaf);
      if (prepared.digest !== input.expectedPreparedDigest) return fail('prepared_digest_mismatch');
      const expected: SqliteRecoveryPending = { schemaVersion: 1, kind: 'secumon-sqlite-recovery-apply', operationId: input.operationId,
        agentId: context.profile.identity.agentId, preparedDigest: prepared.digest };
      const pendingPath = join(context.profile.paths.metadata, SQLITE_RECOVERY_PENDING);
      const pending = readProfileJson(pendingPath, SqliteRecoveryPendingSchema);
      if (pending && !same(pending, expected)) return fail('pending_conflict');
      if (saved.complete && !pending) return { stage: 'complete' as const, historical: true, receipt: saved.complete, currentDatabaseVerified: false };
      if (lifecycleExists(join(context.folder, 'worker-unobserved.json'))) return fail('worker_cleanup_required');
      const original = join(context.folder, preserved.directory, leaf);
      assertSqliteRecoveryFile(original, preserved.main, sqliteRecoveryLimits.fileBytes);
      assertSqliteRecoveryFile(original + '-journal', preserved.journal, sqliteRecoveryLimits.fileBytes);
      if (!pending) {
        assertSource(source, intent); assertSqliteRecoveryFile(candidatePath, prepared.candidate, sqliteRecoveryLimits.fileBytes);
        if (lifecycleExists(candidatePath + '-journal')) return fail('candidate_journal_remaining');
        const validation = await worker(context, 'verify', candidatePath, intent);
        if (!same(validation, prepared.validation)) return fail('candidate_validation_changed');
        assertSource(source, intent); assertSqliteRecoveryFile(candidatePath, prepared.candidate, sqliteRecoveryLimits.fileBytes);
        publish(context, context.profile.paths.metadata, SQLITE_RECOVERY_PENDING, expected);
      }
      context.current(); assertSqliteRecoveryLayout(source);
      retireSqliteRecoveryFile(source, input.operationId, intent.source.main, sqliteRecoveryLimits.fileBytes,
        { path: candidatePath, pin: prepared.candidate });
      retireSqliteRecoveryFile(source + '-journal', input.operationId, intent.source.journal, sqliteRecoveryLimits.fileBytes);
      context.current();
      const applied = publishSqliteRecoveryCandidate(candidatePath, source, prepared.candidate, sqliteRecoveryLimits.fileBytes);
      assertSqliteRecoveryFile(source + '-journal', null, sqliteRecoveryLimits.fileBytes);
      const validation = await worker(context, 'verify', source, intent);
      if (!same(applied, prepared.candidate) || !same(validation, prepared.validation)) return fail('applied_candidate_mismatch');
      assertSqliteRecoveryFile(source, prepared.candidate, sqliteRecoveryLimits.fileBytes); context.current();
      const complete = saved.complete ?? signed(SqliteRecoveryCompleteSchema, { schemaVersion: 1, kind: 'secumon-sqlite-recovery-complete',
        operationId: input.operationId, agentId: context.profile.identity.agentId, preparedDigest: prepared.digest,
        applied, validation, completedAt: Date.now() });
      publish(context, context.folder, 'complete.json', complete); clearPending(context, expected);
      return { stage: 'complete' as const, historical: false, receipt: complete, currentDatabaseVerified: true,
        externalEffects: 'preserved; reconcile existing runtime receipts before new execution' };
    });
}
