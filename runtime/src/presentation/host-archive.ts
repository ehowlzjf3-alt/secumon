import type { ArchiveDescriptor, ArchiveOwner, ArchiveProvider } from '../application/archive-contracts.js';
import { ArchiveOwnerSchema } from '../application/archive-contracts.js';
import { ArchiveService } from '../application/archive-service.js';
import { createArchiveTools } from '../application/archive-tools.js';
import type { Tool } from '../application/ports.js';
import { frozen } from '../application/resource-contracts.js';
import type { WorkActor } from '../application/work-resources.js';
import { FileArchiveProvider } from '../infrastructure/file-archive.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { closeAgentTurnResources } from './host-models.js';

export interface HostArchiveContext {
  readonly agentId: string; readonly root: string; readonly scope: string; readonly actor: WorkActor; readonly signal: AbortSignal;
}
export interface OpenedArchiveProvider { readonly provider: ArchiveProvider; close(): Promise<void> }
export interface HostArchiveRegistration {
  /** Explicit host grant, independent of provider mutation capability. Omission denies model and management writes. */
  readonly allowWrites?: boolean;
  open(context: Readonly<HostArchiveContext>): Promise<OpenedArchiveProvider>;
}
export interface OpenedHostArchive {
  readonly service: ArchiveService; readonly tools: readonly Tool[];
  readonly allowedTools: readonly string[]; readonly allowWrites: boolean;
  close(): Promise<void>;
}

/** Optional host injection only; an absent registration performs no I/O and enables no tools. */
export async function openHostArchive(registration: HostArchiveRegistration | undefined, context: HostArchiveContext): Promise<OpenedHostArchive | null> {
  if (registration === undefined) return null;
  const open = registration.open;
  const requestedWrites = registration.allowWrites;
  if (typeof open !== 'function' || requestedWrites !== undefined && typeof requestedWrites !== 'boolean' ||
    !(context.signal instanceof AbortSignal)) throw new Error('archive_registration_invalid');
  const actor = frozen({ ...structuredClone(context.actor), allowWrites: requestedWrites === true });
  const owner: ArchiveOwner = ArchiveOwnerSchema.parse({ agentId: context.agentId, scope: context.scope,
    tenantId: actor.tenantId, principalId: actor.principalId });
  const lifetime = new AbortController();
  const signal = AbortSignal.any([context.signal, lifetime.signal]);
  const captured = Object.freeze({ ...context, actor, signal });
  context.signal.throwIfAborted();
  const opened = await open.call(registration, captured);
  let close: (() => Promise<void>) | undefined;
  try {
    const sourceClose = opened.close;
    if (typeof sourceClose !== 'function') throw new Error('archive_registration_invalid');
    let closing: Promise<void> | undefined;
    close = () => { lifetime.abort(); return closing ??= Promise.resolve().then(() => sourceClose.call(opened)); };
    const service = new ArchiveService(opened.provider, owner, signal, new Sha256Digester(), requestedWrites === true);
    if (requestedWrites === true && service.descriptor.access !== 'read_register') throw new Error('archive_write_not_supported');
    service.authorize(actor);
    const tools = Object.freeze(createArchiveTools(service, actor));
    return Object.freeze({ service, tools, allowedTools: Object.freeze(tools.map(tool => tool.definition.id)), allowWrites: requestedWrites === true, close });
  } catch (error) {
    await closeAgentTurnResources(close ? [close] : [], { error });
    throw error;
  }
}

/** Original text/path/version are explicitly registered through service.mutate; no memory or Evidence is synthesized. */
export function createLocalArchiveRegistration(descriptor: ArchiveDescriptor = {
  id: 'archive', version: '1', destination: 'local', labels: [], access: 'read_register',
}, options: { allowWrites?: boolean } = {}): HostArchiveRegistration {
  const selected = frozen(structuredClone(descriptor));
  const allowWrites = options.allowWrites;
  return Object.freeze({ ...(allowWrites === undefined ? {} : { allowWrites }), async open(context: Readonly<HostArchiveContext>) {
    const provider = new FileArchiveProvider({ root: context.root, owner: { agentId: context.agentId, scope: context.scope,
      tenantId: context.actor.tenantId, principalId: context.actor.principalId }, descriptor: selected });
    return { provider, close: () => provider.close() };
  } });
}
