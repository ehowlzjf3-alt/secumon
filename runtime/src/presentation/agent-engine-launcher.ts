import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { join } from 'node:path';
import { AgentLifecycleError } from '../application/agent-lifecycle-contracts.js';
import { resolveAgentEngine } from '../infrastructure/agent-engine-registry.js';
import { prepareAgentEngine } from '../infrastructure/agent-engine-preparation.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { lifecycleExists } from '../infrastructure/agent-lifecycle-files.js';
import { agentLaunchDirectory, agentPreparationDirectory } from './agent-cli-options.js';
import { parseAgentDispatch, validateAgentDispatch } from './agent-dispatch.js';

export type AgentLaunchResult = { kind: 'local'; args: string[]; defaultDirectory?: string } | { kind: 'exited'; code: number };

/** Selects the installation before interpreting an envelope's target-engine command. */
export async function launchPinnedAgent(args: string[], currentEngine: string): Promise<AgentLaunchResult> {
  const dispatch = parseAgentDispatch(args, process.cwd());
  const directory = dispatch?.directory ?? agentLaunchDirectory(args, process.cwd());
  if (directory === null) return { kind: 'local', args };
  let selection = resolveAgentEngine(directory, currentEngine);
  if (selection.source !== 'current') return { kind: 'exited', code: await executeSelectedAgentEngine(args, selection.directory) };
  const local: AgentLaunchResult = dispatch
    ? { kind: 'local', args: dispatch.args, defaultDirectory: validateAgentDispatch(dispatch, currentEngine) }
    : { kind: 'local', args };
  if (!lifecycleExists(join(currentEngine, 'release.json')) && agentPreparationDirectory(local.args, local.defaultDirectory ?? process.cwd()) !== null) {
    const profiles = new FileAgentProfileStore(currentEngine), profile = profiles.inspect(directory);
    if (profile.status === 'uninitialized') {
      if (process.env['SECUMON_ENGINE_LAUNCH_DEPTH'] !== undefined) throw new AgentLifecycleError('engine_launch_changed');
      const prepared = prepareAgentEngine(currentEngine, profile.root);
      // Preparation grants no ownership of the agent. A concurrent initializer may already have selected another engine.
      selection = resolveAgentEngine(profile.root, currentEngine);
      if (selection.source !== 'current') return { kind: 'exited', code: await executeSelectedAgentEngine(args, selection.directory) };
      if (profiles.inspect(profile.root).status === 'uninitialized') return { kind: 'exited', code: await executeSelectedAgentEngine(args, prepared.directory) };
    }
  }
  return local;
}

/** Terminal transport for an already selected installation; only trusted launcher code calls this. */
export function executeSelectedAgentEngine(args: string[], directory: string): Promise<number> {
  // This marker only rejects further dispatch. It never bypasses pin, registration or release validation.
  if (process.env['SECUMON_ENGINE_LAUNCH_DEPTH'] !== undefined) throw new AgentLifecycleError('engine_launch_changed');
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [join(directory, 'dist/presentation/agent-cli.js'), ...args], {
      cwd: process.cwd(), env: { ...process.env, SECUMON_ENGINE_LAUNCH_DEPTH: '1' }, stdio: 'inherit', shell: false,
    });
    const signals = ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? [] : ['SIGHUP'])] as NodeJS.Signals[];
    const listeners = signals.map(signal => {
      const listener = () => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
      process.on(signal, listener); return { signal, listener };
    });
    const cleanup = () => { for (const { signal, listener } of listeners) process.off(signal, listener); };
    let failure: Error | undefined;
    // A signal-delivery error can occur while the child is still live. Retain ownership until close.
    child.on('error', error => { failure ??= error; });
    child.once('close', (code, signal) => {
      cleanup();
      if (failure) reject(new AgentLifecycleError('engine_launch_failed', { cause: failure }));
      else resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1));
    });
  });
}
