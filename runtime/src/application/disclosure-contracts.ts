import { z } from 'zod';
import type { DisclosurePayload, DisclosurePolicy, DisclosureRecord, DisclosureRule } from '../domain/disclosure.js';

const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const scalar = z.union([z.string().max(10000), z.number().finite(), z.boolean(), z.null()]);
const labels = z.array(id).max(1000).refine(values => new Set(values).size === values.length);
export const DisclosureSurfaceSchema = z.enum(['model', 'tool', 'channel', 'summary', 'search', 'log', 'screen', 'artifact', 'a2a']);
export const DisclosurePolicySchema: z.ZodType<DisclosurePolicy> = z.strictObject({ revision: id,
  destinations: z.array(z.strictObject({ destination: id, surfaces: z.array(DisclosureSurfaceSchema).min(1).max(9).refine(values => new Set(values).size === values.length), allowedLabels: labels })).max(100)
    .refine(values => new Set(values.map(value => value.destination)).size === values.length),
  maxReleasesPerWork: count.max(1000), maxReleasedBytesPerWork: count.max(16 * 1024 * 1024) });
const outputKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).refine(value => !['constructor', 'prototype', '__proto__'].includes(value));
export const DisclosureRuleSchema: z.ZodType<DisclosureRule> = z.strictObject({ id, version: id, tenantId: id, principalId: id, scope: id,
  destination: id, surface: DisclosureSurfaceSchema, sourceLabels: labels, releasedLabels: labels.min(1),
  fields: z.array(z.strictObject({ sourceKey: id, outputKey, values: z.array(z.strictObject({ from: scalar, to: scalar })).min(1).max(100)
    .refine(values => new Set(values.map(value => JSON.stringify(value.from))).size === values.length) })).min(1).max(100)
    .refine(fields => new Set(fields.map(field => field.outputKey)).size === fields.length),
  includeCoverage: z.boolean(), maxSources: count.min(1).max(100), maxBytes: count.min(1).max(1024 * 1024) });
export const DisclosurePayloadSchema: z.ZodType<DisclosurePayload> = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('released_observations'),
  observations: z.array(z.strictObject({ source: count.min(1).max(100), basis: z.array(count.min(1).max(100)).min(1).max(100), derived: z.boolean(),
    facts: z.record(outputKey, scalar), coverage: z.enum(['complete', 'partial', 'unknown']).optional() })).min(1).max(100) });
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const DisclosureRecordSchema: z.ZodType<DisclosureRecord> = z.strictObject({ id, requestDigest: digest, policyDigest: digest, ruleId: id, ruleDigest: digest,
  goalRevision: count.min(1), dataGeneration: count, evidenceIds: z.array(id).min(1).max(100), sources: z.array(z.strictObject({ evidenceId: id, digest })).min(1).max(100),
  destination: id, surface: DisclosureSurfaceSchema, labels, payload: DisclosurePayloadSchema, payloadDigest: digest,
  byteLength: count.min(1).max(1024 * 1024), createdAt: count });
export const DisclosureRequestSchema = z.strictObject({ requestId: id, ruleId: id, evidenceIds: z.array(id).min(1).max(100)
  .refine(values => new Set(values).size === values.length) });
