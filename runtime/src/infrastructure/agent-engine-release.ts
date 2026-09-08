import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ENGINE_EXTENSION_SUPPORT } from '../application/engine-extension-contracts.js';
import { AgentCloneSetupSchema, AgentConfigSchema, AgentInitialSetupReceiptSchema, AgentSetupOperationSchema, AgentSetupReceiptSchema } from '../application/agent-profile-contracts.js';
import { EnginePinSchema, EngineReleaseSchema, type EngineRelease } from '../application/agent-lifecycle-contracts.js';
import { captureLifecycleTree, copyLifecycleTree, createLifecycleDirectory, disjoint, lifecycleDigest, lifecycleExists, lifecycleFail, lifecycleNames, lifecycleRoot } from './agent-lifecycle-files.js';
import { openProfileMutationScope, profileDirectory, publishProfileJson, readProfileBytes, readProfileJson, syncProfileDirectory } from './agent-profile-files.js';
import { publishWindowsLifecycleJson, readWindowsLifecycleJson } from './windows-lifecycle-files.js';
import { initialEnginePinHistoryNames } from './agent-initial-pin-files.js';

export const engineCompatibility = Object.freeze({ config: [1, 2], state: [1, 2, 3], knowledge: [1, 2, 3], session: [1], journal: [2], documents: [1, 2], setup: [1, 2, 3],
  extensions: ENGINE_EXTENSION_SUPPORT,
  postgres: { installation: [2], binding: [1], state: [1], knowledge: [1], channel: [1] },
});
const nativeReleaseFiles = ['native', 'native/windows-files', 'native/windows-files/secumon_windows_files.node'];
const releaseInclude = (path: string) => nativeReleaseFiles.includes(path) || path !== 'release.json' && !path.split('/').includes('.bin') && !path.split('/').includes('.cache') &&
  ['package.json', 'package-lock.json', 'node_modules', 'guidance', 'examples', 'fixtures', 'src', 'src/presentation', 'src/presentation/web', 'src/presentation/web/index.html', 'src/presentation/web/styles.css', 'dist', 'dist/domain', 'dist/application', 'dist/infrastructure', 'dist/presentation'].some(prefix => path === prefix || ['node_modules', 'guidance', 'examples', 'fixtures', 'dist/domain', 'dist/application', 'dist/infrastructure', 'dist/presentation'].includes(prefix) && path.startsWith(`${prefix}/`));
