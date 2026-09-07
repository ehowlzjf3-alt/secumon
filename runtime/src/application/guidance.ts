import { z } from 'zod';
import { selectMethod, type WorkKind } from '../domain/methods.js';
import { evaluateCompletion } from '../domain/completion.js';
import type { ArtifactRef, WorkState } from '../domain/model.js';
import type { ArtifactStore, Digester } from './ports.js';
import { parseContract } from './contracts.js';
import { frozen, ReadLimitSchema, ToolRefSchema } from './resource-contracts.js';
import { CatalogCursors, type CatalogCursorOptions } from './catalog-cursor.js';
import { asJson } from './plan-validator.js';

export const GuidanceManifestSchema = z.strictObject({ id: z.string().min(1).max(256), version: z.string().min(1).max(256), title: z.string().min(1).max(200),
  summary: z.string().min(1).max(500), source: z.string().min(1).max(1000), tenantId: z.string().min(1).max(256), labels: z.array(z.string().min(1).max(256)).max(100),
  supportedKinds: z.array(z.enum(['lookup', 'transform', 'compare', 'investigate', 'followup'])).min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/), byteLength: z.number().int().min(1).max(1048576),
  requiredRules: z.array(z.string().min(1).max(4000)).min(1).max(100).optional() });
export type GuidanceManifest = z.infer<typeof GuidanceManifestSchema>;
export interface GuidanceSourcePage { revision: string; manifests: GuidanceManifest[]; nextCursor: string | null }
export interface GuidanceSource {
  list(): Promise<GuidanceManifest[]>;
  read(id: string, version: string, signal?: AbortSignal): Promise<Uint8Array>;
  listSnapshot?(input: { cursor: string | null; signal: AbortSignal }): Promise<GuidanceSourcePage>;
  /** Must verify this exact manifest and its original content. A cached body is never its own validation. */
  validate?(manifest: GuidanceManifest, signal?: AbortSignal): Promise<boolean>;
}
export interface GuidanceOptions extends CatalogCursorOptions { digester?: Digester; maxCachedBodies?: number; maxCachedBytes?: number }
export interface GuidanceRefreshOptions { signal?: AbortSignal; maxPages?: number; maxEntries?: number; maxBytes?: number }
export const GuidancePageQuerySchema = z.strictObject({ kind: z.enum(['lookup', 'transform', 'compare', 'investigate', 'followup']),
  limit: z.number().int().min(1).max(20), maxBytes: ReadLimitSchema, cursor: z.string().min(1).max(1024).nullable().optional() });
