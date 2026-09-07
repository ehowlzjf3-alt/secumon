import { z } from 'zod';
import type { MissionEventSource } from '../application/mission-contracts.js';
import type { A2aPeer } from '../application/a2a-contracts.js';
import { asJson } from '../application/plan-validator.js';
import { Sha256Digester } from './digest.js';
import { JsonSchema } from '../application/contracts.js';
import type { Json } from '../domain/model.js';

/** A host-bound observation callback. Registration does not grant its destination or data labels. */
export function observationMissionSource(source: { id: string; resourceId: string; destination: string; labels: readonly string[];
  read(input: { signal: AbortSignal; authorize: () => Promise<void> }): Promise<{ version: string; body: Json }> }): MissionEventSource {
  const { id, resourceId, destination, labels, read } = source;
  if (![id, resourceId, destination].every(value => typeof value === 'string' && value.length > 0 && value.length <= 160) ||
    !Array.isArray(labels) || labels.some(value => typeof value !== 'string' || !value) || typeof read !== 'function') throw new Error('mission_source_invalid');
  const readBound = read.bind(source), digester = new Sha256Digester();
  const schema = z.strictObject({ version: z.string().min(1).max(256), body: JsonSchema });
  return Object.freeze({ id, destination, labels: Object.freeze([...labels]), async poll(request: Parameters<MissionEventSource['poll']>[0]) {
    if (request.resourceId !== resourceId) throw new Error('mission_resource_unavailable');
    request.signal.throwIfAborted(); await request.authorize(); request.signal.throwIfAborted();
    const observation = schema.parse(await readBound({ signal: request.signal, authorize: request.authorize }));
    await request.authorize(); request.signal.throwIfAborted();
    const snapshotDigest = digester.digest(asJson(observation));
    if (snapshotDigest === request.snapshotDigest) return { cursor: request.cursor, snapshotDigest, events: [] };
    return { cursor: request.cursor + 1, snapshotDigest, events: [{ id: `observation:${snapshotDigest}`, kind: 'observation' as const,
      referenceId: resourceId, occurredAt: 0, body: asJson({ kind: 'unreviewed_observation', ...observation }) }] };
  } });
}

/** Host-selected timer. One due event per poll, including after restart; no catch-up fan-out. */
export function scheduledMissionSource(input: { id: string; resourceId: string; firstAt: number; intervalMs: number }): MissionEventSource {
  const options = z.strictObject({ id: z.string().min(1).max(160), resourceId: z.string().min(1).max(160),
    firstAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), intervalMs: z.number().int().min(1000).max(86400000) }).parse(input);
  return Object.freeze({ id: options.id, destination: 'local', labels: Object.freeze([] as string[]), async poll(request: Parameters<MissionEventSource['poll']>[0]) {
    request.signal.throwIfAborted(); await request.authorize(); request.signal.throwIfAborted();
    if (request.resourceId !== options.resourceId) throw new Error('mission_resource_unavailable');
    if (request.now < options.firstAt) return { cursor: request.cursor, snapshotDigest: null, events: [] };
    const due = Math.floor((request.now - options.firstAt) / options.intervalMs) + 1;
    if (due <= request.cursor) return { cursor: request.cursor, snapshotDigest: null, events: [] };
    return { cursor: due, snapshotDigest: null, events: [{ id: `schedule:${due}`, kind: 'schedule' as const,
      referenceId: options.resourceId, occurredAt: options.firstAt + (due - 1) * options.intervalMs,
      body: asJson({ kind: 'scheduled_observation', due, skippedIntervals: Math.max(0, due - request.cursor - 1) }) }] };
  } });
}

/** Polls a host-selected remote task. Its content remains an unreviewed external reply. */
export function a2aReplyMissionSource(peer: A2aPeer, sourceId = `${peer.id}-replies`): MissionEventSource {
  const digester = new Sha256Digester(), get = peer.get.bind(peer);
  return Object.freeze({ id: sourceId, destination: peer.destination, labels: Object.freeze([...peer.labels]), async poll(request: Parameters<MissionEventSource['poll']>[0]) {
    const task = await get(request.resourceId, { requestId: digester.digest(asJson({ sourceId, resourceId: request.resourceId, cursor: request.cursor })),
      signal: request.signal, authorize: request.authorize });
    const snapshotDigest = digester.digest(asJson(task));
    if (snapshotDigest === request.snapshotDigest) return { cursor: request.cursor, snapshotDigest, events: [] };
    return { cursor: request.cursor + 1, snapshotDigest, events: [{ id: `reply:${snapshotDigest}`, kind: 'reply' as const,
      referenceId: task.id, occurredAt: task.status.timestamp ? Date.parse(task.status.timestamp) : 0, body: asJson({ kind: 'unreviewed_a2a_task', task }) }] };
  } });
}
