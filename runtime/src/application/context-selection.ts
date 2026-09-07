import { z } from 'zod';
import type { ContextDecision, ContextItem, ContextMemo, ContextMemoEntry } from '../domain/context.js';

export interface ContextSelectionConfig {
  budgetBytes: number;
  highWatermark?: number;
  lowWatermark?: number;
  minResidentCycles?: number;
  idleCycles?: number;
  forceCompact?: boolean;
}
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(512);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const ItemSchema = z.strictObject({ key: id, kind: z.enum(['tool', 'evidence', 'result', 'guidance', 'attempt']), version: id, digest: hash,
  fullBytes: count, referenceBytes: count, minimum: z.enum(['full', 'reference', 'omitted']), maximum: z.enum(['full', 'reference']).default('full'),
  priority: z.number().finite(), useMarker: id.nullable() }).refine(item => item.minimum !== 'full' || item.maximum === 'full', 'invalid_representation_bounds');
const MemoSchema = z.strictObject({ cycle: count.min(1).max(Number.MAX_SAFE_INTEGER - 1), mode: z.enum(['full', 'compact']), evictions: count, reloads: count,
  entries: z.array(z.strictObject({ key: id, digest: hash, useMarker: id.nullable(), lastUsedCycle: count, admittedCycle: count,
    lastIncludedCycle: count, lastEvictedCycle: count.nullable() })).max(128) });
const ConfigSchema = z.strictObject({ budgetBytes: count, highWatermark: z.number().gt(0).max(1).default(0.9), lowWatermark: z.number().min(0).lt(1).default(0.7),
  minResidentCycles: count.default(2), idleCycles: count.default(3), forceCompact: z.boolean().default(false) })
  .refine(c => c.lowWatermark < c.highWatermark, 'invalid_watermarks');
function parse<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const parsed = schema.safeParse(value); if (!parsed.success) throw new Error(code); return parsed.data;
}
const compareKey = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const minimumRank = { full: 2, reference: 1, omitted: 0 };
function increment(value: number, by: number): number {
  if (by > Number.MAX_SAFE_INTEGER - value) throw new Error('context_invalid_memo');
  return value + by;
}

