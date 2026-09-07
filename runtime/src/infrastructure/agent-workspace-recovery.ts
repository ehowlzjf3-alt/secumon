import { join } from 'node:path';
import { z } from 'zod';
import type { WorkspaceFile } from '../domain/workspace.js';
import { WorkspaceCheckpoints, WorkspaceError, type WorkspaceCheckpointServices, type WorkspaceStore } from '../application/workspace-checkpoints.js';
import { WorkspaceRecoveryManifestSchema, WorkspaceRecoveryRequestSchema, type WorkspaceRecoveryManifest } from '../application/workspace-recovery-contracts.js';
import type { WorkActor } from '../application/work-resources.js';
import { asJson } from '../application/plan-validator.js';
import { FileWorkspaceStore } from './file-workspaces.js';
import { createLifecycleDirectory, lifecycleExists, lifecycleRoot } from './agent-lifecycle-files.js';
import { publishLifecycleManifest } from './agent-engine-release.js';
import { readProfileJson } from './agent-profile-files.js';
import { sha256 } from './digest.js';

export type { WorkspaceRecoveryManifest } from '../application/workspace-recovery-contracts.js';
export interface WorkspaceRecoveryHost {
  agentId: string;
  services: WorkspaceCheckpointServices;
  actor: WorkActor;
  assertCurrent: () => void | Promise<void>;
}
const manifestName = 'recovery.json';
const manifestMaximum = 4 * 1024 * 1024;
const limits = Object.freeze({ maxFileBytes: 1048576, maxFilesPerAttempt: 128, maxAttemptBytes: 16777216 });
const fail: (code: string) => never = code => { throw new WorkspaceError(code); };
const fileKey = (file: Pick<WorkspaceFile, 'attemptId' | 'path'>) => JSON.stringify([file.attemptId, file.path]);
function capture(host: WorkspaceRecoveryHost) {
  return { agentId: z.uuid().parse(host.agentId), services: host.services, actor: structuredClone(host.actor), assertCurrent: host.assertCurrent.bind(host) };
}
function hash(host: WorkspaceRecoveryHost, value: unknown) { return host.services.digester.digest(asJson(value)); }
function same(host: WorkspaceRecoveryHost, a: unknown, b: unknown) { return hash(host, a) === hash(host, b); }
function filesOf(host: WorkspaceRecoveryHost, manifest: WorkspaceRecoveryManifest): WorkspaceFile[] {
  const files = new Map<string, WorkspaceFile>(); let total = 0;
  if (manifest.agentId !== host.agentId || !same(host, manifest.checkpointIds, [...new Set(manifest.checkpointIds)].sort()) ||
    !same(host, manifest.checkpointIds, manifest.restored.map(item => item.checkpoint.id))) fail('workspace_recovery_manifest_invalid');
  for (const item of manifest.restored) {
    const { checkpoint, file } = item;
    const expected = { workId: manifest.workId, attemptId: checkpoint.attemptId, path: checkpoint.path,
      tenantId: checkpoint.artifact.tenantId, labels: [...checkpoint.artifact.labels].sort(), lifecycleGeneration: checkpoint.lifecycleGeneration,
      sha256: checkpoint.artifact.sha256, byteLength: checkpoint.artifact.byteLength };
    if (checkpoint.workId !== manifest.workId || !same(host, expected, file)) fail('workspace_recovery_manifest_invalid');
    const key = fileKey(file), before = files.get(key);
    if (before && !same(host, before, file)) fail('workspace_file_conflict');
    if (!before) { files.set(key, file); total += file.byteLength; }
    if (file.byteLength > limits.maxFileBytes || total > limits.maxAttemptBytes || files.size > limits.maxFilesPerAttempt) fail('workspace_capacity_exceeded');
  }
  return [...files.values()];
}
function assertDirectories(directory: string, files: readonly WorkspaceFile[]) {
  for (const file of files) {
    const work = join(directory, sha256(file.workId)), attempt = join(work, sha256(file.attemptId));
    lifecycleRoot(work); lifecycleRoot(attempt); lifecycleRoot(join(attempt, 'files'));
  }
}
async function verifyFiles(host: WorkspaceRecoveryHost, directory: string, disk: FileWorkspaceStore, manifest: WorkspaceRecoveryManifest,
  selectedIds: readonly string[] = manifest.checkpointIds) {
  await host.assertCurrent(); const expected = filesOf(host, manifest); assertDirectories(directory, expected);
  const verification: WorkspaceStore = {
    async stage(workId, attemptId, path, bytes, attributes) {
      await host.assertCurrent();
      const saved = expected.find(file => file.workId === workId && file.attemptId === attemptId && file.path === path);
      if (!saved || !same(host, attributes, { tenantId: saved.tenantId, labels: saved.labels, lifecycleGeneration: saved.lifecycleGeneration })) fail('workspace_recovery_scope_denied');
      const actual = await disk.read(workId, attemptId, path);
      if (!same(host, actual.file, saved) || !Buffer.from(actual.bytes).equals(Buffer.from(bytes))) fail('workspace_file_integrity_failure');
      await host.assertCurrent(); return actual.file;
    },
    async read() { return fail('workspace_recovery_scope_denied'); },
    async list() { return fail('workspace_recovery_scope_denied'); },
    async removeAttempt() { return fail('workspace_recovery_read_only'); },
  };
  const checkpoints = new WorkspaceCheckpoints(host.services, verification);
  const actual = await checkpoints.restoreInto(manifest.workId, host.actor, selectedIds, verification);
  const selected = new Set(selectedIds);
  if (!same(host, actual, manifest.restored.filter(item => selected.has(item.checkpoint.id)))) fail('workspace_recovery_checkpoint_changed');
  for (const attemptId of new Set(actual.map(item => item.file.attemptId))) {
    const listed = await disk.list(manifest.workId, attemptId);
    const wanted = expected.filter(file => file.attemptId === attemptId).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (!same(host, listed, wanted)) fail('workspace_manifest_changed');
  }
  await host.assertCurrent();
}

