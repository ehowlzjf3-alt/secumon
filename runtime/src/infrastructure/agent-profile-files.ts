import { lstatSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { z } from 'zod';
import { AgentProfileError } from '../application/agent-profile-contracts.js';
import { FileBoundaryFault, hostMetadataFiles, sameFileIdentity, completeMetadataPublication, releaseMetadataDirectory } from './host-metadata-files.js';
import { FileMutationFault, hostFileMutations, type HostFileMutationScope } from './host-file-mutations.js';

export const profileErrorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
export const failProfile = (reason: string): never => { throw new AgentProfileError(reason); };
export function profileStat(path: string) {
  try { return lstatSync(path); } catch (error) { if (profileErrorCode(error) === 'ENOENT') return null; throw error; }
}
function profileBoundaryFailure(error: unknown, reason: 'agent_directory_unsafe' | 'agent_metadata_unsafe'): never {
  if (error instanceof FileMutationFault) {
    if (error.operation === 'publish' && error.status.publication !== 'not_published') {
      throw new AgentProfileError('agent_metadata_publish_unknown', { cause: error });
    }
    if (error.operation === 'directory' && error.status.created) {
      throw new AgentProfileError('agent_directory_create_unknown', { cause: error });
    }
    if (error.errors.length === 1) return profileBoundaryFailure(error.cause, reason);
    throw error;
  }
  if (!(error instanceof FileBoundaryFault)) throw error;
  if (error.code === 'unsupported_platform') return failProfile('agent_platform_unsupported');
  if (error.code === 'missing' && error.operation === 'read' && error.cause !== undefined) throw error.cause;
  if (error.code === 'io') {
    // Read-open failures have always been metadata refusals; later filesystem failures retain their original cause.
    if (reason === 'agent_metadata_unsafe' && error.operation === 'open') return failProfile(reason);
    if (error.cause !== undefined) throw error.cause;
    throw error;
  }
  throw new AgentProfileError(reason, { cause: error });
}
export function openProfileMutationScope(root: string, forbiddenRoots: readonly string[]): HostFileMutationScope {
  try { return hostFileMutations().openScope({ root, forbiddenRoots }); }
  catch (error) { return profileBoundaryFailure(error, 'agent_directory_unsafe'); }
}
export function checkProfileMutationScope(scope: HostFileMutationScope) {
  try { scope.check(); } catch (error) { return profileBoundaryFailure(error, 'agent_directory_unsafe'); }
}
export function syncProfileDirectory(path: string, scope?: HostFileMutationScope) {
  try {
    const files = hostMetadataFiles(); scope?.check();
    const directory = scope ? scope.directory(path, 'owner-writable') : files.inspectDirectory(path, 'sync');
    if (!directory) throw Object.assign(new Error('directory does not exist'), { code: 'ENOENT', syscall: 'open', path });
    try { const barrier = completeMetadataPublication(files, directory); scope?.check(); return barrier; }
    finally { if (!scope) releaseMetadataDirectory(files, directory); }
  } catch (error) { return profileBoundaryFailure(error, 'agent_directory_unsafe'); }
}
export function profileDirectory(path: string, create: boolean, privateMode = true, scope?: HostFileMutationScope, exclusive = false) {
  try {
    const files = hostMetadataFiles();
    if (scope) return scope.directory(path, privateMode ? 'private' : 'owner-writable', create, exclusive) !== null;
    if (create) return failProfile('agent_mutation_scope_required');
    const ref = files.inspectDirectory(path, privateMode ? 'private' : 'owner-writable');
    if (!ref) return false;
    releaseMetadataDirectory(files, ref); return true;
  }
  catch (error) { return profileBoundaryFailure(error, 'agent_directory_unsafe'); }
}
export function readProfileBytes(path: string, maximum: number, privateMode = true, scope?: HostFileMutationScope): Buffer | null {
  try {
    scope?.check();
    if (process.platform !== 'win32' && !profileStat(path)) { scope?.check(); return null; }
    const files = hostMetadataFiles();
    const directory = scope ? scope.directory(dirname(path), 'owner-writable') : files.inspectDirectory(dirname(path), 'traverse');
    if (!directory) return process.platform === 'win32' ? null : failProfile('agent_metadata_unsafe');
    try {
    const bytes = files.readStableRegularFile(directory, basename(path), {
      maximum, access: privateMode ? 'private' : 'owner-writable',
      allowLinkedFile: (file, siblings) => {
        if (file.links !== 2n) return false;
        for (const name of siblings.names()) {
          if (!/^\.secumon-init-[a-f0-9-]+\.pending$/.test(name)) continue;
          const candidate = siblings.inspect(name);
          if (candidate?.kind === 'regular' && sameFileIdentity(candidate.identity, file.identity)) return true;
        }
        return false;
      },
    });
    scope?.check(); return bytes;
    } catch (error) {
      if (process.platform === 'win32' && error instanceof FileBoundaryFault && error.code === 'missing') { scope?.check(); return null; }
      throw error;
    } finally { if (!scope) releaseMetadataDirectory(files, directory); }
  } catch (error) { return profileBoundaryFailure(error, 'agent_metadata_unsafe'); }
}
export function readProfileJson<T>(path: string, schema: z.ZodType<T>, versions = [1], maximum = 65536, scope?: HostFileMutationScope): T | null {
  const bytes = readProfileBytes(path, maximum, true, scope); if (!bytes) return null;
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return failProfile('agent_metadata_invalid'); }
  if (value && typeof value === 'object' && 'schemaVersion' in value && !versions.includes(value.schemaVersion as number)) failProfile('agent_schema_unsupported');
  const parsed = schema.safeParse(value); if (!parsed.success) return failProfile('agent_metadata_invalid');
  return parsed.data;
}
export function publishProfileBytes(path: string, bytes: Uint8Array, executable = false, scope?: HostFileMutationScope): boolean {
  try {
    hostMetadataFiles();
    if (!scope) return failProfile('agent_mutation_scope_required');
    const parent = scope.directory(dirname(path), 'owner-writable');
    if (!parent) return failProfile('agent_directory_unsafe');
    return scope.publish(parent, basename(path), bytes, { executable }).published;
  } catch (error) { return profileBoundaryFailure(error, 'agent_metadata_unsafe'); }
}
export function publishProfileJson(path: string, value: unknown, scope?: HostFileMutationScope) {
  return publishProfileBytes(path, Buffer.from(JSON.stringify(value, null, 2) + '\n'), false, scope);
}
