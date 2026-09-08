import test from 'node:test';
import assert from 'node:assert/strict';
import { HostBudgetLedgerRouter, budgetWorkAddress, type BudgetLedgerRegistration } from '../application/budget-work-ledgers.js';
import type { BudgetAuthorityBinding, BudgetInvocation } from '../application/budget-authority.js';
import type { ArtifactStore, StateRepository } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { FakeClock, FakeSink, ScriptedPlanner, SequenceIds } from '../infrastructure/fakes.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { artifact, command, delivery, initial } from './state-conformance-helpers.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(scope = 'agent-a') {
  const work = initial('same-local-work-id'); work.goal.scope = scope;
  const { workId: _workId, ...owner } = budgetWorkAddress(work);
  const deny = async (): Promise<never> => { throw new Error('unexpected_underlying_operation'); };
  const source: StateRepository = {
    get: async id => id === work.id ? structuredClone(work) : null,
    receipt: async () => ({ digest: 'receipt', state: structuredClone(work) }),
    commit: async request => ({ kind: 'committed', state: structuredClone(request.next) }),
    events: deny, eventPage: deny, recentEventMetadata: deny, deliveries: deny, workIdsForConversation: deny,
    conversationWorkPage: deny, runnable: deny, close: deny,
  };
  const artifacts: ArtifactStore = { get: deny, put: deny, exists: async () => true };
  const services: RuntimeServices = { state: source, artifacts, tools: [], clock: new FakeClock(1000),
    ids: new SequenceIds(), digester: new Sha256Digester(), planner: new ScriptedPlanner([]), sink: new FakeSink() };
  const runs: string[] = [], interrupts: string[] = [];
  const registration: BudgetLedgerRegistration = { services,
    async run(id) { runs.push(id); return { privateContext: 'recipient-only', artifact: artifact() }; },
    interrupt(id) { interrupts.push(id); },
  };
  const router = new HostBudgetLedgerRouter();
  const register = () => router.register(owner, registration);
  const budgetCommand = () => ({ ...command(work, 'budget-command'), events: [{ type: 'budget_grant_reconciled', at: 1000, data: {} }] });
  return { work, owner, source, artifacts, services, registration, runs, interrupts, router, register, budgetCommand,
    ledger: () => router.resolve(budgetWorkAddress(work)) };
}

test('budget ledgers: identical work IDs route only through the exact registered owner', async () => {
  const a = fixture(), b = fixture('agent-b'); a.register();
  a.router.register(b.owner, b.registration);
  assert.equal((await a.ledger().state.get(a.work.id))?.goal.scope, 'agent-a');
  assert.equal((await a.router.resolve(budgetWorkAddress(b.work)).state.get(b.work.id))?.goal.scope, 'agent-b');
  for (const dimension of ['tenantId', 'principalId', 'scope'] as const)
    assert.throws(() => a.router.resolve({ ...budgetWorkAddress(a.work), [dimension]: 'unregistered' }), /budget_owner_ledger_unavailable/);
  assert.equal(await a.ledger().state.get('missing'), null);
  assert.throws(a.register, /budget_ledger_registration_conflict/);
});

for (const operation of ['get', 'receipt', 'committed', 'duplicate'] as const) {
  test(`budget ledgers: ${operation} rejects a different work from the same owner`, async () => {
    const f = fixture(), other = { ...structuredClone(f.work), id: 'other-work' };
    if (operation === 'get') f.source.get = async () => other;
    else if (operation === 'receipt') f.source.receipt = async () => ({ digest: 'other', state: other });
    else f.source.commit = async () => ({ kind: operation, state: other });
    f.register(); const ledger = f.ledger();
    await assert.rejects(() => operation === 'get' ? ledger.state.get(f.work.id) : operation === 'receipt' ?
      ledger.state.receipt(f.work.id, 'command') : ledger.state.commit(f.budgetCommand()), /budget_work_owner_mismatch/);
  });
}

test('budget ledgers: a faulty store cannot substitute a foreign tenant, principal or scope', async () => {
  for (const dimension of ['tenantId', 'principalId', 'scope'] as const) {
    const f = fixture(), other = structuredClone(f.work);
    if (dimension === 'scope') other.goal.scope = 'foreign'; else other.policy[dimension] = 'foreign';
    f.source.get = async () => other; f.register();
    await assert.rejects(() => f.ledger().state.get(f.work.id), /budget_work_owner_mismatch/);
  }
});

test('budget ledgers: discovery, content, non-budget commits and deliveries stay inaccessible', async () => {
  const f = fixture(); f.register(); const ledger = f.ledger();
  const denied = [() => ledger.state.events(f.work.id, 0), () => ledger.state.deliveries(f.work.id),
    () => ledger.state.eventPage(f.work.id, { afterRevision: 0, throughRevision: 1, limit: 1 }),
    () => ledger.state.recentEventMetadata(f.work.id, { throughRevision: 1, limit: 1 }),
    () => ledger.state.runnable(1000), () => ledger.state.close(),
    () => ledger.state.workIdsForConversation('tenant-a', 'person-a', 'peer', 'conversation'),
    () => ledger.state.conversationWorkPage({ tenantId: 'tenant-a', principalId: 'person-a', channel: 'peer', conversationId: 'conversation', limit: 1 }),
    () => ledger.artifacts.get(artifact(), f.work.policy),
    () => ledger.artifacts.put(new Uint8Array(), { tenantId: 'tenant-a', labels: [], mediaType: 'text/plain' }),
    () => ledger.state.commit(command(f.work, 'ordinary')),
    () => ledger.state.commit({ ...f.budgetCommand(), workId: 'other' }),
    () => ledger.state.commit({ ...f.budgetCommand(), events: [] }),
    () => ledger.state.commit({ ...f.budgetCommand(), deliveries: [delivery(f.work.id)] }),
  ];
  for (const invoke of denied) await assert.rejects(invoke, /budget_ledger_operation_denied/);
  await assert.rejects(() => ledger.artifacts.exists({ ...artifact(), tenantId: 'foreign' }), /budget_work_owner_mismatch/);
  assert.equal((await ledger.state.commit(f.budgetCommand())).kind, 'committed');
  assert.equal(await ledger.artifacts.exists(artifact()), true);
  assert.deepEqual(await ledger.run(f.work.id, 1, new AbortController().signal),
    { status: f.work.status, stateRevision: f.work.revision, goalRevision: f.work.goal.revision });
  assert.deepEqual(f.runs, [f.work.id]);
});

