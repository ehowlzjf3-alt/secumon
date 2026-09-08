import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ArtifactSchema, WorkStateSchema } from '../application/contracts.js';
import { MissionEventSchema, MissionRuleSchema } from '../application/mission-contracts.js';
import { asJson } from '../application/plan-validator.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { RESIDENT_RULE, residentEntryFixture } from './resident-missions-entry-fixture.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().min(1).max(256), count = z.number().int().nonnegative();
const ReceiptSchema = z.strictObject({ digest: hash, state: WorkStateSchema });
const MarkerSchema = z.strictObject({ kind: z.literal('workflow-complete'), pid: count.positive(), base: z.string(), workId: id,
  agentId: id, sessionId: id, recordSha256: hash, stateDigest: hash, completionDigest: hash, checkpointSha256: hash, observedAt: count });
const RecordSchema = z.strictObject({ schemaVersion: z.literal(1), event: MissionEventSchema, state: WorkStateSchema,
  workflow: z.object({ control: z.object({ kind: z.literal('complete'), reason: z.literal('criteria_verified') }), stateRevision: count }),
  completion: z.strictObject({ commandId: id, receipt: ReceiptSchema }),
  checkpoint: z.strictObject({ artifact: ArtifactSchema, receipt: ReceiptSchema, base64: z.string().max(1024 * 1024) }),
  input: z.record(z.string(), z.unknown()), acceptReceipt: ReceiptSchema, history: z.unknown(), deliveries: z.array(z.unknown()),
  originals: z.array(z.strictObject({ ref: ArtifactSchema, base64: z.string().max(1024 * 1024) })).max(256) });
const CheckpointSchema = z.object({ rule: MissionRuleSchema, cursor: count, snapshotDigest: z.string().nullable(), status: z.enum(['active', 'closed']),
  pendingRun: z.boolean(), claim: z.object({ owner: id, until: count }).nullable(), reason: z.string().nullable(),
  acknowledgedRead: z.strictObject({ attemptId: id, resultId: id }), events: z.array(MissionEventSchema), seen: z.array(z.unknown()) });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const digester = new Sha256Digester(), digest = (value: unknown) => digester.digest(asJson(value));
async function bounded<T>(pending: Promise<T>, milliseconds: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

function readObserved(base: string, marker: z.infer<typeof MarkerSchema>) {
  const path = join(base, 'mission-completion-observed.json'), info = lstatSync(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 4 * 1024 * 1024);
  const bytes = readFileSync(path); assert.equal(sha(bytes), marker.recordSha256);
  const record = RecordSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))), state = record.state;
  assert.equal(digest(state), marker.stateDigest); assert.equal(digest(record.completion.receipt), marker.completionDigest);
  assert.equal(state.id, marker.workId); assert.equal(state.status, 'completed'); assert.equal(state.statusReason, 'criteria_verified');
  assert.equal(state.conversation?.session?.scope.agentId, marker.agentId); assert.equal(state.conversation?.session?.scope.sessionId, marker.sessionId);
  assert.equal(record.workflow.stateRevision, state.revision);
  const completion = record.completion.receipt;
  assert.equal(record.completion.commandId, `control:${completion.state.revision - 1}`); assert.ok(completion.state.revision <= state.revision);
  assert.equal(completion.digest, digest({ type: 'control_selected', data: { kind: 'complete', reason: 'criteria_verified' } }));
  assert.equal(completion.state.id, state.id); assert.equal(completion.state.status, 'completed');
  assert.deepEqual(completion.state.goal, state.goal); assert.deepEqual(completion.state.policy, state.policy);
  const subscription = state.subscriptions?.find(value => value.provider === 'mission'); assert.ok(subscription);
  assert.equal(subscription.status, 'closed'); assert.equal(subscription.checkpointId, `mission:${marker.checkpointSha256}`);
  const checkpointBytes = Buffer.from(record.checkpoint.base64, 'base64');
  assert.equal(checkpointBytes.byteLength, record.checkpoint.artifact.byteLength); assert.equal(sha(checkpointBytes), marker.checkpointSha256);
  assert.equal(record.checkpoint.receipt.digest, digest({ type: 'mission_checkpoint', data: { subscriptionId: subscription.id, artifact: record.checkpoint.artifact } }));
  const active = record.checkpoint.receipt.state.subscriptions?.find(value => value.id === subscription.id); assert.ok(active);
  assert.equal(active.status, 'active'); assert.deepEqual({ ...active, status: 'closed' }, subscription);
  const checkpoint = CheckpointSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(checkpointBytes)));
  assert.equal(checkpoint.status, 'active'); assert.equal(checkpoint.pendingRun, true); assert.ok(checkpoint.claim);
  assert.deepEqual(checkpoint.rule, RESIDENT_RULE); assert.equal(checkpoint.cursor, 1); assert.deepEqual(checkpoint.events, [record.event]);
  const acknowledged = state.attempts.find(value => value.id === checkpoint.acknowledgedRead.attemptId); assert.ok(acknowledged);
  assert.equal(acknowledged.resultId, checkpoint.acknowledgedRead.resultId); assert.equal(acknowledged.status, 'succeeded'); assert.equal(acknowledged.adopted, true);
  assert.equal(state.budget.used.modelCalls, 3); assert.equal(state.budget.used.toolCalls, 2); assert.equal(state.progress?.policy.maxUnproductiveSteps, 3);
  assert.deepEqual(record.originals.map(value => value.ref), state.artifacts);
  for (const original of record.originals) { const raw = Buffer.from(original.base64, 'base64'); assert.equal(raw.byteLength, original.ref.byteLength); assert.equal(sha(raw), original.ref.sha256); }
  return { record, checkpoint, subscription, checkpointBytes };
}

