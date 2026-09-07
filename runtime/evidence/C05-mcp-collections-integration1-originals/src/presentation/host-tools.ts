import { z } from 'zod';
import { BudgetSchema, PolicySchema } from '../application/contracts.js';
import type { SchemaCompiler, Tool } from '../application/ports.js';
import type { ProviderRefreshOptions, ProviderToolSource } from '../application/provider-tool-snapshot.js';
import { frozen } from '../application/resource-contracts.js';
import type { RuntimeServices } from '../application/services.js';
import { snapshotTool, validProvider } from '../application/tool-contracts.js';
import type { Limits, Policy } from '../domain/model.js';
import { closeAgentTurnResources, type AgentTurnHost } from './host-models.js';

export interface HostToolContext { readonly agentId: string; readonly root: string; readonly scope: string }
export interface HostToolAssembly {
  readonly custody: Readonly<Pick<RuntimeServices, 'state' | 'artifacts' | 'digester' | 'clock'>>;
  readonly schemas: SchemaCompiler;
  readonly signal: AbortSignal;
}
export interface HostProviderTools {
  readonly provider: string;
  readonly source: ProviderToolSource;
  readonly limits?: Readonly<Pick<ProviderRefreshOptions, 'maxPages' | 'maxTools' | 'maxBytes'>>;
}
export interface OpenedHostTools {
  readonly tools: readonly Tool[];
  readonly policy: Policy;
  readonly limits: Limits;
  readonly providerSources?: readonly HostProviderTools[];
  close(): Promise<void>;
}
export interface HostToolRegistration { open(context: Readonly<HostToolContext>, assembly?: HostToolAssembly): Promise<OpenedHostTools> }
export interface AgentExecutionHost extends AgentTurnHost { readonly tools?: HostToolRegistration }

const text = (maximum: number) => z.string().min(1).max(maximum).refine(value => value.trim().length > 0 && !value.includes('\0'));
const ContextSchema = z.strictObject({ agentId: text(256), root: text(4096), scope: text(256) });
// Numeric range/default validation belongs to refreshProviderTools; this only captures metadata.
const ProviderLimitsSchema = z.strictObject({ maxPages: z.number().optional(), maxTools: z.number().optional(), maxBytes: z.number().optional() });
function invalid(cause?: unknown): Error {
  return new Error('agent_tool_registration_invalid', cause === undefined ? undefined : { cause });
}
function failure(error: unknown): Error {
  return error instanceof Error && error.message === 'agent_tool_registration_invalid' ? error : invalid(error);
}
function captureRegistration(value: unknown): HostToolRegistration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const open = (value as HostToolRegistration).open;
  if (typeof open !== 'function') throw invalid();
  return Object.freeze({ open: open.bind(value) });
}
function captureAssembly(value: HostToolAssembly): HostToolAssembly {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const { custody, schemas, signal } = value;
  if (!custody || typeof custody !== 'object' || Array.isArray(custody) || !(signal instanceof AbortSignal)) throw invalid();
  const { state, artifacts, digester, clock } = custody;
  for (const [port, methods] of [
    [state, ['get', 'receipt', 'commit', 'events', 'recentEventMetadata', 'deliveries', 'workIdsForConversation', 'conversationWorkPage', 'runnable', 'close']],
    [artifacts, ['put', 'get', 'exists']], [digester, ['digest']], [clock, ['now']],
  ] as const) {
    if (!port || typeof port !== 'object' || Array.isArray(port) || methods.some(method => typeof Reflect.get(port, method) !== 'function')) throw invalid();
  }
  if (!schemas || typeof schemas !== 'object' || Array.isArray(schemas)) throw invalid();
  const sourceCompile = schemas.compile;
  if (typeof sourceCompile !== 'function') throw invalid();
  const compile = sourceCompile.bind(schemas);
  // Keep the actual C01 port instances. Do not freeze or acquire their lifetime here.
  return Object.freeze({ custody: Object.freeze({ state, artifacts, digester, clock }), schemas: Object.freeze({ compile }), signal });
}
function readTool(candidate: Tool): Tool {
  const tool = snapshotTool(candidate), definition = tool.definition;
  if (definition.effect !== 'read' || definition.provider === 'core' || definition.id.startsWith('core.')) throw invalid();
  return tool;
}
function captureProvider(value: HostProviderTools): HostProviderTools {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const { provider, source, limits } = value;
  if (!validProvider(provider) || provider === 'core' || !source || typeof source !== 'object' || Array.isArray(source)) throw invalid();
  const list = source.list;
  if (typeof list !== 'function') throw invalid();
  const currentList = list.bind(source);
  const parsedLimits = limits === undefined ? undefined : ProviderLimitsSchema.parse(structuredClone(limits));
  const capturedLimits = parsedLimits === undefined ? undefined : Object.freeze({
    ...(parsedLimits.maxPages === undefined ? {} : { maxPages: parsedLimits.maxPages }),
    ...(parsedLimits.maxTools === undefined ? {} : { maxTools: parsedLimits.maxTools }),
    ...(parsedLimits.maxBytes === undefined ? {} : { maxBytes: parsedLimits.maxBytes }),
  });
  const currentSource: ProviderToolSource = Object.freeze({ async list(input: Parameters<ProviderToolSource['list']>[0]) {
    const page = await currentList(input);
    // Preserve malformed shape/revision/cursor and extra keys for the existing refresh validator.
    if (!page || typeof page !== 'object' || Array.isArray(page) || !Array.isArray(page.tools)) return page;
    return { ...page, tools: Array.from(page.tools, readTool) };
  } });
  return Object.freeze({ provider, source: currentSource, ...(capturedLimits === undefined ? {} : { limits: capturedLimits }) });
}

