import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { join } from 'node:path';
import { AgentLifecycleError } from '../application/agent-lifecycle-contracts.js';
import { resolveAgentEngine } from '../infrastructure/agent-engine-registry.js';
import { agentLaunchDirectory } from './agent-cli-options.js';

/** Returns null when the invoked engine handles this command; otherwise the selected child owns the terminal. */
export async function launchPinnedAgent(args: string[], currentEngine: string): Promise<number | null> {
  const directory = agentLaunchDirectory(args, process.cwd());
  if (directory === null) return null;
  const selection = resolveAgentEngine(directory, currentEngine);
  if (selection.source === 'current') return null;
  return executeSelectedAgentEngine(args, selection.directory);
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
