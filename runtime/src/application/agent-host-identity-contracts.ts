import { z } from 'zod';
import { AgentIdentitySchema, type AgentIdentity } from './agent-profile-contracts.js';

const text = (maximum: number) => z.string().min(1).max(maximum).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const AgentHostDirectoryIdentitySchema = z.strictObject({ volume: text(256), object: text(256) });
export const AgentHostIdentityRecordSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('agent-host-identity-registration'),
  sequence: z.number().int().min(1).max(1024), identity: AgentIdentitySchema,
  rootIdentity: AgentHostDirectoryIdentitySchema, registeredRoot: text(4096), previous: digest.nullable(),
  reason: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('claim') }),
    z.strictObject({ kind: z.literal('restore'), operationId: text(256), backupDigest: digest, originalRoot: text(4096) })]),
  recordedAt: z.number().int().nonnegative(),
}).refine(value => value.sequence === 1 ? value.previous === null && value.reason.kind === 'claim' :
  value.previous !== null && value.reason.kind === 'restore', 'invalid_identity_registration_history');
export const AgentHostIdentityRebindProofSchema = z.strictObject({
  operationId: text(256), backupDigest: digest, originalRoot: text(4096), expectedHeadDigest: digest,
});
export type AgentHostIdentityRecord = z.infer<typeof AgentHostIdentityRecordSchema>;
export type AgentHostIdentityRebindProof = z.infer<typeof AgentHostIdentityRebindProofSchema>;
export interface AgentHostIdentitySubject { readonly root: string; readonly identity: AgentIdentity }
/** Only trusted startup code selects the registry. No per-message/config override. */
export interface AgentHostIdentityOptions {
  readonly registryDirectory?: string | undefined;
  readonly engineDirectories: readonly string[];
}
export interface AgentHostIdentityHead { readonly record: Readonly<AgentHostIdentityRecord>; readonly digest: string }
export interface AgentHostIdentityClaim extends AgentHostIdentityHead { assertCurrent(): void; close(): void }
/** The caller keeps its verified restore/maintenance authority live until publish returns. */
export type AgentHostIdentityRebindPublisher = (proof: AgentHostIdentityRebindProof,
  assertProofCurrent: () => void | Promise<void>) => Promise<void>;
export type WithVerifiedAgentRestore = (publish: AgentHostIdentityRebindPublisher) => Promise<void>;
