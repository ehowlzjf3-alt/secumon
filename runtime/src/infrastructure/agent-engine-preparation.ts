import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { EngineRelease } from '../application/agent-lifecycle-contracts.js';
import { bundleAgentEngine, inspectAgentEngineBuild, inspectEngineRelease, installAgentEngine } from './agent-engine-release.js';
import { registerAgentEngine } from './agent-engine-registry.js';
import { createLifecycleDirectory, disjoint, lifecycleDigest, lifecycleExists, lifecycleFail, lifecycleNames, lifecycleRoot } from './agent-lifecycle-files.js';
import { openProfileMutationScope, profileDirectory, publishProfileJson, readProfileJson, syncProfileDirectory } from './agent-profile-files.js';
import type { HostFileMutationScope } from './host-file-mutations.js';
import { hostMetadataFiles, releaseMetadataDirectory, sameFileIdentity } from './host-metadata-files.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const SelectionSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('prepared-agent-engine'),
  releaseDigest: digest, attemptId: z.uuid(), registrationDigest: digest });
type Selection = z.infer<typeof SelectionSchema>;
export interface AgentEnginePreparationOptions { readonly preparationDirectory?: string; readonly registryDirectory?: string }
export interface PreparedAgentEngine {
  readonly directory: string; readonly releaseDigest: string; readonly source: 'prepared' | 'reused'; readonly preparationDirectory: string;
}
const maximumAttempts = 64;
const isPending = (name: string) => /^\.secumon-init-[a-f0-9-]+\.pending$/.test(name);

/** Builds from local files only. A cached pointer never replaces verification of the installation and host registration. */
export function prepareAgentEngine(input: string, agentRoot: string, options: AgentEnginePreparationOptions = {}): PreparedAgentEngine {
  const source = lifecycleRoot(input), agent = lifecycleRoot(agentRoot, false);
  if (lifecycleExists(join(source, 'release.json'))) lifecycleFail('engine_preparation_not_required');
  const requested = resolve(options.preparationDirectory ?? join(homedir(), '.secumon', 'engine-releases'));
  const registry = resolve(options.registryDirectory ?? join(homedir(), '.secumon', 'engines'));
  disjoint(source, agent); disjoint(requested, source); disjoint(requested, agent); disjoint(requested, registry);
  disjoint(registry, source); disjoint(registry, agent);
  // Capture and validate before creating a preparation directory or a new agent identity.
  const expected = inspectAgentEngineBuild(source);
  if (!profileDirectory(dirname(requested), false, false)) {
    if (options.preparationDirectory !== undefined) lifecycleFail('engine_preparation_parent_missing');
    const parentScope = openProfileMutationScope(dirname(requested), [source, agent]);
    try { profileDirectory(dirname(requested), true, true, parentScope); syncProfileDirectory(dirname(requested), parentScope); parentScope.check(); }
    finally { parentScope.close(); }
  }
  const store = lifecycleRoot(requested, false);
  disjoint(store, source); disjoint(store, agent); disjoint(store, registry);
  const scope = openProfileMutationScope(store, [source, agent, registry]);
  try {
    profileDirectory(store, true, true, scope);
    const folder = join(store, expected.digest);
    profileDirectory(folder, true, true, scope); syncProfileDirectory(store, scope);
    const selectedPath = join(folder, 'selected.json');
    const readSelection = () => readProfileJson(selectedPath, SelectionSchema, [1], 65536, scope);
    const register = (directory: string) => registerAgentEngine(directory, expected.digest,
      options.registryDirectory === undefined ? {} : { registryDirectory: registry });
    const assertSource = () => {
      if (lifecycleExists(join(source, 'release.json')) || inspectAgentEngineBuild(source).digest !== expected.digest)
        lifecycleFail('lifecycle_source_changed');
    };
    const verify = (selection: Selection) => {
      if (selection.releaseDigest !== expected.digest) lifecycleFail('engine_preparation_invalid');
      const directory = join(folder, selection.attemptId, 'engine');
      if (!lifecycleExists(directory)) lifecycleFail('engine_preparation_installation_missing');
      const release = inspectEngineRelease(directory);
      if (release.digest !== expected.digest) lifecycleFail('engine_release_digest_mismatch');
      const registered = register(directory);
      if (lifecycleDigest(registered.registration) !== selection.registrationDigest) lifecycleFail('engine_preparation_invalid');
      return directory;
    };
    const finish = (selection: Selection, disposition: 'prepared' | 'reused'): PreparedAgentEngine => {
      // Finish the potentially long source scan before the last selected-installation/registration checks.
      assertSource(); const directory = verify(selection);
      if (lifecycleDigest(readSelection()) !== lifecycleDigest(selection)) lifecycleFail('engine_preparation_conflict');
      scope.check(); return Object.freeze({ directory, releaseDigest: expected.digest, source: disposition, preparationDirectory: store });
    };
    const prior = readSelection(); if (prior) return finish(prior, 'reused');
    const publish = (attemptId: string, disposition: 'prepared' | 'reused') => {
      const directory = join(folder, attemptId, 'engine');
      const release = inspectEngineRelease(directory);
      if (release.digest !== expected.digest) lifecycleFail('engine_release_digest_mismatch');
      const registered = register(directory); assertSource();
      const proposal = SelectionSchema.parse({ schemaVersion: 1, kind: 'prepared-agent-engine', releaseDigest: expected.digest,
        attemptId, registrationDigest: lifecycleDigest(registered.registration) });
      if (!readSelection()) publishProfileJson(selectedPath, proposal, scope);
      syncProfileDirectory(folder, scope);
      const selected = readSelection(); if (!selected) return lifecycleFail('engine_preparation_incomplete');
      return finish(selected, selected.attemptId === attemptId ? disposition : 'reused');
    };
    const attempts = readAttempts(folder, scope);
    for (const attemptId of attempts) {
      const directory = join(folder, attemptId, 'engine');
      if (lifecycleExists(join(directory, 'release.json')) && !unfinishedManifestPublication(directory, expected)) return publish(attemptId, 'reused');
      // An absent final manifest proves no completed installation. Preserve that candidate and use a fresh destination.
    }
    if (attempts.length >= maximumAttempts) lifecycleFail('engine_preparation_limit');
    const attemptId = randomUUID(), attempt = join(folder, attemptId);
    createLifecycleDirectory(attempt); scope.check();
    const bundled = bundleAgentEngine(source, join(attempt, 'bundle'));
    if (bundled.release.digest !== expected.digest) lifecycleFail('lifecycle_source_changed');
    const winner = readSelection(); if (winner) return finish(winner, 'reused');
    installAgentEngine(bundled.directory, join(attempt, 'engine'), expected.digest);
    return publish(attemptId, 'prepared');
  } finally { scope.close(); }
}

