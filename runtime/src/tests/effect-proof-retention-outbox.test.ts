import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerReconciliation } from '../domain/computer-reconciliation.js';
import type { Delivery, WorkState } from '../domain/model.js';
import type { ArtifactStore, CommitRequest, MessageSink, StateRepository } from '../application/ports.js';
import { OutboxDispatcher } from '../application/outbox.js';
import { toolExecution } from '../application/tool-execution-usage.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { FakeClock } from '../infrastructure/fakes.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { adapters, advance, attempt, command, initial, openRepository, snapshot, type Adapter } from './state-conformance-helpers.js';

const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
const kinds = ['ack', 'question', 'failure'] as const;
type Kind = typeof kinds[number];

/** Synthetic ledger metadata and an injected boolean checker isolate transport fencing; these are not authenticated computer receipts. */
async function fixture(t: TestContext, backend: Adapter, deliveries: { kind: Kind; status: 'pending' | 'sending' | 'unknown' }[], settled = false) {
  const directory = await mkdtemp(join(tmpdir(), 'effect-proof-retention-outbox-')); const repository = openRepository(backend, directory);
  t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const backing = new MemoryArtifactStore(); const digester = new Sha256Digester(); const clock = new FakeClock(1000);
  const ref = (id: string) => backing.put(new TextEncoder().encode(JSON.stringify({ fixtureOnly: id })),
    { tenantId: actor.tenantId, labels: ['synthetic'], mediaType: 'application/json' });
  const [head, originalResult, request, response, proof, message] = await Promise.all(['head', 'original-result', 'request', 'response', 'proof', 'message'].map(ref));
  const state = initial(); state.status = 'blocked'; state.statusReason = 'effect_unknown'; state.policy.allowWrites = true;
  state.attempts = [{ ...attempt('unknown'), toolId: 'fixture.act', contractDigest: 'a'.repeat(64), effect: 'write', effectState: 'unknown',
    finishedAt: 1000, resultId: 'original-result', resultArtifact: originalResult!,
    computerUse: { head: head!, phase: 'unknown', completedSteps: 0, pendingOperationId: 'operation' } }];
  state.artifacts = [head!, originalResult!, request!, response!, proof!, message!];
  state.obligations = [{ id: 'effect:attempt', kind: 'effect_reconciliation', reason: 'Original effect requires proof', status: 'pending', wakeKey: null, dueAt: null },
    { id: 'question', kind: 'response', reason: 'A pending synthetic question', status: 'pending', wakeKey: 'reply', dueAt: null }];
  const binding = { ...actor, id: 'binding', channel: 'test' as const, conversationId: 'retention-outbox', destination: 'local', recipientId: actor.principalId };
  state.conversation = { primaryBindingId: binding.id, bindings: [binding], completionRequiresDelivery: false, result: null };
  const outgoing: Delivery[] = deliveries.map(({ kind, status }, index) => ({ id: `${kind}-${index}`, workId: state.id, goalRevision: 1,
    destination: 'local', kind, text: `Synthetic ${kind} requiring the retained source proof`, status, externalId: null,
    dispatch: status === 'pending' ? null : { owner: 'previous-sender', leaseUntil: 999, attempts: 1, lastError: 'unknown' },
    context: { binding, labels: ['synthetic'], sourceRevision: state.revision, dataGeneration: 0, responseId: null, evidenceIds: [],
      evidenceDigest: null, obligationIds: kind === 'question' ? ['question'] : [], artifact: message! } }));
  assert.equal((await repository.commit(command(state, 'seed', outgoing))).kind, 'committed');
  const reserved: ComputerReconciliation = { id: 'lookup', sourceAttemptId: 'attempt', obligationId: 'effect:attempt', sourceHead: head!,
    sourceResultArtifact: originalResult!, requestArtifact: request!, responseArtifact: null, proofArtifact: null, operationId: 'operation', stepIndex: 0,
    goalRevision: 1, policyDigest: 'b'.repeat(64), generation: 0, contractDigest: 'a'.repeat(64), driver: { id: 'fixture-driver', version: '1' },
    owner: 'fixture-owner', leaseUntil: 2000, createdAt: 1000, dispatchedAt: null, finishedAt: null, status: 'reserved', execution: toolExecution('not_invoked'),
    reason: null, outcome: null, effectState: 'unknown' };
  const running: ComputerReconciliation = { ...reserved, status: 'running', dispatchedAt: 1000, execution: toolExecution('unreported') };
  const received: ComputerReconciliation = { ...running, status: 'received', responseArtifact: response!, finishedAt: 1000, outcome: 'applied',
    execution: toolExecution('invoked', { transportCalls: 1, internalOperations: 1, imageBytes: 0, waitMs: 0 }) };
  const confirmed: ComputerReconciliation = { ...received, status: 'settled', proofArtifact: proof!, effectState: 'confirmed' };
  let current = state;
  for (const record of [reserved, running, received, confirmed]) {
    const next = advance(current); next.computerReconciliations = [record];
    if (record.status === 'settled') next.obligations[0]!.status = 'satisfied';
    assert.equal((await repository.commit(command(next, `fixture-${record.status}`))).kind, 'committed'); current = next;
  }
  const counts = { sends: 0, lookups: 0, proofChecks: 0, refreshes: 0, outboxCommits: 0, puts: 0 };
  let allowed = settled; let afterSend: (() => Promise<void>) | undefined; let onExists: (() => void) | undefined;
  async function retire() {
    const value = (await repository.get(state.id))!; const record = value.computerReconciliations![0]!;
    if (record.status === 'failed') return;
    const next = advance(value); next.computerReconciliations![0]!.status = 'failed'; next.computerReconciliations![0]!.reason = 'effect_proof_unavailable';
    next.obligations[0]!.status = 'pending';
    assert.equal((await repository.commit(command(next, 'fixture-retired'))).kind, 'committed');
  }
  if (!settled) await retire();
  const tracked = new Proxy(repository, { get(target, key) {
    if (key === 'commit') return async (input: CommitRequest) => { counts.outboxCommits++; return target.commit(input); };
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } }) as StateRepository;
  const artifacts: ArtifactStore = { get: backing.get.bind(backing), async put(bytes, attributes) { counts.puts++; return backing.put(bytes, attributes); },
    async exists(value) { const present = await backing.exists(value); onExists?.(); return present; } };
  const sink: MessageSink = { capabilities: { idempotentSend: true },
    async send(value) { counts.sends++; await afterSend?.(); return { status: 'delivered', externalId: `sent:${value.id}` }; },
    async lookup(value) { counts.lookups++; return { status: 'delivered', externalId: `found:${value.id}` }; } };
  const effects = { async current(_state: WorkState) { counts.proofChecks++; return allowed; },
    async refresh(workId: string) { counts.refreshes++; return (await repository.get(workId))!; } };
  const outbox = new OutboxDispatcher({ state: tracked, artifacts, clock, digester, sink, effects }, 'retention-sender', 1000);
  return { repository, outbox, counts, workId: state.id, retire,
    allow(value: boolean) { allowed = value; }, afterSend(value: () => Promise<void>) { afterSend = value; }, onExists(value: () => void) { onExists = value; },
    state: () => repository.get(state.id), deliveries: () => repository.deliveries(state.id),
    snapshot: () => snapshot(repository, state.id, ['fixture-settled', 'fixture-retired']) };
}

