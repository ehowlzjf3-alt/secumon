import test from 'node:test';
import assert from 'node:assert/strict';
import type { BudgetGrant } from '../domain/budget-delegation.js';
import { BUDGET_DIMENSIONS, grantExposure, totalExposure } from '../domain/budget-delegation.js';
import type { ContextPacket, WorkState } from '../domain/model.js';
import { GoalSchema } from '../application/contracts.js';
import { asJson } from '../application/plan-validator.js';
import { BUDGET_ENTRY_CHILD_LIMITS, BUDGET_ENTRY_SECRET, BUDGET_ENTRY_SOURCE, budgetAllocate, budgetGrantId,
  budgetObject, budgetRun, budgetStatus, budgetToolsEntryFixture, type BudgetEntryStep } from './budget-tools-entry-fixture.js';

function original(state: WorkState) { return { goal: state.goal, policy: state.policy, limits: state.budget.limits, deadlineAt: state.deadlineAt }; }
function assertSettled(grant: BudgetGrant, child: WorkState) {
  assert.equal(grant.status, 'settled'); assert.equal(grant.unmeasuredModelCalls, 0);
  for (const dimension of BUDGET_DIMENSIONS) {
    assert.equal(grant.accounted[dimension], child.budget.used[dimension], dimension);
    assert.equal(grant.reserved[dimension], 0, dimension);
    assert.equal(grantExposure(grant)[dimension], child.budget.used[dimension], dimension);
  }
}
async function finite<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('budget_return_settlement_timeout')), 5000);
  })]); } finally { if (timer !== undefined) clearTimeout(timer); }
}
function observedSettledGrant(packet: ContextPacket) {
  const id = budgetGrantId(packet);
  for (const observation of [...(packet.toolObservations ?? [])].reverse()) {
    if (observation.status !== 'success' || !['core.budget.status', 'core.budget.run'].includes(observation.toolId)) continue;
    const output = budgetObject(observation.output);
    const candidates = Array.isArray(output['grants']) ? output['grants'] : output['grant'] ? [output['grant']] : [];
    const grant = candidates.map(value => budgetObject(value)).find(value => value['id'] === id);
    if (grant) { assert.equal(grant['status'], 'settled', 'the model must observe the old grant settled before requesting a new one'); return id; }
  }
  throw new Error('budget_return_observation_required');
}
function assignment(description: string, independentSources: number, returned = false): BudgetEntryStep {
  const allocate = budgetAllocate();
  return { operation: 'allocate', input(packet) {
    if (returned) observedSettledGrant(packet);
    const input = allocate.input(packet), goal = GoalSchema.parse(input['goal']);
    const limits = { ...BUDGET_ENTRY_CHILD_LIMITS };
    if (returned) {
      const execution = packet.execution; assert.ok(execution?.delegation);
      // The current allocation proposal and the next run proposal each need one sponsor replan.
      // Previously charged child work remains in the public total even after its unused allowance returns.
      const remaining = execution.budget.limits.replans - execution.delegation.total.replans;
      assert.ok(Number.isSafeInteger(remaining) && remaining >= 2, 'public remaining replans must cover the two sponsor proposals');
      limits.replans = Math.min(limits.replans, remaining - 2);
      assert.equal(execution.delegation.total.replans, execution.budget.used.replans + execution.delegation.delegated.replans);
      assert.ok(execution.delegation.total.replans + limits.replans + 2 <= execution.budget.limits.replans);
    }
    return { ...input, limits: asJson(limits), goal: asJson({ ...goal, description,
      criteria: goal.criteria.map(value => ({ ...value, minIndependentSources: independentSources })) }) };
  } };
}

