import { z } from 'zod';
import type { PersonalMemoryContext, PersonalMemorySelection } from '../domain/personal-memory.js';
import { KnowledgeDependencySchema, PersonalMemoryRefSchema } from './knowledge-contracts.js';
import { AppliedSessionInputSchema } from './session-base-contracts.js';

const id = z.string().min(1).max(256);
const count = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export { PersonalMemoryRefSchema } from './knowledge-contracts.js';
export const PersonalMemorySelectionSchema: z.ZodType<PersonalMemorySelection> = z.strictObject({ schemaVersion: z.literal(1), selectionId: id,
  basis: AppliedSessionInputSchema, policy: z.strictObject({ allowedLabels: z.array(id).max(10000), allowedDestinations: z.array(id).max(10000) }),
  entries: z.array(z.strictObject({ ref: PersonalMemoryRefSchema, dependency: KnowledgeDependencySchema })).max(5) });
export const PersonalMemoryContextSchema: z.ZodType<PersonalMemoryContext> = z.strictObject({ schemaVersion: z.literal(1), selectionId: id,
  basis: AppliedSessionInputSchema, entries: z.array(z.strictObject({ ref: PersonalMemoryRefSchema, title: z.string().max(1000), body: z.string().max(65536),
    sourceVersions: z.array(id).min(1).max(64) })).max(5), interpretation: z.literal('user_requested_memory_not_verified_evidence') });
export const PersonalMemorySelectSchema = z.strictObject({ commandId: id, expectedGoalRevision: count, expectedStateRevision: count,
  refs: z.array(PersonalMemoryRefSchema).max(5) }).refine(value => new Set(value.refs.map(ref => ref.id)).size === value.refs.length, 'duplicate_memory_reference');
