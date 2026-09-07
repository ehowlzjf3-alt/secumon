import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ArtifactRef } from '../domain/model.js';
import type { WorkViewResult } from '../domain/work-view.js';
import { McpStdioClient } from '../infrastructure/mcp-stdio-client.js';
import { openAgentWeb } from '../presentation/agent-web.js';
import type { WebCommandResult } from '../presentation/web-contracts.js';
import { COLLECTION_ENTRY_TEXT, createCollectionEntryHost, entryAudit, entryObservations } from './mcp-collection-entry-fixture.js';
import { seedCollectionCustodyEntry, type CollectionCustodyEntryFixture } from './mcp-collection-custody-entry-fixture.js';

const execute = promisify(execFile);
interface Chat {
  workId: string; sessionId: string; snapshot: { status: string; resultReady: boolean };
  messages: { kind: string; text: string }[];
  run?: { control: { kind: string; reason: string }; checkpoint: ArtifactRef };
}
async function cli(f: CollectionCustodyEntryFixture, command: 'status' | 'resume') {
  const options = { ...f.options, now: Date.now() };
  const program = `import {mock} from 'node:test';
import {runAgentTurnCli} from ${JSON.stringify(new URL('../presentation/agent-turn-cli.js', import.meta.url).href)};
import {McpStdioClient} from ${JSON.stringify(new URL('../infrastructure/mcp-stdio-client.js', import.meta.url).href)};
import {createCollectionEntryHost} from ${JSON.stringify(new URL('./mcp-collection-entry-fixture.js', import.meta.url).href)};
const realNow=Date.now,started=realNow(); mock.method(Date,'now',()=>${options.now}+realNow()-started);
for(const method of ['discover','call','close']) mock.method(McpStdioClient.prototype,method,()=>{throw new Error('custody_entry_offline_client_'+method)});
try { await runAgentTurnCli(process.argv.slice(1),createCollectionEntryHost(${JSON.stringify(options)},'stored_only')); }
finally { mock.restoreAll(); }`;
  const result = await execute(process.execPath, ['--input-type=module', '-e', program, command, '--directory', f.directory,
    '--provider', 'registered', '--session', f.sessionId, '--conversation', f.conversationId, '--work', f.workId, '--json',
    ...(command === 'resume' ? ['--goal-revision', '1', '--steps', '20'] : [])], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  assert.doesNotMatch(result.stdout, /\u001b/);
  return JSON.parse(result.stdout) as Chat;
}

async function connect(f: CollectionCustodyEntryFixture) {
  const app = await openAgentWeb(['--directory', f.directory, '--provider', 'registered', '--session', f.sessionId,
    '--conversation', f.conversationId], createCollectionEntryHost(f.options, 'stored_only'));
  assert.ok(app);
  try {
    const login = await fetch(`${app.server.origin}/api/session`, { method: 'POST',
      headers: { Origin: app.server.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URL(app.server.connectUrl).hash.slice(9) }), signal: AbortSignal.timeout(10000) });
    assert.equal(login.status, 200); const session = await login.json() as { csrf: string };
    const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]!, Origin: app.server.origin,
      'Content-Type': 'application/json', 'X-Work-CSRF': session.csrf };
    return { app, async request<T>(path: string, body?: unknown): Promise<T> {
      const result = await fetch(`${app.server.origin}${path}`, { headers, signal: AbortSignal.timeout(10000),
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      const value: unknown = await result.json(); assert.equal(result.status, 200, JSON.stringify(value)); return value as T;
    } };
  } catch (error) {
    try { await app.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'collection_custody_web_open_failed'); }
    throw error;
  }
}

