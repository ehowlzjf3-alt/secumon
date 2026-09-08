import assert from 'node:assert/strict';
import { openSync, writeFileSync, fsyncSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ArtifactSchema, WorkStateSchema } from '../application/contracts.js';
import { PeerIdentitySchema, PeerRequestSchema, PeerTicketSchema, type PeerTicket } from '../application/peer-contracts.js';
import { asJson } from '../application/plan-validator.js';
import type { AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { peerDeploymentFixture, type PeerDeploymentOptions } from './peer-deployment-entry-fixture.js';

const IntentSchema = z.strictObject({ peerId: z.string(), peer: PeerIdentitySchema, destination: z.string(), request: PeerRequestSchema });
export const StoppedSchema = z.strictObject({ schemaVersion: z.literal(1), pid: z.number().int().positive(),
  caller: WorkStateSchema, receiver: WorkStateSchema, ticket: PeerTicketSchema,
  requestArtifact: ArtifactSchema, requestBytes: z.string(), requestReceiptDigest: z.string(),
  receiverInputDigest: z.string(), receiverHistoryDigest: z.string() });
export const RecoveredSchema = z.strictObject({ schemaVersion: z.literal(1), pid: z.number().int().positive(),
  callerId: z.string(), receiverId: z.string(), ticket: PeerTicketSchema, oldAttemptId: z.string(), resumeAttemptId: z.string(),
  callerModels: z.literal(1), callerTools: z.literal(2), receiverModels: z.literal(1), receiverTools: z.literal(0),
  receiverResultDeliveries: z.literal(1), callerCompleted: z.literal(false), oldLeasesPreserved: z.literal(true) });
export function crashProfiles(directory: string, existing: boolean, onAccepted?: PeerDeploymentOptions['onAccepted']) {
  const cleanups: (() => Promise<void>)[] = [];
  const fixture = peerDeploymentFixture({ after: callback => { cleanups.push(callback); } }, { directory, existing, ...(onAccepted ? { onAccepted } : {}) });
  return { ...fixture, async close() {
    const errors: unknown[] = []; for (const callback of cleanups) try { await callback(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'peer_acceptance_cleanup_failed');
  } };
}
export async function retainedRequest(profile: AgentTurnProfile, workId: string) {
  const state = await profile.runtime.state(workId), events = (await profile.services.state.events(workId, 0)).filter(value => value.type === 'peer_requested');
  assert.equal(events.length, 1); const event = events[0]!;
  const payload = z.strictObject({ payload: z.strictObject({ artifact: ArtifactSchema, value: IntentSchema }) }).parse(event.data).payload;
  const receipt = await profile.services.state.receipt(workId, event.commandId); assert.ok(receipt);
  const digest = (value: unknown) => profile.services.digester.digest(asJson(value));
  assert.equal(event.commandId, `peer-request:${payload.value.request.id}`); assert.equal(event.revision, receipt.state.revision);
  assert.equal(receipt.digest, digest({ type: event.type, data: payload }));
  assert.ok(receipt.state.artifacts.some(value => digest(value) === digest(payload.artifact)));
  const bytes = await profile.services.artifacts.get(payload.artifact, state.policy), intent = IntentSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  assert.equal(digest(intent), digest(payload.value)); assert.equal(intent.request.from.workId, state.id);
  assert.equal(intent.request.from.agentId, profile.agentId); assert.equal(intent.request.from.principalId, state.policy.principalId);
  assert.equal(intent.request.from.goalRevision, state.goal.revision); assert.equal(intent.request.policyDigest, digest(state.policy));
  assert.equal(intent.request.deadlineAt, state.deadlineAt);
  return { state, event, receipt, artifact: payload.artifact, bytes, intent };
}
export async function receiverInput(profile: AgentTurnProfile, ticket: PeerTicket) {
  const state = await profile.runtime.state(ticket.workId), scope = state.conversation!.session!.scope;
  assert.equal(scope.agentId, profile.agentId); assert.equal(scope.sessionId, ticket.sessionId);
  const input = await profile.sessions.repository.input(scope, ticket.requestId); assert.ok(input);
  assert.equal(input.kind, 'work'); assert.equal(input.workId, state.id); assert.equal(input.status, 'applied');
  return { state, input, history: await profile.sessions.history(profile.actor, ticket.sessionId, profile.policy, { limit: 100 }) };
}
/** Private test evidence, never authority to restore a request or publish a receipt. */
export function publishCrashEvidence(directory: string, name: 'stopped' | 'recovered', value: unknown) {
  const bytes = JSON.stringify(value); assert.ok(Buffer.byteLength(bytes) <= 131072);
  const fd = openSync(join(directory, `${name}.json`), 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(directory, 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
}
export function readCrashEvidence(directory: string, name: 'stopped' | 'recovered'): unknown {
  return JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'));
}
