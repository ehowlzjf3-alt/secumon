import { readdirSync, realpathSync } from 'node:fs';
import { windowsProfilePath, windowsPathInfo, windowsProfileNames, windowsProfileContains } from './windows-profile-files.js';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AgentConfigSchema, AgentIdentitySchema, AgentSetupOptionsSchema, AgentSetupReceiptSchema, AgentCloneOptionsSchema, AgentSetupOperationSchema, AgentCloneSetupSchema, AgentCloneCompletionSchema } from '../application/agent-profile-contracts.js';
import type { AgentConfig, AgentIdentity, AgentPaths, AgentProfileStatus, AgentProfileStore, AgentSetupOptions, AgentSetupOperation, AgentCloneOptions, AgentCloneOperation } from '../application/agent-profile-contracts.js';
import { failProfile as fail, profileErrorCode as code, profileStat as stat, profileDirectory as directory, syncProfileDirectory as sync, readProfileJson as read, publishProfileJson as publish } from './agent-profile-files.js';
import { captureCloneSkills, copyCloneSkills, verifyCloneSkills } from './agent-clone-files.js';
import { openProfileMutationScope, checkProfileMutationScope } from './agent-profile-files.js';
import type { HostFileMutationScope } from './host-file-mutations.js';
import { inspectMigrationSelection } from './personal-memory-migration-profile.js';
import { assertAgentEnginePin } from './agent-engine-release.js';
import { inspectPostgresMigration, effectiveAgentPostgresSelection } from './agent-postgres-migration-profile.js';

const pathExists = (path: string) => process.platform === 'win32' ? windowsPathInfo(path, false) !== null : stat(path) !== null;
const directoryNames = (path: string) => process.platform === 'win32' ? windowsProfileNames(path) : readdirSync(path);
const receiptSchema = z.union([AgentSetupReceiptSchema, AgentCloneSetupSchema]);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function contains(parent: string, child: string) { if (process.platform === 'win32') return windowsProfileContains(parent, child); const part = relative(parent, child); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); }
function cloneDigest(operation: AgentCloneOperation) { const { manifestDigest: _, ...body } = operation; return digest(body); }
function cloneStamp(operation: AgentCloneOperation) { return { agentId: operation.identity.agentId, operationId: operation.operationId, manifestDigest: operation.manifestDigest }; }
function personalMemory(config: AgentConfig) { return config.schemaVersion === 2 ? config.storage.personalMemory : null; }
function operationMemory(operation: AgentSetupOperation) {
  return operation.schemaVersion === 1 ? null : operation.kind === 'initialize' ? operation.personalMemory : operation.config.storage.personalMemory;
}
function checkMemoryOption(option: AgentSetupOptions['personalMemory'], selected: ReturnType<typeof personalMemory>) {
  if (option !== undefined && option !== (selected?.backend ?? 'sqlite')) fail('agent_personal_memory_backend_mismatch');
}
function operationState(operation: AgentSetupOperation) {
  return operation.kind === 'clone' ? operation.config.storage.state : operation.stateBackend ?? 'sqlite';
}
function operationPostgres(operation: AgentSetupOperation) { return operation.kind === 'clone' ? operation.config.storage.postgres : operation.postgres; }
function checkPostgresOption(option: AgentSetupOptions['postgres'], selected: AgentSetupOptions['postgres']) {
  if (option !== undefined && digest(option) !== digest(selected ?? null)) fail('agent_postgres_selection_mismatch');
}
function checkStateOption(option: AgentSetupOptions['stateBackend'], selected: AgentConfig['storage']['state']) {
  if (option !== undefined && option !== selected) fail('agent_state_backend_mismatch');
}

