import { createRequire } from 'node:module';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { disjoint, lifecycleRoot } from './agent-lifecycle-files.js';
import { openProfileMutationScope } from './agent-profile-files.js';
import { hostMetadataFiles, releaseMetadataDirectory, sameFileIdentity, type FileIdentity, type HostMetadataFiles,
  type MetadataDirectory, type MetadataPublicationBarrier } from './host-metadata-files.js';

export interface HostDirectoryRetirementInput {
  readonly source: string;
  readonly destination: string;
  readonly expectedIdentity: FileIdentity;
  readonly forbiddenRoots: readonly string[];
}
export interface HostDirectoryRetirementInspection {
  readonly sourceIdentity: FileIdentity | null;
  readonly destinationIdentity: FileIdentity | null;
  readonly retired: boolean;
}
export interface HostDirectoryRetirementResult extends HostDirectoryRetirementInspection, MetadataPublicationBarrier {
  readonly outcome: 'moved' | 'already_retired';
  readonly identity: FileIdentity;
}
type Outcome = HostDirectoryRetirementResult['outcome'] | 'not_moved' | 'unknown';
interface NativeResult {
  ok: boolean; outcome: Outcome; durability: MetadataPublicationBarrier['durability']; directorySynced: boolean;
  code?: string; phase: string; osError?: number; cleanupErrors: string[];
}
interface NativeRetirement {
  directoryRetirementCapabilities(): { apiVersion: number; platform: string; noReplace: boolean };
  retireDirectoryNoReplace(parent: string, source: string, destination: string, expectedParent: FileIdentity, expectedSource: FileIdentity): NativeResult;
}
export class HostDirectoryRetirementError extends Error {
  constructor(readonly code: string, readonly outcome: Outcome = 'not_moved', readonly directorySynced = false, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
  }
}
const fail = (code: string): never => { throw new HostDirectoryRetirementError(code); };
const require = createRequire(import.meta.url);
let addon: NativeRetirement | undefined;
function native(): NativeRetirement {
  if (addon) return addon;
  try {
    // The already registered engine owns this binary. Neither model input nor environment variables select native code.
    const loaded = require(fileURLToPath(new URL('../../native/windows-files/secumon_windows_files.node', import.meta.url))) as NativeRetirement;
    const capability = loaded.directoryRetirementCapabilities();
    const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform;
    if (capability.apiVersion !== 1 || capability.platform !== platform || !capability.noReplace || typeof loaded.retireDirectoryNoReplace !== 'function')
      return fail('host_directory_retirement_native_contract_invalid');
    return addon = loaded;
  } catch (cause) { throw new HostDirectoryRetirementError('host_directory_retirement_native_required', 'not_moved', false, cause); }
}
/** Read-only preflight before the caller publishes an operation gate or releases its original-root references. */
export function assertHostDirectoryRetirementAvailable(): void { native(); }
const samePath = (left: string, right: string) => process.platform === 'win32' ? left.toUpperCase() === right.toUpperCase() : left === right;
class Context {
  readonly source: string;
  readonly destination: string;
  readonly parent: string;
  readonly expected: FileIdentity;
  readonly forbidden: readonly string[];
  readonly files: HostMetadataFiles;
  readonly reference: MetadataDirectory;
  constructor(input: HostDirectoryRetirementInput) {
    if (!input || typeof input.source !== 'string' || typeof input.destination !== 'string' || !Array.isArray(input.forbiddenRoots) ||
      input.forbiddenRoots.length > 128 || !input.expectedIdentity ||
      ![input.expectedIdentity.volume, input.expectedIdentity.object].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256))
      fail('host_directory_retirement_invalid_request');
    this.expected = Object.freeze({ volume: input.expectedIdentity.volume, object: input.expectedIdentity.object });
    this.source = lifecycleRoot(input.source, false); this.destination = lifecycleRoot(input.destination, false);
    this.parent = dirname(this.source);
    if (samePath(this.source, this.destination) || !samePath(this.parent, dirname(this.destination)))
      fail('host_directory_retirement_sibling_required');
    this.forbidden = Object.freeze([...input.forbiddenRoots]);
    this.boundaries();
    this.files = hostMetadataFiles();
    const parent = this.files.inspectDirectory(this.parent, 'owner-writable');
    if (!parent) throw new HostDirectoryRetirementError('host_directory_retirement_parent_missing');
    this.reference = parent;
  }
  boundaries() {
    for (const path of [this.source, this.destination]) {
      // Existing scopes canonicalize forbidden roots, including existing aliases; close before any rename.
      const scope = openProfileMutationScope(path, this.forbidden);
      try {
        scope.check();
        for (const forbidden of this.forbidden) disjoint(path, lifecycleRoot(forbidden, false));
      } finally { scope.close(); }
    }
  }
  check() {
    this.boundaries();
    if (!this.files.inspectDirectory(this.parent, 'owner-writable', this.reference)) fail('host_directory_retirement_parent_changed');
  }
  identity(path: string): FileIdentity | null {
    const directory = this.files.inspectDirectory(path, 'owner-writable');
    if (!directory) return null;
    try { return Object.freeze({ ...directory.identity }); }
    finally { releaseMetadataDirectory(this.files, directory); }
  }
  inspect(): HostDirectoryRetirementInspection {
    this.check();
    const sourceIdentity = this.identity(this.source), destinationIdentity = this.identity(this.destination);
    this.check();
    const sourceMatches = sourceIdentity !== null && sameFileIdentity(sourceIdentity, this.expected);
    const destinationMatches = destinationIdentity !== null && sameFileIdentity(destinationIdentity, this.expected);
    if (sourceMatches && destinationMatches) fail('host_directory_retirement_identity_ambiguous');
    if (destinationIdentity && !destinationMatches) fail('host_directory_retirement_destination_exists');
    if (!destinationMatches && !sourceMatches) fail('host_directory_retirement_source_changed');
    return Object.freeze({ sourceIdentity, destinationIdentity, retired: destinationMatches });
  }
  close() { releaseMetadataDirectory(this.files, this.reference); }
}
function usingContext<T>(input: HostDirectoryRetirementInput, operation: (context: Context) => T): T {
  const context = new Context(input); let primary: { error: unknown } | undefined, completed: T | undefined;
  try { completed = operation(context); return completed; }
  catch (error) { primary = { error }; throw error; }
  finally {
    try { context.close(); } catch (error) {
      if (primary) throw new AggregateError([primary.error, error], 'host_directory_retirement_cleanup_failed', { cause: primary.error });
      const moved = completed as HostDirectoryRetirementResult | undefined;
      if (moved?.outcome) throw new HostDirectoryRetirementError('host_directory_retirement_close_failed', moved.outcome, moved.directorySynced, error);
      throw error;
    }
  }
}

