import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { AgentHostDirectoryIdentitySchema } from '../application/agent-host-identity-contracts.js';
import { AgentConfigSchema, AgentSetupOperationSchema } from '../application/agent-profile-contracts.js';
import { frozen } from '../application/resource-contracts.js';
import { assertAgentSetupCompatibility, inspectEngineRelease, readAgentEnginePin, readAgentSetupSchemaVersion } from './agent-engine-release.js';
import { disjoint, lifecycleDigest, lifecycleFail, lifecycleRoot } from './agent-lifecycle-files.js';
import { openProfileMutationScope, profileDirectory, publishProfileJson, readProfileJson, syncProfileDirectory } from './agent-profile-files.js';
import { hostMetadataFiles, releaseMetadataDirectory, sameFileIdentity } from './host-metadata-files.js';
import { FileAgentProfileStore } from './file-agent-profile.js';
import type { HostFileMutationScope } from './host-file-mutations.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const RegistrationSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('secumon-engine-installation'),
  directory: z.string().min(1).max(4096), releaseDigest: digest, version: z.string().min(1).max(100),
  directoryIdentity: AgentHostDirectoryIdentitySchema,
});
export interface AgentEngineRegistryOptions { readonly registryDirectory?: string }
export interface AgentEngineSelection { readonly directory: string; readonly source: 'current' | 'registered'; readonly releaseDigest: string | null }
const comparable = (path: string) => process.platform === 'win32' ? path.toUpperCase() : path;
const registryPath = (options: AgentEngineRegistryOptions) => resolve(options.registryDirectory ?? join(homedir(), '.secumon', 'engines'));
const recordName = (directory: string, releaseDigest: string) => `${releaseDigest}-${lifecycleDigest(comparable(directory))}.json`;

/** Explicit host operation. A pin or a model/tool request cannot register executable code. */
export function registerAgentEngine(input: string, expectedDigest: string, options: AgentEngineRegistryOptions = {}) {
  if (!digest.safeParse(expectedDigest).success) return lifecycleFail('engine_release_digest_mismatch');
  const directory = lifecycleRoot(input), registryDirectory = registryPath(options); disjoint(directory, registryDirectory);
  const files = hostMetadataFiles(), reference = files.inspectDirectory(directory, 'owner-writable');
  if (!reference) return lifecycleFail('engine_installation_missing');
  try {
    const release = inspectEngineRelease(directory);
    if (release.digest !== expectedDigest) lifecycleFail('engine_release_digest_mismatch');
    if (!profileDirectory(dirname(registryDirectory), false, false)) {
      if (options.registryDirectory !== undefined) lifecycleFail('engine_registry_parent_missing');
      const parentScope = openProfileMutationScope(dirname(registryDirectory), [directory]);
      try { profileDirectory(dirname(registryDirectory), true, true, parentScope); syncProfileDirectory(dirname(registryDirectory), parentScope); parentScope.check(); }
      finally { parentScope.close(); }
    }
    const scope = openProfileMutationScope(registryDirectory, [directory]);
    try {
      profileDirectory(registryDirectory, true, true, scope);
      const registration = RegistrationSchema.parse({ schemaVersion: 1, kind: 'secumon-engine-installation', directory,
        releaseDigest: release.digest, version: release.version, directoryIdentity: reference.identity });
      const path = join(registryDirectory, recordName(directory, release.digest));
      if (!files.inspectDirectory(directory, 'owner-writable', reference)) lifecycleFail('engine_installation_missing');
      const prior = readProfileJson(path, RegistrationSchema, [1], 65536, scope);
      if (prior && lifecycleDigest(prior) !== lifecycleDigest(registration)) lifecycleFail('engine_installation_conflict');
      const published = prior ? false : publishProfileJson(path, registration, scope);
      const stored = readProfileJson(path, RegistrationSchema, [1], 65536, scope);
      if (!stored || lifecycleDigest(stored) !== lifecycleDigest(registration)) lifecycleFail('engine_installation_conflict');
      syncProfileDirectory(registryDirectory, scope); scope.check();
      if (!files.inspectDirectory(directory, 'owner-writable', reference)) lifecycleFail('engine_installation_missing');
      return frozen({ registryDirectory, registration: stored, published });
    } finally { scope.close(); }
  } finally { releaseMetadataDirectory(files, reference); }
}

