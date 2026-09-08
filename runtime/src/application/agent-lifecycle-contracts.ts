import { z } from 'zod';
import { EngineExtensionSupportSchema } from './engine-extension-contracts.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(4096).refine(value => !value.includes('\\') && !value.startsWith('/') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
export const LifecycleEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('directory'), path }),
  z.strictObject({ kind: z.literal('file'), path, bytes: z.number().int().nonnegative(), sha256: digest, executable: z.boolean() }),
]);
export const EngineReleaseSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('secumon-engine-release'), version: z.string().min(1).max(100),
  node: z.literal('>=24.20.0 <25'), platform: z.string(), arch: z.string(),
  compatibility: z.strictObject({ config: z.array(z.number().int()), state: z.array(z.number().int()), knowledge: z.array(z.number().int()), session: z.array(z.number().int()), journal: z.array(z.number().int()), documents: z.array(z.number().int()),
    extensions: EngineExtensionSupportSchema.optional(),
    postgres: z.strictObject({ installation: z.array(z.number().int().positive()).min(1), binding: z.array(z.number().int().positive()).min(1),
      state: z.array(z.number().int().positive()).min(1), knowledge: z.array(z.number().int().positive()).min(1), channel: z.array(z.number().int().positive()).min(1) }).optional(),
  }),
  entries: z.array(LifecycleEntrySchema).max(100000), digest,
});
export const EnginePinSchema = z.strictObject({
  schemaVersion: z.literal(1), sequence: z.number().int().positive(), agentId: z.uuid(),
  releaseDigest: digest, engineDirectory: z.string().min(1), version: z.string(),
  previous: digest.nullable(), backupDigest: digest.nullable(), createdAt: z.number().int().nonnegative(),
});
export const AgentBackupSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('secumon-agent-backup'), agentId: z.uuid(), originalRoot: z.string().min(1),
  createdAt: z.number().int().nonnegative(), releaseDigest: digest.nullable(),
  entries: z.array(LifecycleEntrySchema).max(100000), digest,
});
export const AGENT_LOCAL_RESTORE_COMPLETION = '.secumon-local-restore-complete.json';
export const AgentLocalRestoreMarkerSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('secumon-local-restore'),
  operationId: z.string().regex(/^local:[a-f0-9]{64}$/), agentId: z.uuid(), backupDigest: digest,
  originalRoot: z.string().min(1),
});
export type LifecycleEntry = z.infer<typeof LifecycleEntrySchema>;
export type EngineRelease = z.infer<typeof EngineReleaseSchema>;
export type EnginePin = z.infer<typeof EnginePinSchema>;
export type AgentBackup = z.infer<typeof AgentBackupSchema>;
export class AgentLifecycleError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) { super(code, options); }
}
