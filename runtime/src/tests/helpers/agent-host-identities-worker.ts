import { existsSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FileAgentProfileStore } from '../../infrastructure/file-agent-profile.js';
import { claimAgentHostIdentity, type AgentHostIdentityHead } from '../../infrastructure/agent-host-identities.js';
import { hostFileMutations, type FilePublicationResult, type HostFileMutationScope } from '../../infrastructure/host-file-mutations.js';

const [engine, root, registry, control, index] = process.argv.slice(2);
if (!engine || !root || !registry || !control || !['0', '1'].includes(index ?? '')) throw new Error('identity_worker_arguments');
const enginePath = engine, rootPath = root, registryPath = registry, controlPath = control, workerIndex = index!;
const sleep = new Int32Array(new SharedArrayBuffer(4));
function marker(name: string, value: unknown): void {
  const pending = join(controlPath, `${name}.pending`), target = join(controlPath, name);
  writeFileSync(pending, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(pending, target);
}
function wait(name: string): void {
  const deadline = performance.now() + 10000;
  while (!existsSync(join(controlPath, name))) {
    if (performance.now() >= deadline) throw new Error(`identity_worker_barrier_timeout:${name}`);
    Atomics.wait(sleep, 0, 0, 10);
  }
}
function failure(error: unknown) {
  return error instanceof Error ? { name: error.name, message: error.message, code: (error as Error & { code?: string }).code ?? null } :
    { name: 'UnknownError', message: String(error), code: null };
}
const profile = new FileAgentProfileStore(enginePath).inspect(rootPath);
if (profile.status !== 'ready') throw new Error('identity_worker_profile_not_ready');
const mutations = hostFileMutations(), originalOpen = mutations.openScope;
let entered = 0, publication: FilePublicationResult | null = null, head: AgentHostIdentityHead | null = null, rejected: ReturnType<typeof failure> | null = null;
mutations.openScope = function (options): HostFileMutationScope {
  const scope = originalOpen.call(mutations, options);
  if (resolve(options.root) !== resolve(registryPath)) return scope;
  return {
    directory: scope.directory.bind(scope), check: scope.check.bind(scope), close: scope.close.bind(scope),
    publish(directory, leaf, bytes, settings) {
      if (leaf !== '00000001.json') return scope.publish(directory, leaf, bytes, settings);
      if (++entered !== 1) throw new Error('identity_worker_repeated_publication');
      // Both real claim calls have observed an empty history before either performs its no-replace publication.
      marker(`before-${workerIndex}.json`, { leaf, bytes: bytes.byteLength }); wait('publish.go');
      let result: FilePublicationResult | undefined, error: { value: unknown } | undefined;
      try { result = scope.publish(directory, leaf, bytes, settings); publication = result; }
      catch (value) { error = { value }; }
      // Let both real publishers clean their own pending file before either performs its final history read.
      marker(`after-${workerIndex}.json`, { publication: result ?? null, failure: error ? failure(error.value) : null });
      wait('inspect.go');
      if (error) throw error.value;
      if (!result) throw new Error('identity_worker_publication_missing'); return result;
    },
  };
};
try {
  const claim = claimAgentHostIdentity(profile, { registryDirectory: registryPath, engineDirectories: [enginePath] });
  try { claim.assertCurrent(); head = { record: claim.record, digest: claim.digest }; }
  finally { claim.close(); }
} catch (error) { rejected = failure(error); }
finally { mutations.openScope = originalOpen; }
writeSync(1, JSON.stringify({ root: rootPath, entered, publication, head, failure: rejected }) + '\n');
