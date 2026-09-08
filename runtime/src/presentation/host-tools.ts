import { captureEngineApi, EngineExtensionError, type EngineApiRegistration } from '../application/engine-extension-contracts.js';
import { z } from 'zod';
import { BudgetSchema, PolicySchema } from '../application/contracts.js';
import type { ReadCollectionBinding, SchemaCompiler, Tool } from '../application/ports.js';
import { snapshotReadCollectionBinding } from '../application/read-collections.js';
import type { ProviderRefreshOptions, ProviderToolSource } from '../application/provider-tool-snapshot.js';
import { frozen } from '../application/resource-contracts.js';
import type { EffectProofValidator, RuntimeServices } from '../application/services.js';
import { snapshotTool, validProvider } from '../application/tool-contracts.js';
import type { Limits, Policy } from '../domain/model.js';
import { closeAgentTurnResources, type AgentTurnHost } from './host-models.js';
import type { KnoxRegistration } from '../infrastructure/knox-channel.js';
import type { HostBoardRegistration } from './host-board.js';
import type { HostArchiveRegistration } from './host-archive.js';
import type { BudgetAuthority, BudgetChildRuntime } from '../application/budget-authority.js';
import type { HostPeerRegistration } from './host-peers.js';
import type { HostA2aRegistration } from './host-a2a.js';
import type { HostMissionRegistration } from './host-missions.js';
import type { ComputerBinding } from '../application/computer-use-ports.js';
import { captureHostComputerBindings } from './host-computer-tools.js';
import type { BudgetWorkLedgers } from '../application/budget-work-ledgers.js';

export interface HostToolContext { readonly agentId: string; readonly root: string; readonly scope: string }
export interface HostToolAssembly {
  readonly custody: Readonly<Pick<RuntimeServices, 'state' | 'artifacts' | 'digester' | 'clock'>>;
  readonly schemas: SchemaCompiler;
  readonly signal: AbortSignal;
}
export interface HostProviderTools {
  readonly provider: string;
  readonly source: ProviderToolSource;
  /** Explicit host declaration; actual writes still require the current work policy. Omission keeps read-only discovery. */
  readonly allowWrites?: boolean;
  readonly limits?: Readonly<Pick<ProviderRefreshOptions, 'maxPages' | 'maxTools' | 'maxBytes'>>;
}
export interface OpenedHostTools {
  readonly tools: readonly Tool[];
  /** Keep write registration explicit instead of widening the existing read-only tools input. */
  readonly writeTools?: readonly Tool[];
  readonly computerTools?: readonly ComputerBinding[];
  readonly effectReaders?: readonly HostEffectReader[];
  readonly policy: Policy;
  readonly limits: Limits;
  readonly providerSources?: readonly HostProviderTools[];
  readonly collectionTools?: readonly ReadCollectionBinding[];
  close(): Promise<void>;
}
/** Reads/reconciles original effects; callbacks must never retry the original write. */
export interface HostEffectReader { readonly provider: string; readonly reader: EffectProofValidator }
export interface HostToolRegistration extends EngineApiRegistration { open(context: Readonly<HostToolContext>, assembly?: HostToolAssembly): Promise<OpenedHostTools> }
export interface HostBudgetRegistration extends EngineApiRegistration {
  readonly authority?: BudgetAuthority; readonly children?: BudgetChildRuntime; readonly ledgers?: BudgetWorkLedgers;
}
export interface AgentExecutionHost extends AgentTurnHost {
  /** Host policy only; legacy registrations otherwise remain explicitly unverified. */
  readonly requireDeclaredExtensions?: boolean;
  /** One trusted registry location shared by all agents on this host; absent uses the host default. */
  readonly identityRegistryDirectory?: string;
  readonly postgres?: import('../infrastructure/agent-postgres-storage.js').AgentPostgresHost;
  readonly tools?: HostToolRegistration;
  readonly knox?: KnoxRegistration;
  readonly board?: HostBoardRegistration;
  readonly archive?: HostArchiveRegistration;
  readonly budget?: HostBudgetRegistration;
  readonly peers?: HostPeerRegistration;
  readonly a2a?: HostA2aRegistration;
  /** Host-authenticated inbound handlers may be enabled without an outbound peer registration. */
  readonly a2aInbound?: boolean;
  readonly missions?: HostMissionRegistration;
}

