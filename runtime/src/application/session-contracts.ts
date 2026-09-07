import { z } from 'zod';
import type { SessionContext } from '../domain/session.js';
import { AppliedSessionInputSchema, SessionEntrySchema, SessionHeadSchema } from './session-base-contracts.js';
import { SessionSummaryViewSchema } from './session-compact-contracts.js';
export { AppliedSessionInputSchema, SessionEntrySchema, SessionHeadSchema, SessionScopeSchema } from './session-base-contracts.js';

const common = { basis: AppliedSessionInputSchema, head: SessionHeadSchema,
  interpretation: z.literal('conversation_history_not_verified_evidence'), entries: z.array(SessionEntrySchema).max(256) };
export const SessionContextSchema: z.ZodType<SessionContext> = z.discriminatedUnion('schemaVersion', [
  z.strictObject({ ...common, schemaVersion: z.literal(1) }),
  z.strictObject({ ...common, schemaVersion: z.literal(2), summary: SessionSummaryViewSchema }),
]);