function accounted(f: CollectionCustodyEntryFixture, after: Awaited<ReturnType<CollectionCustodyEntryFixture['inspect']>>) {
  f.unchangedOriginal(after);
  assert.deepEqual(after.attempt.execution, { mode: 'invoked', implementationCalls: 1,
    usage: { transportCalls: 1, internalOperations: null, imageBytes: null, waitMs: null } });
  assert.equal(after.events.filter(value => value.type === 'tool_execution_usage_recorded').length, 1);
  assert.equal(after.events.filter(value => value.type === 'read_response_reconciled').length, 0);
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: collection custody CLI resume blocks denied body access with a valid checkpoint and accounts once without retransmission`, { timeout: 55000 }, async t => {
    const f = await seedCollectionCustodyEntry(t, backend, 'cli'), wire = entryAudit(f.options);
    const status = await cli(f, 'status'); f.noBody(status);
    assert.equal(status.snapshot.resultReady, false); assert.deepEqual(await f.inspect(), f.before);
    f.noExtraExecution(0);
    const resumed = await cli(f, 'resume'); f.noBody(resumed);
    assert.ok(resumed.run); assert.equal(resumed.run.control.kind, 'blocked'); assert.equal(resumed.run.control.reason, 'tool_permission_denied');
    assert.equal(resumed.snapshot.status, 'blocked'); assert.equal(resumed.snapshot.resultReady, false);
    assert.equal(resumed.messages.filter(value => value.kind === 'failure').length, 1, 'the first resume reports its restriction');
    assert.deepEqual(resumed.messages.filter(value => value.kind === 'question'), []);
    assert.equal(resumed.messages.some(value => value.kind === 'result'), false);
    const after = await f.inspect(); accounted(f, after);
    assert.equal(after.state.status, 'blocked'); assert.equal(after.state.statusReason, 'tool_permission_denied');
    assert.equal(after.attempt.status, 'failed');
    assert.equal(after.attempt.error?.code, 'lease_expired');
    assert.deepEqual(after.state.modelCalls, []); assert.equal(after.state.budget.used.modelCalls, 0);
    assert.deepEqual(after.state.budget, f.before.state.budget);
    assert.deepEqual(after.state.conversation?.session, f.before.state.conversation?.session);
    f.noExtraExecution(0);
    const packet = await f.readResume(resumed.run.checkpoint); f.noBody(packet);
    assert.equal(packet.kind, 'runtime_resume'); assert.equal(packet.runtime.status, 'blocked');
    assert.equal(packet.runtime.statusReason, 'tool_permission_denied');
    assert.deepEqual(packet.context.evidence, []); assert.equal(packet.context.readCollections?.length ?? 0, 0);
    assert.equal(packet.context.session?.basis.input.messageId, 'original-request');
    assert.equal(packet.context.session?.entries.filter(value => value.role === 'user' && value.text === COLLECTION_ENTRY_TEXT).length, 1);
    // Ordinary resume does not grant permission or clear an explicit block merely because accounting succeeded.
    const again = await cli(f, 'resume'); f.noBody(again); assert.equal(again.run?.control.kind, 'blocked');
    assert.equal(again.run?.control.reason, 'tool_permission_denied'); assert.equal(again.snapshot.status, 'blocked');
    assert.equal(again.snapshot.resultReady, false);
    const repeated = await f.inspect(); accounted(f, repeated);
    assert.deepEqual(repeated.attempt, after.attempt); assert.deepEqual(repeated.state.modelCalls, after.state.modelCalls);
    assert.deepEqual(repeated.state.budget, after.state.budget);
    assert.deepEqual(repeated.history, after.history);
    assert.deepEqual(repeated, after, 'a duplicate resume does not republish control, usage, or session input');
    const finalStatus = await cli(f, 'status'); f.noBody(finalStatus); assert.equal(finalStatus.snapshot.status, 'blocked');
    assert.deepEqual(await f.inspect(), repeated, 'status remains a pure read after usage and the permission block have been recorded');
    assert.deepEqual(entryAudit(f.options), wire, 'every later CLI profile is stored-only, including discovery');
    f.noExtraExecution(0);
  });

  test(`${backend}: collection custody HTTP view is read-only and cancel keeps known usage and cancellation across reopen`, { timeout: 55000 }, async t => {
    const f = await seedCollectionCustodyEntry(t, backend, 'web'), wire = entryAudit(f.options);
    for (const method of ['discover', 'call', 'close'] as const)
      t.mock.method(McpStdioClient.prototype, method, () => { throw new Error(`custody_entry_offline_client_${method}`); });
    let web = await connect(f); f.cleanupWith(() => web.app.close());
    const view = await web.request<WorkViewResult>(`/api/works/${f.workId}/view`); f.noBody(view);
    assert.equal(view.kind, 'snapshot'); assert.deepEqual(await f.inspect(), f.before); f.noExtraExecution(0);
    const command = { requestId: 'cancel-protected-collection', kind: 'cancel', expectedGoalRevision: 1,
      reason: 'user_requested_cancel', rawText: '이 자료 확인 작업을 취소해 줘.' };
    const cancelled = await web.request<WebCommandResult>(`/api/works/${f.workId}/commands`, command); f.noBody(cancelled);
    assert.equal(cancelled.duplicate, false); assert.equal(cancelled.view.kind, 'snapshot');
    if (cancelled.view.kind !== 'snapshot') assert.fail('expected cancellation snapshot');
    assert.equal(cancelled.view.view.progress.status, 'cancelled'); assert.equal(cancelled.view.view.progress.resultReady, false);
    const after = await f.inspect(); accounted(f, after);
    assert.equal(after.state.status, 'cancelled'); assert.equal(after.state.modelCalls.length, 0);
    assert.deepEqual(after.state.budget, f.before.state.budget);
    assert.equal(after.history.entries.filter(value => value.role === 'user' && value.text === command.rawText).length, 1);
    assert.notDeepEqual(after.state.conversation?.session?.input, f.before.state.conversation?.session?.input);
    f.noExtraExecution(0);
    await web.app.close(); web = await connect(f);
    f.noBody(await web.request<WorkViewResult>(`/api/works/${f.workId}/view`));
    assert.deepEqual(await f.inspect(), after, 'opening and viewing cannot write usage or revive a cancelled work');
    const duplicate = await web.request<WebCommandResult>(`/api/works/${f.workId}/commands`, command); f.noBody(duplicate);
    assert.equal(duplicate.duplicate, true);
    const repeated = await f.inspect(); accounted(f, repeated);
    assert.equal(repeated.state.status, 'cancelled'); assert.deepEqual(repeated.attempt, after.attempt);
    assert.deepEqual(repeated.state.modelCalls, []); assert.deepEqual(repeated.state.budget, after.state.budget);
    assert.deepEqual(repeated.history, after.history);
    await web.app.close(); f.noExtraExecution(0);
    assert.deepEqual(entryAudit(f.options), wire, 'reopened HTTP servers use stored-only registration with no peer discovery');
    assert.ok(entryObservations(f.options).filter(value => value.kind === 'open').slice(1).every(value => value.mode === 'stored_only'));
  });
}