export function selectContextItems(input: ContextItem[], previous: ContextMemo | null, configuration: ContextSelectionConfig): {
  decisions: ContextDecision[]; memo: ContextMemo; bytes: number;
} {
  const items = parse(z.array(ItemSchema).max(50000), input, 'context_invalid_items');
  const config = parse(ConfigSchema, configuration, 'context_invalid_config');
  const prior = previous === null ? null : parse(MemoSchema, previous, 'context_invalid_memo');
  if (new Set(items.map(i => i.key)).size !== items.length) throw new Error('context_duplicate_item');
  if (prior && (new Set(prior.entries.map(e => e.key)).size !== prior.entries.length || prior.entries.some(e =>
    [e.lastUsedCycle, e.admittedCycle, e.lastIncludedCycle, e.lastEvictedCycle ?? 0].some(cycle => cycle > prior.cycle) ||
    (e.lastIncludedCycle === 0 ? e.admittedCycle !== 0 || e.lastEvictedCycle !== null : e.admittedCycle < 1 || e.admittedCycle > e.lastIncludedCycle) ||
    (e.lastIncludedCycle === prior.cycle && e.lastEvictedCycle === prior.cycle)))) throw new Error('context_invalid_memo');
  const cycle = (prior?.cycle ?? 0) + 1;
  const currentByKey = new Map(items.map(item => [item.key, item]));
  const oldByKey = new Map(prior?.entries.map(entry => [entry.key, entry]) ?? []);
  const ranked = items.map(item => {
    const old = oldByKey.get(item.key); const entry = old?.digest === item.digest ? old : undefined;
    const used = item.useMarker !== null && item.useMarker !== entry?.useMarker;
    const lastUsedCycle = used ? cycle : entry?.lastUsedCycle ?? 0;
    const resident = Boolean(entry && entry.lastIncludedCycle === prior?.cycle);
    const held = resident && cycle - entry!.admittedCycle < config.minResidentCycles;
    const age = cycle - (lastUsedCycle || entry?.admittedCycle || cycle);
    const idle = age > config.idleCycles;
    const cooled = entry?.lastEvictedCycle === null || entry?.lastEvictedCycle === undefined || cycle - entry.lastEvictedCycle >= config.minResidentCycles;
    const previouslyFull = Boolean(entry?.lastIncludedCycle);
    const wanted = item.minimum === 'full' || used || held || !entry || (!idle && (resident || !previouslyFull || cooled && lastUsedCycle > 0));
    return { item, entry, used, lastUsedCycle, resident, held, idle, wanted };
  }).sort((a, b) => minimumRank[b.item.minimum] - minimumRank[a.item.minimum] || b.item.priority - a.item.priority ||
    Number(b.used) - Number(a.used) || b.lastUsedCycle - a.lastUsedCycle || Number(b.resident) - Number(a.resident) || compareKey(a.item.key, b.item.key));
  const totalMaximum = items.reduce((total, item) => total + BigInt(item.maximum === 'reference' ? item.referenceBytes : item.fullBytes), 0n);
  const high = Math.floor(config.budgetBytes * config.highWatermark); const low = Math.floor(config.budgetBytes * config.lowWatermark);
  const mode: ContextMemo['mode'] = config.forceCompact || totalMaximum > BigInt(high) || prior?.mode === 'compact' && totalMaximum > BigInt(low) ? 'compact' : 'full';
  let bytes = 0;
  const decisions: ContextDecision[] = ranked.map(({ item }) => {
    const full = item.maximum === 'full' && (item.minimum === 'full' || item.minimum === 'reference' && item.fullBytes <= item.referenceBytes);
    const representation = full ? 'full' : item.minimum;
    const size = representation === 'full' ? item.fullBytes : representation === 'reference' ? item.referenceBytes : 0;
    if (size > config.budgetBytes - bytes) throw new Error('context_required_overflow');
    bytes += size;
    return { key: item.key, kind: item.kind, version: item.version, digest: item.digest, representation,
      reason: full ? 'required_full' : representation === 'reference' ? 'required_reference' : 'unused', bytes: size };
  });
  const target = Math.max(bytes, mode === 'compact' ? low : config.budgetBytes);
  for (let i = 0; i < ranked.length; i++) {
    const candidate = ranked[i]!; const item = candidate.item; const decision = decisions[i]!;
    if (decision.representation === 'full') continue;
    if (!candidate.wanted) { if (decision.representation === 'omitted') decision.reason = candidate.idle ? 'idle' : 'reload_deferred'; continue; }
    const ceiling = candidate.held ? config.budgetBytes : target;
    const fullDelta = item.fullBytes - decision.bytes;
    if (item.maximum === 'full' && fullDelta <= ceiling - bytes) {
      bytes += fullDelta; decision.representation = 'full'; decision.bytes = item.fullBytes;
      decision.reason = candidate.used ? 'used' : candidate.held ? 'minimum_residency' : candidate.resident ? 'resident' : 'selected';
    } else if (decision.representation === 'omitted' && item.referenceBytes <= target - bytes) {
      bytes += item.referenceBytes; decision.representation = 'reference'; decision.bytes = item.referenceBytes; decision.reason = 'budget_reference';
    } else if (decision.representation === 'omitted') decision.reason = 'budget_omitted';
  }
  let evictions = prior?.evictions ?? 0; let reloads = prior?.reloads ?? 0;
  for (const entry of prior?.entries ?? []) {
    if (entry.lastIncludedCycle === prior!.cycle && currentByKey.get(entry.key)?.digest !== entry.digest) evictions = increment(evictions, 1);
  }
  const entries = ranked.map((candidate, i) => {
    const { item, entry, resident, lastUsedCycle } = candidate; const full = decisions[i]!.representation === 'full';
    if (resident && !full) evictions = increment(evictions, 1);
    if (full && !resident && (entry?.lastIncludedCycle ?? 0) > 0) reloads = increment(reloads, 1);
    const memo: ContextMemoEntry = { key: item.key, digest: item.digest, useMarker: item.useMarker, lastUsedCycle,
      admittedCycle: full && !resident ? cycle : entry?.admittedCycle ?? 0,
      lastIncludedCycle: full ? cycle : entry?.lastIncludedCycle ?? 0,
      lastEvictedCycle: resident && !full ? cycle : entry?.lastEvictedCycle ?? null };
    return { memo, full, minimum: minimumRank[item.minimum], priority: item.priority };
  }).sort((a, b) => Number(b.full) - Number(a.full) || b.minimum - a.minimum || b.memo.lastUsedCycle - a.memo.lastUsedCycle ||
    (b.memo.lastEvictedCycle ?? 0) - (a.memo.lastEvictedCycle ?? 0) || b.priority - a.priority || compareKey(a.memo.key, b.memo.key))
    .slice(0, 128).map(({ memo }) => memo).sort((a, b) => compareKey(a.key, b.key));
  return { decisions, memo: { cycle, mode, entries, evictions, reloads }, bytes };
}