export function publishLifecycleManifest(root: string, name: string, value: unknown) {
  if (process.platform === 'win32') return publishWindowsLifecycleJson(root, name, value);
  const scope = openProfileMutationScope(root, []);
  try { if (!publishProfileJson(join(root, name), value, scope)) lifecycleFail('lifecycle_destination_exists'); syncProfileDirectory(root, scope); scope.check(); } finally { scope.close(); }
}
function assertManifest(value: EngineRelease) {
  const { digest, ...body } = value; if (lifecycleDigest(body) !== digest) lifecycleFail('engine_release_digest_mismatch');
  if (new Set(value.entries.map(entry => entry.path)).size !== value.entries.length) lifecycleFail('engine_release_invalid');
  if (value.platform !== process.platform || value.arch !== process.arch) lifecycleFail('engine_platform_incompatible');
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor === undefined || patch === undefined || minor < 20 || minor === 20 && patch < 0) lifecycleFail('engine_node_incompatible');
}
export function inspectEngineRelease(input: string, verify = true): EngineRelease {
  const root = lifecycleRoot(input);
  const value = process.platform === 'win32' ? readWindowsLifecycleJson(join(root, 'release.json'), EngineReleaseSchema, 32 * 1024 * 1024) :
    readProfileJson(join(root, 'release.json'), EngineReleaseSchema, [1], 32 * 1024 * 1024);
  if (!value) return lifecycleFail('engine_release_missing'); assertManifest(value);
  if (verify && lifecycleDigest(captureLifecycleTree(root, path => path !== 'release.json')) !== lifecycleDigest(value.entries)) lifecycleFail('engine_release_files_changed');
  return value;
}
export function bundleAgentEngine(input: string, destination: string) {
  const root = lifecycleRoot(input), target = lifecycleRoot(destination, false); disjoint(root, target);
  const raw = process.platform === 'win32' ? readProfileBytes(join(root, 'package.json'), 1024 * 1024) : readFileSync(join(root, 'package.json'));
  if (!raw) return lifecycleFail('engine_build_required');
  const pkg = JSON.parse(raw.toString('utf8')) as { name?: string; version?: string; engines?: { node?: string } };
  if (pkg.name !== 'long-horizon-runtime' || typeof pkg.version !== 'string' || pkg.engines?.node !== '>=24.20.0 <25' || !lifecycleExists(join(root, 'dist/presentation/agent-cli.js')) || !lifecycleExists(join(root, 'node_modules/zod/package.json'))) lifecycleFail('engine_build_required');
  if (process.platform === 'win32' && !lifecycleExists(join(root, 'native/windows-files/secumon_windows_files.node'))) lifecycleFail('engine_native_build_required');
  const entries = captureLifecycleTree(root, releaseInclude);
  const body = { schemaVersion: 1 as const, kind: 'secumon-engine-release' as const, version: pkg.version, node: '>=24.20.0 <25' as const, platform: process.platform, arch: process.arch, compatibility: engineCompatibility, entries };
  const release = EngineReleaseSchema.parse({ ...body, digest: lifecycleDigest(body) }); assertManifest(release);
  createLifecycleDirectory(target); copyLifecycleTree(root, target, entries);
  if (lifecycleDigest(captureLifecycleTree(root, releaseInclude)) !== lifecycleDigest(entries)) lifecycleFail('lifecycle_source_changed');
  publishLifecycleManifest(target, 'release.json', release); return { directory: target, release };
}
export function installAgentEngine(bundle: string, destination: string, expectedDigest: string) {
  const source = lifecycleRoot(bundle), target = lifecycleRoot(destination, false); disjoint(source, target);
  const release = inspectEngineRelease(source); if (release.digest !== expectedDigest) lifecycleFail('engine_release_digest_mismatch');
  createLifecycleDirectory(target); copyLifecycleTree(source, target, release.entries); publishLifecycleManifest(target, 'release.json', release);
  inspectEngineRelease(target); return { directory: target, release, command: ['node', join(target, 'dist/presentation/agent-cli.js')] };
}
const setupReceiptSchema = z.union([AgentSetupReceiptSchema, AgentCloneSetupSchema, AgentInitialSetupReceiptSchema]);
/** Reads original setup records; operation 3 already requires support before its final receipt exists. */
export function readAgentSetupSchemaVersion(root: string): 1 | 2 | 3 | null {
  const receipt = readProfileJson(join(root, '.secumon', 'setup.json'), setupReceiptSchema, [1, 2, 3]);
  const operation = readProfileJson(join(root, '.secumon', 'setup-operation.json'), AgentSetupOperationSchema, [1, 2, 3], 512 * 1024);
  if (receipt?.schemaVersion === 3 || operation?.schemaVersion === 3) return 3;
  if (receipt?.schemaVersion === 2 || operation?.schemaVersion === 2) return 2;
  return receipt || operation ? 1 : null;
}
/** Legacy manifests omit setup support and cover only the original setup formats. */
export function assertAgentSetupCompatibility(root: string, release: Pick<EngineRelease, 'compatibility'>): void {
  const version = readAgentSetupSchemaVersion(root);
  if (version !== null && !(release.compatibility.setup ?? [1, 2]).includes(version)) lifecycleFail('engine_setup_incompatible');
}
export function readAgentEnginePin(root: string) {
  const folder = join(root, '.secumon', 'engine-pins'); if (!lifecycleExists(folder)) return null;
  profileDirectory(folder, false); const listed = lifecycleNames(folder, 1025); if (listed.length > 1024) lifecycleFail('engine_pin_limit');
  const names = initialEnginePinHistoryNames(root, listed).sort();
  let prior: ReturnType<typeof EnginePinSchema.parse> | null = null;
  for (const [index, name] of names.entries()) {
    if (name !== `${String(index + 1).padStart(8, '0')}.json`) lifecycleFail('engine_pin_history_invalid');
    const pin = readProfileJson(join(folder, name), EnginePinSchema); if (!pin || pin.sequence !== index + 1 || pin.previous !== (prior ? lifecycleDigest(prior) : null) || prior && pin.agentId !== prior.agentId) lifecycleFail('engine_pin_history_invalid'); prior = pin;
  }
  if (prior) {
    const config = readProfileJson(join(root, 'config.json'), AgentConfigSchema, [1, 2]);
    if (!config || config.identity.agentId !== prior.agentId) lifecycleFail('engine_pin_owner_mismatch');
  }
  return prior;
}
export function assertAgentEnginePin(root: string, engine: string) {
  const pin = readAgentEnginePin(root);
  if (!pin) {
    if (readAgentSetupSchemaVersion(root) === 3) assertAgentSetupCompatibility(root, inspectEngineRelease(engine));
    return;
  }
  const config = readProfileJson(join(root, 'config.json'), AgentConfigSchema, [1, 2]);
  if (!config || pin.agentId !== config.identity.agentId) return lifecycleFail('engine_pin_owner_mismatch');
  const release = inspectEngineRelease(engine);
  assertAgentSetupCompatibility(root, release);
  if (release.digest !== pin.releaseDigest || !release.compatibility.config.includes(config.schemaVersion)) lifecycleFail('agent_engine_update_required');
}