async function killAtCompletedWorkflow(base: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const child = fork(new URL('./mission-completion-crash-worker.js', import.meta.url), [base],
    { execPath: process.execPath, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined, closedObserved = false;
  let stderr = '', outputBytes = 0, messages = 0, spawnError: Error | undefined;
  const kill = () => { if (!exited) child.kill('SIGKILL'); };
  child.stdout!.on('data', value => { outputBytes += Buffer.byteLength(value); if (outputBytes > 65536) kill(); });
  child.stderr!.on('data', value => { outputBytes += Buffer.byteLength(value); stderr = (stderr + String(value)).slice(-16384); if (outputBytes > 65536) kill(); });
  child.on('error', error => { spawnError = error; });
  child.once('exit', (code, signal) => { exited = { code, signal }; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => {
    closedObserved = true; resolve({ code, signal });
  }));
  const message = new Promise<unknown>((resolve, reject) => child.on('message', value => {
    messages++; if (Buffer.byteLength(JSON.stringify(value)) > 16384 || messages > 1) { kill(); reject(new Error('mission_completion_message_limit')); }
    else resolve(value);
  }));
  signal.addEventListener('abort', kill, { once: true }); if (signal.aborted) kill();
  let failure: unknown, marker: z.infer<typeof MarkerSchema> | undefined, observed: ReturnType<typeof readObserved> | undefined;
  try {
    marker = MarkerSchema.parse(await bounded(Promise.race([message, closed.then(() => {
      throw new Error('mission_completion_worker_closed_before_gate', { cause: spawnError });
    })]), 45000, 'mission_completion_gate_timeout'));
    assert.equal(marker.base, base); assert.equal(marker.pid, child.pid); assert.equal(exited, undefined);
    observed = readObserved(base, marker); // Verify bounded original snapshots and hashes before sending the actual kill.
    assert.equal(child.kill('SIGKILL'), true);
    const terminal = await bounded(closed, 5000, 'mission_completion_terminal_unobserved');
    assert.deepEqual(terminal, { code: null, signal: 'SIGKILL' }); assert.deepEqual(exited, terminal);
    assert.equal(messages, 1); assert.equal(spawnError, undefined); assert.ok(outputBytes <= 65536);
  } catch (error) { failure = error; }
  finally {
    if (!closedObserved) { kill(); try { await bounded(closed, 5000, 'mission_completion_cleanup_terminal_unobserved'); }
      catch (error) { failure = failure ? new AggregateError([failure, error], 'mission_completion_cleanup_failed', { cause: failure }) : error; } }
    signal.removeEventListener('abort', kill);
  }
  if (failure) throw Object.assign(new Error(`mission_completion_crash_failed: ${stderr}`, { cause: failure }), { terminalObserved: closedObserved });
  assert.ok(marker && observed); return { marker, ...observed };
}

test('POSIX SIGKILL after actual workflow completion recovers the mission checkpoint on SQLite reopen without replaying models, tools or delivery',
  { timeout: 120000, skip: process.platform === 'win32' ? 'POSIX SIGKILL process acceptance; no native Windows crash or power-loss durability claim.' : false }, async t => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'mission-completion-crash-')));
    let fixture: Awaited<ReturnType<typeof residentEntryFixture>> | undefined, removable = true, failure: unknown;
    try {
      const observed = await killAtCompletedWorkflow(base, t.signal), { marker, record, checkpoint, subscription, checkpointBytes } = observed;
      const oldLeases = ['first', 'second'].flatMap(role => {
        const directory = join(base, role, '.secumon', 'runtime-leases');
        const found = readdirSync(directory).map(name => ({ path: join(directory, name), bytes: readFileSync(join(directory, name), 'utf8') }))
          .filter(value => (JSON.parse(value.bytes) as { pid: number }).pid === marker.pid);
        assert.equal(found.length, 1); return found;
      });
      fixture = await residentEntryFixture({ after() {} } as unknown as TestContext, false, { base });
      const f = fixture, p = f.current(); assert.equal(p.agentId, marker.agentId);
      const before = await p.runtime.state(marker.workId); assert.deepEqual(before, record.state);
      assert.deepEqual(await p.services.state.receipt(before.id, record.completion.commandId), record.completion.receipt);
      assert.deepEqual(await p.services.state.receipt(before.id, subscription.checkpointId), record.checkpoint.receipt);
      assert.deepEqual(Buffer.from(await p.services.artifacts.get(record.checkpoint.artifact, before.policy)), checkpointBytes);
      const basis = before.conversation?.session; assert.ok(basis);
      const input = await p.sessions.repository.input(basis.scope, basis.input.messageId); assert.deepEqual(input, record.input);
      assert.deepEqual(await p.services.state.receipt(before.id, 'conversation.accept'), record.acceptReceipt);
      assert.deepEqual(await p.sessions.history(p.actor, marker.sessionId, p.policy, { limit: 100 }), record.history);
      assert.deepEqual(await p.services.state.deliveries(before.id), record.deliveries);
      let workflows = 0, sends = 0, lookups = 0;
      assert.ok(p.services.sink.lookup);
      const run = p.workflow.run.bind(p.workflow), send = p.services.sink.send.bind(p.services.sink), lookup = p.services.sink.lookup.bind(p.services.sink);
      p.workflow.run = async () => { workflows++; throw new Error('completed_workflow_must_not_run'); };
      p.services.sink.send = async () => { sends++; throw new Error('completed_delivery_must_not_send'); };
      p.services.sink.lookup = async () => { lookups++; throw new Error('completed_delivery_must_not_lookup'); };
      try {
        assert.ok(p.missions); await p.missions.tick(before.id, p.workflow, { maxSteps: 20, signal: t.signal });
        const after = await p.runtime.state(before.id), closedSubscription = after.subscriptions?.find(value => value.id === subscription.id); assert.ok(closedSubscription);
        assert.equal(after.status, 'completed'); assert.equal(after.statusReason, before.statusReason); assert.equal(after.id, before.id);
        assert.notEqual(closedSubscription.checkpointId, subscription.checkpointId); assert.equal(closedSubscription.status, 'closed');
        const closedArtifact = after.artifacts.find(value => closedSubscription.checkpointId === `mission:${value.sha256}`); assert.ok(closedArtifact);
        const closedBytes = await p.services.artifacts.get(closedArtifact, after.policy); assert.equal(sha(closedBytes), closedArtifact.sha256);
        const closedCheckpoint = CheckpointSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(closedBytes)));
        assert.equal(closedCheckpoint.status, 'closed'); assert.equal(closedCheckpoint.reason, 'completed');
        assert.equal(closedCheckpoint.pendingRun, false); assert.equal(closedCheckpoint.claim, null);
        for (const key of ['rule', 'cursor', 'snapshotDigest', 'events', 'seen', 'acknowledgedRead'] as const) assert.deepEqual(closedCheckpoint[key], checkpoint[key], key);
        for (const key of ['goal', 'policy', 'executionControl', 'createdAt', 'deadlineAt', 'conversation', 'budget', 'attempts', 'modelCalls', 'generatedAnswer', 'evidence', 'progress'] as const)
          assert.deepEqual(after[key], before[key], key);
        assert.equal(after.notifications?.filter(value => value.provider === 'mission').length, 0);
        const closedReceipt = await p.services.state.receipt(before.id, closedSubscription.checkpointId); assert.ok(closedReceipt);
        assert.deepEqual(closedReceipt.state.subscriptions?.find(value => value.id === subscription.id), closedSubscription);
        assert.equal(closedReceipt.digest, digest({ type: 'mission_checkpoint', data: { subscriptionId: subscription.id, artifact: closedArtifact } }));
        const view = await p.missions.readEvents(before.id, RESIDENT_RULE.id); assert.equal(view.status, 'closed'); assert.deepEqual(view.events, [record.event]); assert.equal(view.cursor, checkpoint.cursor);
        await p.missions.tick(before.id, p.workflow, { maxSteps: 20, signal: t.signal });
        assert.deepEqual(await p.runtime.state(before.id), after); assert.deepEqual(await p.services.state.receipt(before.id, closedSubscription.checkpointId), closedReceipt);
        assert.equal(workflows + sends + lookups, 0); assert.equal(f.observed.inputs.first.length + f.observed.inputs.second.length + f.observed.polls.length, 0);
        assert.deepEqual(await p.services.state.deliveries(before.id), record.deliveries);
        assert.deepEqual(await p.sessions.history(p.actor, marker.sessionId, p.policy, { limit: 100 }), record.history);
        assert.deepEqual(await p.sessions.repository.input(basis.scope, basis.input.messageId), input);
        assert.deepEqual(await p.services.state.receipt(before.id, 'conversation.accept'), record.acceptReceipt);
        assert.deepEqual(await p.services.state.receipt(before.id, record.completion.commandId), record.completion.receipt);
        assert.deepEqual(await p.services.state.receipt(before.id, subscription.checkpointId), record.checkpoint.receipt);
        for (const original of record.originals) assert.deepEqual(Buffer.from(await p.services.artifacts.get(original.ref, after.policy)), Buffer.from(original.base64, 'base64'));
        const binding = after.conversation!.bindings.find(value => value.id === after.conversation!.primaryBindingId)!;
        assert.deepEqual(await p.services.state.workIdsForConversation(binding.tenantId, binding.principalId, binding.channel, binding.conversationId), [before.id]);
        assert.deepEqual(await f.memory('first'), []); assert.deepEqual(await f.memory('second'), []);
        for (const lease of oldLeases) assert.equal(readFileSync(lease.path, 'utf8'), lease.bytes);
      } finally { p.workflow.run = run; p.services.sink.send = send; p.services.sink.lookup = lookup; }
    } catch (error) {
      if (error && typeof error === 'object' && 'terminalObserved' in error && error.terminalObserved === false) removable = false;
      failure = error;
    } finally {
      if (fixture) for (const role of ['first', 'second'] as const) try { await fixture.current(role).close(); }
      catch (error) { removable = false; failure = failure ? new AggregateError([failure, error], 'mission_completion_parent_cleanup_failed', { cause: failure }) : error; }
      if (removable) rmSync(base, { recursive: true, force: true });
    }
    if (failure) throw failure;
  });