/** Selects code only from the invoked engine or an immutable host registration, never from the pin alone. */
export function resolveAgentEngine(input: string, currentEngine: string, options: AgentEngineRegistryOptions = {}): AgentEngineSelection {
  const current = lifecycleRoot(currentEngine), profiles = new FileAgentProfileStore(current), profile = profiles.inspect(input);
  const operationPath = join(profile.root, '.secumon', 'setup-operation.json');
  const operation = profile.status === 'incomplete' && profile.recoverable && profile.recovery !== 'clone'
    ? readProfileJson(operationPath, AgentSetupOperationSchema, [1, 2, 3], 512 * 1024) : null;
  const initialOperation = operation?.schemaVersion === 3 ? operation : null;
  const publishedPin = readAgentEnginePin(profile.root), pin = publishedPin ?? initialOperation?.initialEngine.pin;
  if (!pin) {
    if (readAgentSetupSchemaVersion(profile.root) === 3) assertAgentSetupCompatibility(profile.root, inspectEngineRelease(current));
    return frozen({ directory: current, source: 'current', releaseDigest: null });
  }
  if (profile.status === 'ready' ? profile.identity.agentId !== pin.agentId
    : !initialOperation || profile.status !== 'incomplete' || profile.agentId !== initialOperation.identity.agentId ||
      initialOperation.identity.agentId !== pin.agentId) return lifecycleFail('engine_pin_owner_mismatch');
  const config = profile.status === 'ready' ? profile.config
    : readProfileJson(join(profile.root, 'config.json'), AgentConfigSchema, [1, 2]);
  const configVersion = config?.schemaVersion ?? (initialOperation?.personalMemory ? 2 : 1);
  let directory: string;
  try { directory = lifecycleRoot(pin.engineDirectory); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return lifecycleFail('engine_installation_missing'); throw error; }
  disjoint(directory, profile.root);
  const files = hostMetadataFiles(), reference = files.inspectDirectory(directory, 'owner-writable');
  if (!reference) return lifecycleFail('engine_installation_missing');
  let registryScope: HostFileMutationScope | undefined;
  let assertRegistration = () => {};
  try {
    const selectedCurrent = comparable(directory) === comparable(current);
    // An interrupted initial choice still requires the host registration, including when invoked from that engine.
    if (!selectedCurrent || initialOperation) {
      const registry = registryPath(options); disjoint(profile.root, registry); disjoint(directory, registry); disjoint(current, registry);
      if (!profileDirectory(registry, false, true)) return lifecycleFail('engine_installation_unregistered');
      const scope = registryScope = openProfileMutationScope(registry, [directory, current, profile.root]);
        profileDirectory(registry, false, true, scope);
        const path = join(registry, recordName(directory, pin.releaseDigest));
        const registration = readProfileJson(path, RegistrationSchema, [1], 65536, scope);
        if (!registration) return lifecycleFail('engine_installation_unregistered');
        if (comparable(registration.directory) !== comparable(directory) || registration.releaseDigest !== pin.releaseDigest ||
          registration.version !== pin.version || !sameFileIdentity(registration.directoryIdentity, reference.identity)) lifecycleFail('engine_installation_changed');
        if (!publishedPin && initialOperation && lifecycleDigest(registration) !== initialOperation.initialEngine.registrationDigest)
          lifecycleFail('engine_installation_changed');
        assertRegistration = () => {
          const latest = readProfileJson(path, RegistrationSchema, [1], 65536, scope);
          if (!latest || lifecycleDigest(latest) !== lifecycleDigest(registration)) lifecycleFail('engine_installation_changed');
          scope.check();
        };
        assertRegistration();
    }
    const release = inspectEngineRelease(directory);
    if (release.digest !== pin.releaseDigest || release.version !== pin.version) lifecycleFail('engine_release_digest_mismatch');
    if (!release.compatibility.config.includes(configVersion)) lifecycleFail('engine_config_incompatible');
    assertAgentSetupCompatibility(profile.root, release);
    const entry = release.entries.find(value => value.path === 'dist/presentation/agent-cli.js');
    if (entry?.kind !== 'file') lifecycleFail('engine_entrypoint_missing');
    if (initialOperation) {
      // inspect validates the original operation/identity/config/first-pin proof, not just the selected executable path.
      const latest = profiles.inspect(profile.root);
      if (comparable(latest.root) !== comparable(profile.root) || (latest.status === 'ready'
        ? lifecycleDigest(latest.identity) !== lifecycleDigest(initialOperation.identity)
        : latest.status !== 'incomplete' || !latest.recoverable || latest.recovery === 'clone' ||
          latest.agentId !== initialOperation.identity.agentId)) lifecycleFail('engine_pin_owner_mismatch');
      if (lifecycleDigest(readProfileJson(operationPath, AgentSetupOperationSchema, [1, 2, 3], 512 * 1024)) !== lifecycleDigest(initialOperation) ||
        lifecycleDigest(readProfileJson(join(profile.root, 'config.json'), AgentConfigSchema, [1, 2])) !== lifecycleDigest(config))
        lifecycleFail('engine_pin_conflict');
    }
    if (lifecycleDigest(readAgentEnginePin(profile.root)) !== lifecycleDigest(publishedPin)) lifecycleFail('engine_pin_conflict');
    assertRegistration();
    if (!files.inspectDirectory(directory, 'owner-writable', reference)) lifecycleFail('engine_installation_missing');
    return frozen({ directory, source: selectedCurrent ? 'current' : 'registered', releaseDigest: release.digest });
  } finally { try { registryScope?.close(); } finally { releaseMetadataDirectory(files, reference); } }
}
