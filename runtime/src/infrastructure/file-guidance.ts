import { readFile, realpath, lstat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import { GuidanceManifestSchema, type GuidanceManifest, type GuidanceSource, type GuidanceSourcePage } from '../application/guidance.js';
import { parseContract } from '../application/contracts.js';
import { canonical, sha256 } from './digest.js';
import type { Json } from '../domain/model.js';

const PackSchema = z.strictObject({ schemaVersion: z.literal(1), entries: z.array(GuidanceManifestSchema.extend({ bodyFile: z.string().min(1).max(512) })).max(1000) });
export class FileGuidanceSource implements GuidanceSource {
  readonly #metrics = { catalogReads: 0, catalogBytes: 0, bodyReads: 0, bodyBytes: 0, readCalls: 0, validateCalls: 0 };
  constructor(readonly directory: string) {}
  metrics() { return { ...this.#metrics }; }
  private cancelled(signal?: AbortSignal) { if (signal?.aborted) throw new Error('guidance_cancelled'); }
  private async catalog(signal?: AbortSignal) {
    this.cancelled(signal); this.#metrics.catalogReads++;
    const bytes = await readFile(resolve(this.directory, 'catalog.json'), { ...(signal ? { signal } : {}) });
    this.#metrics.catalogBytes += bytes.byteLength; this.cancelled(signal);
    if (bytes.byteLength > 2097152) throw new Error('guidance_catalog_too_large');
    const entries = parseContract(PackSchema, JSON.parse(bytes.toString('utf8'))).entries; const keys = new Set<string>();
    for (const entry of entries) { const key = JSON.stringify([entry.id, entry.version]); if (keys.has(key)) throw new Error('duplicate_guidance'); keys.add(key); }
    return { revision: `file:${sha256(bytes)}`, entries };
  }
  private manifest(entry: z.infer<typeof PackSchema>['entries'][number]): GuidanceManifest {
    const { bodyFile: _bodyFile, ...manifest } = entry; return structuredClone(manifest);
  }
  async list(): Promise<GuidanceManifest[]> { return (await this.catalog()).entries.map(entry => this.manifest(entry)); }
  async listSnapshot(input: { cursor: string | null; signal: AbortSignal }): Promise<GuidanceSourcePage> {
    if (input.cursor !== null) throw new Error('guidance_cursor_invalid');
    const result = await this.catalog(input.signal);
    return { revision: result.revision, manifests: result.entries.map(entry => this.manifest(entry)), nextCursor: null };
  }
  private async body(entry: z.infer<typeof PackSchema>['entries'][number], signal?: AbortSignal) {
    this.cancelled(signal);
    const root = await realpath(this.directory); const candidate = resolve(root, entry.bodyFile);
    if (!candidate.startsWith(root + sep) || !(await lstat(candidate)).isFile()) throw new Error('guidance_path_invalid');
    const path = await realpath(candidate); if (!path.startsWith(root + sep)) throw new Error('guidance_path_invalid');
    this.cancelled(signal); this.#metrics.bodyReads++;
    const bytes = await readFile(path, { ...(signal ? { signal } : {}) }); this.#metrics.bodyBytes += bytes.byteLength; this.cancelled(signal);
    if (bytes.byteLength !== entry.byteLength || sha256(bytes) !== entry.sha256) throw new Error('guidance_integrity_failure');
    return bytes;
  }
  async read(id: string, version: string, signal?: AbortSignal) {
    this.#metrics.readCalls++; const initial = await this.catalog(signal); const entry = initial.entries.find(value => value.id === id && value.version === version);
    if (!entry) throw new Error('guidance_unavailable'); const bytes = await this.body(entry, signal);
    if ((await this.catalog(signal)).revision !== initial.revision) throw new Error('guidance_source_changed');
    this.cancelled(signal); return bytes;
  }
  /** This probe reads and hashes the original body; its cost remains in bodyReads/bodyBytes. */
  async validate(value: GuidanceManifest, signal?: AbortSignal): Promise<boolean> {
    this.#metrics.validateCalls++;
    try {
      const manifest = parseContract(GuidanceManifestSchema, value); const initial = await this.catalog(signal);
      const entry = initial.entries.find(item => item.id === manifest.id && item.version === manifest.version);
      if (!entry || canonical(this.manifest(entry) as unknown as Json) !== canonical(manifest as unknown as Json)) return false;
      await this.body(entry, signal);
      return (await this.catalog(signal)).revision === initial.revision;
    } catch { this.cancelled(signal); return false; }
  }
}
