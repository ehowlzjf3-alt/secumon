import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openLocalProfile } from '../presentation/local-profile.js';
import { conversationView } from '../presentation/conversation-view.js';
import { transact } from '../application/work-transactions.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
async function completed() {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-view-')); const profile = await openLocalProfile(dir);
  const scenario = profile.scenarios.find(s => s.id === 'documents-simple')!;
  const accepted = await profile.workflow.accept(actor, { messageId: 'view', binding: { ...actor, channel: 'cli', conversationId: 'view', recipientId: actor.principalId, destination: 'local' }, goal: scenario.goal, policy: scenario.policy,
    limits: { toolCalls: 5, modelCalls: 0, tokens: 10000, replans: 3, wallTimeMs: 120000 }, completionRequiresDelivery: true });
  const id = accepted.workId; await profile.runtime.submitPlan(id, 'plan', { baseStateRevision: accepted.state.revision, baseGoalRevision: 1, basePlanRevision: 0, reason: 'Read', hypotheses: [],
    tasks: [{ id: 'read', description: 'Read original', dependsOn: [], toolId: 'fixture.read', toolVersion: '1', input: { evidenceIds: ['doc-current'] }, effect: 'read', maxAttempts: 2, satisfies: ['retention'] }] });
  const result = await profile.workflow.run(id, actor); assert.equal(result.control.kind, 'complete');
  return { profile, id, scenario, close: async () => { await profile.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('a late counterexample prevents a previously delivered answer from being displayed as the current result', async () => {
  const f = await completed();
  try {
    assert.equal((await conversationView(f.profile, f.id, actor, 'view')).latest?.kind, 'result');
    await transact(f.profile.services, f.id, 'late-source', 'evidence_received', {}, state => {
      state.evidence.push({ ...state.evidence[0]!, id: 'counter', sourceId: 'counter', lineageId: 'counter', locator: 'fixture://counter', facts: { 'retention.days': 90 } });
    });
    const view = await conversationView(f.profile, f.id, actor, 'view'); assert.equal(view.snapshot.resultReady, false); assert.equal(view.latest, undefined);
  } finally { await f.close(); }
});

test('a public snapshot retries a goal change during artifact verification', async () => {
  const f = await completed();
  try {
    const exists = f.profile.services.artifacts.exists.bind(f.profile.services.artifacts); let change = true;
    f.profile.services.artifacts.exists = async ref => {
      if (change) { change = false; await f.profile.runtime.command(f.id, 'goal-during-read', actor, 1, { kind: 'goal', expectedControlRevision: (await f.profile.runtime.state(f.id)).executionControl?.revision ?? 1, goal: { ...f.scenario.goal, revision: 2 } }); }
      return exists(ref);
    };
    const snapshot = await f.profile.conversation.snapshot(f.id, actor);
    assert.equal(snapshot.goalRevision, 2); assert.equal(snapshot.resultReady, false); assert.equal(snapshot.resultDelivery, 'not_prepared');
  } finally { await f.close(); }
});

test('conversation view keeps message selection and public status on the same revision', async () => {
  const f = await completed();
  try {
    const messages = f.profile.services.sink.messages.bind(f.profile.services.sink); let change = true;
    f.profile.services.sink.messages = async (...args) => {
      const value = await messages(...args);
      if (change) { change = false; await f.profile.runtime.command(f.id, 'goal-during-messages', actor, 1, { kind: 'goal', expectedControlRevision: (await f.profile.runtime.state(f.id)).executionControl?.revision ?? 1, goal: { ...f.scenario.goal, revision: 2 } }); }
      return value;
    };
    const view = await conversationView(f.profile, f.id, actor, 'view'); assert.equal(view.snapshot.goalRevision, 2); assert.equal(view.latest, undefined);
  } finally { await f.close(); }
});

test('cancelled work displays its status rather than its historical delivered result', async () => {
  const f = await completed();
  try {
    await f.profile.runtime.command(f.id, 'cancel', actor, 1, { kind: 'cancel', reason: 'Stop' });
    const view = await conversationView(f.profile, f.id, actor, 'view'); assert.equal(view.snapshot.status, 'cancelled'); assert.equal(view.latest, undefined);
  } finally { await f.close(); }
});
