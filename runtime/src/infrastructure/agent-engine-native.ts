import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { AgentLifecycleError, type LifecycleEntry } from '../application/agent-lifecycle-contracts.js';
import { captureLifecycleTree, lifecycleDigest, lifecycleFail, lifecycleRoot } from './agent-lifecycle-files.js';

export const AGENT_ENGINE_NATIVE_PATH = 'native/windows-files/secumon_windows_files.node';
export const AGENT_ENGINE_NATIVE_PATHS = ['native', 'native/windows-files', AGENT_ENGINE_NATIVE_PATH] as const;
export interface AgentEngineNativeCapabilities { platform: NodeJS.Platform; arch: string; fileApi: 4; retirementApi: 1 }

/** Metadata-only: inspecting an unselected release must never execute its code. */
export function assertAgentEngineNativeEntries(entries: readonly LifecycleEntry[]): void {
  for (const path of AGENT_ENGINE_NATIVE_PATHS) {
    const found = entries.filter(entry => entry.path === path);
    if (found.length !== 1 || (path === AGENT_ENGINE_NATIVE_PATH ? found[0]!.kind !== 'file' : found[0]!.kind !== 'directory'))
      lifecycleFail('engine_native_build_required');
  }
}

// Only this fixed probe executes. No entry point or JS module from the candidate engine is imported.
const probe = `const addon = require(process.argv[1]);
const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform;
const files = addon.setupCapabilities(), retirement = addon.directoryRetirementCapabilities();
if (files.platform !== platform || files.win32BackendCompiled !== (process.platform === 'win32') ||
    files.hostFilesApiVersion !== 4 || files.maximumBytes !== 4 * 1024 * 1024 || files.maximumStreamBytes !== 1024 ** 3 ||
    files.namespaceBarrier !== 'unsupported' || typeof addon.openDirectory !== 'function' || typeof addon.fileMetrics !== 'function' ||
    retirement.apiVersion !== 1 || retirement.platform !== platform || retirement.noReplace !== true ||
    typeof addon.retireDirectoryNoReplace !== 'function') process.exit(2);
process.stdout.write(JSON.stringify({ platform: process.platform, arch: process.arch, fileApi: 4, retirementApi: 1 }));`;

/** Explicit trusted host preparation/install/registration only. A fresh bounded child avoids require-cache reuse. */
export function assertAgentEngineNative(input: string, entries: readonly LifecycleEntry[]): AgentEngineNativeCapabilities {
  assertAgentEngineNativeEntries(entries);
  const root = lifecycleRoot(input), expected = entries.filter(entry => (AGENT_ENGINE_NATIVE_PATHS as readonly string[]).includes(entry.path));
  const current = () => captureLifecycleTree(root, path => (AGENT_ENGINE_NATIVE_PATHS as readonly string[]).includes(path));
  if (lifecycleDigest(current()) !== lifecycleDigest(expected)) lifecycleFail('engine_native_changed');
  // Node preload/search and dynamic-loader environment variables are not inherited.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const capabilities: AgentEngineNativeCapabilities = { platform: process.platform, arch: process.arch, fileApi: 4, retirementApi: 1 };
  let failure: unknown;
  try {
    const output = execFileSync(process.execPath, ['--input-type=commonjs', '-e', probe, join(root, AGENT_ENGINE_NATIVE_PATH)], {
      cwd: dirname(process.execPath), env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    if (output !== JSON.stringify(capabilities)) throw new Error('engine_native_probe_result_invalid');
  } catch (cause) { failure = cause; }
  if (lifecycleDigest(current()) !== lifecycleDigest(expected)) lifecycleFail('engine_native_changed');
  if (failure) throw new AgentLifecycleError('engine_native_incompatible', { cause: failure });
  return Object.freeze(capabilities);
}
