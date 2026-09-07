import type { Policy } from '../domain/model.js';
import { z } from 'zod';
import type { Digester, ToolDefinition } from './ports.js';
import { parseContract, PolicySchema } from './contracts.js';
import { asJson } from './plan-validator.js';
import { ReadLimitSchema, SearchSchema, ToolRefSchema } from './resource-contracts.js';
import { ToolContracts, toolAllowed } from './tool-contracts.js';
import { CatalogCursors, type CatalogCursorOptions } from './catalog-cursor.js';

export type ToolRef = { id: string; version: string };
export const CatalogSearchPageSchema = SearchSchema.extend({ maxBytes: ReadLimitSchema, cursor: z.string().min(1).max(1024).nullable().optional() });
export type CatalogSearchPageInput = z.infer<typeof CatalogSearchPageSchema>;
export interface ToolCard { provider: string; id: string; version: string; description: string; effect: 'read' | 'write'; contractDigest: string }
export interface CatalogSearchPage {
  status: 'available' | 'too_large'; cards: ToolCard[]; hasMore: boolean; nextCursor: string | null;
  snapshotRevision: number; byteLength: number; requiredBytes?: number;
}
function measured<T extends { byteLength: number }>(value: T): T {
  let size = new TextEncoder().encode(JSON.stringify(value)).length;
  while (value.byteLength !== size) { value.byteLength = size; size = new TextEncoder().encode(JSON.stringify(value)).length; }
  return value;
}
function normalized(value: string): string { return value.normalize('NFC').toLocaleLowerCase('en'); }
export class ToolCatalog {
  readonly #cursors: CatalogCursors;
  readonly #definitionDigests = new WeakMap<ToolDefinition, string>();
  constructor(readonly contracts: ToolContracts, readonly digester: Digester, cursorOptions: CatalogCursorOptions = {}) {
    this.#cursors = new CatalogCursors(digester, cursorOptions);
  }
  private contractDigest(d: ToolDefinition): string {
    const previous = this.#definitionDigests.get(d); if (previous !== undefined) return previous;
    const digest = this.digester.digest(asJson(d)); this.#definitionDigests.set(d, digest); return digest;
  }
  private card(d: ToolDefinition): ToolCard {
    return { provider: d.provider, id: d.id, version: d.version, description: d.description.slice(0, 240), effect: d.effect,
      contractDigest: this.contractDigest(d) };
  }
  private ranked(policy: Policy, query: string): ToolDefinition[] {
    const words = normalized(query).match(/[\p{L}\p{N}_.:-]+/gu) ?? [];
    if (!words.length) return [];
    return this.contracts.callable(policy).map(d => {
      const name = normalized(d.id); const description = normalized(d.description);
      return { d, score: words.every(w => name.includes(w) || description.includes(w)) ? words.reduce((n, w) => n + (name === w ? 20 : name.includes(w) ? 5 : 1), 0) : 0 };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.d.id.localeCompare(b.d.id, 'en') || a.d.version.localeCompare(b.d.version, 'en')).map(item => item.d);
  }
  search(policy: Policy, input: { query: string; limit: number }) {
    const { query, limit } = parseContract(SearchSchema, input); const ranked = this.ranked(policy, query);
    return { cards: ranked.slice(0, limit).map(d => this.card(d)), hasMore: ranked.length > limit };
  }
  searchPage(policy: Policy, input: CatalogSearchPageInput): CatalogSearchPage {
    const { query, limit, maxBytes, cursor } = parseContract(CatalogSearchPageSchema, input);
    const currentPolicy = parseContract(PolicySchema, policy); const snapshotRevision = this.contracts.revision;
    const ranked = this.ranked(currentPolicy, query);
    const scope = { queryDigest: this.digester.digest(normalized(query)), policyDigest: this.digester.digest(asJson(currentPolicy)), snapshotRevision,
      snapshotDigest: this.digester.digest(ranked.map(d => this.contractDigest(d))) };
    const offset = cursor ? this.#cursors.resolve(cursor, scope) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && offset >= ranked.length)) throw new Error('catalog_cursor_stale');
    const page = (cards: ToolCard[]): CatalogSearchPage => {
      const hasMore = offset + cards.length < ranked.length;
      return measured({ status: 'available', cards, hasMore, nextCursor: hasMore ? this.#cursors.preview(scope, offset + cards.length) : null, snapshotRevision, byteLength: 0 });
    };
    let result = page([]);
    for (const definition of ranked.slice(offset, offset + limit)) {
      const candidate = page([...result.cards, this.card(definition)]);
      if (candidate.byteLength > maxBytes) {
        if (!result.cards.length) {
          const tooLarge = measured<CatalogSearchPage>({ status: 'too_large', cards: [], hasMore: true, nextCursor: null, snapshotRevision, byteLength: 0, requiredBytes: candidate.byteLength });
          if (tooLarge.byteLength > maxBytes) throw new Error('catalog_page_budget_too_small');
          return tooLarge;
        }
        break;
      }
      result = candidate;
    }
    if (result.byteLength > maxBytes) throw new Error('catalog_page_budget_too_small');
    if (result.hasMore) result.nextCursor = this.#cursors.issue(scope, offset + result.cards.length);
    return result;
  }
  describe(policy: Policy, value: ToolRef, maxBytes: number) {
    const ref = parseContract(ToolRefSchema, value); const limit = parseContract(ReadLimitSchema, maxBytes);
    const entry = this.contracts.get(ref.id, ref.version);
    if (!entry || !toolAllowed(entry.tool.definition, policy)) throw new Error('tool_unavailable');
    if (entry.tool.availability === 'stored_only') throw new Error('tool_connection_required');
    const bytes = new TextEncoder().encode(JSON.stringify(entry.tool.definition)).length;
    const card = this.card(entry.tool.definition);
    return bytes > limit ? { status: 'too_large' as const, card, byteLength: bytes } :
      { status: 'available' as const, card, byteLength: bytes, definition: structuredClone(entry.tool.definition) };
  }
}
