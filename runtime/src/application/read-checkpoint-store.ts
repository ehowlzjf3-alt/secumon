import type { ArtifactRef, WorkState } from '../domain/model.js';
import type { ReadCheckpoint } from '../domain/read-checkpoint.js';
import type { ReadCheckpointRecord } from '../domain/read-checkpoint-record.js';
import type { ReadDeferral, ReadPage } from '../domain/read-collection.js';
import { visibleArtifact } from '../domain/data-lifecycle.js';
import type { ArtifactStore, Digester } from './ports.js';
import { asJson } from './plan-validator.js';
import { ArtifactSchema } from './contracts.js';
import { ReadCheckpointSchema } from './read-checkpoint-contracts.js';
import { ReadDeferralSchema, ReadPageSchema } from './read-collection-contracts.js';
import { decodeReadCheckpoint, encodeReadCheckpoint, ReadCheckpointRecordSchema } from './read-checkpoint-record.js';

const maximumRecordBytes = 16 * 1024 * 1024;
const maximumChainBytes = 64 * 1024 * 1024;
const maximumRecords = 10000;
const maximumCacheBytes = 16 * 1024 * 1024;
type Materialization = { checkpoint: ReadCheckpoint; ref: ArtifactRef; chainIds: string[]; chainBytes: number; bytes: number };
const materializations = new WeakMap<ArtifactStore, { values: Map<string, Materialization>; bytes: number }>();
function unavailable(): never { throw new Error('read_checkpoint_unavailable'); }

/** Writes small changes while preserving the logical checkpoint and legacy reader contract. */
export async function storeReadCheckpoint(artifacts: ArtifactStore, digester: Digester, checkpoint: ReadCheckpoint,
  base: { head: ArtifactRef; checkpoint: ReadCheckpoint } | null): Promise<ArtifactRef> {
  const record = encodeReadCheckpoint(checkpoint, base, digester);
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  if (bytes.byteLength > checkpoint.limits.maxCheckpointBytes) unavailable();
  return artifacts.put(bytes, { tenantId: checkpoint.policy.tenantId, labels: [...checkpoint.policy.allowedLabels], mediaType: 'application/json' });
}

export interface ReadCheckpointMetrics {
  artifactReads: number;
  artifactCacheHits: number;
  jsonParses: number;
  pageParses: number;
  recordApplications: number;
  logicalCacheHits: number;
  revalidations: number;
  peakCachedBytes: number;
}

