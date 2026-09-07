import type { Policy } from '../domain/model.js';
import type { WorkActor } from './work-resources.js';
import type { Digester } from './ports.js';
import { asJson } from './plan-validator.js';
import { ArchiveDescriptorSchema, ArchiveDocumentSchema, ArchiveMutationResultSchema, ArchiveMutationSchema,
  ArchiveOwnerSchema, ArchiveQuerySchema, ArchiveSearchSchema,
  type ArchiveDescriptor, type ArchiveMutation, type ArchiveOwner, type ArchiveProvider, type ArchiveQuery } from './archive-contracts.js';
import { frozen } from './resource-contracts.js';

export class ArchiveService {
  readonly owner: ArchiveOwner;
  readonly descriptor: ArchiveDescriptor;
  readonly #source: ArchiveProvider;
  constructor(source: ArchiveProvider, owner: ArchiveOwner, readonly signal: AbortSignal, readonly digester: Digester, readonly allowWrites = false) {
    this.owner = frozen(ArchiveOwnerSchema.parse(owner));
    const descriptor = ArchiveDescriptorSchema.parse(structuredClone(source.descriptor));
    const search = source.search, get = source.get, mutate = source.mutate, receipt = source.receipt;
    if (typeof search !== 'function' || typeof get !== 'function' || descriptor.access === 'read_register' && typeof mutate !== 'function' ||
      receipt !== undefined && typeof receipt !== 'function') {
      throw new Error('archive_registration_invalid');
    }
    this.descriptor = frozen(descriptor);
    this.#source = Object.freeze({ descriptor: this.descriptor, search: search.bind(source), get: get.bind(source),
      ...(descriptor.access === 'read_register' && mutate ? { mutate: mutate.bind(source) } : {}),
      ...(receipt ? { receipt: receipt.bind(source) } : {}) });
  }
  authorize(actor: WorkActor, policy?: Policy): void {
    if (this.signal.aborted) throw new Error('archive_closed');
    if (actor.tenantId !== this.owner.tenantId || actor.principalId !== this.owner.principalId ||
      this.descriptor.labels.some(label => !actor.allowedLabels?.includes(label)) ||
      !actor.allowedDestinations?.includes(this.descriptor.destination)) throw new Error('archive_access_denied');
    if (policy && (policy.tenantId !== actor.tenantId || policy.principalId !== actor.principalId ||
      this.descriptor.labels.some(label => !policy.allowedLabels.includes(label)) || !policy.allowedDestinations.includes(this.descriptor.destination))) {
      throw new Error('archive_access_denied');
    }
  }
  async search(actor: WorkActor, query: ArchiveQuery, signal = this.signal) {
    this.authorize(actor); signal.throwIfAborted();
    const selected = ArchiveQuerySchema.parse(structuredClone(query));
    const result = ArchiveSearchSchema.parse(await this.#source.search(selected, signal));
    this.authorize(actor); signal.throwIfAborted();
    if (result.documents.length > selected.limit || new Set(result.documents.map(doc => doc.id)).size !== result.documents.length ||
      result.documents.some(doc => doc.status !== 'active')) throw new Error('archive_result_invalid');
    return result;
  }
  async get(actor: WorkActor, id: string, signal = this.signal) {
    this.authorize(actor); signal.throwIfAborted();
    const key = ArchiveDocumentSchema.shape.id.parse(id);
    const raw = await this.#source.get(key, signal);
    this.authorize(actor); signal.throwIfAborted();
    const document = raw === null ? null : ArchiveDocumentSchema.parse(raw);
    if (document && document.id !== key) throw new Error('archive_result_invalid');
    return document?.status === 'deleted' ? null : document;
  }
  /** Returns the provider command receipt, not a work effect proof. The runtime owns effect reconciliation. */
  async mutate(actor: WorkActor, input: ArchiveMutation, signal = this.signal) {
    this.authorize(actor);
    signal.throwIfAborted();
    if (!this.allowWrites || !actor.allowWrites || this.descriptor.access !== 'read_register' || !this.#source.mutate) throw new Error('archive_read_only');
    const command = ArchiveMutationSchema.parse(structuredClone(input));
    const result = this.checkedReceipt(command, await this.#source.mutate(command, signal));
    // A successful provider commit remains committed even if close raced with its response.
    return result;
  }
  get supportsReceipts(): boolean { return this.#source.receipt !== undefined; }
  async receipt(actor: WorkActor, input: ArchiveMutation, signal = this.signal) {
    this.authorize(actor); signal.throwIfAborted();
    if (!this.#source.receipt) return null;
    const command = ArchiveMutationSchema.parse(structuredClone(input));
    const raw = await this.#source.receipt(command.commandId, signal);
    this.authorize(actor); signal.throwIfAborted();
    return raw === null ? null : this.checkedReceipt(command, raw);
  }
  private checkedReceipt(command: ArchiveMutation, raw: unknown) {
    const result = ArchiveMutationResultSchema.parse(raw);
    if (result.id !== command.id || result.commandId !== command.commandId || result.commandDigest !== this.digester.digest(asJson(command)) ||
      result.revision !== command.expectedRevision + 1 ||
      result.status !== (command.kind === 'delete' ? 'deleted' : 'active')) throw new Error('archive_result_invalid');
    return result;
  }
}
