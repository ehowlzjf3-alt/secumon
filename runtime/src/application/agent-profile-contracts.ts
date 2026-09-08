import { z } from 'zod';
import { EnginePinSchema } from './agent-lifecycle-contracts.js';

const text = (maximum: number) => z.string().trim().max(maximum).refine(value => !/[\x00-\x1f\x7f]/.test(value));
export const AgentIdentitySchema = z.strictObject({
  schemaVersion: z.literal(1), agentId: z.uuid(), createdAt: z.number().int().nonnegative(),
});
/** Non-secret host registration. Unselected purposes retain their local storage setting. */
export const AgentPostgresSelectionSchema = z.strictObject({ storeId: z.uuid(), registrationId: z.uuid(),
  purposes: z.array(z.enum(['state', 'knowledge', 'channel'])).min(1).max(3).refine(values => new Set(values).size === values.length) });
export type AgentPostgresSelection = z.infer<typeof AgentPostgresSelectionSchema>;
export const AgentConfigV1Schema = z.strictObject({
  schemaVersion: z.literal(1), identity: AgentIdentitySchema,
  name: text(120).min(1), purpose: text(4000),
  storage: z.strictObject({ state: z.enum(['sqlite', 'file-journal']), memory: z.literal('sqlite'), artifacts: z.literal('files'), postgres: AgentPostgresSelectionSchema.optional() }),
  model: z.union([z.null(), z.strictObject({ profile: text(120).min(1) })]),
  features: z.strictObject({ board: z.boolean(), archive: z.boolean(), peers: z.boolean().optional(), missions: z.boolean().optional(), a2a: z.boolean().optional() }),
  skills: z.strictObject({ mode: z.enum(['off', 'explicit', 'on-demand']) }),
});
export const AgentDocumentMemorySchema = z.strictObject({ backend: z.literal('documents'), storeId: z.uuid() });
export const AgentConfigV2Schema = AgentConfigV1Schema.extend({ schemaVersion: z.literal(2),
  storage: z.strictObject({ state: z.enum(['sqlite', 'file-journal']), memory: z.literal('sqlite'), artifacts: z.literal('files'),
    personalMemory: AgentDocumentMemorySchema, postgres: AgentPostgresSelectionSchema.optional() }) });
export const AgentConfigSchema = z.discriminatedUnion('schemaVersion', [AgentConfigV1Schema, AgentConfigV2Schema]);
export const AgentSetupOptionsSchema = z.strictObject({ name: text(120).min(1).optional(), purpose: text(4000).optional(),
  repair: z.boolean().default(false), personalMemory: z.enum(['sqlite', 'documents']).optional(),
  stateBackend: z.enum(['sqlite', 'file-journal']).optional(), postgres: AgentPostgresSelectionSchema.optional() });
export const AgentSetupReceiptSchema = z.strictObject({ schemaVersion: z.literal(1), agentId: z.uuid() });
export const AgentCloneOptionsSchema = z.strictObject({ name: text(120).min(1).optional(), resume: z.boolean().default(false) });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const AgentCloneEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ path: z.string().min(1).max(4096), kind: z.literal('directory') }),
  z.strictObject({ path: z.string().min(1).max(4096), kind: z.literal('file'), bytes: z.number().int().nonnegative().max(4 * 1024 * 1024), sha256: digest, executable: z.boolean() }),
]);
export const AgentSetupOperationV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('initialize'), operationId: z.uuid(), identity: AgentIdentitySchema,
    stateBackend: z.enum(['sqlite', 'file-journal']).optional(), postgres: AgentPostgresSelectionSchema.optional() }),
  z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('clone'), operationId: z.uuid(), identity: AgentIdentitySchema,
    config: AgentConfigV1Schema, source: z.strictObject({ identity: AgentIdentitySchema, configDigest: digest, skillsDigest: digest }),
    entries: z.array(AgentCloneEntrySchema).max(512), manifestDigest: digest }),
]);
export const AgentSetupOperationV2Schema = z.discriminatedUnion('kind', [
  z.strictObject({ schemaVersion: z.literal(2), kind: z.literal('initialize'), operationId: z.uuid(), identity: AgentIdentitySchema,
    personalMemory: AgentDocumentMemorySchema, stateBackend: z.enum(['sqlite', 'file-journal']).optional(), postgres: AgentPostgresSelectionSchema.optional() }),
  z.strictObject({ schemaVersion: z.literal(2), kind: z.literal('clone'), operationId: z.uuid(), identity: AgentIdentitySchema,
    config: AgentConfigV2Schema, source: z.strictObject({ identity: AgentIdentitySchema, configDigest: digest, skillsDigest: digest }),
    entries: z.array(AgentCloneEntrySchema).max(512), manifestDigest: digest }),
]);
export const AgentInitialEngineSchema = z.strictObject({
  pin: EnginePinSchema.refine(pin => pin.sequence === 1 && pin.previous === null && pin.backupDigest === null,
    { message: 'initial_engine_pin_invalid' }),
  registrationDigest: digest,
});
export const AgentSetupOperationV3Schema = z.strictObject({
  schemaVersion: z.literal(3), kind: z.literal('initialize'), operationId: z.uuid(), identity: AgentIdentitySchema,
  personalMemory: AgentDocumentMemorySchema.nullable(), stateBackend: z.enum(['sqlite', 'file-journal']).optional(),
  postgres: AgentPostgresSelectionSchema.optional(), initialEngine: AgentInitialEngineSchema,
}).refine(operation => operation.initialEngine.pin.agentId === operation.identity.agentId,
  { message: 'initial_engine_owner_mismatch', path: ['initialEngine', 'pin', 'agentId'] });
