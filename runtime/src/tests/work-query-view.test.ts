import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalProfile } from '../presentation/local-profile.js';
import { LocalWorkbench } from '../presentation/local-workbench.js';
import { transact } from '../application/work-transactions.js';
import { adapters, type Adapter } from './state-conformance-helpers.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
async function fixture(t: TestContext, adapter: Adapter) {
  const directory = await mkdtemp(join(tmpdir(), 'work-query-view-'));
  const profile = await openLocalProfile(directory, adapter); const workbench = new LocalWorkbench(profile);
  t.after(async () => { await workbench.drain(); await profile.close(); await rm(directory, { recursive: true, force: true }); });
  const accept = (requestId: string) => workbench.accept({ requestId, scenarioId: 'documents-simple', mode: 'auto' });
  return { profile, workbench, accept };
}

for (const adapter of adapters) {
  test(`${adapter}: page options cannot replace the trusted actor or conversation route`, async t => {
    const f = await fixture(t, adapter); const accepted = await f.accept('trusted-route');
    const untrusted = { limit: 20, tenantId: 'other', principalId: 'other', channel: 'cli', conversationId: 'other' };
    const page = await f.profile.conversation.listPage(actor, 'web', 'web', untrusted);
    assert.deepEqual(page.workIds, [accepted.workId]); assert.equal(page.nextCursor, null);
  });

  test(`${adapter}: diagnostics uses metadata through the current revision and never requests full event payloads`, async t => {
    const f = await fixture(t, adapter); const { workId } = await f.accept('diagnostic-history');
    const state = f.profile.services.state; let before = (await state.get(workId))!;
    const initialEvents = (await state.events(workId, 0)).length;
    for (let revision = 0; revision < 3; revision++) {
      const next = { ...before, revision: before.revision + 1, updatedAt: before.updatedAt + 1 };
      const committed = await state.commit({ workId, expectedRevision: before.revision, commandId: `history-${revision}`, commandDigest: `history-${revision}`, next,
        events: Array.from({ length: 40 }, (_, index) => ({ type: `history-${revision}-${index}`, at: next.updatedAt, data: { privateBody: 'UNPROJECTED_EVENT_PAYLOAD'.repeat(100) } })), deliveries: [] });
      assert.equal(committed.kind, 'committed'); before = next;
    }
    const original = state.recentEventMetadata.bind(state); const revisions: number[] = [];
    state.recentEventMetadata = async (id, query) => { revisions.push(query.throughRevision); assert.equal(query.limit, 50); return original(id, query); };
    state.events = async () => { throw new Error('full_events_not_allowed_for_view'); };
    state.commit = async () => { throw new Error('view_must_not_commit'); };
    f.profile.services.artifacts.put = async () => { throw new Error('view_must_not_put'); };
    f.profile.services.sink.send = async () => { throw new Error('view_must_not_send'); };
    const result = await f.workbench.view(workId, 'diagnostics'); assert.equal(result.kind, 'snapshot');
    if (result.kind !== 'snapshot') return;
    assert.equal(result.view.diagnostics!.events.length, 50); assert.equal(result.view.diagnostics!.omittedEvents, initialEvents + 120 - 50);
    assert.deepEqual(result.view.diagnostics!.events.map(event => event.sequence), Array.from({ length: 50 }, (_, i) => initialEvents + 120 - 49 + i));
    assert.equal(JSON.stringify(result).includes('UNPROJECTED_EVENT_PAYLOAD'), false);
    assert.deepEqual(revisions, [before.revision, before.revision]); assert.deepEqual(await state.get(workId), before);
  });

  test(`${adapter}: a denied-only list page stops after one candidate page and continues after a detached anchor`, async t => {
    const f = await fixture(t, adapter);
    for (let i = 0; i < 43; i++) await f.accept(`candidate-${i}`);
    const state = f.profile.services.state;
    const initial = await state.conversationWorkPage({ ...actor, channel: 'web', conversationId: 'web', limit: 20 });
    assert.equal(initial.workIds.length, 20); assert.ok(initial.nextCursor);
    for (const workId of initial.workIds) await transact(f.profile.services, workId, 'hide-screen', 'fixture_changed', {}, work => {
      work.policy.disclosure!.destinations[0]!.surfaces = ['tool', 'channel'];
    });
    const read = f.profile.workView.read.bind(f.profile.workView); let viewCalls = 0;
    f.profile.workView.read = async (...args) => { viewCalls++; return read(...args); };
    f.profile.conversation.list = async () => { throw new Error('whole_list_not_allowed'); };
    const first = await f.workbench.list(); assert.deepEqual(first.items, []); assert.ok(first.nextCursor); assert.equal(viewCalls, 20);
    for (const workId of initial.workIds) assert.equal(first.nextCursor!.includes(workId), false);
    const anchor = initial.workIds.at(-1)!;
    await f.profile.conversation.attach(anchor, actor, { ...actor, channel: 'cli', conversationId: 'replacement', destination: 'local', recipientId: actor.principalId });
    await transact(f.profile.services, anchor, 'detach-anchor', 'fixture_changed', {}, work => {
      work.conversation!.bindings = work.conversation!.bindings.filter(binding => binding.channel !== 'web');
      work.conversation!.primaryBindingId = work.conversation!.bindings[0]!.id;
    });
    viewCalls = 0;
    const second = await f.workbench.list(first.nextCursor!); assert.equal(second.items.length, 20); assert.ok(second.nextCursor); assert.equal(viewCalls, 40);
    const third = await f.workbench.list(second.nextCursor!); assert.equal(third.items.length, 3); assert.equal(third.nextCursor, null);
    const seen = [...second.items, ...third.items].map(item => item.workId);
    assert.equal(new Set(seen).size, 23); assert.equal(seen.some(id => initial.workIds.includes(id)), false);
  });

  test(`${adapter}: list cursor handles expire, stay instance scoped, and are evicted without resolving all IDs`, async t => {
    const f = await fixture(t, adapter); let now = 1000; f.profile.services.clock.now = () => now;
    f.profile.conversation.listPage = async () => ({ workIds: [], nextCursor: 'PRIVATE_ADAPTER_POSITION' });
    f.profile.conversation.list = async () => { throw new Error('whole_list_not_allowed'); };
    const first = (await f.workbench.list()).nextCursor!; assert.ok(first); assert.equal(first.includes('PRIVATE_ADAPTER_POSITION'), false);
    const other = new LocalWorkbench(f.profile);
    await assert.rejects(other.list(first), /web_list_cursor_invalid/); await other.drain();
    now += 900000; await assert.rejects(f.workbench.list(first), /web_list_cursor_invalid/);
    const oldest = (await f.workbench.list()).nextCursor!;
    for (let i = 0; i < 128; i++) await f.workbench.list();
    await assert.rejects(f.workbench.list(oldest), /web_list_cursor_invalid/);
  });
}
