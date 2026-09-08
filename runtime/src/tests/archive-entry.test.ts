import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVE_CONTENT, acceptArchive, archiveAttemptResult, archiveProfileFixture, archiveTask,
  freshSignal, personalArchiveCards, prepareArchive } from './archive-acceptance-fixture.js';

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: registered archive search, explicit get and answer keep references outside Evidence and personal memory`, async t => {
  const f = archiveProfileFixture(t, { backend }), profile = await f.open();
  assert.deepEqual(await personalArchiveCards(profile), []);
  const accepted = await acceptArchive(profile, 'read-reference');
  const run = await profile.workflow.run(accepted.workId, profile.executionActor, { maxSteps: 24 });
  assert.equal(run.control.kind, 'complete', JSON.stringify(run));
  const state = await profile.runtime.state(accepted.workId);
  assert.equal(state.status, 'completed'); assert.equal(state.progress?.policy.maxUnproductiveSteps, 3);
  assert.deepEqual(state.attempts.map(attempt => attempt.toolId), ['archive.search', 'archive.get']);
  assert.ok(state.attempts.every(attempt => attempt.adopted && attempt.status === 'succeeded'));
  assert.deepEqual(state.evidence, []); assert.deepEqual(state.generatedAnswer?.evidenceIds, []);
  const delivery = (await profile.services.state.deliveries(state.id)).find(value => value.kind === 'result' && value.status === 'delivered');
  assert.ok(delivery); assert.match(delivery.text, /ARCHIVE_ORIGINAL/); assert.match(delivery.text, /source-v1/);
  assert.equal(f.source().observed.searches, 1); assert.deepEqual(f.source().observed.gets, ['case-1']);
  assert.equal(f.source().observed.mutations.length, 0);
  const afterSearch = f.inputs.find(input => input.packet.toolObservations?.some(item => item.toolId === 'archive.search'));
  assert.ok(afterSearch);
  const card = afterSearch.packet.toolObservations!.find(item => item.toolId === 'archive.search')!;
  assert.equal(JSON.stringify(card.output).includes(ARCHIVE_CONTENT.body), false);
  assert.equal(JSON.stringify(afterSearch.packet.evidence).includes(ARCHIVE_CONTENT.body), false);
  for (const attempt of state.attempts) {
    const original = await archiveAttemptResult(profile, state.id, attempt.id);
    assert.deepEqual(original.result.evidence, []); assert.deepEqual(original.result.artifacts, []);
  }
  assert.deepEqual(await personalArchiveCards(profile), []);
  const history = await profile.sessions.history(profile.actor, accepted.sessionId, profile.policy, { limit: 100 });
  assert.equal(history.entries.filter(entry => entry.kind === 'result').length, 1);
  await profile.close();
  const reopened = await f.open(), persisted = await reopened.runtime.state(state.id);
  assert.deepEqual(persisted.attempts, state.attempts); assert.deepEqual(persisted.evidence, []);
  assert.deepEqual(await personalArchiveCards(reopened), []);
  assert.equal(f.source().observed.searches, 0); assert.deepEqual(f.source().observed.gets, []);
});

for (const repeatRead of ['search', 'get'] as const) test(`registered archive repeated ${repeatRead} with fresh task IDs stops at the default no-progress limit`, async t => {
  const f = archiveProfileFixture(t, { repeatRead }), profile = await f.open();
  const accepted = await acceptArchive(profile, 'repeated-' + repeatRead);
  const run = await profile.workflow.run(accepted.workId, profile.executionActor, { maxSteps: 24 });
  assert.equal(run.control.kind, 'blocked', JSON.stringify(run)); assert.equal(run.control.reason, 'no_progress_limit');
  const state = await profile.runtime.state(accepted.workId);
  assert.equal(state.status, 'blocked'); assert.equal(state.statusReason, 'no_progress_limit');
  assert.equal(state.progress?.policy.maxUnproductiveSteps, 3); assert.equal(state.progress?.consecutiveUnproductive, 3);
  const repeated = state.attempts.filter(attempt => attempt.toolId === 'archive.' + repeatRead);
  assert.ok(repeated.length >= 2, 'the guard must allow a real first read and an unchanged subsequent read');
  assert.equal(new Set(repeated.map(attempt => attempt.taskId)).size, repeated.length);
  assert.equal(new Set(repeated.map(attempt => attempt.id)).size, repeated.length);
  assert.ok(repeated.every(attempt => attempt.adopted && attempt.status === 'succeeded' && attempt.execution?.mode === 'invoked'));
  const originals = await Promise.all(repeated.map(attempt => archiveAttemptResult(profile, state.id, attempt.id)));
  for (const original of originals.slice(1)) {
    assert.notEqual(original.result.resultId, originals[0]!.result.resultId);
    assert.deepEqual(original.result.output, originals[0]!.result.output);
  }
  assert.ok((repeatRead === 'search' ? f.source().observed.searches : f.source().observed.gets.length) >= 2);
  assert.equal(f.source().observed.mutations.length, 0);
  assert.deepEqual(state.evidence, []); assert.equal(state.generatedAnswer, undefined);
  assert.deepEqual(await personalArchiveCards(profile), []);
});

test('registered archive explicit register, revise and delete use separate works in one persistent session', async t => {
  const f = archiveProfileFixture(t, { allowWrites: true, seed: false }), profile = await f.open();
  const works: string[] = [], sessions: string[] = [];
  for (const [index, kind] of (['register', 'revise', 'delete'] as const).entries()) {
    const accepted = await acceptArchive(profile, 'archive-' + kind, `${kind}: explicitly ${kind} the case-created archive reference.`);
    works.push(accepted.workId); sessions.push(accepted.sessionId);
    const run = await profile.workflow.run(accepted.workId, profile.executionActor, { maxSteps: 16 });
    assert.equal(run.control.kind, 'complete', JSON.stringify(run));
    const state = await profile.runtime.state(accepted.workId);
    assert.deepEqual(state.attempts.map(attempt => attempt.toolId), ['archive.' + kind]);
    assert.equal(state.attempts[0]!.effectState, 'confirmed'); assert.equal(state.attempts[0]!.adopted, true);
    assert.deepEqual(state.evidence, []); assert.deepEqual(state.generatedAnswer?.evidenceIds, []);
    const original = await archiveAttemptResult(profile, state.id, state.attempts[0]!.id);
    assert.equal((original.result.output as { receipt: { revision: number } }).receipt.revision, index + 1);
    assert.deepEqual(original.result.evidence, []); assert.equal(original.result.effectReceipt, undefined);
    const document = await f.source().file.get('case-created', freshSignal());
    if (kind === 'delete') assert.equal(document, null);
    else { assert.equal(document?.revision, index + 1); assert.equal(document?.sourceVersion, `source-v${index + 1}`); }
  }
  assert.equal(new Set(works).size, 3); assert.equal(new Set(sessions).size, 1);
  assert.equal(f.source().observed.mutations.length, 3);
  for (const [index, command] of f.source().observed.mutations.entries()) {
    const state = await profile.runtime.state(works[index]!);
    assert.equal(command.commandId, JSON.stringify(['archive', state.id, state.attempts[0]!.id]));
  }
  assert.deepEqual(await personalArchiveCards(profile), []);
});

async function lostMutation(t: Parameters<typeof archiveProfileFixture>[0], backend: 'sqlite' | 'file-journal' = 'sqlite') {
  const f = archiveProfileFixture(t, { backend, allowWrites: true, seed: false }), profile = await f.open();
  const source = f.source(); source.controls.reply = 'lost_after_commit'; source.controls.receipts = 'null';
  const accepted = await acceptArchive(profile, 'lost-register', 'register: explicitly register the lost-response archive reference.');
  const attempt = await prepareArchive(profile, accepted.workId, archiveTask('register', { id: 'lost-case', expectedRevision: 0, content: ARCHIVE_CONTENT }));
  await profile.runtime.execute(accepted.workId, attempt.id);
  await profile.runtime.settlePending(attempt.id); await profile.runtime.adopt(accepted.workId, attempt.id);
  const before = await archiveAttemptResult(profile, accepted.workId, attempt.id);
  assert.equal(before.result.status, 'error'); assert.equal(before.result.effectState, 'unknown');
  assert.equal(before.attempt.effectState, 'unknown'); assert.equal(before.attempt.adopted, false);
  assert.equal(before.state.obligations.find(item => item.id === 'effect:' + attempt.id)?.status, 'pending');
  assert.equal(source.observed.mutations.length, 1);
  assert.equal((await source.file.get('lost-case', freshSignal()))?.revision, 1);
  assert.ok(profile.archiveReconciliation);
  const dispatch = await profile.services.state.receipt(accepted.workId, 'dispatch:' + attempt.id); assert.ok(dispatch);
  return { f, profile, source, accepted, attempt, before, dispatch };
}

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: archive lost mutation response recovers from the original receipt after reopen without repeating a write`, async t => {
  const { f, profile, source, accepted, attempt, before, dispatch } = await lostMutation(t, backend);
  const originalReceipt = await source.file.receipt(source.observed.mutations[0]!.commandId, freshSignal()); assert.ok(originalReceipt);
  await profile.close();
  const reopened = await f.open(); assert.ok(reopened.archiveReconciliation);
  const recovered = await reopened.archiveReconciliation.recover(accepted.workId, attempt.id);
  const current = recovered.attempts.find(item => item.id === attempt.id)!;
  assert.equal(current.effectState, 'confirmed'); assert.equal(current.adopted, false);
  assert.equal(current.effectReceipt?.origin, 'reconciliation'); assert.equal(current.effectReceipt?.outcome, 'applied');
  assert.equal(recovered.obligations.find(item => item.id === 'effect:' + attempt.id)?.status, 'satisfied');
  assert.notEqual(recovered.status, 'completed'); assert.equal(recovered.generatedAnswer, undefined);
  assert.equal(current.owner, before.attempt.owner); assert.deepEqual(current.execution, before.attempt.execution);
  assert.deepEqual(current.resultArtifact, before.attempt.resultArtifact);
  assert.deepEqual(await reopened.services.state.receipt(accepted.workId, 'dispatch:' + attempt.id), dispatch);
  const original = await archiveAttemptResult(reopened, accepted.workId, attempt.id);
  assert.deepEqual(original.bytes, before.bytes); assert.deepEqual(original.result, before.result);
  assert.equal(await reopened.services.effects!.current(recovered), true);
  const again = await reopened.archiveReconciliation.recover(accepted.workId, attempt.id);
  assert.deepEqual(again.attempts, recovered.attempts);
  assert.equal(f.sources.reduce((sum, item) => sum + item.observed.mutations.length, 0), 1);
  assert.ok(f.source().observed.receipts.length > 0);
  assert.ok(f.source().observed.receipts.every(commandId => commandId === originalReceipt.commandId));
  assert.deepEqual(await f.source().file.receipt(originalReceipt.commandId, freshSignal()), originalReceipt);
  assert.deepEqual(await personalArchiveCards(reopened), []);
});