/** Read-only classification; a new source object after retirement is never mistaken for the preserved object. */
export function inspectHostDirectoryRetirement(input: HostDirectoryRetirementInput): HostDirectoryRetirementInspection {
  return usingContext(input, context => context.inspect());
}

/** Caller closes root/descendant references first and holds its independent recovery gate throughout this operation. */
export function retireHostDirectory(input: HostDirectoryRetirementInput): HostDirectoryRetirementResult {
  return usingContext(input, context => {
    context.inspect();
    const result = native().retireDirectoryNoReplace(context.parent, basename(context.source), basename(context.destination), context.reference.identity, context.expected);
    if (!result || typeof result.ok !== 'boolean' || !['moved', 'already_retired', 'not_moved', 'unknown'].includes(result.outcome) ||
      !['namespace-fsync', 'process-crash'].includes(result.durability) || typeof result.directorySynced !== 'boolean' ||
      !Array.isArray(result.cleanupErrors)) throw new HostDirectoryRetirementError('host_directory_retirement_native_result_invalid', 'unknown');
    if (!result.ok) throw new HostDirectoryRetirementError(`host_directory_retirement_${result.code ?? 'failed'}`, result.outcome, result.directorySynced, result);
    if (!['moved', 'already_retired'].includes(result.outcome) || result.cleanupErrors.length ||
      process.platform === 'win32' && (result.durability !== 'process-crash' || result.directorySynced) ||
      process.platform !== 'win32' && (result.durability !== 'namespace-fsync' || !result.directorySynced))
      throw new HostDirectoryRetirementError('host_directory_retirement_native_result_invalid', result.outcome, result.directorySynced, result);
    try {
      const observed = context.inspect();
      if (!observed.retired) throw new Error('retired object is not at its destination');
      return Object.freeze({ ...observed, identity: context.expected, outcome: result.outcome as HostDirectoryRetirementResult['outcome'],
        durability: result.durability, directorySynced: result.directorySynced });
    } catch (cause) { throw new HostDirectoryRetirementError('host_directory_retirement_postcheck_failed', result.outcome, result.directorySynced, cause); }
  });
}