/** Host-side setup only. Work tools receive scoped stores, never this initializer. */
export class FileAgentProfileStore implements AgentProfileStore {
  readonly #engine: string;
  constructor(engineDirectory: string) { this.#engine = process.platform === 'win32' ? windowsProfilePath(engineDirectory) : realpathSync(engineDirectory); }

  get engineDirectories(): readonly string[] { return Object.freeze([this.#engine]); }

  assertRuntimeCompatible(directory: string) { assertAgentEnginePin(this.#root(directory), this.#engine); }

  #root(input: string, create = false, scope?: HostFileMutationScope) {
    const absolute = resolve(input); const existing = process.platform === 'win32' ? null : stat(absolute);
    if (existing?.isSymbolicLink()) fail('agent_directory_unsafe');
    const root = process.platform === 'win32' ? windowsProfilePath(absolute, true) : existing ? realpathSync(absolute) : join(realpathSync(dirname(absolute)), basename(absolute));
    if (pathExists(join(root, '.secumon-restore-in-progress.json'))) fail('agent_restore_incomplete');
    if (contains(this.#engine, root) || contains(root, this.#engine)) fail('agent_engine_overlap');
    for (let parent = dirname(root); parent !== dirname(parent); parent = dirname(parent)) {
      if (['identity.json', 'setup.json', 'setup-operation.json'].some(file => pathExists(join(parent, '.secumon', file)))) fail('agent_nested_workspace');
    }
    directory(root, create, false, scope);
    return root;
  }
  #paths(root: string, config?: AgentConfig): AgentPaths {
    const metadata = join(root, '.secumon');
    return { root, metadata, state: join(metadata, config?.storage.state === 'file-journal' ? 'state-journal' : 'runtime.sqlite'),
      memory: join(root, 'memory', 'memory.sqlite'), artifacts: join(metadata, 'artifacts'), skills: join(root, 'skills'), workspace: join(root, 'workspace') };
  }
  #read(root: string, scope?: HostFileMutationScope) {
    const paths = this.#paths(root);
    const hasMetadata = directory(paths.metadata, false, true, scope);
    let operation = hasMetadata ? read(join(paths.metadata, 'setup-operation.json'), AgentSetupOperationSchema, [1, 2], 512 * 1024, scope) : null;
    const identity = hasMetadata ? read(join(paths.metadata, 'identity.json'), AgentIdentitySchema, undefined, undefined, scope) : null;
    const receipt = hasMetadata ? read(join(paths.metadata, 'setup.json'), receiptSchema, [1, 2], undefined, scope) : null;
    const completion = hasMetadata ? read(join(paths.metadata, 'clone-complete.json'), AgentCloneCompletionSchema, undefined, undefined, scope) : null;
    const config = read(join(root, 'config.json'), AgentConfigSchema, [1, 2], undefined, scope);
    // A concurrent initializer may publish the operation after our first read, then publish these files.
    if (hasMetadata && !operation && (identity || receipt || config)) {
      operation = read(join(paths.metadata, 'setup-operation.json'), AgentSetupOperationSchema, [1, 2], 512 * 1024, scope);
    }
    if (operation?.kind === 'clone' && (cloneDigest(operation) !== operation.manifestDigest ||
      digest(operation.identity) !== digest(operation.config.identity) || digest(operation.entries) !== operation.source.skillsDigest ||
      operation.identity.agentId === operation.source.identity.agentId)) fail('agent_clone_operation_invalid');
    if (config && (config.schemaVersion === 2 && !operation || operation && digest(personalMemory(config)) !== digest(operationMemory(operation)))) {
      fail('agent_personal_memory_profile_mismatch');
    }
    if (config && operation?.kind === 'initialize' && operation.stateBackend !== undefined &&
      config.storage.state !== operation.stateBackend) fail('agent_state_backend_mismatch');
    if (config && operation && digest(config.storage.postgres ?? null) !== digest(operationPostgres(operation) ?? null)) fail('agent_postgres_selection_mismatch');
    const ids = [identity?.agentId, receipt?.agentId, config?.identity.agentId, operation?.identity.agentId, completion?.agentId].filter(value => value !== undefined);
    const identities = [identity, config?.identity, operation?.identity].filter(value => value !== undefined && value !== null);
    if (new Set(ids).size > 1 || new Set(identities.map(value => value.createdAt)).size > 1) fail('agent_identity_mismatch');
    if (receipt?.schemaVersion === 2 && (operation?.kind !== 'clone' ||
      receipt.operationId !== operation.operationId || receipt.manifestDigest !== operation.manifestDigest)) fail('agent_clone_operation_invalid');
    if (operation?.kind === 'clone' && receipt?.schemaVersion === 1) fail('agent_clone_operation_conflict');
    if (completion && (operation?.kind !== 'clone' || receipt?.schemaVersion !== 2 ||
      completion.operationId !== operation.operationId || completion.manifestDigest !== operation.manifestDigest)) fail('agent_clone_operation_invalid');
    return { paths, identity, receipt, config, hasMetadata, operation, completion };
  }
  #unboundData(root: string, scope?: HostFileMutationScope) {
    for (const path of [join(root, '.secumon'), join(root, 'memory')]) {
      if (!directory(path, false, true, scope)) continue;
      if (directoryNames(path).some(name => !/^\.secumon-init-[a-f0-9-]+\.pending$/.test(name))) return true;
    }
    return false;
  }
  inspect(input: string): AgentProfileStatus { return this.#inspect(input); }
  #inspect(input: string, scope?: HostFileMutationScope): AgentProfileStatus {
    if (scope) checkProfileMutationScope(scope);
    const root = this.#root(input, false, scope); if (!pathExists(root)) return { status: 'uninitialized', root };
    let current = this.#read(root, scope);
    if (!current.identity && !current.config && !current.receipt && !current.operation) {
      if (!this.#unboundData(root, scope)) return { status: 'uninitialized', root };
      // Another initializer can publish ownership between the empty read and directory scan.
      current = this.#read(root, scope);
      if (!current.identity && !current.config && !current.receipt && !current.operation) {
        return { status: 'incomplete', root, agentId: null, missing: ['identity', 'config'], recoverable: false };
      }
    }
    const { paths, identity, receipt, config, operation, completion } = current;
    const missing: string[] = [];
    if (!identity) missing.push('identity'); if (!config) missing.push('config'); if (!receipt) missing.push('setup');
    for (const [name, path] of [['memory', dirname(paths.memory)], ['skills', paths.skills], ['workspace', paths.workspace], ['artifacts', paths.artifacts]]) {
      if (name && path && !directory(path, false, true, scope)) missing.push(name);
    }
    if (operation?.kind === 'clone' && !completion) {
      missing.push('clone-completion');
      return { status: 'incomplete', root, agentId: operation.identity.agentId, missing, recoverable: true, recovery: 'clone' };
    }
    if (missing.length || !identity || !config) return { status: 'incomplete', root, agentId: identity?.agentId ?? config?.identity.agentId ?? operation?.identity.agentId ?? receipt?.agentId ?? null,
      missing, recoverable: Boolean((identity || config || operation?.kind === 'initialize') && !(receipt && !config)) };
    const profile = { status: 'ready' as const, root, identity, config, paths: this.#paths(root, config), modelReady: false as const };
    const personal = { ...profile, ...inspectMigrationSelection(profile) };
    return { ...personal, ...inspectPostgresMigration(personal) };
  }
  initialize(input: string, rawOptions: AgentSetupOptions = {}): Extract<AgentProfileStatus, { status: 'ready' }> {
    const parsed = AgentSetupOptionsSchema.safeParse(rawOptions); if (!parsed.success) return fail('agent_setup_options_invalid');
    const root = this.#root(input); const scope = openProfileMutationScope(root, [this.#engine]);
    try { const result = this.#initialize(root, parsed.data, scope); checkProfileMutationScope(scope); return result; }
    finally { scope.close(); }
  }
  #initialize(input: string, options: AgentSetupOptions, scope: HostFileMutationScope): Extract<AgentProfileStatus, { status: 'ready' }> {
    const before = this.#inspect(input, scope);
    if (before.status === 'ready') {
      checkMemoryOption(options.personalMemory, before.effectivePersonalMemory.backend === 'documents' ? before.effectivePersonalMemory : null);
      checkPostgresOption(options.postgres, before.config.storage.postgres);
      checkStateOption(options.stateBackend, before.config.storage.state);
      if (options.name !== undefined && options.name !== before.config.name || options.purpose !== undefined && options.purpose !== before.config.purpose) fail('agent_config_already_exists');
      // Reconcile namespace barriers after an earlier publication or directory-creation interruption.
      directory(before.root, true, false, scope); directory(before.paths.metadata, true, true, scope);
      sync(before.paths.metadata, scope); sync(before.root, scope);
      return before;
    }
    if (before.status === 'incomplete' && before.recovery === 'clone') fail('agent_clone_resume_required');
    if (before.status === 'incomplete' && (!before.recoverable || !options.repair && !before.missing.includes('setup'))) fail(before.recoverable ? 'agent_repair_required' : 'agent_recovery_source_required');
    const root = this.#root(input, true, scope); const paths = this.#paths(root);
    directory(paths.metadata, true, true, scope); sync(root, scope);
    let current = this.#read(root, scope);
    if (current.operation || current.config || current.identity || current.receipt) {
      checkPostgresOption(options.postgres, current.config?.storage.postgres ?? (current.operation ? operationPostgres(current.operation) : undefined));
      checkMemoryOption(options.personalMemory, current.operation ? operationMemory(current.operation) : current.config ? personalMemory(current.config) : null);
      checkStateOption(options.stateBackend, current.config?.storage.state ?? (current.operation ? operationState(current.operation) : options.stateBackend ?? 'sqlite'));
    }
    if (!current.operation) {
      const identity = current.identity ?? current.config?.identity ?? { schemaVersion: 1 as const, agentId: randomUUID(), createdAt: Date.now() };
      const selected = options.personalMemory === 'documents' ? { backend: 'documents' as const, storeId: randomUUID() } : null;
      const stateBackend = current.config?.storage.state ?? options.stateBackend ?? 'sqlite';
      const stateSelection = { ...(stateBackend === 'file-journal' || options.stateBackend !== undefined ? { stateBackend } : {}),
        ...(options.postgres ? { postgres: options.postgres } : {}) };
      publish(join(paths.metadata, 'setup-operation.json'), selected ?
        { schemaVersion: 2, kind: 'initialize', operationId: randomUUID(), identity, personalMemory: selected, ...stateSelection } :
        { schemaVersion: 1, kind: 'initialize', operationId: randomUUID(), identity, ...stateSelection }, scope);
      current = this.#read(root, scope);
    }
    checkMemoryOption(options.personalMemory, operationMemory(current.operation!));
    checkStateOption(options.stateBackend, current.config?.storage.state ?? operationState(current.operation!));
    if (current.operation?.kind === 'clone' && !current.completion) fail('agent_clone_resume_required');
    if (!current.identity) {
      publish(join(paths.metadata, 'identity.json'), current.config?.identity ?? current.operation!.identity, scope); current = this.#read(root, scope);
    }
    const identity = current.identity!;
    if (!current.config) {
      if (current.receipt) return fail('agent_recovery_source_required');
      const selected = operationMemory(current.operation!);
      const config = AgentConfigSchema.parse({ schemaVersion: selected ? 2 : 1, identity, name: options.name ?? basename(root), purpose: options.purpose ?? '',
        storage: { state: operationState(current.operation!), memory: 'sqlite', artifacts: 'files', ...(selected ? { personalMemory: selected } : {}),
          ...(operationPostgres(current.operation!) ? { postgres: operationPostgres(current.operation!) } : {}) },
        model: null, features: { board: false, archive: false }, skills: { mode: 'on-demand' } });
      publish(join(root, 'config.json'), config, scope);
    }
    current = this.#read(root, scope);
    if (options.name !== undefined && current.config!.name !== options.name || options.purpose !== undefined && current.config!.purpose !== options.purpose) fail('agent_config_already_exists');
    this.#directories(paths, scope);
    if (!current.receipt) publish(join(paths.metadata, 'setup.json'), { schemaVersion: 1, agentId: identity.agentId }, scope);
    const result = this.#inspect(root, scope); if (result.status !== 'ready') return fail('agent_setup_incomplete');
    return result;
  }
  #directories(paths: AgentPaths, scope: HostFileMutationScope) {
    for (const path of [dirname(paths.memory), paths.skills, paths.workspace, paths.artifacts]) { directory(path, true, true, scope); sync(path, scope); sync(dirname(path), scope); }
  }
  #checkCloneTarget(root: string, scope: HostFileMutationScope) {
    const paths = this.#paths(root);
    const only = (path: string, allowed: string[], allowPending = false) => {
      if (!directory(path, false, true, scope)) return;
      for (const name of directoryNames(path)) {
        if (allowed.includes(name)) continue;
        if (allowPending && /^\.secumon-init-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pending$/.test(name)) {
          if (process.platform === 'win32') {
            const entry = windowsPathInfo(join(path, name));
            if (entry?.kind === 'regular' && BigInt(entry.bytes) <= 512n * 1024n) continue;
            fail('agent_clone_target_conflict');
          }
          const entry = stat(join(path, name));
          if (entry?.isFile() && !entry.isSymbolicLink() && (entry.mode & 0o077) === 0 &&
            entry.size <= 512 * 1024 && (typeof process.getuid !== 'function' || entry.uid === process.getuid()) &&
            (entry.nlink === 1 || entry.nlink === 2 && allowed.some(file => {
              const published = stat(join(path, file)); return published?.isFile() && published.dev === entry.dev && published.ino === entry.ino;
            }))) continue;
        }
        fail('agent_clone_target_conflict');
      }
    };
    only(root, ['.secumon', 'config.json', 'skills', 'memory', 'workspace'], true);
    only(paths.metadata, ['setup-operation.json', 'setup.json', 'identity.json', 'clone-complete.json', 'artifacts'], true);
    for (const path of [dirname(paths.memory), paths.workspace, paths.artifacts]) only(path, []);
  }
  clone(sourceInput: string, destinationInput: string, rawOptions: AgentCloneOptions = {}): Extract<AgentProfileStatus, { status: 'ready' }> {
    const parsed = AgentCloneOptionsSchema.safeParse(rawOptions); if (!parsed.success) return fail('agent_clone_options_invalid');
    const root = this.#root(destinationInput); const scope = openProfileMutationScope(root, [this.#engine]);
    try { const result = this.#clone(sourceInput, root, parsed.data, scope); checkProfileMutationScope(scope); return result; }
    finally { scope.close(); }
  }
  #clone(sourceInput: string, destinationInput: string, options: AgentCloneOptions, scope: HostFileMutationScope): Extract<AgentProfileStatus, { status: 'ready' }> {
    const source = this.inspect(sourceInput);
    if (source.status !== 'ready') return fail('agent_clone_source_not_ready');
    if (source.personalMemoryMigration?.phase === 'pending') return fail('agent_migration_resume_required');
    const root = this.#root(destinationInput, false, scope); const paths = this.#paths(root);
    if (contains(root, source.root) || contains(source.root, root)) fail('agent_clone_path_overlap');
    let operation: AgentCloneOperation;
    if (options.resume) {
      if (!pathExists(root)) return fail('agent_clone_resume_missing');
      const current = this.#read(root, scope);
      if (current.operation?.kind !== 'clone') return fail('agent_clone_resume_missing');
      operation = current.operation;
      if (digest(operation.source.identity) !== digest(source.identity)) fail('agent_clone_source_changed');
      if (options.name !== undefined && options.name !== operation.config.name) fail('agent_clone_options_conflict');
      if (current.completion) {
        const ready = this.#inspect(root, scope); if (ready.status !== 'ready') return fail('agent_repair_required');
        directory(root, true, false, scope); directory(paths.metadata, true, true, scope);
        sync(paths.metadata, scope); sync(root, scope);
        return ready;
      }
    } else {
      if (pathExists(root)) fail('agent_clone_target_exists');
      const entries = captureCloneSkills(source.paths.skills);
      const identity: AgentIdentity = { schemaVersion: 1, agentId: randomUUID(), createdAt: Math.max(Date.now(), source.identity.createdAt + 1) };
      const config: AgentConfig = AgentConfigSchema.parse(source.effectivePersonalMemory.backend === 'documents' ? { ...source.config, schemaVersion: 2, identity, name: options.name ?? basename(root),
        storage: { ...source.config.storage, personalMemory: { backend: 'documents', storeId: randomUUID() } } } :
        { ...source.config, storage: { ...source.config.storage }, identity, name: options.name ?? basename(root) });
      const postgres = effectiveAgentPostgresSelection(source);
      if (postgres) config.storage.postgres = { ...postgres, storeId: randomUUID(), registrationId: randomUUID() };
      const candidate = AgentSetupOperationSchema.parse({ schemaVersion: config.schemaVersion, kind: 'clone', operationId: randomUUID(), identity, config,
        source: { identity: source.identity, configDigest: digest(source.config), skillsDigest: digest(entries) }, entries, manifestDigest: '0'.repeat(64) });
      if (candidate.kind !== 'clone') return fail('agent_clone_operation_invalid');
      operation = { ...candidate, manifestDigest: cloneDigest(candidate) };
      if (Buffer.byteLength(JSON.stringify(operation, null, 2) + '\n') > 512 * 1024) fail('agent_clone_limit_exceeded');
      try { directory(root, true, false, scope, true); } catch (error) { if (code(error) === 'EEXIST') return fail('agent_clone_target_exists'); throw error; }
      directory(paths.metadata, true, true, scope); sync(root, scope);
      publish(join(paths.metadata, 'setup-operation.json'), operation, scope);
      const winner = this.#read(root, scope).operation;
      if (winner?.kind !== 'clone' || winner.operationId !== operation.operationId) fail('agent_clone_operation_conflict');
    }
    this.#checkCloneTarget(root, scope);
    const currentSource = this.inspect(source.root);
    if (currentSource.status !== 'ready' || digest(currentSource.config) !== operation.source.configDigest ||
      digest(captureCloneSkills(currentSource.paths.skills)) !== operation.source.skillsDigest) fail('agent_clone_source_changed');
    publish(join(paths.metadata, 'setup.json'), { schemaVersion: 2, ...cloneStamp(operation) }, scope);
    this.#read(root, scope);
    publish(join(paths.metadata, 'identity.json'), operation.identity, scope);
    publish(join(root, 'config.json'), operation.config, scope);
    const copied = this.#read(root, scope);
    if (digest(copied.config) !== digest(operation.config)) fail('agent_clone_target_conflict');
    this.#directories(paths, scope);
    copyCloneSkills(source.paths.skills, paths.skills, operation.entries, scope);
    const afterSource = this.inspect(source.root);
    if (afterSource.status !== 'ready' || digest(afterSource.config) !== operation.source.configDigest) fail('agent_clone_source_changed');
    verifyCloneSkills(paths.skills, operation.entries); this.#checkCloneTarget(root, scope);
    const finalMetadata = this.#read(root, scope);
    if (digest(finalMetadata.config) !== digest(operation.config)) fail('agent_clone_target_conflict');
    publish(join(paths.metadata, 'clone-complete.json'), { schemaVersion: 1, ...cloneStamp(operation) }, scope);
    const result = this.#inspect(root, scope); if (result.status !== 'ready') return fail('agent_setup_incomplete');
    return result;
  }
}
