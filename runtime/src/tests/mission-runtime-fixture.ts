import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MissionRuntime } from '../application/mission-runtime.js';
import { MissionEventSchema, MissionRuleSchema, type MissionEventSource, type MissionRule, type MissionPage } from '../application/mission-contracts.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { createExecutionAuthority } from '../application/execution-authority.js';
import { asJson } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FileJournalStateRepository, type JournalOptions } from '../infrastructure/file-journal-state.js';
import { LocalChannel } from '../infrastructure/local-channel.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock, FixtureReadTool, ScriptedPlanner, SequenceIds } from '../infrastructure/fakes.js';
import type { WorkState } from '../domain/model.js';
import { initial, openRepository } from './state-conformance-helpers.js';

export const rule = (id = 'observations', overrides: Partial<MissionRule> = {}): MissionRule => ({ id, sourceId: id, resourceId: `resource-${id}`,
  pollIntervalMs: 1000, maxResumes: 4, maxIdlePolls: 4, maxNoProgress: 3, ...overrides });
export const event = (id = 'event-one', occurredAt = 1100) => ({ id, kind: 'observation' as const, referenceId: 'original-reference', occurredAt,
  body: asJson({ kind: 'unreviewed_observation', value: 'original body' }) });
export function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
export async function bounded<T>(pending: Promise<T>, milliseconds = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('mission_fixture_deadline')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
type Poll = MissionEventSource['poll'];
// This parses assertion fields; the product separately validates its complete checkpoint schema.
const checkpointView = z.object({ schemaVersion: z.literal(1), workId: z.string(), createdAt: z.number(), rule: MissionRuleSchema,
  goalRevision: z.number(), generation: z.number(), cursor: z.number(), snapshotDigest: z.string().nullable(), nextPollAt: z.number(),
  idlePolls: z.number(), noProgress: z.number(), resumes: z.number(), pendingRun: z.boolean(), resumeAt: z.number(),
  claim: z.object({ owner: z.string(), until: z.number() }).nullable(), status: z.enum(['active', 'closed']), reason: z.string().nullable(),
  seen: z.array(z.object({ id: z.string(), digest: z.string() })), events: z.array(MissionEventSchema) });

/** The same C01 repository/artifact/FakeClock primitives as board-wake; real isolated session intake, no profile or HOME writes. */
export async function missionFixture(t: TestContext, sourceIds = ['observations'], options: { stateBackend?: 'sqlite' | 'file-journal'; journalOptions?: JournalOptions } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mission-runtime-'));
  const openState = () => options.stateBackend === 'file-journal' ? new FileJournalStateRepository(join(directory, 'journal'), options.journalOptions) : openRepository('sqlite', directory);
  let state = openState(), channel = new LocalChannel(join(directory, 'channel.sqlite'), 'mission-agent');
  const artifacts = new FileArtifactStore(join(directory, 'artifacts')), clock = new FakeClock(1100), ids = new SequenceIds(), digester = new Sha256Digester();
  const template = initial(), actor = { ...template.policy }, lifetime = new AbortController(), host = new AbortController();
  const authority = createExecutionAuthority({ actor, scope: template.goal.scope, signal: host.signal });
  const sourceCalls: { sourceId: string; resourceId: string; cursor: number; snapshotDigest: string | null; now: number; signal: AbortSignal }[] = [];
  const handlers = new Map<string, Poll>();
  const sources: MissionEventSource[] = sourceIds.map(id => ({ id, destination: 'local', labels: ['synthetic'], async poll(input) {
    sourceCalls.push({ sourceId: id, resourceId: input.resourceId, cursor: input.cursor, snapshotDigest: input.snapshotDigest, now: input.now, signal: input.signal });
    await input.authorize(); return (handlers.get(id) ?? (async () => ({ cursor: input.cursor, snapshotDigest: input.snapshotDigest, events: [] })))(input);
  } }));
  const original = await artifacts.put(new TextEncoder().encode('original independent record'), { tenantId: actor.tenantId, labels: ['synthetic'], mediaType: 'text/plain' });
  const tool = new FixtureReadTool([{ id: 'independent', tenantId: actor.tenantId, scope: template.goal.scope, sourceId: 'fixture.read', lineageId: 'original-record',
    locator: 'fixture://independent', observedAt: 1000, recordedAt: 1001, labels: ['synthetic'], coverage: 'complete', status: 'accepted',
    supersedes: [], derivedFrom: [], facts: { available: true }, artifact: original }]);
  const planner = new ScriptedPlanner([]);
  const compose = () => composeRuntime({ services: { state, artifacts, sink: channel, clock, ids, digester, tools: [tool], planner },
    session: { repository: channel.sessions!, agentId: 'mission-agent' }, executionAuthority: authority,
    schemas: new AjvSchemas(), guidanceSource: { list: async () => [], read: async () => { throw new Error('unused_guidance'); } },
    owner: 'mission-fixture', enablePlanning: false });
  let bundle = await compose();
  const makeDriver = () => new MissionRuntime({ services: bundle.services, actor, agentId: 'mission-agent', scope: template.goal.scope, signal: lifetime.signal, sources });
  let missions = makeDriver(); bundle.services.notifications = missions;
  const session = await bundle.sessions!.open(actor, { channel: 'test', conversationId: 'mission-conversation' });
  const accepted = await bundle.sessions!.accept(actor, { sessionId: session.scope.sessionId, rawText: 'Observe events and inspect the independent record.', request: {
    messageId: 'mission-input', goal: template.goal, policy: template.policy, limits: { ...template.budget.limits, tokens: 1000000 }, completionRequiresDelivery: false,
    binding: { tenantId: actor.tenantId, principalId: actor.principalId, channel: 'test', conversationId: 'mission-conversation', recipientId: actor.principalId, destination: 'local' } } });
  const workId = accepted.workId; let sequence = 0;
  const current = async () => { const value = await state.get(workId); assert.ok(value); return value; };
  const checkpoint = async (selected = rule()) => {
    const work = await current(), subscription = work.subscriptions?.find(value => value.provider === 'mission' && value.resourceId === selected.resourceId); assert.ok(subscription);
    const artifact = work.artifacts.find(value => subscription.checkpointId === `mission:${value.sha256}`); assert.ok(artifact);
    const receipt = await state.receipt(workId, subscription.checkpointId); assert.ok(receipt);
    assert.equal(receipt.digest, digester.digest(asJson({ type: 'mission_checkpoint', data: { subscriptionId: subscription.id, artifact } })));
    assert.deepEqual(receipt.state.subscriptions?.find(value => value.id === subscription.id), subscription);
    assert.ok(receipt.state.artifacts.some(value => digester.digest(asJson(value)) === digester.digest(asJson(artifact))));
    const bytes = await artifacts.get(artifact, work.policy); assert.equal(bytes.byteLength, artifact.byteLength);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    const value = checkpointView.parse(JSON.parse(new TextDecoder().decode(bytes)));
    assert.equal(value.workId, workId); assert.equal(value.createdAt, work.createdAt); assert.deepEqual(value.rule, selected);
    assert.equal(value.cursor, subscription.cursor); return { work, subscription, artifact, receipt, bytes, value };
  };
  const prepareRead = async () => {
    const work = await current(), taskId = `read-${++sequence}`;
    await bundle.runtime.submitPlan(workId, `mission-plan-${sequence}`, { baseStateRevision: work.revision, baseGoalRevision: work.goal.revision,
      basePlanRevision: work.plan?.revision ?? 0, hypotheses: [], reason: 'Explicitly inspect the original after observing the event.',
      tasks: [{ id: taskId, description: 'Read independent original', toolId: 'fixture.read', toolVersion: '1', effect: 'read',
        input: { evidenceIds: ['independent'] }, dependsOn: [], maxAttempts: 1, satisfies: ['criterion'] }] });
    return taskId;
  };
  const close = async () => { bundle.runtime.beginClose(); await bundle.runtime.finishClose(); await state.close(); channel.close(); };
  t.after(async () => { lifetime.abort(); await close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, actor, lifetime, host, clock, artifacts, tool, planner, workId, sourceCalls, sources, current, checkpoint, prepareRead, makeDriver,
    get bundle() { return bundle; }, get missions() { return missions; }, get state() { return state; },
    poll(sourceId: string, handler: Poll) { handlers.set(sourceId, handler); },
    page(sourceId: string, page: MissionPage) { handlers.set(sourceId, async () => structuredClone(page)); },
    async edit(change: (work: WorkState) => void) { return (await transact(bundle.services, workId, `host-edit-${++sequence}`, 'fixture_host_control', {}, change)).state; },
    async reopen() { await close(); state = openState(); channel = new LocalChannel(join(directory, 'channel.sqlite'), 'mission-agent');
      bundle = await compose(); missions = makeDriver(); bundle.services.notifications = missions; },
  };
}