export type GuidancePageQuery = z.infer<typeof GuidancePageQuerySchema>;
interface GuidanceCard { id: string; version: string; title: string; summary: string; byteLength: number; sha256: string }
interface GuidancePage { status: 'available' | 'too_large'; cards: GuidanceCard[]; hasMore: boolean; nextCursor: string | null; snapshotRevision: number; byteLength: number; requiredBytes?: number }
interface BodyEntry { artifact: ArtifactRef; body: string; byteLength: number; contentKey: string }
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
function measured<T extends { byteLength: number }>(value: T): T {
  let bytes = jsonBytes(value); while (bytes !== value.byteLength) { value.byteLength = bytes; bytes = jsonBytes(value); } return value;
}
function boundedNumber(value: number | undefined, fallback: number, maximum: number, minimum = 1): number {
  const actual = value ?? fallback; if (!Number.isSafeInteger(actual) || actual < minimum || actual > maximum) throw new Error('invalid_guidance_limits'); return actual;
}
function cancelled(signal: AbortSignal) { if (signal.aborted) throw new Error('guidance_cancelled'); }
async function pending<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error('guidance_cancelled')); };
    const cleanup = () => signal.removeEventListener('abort', abort); signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { cancelled(signal); return action(); }).then(value => {
      cleanup(); if (signal.aborted) reject(new Error('guidance_cancelled')); else resolve(value);
    }, error => { cleanup(); reject(signal.aborted ? new Error('guidance_cancelled') : error); });
  });
}
export class GuidanceCatalog {
  #entries = new Map<string, GuidanceManifest>();
  #revision = 0;
  #sourceRevision: string | null = null;
  readonly #cursors: CatalogCursors | null;
  readonly #digester: Digester | undefined;
  readonly #cache = new Map<string, BodyEntry>();
  readonly #stores = new WeakMap<ArtifactStore, number>();
  #storeSequence = 0;
  #cachedBytes = 0;
  readonly #maxBodies: number;
  readonly #maxBytes: number;
  readonly #metrics = { sourceReadCalls: 0, sourceReadBytes: 0, sourceValidateCalls: 0, artifactPutCalls: 0,
    artifactCheckCalls: 0, bodyDecodes: 0, cacheHits: 0, cacheMisses: 0 };
  readonly #validationMetrics = { calls: 0, legacyReadCalls: 0, legacyReadBytes: 0, legacyListingCalls: 0, legacyListingBytes: 0, legacyArtifactPuts: 0 };
  private constructor(readonly source: GuidanceSource, options: GuidanceOptions) {
    this.#digester = options.digester; this.#cursors = options.digester ? new CatalogCursors(options.digester, options) : null;
    this.#maxBodies = boundedNumber(options.maxCachedBodies, 16, 128, 0); this.#maxBytes = boundedNumber(options.maxCachedBytes, 2 * 1024 * 1024, 16 * 1024 * 1024, 0);
  }
  static async create(source: GuidanceSource, options: GuidanceOptions = {}) {
    const catalog = new GuidanceCatalog(source, options); await catalog.refresh(); return catalog;
  }
  get revision() { return this.#revision; }
  get sourceRevision() { return this.#sourceRevision; }
  metrics() { return { ...this.#metrics, cachedBodies: this.#cache.size, cachedBytes: this.#cachedBytes }; }
  /** Application calls/returned bytes; filesystem probes retain their separate adapter I/O counters. */
  validationMetrics() { return { ...this.#validationMetrics }; }
  async refresh(options: GuidanceRefreshOptions = {}) {
    const signal = options.signal ?? new AbortController().signal; const expected = this.#revision;
    const maxPages = boundedNumber(options.maxPages, 100, 1000); const maxEntries = boundedNumber(options.maxEntries, 1000, 10000);
    const maxBytes = boundedNumber(options.maxBytes, 4 * 1024 * 1024, 64 * 1024 * 1024); const snapshot = this.source.listSnapshot?.bind(this.source);
    const legacy = this.source.list.bind(this.source); const staged = new Map<string, GuidanceManifest>(); const cursors = new Set<string>();
    let cursor: string | null = null; let sourceRevision: string | null = null; let pages = 0; let byteLength = 0;
    do {
      if (pages >= maxPages) throw new Error('guidance_page_limit');
      const value = snapshot ? await pending(() => snapshot({ cursor, signal }), signal) :
        { revision: null, manifests: await pending(legacy, signal), nextCursor: null };
      cancelled(signal); pages++;
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'manifests,nextCursor,revision' ||
          !Array.isArray(value.manifests) || (snapshot && (typeof value.revision !== 'string' || !value.revision.length || value.revision.length > 256)) ||
          (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !value.nextCursor.length || jsonBytes(value.nextCursor) > 4096))) throw new Error('invalid_guidance_page');
      if (pages > 1 && value.revision !== sourceRevision) throw new Error('guidance_revision_mixed'); sourceRevision = value.revision;
      if (staged.size + value.manifests.length > maxEntries) throw new Error('guidance_entry_limit');
      byteLength += jsonBytes(value); if (byteLength > maxBytes) throw new Error('guidance_byte_limit');
      for (const item of value.manifests) {
        const manifest = frozen(parseContract(GuidanceManifestSchema, item)); const key = this.key(manifest.id, manifest.version);
        if (staged.has(key)) throw new Error('duplicate_guidance'); staged.set(key, manifest);
      }
      cursor = value.nextCursor;
      if (cursor !== null) { if (cursors.has(cursor)) throw new Error('guidance_cursor_cycle'); cursors.add(cursor); }
    } while (cursor !== null);
    cancelled(signal); if (this.#revision !== expected) throw new Error('guidance_snapshot_conflict');
    if (expected === Number.MAX_SAFE_INTEGER) throw new Error('guidance_revision_overflow');
    this.#entries = staged; this.#sourceRevision = sourceRevision; this.#revision++;
    const retained = new Set([...staged.values()].map(manifest => this.contentKey(manifest)));
    for (const [key, entry] of this.#cache) if (!retained.has(entry.contentKey)) this.evict(key);
    return { revision: this.#revision, sourceRevision, entryCount: staged.size, pages, byteLength };
  }
  private key(id: string, version: string) { return JSON.stringify([id, version]); }
  private contentKey(manifest: GuidanceManifest) { return JSON.stringify({ sha256: manifest.sha256, byteLength: manifest.byteLength, tenantId: manifest.tenantId, labels: [...manifest.labels].sort() }); }
  private cacheKey(manifest: GuidanceManifest, artifacts: ArtifactStore) {
    let store = this.#stores.get(artifacts); if (store === undefined) { store = ++this.#storeSequence; this.#stores.set(artifacts, store); }
    return JSON.stringify([store, this.contentKey(manifest)]);
  }
  private evict(key: string) { const entry = this.#cache.get(key); if (entry) { this.#cachedBytes -= entry.byteLength; this.#cache.delete(key); } }
  private cache(key: string, entry: BodyEntry) {
    if (!this.#maxBodies || entry.byteLength > this.#maxBytes) return;
    this.evict(key);
    while (this.#cache.size >= this.#maxBodies || this.#cachedBytes + entry.byteLength > this.#maxBytes) this.evict(this.#cache.keys().next().value!);
    this.#cache.set(key, entry); this.#cachedBytes += entry.byteLength;
  }
  private allowed(manifest: GuidanceManifest, state: WorkState) {
    return manifest.tenantId === state.policy.tenantId && manifest.labels.every(l => state.policy.allowedLabels.includes(l));
  }
  method(state: WorkState, kind: WorkKind) {
    const validated = z.enum(['lookup', 'transform', 'compare', 'investigate', 'followup']).parse(kind);
    const completion = evaluateCompletion(state.goal, state.evidence, state.obligations, state.policy, state.attempts);
    return selectMethod({ kind: validated, hasContradictions: completion.criteria.some(c => c.reasons.includes('unresolved_counterevidence')),
      needsIndependentSources: state.goal.criteria.some(c => c.minIndependentSources > 1), awaitsResponse: state.obligations.some(o => o.kind === 'response' && o.status === 'pending') });
  }
  describe(state: WorkState, id: string, version: string) {
    const manifest = this.#entries.get(this.key(id, version));
    if (!manifest || !this.allowed(manifest, state)) throw new Error('guidance_unavailable');
    return structuredClone(manifest);
  }
  list(state: WorkState, kind: WorkKind, limit: number) {
    z.enum(['lookup', 'transform', 'compare', 'investigate', 'followup']).parse(kind); z.number().int().min(1).max(20).parse(limit);
    const entries = [...this.#entries.values()].filter(m => this.allowed(m, state) && m.supportedKinds.includes(kind)).sort((a, b) => a.id.localeCompare(b.id, 'en') || a.version.localeCompare(b.version, 'en'));
    return { cards: entries.slice(0, limit).map(({ id, version, title, summary, byteLength, sha256 }) => ({ id, version, title, summary, byteLength, sha256 })), hasMore: entries.length > limit };
  }
  listPage(state: WorkState, input: GuidancePageQuery): GuidancePage {
    const query = parseContract(GuidancePageQuerySchema, input); if (!this.#cursors || !this.#digester) throw new Error('guidance_cursor_unconfigured');
    const entries = [...this.#entries.values()].filter(m => this.allowed(m, state) && m.supportedKinds.includes(query.kind))
      .sort((a, b) => a.id.localeCompare(b.id, 'en') || a.version.localeCompare(b.version, 'en'));
    const scope = { queryDigest: this.#digester.digest(query.kind), policyDigest: this.#digester.digest(asJson({ policy: state.policy, workId: state.id, goal: state.goal })),
      snapshotRevision: this.#revision, snapshotDigest: this.#digester.digest(asJson(entries)) };
    const offset = query.cursor ? this.#cursors.resolve(query.cursor, scope) : 0;
    if (offset < 0 || (offset > 0 && offset >= entries.length)) throw new Error('catalog_cursor_stale');
    const page = (cards: GuidanceCard[]): GuidancePage => { const hasMore = offset + cards.length < entries.length;
      return measured({ status: 'available', cards, hasMore, nextCursor: hasMore ? this.#cursors!.preview(scope, offset + cards.length) : null, snapshotRevision: this.#revision, byteLength: 0 }); };
    let result = page([]);
    for (const { id, version, title, summary, byteLength, sha256 } of entries.slice(offset, offset + query.limit)) {
      const candidate = page([...result.cards, { id, version, title, summary, byteLength, sha256 }]);
      if (candidate.byteLength > query.maxBytes) {
        if (!result.cards.length) return measured({ status: 'too_large', cards: [], hasMore: true, nextCursor: null,
          snapshotRevision: this.#revision, byteLength: 0, requiredBytes: candidate.byteLength });
        break;
      }
      result = candidate;
    }
    if (result.byteLength > query.maxBytes) throw new Error('guidance_page_budget_too_small');
    if (result.hasMore) result.nextCursor = this.#cursors.issue(scope, offset + result.cards.length);
    return result;
  }
  private async legacyListingCurrent(state: WorkState, manifest: GuidanceManifest, signal: AbortSignal): Promise<boolean> {
    const read = this.source.read.bind(this.source); const list = this.source.list.bind(this.source); const snapshot = this.source.listSnapshot?.bind(this.source);
    const source: GuidanceSource = { read, list: async () => {
      this.#validationMetrics.legacyListingCalls++; const values = await list(); this.#validationMetrics.legacyListingBytes += jsonBytes(values); return values;
    }, ...(snapshot ? { listSnapshot: async (input: { cursor: string | null; signal: AbortSignal }) => {
      this.#validationMetrics.legacyListingCalls++; const page = await snapshot(input); this.#validationMetrics.legacyListingBytes += jsonBytes(page); return page;
    } } : {}) };
    const fresh = new GuidanceCatalog(source, {}); await fresh.refresh({ signal });
    return JSON.stringify(fresh.describe(state, manifest.id, manifest.version)) === JSON.stringify(manifest);
  }
  /** Validates a stored selection against its original source without granting authority beyond the supplied state. */
  async validateCurrent(value: WorkState, artifacts: ArtifactStore, expected: GuidanceManifest, options: { kind?: WorkKind; signal?: AbortSignal } = {}): Promise<boolean> {
    this.#validationMetrics.calls++;
    let cacheKey: string | undefined;
    try {
      const state = structuredClone(value); const manifest = parseContract(GuidanceManifestSchema, expected);
      const signal = options.signal ?? new AbortController().signal;
      const kind = options.kind === undefined ? undefined : parseContract(GuidancePageQuerySchema.shape.kind, options.kind);
      const current = () => {
        cancelled(signal); const latest = this.#entries.get(this.key(manifest.id, manifest.version));
        return Boolean(latest && JSON.stringify(latest) === JSON.stringify(manifest) && this.allowed(latest, state) && (!kind || latest.supportedKinds.includes(kind)));
      };
      if (!current()) return false;
      cacheKey = this.cacheKey(manifest, artifacts);
      const validate = this.source.validate?.bind(this.source);
      if (validate) {
        this.#metrics.sourceValidateCalls++;
        if (!(await pending(() => validate(structuredClone(manifest), signal), signal))) { this.evict(cacheKey); return false; }
      } else {
        // Legacy adapters promise no cheap probe. Fresh content and a fresh complete listing are both required.
        const read = this.source.read.bind(this.source);
        this.#validationMetrics.legacyReadCalls++; this.#metrics.sourceReadCalls++;
        const bytes = Uint8Array.from(await pending(() => read(manifest.id, manifest.version, signal), signal));
        this.#validationMetrics.legacyReadBytes += bytes.byteLength; this.#metrics.sourceReadBytes += bytes.byteLength;
        if (bytes.byteLength !== manifest.byteLength) { this.evict(cacheKey); return false; }
        this.#validationMetrics.legacyArtifactPuts++; this.#metrics.artifactPutCalls++;
        const artifact = await pending(() => artifacts.put(bytes, { tenantId: manifest.tenantId, labels: [...manifest.labels], mediaType: 'text/markdown' }), signal);
        if (artifact.sha256 !== manifest.sha256 || artifact.byteLength !== manifest.byteLength || artifact.tenantId !== manifest.tenantId ||
          !manifest.labels.every(label => artifact.labels.includes(label)) || !artifact.labels.every(label => state.policy.allowedLabels.includes(label))) { this.evict(cacheKey); return false; }
        if (!(await this.legacyListingCurrent(state, manifest, signal))) { this.evict(cacheKey); return false; }
      }
      // No await follows this check: refresh may have changed applicability or required rules during the probe.
      return current();
    } catch { if (cacheKey) this.evict(cacheKey); return false; }
  }
  async load(value: WorkState, artifacts: ArtifactStore, input: { id: string; version: string; kind: WorkKind; reason: string; maxBytes: number }, options: { signal?: AbortSignal } = {}) {
    const state = structuredClone(value); const signal = options.signal ?? new AbortController().signal; cancelled(signal);
    const ref = parseContract(ToolRefSchema, { id: input.id, version: input.version });
    const limit = parseContract(ReadLimitSchema, input.maxBytes);
    const reason = parseContract(z.string().min(1).max(1000), input.reason); const kind = parseContract(z.enum(['lookup', 'transform', 'compare', 'investigate', 'followup']), input.kind);
    const manifest = this.#entries.get(this.key(ref.id, ref.version));
    if (!manifest || !this.allowed(manifest, state) || !manifest.supportedKinds.includes(kind)) throw new Error('guidance_unavailable');
    const current = () => {
      cancelled(signal); const latest = this.#entries.get(this.key(ref.id, ref.version));
      if (!latest || JSON.stringify(latest) !== JSON.stringify(manifest) || !this.allowed(latest, state) || !latest.supportedKinds.includes(kind)) throw new Error('guidance_changed');
    };
    if (manifest.byteLength > limit) return { status: 'too_large' as const, byteLength: manifest.byteLength, id: manifest.id, version: manifest.version };
    const sourceRead = this.source.read.bind(this.source); const validate = this.source.validate?.bind(this.source); const key = this.cacheKey(manifest, artifacts);
    const sourceCurrent = async () => {
      let valid: boolean;
      if (validate) { this.#metrics.sourceValidateCalls++; valid = await pending(() => validate(structuredClone(manifest), signal), signal); }
      else valid = await this.legacyListingCurrent(state, manifest, signal);
      if (!valid) { this.evict(key); throw new Error('guidance_source_changed'); }
    };
    const cached = validate && this.#cache.get(key);
    if (cached) {
      this.#metrics.artifactCheckCalls++;
      if (await pending(() => artifacts.exists(cached.artifact), signal)) {
        current(); await sourceCurrent(); current(); this.#metrics.cacheHits++;
        this.cache(key, cached);
        return this.loaded(state, manifest, structuredClone(cached.artifact), cached.body, kind, reason);
      }
      this.evict(key);
    }
    this.#metrics.cacheMisses++; this.#metrics.sourceReadCalls++;
    const bytes = Uint8Array.from(await pending(() => sourceRead(ref.id, ref.version, signal), signal)); this.#metrics.sourceReadBytes += bytes.byteLength;
    if (bytes.byteLength !== manifest.byteLength) throw new Error('guidance_integrity_failure');
    this.#metrics.artifactPutCalls++;
    const artifact = await pending(() => artifacts.put(bytes, { tenantId: manifest.tenantId, labels: [...manifest.labels], mediaType: 'text/markdown' }), signal);
    if (artifact.sha256 !== manifest.sha256 || artifact.byteLength !== manifest.byteLength || artifact.tenantId !== manifest.tenantId ||
        !manifest.labels.every(label => artifact.labels.includes(label)) || !artifact.labels.every(label => state.policy.allowedLabels.includes(label))) throw new Error('guidance_integrity_failure');
    let body: string; this.#metrics.bodyDecodes++; try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('guidance_not_utf8'); }
    current(); await sourceCurrent(); current();
    if (validate) this.cache(key, { artifact: structuredClone(artifact), body, byteLength: manifest.byteLength, contentKey: this.contentKey(manifest) });
    return this.loaded(state, manifest, artifact, body, kind, reason);
  }
  private loaded(state: WorkState, manifest: GuidanceManifest, artifact: ArtifactRef, body: string, kind: WorkKind, reason: string) {
    return { status: 'available' as const, manifest: structuredClone(manifest), artifact, body, selectedFor: { workId: state.id, goalRevision: state.goal.revision, kind, reason },
      method: this.method(state, kind), role: 'guidance_only' as const, grantsPermissions: false as const };
  }
}
