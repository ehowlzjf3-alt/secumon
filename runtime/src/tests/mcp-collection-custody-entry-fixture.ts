import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactRef, Attempt, TaskSpec } from '../domain/model.js';
import { ToolBroker } from '../application/tool-broker.js';
import { ReadCheckpointReader } from '../application/read-checkpoint-store.js';
import { ResumePacketSchema } from '../application/recovery-contracts.js';
import { transact } from '../application/work-transactions.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { assertMcpPeersStopped, initializeMcpAgent, mcpFixtureIdentityOptions } from './mcp-agent-profile-helper.js';
import { COLLECTION_ENTRY_TEXT, createCollectionEntryHost, entryAudit, entryObservations, runtimeRoot,
  type CollectionEntryOptions } from './mcp-collection-entry-fixture.js';

function originalIdentity(attempt: Attempt) {
  return { id: attempt.id, taskId: attempt.taskId, toolId: attempt.toolId, toolVersion: attempt.toolVersion,
    owner: attempt.owner, scope: attempt.scope, startedAt: attempt.startedAt, leaseUntil: attempt.leaseUntil,
    inputDigest: attempt.inputDigest, contractDigest: attempt.contractDigest,
    goalRevision: attempt.goalRevision, planRevision: attempt.planRevision };
}

