import { lstatSync, opendirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AgentIdentitySchema, AgentProfileError } from '../application/agent-profile-contracts.js';
import { AgentHostIdentityRecordSchema, AgentHostIdentityRebindProofSchema,
  type AgentHostIdentitySubject, type AgentHostIdentityOptions, type AgentHostIdentityRecord,
  type AgentHostIdentityHead, type AgentHostIdentityClaim, type AgentHostIdentityRebindProof,
  type WithVerifiedAgentRestore } from '../application/agent-host-identity-contracts.js';
import { frozen } from '../application/resource-contracts.js';
import { FileBoundaryFault, hostMetadataFiles, sameFileIdentity, completeMetadataPublication, releaseMetadataDirectory,
  type FileIdentity, type HostMetadataFiles, type MetadataDirectory } from './host-metadata-files.js';
import { hostFileMutations, type HostFileMutationScope } from './host-file-mutations.js';
import { WindowsMetadataFiles, windowsAbsolutePath } from './windows-metadata-files.js';
import { windowsCanonicalPath } from './windows-profile-files.js';
import { sha256 } from './digest.js';

export type { AgentHostIdentitySubject, AgentHostIdentityOptions, AgentHostIdentityHead, AgentHostIdentityClaim,
  AgentHostIdentityRecord, AgentHostIdentityRebindProof, WithVerifiedAgentRestore } from '../application/agent-host-identity-contracts.js';

const maximumRecords = 1024, maximumBytes = 65536;
const publicationWait = new Int32Array(new SharedArrayBuffer(4));
const pendingName = /^\.secumon-init-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pending$/;
const recordName = (sequence: number) => `${String(sequence).padStart(8, '0')}.json`;
const fail = (code: string): never => { throw new AgentProfileError(`agent_host_identity_${code}`); };
const missing = (error: unknown) => error instanceof FileBoundaryFault && error.code === 'missing' ||
  (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const sameIdentity = (a: AgentHostIdentitySubject['identity'], b: AgentHostIdentitySubject['identity']) =>
  a.agentId === b.agentId && a.createdAt === b.createdAt && a.schemaVersion === b.schemaVersion;
function path(input: string): string {
  if (typeof input !== 'string' || !input || input.length > 4096 || /[\x00-\x1f\x7f]/.test(input)) return fail('path_invalid');
  const value = resolve(input); return process.platform === 'win32' ? windowsAbsolutePath(value) : value;
}
export function agentHostIdentityRegistryDirectory(options: Pick<AgentHostIdentityOptions, 'registryDirectory'> = {}): string {
  return path(options.registryDirectory ?? join(homedir(), '.secumon', 'host-identities'));
}
function canonical(input: string): string {
  if (process.platform === 'win32') return windowsCanonicalPath(input);
  let current = input; const suffix: string[] = [];
  for (;;) {
    try { return join(realpathSync(current), ...suffix.reverse()); }
    catch (error) { if (!missing(error) || dirname(current) === current) throw error; suffix.push(basename(current)); current = dirname(current); }
  }
}
const comparisonPath = (input: string) => process.platform === 'win32' ? input.toUpperCase() : input;
function inside(parent: string, child: string): boolean {
  const part = relative(comparisonPath(parent), comparisonPath(child));
  return part === '' || !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
}
function disjoint(a: string, b: string) { if (inside(a, b) || inside(b, a)) fail('directory_overlap'); }
function cleanup(actions: readonly (() => void)[], primary?: { error: unknown }): void {
  const errors: unknown[] = primary ? [primary.error] : [];
  for (const action of actions) { try { action(); } catch (error) { errors.push(error); } }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'agent_host_identity_cleanup_failed');
}
type ReadRecord = { head: AgentHostIdentityHead; fileIdentity: FileIdentity };
type Directory = { path: string; reference: MetadataDirectory; access: 'private' | 'owner-writable' | 'traverse' };
type History = readonly ReadRecord[];

