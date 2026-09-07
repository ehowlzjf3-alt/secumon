import { join } from 'node:path';
import { newWork } from '../application/new-work.js';
import type { CommitRequest, StateRepository } from '../application/ports.js';
import type { ArtifactRef, Attempt, Delivery, ModelCall, WorkState } from '../domain/model.js';
import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';
import { FileJournalStateRepository } from '../infrastructure/file-journal-state.js';

export const adapters = ['sqlite', 'file-journal'] as const;
export type Adapter = typeof adapters[number];
export function openRepository(adapter: Adapter, directory: string): StateRepository {
  return adapter === 'sqlite' ? new SqliteStateRepository(join(directory, 'state.sqlite')) : new FileJournalStateRepository(join(directory, 'journal'));
}
export function initial(id = 'work-1'): WorkState {
  return newWork({ id, now: 1000,
    goal: { revision: 1, description: 'Compare synthetic records', scope: 'fixture', mode: 'auto', criteria: [
      { id: 'criterion', description: 'Original record available', key: 'available', operator: 'equals', equals: true, minIndependentSources: 1, requireCompleteCoverage: true },
    ] },
    policy: { tenantId: 'tenant-a', principalId: 'person-a', allowedTools: ['fixture.read'], allowedLabels: ['synthetic'], allowedDestinations: ['local'], allowWrites: false },
    limits: { toolCalls: 10, modelCalls: 5, tokens: 10000, replans: 5, wallTimeMs: 60000 },
  });
}
export function delivery(workId = 'work-1', id = 'ack'): Delivery {
  return { id, workId, goalRevision: 1, destination: 'local', kind: 'ack', text: '요청을 받았습니다.', status: 'pending', externalId: null, context: null, dispatch: null };
}
export function command(next: WorkState, commandId: string, deliveries: Delivery[] = []): CommitRequest {
  return { workId: next.id, expectedRevision: next.revision - 1, commandId, commandDigest: `digest:${commandId}`, next,
    events: [{ type: 'state_changed', at: next.updatedAt, data: { status: next.status, marker: commandId } }], deliveries };
}
export function advance(state: WorkState, statusReason = 'advanced'): WorkState {
  return { ...structuredClone(state), revision: state.revision + 1, updatedAt: state.updatedAt + 1, statusReason };
}
export function artifact(): ArtifactRef {
  return { id: 'synthetic-input', sha256: 'a'.repeat(64), byteLength: 1, mediaType: 'application/json', tenantId: 'tenant-a', labels: ['synthetic'] };
}
export function attempt(status: Attempt['status'], leaseUntil = 2000): Attempt {
  return { id: 'attempt', taskId: 'task', planRevision: 1, goalRevision: 1, toolId: 'fixture.read', toolVersion: '1', inputDigest: 'input',
    scope: 'fixture', effect: 'read', effectState: 'none', status, owner: 'worker', leaseUntil, startedAt: 1000, finishedAt: null,
    resultId: null, resultArtifact: null, adopted: false, error: null };
}
export function modelCall(status: ModelCall['status'], leaseUntil = 2000, expired = false): ModelCall {
  return { id: 'model-call', provider: 'synthetic', model: 'stub', adapterRevision: '1', destination: 'local', owner: 'worker',
    goalRevision: 1, baseStateRevision: 1, basePlanRevision: 0, semanticDigest: 'semantic', inputArtifact: artifact(), replyArtifact: null,
    inputEstimate: 1, maxOutputTokens: 10, tokenReservation: 11, inputTokens: null, outputTokens: null, usageStatus: 'reserved',
    status, startedAt: 1000, leaseUntil, finishedAt: null, expired, outcome: null, reason: 'synthetic boundary' };
}
export async function snapshot(repository: StateRepository, workId: string, commandIds: string[]) {
  return { state: await repository.get(workId), events: await repository.events(workId, 0), deliveries: await repository.deliveries(workId),
    receipts: Object.fromEntries(await Promise.all(commandIds.map(async id => [id, await repository.receipt(workId, id)]))) };
}
export type WorkerRequest = { operation: 'commit'; request: CommitRequest; crashAfterCommit?: boolean } |
  { operation: 'read'; workId: string; commandIds: string[] };
