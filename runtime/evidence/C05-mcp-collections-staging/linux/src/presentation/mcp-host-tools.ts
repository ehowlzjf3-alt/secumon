import { z } from 'zod';
import { BudgetSchema, JsonSchema, PolicySchema } from '../application/contracts.js';
import { frozen, ToolDefinitionSchema } from '../application/resource-contracts.js';
import type { Limits, Policy } from '../domain/model.js';
import { createMcpProviderSource, createMcpReadTool, createMcpStoredReadTool, type McpReadBinding, type McpStoredOrigin } from '../infrastructure/mcp-read-tools.js';
import { createMcpReadCollection, createMcpStoredReadCollection, type McpReadCollectionBinding } from '../infrastructure/mcp-read-collections.js';
import { MCP_PROTOCOL_VERSION, McpStdioClient, type McpStdioConfig } from '../infrastructure/mcp-stdio-client.js';
import { closeAgentTurnResources } from './host-models.js';
import type { HostToolAssembly, HostToolContext, HostToolRegistration } from './host-tools.js';

interface McpHostToolsCommonOptions {
  readonly bindings: readonly McpReadBinding[];
  readonly collectionBindings?: readonly McpReadCollectionBinding[];
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

function captureCollection(source: McpReadCollectionBinding): McpReadCollectionBinding {
  const definition = frozen(ToolDefinitionSchema.parse(structuredClone(source.definition)));
  const remote = frozen(RemoteSchema.parse(structuredClone(source.remote)));
  const projectorId = text.parse(source.projectorId), projectorVersion = text.parse(source.projectorVersion);
  const project = source.project, manifest = source.manifest, suppliedDeferral = source.deferral;
  if (definition.effect !== 'read' || definition.provider === 'core' || definition.id.startsWith('core.') || !definition.collection ||
      definition.computerContinuation || definition.computerInputAssurance || definition.reuse || definition.resultValidation ||
      typeof project !== 'function' || typeof manifest !== 'function' || definition.collection.deferralValidation && !suppliedDeferral) throw invalid();
  let deferral: McpReadCollectionBinding['deferral'];
  if (suppliedDeferral !== undefined) {
    const { id, version, maxDelayMs, project: map } = suppliedDeferral;
    if (typeof map !== 'function') throw invalid();
    const captured = { id: text.parse(id), version: text.parse(version),
      maxDelayMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(maxDelayMs), project: map };
    captured.project = map.bind(captured); deferral = Object.freeze(captured);
  }
  ToolDefinitionSchema.parse({ ...definition, version: `${definition.version}.${'0'.repeat(24)}`,
    collection: { ...definition.collection, pageValidation: 'artifact-proof-v1', responseRecovery: 'stored-response-v1',
      ...(deferral ? { deferralValidation: 'artifact-proof-v1' } : {}) } });
  const captured: McpReadCollectionBinding = { definition, remote, projectorId, projectorVersion, project, manifest,
    ...(deferral === undefined ? {} : { deferral }) };
  captured.project = project.bind(captured); captured.manifest = manifest.bind(captured);
  return Object.freeze(captured);
}

function assertCombinedSize(bindings: McpReadBinding[], collections: McpReadCollectionBinding[]): void {
  // Same definition-page budget as the plain provider publication. Digest characters have a fixed UTF-8 width.
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  let length = bytes({ revision: '0'.repeat(64), tools: [], nextCursor: null });
  const definitions = [
    ...bindings.map(({ definition }) => ({ ...definition, version: `${definition.version}.${'0'.repeat(24)}`, resultValidation: 'artifact-proof-v1' })),
    ...collections.map(({ definition, deferral }) => ({ ...definition, version: `${definition.version}.${'0'.repeat(24)}`,
      collection: { ...definition.collection, pageValidation: 'artifact-proof-v1', responseRecovery: 'stored-response-v1',
        ...(deferral ? { deferralValidation: 'artifact-proof-v1' } : {}) } })),
  ];
  for (const [index, definition] of definitions.entries()) {
    length += bytes(definition) + (index === 0 ? 0 : 1);
    if (length > 4 * 1024 * 1024) throw invalid(new Error('provider_byte_limit'));
  }
}

/** One trusted endpoint/provider per registration. Only online opens own a client; custody ports remain caller-owned. */
export function createMcpHostTools(options: McpHostToolsOptions): HostToolRegistration {
  let selection: { mode: 'online'; config: McpStdioConfig } | { mode: 'stored_only'; origin: McpStoredOrigin };
  let bindings: McpReadBinding[], collections: McpReadCollectionBinding[], policy: Policy, limits: Limits;
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
    const suppliedCollections = options.collectionBindings;
    if (policy.allowWrites || !Array.isArray(options.bindings) || suppliedCollections !== undefined && !Array.isArray(suppliedCollections)) throw invalid();
    const count = options.bindings.length + (suppliedCollections?.length ?? 0);
    if (count < 1 || count > 1000) throw invalid();
    bindings = Array.from(options.bindings, captureBinding);
    collections = Array.from(suppliedCollections ?? [], captureCollection);
    const combined = [...bindings, ...collections];
    const provider = combined[0]!.definition.provider, keys = new Set<string>(), remotes = new Set<string>();
    for (const binding of combined) {
      const key = JSON.stringify([binding.definition.id, binding.definition.version]);
      if (binding.definition.provider !== provider || keys.has(key) || remotes.has(binding.remote.name)) throw invalid();
      keys.add(key); remotes.add(binding.remote.name);
    }
    if (collections.length) assertCombinedSize(bindings, collections);
    Object.freeze(bindings); Object.freeze(collections);
  } catch (error) { throw error instanceof Error && error.message === 'mcp_host_registration_invalid' ? error : invalid(error); }

  return Object.freeze({ async open(_context: Readonly<HostToolContext>, assembly?: HostToolAssembly) {
    if (!assembly) throw new Error('mcp_host_assembly_required');
    assembly.signal.throwIfAborted();
    if (selection.mode === 'stored_only') {
      const origin = selection.origin, closed = Promise.resolve();
      const tools = bindings.map(binding => createMcpStoredReadTool(binding, origin, assembly.custody, assembly.schemas));
      const collectionTools = collections.map(binding => createMcpStoredReadCollection(binding, origin, assembly.custody, assembly.schemas));
      // No peer or store belongs to this lease. Runtime drain keeps using these captured ports until the host closes them.
      return Object.freeze({ tools: Object.freeze(tools), policy, limits,
        ...(collections.length ? { collectionTools: Object.freeze(collectionTools) } : {}), close: () => closed });
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
      if (collections.length) {
        const session = await scopedClient.discover([...bindings, ...collections].map(binding => binding.remote), lifetime);
        const tools = bindings.map(binding => createMcpReadTool(binding, session, scopedClient, assembly.custody, assembly.schemas));
        const collectionTools = collections.map(binding => createMcpReadCollection(binding, session, scopedClient, assembly.custody, assembly.schemas));
        lifetime.throwIfAborted();
        return Object.freeze({ tools: Object.freeze(tools), collectionTools: Object.freeze(collectionTools), policy, limits, close });
      }
      const source = createMcpProviderSource(bindings, scopedClient, assembly.custody, assembly.schemas);
      return Object.freeze({ tools: Object.freeze([]), policy, limits,
        providerSources: Object.freeze([Object.freeze({ provider: bindings[0]!.definition.provider, source: Object.freeze(source) })]), close });
    } catch (error) {
      await closeAgentTurnResources([close], { error });
      throw error;
    }
  } } satisfies HostToolRegistration);
}
