import { parseArgs } from 'node:util';
import { AgentLifecycleError } from '../application/agent-lifecycle-contracts.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { agentCliRoute } from './agent-cli-options.js';

export interface AgentDispatch { directory: string; args: string[] }

/** The bootstrap interprets only the header. Target-engine flags remain opaque, including future flags. */
export function parseAgentDispatch(args: string[], cwd: string): AgentDispatch | null {
  if (args[0] !== 'dispatch') return null;
  const separator = args.indexOf('--', 1);
  if (separator < 0 || separator === args.length - 1) throw new AgentLifecycleError('engine_dispatch_command_required');
  try {
    const { values } = parseArgs({ args: args.slice(1, separator), strict: true, allowPositionals: false,
      options: { directory: { type: 'string', default: cwd } } });
    if (!values.directory.trim()) throw new Error('empty_directory');
    return { directory: values.directory, args: args.slice(separator + 1) };
  } catch (error) { throw new AgentLifecycleError('engine_dispatch_header_invalid', { cause: error }); }
}

/** Only the chosen engine calls this, using its own option definitions before executing the inner CLI. */
export function validateAgentDispatch(dispatch: AgentDispatch, engine: string): string {
  const profiles = new FileAgentProfileStore(engine);
  const outer = profiles.inspect(dispatch.directory).root;
  const route = agentCliRoute(dispatch.args, outer);
  if (route.kind === 'bootstrap') throw new AgentLifecycleError('engine_dispatch_command_not_supported');
  if (route.kind === 'agent') {
    const inner = profiles.inspect(route.directory).root;
    const comparable = (path: string) => process.platform === 'win32' ? path.toUpperCase() : path;
    if (comparable(inner) !== comparable(outer)) throw new AgentLifecycleError('engine_dispatch_directory_mismatch');
  }
  // Help is data-free. Invalid input returns to this engine's original parser/error reporter, never another engine.
  return outer;
}
