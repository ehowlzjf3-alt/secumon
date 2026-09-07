import type { Clock, Digester, IdGenerator } from './ports.js';

export interface CatalogCursorScope {
  queryDigest: string;
  policyDigest: string;
  snapshotRevision: number;
  snapshotDigest: string;
}
export interface CatalogCursorOptions { clock?: Clock; ids?: IdGenerator; cursorTtlMs?: number; maxCursors?: number }
interface CursorRecord { scope: CatalogCursorScope; offset: number; expiresAt: number | null }
let localIssuer = 0;

/** Local acceleration only: callers must restart a search when this bounded index is lost or expires. */
export class CatalogCursors {
  #records = new Map<string, CursorRecord>();
  #serial = 0;
  readonly #issuer: string;
  readonly #clock: Clock | undefined;
  readonly #ttl: number;
  readonly #maximum: number;
  constructor(private readonly digester: Digester, options: CatalogCursorOptions = {}) {
    this.#clock = options.clock; this.#ttl = options.cursorTtlMs ?? 300000; this.#maximum = options.maxCursors ?? 128;
    if (!Number.isSafeInteger(this.#ttl) || this.#ttl < 1 || this.#ttl > 86400000 ||
        !Number.isSafeInteger(this.#maximum) || this.#maximum < 1 || this.#maximum > 1024 ||
        (options.cursorTtlMs !== undefined && !options.clock)) throw new Error('invalid_catalog_cursor_options');
    this.#issuer = options.ids?.next('catalog-cursor') ?? `local-${++localIssuer}`;
  }
  private now(): number | null {
    if (!this.#clock) return null;
    const now = this.#clock.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - this.#ttl) throw new Error('invalid_catalog_clock');
    return now;
  }
  preview(scope: CatalogCursorScope, offset: number): string {
    if (this.#serial === Number.MAX_SAFE_INTEGER) throw new Error('catalog_cursor_overflow');
    return `cc:${this.digester.digest({ issuer: this.#issuer, serial: this.#serial, scope: { ...scope }, offset })}`;
  }
  issue(scope: CatalogCursorScope, offset: number): string {
    const now = this.now(); const token = this.preview(scope, offset); this.#serial++;
    for (const [key, record] of this.#records) if (record.scope.snapshotRevision !== scope.snapshotRevision ||
      (now !== null && record.expiresAt !== null && record.expiresAt <= now)) this.#records.delete(key);
    while (this.#records.size >= this.#maximum) this.#records.delete(this.#records.keys().next().value!);
    this.#records.set(token, { scope: { ...scope }, offset, expiresAt: now === null ? null : now + this.#ttl });
    return token;
  }
  resolve(token: string, scope: CatalogCursorScope): number {
    const record = this.#records.get(token); const now = this.now();
    if (!record) throw new Error('catalog_cursor_stale');
    if (record.scope.queryDigest !== scope.queryDigest || record.scope.policyDigest !== scope.policyDigest) throw new Error('catalog_cursor_mismatch');
    if (record.scope.snapshotRevision !== scope.snapshotRevision || record.scope.snapshotDigest !== scope.snapshotDigest ||
        (now !== null && record.expiresAt !== null && record.expiresAt <= now)) {
      this.#records.delete(token); throw new Error('catalog_cursor_stale');
    }
    return record.offset;
  }
}