export const AgentSetupOperationSchema = z.union([AgentSetupOperationV1Schema, AgentSetupOperationV2Schema, AgentSetupOperationV3Schema]);
export const AgentCloneSetupSchema = z.strictObject({ schemaVersion: z.literal(2), agentId: z.uuid(), operationId: z.uuid(), manifestDigest: digest });
export const AgentInitialSetupReceiptSchema = z.strictObject({ schemaVersion: z.literal(3), agentId: z.uuid(), operationId: z.uuid(), initialPinDigest: digest });
export const AgentCloneCompletionSchema = z.strictObject({ schemaVersion: z.literal(1), agentId: z.uuid(), operationId: z.uuid(), manifestDigest: digest });
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgentSetupOptions = z.input<typeof AgentSetupOptionsSchema>;
export type AgentCloneOptions = z.input<typeof AgentCloneOptionsSchema>;
export type AgentCloneEntry = z.infer<typeof AgentCloneEntrySchema>;
export type AgentSetupOperation = z.infer<typeof AgentSetupOperationSchema>;
export type AgentInitialEngine = z.infer<typeof AgentInitialEngineSchema>;
export type AgentInitialSetupReceipt = z.infer<typeof AgentInitialSetupReceiptSchema>;
export type AgentCloneOperation = Extract<AgentSetupOperation, { kind: 'clone' }>;
export interface AgentPaths { root: string; metadata: string; state: string; memory: string; artifacts: string; skills: string; workspace: string }
export type AgentPersonalMemorySelection = { backend: 'sqlite' } | { backend: 'documents'; storeId: string } | { backend: 'postgres'; storeId: string; registrationId: string };
export interface AgentMemoryMigrationStatus { operationId: string; phase: 'pending' | 'activated' }
export interface AgentPostgresMigrationStatus { operationId: string; phase: 'pending' | 'activated'; selection: AgentPostgresSelection; snapshotDigest: string }
export type AgentProfileStatus =
  | { status: 'uninitialized'; root: string }
  | { status: 'incomplete'; root: string; agentId: string | null; missing: string[]; recoverable: boolean; recovery?: 'clone' }
  | { status: 'ready'; root: string; identity: AgentIdentity; config: AgentConfig; paths: AgentPaths; modelReady: false;
      setupSchemaVersion?: 3;
      effectivePersonalMemory: AgentPersonalMemorySelection; personalMemoryMigration?: AgentMemoryMigrationStatus; postgresMigration?: AgentPostgresMigrationStatus };
export class AgentProfileError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) { super(code, options); }
}

/** Storage and setup contract; no model invocation or implicit work submission. */
export interface AgentProfileStore {
  /** Host-owned engine locations excluded from agent and identity-registry writes. */
  readonly engineDirectories?: readonly string[];
  /** Optional host version gate, checked before opening physical stores. */
  assertRuntimeCompatible?(directory: string): void;
  inspect(directory: string): AgentProfileStatus;
  initialize(directory: string, options?: AgentSetupOptions): Extract<AgentProfileStatus, { status: 'ready' }>;
  clone(source: string, destination: string, options?: AgentCloneOptions): Extract<AgentProfileStatus, { status: 'ready' }>;
}