/** One real decoded response; no crash, page projection, successor, or pre-entry usage write. */
export async function seedCollectionCustodyEntry(t: TestContext, backend: 'sqlite' | 'file-journal', channel: 'cli' | 'web') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'collection-custody-entry-'))), directory = join(base, 'agent');
  const options: CollectionEntryOptions = { directory, backend, scenario: 'complete', now: 100_000,
    auditFile: join(base, 'peer.jsonl'), hostAuditFile: join(base, 'host.jsonl') };
  const realNow = Date.now, started = realNow();
  // Preserve the production clock object and original timestamps across actual CLI/HTTP lifetimes.
  t.mock.method(Date, 'now', () => options.now + realNow() - started);
  let profile: AgentTurnProfile | undefined, extraClose: (() => Promise<void>) | undefined;
  t.after(async () => {
    const errors: unknown[] = [];
    try { await extraClose?.(); } catch (error) { errors.push(error); }
    try { await profile?.close(); } catch (error) { errors.push(error); }
    try { if (existsSync(options.auditFile)) assertMcpPeersStopped(options.auditFile); } catch (error) { errors.push(error); }
    // Never remove the lifecycle lease's parent before closing both profile/server lifetimes.
    if (!errors.length) rmSync(base, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, 'collection_custody_entry_cleanup_failed');
  });
  initializeMcpAgent(directory, backend);
  let workId = '', narrowed = 0;
  profile = await openAgentTurnProfile(directory, { provider: 'registered' }, createCollectionEntryHost(options, 'online', async () => {
    assert.ok(profile && workId); assert.equal(++narrowed, 1);
    // The real page receipt has committed. Keep it and its original labels, then revoke body access before projection.
    await transact(profile.services, workId, 'custody-entry-narrow', 'fixture_policy_narrowed', {}, next => {
      next.policy.allowedLabels = [];
    });
  }));
  const p = profile, conversationId = channel === 'cli' ? 'terminal' : 'collection-custody-entry';
  const session = await p.sessions.open(p.actor, { channel, conversationId });
  const accepted = await p.turns.accept(p.actor, { sessionId: session.scope.sessionId, messageId: 'original-request',
    rawText: COLLECTION_ENTRY_TEXT, mode: 'auto',
    binding: { ...p.executionActor, channel, conversationId, recipientId: p.actor.principalId, destination: 'local' },
    scope: p.scope, policy: { ...p.policy, allowedLabels: [] }, limits: p.limits });
  workId = accepted.workId;
  // The real CLI ask delivers its public intake acknowledgement before entering the workflow.
  if (channel === 'cli') await p.outbox.flush(workId, p.actor);
  const originalInput = await p.sessions.repository.input(session.scope, 'original-request');
  assert.ok(originalInput); assert.deepEqual(originalInput.labels, []);
  // The immutable request is public from acceptance. A separate explicit grant permits this one protected read.
  await transact(p.services, workId, 'custody-entry-grant', 'fixture_read_authorized', {}, next => {
    next.policy.allowedLabels = [...p.policy.allowedLabels];
  });
  const state = await p.runtime.state(workId), definition = p.contracts.visible(p.policy).find(value => value.id === 'fixture.collection');
  assert.ok(definition);
  const task: TaskSpec = { id: 'original-collection', description: 'Read the selected local records once', toolId: definition.id,
    toolVersion: definition.version, effect: 'read', input: { ids: ['a', 'b'] }, dependsOn: [], satisfies: [], maxAttempts: 1 };
  await p.runtime.submitPlan(workId, 'custody-entry-plan', { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
    basePlanRevision: 0, reason: 'Seed the original call; the general entry must account without reading its protected body', tasks: [task], hypotheses: [] });
  const reserved = await p.runtime.reserve(workId, task.id); await p.runtime.dispatch(workId, reserved.id);
  const broker = new ToolBroker(p.services.state, p.contracts, p.services.digester, p.services.clock,
    undefined, undefined, undefined, p.services);
  // ReadCollections rechecks the exact original policy after source.fetch, before accepting or publishing a page.
  await assert.rejects(broker.invoke(workId, reserved.id, p.runtime.owner, new AbortController().signal),
    { message: 'read_scope_changed' });
  assert.equal(narrowed, 1);
  const saved = await p.runtime.state(workId), attempt = saved.attempts.find(value => value.id === reserved.id)!;
  assert.equal(attempt.status, 'running'); assert.equal(attempt.execution?.mode, 'unreported'); assert.ok(attempt.readProgress);
  const head = attempt.readProgress.head, originalPolicy = structuredClone(p.policy);
  const checkpoint = await new ReadCheckpointReader({ ...saved, policy: originalPolicy }, p.services.artifacts, p.services.digester).load(head);
  assert.equal(checkpoint.calls.length, 1); assert.equal(checkpoint.calls[0]!.status, 'intent');
  assert.equal(checkpoint.calls[0]!.response, null); assert.equal(checkpoint.collection.pages.length, 0);
  const request = checkpoint.calls[0]!.request, responseId = `mcp-page:${attempt.id}:${request.requestId}`;
  const response = await p.services.state.receipt(workId, responseId); assert.ok(response);
  const raw = response.state.artifacts.at(-1); assert.ok(raw);
  const envelope = JSON.parse(new TextDecoder().decode(await p.services.artifacts.get(raw, originalPolicy)));
  assert.equal(envelope.kind, 'mcp_collection_response'); assert.equal(envelope.failure, null); assert.equal(envelope.transportCalls, 1);
  assert.equal(envelope.request.requestId, request.requestId);
  assert.equal(envelope.value.structuredContent.dataset, 'documents-v1');
  assert.deepEqual(envelope.value.structuredContent.records.map((value: { id: string; record: { value: number } }) =>
    ({ id: value.id, value: value.record.value })), [{ id: 'a', value: 30 }, { id: 'b', value: 30 }]);
  const responseEvent = (await p.services.state.events(workId, 0)).find(value => value.type === 'mcp_collection_response_recorded');
  assert.ok(responseEvent);
  const payload = responseEvent.data['payload'];
  assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
  assert.deepEqual(payload['custody'],
    { schemaVersion: 1, outcome: 'returned', transportCalls: 1, recordedAtKind: 'decoded_response' });
  assert.deepEqual(raw.labels, [...originalPolicy.allowedLabels].sort());
  assert.ok(envelope.recordedAt < Math.min(attempt.leaseUntil, saved.deadlineAt));
  await assert.rejects(p.services.artifacts.get(raw, saved.policy), /artifact_access_denied/);
  const immutableRefs = structuredClone(saved.artifacts);
  await p.close(); profile = undefined; assertMcpPeersStopped(options.auditFile);

  const withStores = async <T>(read: (stores: Awaited<ReturnType<typeof openAgentStores>>) => Promise<T>) => {
    const stores = await openAgentStores(new FileAgentProfileStore(runtimeRoot), directory, undefined, mcpFixtureIdentityOptions(options));
    try { return await read(stores); } finally { await stores.close(); }
  };
  const inspect = (bodyAccess: 'denied' | 'permitted' = 'denied') => withStores(async stores => {
    const current = await stores.state.get(workId); assert.ok(current);
    const selected = current.attempts.find(value => value.id === attempt.id); assert.ok(selected);
    const receipts = await Promise.all([`dispatch:${attempt.id}`, `read:${attempt.id}:${head.id}`, responseId]
      .map(id => stores.state.receipt(workId, id)));
    const originals = await Promise.all(immutableRefs.map(async ref => ({ ref, bytes: Array.from(await stores.artifacts.get(ref, originalPolicy)) })));
    if (bodyAccess === 'denied') {
      await assert.rejects(stores.artifacts.get(raw, current.policy), /artifact_access_denied/);
      await assert.rejects(stores.artifacts.get(head, current.policy), /artifact_access_denied/);
    } else {
      assert.deepEqual(await stores.artifacts.get(raw, current.policy), await stores.artifacts.get(raw, originalPolicy));
      assert.deepEqual(await stores.artifacts.get(head, current.policy), await stores.artifacts.get(head, originalPolicy));
    }
    return { state: current, attempt: selected, receipts, originals,
      checkpoint: await new ReadCheckpointReader({ ...current, policy: originalPolicy }, stores.artifacts, new Sha256Digester()).load(head),
      receive: await stores.state.receipt(workId, `receive:${attempt.id}`),
      reconciliation: await stores.state.receipt(workId, `read-reconcile:${attempt.id}:${head.id}`),
      input: await stores.sessions.input(session.scope, 'original-request'),
      history: await stores.sessions.history(session.scope, originalPolicy, { limit: 100 }), events: await stores.state.events(workId, 0) };
  });
  const before = await inspect();
  assert.ok(before.receipts.every(Boolean)); assert.equal(before.attempt.execution?.usage.transportCalls, null);
  const unchangedOriginal = (after: Awaited<ReturnType<typeof inspect>>) => {
    assert.deepEqual(after.receipts, before.receipts); assert.deepEqual(after.originals, before.originals);
    assert.deepEqual(after.checkpoint, checkpoint); assert.deepEqual(originalIdentity(after.attempt), originalIdentity(before.attempt));
    assert.deepEqual(after.attempt.readProgress, before.attempt.readProgress);
    assert.deepEqual(after.input, originalInput); assert.deepEqual(after.state.goal, before.state.goal);
    assert.deepEqual(after.state.plan, before.state.plan); assert.deepEqual(after.state.policy, before.state.policy);
    for (const ref of immutableRefs) assert.deepEqual(after.state.artifacts.find(value => value.id === ref.id), ref);
    assert.equal(after.state.attempts.length, 1); assert.deepEqual(after.state.evidence, []);
    assert.equal(after.attempt.resultId, null); assert.equal(after.attempt.resultArtifact, null); assert.equal(after.attempt.adopted, false);
    assert.equal(after.receive, null); assert.equal(after.reconciliation, null); assert.equal(after.state.generatedAnswer ?? null, null);
    assert.equal(after.state.budget.used.toolCalls, before.state.budget.used.toolCalls);
    assert.equal(after.history.entries.filter(entry => entry.role === 'user' && entry.text === COLLECTION_ENTRY_TEXT).length, 1);
    assert.equal(after.history.entries.some(entry => entry.role === 'assistant' && entry.kind === 'result'), false);
  };
  unchangedOriginal(before);
  const noBody = (value: unknown) => {
    const text = JSON.stringify(value);
    for (const forbidden of ['mcp_collection_response', 'structuredContent', 'documents-v1', 'doc-origin', 'document:a', 'document:b',
      '"collection.record"', '"value":30', 'a=30', 'b=30', '합계=60', raw.id, raw.sha256, head.id, head.sha256])
      assert.equal(text.includes(forbidden), false, `protected source exposed: ${forbidden}`);
    assert.doesNotMatch(text, /"facts"\s*:/);
  };
  const noExtraExecution = (modelCalls: number) => {
    const audit = entryAudit(options), observations = entryObservations(options);
    assert.equal(audit.filter(row => row.event === 'start').length, 1);
    assert.equal(audit.filter(row => row.event === 'call').length, 1);
    assert.equal(audit.filter(row => row.event === 'method' && row.method === 'tools/call').length, 1);
    assert.equal(observations.filter(row => row.kind === 'fetch').length, 1);
    assert.equal(observations.filter(row => row.kind === 'project').length, 0);
    assert.equal(observations.filter(row => row.kind === 'compact').length, 0);
    const turns = observations.filter(row => row.kind === 'turn'); assert.equal(turns.length, modelCalls);
    for (const turn of turns) { assert.equal(turn.result.kind, 'question'); noBody(turn.input); }
    assertMcpPeersStopped(options.auditFile);
  };
  noExtraExecution(0);
  // Expiration closes the original attempt's call set without rewriting its owner, lease, or receipt timestamps.
  options.now = attempt.leaseUntil + 1;
  return { options, directory, workId, sessionId: session.scope.sessionId, conversationId, before, inspect, unchangedOriginal,
    originalPolicy: structuredClone(originalPolicy),
    retainedOriginal: { options, workId, attemptId: attempt.id, scope: session.scope, raw, originalHead: head, responseCommandId: responseId },
    noBody, noExtraExecution, cleanupWith(close: () => Promise<void>) { extraClose = close; },
    readResume: (ref: ArtifactRef) => withStores(async stores => {
      const current = await stores.state.get(workId); assert.ok(current);
      return ResumePacketSchema.parse(JSON.parse(new TextDecoder().decode(await stores.artifacts.get(ref, current.policy))));
    }) };
}

export type CollectionCustodyEntryFixture = Awaited<ReturnType<typeof seedCollectionCustodyEntry>>;
