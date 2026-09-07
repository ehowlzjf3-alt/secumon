import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BudgetVector } from '../domain/budget-delegation.js';
import { grantExposure, totalExposure } from '../domain/budget-delegation.js';
import { adapters, openRepository, type Adapter } from './state-conformance-helpers.js';

type Message = { type: 'checkpoint' | 'finished'; stage: string; parentId: string; childId: string; toolEntries: number; modelEntries: number;
  phase?: string; grantStatus?: string; grantCount?: number; exposure?: BudgetVector; parentRevision?: number; childRevision?: number };
const zero = (values: Partial<BudgetVector> = {}): BudgetVector => ({ toolCalls: 0, modelCalls: 0, tokens: 0, replans: 0, ...values });
const allocation = zero({ toolCalls: 4, modelCalls: 2, tokens: 500, replans: 4 });

async function worker(directory: string, stage: string, adapter: Adapter, reservation = 'tool'): Promise<Message> {
  const child = fork(new URL('./budget-delegation-crash-worker.js', import.meta.url), [directory, stage, adapter, reservation],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; const messages: Message[] = [];
  child.stderr!.on('data', value => { stderr += String(value); });
  child.stdout!.resume();
  child.on('message', value => { messages.push(value as Message); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    const [code, signal] = await once(child, 'exit');
    if (stage.startsWith('resume-')) assert.equal(code, 0, stderr);
    else assert.equal(signal, 'SIGKILL', stderr);
    assert.equal(messages.length, 1, stderr);
    const message = messages[0]!;
    assert.equal(message.type, stage.startsWith('resume-') ? 'finished' : 'checkpoint', stderr);
    assert.equal(message.stage, stage); return message;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit').catch(() => {}); }
  }
}

for (const adapter of adapters) {
  for (const stage of ['child-genesis', 'parent-grant', 'child-activation']) {
    test(`budget crash ${adapter}: SIGKILL after durable ${stage} resumes one grant without Tool or Planner entry`, { timeout: 45000 }, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'budget-create-crash-'));
      try {
        const stopped = await worker(directory, stage, adapter);
        assert.equal(stopped.toolEntries, 0); assert.equal(stopped.modelEntries, 0);
        const repository = openRepository(adapter, directory);
        try {
          const child = (await repository.get(stopped.childId))!; const parent = (await repository.get(stopped.parentId))!;
          assert.ok(await repository.receipt(child.id, 'budget.child-genesis'));
          assert.equal(child.budgetParent!.phase, stage === 'child-activation' ? 'active' : 'pending');
          assert.equal(parent.budgetGrants?.length ?? 0, stage === 'child-genesis' ? 0 : 1);
          assert.deepEqual(totalExposure(parent), stage === 'child-genesis' ? zero() : allocation);
          assert.equal(child.attempts.length, 0); assert.equal(child.modelCalls.length, 0);
        } finally { await repository.close(); }
        const resumed = await worker(directory, 'resume-create', adapter);
        assert.equal(resumed.phase, 'active'); assert.equal(resumed.grantStatus, 'active'); assert.equal(resumed.grantCount, 1);
        assert.deepEqual(resumed.exposure, allocation); assert.equal(resumed.toolEntries, 0); assert.equal(resumed.modelEntries, 0);
        const repeated = await worker(directory, 'resume-create', adapter);
        assert.deepEqual(repeated, resumed);
        const reopened = openRepository(adapter, directory);
        try {
          const parent = (await reopened.get(stopped.parentId))!; const child = (await reopened.get(stopped.childId))!;
          assert.equal(parent.obligations.filter(value => value.kind === 'budget_reconciliation' && value.status === 'pending').length, 1);
          assert.equal((await reopened.events(parent.id, 0)).filter(value => value.type === 'budget_granted').length, 1);
          const events = await reopened.events(child.id, 0);
          assert.equal(events.filter(value => value.type === 'budget_child_pending').length, 1);
          assert.equal(events.filter(value => value.type === 'budget_child_activated').length, 1);
          assert.equal(events.filter(value => value.type === 'model_call_reserved' || value.type === 'attempt_reserved').length, 0);
        } finally { await reopened.close(); }
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  }

  for (const reservation of ['tool', 'model']) for (const stage of ['parent-draining', 'child-fence', 'parent-settlement']) {
    test(`budget crash ${adapter}: SIGKILL after ${stage} retains consumed usage and cancels unsent ${reservation} once`, { timeout: 45000 }, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'budget-revoke-crash-'));
      const consumed = zero({ toolCalls: 1, modelCalls: 1, tokens: 100, replans: reservation === 'tool' ? 1 : 0 });
      try {
        const stopped = await worker(directory, stage, adapter, reservation);
        assert.equal(stopped.toolEntries, 1); assert.equal(stopped.modelEntries, 1);
        const repository = openRepository(adapter, directory);
        try {
          const parent = (await repository.get(stopped.parentId))!; const child = (await repository.get(stopped.childId))!;
          const grant = parent.budgetGrants![0]!;
          assert.equal(grant.status, stage === 'parent-settlement' ? 'settled' : 'draining');
          assert.equal(child.budgetParent!.phase, stage === 'parent-draining' ? 'active' : 'draining');
          assert.deepEqual(grantExposure(grant), stage === 'parent-settlement' ? consumed : allocation);
          const unsent = reservation === 'tool' ? child.attempts.find(value => value.taskId === 'unsent')! : child.modelCalls[1]!;
          assert.equal(unsent.status, stage === 'parent-draining' ? 'reserved' : 'cancelled');
          assert.equal(child.budget.used.toolCalls, 1); assert.equal(child.budget.used.modelCalls, 1); assert.equal(child.budget.used.tokens, 100);
          assert.equal(parent.obligations.filter(value => value.kind === 'budget_reconciliation' && value.status === 'pending').length, stage === 'parent-settlement' ? 0 : 1);
        } finally { await repository.close(); }
        const resumed = await worker(directory, 'resume-revoke', adapter, reservation);
        assert.equal(resumed.phase, 'draining'); assert.equal(resumed.grantStatus, 'settled'); assert.equal(resumed.grantCount, 1);
        assert.deepEqual(resumed.exposure, consumed); assert.equal(resumed.toolEntries, 1); assert.equal(resumed.modelEntries, 1);
        const repeated = await worker(directory, 'resume-revoke', adapter, reservation);
        assert.deepEqual(repeated, resumed);
        const reopened = openRepository(adapter, directory);
        try {
          const parent = (await reopened.get(stopped.parentId))!; const child = (await reopened.get(stopped.childId))!;
          const grant = parent.budgetGrants![0]!;
          assert.deepEqual(grant.accounted, consumed); assert.deepEqual(grant.reserved, zero()); assert.equal(grant.unmeasuredModelCalls, 0);
          assert.equal(child.budget.reservedToolCalls, 0); assert.equal(child.budget.reservedModelCalls, 0); assert.equal(child.budget.reservedTokens, 0);
          assert.equal(child.budget.used.unmeasuredModelCalls, 0); assert.equal(parent.evidence.length, 0); assert.equal(child.evidence.length, 1);
          assert.equal(parent.obligations.filter(value => value.kind === 'budget_reconciliation').length, 1);
          assert.equal(parent.obligations.find(value => value.kind === 'budget_reconciliation')!.status, 'satisfied');
          const parentEvents = await reopened.events(parent.id, 0); const childEvents = await reopened.events(child.id, 0);
          assert.equal(parentEvents.filter(value => value.type === 'budget_granted').length, 1);
          assert.equal(parentEvents.filter(value => value.type === 'budget_revoke_requested').length, 1);
          assert.equal(childEvents.filter(value => value.type === 'budget_child_fenced').length, 1);
          assert.equal(childEvents.filter(value => value.type === 'attempt_dispatched').length, 1);
          assert.equal(childEvents.filter(value => value.type === 'model_call_dispatched').length, 1);
          assert.equal(child.attempts.length, reservation === 'tool' ? 2 : 1); assert.equal(child.modelCalls.length, reservation === 'model' ? 2 : 1);
        } finally { await reopened.close(); }
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  }
}
