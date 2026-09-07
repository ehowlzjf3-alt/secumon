import { z } from 'zod';
import { BudgetSchema, JsonSchema, PolicySchema } from '../application/contracts.js';
import { frozen, ToolDefinitionSchema } from '../application/resource-contracts.js';
import type { Limits, Policy } from '../domain/model.js';
import { createMcpProviderSource, createMcpStoredReadTool, type McpReadBinding, type McpStoredOrigin } from '../infrastructure/mcp-read-tools.js';
import { MCP_PROTOCOL_VERSION, McpStdioClient, type McpStdioConfig } from '../infrastructure/mcp-stdio-client.js';
import { closeAgentTurnResources } from './host-models.js';
import type { HostToolAssembly, HostToolContext, HostToolRegistration } from './host-tools.js';

interface McpHostToolsCommonOptions {
  readonly bindings: readonly McpReadBinding[];
  readonly policy: Policy;
  readonly limits: Limits;
}
export type McpHostToolsOptions = McpHostToolsCommonOptions & (
  | { readonly mode?: 'online'; readonly config: McpStdioConfig; readonly origin?: never }
  | { readonly mode: 'stored_only'; readonly origin: McpStoredOrigin; readonly config?: never }
);

const text = z.string().min(1).max(256).refine(value => value.trim().length > 0 && !value.includes('\0'));
const StoredOriginSchema = z.strictObject({ endpointId: text, protocolVersion: z.literal(MCP_PROTOCOL_VERSION) });
const RemoteSchema = z.strictObject({ name: text, inputSchema: JsonSchema, outputSchema: JsonSchema });
function invalid(cause?: unknown): Error {
  return new Error('mcp_host_registration_invalid', cause === undefined ? undefined : { cause });
}
function captureBinding(source: McpReadBinding): McpReadBinding {
  const definition = frozen(ToolDefinitionSchema.parse(structuredClone(source.definition)));
  const remote = frozen(RemoteSchema.parse(structuredClone(source.remote)));
  const projectorId = text.parse(source.projectorId), projectorVersion = text.parse(source.projectorVersion), project = source.project;
  if (definition.effect !== 'read' || definition.provider === 'core' || definition.id.startsWith('core.') ||
      definition.collection || definition.computerContinuation || definition.computerInputAssurance || definition.reuse || typeof project !== 'function') throw invalid();
  // The adapter adds this digest suffix after discovery. Reject an unpublishable version before opening a peer.
  ToolDefinitionSchema.parse({ ...definition, version: `${definition.version}.${'0'.repeat(24)}`, resultValidation: 'artifact-proof-v1' });
  const captured: McpReadBinding = { definition, remote, projectorId, projectorVersion, project };
  captured.project = project.bind(captured);
  return Object.freeze(captured);
}

/** One trusted endpoint/provider per registration. Only online opens own a client; custody ports remain caller-owned. */
export function createMcpHostTools(options: McpHostToolsOptions): HostToolRegistration {
  let selection: { mode: 'online'; config: McpStdioConfig } | { mode: 'stored_only'; origin: McpStoredOrigin };
  let bindings: McpReadBinding[], policy: Policy, limits: Limits;
  try {
    if (options.mode === 'stored_only') {
      if ('config' in options) throw invalid();
      selection = { mode: 'stored_only', origin: frozen(StoredOriginSchema.parse(structuredClone(options.origin))) };
    } else {
      if (options.mode !== undefined && options.mode !== 'online' || 'origin' in options) throw invalid();
      selection = { mode: 'online', config: frozen(structuredClone(options.config)) };
    }
    policy = frozen(PolicySchema.parse(structuredClone(options.policy)));
    limits = frozen(BudgetSchema.shape.limits.parse(structuredClone(options.limits)));
    if (policy.allowWrites || !Array.isArray(options.bindings) || options.bindings.length < 1 || options.bindings.length > 1000) throw invalid();
    bindings = Array.from(options.bindings, captureBinding);
    const provider = bindings[0]!.definition.provider, keys = new Set<string>(), remotes = new Set<string>();
    for (const binding of bindings) {
      const key = JSON.stringify([binding.definition.id, binding.definition.version]);
      if (binding.definition.provider !== provider || keys.has(key) || remotes.has(binding.remote.name)) throw invalid();
      keys.add(key); remotes.add(binding.remote.name);
    }
    Object.freeze(bindings);
  } catch (error) { throw error instanceof Error && error.message === 'mcp_host_registration_invalid' ? error : invalid(error); }

  return Object.freeze({ async open(_context: Readonly<HostToolContext>, assembly?: HostToolAssembly) {
    if (!assembly) throw new Error('mcp_host_assembly_required');
    assembly.signal.throwIfAborted();
    if (selection.mode === 'stored_only') {
      const origin = selection.origin, closed = Promise.resolve();
      const tools = bindings.map(binding => createMcpStoredReadTool(binding, origin, assembly.custody, assembly.schemas));
      // No peer or store belongs to this lease. Runtime drain keeps using these captured ports until the host closes them.
      return Object.freeze({ tools: Object.freeze(tools), policy, limits, close: () => closed });
    }
    // Construction validates the captured transport config without starting a subprocess.
    const client = new McpStdioClient(selection.config), stopped = new AbortController();
    const lifetime = AbortSignal.any([assembly.signal, stopped.signal]);
    let closing: Promise<void> | undefined;
    const close = () => {
      if (!closing) { stopped.abort(); closing = Promise.resolve().then(() => client.close()); }
      return closing;
    };
    try {
      const scopedClient: Pick<McpStdioClient, 'discover' | 'call'> = {
        discover: (expected, signal) => client.discover(expected, AbortSignal.any([lifetime, signal])),
        call: (session, name, input, context) => client.call(session, name, input,
          { ...context, signal: AbortSignal.any([lifetime, context.signal]) }),
      };
      const source = createMcpProviderSource(bindings, scopedClient, assembly.custody, assembly.schemas);
      return Object.freeze({ tools: Object.freeze([]), policy, limits,
        providerSources: Object.freeze([Object.freeze({ provider: bindings[0]!.definition.provider, source: Object.freeze(source) })]), close });
    } catch (error) {
      await closeAgentTurnResources([close], { error });
      throw error;
    }
  } } satisfies HostToolRegistration);
}