/** Host code supplies this registration; neither user text nor configuration names executable modules. */
export function resolveHostToolRegistration(host: AgentExecutionHost | undefined): HostToolRegistration | null {
  try {
    if (host === undefined) return null;
    if (!host || typeof host !== 'object' || Array.isArray(host)) throw invalid();
    const registration = host.tools;
    return registration === undefined ? null : captureRegistration(registration);
  } catch (error) { throw failure(error); }
}

/** Capture one owned lease. Final input/output schema compilation remains in composeRuntime's ToolContracts. */
export async function openRegisteredHostTools(registration: HostToolRegistration, context: HostToolContext, assembly?: HostToolAssembly): Promise<OpenedHostTools> {
  let selected: HostToolRegistration, expected: HostToolContext, capturedAssembly: HostToolAssembly | undefined;
  try {
    selected = captureRegistration(registration);
    expected = frozen(ContextSchema.parse(structuredClone(context)));
    capturedAssembly = assembly === undefined ? undefined : captureAssembly(assembly);
  } catch (error) { throw failure(error); }
  // A factory owns any partial resources until it successfully returns its closer.
  const opened = await selected.open(expected, capturedAssembly);
  let close: (() => Promise<void>) | undefined;
  try {
    if (!opened || typeof opened !== 'object' || Array.isArray(opened)) throw invalid();
    const sourceClose = opened.close;
    if (typeof sourceClose !== 'function') throw invalid();
    const rawClose = sourceClose.bind(opened); let closing: Promise<void> | undefined;
    close = () => closing ??= Promise.resolve().then(rawClose);

    const suppliedTools = opened.tools, suppliedPolicy = opened.policy, suppliedLimits = opened.limits, suppliedProviders = opened.providerSources;
    if (!Array.isArray(suppliedTools)) throw invalid();
    const policy = frozen(PolicySchema.parse(structuredClone(suppliedPolicy)));
    const limits = frozen(BudgetSchema.shape.limits.parse(structuredClone(suppliedLimits)));
    if (policy.allowWrites) throw invalid();
    const tools: Tool[] = [], identities = new Set<string>();
    for (const candidate of Array.from(suppliedTools)) {
      const tool = readTool(candidate), definition = tool.definition;
      const identity = JSON.stringify([definition.id, definition.version]);
      if (identities.has(identity)) throw invalid();
      identities.add(identity); tools.push(tool);
    }
    let providerSources: HostProviderTools[] | undefined;
    if (suppliedProviders !== undefined) {
      if (!capturedAssembly || !Array.isArray(suppliedProviders)) throw invalid();
      const providers = new Set(tools.map(tool => tool.definition.provider));
      providerSources = Array.from(suppliedProviders, candidate => {
        const captured = captureProvider(candidate);
        if (providers.has(captured.provider)) throw invalid();
        providers.add(captured.provider); return captured;
      });
    }
    return Object.freeze({ tools: Object.freeze(tools), policy, limits,
      ...(providerSources === undefined ? {} : { providerSources: Object.freeze(providerSources) }), close });
  } catch (error) {
    const primary = failure(error);
    await closeAgentTurnResources(close ? [close] : [], { error: primary });
    throw primary;
  }
}