/** The host owns source identity/lifetime. This function never opens the original workspace or removes a failed destination. */
export async function recoverAgentWorkspace(inputHost: WorkspaceRecoveryHost, input: {
  operationId: string; workId: string; checkpointIds: readonly string[]; destination: string;
}): Promise<{ directory: string; manifest: WorkspaceRecoveryManifest }> {
  const host = capture(inputHost), request = WorkspaceRecoveryRequestSchema.parse({ ...input, checkpointIds: [...input.checkpointIds] });
  await host.assertCurrent(); const directory = lifecycleRoot(request.destination, false);
  if (lifecycleExists(directory)) return fail('workspace_recovery_destination_exists');
  createLifecycleDirectory(directory); let disk: FileWorkspaceStore | undefined, primary: { error: unknown } | undefined;
  try {
    disk = new FileWorkspaceStore(directory, limits); const target = disk;
    const guarded: WorkspaceStore = {
      async stage(...args) { await host.assertCurrent(); const file = await target.stage(...args); await host.assertCurrent(); return file; },
      async read() { return fail('workspace_recovery_scope_denied'); },
      async list() { return fail('workspace_recovery_scope_denied'); },
      async removeAttempt() { return fail('workspace_recovery_read_only'); },
    };
    const restored = await new WorkspaceCheckpoints(host.services, guarded).restoreInto(request.workId, host.actor, request.checkpointIds, guarded);
    const body = { schemaVersion: 1 as const, kind: 'secumon-workspace-recovery' as const, operationId: request.operationId,
      agentId: host.agentId, workId: request.workId, checkpointIds: [...new Set(request.checkpointIds)].sort(),
      createdAt: host.services.clock.now(), restored };
    const manifest = WorkspaceRecoveryManifestSchema.parse({ ...body, digest: hash(host, body) });
    if (Buffer.byteLength(JSON.stringify(manifest, null, 2) + '\n') > manifestMaximum) fail('workspace_capacity_exceeded');
    await verifyFiles(host, directory, target, manifest);
    await target.close(); disk = undefined; await host.assertCurrent();
    publishLifecycleManifest(directory, manifestName, manifest); await host.assertCurrent();
    return { directory, manifest: structuredClone(manifest) };
  } catch (error) { primary = { error }; throw error; }
  finally {
    if (disk) try { await disk.close(); } catch (error) {
      if (primary) throw new AggregateError([primary.error, error], 'workspace_recovery_close_failed');
      throw error;
    }
  }
}