/** One verification scope only. Exact references and source integrity are checked again before returning a reused view. */
export class ReadCheckpointReader {
  readonly #state: WorkState;
  private readonly index = new Map<string, ArtifactRef>();
  private readonly cache = new Map<string, { bytes: Uint8Array; json?: unknown; page?: ReadPage; deferral?: ReadDeferral }>();
  private readonly reused = new Map<string, ArtifactRef>();
  private readonly requiredOriginals = new Map<string, ArtifactRef>();
  private cachedBytes = 0;
  private readonly counts: ReadCheckpointMetrics = { artifactReads: 0, artifactCacheHits: 0, jsonParses: 0, pageParses: 0, recordApplications: 0, logicalCacheHits: 0, revalidations: 0, peakCachedBytes: 0 };
  constructor(state: WorkState, readonly artifacts: ArtifactStore, readonly digester: Digester) {
    this.#state = structuredClone(state);
    for (const ref of state.artifacts) {
      if (this.index.has(ref.id) && !this.same(this.index.get(ref.id), ref)) unavailable();
      this.index.set(ref.id, structuredClone(ref));
    }
  }
  get state(): WorkState { return structuredClone(this.#state); }
  metrics(): ReadCheckpointMetrics { return { ...this.counts }; }
  private remember(ref: ArtifactRef, checkpoint: ReadCheckpoint, chainIds: string[], chainBytes: number) {
    const bytes = new TextEncoder().encode(JSON.stringify({ checkpoint, chainIds, chainBytes })).byteLength;
    if (bytes > maximumCacheBytes) return;
    let cache = materializations.get(this.artifacts);
    if (!cache) { cache = { values: new Map(), bytes: 0 }; materializations.set(this.artifacts, cache); }
    const old = cache.values.get(ref.id);
    if (old) { cache.bytes -= old.bytes; cache.values.delete(ref.id); }
    while (cache.values.size >= 64 || cache.bytes + bytes > maximumCacheBytes) {
      const key = cache.values.keys().next().value!; cache.bytes -= cache.values.get(key)!.bytes; cache.values.delete(key);
    }
    cache.values.set(ref.id, { ref: structuredClone(ref), checkpoint: structuredClone(checkpoint), chainIds: [...chainIds], chainBytes, bytes }); cache.bytes += bytes;
  }
  private async remembered(ref: ArtifactRef, visited: Set<string>, bytes: number): Promise<Materialization | null> {
    const cache = materializations.get(this.artifacts); const old = cache?.values.get(ref.id);
    if (!old) return null;
    if (!this.same(ref, old.ref)) unavailable();
    if (old.chainIds[0] !== ref.id || visited.size + old.chainIds.length - 1 > maximumRecords ||
      bytes + old.chainBytes - ref.byteLength > maximumChainBytes || old.chainIds.slice(1).some(id => visited.has(id))) unavailable();
    // Only deterministic decoding is reused. Every input artifact is read and verified in this scope.
    for (const original of old.checkpoint.artifacts) await this.original(original);
    this.counts.logicalCacheHits++;
    // Another reader may evict or replace this entry while its inputs are being checked.
    if (cache!.values.get(ref.id) === old) { cache!.values.delete(ref.id); cache!.values.set(ref.id, old); }
    return structuredClone(old);
  }
  private same(a: unknown, b: unknown) { return this.digester.digest(asJson(a ?? null)) === this.digester.digest(asJson(b ?? null)); }
  private check(ref: ArtifactRef, maximum?: number) {
    if (!visibleArtifact(this.#state, ref) || !this.same(this.index.get(ref.id), ref) || maximum !== undefined && ref.byteLength > maximum) unavailable();
  }
  private owned(cp: ReadCheckpoint, ref: ArtifactRef) {
    if (ref.tenantId !== cp.policy.tenantId || ref.mediaType !== 'application/json' ||
      !this.same([...ref.labels].sort(), [...cp.policy.allowedLabels].sort()) || ref.byteLength > cp.limits.maxCheckpointBytes) unavailable();
  }
  private async entry(value: ArtifactRef, maximum?: number) {
    const ref = ArtifactSchema.parse(value);
    this.check(ref, maximum);
    const cached = this.cache.get(ref.id);
    if (cached) {
      this.counts.artifactCacheHits++; this.reused.set(ref.id, ref);
      this.cache.delete(ref.id); this.cache.set(ref.id, cached); return cached;
    }
    this.counts.artifactReads++;
    const bytes = await this.artifacts.get(structuredClone(ref), structuredClone(this.#state.policy));
    if (bytes.byteLength !== ref.byteLength) unavailable();
    const entry = { bytes: new Uint8Array(bytes) } as { bytes: Uint8Array; json?: unknown; page?: ReadPage; deferral?: ReadDeferral };
    if (bytes.byteLength <= maximumCacheBytes) {
      while (this.cachedBytes + bytes.byteLength > maximumCacheBytes || this.cache.size >= maximumRecords) {
        const oldest = this.cache.keys().next().value; if (!oldest) unavailable();
        this.cachedBytes -= this.cache.get(oldest)!.bytes.byteLength; this.cache.delete(oldest);
      }
      this.cache.set(ref.id, entry); this.cachedBytes += bytes.byteLength;
      this.counts.peakCachedBytes = Math.max(this.counts.peakCachedBytes, this.cachedBytes);
    }
    return entry;
  }
  async original(ref: ArtifactRef, maximum?: number): Promise<Uint8Array> { return new Uint8Array((await this.entry(ref, maximum)).bytes); }
  /** Proof originals remain in the final integrity fence even after their bytes leave the local cache. */
  async proofOriginal(ref: ArtifactRef, maximum: number): Promise<Uint8Array> {
    this.check(ref, maximum);
    this.requiredOriginals.set(ref.id, structuredClone(ref));
    return this.original(ref, maximum);
  }
  private async json(ref: ArtifactRef, maximum?: number) {
    const entry = await this.entry(ref, maximum);
    if (entry.json === undefined) {
      this.counts.jsonParses++;
      entry.json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes)) as unknown;
    }
    return entry.json;
  }
  async page(ref: ArtifactRef, maximum = 4 * 1024 * 1024): Promise<ReadPage> {
    const entry = await this.entry(ref, maximum);
    if (!entry.page) {
      if (entry.json === undefined) { this.counts.jsonParses++; entry.json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes)) as unknown; }
      this.counts.pageParses++; entry.page = ReadPageSchema.parse(entry.json);
    }
    return structuredClone(entry.page);
  }
  async load(head: ArtifactRef): Promise<ReadCheckpoint> {
    const stack: { ref: ArtifactRef; record: ReadCheckpointRecord }[] = [];
    const initialHead = ArtifactSchema.parse(head);
    const visited = new Set<string>(); let ref = initialHead; let bytes = 0; let checkpoint: ReadCheckpoint;
    for (;;) {
      if (visited.has(ref.id) || visited.size >= maximumRecords) unavailable();
      visited.add(ref.id); bytes += ref.byteLength;
      if (bytes > maximumChainBytes) unavailable();
      const value = await this.json(ref, maximumRecordBytes);
      if (!value || typeof value !== 'object') unavailable();
      const cached = await this.remembered(ref, visited, bytes);
      if (cached) {
        bytes += cached.chainBytes - ref.byteLength;
        for (const id of cached.chainIds.slice(1)) visited.add(id);
        checkpoint = cached.checkpoint; this.owned(checkpoint, ref); break;
      }
      const tag = value as { schemaVersion?: unknown; kind?: unknown };
      if (tag.schemaVersion === 1 && tag.kind === 'read_checkpoint') {
        checkpoint = ReadCheckpointSchema.parse(value); this.owned(checkpoint, ref); break;
      }
      const record = ReadCheckpointRecordSchema.parse(value);
      if (record.change.type === 'start') {
        this.counts.recordApplications++;
        checkpoint = await decodeReadCheckpoint(record, null, ref => this.page(ref), this.digester, ref => this.deferral(ref));
        this.owned(checkpoint, ref); break;
      }
      stack.push({ ref, record }); ref = record.change.base;
    }
    for (let i = stack.length - 1; i >= 0; i--) {
      const next = stack[i]!; this.counts.recordApplications++;
      checkpoint = await decodeReadCheckpoint(next.record, checkpoint, ref => this.page(ref), this.digester, ref => this.deferral(ref));
      this.owned(checkpoint, next.ref);
    }
    this.remember(initialHead, checkpoint, [...visited], bytes);
    return checkpoint;
  }
  async revalidate(): Promise<void> {
    for (const ref of new Map([...this.reused, ...this.requiredOriginals]).values()) {
      this.check(ref); this.counts.revalidations++;
      if (!(await this.artifacts.exists(structuredClone(ref)))) unavailable();
    }
  }
  async deferral(ref: ArtifactRef, maximum = 4 * 1024 * 1024): Promise<ReadDeferral> {
    const entry = await this.entry(ref, maximum);
    if (!entry.deferral) entry.deferral = ReadDeferralSchema.parse(await this.json(ref, maximum));
    return structuredClone(entry.deferral);
  }
}