/** One operation/claim owns its actual directory references; the registry is outside the agent tree. */
class IdentityContext {
  readonly files: HostMetadataFiles;
  readonly subject: AgentHostIdentitySubject;
  readonly registryPath: string;
  readonly root: Directory;
  readonly metadata: Directory;
  readonly #engines: Directory[] = [];
  readonly #registryCanonical: string;
  readonly #rootCanonical: string;
  readonly #engineCanonical: string[];
  readonly #defaultRegistry: boolean;
  #scope: HostFileMutationScope | undefined;
  #registry: MetadataDirectory | undefined;
  #agent: MetadataDirectory | undefined;
  #sourceIdentity: FileIdentity | undefined;
  #closed = false;
  constructor(subject: AgentHostIdentitySubject, options: AgentHostIdentityOptions) {
    const identity = AgentIdentitySchema.parse(subject.identity), rootPath = path(subject.root);
    if (!options || !Array.isArray(options.engineDirectories) || !options.engineDirectories.length || options.engineDirectories.length > 32)
      fail('engine_registration_required');
    const engines = [...new Set(options.engineDirectories.map(path))];
    this.subject = frozen({ root: rootPath, identity });
    this.#defaultRegistry = options.registryDirectory === undefined;
    this.registryPath = agentHostIdentityRegistryDirectory(options);
    this.#registryCanonical = canonical(this.registryPath); this.#rootCanonical = canonical(rootPath);
    this.#engineCanonical = engines.map(canonical);
    disjoint(this.#registryCanonical, this.#rootCanonical);
    for (const engine of this.#engineCanonical) { disjoint(engine, this.#registryCanonical); disjoint(engine, this.#rootCanonical); }
    this.files = hostMetadataFiles();
    const acquired: Directory[] = [];
    const directory = (input: string, access: Directory['access']): Directory => {
      const reference = this.files.inspectDirectory(input, access); if (!reference) return fail('directory_missing');
      const value = { path: input, reference, access }; acquired.push(value); return value;
    };
    try {
      this.root = directory(rootPath, 'owner-writable'); this.metadata = directory(join(rootPath, '.secumon'), 'private');
      for (const engine of engines) this.#engines.push(directory(engine, 'traverse'));
      this.checkSource();
    } catch (error) { cleanup(acquired.reverse().map(value => () => releaseMetadataDirectory(this.files, value.reference)), { error }); throw error; }
  }
  #alive() { if (this.#closed) fail('closed'); }
  #checkDirectory(value: Directory) {
    if (!this.files.inspectDirectory(value.path, value.access, value.reference)) fail('directory_changed');
  }
  #fileIdentity(directory: MetadataDirectory, directoryPath: string, name: string): FileIdentity {
    if (this.files instanceof WindowsMetadataFiles) {
      const info = this.files.inspectChild(directory, name, true);
      if (!info || info.kind !== 'regular') return fail('record_unsafe');
      const match = /^([a-f0-9]{8}):([a-f0-9]{16})$/.exec(info.identity); if (!match) return fail('record_unsafe');
      return { volume: match[1]!, object: match[2]! };
    }
    const stat = lstatSync(join(directoryPath, name), { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!()) || stat.mode & 0o077n)
      return fail('record_unsafe');
    return { volume: String(stat.dev), object: String(stat.ino) };
  }
  #read(directory: MetadataDirectory, directoryPath: string, name: string) {
    const before = this.#fileIdentity(directory, directoryPath, name);
    const bytes = this.files.readStableRegularFile(directory, name, { maximum: maximumBytes, access: 'private' });
    if (!sameFileIdentity(before, this.#fileIdentity(directory, directoryPath, name))) fail('record_changed');
    return { bytes, fileIdentity: before };
  }
  checkSource() {
    this.#alive();
    for (const value of [this.root, this.metadata, ...this.#engines]) this.#checkDirectory(value);
    if (comparisonPath(canonical(this.subject.root)) !== comparisonPath(this.#rootCanonical) ||
      comparisonPath(canonical(this.registryPath)) !== comparisonPath(this.#registryCanonical)) fail('directory_changed');
    for (const [index, engine] of this.#engines.entries()) {
      const current = canonical(engine.path);
      if (comparisonPath(current) !== comparisonPath(this.#engineCanonical[index]!)) fail('directory_changed');
      disjoint(current, this.#rootCanonical); disjoint(current, this.#registryCanonical);
    }
    const source = this.#read(this.metadata.reference, this.metadata.path, 'identity.json');
    const identity = AgentIdentitySchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)));
    if (!sameIdentity(identity, this.subject.identity)) fail('source_changed');
    if (this.#sourceIdentity && !sameFileIdentity(this.#sourceIdentity, source.fileIdentity)) fail('source_changed');
    this.#sourceIdentity ??= source.fileIdentity;
    this.#scope?.check();
  }
  open(create: boolean): boolean {
    this.checkSource();
    const parentPath = dirname(this.registryPath);
    const parent = this.files.inspectDirectory(parentPath, 'traverse');
    if (parent) releaseMetadataDirectory(this.files, parent);
    else {
      if (!create) return false;
      if (!this.#defaultRegistry) return fail('registry_parent_missing');
      const bootstrap = hostFileMutations().openScope({ root: parentPath, forbiddenRoots: [this.subject.root, ...this.#engines.map(value => value.path)] });
      try {
        const directory = bootstrap.directory(parentPath, 'private', true); if (!directory) fail('registry_parent_missing');
        completeMetadataPublication(this.files, directory!); bootstrap.check();
      } catch (error) { cleanup([() => bootstrap.close()], { error }); throw error; }
      bootstrap.close();
    }
    this.#scope = hostFileMutations().openScope({ root: this.registryPath, forbiddenRoots: [this.subject.root, ...this.#engines.map(value => value.path)] });
    this.#registry = this.#scope.directory(this.registryPath, 'private', create) ?? undefined;
    if (!this.#registry) return false;
    this.#agent = this.#scope.directory(join(this.registryPath, this.subject.identity.agentId.toLowerCase()), 'private', create) ?? undefined;
    this.checkSource(); return this.#agent !== undefined;
  }
  #listedNames(): string[] {
    if (!this.#agent) return [];
    const path = join(this.registryPath, this.subject.identity.agentId.toLowerCase());
    let names: string[];
    if (this.files instanceof WindowsMetadataFiles) names = this.files.names(this.#agent, maximumRecords + 1);
    else {
      const directory = opendirSync(path); names = [];
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (names.length >= maximumRecords + 1) fail('history_limit'); names.push(entry.name);
        }
      } finally { directory.closeSync(); }
    }
    if (names.length > maximumRecords) fail('history_limit');
    return names.sort();
  }
  #names(): string[] {
    const deadline = performance.now() + 1000;
    for (let attempt = 0; ; attempt++) {
      this.checkSource(); const names = this.#listedNames(), pending = names.filter(name => name.endsWith('.pending'));
      if (!pending.length) return names;
      if (pending.some(name => !pendingName.test(name)) || attempt >= 100 || performance.now() >= deadline) return fail('publication_incomplete');
      // Other processes may still be flushing and unlinking their own candidate. Never inspect, adopt or remove it here.
      Atomics.wait(publicationWait, 0, 0, Math.min(10, Math.max(0, deadline - performance.now())));
    }
  }
  history(): History {
    for (let observation = 0; observation < 2; observation++) {
      this.checkSource(); const names = this.#names(), records: ReadRecord[] = [];
      const directoryPath = join(this.registryPath, this.subject.identity.agentId.toLowerCase());
      for (const [index, name] of names.entries()) {
        if (name !== recordName(index + 1)) fail('history_invalid');
        const current = this.#read(this.#agent!, directoryPath, name);
        const record = AgentHostIdentityRecordSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(current.bytes)));
        const previous = records.at(-1)?.head ?? null;
        if (record.sequence !== index + 1 || record.previous !== (previous?.digest ?? null) || !sameIdentity(record.identity, this.subject.identity))
          fail('history_invalid');
        records.push({ head: frozen({ record, digest: sha256(current.bytes) }), fileIdentity: current.fileIdentity });
      }
      const after = this.#names();
      // Re-read the real first winner if it appeared after an empty observation; every identity/hash check still applies.
      if (observation === 0 && !names.length && after.length === 1 && after[0] === recordName(1)) continue;
      if (JSON.stringify(names) !== JSON.stringify(after)) fail('history_changed');
      this.checkSource(); return records;
    }
    return fail('history_changed');
  }
  assertHistory(expected: History): History {
    const current = this.history();
    if (current.length !== expected.length || current.some((value, index) => value.head.digest !== expected[index]!.head.digest ||
      !sameFileIdentity(value.fileIdentity, expected[index]!.fileIdentity))) fail('registration_changed');
    return current;
  }
  matches(head: AgentHostIdentityHead): boolean { return sameIdentity(head.record.identity, this.subject.identity) && sameFileIdentity(head.record.rootIdentity, this.root.reference.identity); }
  publish(previous: History, reason: AgentHostIdentityRecord['reason']): History {
    if (!this.#agent || !this.#scope) return fail('registry_missing');
    // The first immutable filename itself is the CAS; another first claimant may already have won.
    if (previous.length) this.assertHistory(previous); else this.checkSource();
    const sequence = previous.length + 1; if (sequence > maximumRecords) fail('history_limit');
    const record = AgentHostIdentityRecordSchema.parse({ schemaVersion: 1, kind: 'agent-host-identity-registration', sequence,
      identity: this.subject.identity, rootIdentity: this.root.reference.identity, registeredRoot: this.#rootCanonical,
      previous: previous.at(-1)?.head.digest ?? null, reason, recordedAt: Date.now() });
    const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n'); if (bytes.length > maximumBytes) fail('record_too_large');
    this.#scope.publish(this.#agent, recordName(sequence), bytes);
    completeMetadataPublication(this.files, this.#agent); this.checkSource();
    const current = this.history(), selected = current.at(-1)?.head;
    if (!selected || current.length !== sequence || selected.record.previous !== record.previous || !this.matches(selected)) return fail('claim_conflict');
    if (reason.kind === 'restore' && (selected.record.reason.kind !== 'restore' || JSON.stringify(selected.record.reason) !== JSON.stringify(reason))) fail('rebind_conflict');
    return current;
  }
  close() {
    if (this.#closed) return; this.#closed = true;
    cleanup([() => this.#scope?.close(), ...[...this.#engines, this.metadata, this.root].reverse().map(value => () => releaseMetadataDirectory(this.files, value.reference))]);
  }
}

/** No creation, claim, adoption or directory rewrite. A different object can inspect the registered head. */
export function inspectAgentHostIdentity(subject: AgentHostIdentitySubject, options: AgentHostIdentityOptions): AgentHostIdentityHead | null {
  const context = new IdentityContext(subject, options); let primary: { error: unknown } | undefined;
  try { if (!context.open(false)) return null; return context.history().at(-1)?.head ?? null; }
  catch (error) { primary = { error }; throw error; }
  finally { cleanup([() => context.close()], primary); }
}

export function claimAgentHostIdentity(subject: AgentHostIdentitySubject, options: AgentHostIdentityOptions): AgentHostIdentityClaim {
  const context = new IdentityContext(subject, options);
  try {
    context.open(true); let records = context.history();
    if (!records.length) records = context.publish(records, { kind: 'claim' });
    const head = records.at(-1)!.head; if (!context.matches(head)) fail('duplicate_identity');
    context.assertHistory(records);
    return Object.freeze({ ...head, assertCurrent() { context.assertHistory(records); if (!context.matches(head)) fail('duplicate_identity'); }, close: () => context.close() });
  } catch (error) { cleanup([() => context.close()], { error }); throw error; }
}

function sameRestore(head: AgentHostIdentityHead, proof: AgentHostIdentityRebindProof): boolean {
  const reason = head.record.reason;
  return reason.kind === 'restore' && reason.operationId === proof.operationId && reason.backupDigest === proof.backupDigest &&
    reason.originalRoot === proof.originalRoot && head.record.previous === proof.expectedHeadDigest;
}
/** Publication is available only inside a host-owned, still-current verified restore/maintenance scope. */
export async function rebindAgentHostIdentity(subject: AgentHostIdentitySubject, options: AgentHostIdentityOptions,
  withVerifiedRestore: WithVerifiedAgentRestore): Promise<AgentHostIdentityHead> {
  if (typeof withVerifiedRestore !== 'function') return fail('restore_proof_required');
  const context = new IdentityContext(subject, options); let primary: { error: unknown } | undefined;
  let active = true, used = false, settled = false, pending: Promise<void> | undefined, selected: History | undefined;
  try {
    if (!context.open(false)) return fail('registration_missing');
    await withVerifiedRestore((input, assertProofCurrent) => {
      if (!active || used || typeof assertProofCurrent !== 'function') return Promise.reject(new AgentProfileError('agent_host_identity_restore_scope_invalid'));
      used = true;
      pending = (async () => {
        try {
          const proof = AgentHostIdentityRebindProofSchema.parse(input);
          proof.originalRoot = canonical(path(proof.originalRoot));
          if (comparisonPath(proof.originalRoot) !== comparisonPath(canonical(context.subject.root))) fail('restore_root_mismatch');
          const before = context.history(), head = before.at(-1)?.head;
          if (!head) return fail('registration_missing');
          if (!sameRestore(head, proof) && head.digest !== proof.expectedHeadDigest) fail('rebind_conflict');
          await assertProofCurrent(); if (!active) fail('restore_scope_closed');
          context.assertHistory(before);
          if (sameRestore(head, proof)) {
            if (!context.matches(head)) fail('rebind_conflict'); selected = before;
          } else {
            if (context.matches(head)) fail('restore_object_unchanged');
            selected = context.publish(before, { kind: 'restore', operationId: proof.operationId, backupDigest: proof.backupDigest, originalRoot: proof.originalRoot });
          }
          await assertProofCurrent(); if (!active) fail('restore_scope_closed');
          context.assertHistory(selected);
        } finally { settled = true; }
      })();
      // A callback which abandons this promise must not produce an unhandled rejection.
      void pending.catch(() => {}); return pending;
    });
    active = false;
    if (!used || !pending) fail('restore_proof_required');
    if (!settled) fail('restore_scope_closed');
    await pending;
    if (!selected) return fail('restore_scope_closed');
    context.assertHistory(selected); return selected.at(-1)!.head;
  } catch (error) { primary = { error }; throw error; }
  finally { active = false; cleanup([() => context.close()], primary); }
}