for (const backend of adapters) {
  test(`${backend}: injected invalid retained proof blocks every pending ack, question and failure before transport`, async t => {
    const f = await fixture(t, backend, kinds.map(kind => ({ kind, status: 'pending' })));
    const before = await f.snapshot(); const record = before.state!.computerReconciliations![0]!;
    assert.equal(record.status, 'failed'); assert.ok(record.proofArtifact);
    await f.outbox.flush(f.workId, actor); await f.outbox.flush(f.workId, actor);
    assert.deepEqual(await f.snapshot(), before);
    assert.deepEqual(f.counts, { sends: 0, lookups: 0, proofChecks: 2, refreshes: 2, outboxCommits: 0, puts: 0 });
    // A trusted true stub is only a transport control: it does not authenticate these synthetic proof bytes.
    f.allow(true); await f.outbox.flush(f.workId, actor);
    assert.equal(f.counts.sends, 3); assert.equal(f.counts.lookups, 0);
    assert.ok((await f.deliveries()).every(delivery => delivery.status === 'delivered'));
  });

  test(`${backend}: retained failed proof blocks receipt lookup and settlement for uncertain ack, question and failure`, async t => {
    const f = await fixture(t, backend, kinds.flatMap(kind => [{ kind, status: 'sending' as const }, { kind, status: 'unknown' as const }]));
    const before = await f.snapshot();
    await f.outbox.flush(f.workId, actor); await f.outbox.flush(f.workId, actor);
    assert.deepEqual(await f.snapshot(), before);
    assert.deepEqual(f.counts, { sends: 0, lookups: 0, proofChecks: 2, refreshes: 2, outboxCommits: 0, puts: 0 });
  });

  test(`${backend}: settled-to-failed transition during send cannot adopt an already returned channel receipt`, async t => {
    for (const kind of kinds) {
      const f = await fixture(t, backend, [{ kind, status: 'pending' }], true); const source = (await f.state())!.attempts[0];
      f.afterSend(async () => { await f.retire(); f.allow(false); });
      await f.outbox.flush(f.workId, actor); await f.outbox.flush(f.workId, actor);
      assert.equal(f.counts.sends, 1); assert.equal(f.counts.lookups, 0); assert.equal(f.counts.outboxCommits, 1);
      const delivery = (await f.deliveries())[0]!; assert.equal(delivery.status, 'sending'); assert.equal(delivery.externalId, null);
      const state = (await f.state())!; assert.equal(state.computerReconciliations![0]!.status, 'failed');
      assert.ok(state.computerReconciliations![0]!.proofArtifact); assert.equal(state.obligations[0]!.status, 'pending');
      assert.deepEqual(state.attempts[0], source);
      assert.equal((await f.repository.events(f.workId, 0)).filter(event => event.type === 'delivery_settled').length, 0);
    }
  });

  test(`${backend}: failed-only retained proof is checked again at the final delivery commit after an artifact await`, async t => {
    for (const kind of kinds) {
      const f = await fixture(t, backend, [{ kind, status: 'pending' }]); f.allow(true);
      let armed = false; let fired = false; f.afterSend(async () => { armed = true; });
      f.onExists(() => { if (armed && !fired) { fired = true; f.allow(false); } });
      await f.outbox.flush(f.workId, actor); await f.outbox.flush(f.workId, actor);
      assert.equal(fired, true); assert.equal(f.counts.sends, 1); assert.equal(f.counts.lookups, 0);
      assert.equal(f.counts.outboxCommits, 1, 'the final proof fence runs before the repository settlement commit');
      const delivery = (await f.deliveries())[0]!; assert.equal(delivery.status, 'sending'); assert.equal(delivery.externalId, null);
      assert.equal((await f.state())!.computerReconciliations![0]!.status, 'failed');
      assert.equal((await f.repository.events(f.workId, 0)).filter(event => event.type === 'delivery_settled').length, 0);
    }
  });
}