for (const operation of ['get', 'receipt', 'commit', 'exists', 'run'] as const) {
  test(`budget ledgers: unregister during ${operation} rejects the late result and preserves a replacement`, async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<void>();
    const hold = async () => { entered.resolve(); await release.promise; };
    if (operation === 'get') f.source.get = async () => { await hold(); return f.work; };
    else if (operation === 'receipt') f.source.receipt = async () => { await hold(); return { digest: 'receipt', state: f.work }; };
    else if (operation === 'commit') f.source.commit = async () => { await hold(); return { kind: 'committed', state: f.work }; };
    else if (operation === 'exists') f.artifacts.exists = async () => { await hold(); return true; };
    else f.registration.run = hold;
    const unregister = f.register(), old = f.ledger();
    const pending = operation === 'get' ? old.state.get(f.work.id) : operation === 'receipt' ? old.state.receipt(f.work.id, 'command') :
      operation === 'commit' ? old.state.commit(f.budgetCommand()) : operation === 'exists' ? old.artifacts.exists(artifact()) :
        old.run(f.work.id, 1, new AbortController().signal);
    const rejected = assert.rejects(pending, /budget_owner_ledger_unavailable/);
    await entered.promise; unregister(); f.register(); const replacement = f.ledger(); unregister();
    release.resolve(); await rejected;
    assert.equal(old.current(), false); assert.equal(replacement.current(), true);
    assert.equal(old.owns(f.source), false); assert.equal(replacement.owns(f.source), true);
  });
}

test('budget ledgers: callbacks are captured and replacing a service invalidates the registration', async () => {
  const f = fixture(); f.register(); const ledger = f.ledger();
  f.source.get = async () => { throw new Error('replaced_callback'); };
  f.registration.run = async () => { throw new Error('replaced_callback'); };
  await ledger.run(f.work.id, 1, new AbortController().signal);
  await ledger.interrupt(f.work.id);
  assert.deepEqual(f.runs, [f.work.id]); assert.deepEqual(f.interrupts, [f.work.id]);
  f.services.state = { ...f.source };
  assert.equal(ledger.current(), false);
  await assert.rejects(() => ledger.state.get(f.work.id), /budget_owner_ledger_unavailable/);
});

test('budget ledgers: recipient metadata is captured and allocation does not confer execution permission', async () => {
  const f = fixture(); f.register(); const entered = deferred<void>(), release = deferred<boolean>();
  const decisions: string[] = [];
  const recipient = { owner: structuredClone(f.owner), policy: structuredClone(f.work.policy), revision: 1,
    async approve(binding: BudgetAuthorityBinding, purpose: 'allocation' | 'execution', _signal?: AbortSignal, invocation?: BudgetInvocation) {
      assert.equal(Object.isFrozen(binding.child.policy), true);
      decisions.push(purpose); if (invocation) assert.equal(Object.isFrozen(invocation), true);
      if (purpose === 'execution') { entered.resolve(); return release.promise; } return true;
    } };
  const remove = f.router.registerRecipient('receiver', recipient);
  recipient.owner.scope = 'mutated'; recipient.policy.allowedTools.push('mutated'); recipient.revision = 9;
  const binding: BudgetAuthorityBinding = { mandate: { provider: 'host-budget-ledger', referenceId: 'grant', revision: 1, childGoalRevision: 1, attributes: { recipientId: 'receiver' } },
    grantId: 'grant', parent: { workId: 'sponsor', tenantId: f.owner.tenantId, principalId: f.owner.principalId, goalRevision: 1 },
    child: { workId: f.work.id, goalRevision: 1, goalDigest: 'a'.repeat(64), scope: f.owner.scope, policy: structuredClone(f.work.policy),
      allocated: { toolCalls: 1, modelCalls: 1, tokens: 100, replans: 1 }, deadlineAt: 2000 } };
  assert.equal(await f.router.current(binding, 'allocation'), true);
  const pending = f.router.current(binding, 'execution', undefined, { workId: f.work.id, operation: { kind: 'model' } });
  await entered.promise; remove();
  f.router.registerRecipient('receiver', { ...recipient, owner: f.owner, policy: f.work.policy, revision: 1, approve: async () => true });
  remove(); release.resolve(true);
  assert.equal(await pending, false);
  assert.equal(f.router.recipient('receiver')?.revision, 1);
  assert.deepEqual(decisions, ['allocation', 'execution']);
  assert.equal(await f.router.current({ ...binding, mandate: { ...binding.mandate, revision: 2 } }, 'allocation'), false);
  const controller = new AbortController(); controller.abort();
  assert.equal(await f.router.current(binding, 'allocation', controller.signal), false);
  assert.equal(await f.router.current({ ...binding, child: { ...binding.child, policy: { ...binding.child.policy, allowWrites: true } } }, 'execution'), false);
});