/** Opens only committed recovery output. Existing WorkspaceCheckpoints can read or identically restore these selected originals. */
export async function openRecoveredAgentWorkspace(inputHost: WorkspaceRecoveryHost, input: { directory: string; expectedDigest: string }): Promise<{
  workspace: WorkspaceStore; manifest: WorkspaceRecoveryManifest; close(): Promise<void>;
}> {
  const host = capture(inputHost); await host.assertCurrent();
  const directory = lifecycleRoot(input.directory), expectedDigest = z.string().regex(/^[a-f0-9]{64}$/).parse(input.expectedDigest);
  const loaded = readProfileJson(join(directory, manifestName), WorkspaceRecoveryManifestSchema, [1], manifestMaximum);
  if (!loaded) return fail('workspace_recovery_incomplete');
  const manifest: WorkspaceRecoveryManifest = loaded;
  const { digest, ...body } = manifest;
  if (digest !== expectedDigest || digest !== hash(host, body)) fail('workspace_recovery_digest_mismatch');
  const expected = filesOf(host, manifest); assertDirectories(directory, expected);
  const disk = new FileWorkspaceStore(directory, limits);
  try { await verifyFiles(host, directory, disk, manifest); }
  catch (error) { try { await disk.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'workspace_recovery_close_failed'); } throw error; }
  let closing = false, closePromise: Promise<void> | undefined; const active = new Set<Promise<unknown>>();
  function run<T>(action: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new WorkspaceError('workspace_store_closed'));
    const promise = action(); active.add(promise);
    void promise.then(() => active.delete(promise), () => active.delete(promise)); return promise;
  }
  const selected = (workId: string, attemptId: string, path?: string) => {
    const files = expected.filter(file => file.workId === workId && file.attemptId === attemptId && (path === undefined || file.path === path));
    if (!files.length) return fail('workspace_recovery_scope_denied');
    return files;
  };
  async function verify(selectedFiles: WorkspaceFile[]) {
    const keys = new Set(selectedFiles.map(fileKey));
    await verifyFiles(host, directory, disk, manifest, manifest.restored.filter(item => keys.has(fileKey(item.file))).map(item => item.checkpoint.id));
  }
  const workspace: WorkspaceStore = {
    stage(workId, attemptId, path, bytes, attributes) {
      if (bytes.byteLength > limits.maxFileBytes) return Promise.reject(new WorkspaceError('workspace_file_too_large'));
      const content = Buffer.from(bytes), properties = structuredClone(attributes); return run(async () => {
      const files = selected(workId, attemptId, path); await verify(files);
      const actual = await disk.read(workId, attemptId, path), file = files[0]!;
      if (!same(host, actual.file, file) || !content.equals(Buffer.from(actual.bytes)) ||
        !same(host, properties, { tenantId: file.tenantId, labels: file.labels, lifecycleGeneration: file.lifecycleGeneration })) fail('workspace_recovery_read_only');
      await verify(files); await host.assertCurrent(); return structuredClone(file);
    }); },
    read(workId, attemptId, path) { return run(async () => {
      const files = selected(workId, attemptId, path); await verify(files); const actual = await disk.read(workId, attemptId, path);
      if (!same(host, actual.file, files[0])) fail('workspace_file_integrity_failure'); await verify(files); await host.assertCurrent(); return actual;
    }); },
    list(workId, attemptId) { return run(async () => {
      const files = selected(workId, attemptId); await verify(files); await host.assertCurrent();
      return structuredClone(files).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    }); },
    removeAttempt() { return Promise.reject(new WorkspaceError('workspace_recovery_read_only')); },
  };
  return { workspace: Object.freeze(workspace), manifest: structuredClone(manifest), close() {
    if (!closePromise) {
      closing = true; closePromise = (async () => {
        const settled = await Promise.allSettled([...active]), errors: unknown[] = [];
        for (const result of settled) if (result.status === 'rejected') errors.push(result.reason);
        try { await disk.close(); } catch (error) { errors.push(error); }
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, 'workspace_recovery_close_failed');
      })();
    }
    return closePromise;
  } };
}