for (const mode of ['return', 'read-then-return'] as const) {
  test(`budget return entry: ${mode === 'return' ? 'the first planned operation returns before source use' : 'an unfinished task returns after one adopted original read'} before explicit fresh allocation across separate SQLite profiles`,
    { timeout: 180000 }, async t => {
      const f = await budgetToolsEntryFixture(t, { child: mode });
      const recipient = f.current('recipient'), residentText = 'Keep this resident discussion independently of temporary resource grants.';
      const resident = await recipient.sessions.open(recipient.actor, { channel: 'test', conversationId: 'recipient-resident-return' });
      const residentInput = { sessionId: resident.scope.sessionId, messageId: 'resident-original', rawText: residentText,
        binding: { ...recipient.executionActor, channel: 'test' as const, conversationId: 'recipient-resident-return',
          recipientId: recipient.actor.principalId, destination: 'local' },
        scope: recipient.scope, mode: 'auto' as const, policy: recipient.policy, limits: recipient.limits };
      const residentWork = await recipient.turns.accept(recipient.actor, residentInput);
      await recipient.outbox.flush(residentWork.workId, recipient.actor);
      const residentBefore = await recipient.runtime.state(residentWork.workId);
      const historyBefore = await recipient.sessions.history(recipient.actor, resident.scope.sessionId, recipient.policy, { limit: 50 });
      assert.ok(historyBefore.entries.some(entry => entry.role === 'user' && entry.text === residentText));

      const firstAssignment = assignment('Investigate two independent originals; return the unused allowance if the recipient stops.', 2);
      f.controls.steps = [budgetStatus, firstAssignment, budgetRun];
      const accepted = await f.accept(), sponsor = f.current('sponsor');
      const originalParent = original(await sponsor.runtime.state(accepted.workId));
      const allocated = await f.through(accepted.workId, 2); assert.equal(allocated.result.status, 'success');
      const active = await f.child(accepted.workId), genesis = await recipient.services.state.receipt(active.state.id, 'budget.child-genesis');
      assert.ok(genesis); assert.equal(active.grant.status, 'active');
      assert.deepEqual(active.state.budget.limits, BUDGET_ENTRY_CHILD_LIMITS);
      assert.deepEqual(grantExposure(active.grant), active.grant.allocated);
      assert.notEqual(active.state.id, residentWork.workId); assert.equal(active.state.conversation, null);
      const originalChild = original(active.state);

      const invoked = await f.through(accepted.workId, 3); assert.equal(invoked.result.status, 'success');
      let child = await recipient.runtime.state(active.state.id);
      const returnAttempt = child.attempts.find(value => value.toolId === 'core.budget.return'); assert.ok(returnAttempt);
      // Returning fences the task itself. Finish only the already-dispatched response, without another plan or source call.
      await finite(recipient.runtime.settlePending(returnAttempt.id));
      child = await recipient.runtime.state(child.id);
      const beforeSettlementModels = f.observed.recipientInputs.length, beforeSettlementReads = f.observed.reads.length;
      if (child.attempts.find(value => value.id === returnAttempt.id)?.status === 'received')
        await recipient.workflow.run(child.id, recipient.executionActor, { maxSteps: 1 });
      assert.equal(f.observed.recipientInputs.length, beforeSettlementModels); assert.equal(f.observed.reads.length, beforeSettlementReads);
      const returnedGrant = await sponsor.runtime.budgets.reconcile(accepted.workId, active.grant.id, sponsor.executionActor);
      child = await recipient.runtime.state(child.id); assertSettled(returnedGrant, child);
      assert.deepEqual(original(child), originalChild); assert.equal(child.budgetParent?.phase, 'draining');
      assert.equal(child.status, 'blocked'); assert.notEqual(child.status, 'completed');
      const returned = await f.result('recipient', child.id, returnAttempt.taskId);
      assert.equal(returned.result.status, 'success'); assert.equal(returned.result.effectState, 'none');
      assert.equal(budgetObject(budgetObject(returned.result.output)['grant'])['id'], returnedGrant.id);
      assert.deepEqual(returned.result.evidence, []); assert.deepEqual(returned.result.artifacts, []);
      assert.equal(returned.attempt.adopted, false, 'the return receipt is not a verified answer for the unfinished task');
      assert.equal(child.attempts.filter(value => value.toolId === 'core.budget.return').length, 1);
      assert.equal(child.budget.used.toolCalls, mode === 'return' ? 1 : 2);
      assert.equal(child.budget.used.modelCalls, mode === 'return' ? 1 : 2);
      assert.equal(child.budget.used.tokens, mode === 'return' ? 160 : 320);
      assert.equal(child.evidence.length, mode === 'return' ? 0 : 1);
      if (mode === 'read-then-return') {
        const read = await f.result('recipient', child.id, 'recipient-read');
        assert.equal(read.attempt.adopted, true); assert.equal(read.result.evidence[0]?.facts['text'], BUDGET_ENTRY_SECRET);
        assert.equal(child.goal.criteria[0]?.minIndependentSources, 2);
        assert.ok(f.observed.recipientInputs.some(packet => packet.workId === child.id &&
          packet.toolObservations?.some(value => value.toolId === BUDGET_ENTRY_SOURCE && value.status === 'success')));
      }
      const returns = (await recipient.services.state.events(child.id, 0)).filter(value => value.type === 'budget_return_requested');
      assert.equal(returns.length, 1); const returnCommand = returns[0]!.commandId;
      assert.match(returnCommand, /^budget-return:[a-f0-9]{64}$/);
      const operation = returnCommand.slice('budget-return:'.length);
      const returnReceipt = await recipient.services.state.receipt(child.id, returnCommand);
      const receiveReceipt = await recipient.services.state.receipt(child.id, 'receive:' + returnAttempt.id);
      assert.ok(returnReceipt); assert.ok(receiveReceipt);
      const raw = await recipient.services.artifacts.get(f.raw('recipient'), recipient.policy);
      const observedCalls = { models: f.observed.sponsorInputs.length + f.observed.recipientInputs.length, reads: f.observed.reads.length };
      assert.deepEqual(await recipient.runtime.budgets.returnAllocation(child.id, operation, child.policy, child.goal.revision), returnedGrant);
      await f.reopen();
      const currentRecipient = f.current('recipient'), currentSponsor = f.current('sponsor');
      assert.deepEqual(await currentRecipient.runtime.budgets.returnAllocation(child.id, operation, child.policy, child.goal.revision), returnedGrant);
      assert.deepEqual(await currentSponsor.runtime.budgets.reconcile(accepted.workId, returnedGrant.id, currentSponsor.executionActor), returnedGrant);
      assert.deepEqual(await currentRecipient.services.state.receipt(child.id, returnCommand), returnReceipt);
      assert.deepEqual(await currentRecipient.services.state.receipt(child.id, 'receive:' + returnAttempt.id), receiveReceipt);
      assert.deepEqual(await currentRecipient.services.state.receipt(child.id, 'budget.child-genesis'), genesis);
      assert.deepEqual(await currentRecipient.services.artifacts.get(returned.attempt.resultArtifact!, child.policy), returned.bytes);
      assert.deepEqual(await currentRecipient.services.artifacts.get(f.raw('recipient'), currentRecipient.policy), raw);
      assert.deepEqual({ models: f.observed.sponsorInputs.length + f.observed.recipientInputs.length, reads: f.observed.reads.length }, observedCalls);
      const residentAgain = await currentRecipient.sessions.open(currentRecipient.actor, { channel: 'test', conversationId: 'recipient-resident-return' });
      assert.equal(residentAgain.scope.sessionId, resident.scope.sessionId);
      assert.deepEqual(await currentRecipient.sessions.history(currentRecipient.actor, resident.scope.sessionId, currentRecipient.policy, { limit: 50 }), historyBefore);
      assert.deepEqual(await currentRecipient.runtime.state(residentWork.workId), residentBefore);

      // A newly requested task has its own goal and grant. It never reactivates or edits the returned one.
      const runGrant = budgetObject(budgetObject(invoked.result.output)['grant']);
      const refresh = runGrant['status'] === 'settled' ? [] : [budgetStatus];
      f.controls.child = 'read';
      f.controls.steps = [budgetStatus, firstAssignment, budgetRun, ...refresh,
        assignment('Verify the single recipient original for a newly allocated task.', 1, true), budgetRun];
      const nextStep = 4 + refresh.length;
      const reallocated = await f.through(accepted.workId, nextStep); assert.equal(reallocated.result.status, 'success');
      const allocationOutput = budgetObject(reallocated.result.output), newGrantId = allocationOutput['grantId']; assert.equal(typeof newGrantId, 'string');
      const parentWithNew = await currentSponsor.runtime.state(accepted.workId), nextGrant = parentWithNew.budgetGrants?.find(value => value.id === newGrantId);
      assert.ok(nextGrant); assert.notEqual(nextGrant.id, returnedGrant.id); assert.notEqual(nextGrant.childWorkId, child.id);
      assert.deepEqual(parentWithNew.budgetGrants?.find(value => value.id === returnedGrant.id), returnedGrant);
      assert.equal(parentWithNew.budgetGrants?.length, 2); assert.deepEqual(original(parentWithNew), originalParent);
      const nextChild = await currentRecipient.runtime.state(nextGrant.childWorkId);
      const allocationPacket = f.observed.sponsorInputs.at(-1)?.packet; assert.ok(allocationPacket?.execution?.delegation);
      const expectedReplans = Math.min(BUDGET_ENTRY_CHILD_LIMITS.replans,
        allocationPacket.execution.budget.limits.replans - allocationPacket.execution.delegation.total.replans - 2);
      assert.deepEqual(nextChild.budget.limits, { ...BUDGET_ENTRY_CHILD_LIMITS, replans: expectedReplans });
      assert.equal(nextGrant.allocated.replans, expectedReplans);
      assert.ok(totalExposure(parentWithNew).replans + 1 <= parentWithNew.budget.limits.replans, 'the next run proposal still fits the sponsor original limit');
      assert.equal(nextChild.budgetParent?.phase, 'active'); assert.equal(nextChild.attempts.length, 0); assert.equal(nextChild.modelCalls.length, 0);
      assert.equal(await currentSponsor.services.state.get(nextChild.id), null); assert.equal(await currentSponsor.services.state.get(child.id), null);
      assert.equal((await f.through(accepted.workId, nextStep + 1)).result.status, 'success');
      const completed = await currentSponsor.workflow.run(accepted.workId, currentSponsor.executionActor, { maxSteps: 12 });
      assert.equal(completed.control.kind, 'complete', JSON.stringify(completed));
      const finalParent = await currentSponsor.runtime.state(accepted.workId), finalChild = await currentRecipient.runtime.state(nextChild.id);
      const finalGrant = finalParent.budgetGrants?.find(value => value.id === nextGrant.id); assert.ok(finalGrant); assertSettled(finalGrant, finalChild);
      assert.equal(finalChild.status, 'completed'); assert.equal(finalChild.evidence.length, 1);
      assert.deepEqual(finalParent.budgetGrants?.find(value => value.id === returnedGrant.id), returnedGrant);
      assert.deepEqual(original(finalParent), originalParent); assert.deepEqual(finalParent.evidence, []);
      assert.equal(f.observed.reads.length, mode === 'return' ? 1 : 2);
      for (const dimension of BUDGET_DIMENSIONS)
        assert.equal(totalExposure(finalParent)[dimension], finalParent.budget.used[dimension] + child.budget.used[dimension] + finalChild.budget.used[dimension]);
      const oldFinal = await currentRecipient.runtime.state(child.id);
      assert.deepEqual(oldFinal.attempts, child.attempts); assert.deepEqual(oldFinal.modelCalls, child.modelCalls); assert.deepEqual(oldFinal.budget, child.budget);
      assert.deepEqual(await currentRecipient.services.state.receipt(child.id, returnCommand), returnReceipt);
      assert.equal((await currentRecipient.services.state.events(child.id, 0)).filter(value => value.type === 'budget_return_requested').length, 1);
      assert.equal(JSON.stringify([finalParent, f.observed.sponsorInputs]).includes(BUDGET_ENTRY_SECRET), false);
      assert.equal(await currentSponsor.services.artifacts.exists(f.raw('recipient')), false);
      assert.deepEqual(await f.memory('sponsor'), []); assert.deepEqual(await f.memory('recipient'), []);
      assert.deepEqual(await currentRecipient.runtime.state(residentWork.workId), residentBefore);
    });
}