/** Preserve an exact manifest's unfinished hardlink publication, but never execute that candidate. */
function unfinishedManifestPublication(directory: string, expected: EngineRelease): boolean {
  const pending = lifecycleNames(directory).filter(isPending); if (!pending.length) return false;
  const files = hostMetadataFiles(), reference = files.inspectDirectory(directory, 'owner-writable');
  if (!reference) return lifecycleFail('engine_preparation_installation_missing');
  try {
    let linked = false;
    const bytes = files.readStableRegularFile(reference, 'release.json', { maximum: 32 * 1024 * 1024, access: 'private',
      allowLinkedFile: (file, siblings) => {
        linked = file.links === 2n && pending.some(name => {
          const candidate = siblings.inspect(name);
          return candidate?.kind === 'regular' && candidate.links === 2n && sameFileIdentity(candidate.identity, file.identity);
        });
        return linked;
      } });
    if (!files.inspectDirectory(directory, 'owner-writable', reference)) return lifecycleFail('engine_preparation_installation_missing');
    return linked && bytes.equals(Buffer.from(JSON.stringify(expected, null, 2) + '\n'));
  } finally { releaseMetadataDirectory(files, reference); }
}

function readAttempts(folder: string, scope: HostFileMutationScope): string[] {
  const names = lifecycleNames(folder, maximumAttempts * 2 + 2);
  if (names.length > maximumAttempts * 2 + 1) return lifecycleFail('engine_preparation_limit');
  const attempts: string[] = [];
  for (const name of names.sort()) {
    if (name === 'selected.json' || isPending(name)) continue;
    if (!z.uuid().safeParse(name).success) return lifecycleFail('engine_preparation_invalid');
    if (!profileDirectory(join(folder, name), false, true, scope)) return lifecycleFail('engine_preparation_invalid');
    attempts.push(name);
  }
  if (attempts.length > maximumAttempts) lifecycleFail('engine_preparation_limit');
  return attempts;
}
