import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ReadCheckpointReader } from '../application/read-checkpoint-store.js';
import type { ArtifactRef, TaskSpec } from '../domain/model.js';
import type { SessionScope } from '../domain/session.js';
import { McpStdioClient } from '../infrastructure/mcp-stdio-client.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { runAgentTurnCli } from '../presentation/agent-turn-cli.js';
import { initializeMcpAgent } from './mcp-agent-profile-helper.js';
import { COLLECTION_ENTRY_TAIL, COLLECTION_ENTRY_TEXT, createCollectionEntryHost, entryAudit, entryIds,
  entryObservations, type CollectionEntryMarker, type CollectionEntryOptions, type ResponseBarrier } from './mcp-collection-entry-fixture.js';

const [mode, inputPath, markerPath, command] = process.argv.slice(2);
if (!['seed', 'cli'].includes(mode ?? '') || !inputPath || !markerPath) throw new Error('collection_entry_worker_arguments');
const options = JSON.parse(readFileSync(inputPath, 'utf8')) as CollectionEntryOptions;
const clockNow = Date.now, started = clockNow();
mock.method(Date, 'now', () => options.now + clockNow() - started);
function persist(marker: CollectionEntryMarker) {
  const fd = openSync(markerPath!, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(marker)); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(dirname(markerPath!), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
async function send(value: unknown) {
  assert.ok(process.send);
  await new Promise<void>((resolve, reject) => process.send!(value, error => error ? reject(error) : resolve()));
}

let profile: AgentTurnProfile | undefined;
try {
  if (mode === 'cli') {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as CollectionEntryMarker;
    if (command !== 'resume' && command !== 'status') throw new Error('collection_entry_cli_command');
    for (const method of ['discover', 'call', 'close'] as const)
      mock.method(McpStdioClient.prototype, method, () => { throw new Error(`collection_offline_client_${method}`); });
    await runAgentTurnCli([command, '--directory', options.directory, '--provider', 'registered', '--session', marker.scope.sessionId,
      '--conversation', marker.conversationId, '--work', marker.workId, '--json',
      ...(command === 'resume' ? ['--steps', '80', '--goal-revision', '1'] : [])], createCollectionEntryHost(options, 'stored_only'));
  } else {
    initializeMcpAgent(options.directory, options.backend);
    let workId = '', attemptId = '', scope: SessionScope | undefined, task: TaskSpec | undefined;
    let calibration: CollectionEntryMarker['calibration'] = null;
    const channel = options.scenario === 'complete' ? 'cli' : 'web', conversationId = channel === 'cli' ? 'terminal' : 'collection-entry';
    const barrier: ResponseBarrier = async (assembly, request, result) => {
      assert.equal(result.kind, 'committed'); if (result.kind !== 'committed') throw new Error('collection_commit_not_durable');
      assert.ok(scope && task && attemptId); const current = await assembly.custody.state.get(workId); assert.ok(current);
      const attempt = current.attempts.find(value => value.id === attemptId); assert.ok(attempt?.readProgress);
      assert.equal(attempt.status, 'running'); assert.equal(attempt.resultArtifact, null); assert.equal(attempt.adopted, false);
      const head = attempt.readProgress.head;
      const checkpoint = await new ReadCheckpointReader(current, assembly.custody.artifacts, assembly.custody.digester).load(head);
      assert.equal(checkpoint.calls.length, 1); assert.equal(checkpoint.calls[0]!.status, 'intent');
      assert.equal(checkpoint.calls[0]!.response, null);
      assert.equal(request.commandId, `mcp-page:${attemptId}:${checkpoint.calls[0]!.request.requestId}`);
      const receipt = await assembly.custody.state.receipt(workId, request.commandId); assert.ok(receipt);
      const raw = receipt.state.artifacts.at(-1); assert.ok(raw);
      const envelope = JSON.parse(new TextDecoder().decode(await assembly.custody.artifacts.get(raw, current.policy))) as {
        kind: string; failure: unknown; transportCalls: number; request: { requestId: string } };
      assert.equal(envelope.kind, 'mcp_collection_response'); assert.equal(envelope.failure, null); assert.equal(envelope.transportCalls, 1);
      assert.equal(envelope.request.requestId, checkpoint.calls[0]!.request.requestId);
      assert.equal(await assembly.custody.state.receipt(workId, `receive:${attemptId}`), null);
      // The peer appends its audit after base.send resolves. Observe that actual record without assuming cross-process order.
      const auditDeadline = performance.now() + 3000;
      let audit = entryAudit(options);
      while (!audit.some(row => row.event === 'response-sent' && row.requestId === checkpoint.calls[0]!.request.requestId)) {
        if (performance.now() >= auditDeadline) throw new Error('collection_response_audit_timeout');
        await new Promise<void>(resolve => setTimeout(resolve, 20));
        audit = entryAudit(options);
      }
      const peer = audit.find(row => row.event === 'start'); assert.ok(peer);
      assert.equal(audit.filter(row => row.event === 'call').length, 1);
      assert.equal(entryObservations(options).filter(row => row.kind === 'turn' || row.kind === 'compact').length, 0);
      const marker: CollectionEntryMarker = { schemaVersion: 1, kind: 'raw-receipt', workerPid: process.pid, peerPid: peer.pid,
        options: { ...options }, workId, scope, conversationId, channel, attemptId, task, raw, responseCommandId: request.commandId,
        originalHead: head, original: current, calibration };
      persist(marker); await send({ kind: 'checkpoint', workerPid: process.pid, peerPid: peer.pid });
      await new Promise<never>(() => {});
    };
    profile = await openAgentTurnProfile(options.directory, { provider: 'registered' },
      createCollectionEntryHost(options, 'online', options.scenario === 'adopted_partial' ? undefined : barrier));
    const p = profile, session = await p.sessions.open(p.actor, { channel, conversationId }); scope = session.scope;
    const accepted = await p.turns.accept(p.actor, { sessionId: scope.sessionId, messageId: 'original-request', rawText: COLLECTION_ENTRY_TEXT,
      mode: 'auto', binding: { ...p.executionActor, channel, conversationId, recipientId: p.actor.principalId, destination: 'local' },
      scope: p.scope, policy: p.policy, limits: p.limits });
    workId = accepted.workId;
    if (options.scenario === 'complete') for (let index = 1; index <= 8; index++)
      await p.turns.followUp(p.actor, { sessionId: scope.sessionId, workId, messageId: `tail-${index}`, rawText: COLLECTION_ENTRY_TAIL,
        expectedGoalRevision: 1, action: { kind: 'continue' } });
    const state = await p.runtime.state(workId), definition = p.contracts.visible(p.policy).find(value => value.id === 'fixture.collection');
    assert.ok(definition);
    task = { id: 'original-collection', description: 'Read all original fixture records', toolId: definition.id, toolVersion: definition.version,
      input: { ids: entryIds(options.scenario) }, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] };
    await p.runtime.submitPlan(workId, 'fixture-original-plan', { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
      basePlanRevision: 0, reason: 'Expose a real response boundary; successor selection must use the later general entry', tasks: [task], hypotheses: [] });
    if (options.scenario === 'complete') {
      assert.ok(p.planning);
      const before = await p.runtime.state(workId), sessionBefore = await p.sessions.repository.get(scope);
      const wide = await p.planning.turns.inspect(before, 'fixture-window-measurement', {
        maxInputBytes: p.planning.config.maxInputBytes, maxOutputTokens: p.planning.config.maxOutputTokens, maxInputTokens: 200000 });
      assert.equal(wide.kind, 'fits'); assert.ok(wide.selectedEstimate);
      const inputLimit = wide.requiredEstimate.tokens + 6000, window = inputLimit + p.planning.config.maxOutputTokens;
      assert.ok(wide.selectedEstimate.tokens > inputLimit + 6000, 'the actual full tail must exceed the selected small input window');
      const narrow = await p.planning.turns.inspect(before, 'fixture-window-required', {
        maxInputBytes: p.planning.config.maxInputBytes, maxOutputTokens: p.planning.config.maxOutputTokens, maxInputTokens: inputLimit });
      assert.equal(narrow.kind, 'needs_session_compact');
      assert.deepEqual(await p.runtime.state(workId), before); assert.deepEqual(await p.sessions.repository.get(scope), sessionBefore);
      options.window = window;
      calibration = { requiredTokens: wide.requiredEstimate.tokens, selectedTokens: wide.selectedEstimate.tokens, inputLimit, window };
    }
    const reserved = await p.runtime.reserve(workId, task.id); attemptId = reserved.id;
    await p.runtime.execute(workId, attemptId); await p.runtime.settlePending(attemptId);
    if (options.scenario !== 'adopted_partial') throw new Error('collection_response_barrier_not_reached');
    await p.runtime.adopt(workId, attemptId);
    const current = await p.runtime.state(workId), parent = current.attempts.find(value => value.id === attemptId)!;
    assert.equal(parent.status, 'partial'); assert.equal(parent.adopted, true); assert.ok(parent.readProgress);
    const checkpoint = await p.readCheckpoints.read(current, parent.id, parent.readProgress.head), call = checkpoint.calls.at(-1)!;
    const responseCommandId = `mcp-page:${attemptId}:${call.request.requestId}`;
    const receipt = await p.services.state.receipt(workId, responseCommandId); assert.ok(receipt);
    const raw = receipt.state.artifacts.at(-1) as ArtifactRef; assert.ok(raw);
    const peer = entryAudit(options).find(row => row.event === 'start'); assert.ok(peer);
    const marker: CollectionEntryMarker = { schemaVersion: 1, kind: 'adopted-partial', workerPid: process.pid, peerPid: peer.pid,
      options: { ...options }, workId, scope, conversationId, channel, attemptId, task, raw, responseCommandId,
      originalHead: parent.readProgress.head, original: current, calibration };
    await p.close(); profile = undefined; persist(marker);
    await send({ kind: 'seeded', workerPid: process.pid, peerPid: peer.pid }); process.disconnect?.();
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1;
} finally {
  try { await profile?.close(); } finally { mock.restoreAll(); }
}
