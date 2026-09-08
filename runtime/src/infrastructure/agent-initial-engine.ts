import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentInitialEngineSchema, type AgentInitialEngine, type AgentInitialSetupReceipt, type AgentSetupOperation, type AgentIdentity } from '../application/agent-profile-contracts.js';
import type { EngineRelease } from '../application/agent-lifecycle-contracts.js';
import { disjoint, lifecycleDigest, lifecycleExists, lifecycleRoot } from './agent-lifecycle-files.js';
import { inspectEngineRelease, readAgentEnginePin } from './agent-engine-release.js';
import { registerAgentEngine } from './agent-engine-registry.js';
import { failProfile, readProfileBytes, publishProfileJson, profileDirectory, syncProfileDirectory } from './agent-profile-files.js';
import type { HostFileMutationScope } from './host-file-mutations.js';
import { initialEnginePinBytes } from './agent-initial-pin-files.js';

export interface InitialAgentEngineOptions { readonly engineRegistryDirectory?: string }
interface InitialEngineCapture { directory: string; release: EngineRelease; registrationDigest: string }
const comparable = (path: string) => process.platform === 'win32' ? path.toUpperCase() : path;

/** Only the invoked, verified installation can supply the initial pin. Development materialization is separate. */
export function captureInitialAgentEngine(engine: string, root: string, options: InitialAgentEngineOptions): InitialEngineCapture | null {
  if (!lifecycleExists(join(engine, 'release.json'))) return null;
  const directory = lifecycleRoot(engine);
  const registryDirectory = resolve(options.engineRegistryDirectory ?? join(homedir(), '.secumon', 'engines'));
  disjoint(directory, root); disjoint(registryDirectory, root);
  // Registration verifies every release file. The first read only obtains the manifest-bound digest.
  const release = inspectEngineRelease(directory, false);
  if (!release.compatibility.setup?.includes(3)) return failProfile('engine_setup_incompatible');
  const registered = registerAgentEngine(directory, release.digest,
    options.engineRegistryDirectory === undefined ? {} : { registryDirectory });
  return { directory, release, registrationDigest: lifecycleDigest(registered.registration) };
}

export function initialAgentEngine(capture: InitialEngineCapture, identity: AgentIdentity): AgentInitialEngine {
  return AgentInitialEngineSchema.parse({ pin: { schemaVersion: 1, sequence: 1, agentId: identity.agentId,
    releaseDigest: capture.release.digest, engineDirectory: capture.directory, version: capture.release.version,
    previous: null, backupDigest: null, createdAt: Date.now() }, registrationDigest: capture.registrationDigest });
}

export function assertInitialAgentEngine(engine: string, root: string, initial: AgentInitialEngine, options: InitialAgentEngineOptions) {
  if (comparable(lifecycleRoot(engine)) !== comparable(initial.pin.engineDirectory)) return failProfile('agent_initial_engine_mismatch');
  const current = captureInitialAgentEngine(engine, root, options);
  if (!current || current.release.digest !== initial.pin.releaseDigest || current.release.version !== initial.pin.version ||
    current.registrationDigest !== initial.registrationDigest) failProfile('agent_initial_engine_mismatch');
}

/** Durable setup proof concerns the first pin even after a later valid engine update. */
export function assertInitialAgentSetupProof(root: string, operation: AgentSetupOperation | null,
  receipt: { schemaVersion: number; agentId: string } | null, scope?: HostFileMutationScope) {
  if (receipt?.schemaVersion === 3 && operation?.schemaVersion !== 3) return failProfile('agent_initial_engine_proof_invalid');
  if (operation?.schemaVersion !== 3) {
    // A surviving pin without either setup proof cannot be relabelled as a new legacy initialize operation.
    if (!operation && !receipt && lifecycleExists(join(root, '.secumon', 'engine-pins'))) return failProfile('agent_initial_engine_proof_invalid');
    return;
  }
  const initial = operation.initialEngine, pin = initial.pin;
  if (receipt) {
    const completed = receipt as AgentInitialSetupReceipt;
    if (completed.schemaVersion !== 3 || completed.agentId !== operation.identity.agentId || completed.operationId !== operation.operationId ||
      completed.initialPinDigest !== lifecycleDigest(pin)) return failProfile('agent_initial_engine_proof_invalid');
  }
  const path = join(root, '.secumon', 'engine-pins', '00000001.json');
  let bytes = readProfileBytes(path, 65536, true, scope);
  // Also rejects holes, foreign owners and unrelated pending candidates before setup can be resumed.
  const head = readAgentEnginePin(root);
  // Another initializer may have published after the first empty read; inspect that exact first record once.
  if (head && !bytes) bytes = readProfileBytes(path, 65536, true, scope);
  if (!bytes && (receipt || head) || bytes && !head) return failProfile('agent_initial_engine_pin_missing');
  if (bytes && !bytes.equals(initialEnginePinBytes(pin))) return failProfile('agent_initial_engine_pin_mismatch');
}

export function publishInitialAgentEngine(root: string, operation: Extract<AgentSetupOperation, { schemaVersion: 3 }>, scope: HostFileMutationScope) {
  const folder = join(root, '.secumon', 'engine-pins');
  profileDirectory(folder, true, true, scope);
  const path = join(folder, '00000001.json'), expected = initialEnginePinBytes(operation.initialEngine.pin);
  const prior = readProfileBytes(path, 65536, true, scope);
  if (prior && !prior.equals(expected)) return failProfile('agent_initial_engine_pin_mismatch');
  if (!prior) publishProfileJson(path, operation.initialEngine.pin, scope);
  const actual = readProfileBytes(path, 65536, true, scope);
  if (!actual?.equals(expected)) return failProfile('agent_initial_engine_pin_mismatch');
  syncProfileDirectory(folder, scope); syncProfileDirectory(join(root, '.secumon'), scope);
  assertInitialAgentSetupProof(root, operation, null, scope);
}