const text = (maximum: number) => z.string().min(1).max(maximum).refine(value => value.trim().length > 0 && !value.includes('\0'));
const ContextSchema = z.strictObject({ agentId: text(256), root: text(4096), scope: text(256) });
// Numeric range/default validation belongs to refreshProviderTools; this only captures metadata.
const ProviderLimitsSchema = z.strictObject({ maxPages: z.number().optional(), maxTools: z.number().optional(), maxBytes: z.number().optional() });
function invalid(cause?: unknown): Error {
  return new Error('agent_tool_registration_invalid', cause === undefined ? undefined : { cause });
}
function failure(error: unknown): Error {
  return error instanceof EngineExtensionError || error instanceof Error && error.message === 'agent_tool_registration_invalid' ? error : invalid(error);
}
function captureRegistration(value: unknown): HostToolRegistration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const open = (value as HostToolRegistration).open;
  if (typeof open !== 'function') throw invalid();
  const api = captureEngineApi(value as HostToolRegistration);
  return Object.freeze({ ...(api.engineApi ? { engineApi: api.engineApi } : {}),
    open(...args: Parameters<HostToolRegistration['open']>) { api.assertCurrent(); return open.apply(value, args); } });
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
function writeTool(candidate: Tool): Tool {
  const tool = snapshotTool(candidate), definition = tool.definition;
  if (definition.effect !== 'write' || definition.provider === 'core' || definition.id.startsWith('core.') ||
    definition.resultValidation !== 'artifact-proof-v1' || typeof tool.validateResult !== 'function' ||
    definition.computerContinuation !== undefined || definition.computerInputAssurance !== undefined || definition.collection !== undefined)
    throw invalid();
  return tool;
}
function discoveredTool(candidate: Tool, allowWrites: boolean): Tool {
  if (allowWrites && candidate?.definition?.effect === 'write') return writeTool(candidate);
  return readTool(candidate);
}
function captureEffectReader(value: HostEffectReader): HostEffectReader {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const { provider, reader } = value;
  if (!validProvider(provider) || ['core', 'board', 'archive', 'computer'].includes(provider) || !reader || typeof reader !== 'object') throw invalid();
  const { current, refresh, recover } = reader;
  if (typeof current !== 'function' || typeof refresh !== 'function' || typeof recover !== 'function') throw invalid();
  return Object.freeze({ provider, reader: Object.freeze({ current: current.bind(reader), refresh: refresh.bind(reader), recover: recover.bind(reader) }) });
}
function readCollection(candidate: ReadCollectionBinding): ReadCollectionBinding {
  const binding = snapshotReadCollectionBinding(candidate), definition = binding.definition;
  if (definition.effect !== 'read' || definition.provider === 'core' || definition.id.startsWith('core.')) throw invalid();
  return binding;
}
function captureProvider(value: HostProviderTools): HostProviderTools {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const { provider, source, limits, allowWrites } = value;
  if (!validProvider(provider) || provider === 'core' || !source || typeof source !== 'object' || Array.isArray(source)) throw invalid();
  if (allowWrites !== undefined && typeof allowWrites !== 'boolean') throw invalid();
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
    return { ...page, tools: Array.from(page.tools, candidate => discoveredTool(candidate, allowWrites === true)) };
  } });
  return Object.freeze({ provider, source: currentSource, ...(allowWrites === undefined ? {} : { allowWrites }),
    ...(capturedLimits === undefined ? {} : { limits: capturedLimits }) });
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

    const suppliedTools = opened.tools, suppliedPolicy = opened.policy, suppliedLimits = opened.limits, suppliedProviders = opened.providerSources,
      suppliedCollections = opened.collectionTools, suppliedWrites = opened.writeTools, suppliedComputers = opened.computerTools,
      suppliedEffects = opened.effectReaders;
    if (!Array.isArray(suppliedTools)) throw invalid();
    const policy = frozen(PolicySchema.parse(structuredClone(suppliedPolicy)));
    const limits = frozen(BudgetSchema.shape.limits.parse(structuredClone(suppliedLimits)));
    const tools: Tool[] = [], identities = new Set<string>();
    for (const candidate of Array.from(suppliedTools)) {
      const tool = readTool(candidate), definition = tool.definition;
      const identity = JSON.stringify([definition.id, definition.version]);
      if (identities.has(identity)) throw invalid();
      identities.add(identity); tools.push(tool);
    }
    let writeTools: Tool[] | undefined;
    if (suppliedWrites !== undefined) {
      if (!capturedAssembly || !Array.isArray(suppliedWrites)) throw invalid();
      writeTools = Array.from(suppliedWrites, candidate => {
        const tool = writeTool(candidate), identity = JSON.stringify([tool.definition.id, tool.definition.version]);
        if (identities.has(identity)) throw invalid();
        identities.add(identity); return tool;
      });
    }
    let collectionTools: ReadCollectionBinding[] | undefined;
    if (suppliedCollections !== undefined) {
      if (!capturedAssembly || !Array.isArray(suppliedCollections)) throw invalid();
      collectionTools = Array.from(suppliedCollections, candidate => {
        const binding = readCollection(candidate), definition = binding.definition;
        const identity = JSON.stringify([definition.id, definition.version]);
        if (identities.has(identity)) throw invalid();
        identities.add(identity); return binding;
      });
    }
    let computerTools: readonly ComputerBinding[] | undefined;
    if (suppliedComputers !== undefined) {
      if (!capturedAssembly) throw invalid();
      const captured = captureHostComputerBindings(suppliedComputers);
      for (const definition of captured.definitions) {
        const identity = JSON.stringify([definition.id, definition.version]);
        if (identities.has(identity)) throw invalid();
        identities.add(identity);
      }
      computerTools = captured.bindings;
    }
    let providerSources: HostProviderTools[] | undefined;
    if (suppliedProviders !== undefined) {
      if (!capturedAssembly || !Array.isArray(suppliedProviders)) throw invalid();
      const providers = new Set([...tools.map(tool => tool.definition.provider), ...(writeTools ?? []).map(tool => tool.definition.provider),
        ...(collectionTools ?? []).map(binding => binding.definition.provider), ...(computerTools ?? []).map(binding => binding.provider)]);
      providerSources = Array.from(suppliedProviders, candidate => {
        const captured = captureProvider(candidate);
        if (providers.has(captured.provider)) throw invalid();
        providers.add(captured.provider); return captured;
      });
    }
    let effectReaders: HostEffectReader[] | undefined;
    if (suppliedEffects !== undefined) {
      if (!capturedAssembly || !Array.isArray(suppliedEffects)) throw invalid();
      const providers = new Set<string>();
      effectReaders = Array.from(suppliedEffects, value => {
        const reader = captureEffectReader(value);
        if (providers.has(reader.provider)) throw invalid();
        providers.add(reader.provider); return reader;
      });
    }
    const effectProviders = new Set(effectReaders?.map(value => value.provider));
    if (writeTools?.some(tool => !effectProviders.has(tool.definition.provider)) ||
      providerSources?.some(source => source.allowWrites === true && !effectProviders.has(source.provider))) throw invalid();
    if (policy.allowWrites && !writeTools?.length && !computerTools?.length && !providerSources?.some(source => source.allowWrites === true)) throw invalid();
    return Object.freeze({ tools: Object.freeze(tools), policy, limits,
      ...(writeTools === undefined ? {} : { writeTools: Object.freeze(writeTools) }),
      ...(computerTools === undefined ? {} : { computerTools }),
      ...(effectReaders === undefined ? {} : { effectReaders: Object.freeze(effectReaders) }),
      ...(collectionTools === undefined ? {} : { collectionTools: Object.freeze(collectionTools) }),
      ...(providerSources === undefined ? {} : { providerSources: Object.freeze(providerSources) }), close });
  } catch (error) {
    const primary = failure(error);
    await closeAgentTurnResources(close ? [close] : [], { error: primary });
    throw primary;
  }
}