test('archive null receipt remains unknown through repeated recovery and is never treated as permission to repeat mutation', async t => {
  const { profile, source, accepted, attempt, before } = await lostMutation(t);
  for (let retry = 0; retry < 2; retry++) {
    const unknown = await profile.archiveReconciliation!.recover(accepted.workId, attempt.id);
    assert.deepEqual(unknown.attempts, before.state.attempts);
    assert.equal(unknown.obligations.find(item => item.id === 'effect:' + attempt.id)?.status, 'pending');
    assert.notEqual(unknown.status, 'completed');
  }
  assert.equal(source.observed.mutations.length, 1);
  source.controls.receipts = 'normal';
  const recovered = await profile.archiveReconciliation!.recover(accepted.workId, attempt.id);
  assert.equal(recovered.attempts[0]!.effectState, 'confirmed'); assert.equal(source.observed.mutations.length, 1);
  assert.deepEqual((await archiveAttemptResult(profile, accepted.workId, attempt.id)).bytes, before.bytes);
});

test('archive mismatched recovery receipt leaves the original failure and pending reconciliation untouched', async t => {
  const { profile, source, accepted, attempt, before } = await lostMutation(t);
  source.controls.receipts = 'wrong_digest';
  await assert.rejects(profile.archiveReconciliation!.recover(accepted.workId, attempt.id), /archive_result_invalid/);
  const rejected = await archiveAttemptResult(profile, accepted.workId, attempt.id);
  assert.deepEqual(rejected.bytes, before.bytes); assert.deepEqual(rejected.state.attempts, before.state.attempts);
  assert.equal(rejected.state.obligations.find(item => item.id === 'effect:' + attempt.id)?.status, 'pending');
  assert.equal(source.observed.mutations.length, 1); assert.deepEqual(rejected.state.evidence, []);
  assert.deepEqual(await personalArchiveCards(profile), []);
});
