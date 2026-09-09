import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Attempt } from '../domain/model.js';
import { transact } from '../application/work-transactions.js';
import { McpStdioClient } from '../infrastructure/mcp-stdio-client.js';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { assertMcpPeersStopped } from './mcp-agent-profile-helper.js';
import { COLLECTION_ENTRY_RESUME_TEXT, COLLECTION_ENTRY_TEXT, createCollectionEntryHost, entryAnswer,
  entryAudit, entryObservations, readEntry } from './mcp-collection-entry-fixture.js';
import { seedCollectionCustodyEntry, type CollectionCustodyEntryFixture } from './mcp-collection-custody-entry-fixture.js';

const execute = promisify(execFile), resumeId = 'permission-restored-resume';
interface Chat {
  workId: string; sessionId: string; created?: boolean;
  snapshot: { status: string; resultReady: boolean; resultDelivery: string };
  messages: { kind: string; text: string }[];
  run?: { control: { kind: string; reason: string } };
}

async function cli(f: CollectionCustodyEntryFixture, command: 'status' | 'resume', explicit = false): Promise<Chat> {
  const options = { ...f.options, now: Date.now() };
  const program = `import {mock} from 'node:test';
import {runAgentTurnCli} from ${JSON.stringify(new URL('../presentation/agent-turn-cli.js', import.meta.url).href)};
import {McpStdioClient} from ${JSON.stringify(new URL('../infrastructure/mcp-stdio-client.js', import.meta.url).href)};
import {createCollectionEntryHost} from ${JSON.stringify(new URL('./mcp-collection-entry-fixture.js', import.meta.url).href)};
const realNow=Date.now,started=realNow(); mock.method(Date,'now',()=>${options.now}+realNow()-started);
for(const method of ['discover','call','close']) mock.method(McpStdioClient.prototype,method,()=>{throw new Error('permission_resume_offline_client_'+method)});
try { await runAgentTurnCli(process.argv.slice(1),createCollectionEntryHost(${JSON.stringify(options)},'stored_only')); }
finally { mock.restoreAll(); }`;
  const result = await execute(process.execPath, ['--input-type=module', '-e', program, command, '--directory', f.directory,
    '--provider', 'registered', '--session', f.sessionId, '--conversation', f.conversationId, '--work', f.workId, '--json',
    ...(command === 'resume' ? ['--goal-revision', '1', '--steps', '30'] : []),
    ...(explicit ? ['--message-id', resumeId, '--text', COLLECTION_ENTRY_RESUME_TEXT] : [])],
  { timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  assert.doesNotMatch(result.stdout, /\u001b/); return JSON.parse(result.stdout) as Chat;
}

function originalIdentity(attempt: Attempt) {
  return { id: attempt.id, taskId: attempt.taskId, toolId: attempt.toolId, toolVersion: attempt.toolVersion,
    owner: attempt.owner, scope: attempt.scope, startedAt: attempt.startedAt, leaseUntil: attempt.leaseUntil,
    inputDigest: attempt.inputDigest, contractDigest: attempt.contractDigest,
    goalRevision: attempt.goalRevision, planRevision: attempt.planRevision };
}

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: trusted permission restoration plus explicit CLI resume completes the original stored collection exactly once`,
  { timeout: 90000 }, async t => {
    const f = await seedCollectionCustodyEntry(t, backend, 'cli'), wire = entryAudit(f.options);
    const denied = await cli(f, 'resume'); f.noBody(denied);
    assert.equal(denied.run?.control.kind, 'blocked'); assert.equal(denied.run?.control.reason, 'tool_permission_denied');
    const blocked = await f.inspect(); f.unchangedOriginal(blocked); f.noExtraExecution(0);
    assert.equal(blocked.attempt.status, 'failed'); assert.equal(blocked.attempt.error?.code, 'lease_expired');
    assert.equal(blocked.attempt.execution?.usage.transportCalls, 1);
    const initialUsage = blocked.events.filter(event => event.type === 'tool_execution_usage_recorded'); assert.equal(initialUsage.length, 1);

    for (const method of ['discover', 'call', 'close'] as const)
      t.mock.method(McpStdioClient.prototype, method, () => { throw new Error(`permission_resume_offline_host_${method}`); });
    const host = await openAgentTurnProfile(f.directory, { provider: 'registered' }, createCollectionEntryHost(f.options, 'stored_only'));
    try {
      // Trusted host policy mutation only. Regranting access cannot silently resume the user-controlled work.
      await transact(host.services, f.workId, 'custody-entry-regrant', 'fixture_read_reauthorized', {}, state => {
        assert.equal(state.status, 'blocked'); assert.equal(state.statusReason, 'tool_permission_denied');
        assert.deepEqual(state.policy.allowedLabels, []); state.policy.allowedLabels = [...f.originalPolicy.allowedLabels];
      });
    } finally { await host.close(); }
    const granted = await f.inspect('permitted');
    assert.equal(granted.state.status, 'blocked'); assert.equal(granted.state.statusReason, 'tool_permission_denied');
    assert.deepEqual(granted.state.policy, f.originalPolicy); assert.deepEqual(granted.attempt, blocked.attempt);
    assert.deepEqual(granted.state.budget, blocked.state.budget); assert.deepEqual(granted.state.modelCalls, []);
    assert.deepEqual(granted.state.goal, blocked.state.goal); assert.deepEqual(granted.state.plan, blocked.state.plan);
    assert.deepEqual(granted.receipts, blocked.receipts); assert.deepEqual(granted.originals, blocked.originals);
    const status = await cli(f, 'status'); assert.equal(status.snapshot.status, 'blocked'); assert.equal(status.snapshot.resultReady, false);
    assert.deepEqual(await f.inspect('permitted'), granted, 'reopening and status do not clear the permission block or execute stored work');
    f.noExtraExecution(0); assert.deepEqual(entryAudit(f.options), wire);

    const completed = await cli(f, 'resume', true), after = await readEntry(f.retainedOriginal);
    assert.equal(completed.created, true); assert.equal(completed.workId, f.workId); assert.equal(completed.sessionId, f.sessionId);
    assert.equal(completed.run?.control.kind, 'complete'); assert.equal(completed.snapshot.status, 'completed');
    assert.equal(completed.snapshot.resultReady, true); assert.equal(completed.snapshot.resultDelivery, 'delivered');
    assert.equal(completed.messages.filter(message => message.kind === 'result').length, 1);
    assert.equal(completed.messages.find(message => message.kind === 'result')?.text, entryAnswer('complete'));
    assert.deepEqual(after.state.goal, f.before.state.goal); assert.deepEqual(after.input, f.before.input);
    assert.equal(after.state.goal.responseRequirement?.requestMessageId, 'original-request');
    assert.deepEqual(after.receipts, [f.before.receipts[0], f.before.receipts[2], f.before.receipts[1]]);
    assert.deepEqual(after.rawBytes, f.before.originals.find(value => value.ref.id === f.retainedOriginal.raw.id)!.bytes);
    assert.deepEqual(after.headBytes, f.before.originals.find(value => value.ref.id === f.retainedOriginal.originalHead.id)!.bytes);
    const collections = after.state.attempts.filter(attempt => attempt.toolId === 'fixture.collection'); assert.equal(collections.length, 2);
    const parent = collections.find(attempt => attempt.id === f.before.attempt.id)!, successor = collections.find(attempt => attempt.id !== parent.id)!;
    assert.deepEqual(originalIdentity(parent), originalIdentity(f.before.attempt));
    assert.equal(parent.status, 'failed'); assert.equal(parent.error?.code, 'lease_expired'); assert.equal(parent.adopted, false);
    assert.equal(parent.resultArtifact, null); assert.deepEqual(parent.execution, blocked.attempt.execution);
    assert.equal(parent.readProgress?.successorAttemptId, successor.id); assert.equal(parent.readProgress?.phase, 'complete');
    assert.equal(successor.status, 'succeeded'); assert.equal(successor.adopted, true); assert.notEqual(successor.owner, parent.owner);
    assert.equal(successor.execution?.usage.transportCalls, 0);
    const task = after.dispatches.find(value => value.id === successor.id)!.receipt!.state.plan!.tasks.find(value => value.id === successor.taskId)!;
    assert.deepEqual(task.input, f.before.state.plan!.tasks[0]!.input);
    assert.deepEqual(task.readResume, { attemptId: parent.id, checkpointId: parent.readProgress!.head.id });
    const checkpoint = after.checkpoints.find(value => value.id === successor.id)!.checkpoint;
    assert.deepEqual(checkpoint.parent, { attemptId: parent.id, checkpoint: parent.readProgress!.head });
    assert.equal(checkpoint.phase, 'complete'); assert.equal(checkpoint.collection.exhausted, true);
    assert.equal(checkpoint.calls.length, 1); assert.equal(checkpoint.calls[0]!.attemptId, parent.id);
    assert.equal(checkpoint.calls[0]!.status, 'accepted'); assert.ok(checkpoint.calls[0]!.response);
    assert.deepEqual(checkpoint.calls[0]!.request, f.before.checkpoint.calls[0]!.request);
    const result = after.results.find(value => value.id === successor.id)!.result;
    assert.equal(result.status, 'success'); assert.equal(result.coverage, 'complete'); assert.equal(result.usage?.transportCalls, 0);
    assert.deepEqual(after.state.evidence.map(value => [value.facts['collection.record'], value.facts.value]).sort(), [['a', 30], ['b', 30]]);
    assert.deepEqual(after.state.generatedAnswer!.evidenceIds.slice().sort(), after.state.evidence.map(value => value.id).sort());
    assert.equal(after.state.budget.used.toolCalls, f.before.state.budget.used.toolCalls + 1);
    assert.equal(after.state.budget.reservedToolCalls + after.state.budget.reservedModelCalls + after.state.budget.reservedTokens, 0);
    assert.deepEqual(after.events.filter(event => event.type === 'tool_execution_usage_recorded'), initialUsage, 'the original wire call is accounted once');
    assert.equal(after.events.filter(event => event.type === 'read_response_reconciled').length, 1);
    const observed = entryObservations(f.options), turns = observed.filter(row => row.kind === 'turn');
    assert.equal(observed.filter(row => row.kind === 'fetch').length, 1); assert.ok(observed.some(row => row.kind === 'project'));
    assert.equal(observed.filter(row => row.kind === 'compact').length, 0); assert.equal(turns.length, 2);
    assert.equal(turns[0]!.result.kind, 'plan'); assert.equal(turns[1]!.result.kind, 'answer');
    assert.equal(turns[0]!.input.packet.readCollections?.find(value => value.attemptId === parent.id)?.resumeMode, 'stored_complete');
    assert.equal(after.state.budget.used.modelCalls, 2); assert.equal(after.state.budget.used.tokens, 500);
    assert.equal(after.history.entries.filter(entry => entry.role === 'user' && entry.sourceId === 'original-request' && entry.text === COLLECTION_ENTRY_TEXT).length, 1);
    assert.equal(after.history.entries.filter(entry => entry.role === 'user' && entry.sourceId === resumeId && entry.text === COLLECTION_ENTRY_RESUME_TEXT).length, 1);
    assert.equal(after.history.entries.filter(entry => entry.role === 'assistant' && entry.kind === 'result' && entry.text === entryAnswer('complete')).length, 1);
    assert.deepEqual(entryAudit(f.options), wire); assertMcpPeersStopped(f.options.auditFile);

    const duplicate = await cli(f, 'resume', true);
    assert.equal(duplicate.created, false); assert.equal(duplicate.run, undefined); assert.equal(duplicate.snapshot.status, 'completed');
    assert.deepEqual(await readEntry(f.retainedOriginal), after, 'replayed user resume cannot recollect, resettle, append input or redeliver the result');
    const finalStatus = await cli(f, 'status'); assert.equal(finalStatus.snapshot.status, 'completed');
    assert.deepEqual(await readEntry(f.retainedOriginal), after);
    const repeatedObservations = entryObservations(f.options);
    assert.deepEqual(repeatedObservations.slice(0, observed.length), observed);
    // Current result views reproject the retained response to verify its proof; this is not a fetch, model call or state publication.
    assert.ok(repeatedObservations.slice(observed.length).every(row => row.kind === 'open' && row.mode === 'stored_only' ||
      row.kind === 'project' && row.requestId === f.before.checkpoint.calls[0]!.request.requestId));
    assert.deepEqual(entryAudit(f.options), wire); assertMcpPeersStopped(f.options.auditFile);
    t.diagnostic(JSON.stringify({ backend, workId: f.workId, localStdioCalls: 1, successorTransportCalls: 0,
      originalUsageRecords: initialUsage.length, deterministicTurns: turns.length, resultEntries: 1, duplicateResumeCreated: duplicate.created }));
  });
