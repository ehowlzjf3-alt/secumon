import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Attempt } from '../domain/model.js';
import type { WorkViewResult } from '../domain/work-view.js';
import { AgentTurnCallInputSchema } from '../application/agent-turn-contracts.js';
import { McpStdioClient } from '../infrastructure/mcp-stdio-client.js';
import { openAgentWeb } from '../presentation/agent-web.js';
import type { WebCommandResult } from '../presentation/web-contracts.js';
import { COLLECTION_ENTRY_TEXT, COLLECTION_ENTRY_TAIL, createCollectionEntryHost, entryAnswer, entryAudit, entryIds,
  entryObservations, readEntry, type CollectionEntryMarker, type CollectionEntryOptions, type EntryScenario } from './mcp-collection-entry-fixture.js';

const execute = promisify(execFile);
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function exited(pid: number) {
  const until = performance.now() + 5000;
  while (alive(pid)) {
    if (performance.now() >= until) throw new Error(`collection_entry_owned_process_live:${pid}`);
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}
async function bounded<T>(promise: Promise<T>, ms: number, reason: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(reason())), ms);
  })]); } finally { if (timer) clearTimeout(timer); }
}
async function seeded(options: CollectionEntryOptions, optionsPath: string, markerPath: string) {
  const child = fork(new URL('./mcp-collection-entry-worker.js', import.meta.url), ['seed', optionsPath, markerPath],
    { execPath: process.execPath, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout!.resume(); let stderr = '';
  child.stderr!.on('data', value => { stderr = (stderr + String(value)).slice(-16384); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
    child.once('exit', (code, signal) => resolve({ code, signal })));
  let resolveReady!: (value: unknown) => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<unknown>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const onError = (error: Error) => rejectReady(error), onMessage = (value: unknown) => resolveReady(value);
  child.once('error', onError); child.once('message', onMessage);
  try {
    const value = await bounded(Promise.race([ready, exit.then(({ code, signal }) => {
      throw new Error(`collection_entry_early_exit:${code}:${signal}:${stderr}`);
    })]), 20000, () => `collection_entry_ready_timeout:${stderr}`) as { kind: string; workerPid: number; peerPid: number };
    assert.equal(value.kind, options.scenario === 'adopted_partial' ? 'seeded' : 'checkpoint');
    assert.equal(value.workerPid, child.pid); assert.ok(Number.isSafeInteger(value.peerPid) && value.peerPid > 0);
    assert.notEqual(value.peerPid, child.pid); assert.notEqual(value.peerPid, process.pid);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as CollectionEntryMarker;
    assert.equal(marker.workerPid, child.pid); assert.equal(marker.peerPid, value.peerPid);
    assert.equal(marker.options.backend, options.backend); assert.equal(marker.options.scenario, options.scenario);
    if (options.scenario !== 'adopted_partial') assert.equal(child.kill('SIGKILL'), true);
    const ended = await bounded(exit, 5000, () => `collection_entry_exit_timeout:${stderr}`);
    assert.equal(ended.code, options.scenario === 'adopted_partial' ? 0 : null, stderr);
    assert.equal(ended.signal, options.scenario === 'adopted_partial' ? null : 'SIGKILL', stderr);
    await exited(marker.workerPid); await exited(marker.peerPid);
    const audit = entryAudit(options);
    assert.equal(audit.filter(row => row.event === 'call').length, 1);
    assert.ok(audit.some(row => row.pid === marker.peerPid && row.event === 'close' &&
      (options.scenario === 'adopted_partial' || row.reason === 'stdin-ended')));
    return marker;
  } finally {
    child.off('error', onError); child.off('message', onMessage);
    try {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await bounded(exit, 5000, () => `collection_entry_cleanup_timeout:${stderr}`); }
    } finally {
      for (const row of entryAudit(options).filter(row => row.event === 'start')) {
        if (row.pid !== process.pid && row.pid !== child.pid && Number.isSafeInteger(row.pid) && row.pid > 0 && alive(row.pid)) {
          process.kill(row.pid, 'SIGKILL'); await exited(row.pid);
        }
      }
    }
  }
}
async function fixture(t: TestContext, backend: 'sqlite' | 'file-journal', scenario: EntryScenario) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-collection-entry-'))), optionsPath = join(base, 'options.json'), markerPath = join(base, 'marker.json');
  const options: CollectionEntryOptions = { directory: join(base, 'agent'), auditFile: join(base, 'peer.jsonl'), hostAuditFile: join(base, 'host.jsonl'),
    backend, scenario, now: 100000 };
  const closes: (() => Promise<void>)[] = [];
  t.after(async () => {
    try { for (const close of closes.reverse()) await close(); }
    finally {
      for (const row of entryAudit(options).filter(row => row.event === 'start')) {
        if (alive(row.pid)) { process.kill(row.pid, 'SIGKILL'); await exited(row.pid); }
      }
      rmSync(base, { recursive: true, force: true });
    }
  });
  writeFileSync(optionsPath, JSON.stringify(options), { mode: 0o600 });
  const marker = await seeded(options, optionsPath, markerPath);
  Object.assign(options, marker.options);
  options.now = Math.max(marker.original.updatedAt + 1, marker.original.attempts.find(value => value.id === marker.attemptId)!.leaseUntil + 1);
  const realNow = Date.now, started = realNow(); t.mock.method(Date, 'now', () => options.now + realNow() - started);
  const before = await readEntry(marker), peerBefore = readFileSync(options.auditFile, 'utf8');
  assert.deepEqual(before.state, marker.original);
  assert.equal(before.state.modelCalls.length, 0); assert.equal(before.history.entries.filter(entry => entry.role === 'user' && entry.text === COLLECTION_ENTRY_TEXT).length, 1);
  const noPeer = () => {
    assert.equal(readFileSync(options.auditFile, 'utf8'), peerBefore, 'stored-only reopen must not start/list/call/close a peer');
    assert.equal(alive(marker.peerPid), false);
  };
  return { base, options, optionsPath, markerPath, marker, before, noPeer,
    inspect: () => readEntry(marker), cleanupWith: (close: () => Promise<void>) => closes.push(close) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
interface ChatResult {
  workId: string; sessionId: string; snapshot: { status: string; resultDelivery: string };
  messages: { kind: string; text: string }[]; run?: { control: { kind: string; reason: string } };
}
async function cli(f: Fixture, command: 'resume' | 'status') {
  writeFileSync(f.optionsPath, JSON.stringify({ ...f.options, now: Date.now() }), { mode: 0o600 });
  const result = await execute(process.execPath, [fileURLToPath(new URL('./mcp-collection-entry-worker.js', import.meta.url)),
    'cli', f.optionsPath, f.markerPath, command], { timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(result.stdout) as ChatResult;
}
async function connect(f: Fixture, mode: 'online' | 'stored_only') {
  const app = await openAgentWeb(['--directory', f.options.directory, '--provider', 'registered', '--session', f.marker.scope.sessionId,
    '--conversation', f.marker.conversationId], createCollectionEntryHost(f.options, mode)); assert.ok(app);
  f.cleanupWith(() => app.close());
  const response = await fetch(`${app.server.origin}/api/session`, { method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { Origin: app.server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(app.server.connectUrl).hash.slice(9) }) });
  assert.equal(response.status, 200); const body = await response.json() as { csrf: string };
  const headers = { Cookie: response.headers.get('set-cookie')!.split(';')[0]!, Origin: app.server.origin,
    'Content-Type': 'application/json', 'X-Work-CSRF': body.csrf };
  const request = async <T>(path: string, data?: unknown): Promise<T> => {
    const result = await fetch(`${app.server.origin}${path}`, { headers, signal: AbortSignal.timeout(30000),
      ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }) });
    const value: unknown = await result.json(); assert.equal(result.status, 200, JSON.stringify(value)); return value as T;
  };
  return { app, request, run: (requestId: string) => request<WebCommandResult>(`/api/works/${f.marker.workId}/commands`, {
    requestId, kind: 'run', expectedGoalRevision: 1 }) };
}
function originalIdentity(attempt: Attempt) {
  return { id: attempt.id, owner: attempt.owner, leaseUntil: attempt.leaseUntil, startedAt: attempt.startedAt,
    goalRevision: attempt.goalRevision, planRevision: attempt.planRevision, scope: attempt.scope, taskId: attempt.taskId,
    toolId: attempt.toolId, toolVersion: attempt.toolVersion, inputDigest: attempt.inputDigest, contractDigest: attempt.contractDigest };
}
function originals(f: Fixture, after: Awaited<ReturnType<typeof readEntry>>) {
  assert.deepEqual(after.receipts, f.before.receipts); assert.deepEqual(after.rawBytes, f.before.rawBytes); assert.deepEqual(after.headBytes, f.before.headBytes);
  assert.deepEqual(after.input, f.before.input); assert.deepEqual(after.latestInput, f.before.latestInput); assert.deepEqual(after.state.goal, f.before.state.goal);
  assert.deepEqual(after.history.entries.filter(entry => f.before.history.entries.some(before => before.sequence === entry.sequence)), f.before.history.entries);
  assert.deepEqual(originalIdentity(after.state.attempts.find(value => value.id === f.marker.attemptId)!), originalIdentity(f.before.state.attempts[0]!));
}
function completedLineage(f: Fixture, after: Awaited<ReturnType<typeof readEntry>>, transport: number) {
  originals(f, after); const state = after.state;
  assert.equal(state.status, 'completed');
  const collections = state.attempts.filter(value => value.toolId === 'fixture.collection'); assert.equal(collections.length, 2);
  const parent = collections.find(value => value.id === f.marker.attemptId)!, child = collections.find(value => value.id !== parent.id)!;
  const localReads = state.attempts.filter(value => value.toolId !== 'fixture.collection');
  assert.equal(parent.status, f.options.scenario === 'adopted_partial' ? 'partial' : 'failed');
  assert.equal(parent.adopted, f.options.scenario === 'adopted_partial');
  if (f.options.scenario !== 'adopted_partial') { assert.equal(parent.error?.code, 'lease_expired'); assert.equal(parent.resultArtifact, null); }
  assert.notEqual(child.owner, parent.owner); assert.equal(child.status, 'succeeded'); assert.equal(child.adopted, true);
  assert.equal(parent.readProgress!.successorAttemptId, child.id);
  const task = after.dispatches.find(value => value.id === child.id)!.receipt!.state.plan!.tasks.find(value => value.id === child.taskId)!;
  assert.deepEqual(task.input, f.marker.task.input); assert.deepEqual(task.readResume, { attemptId: parent.id, checkpointId: parent.readProgress!.head.id });
  const checkpoint = after.checkpoints.find(value => value.id === child.id)!.checkpoint;
  assert.deepEqual(checkpoint.parent, { attemptId: parent.id, checkpoint: parent.readProgress!.head });
  assert.equal(checkpoint.phase, 'complete'); assert.equal(checkpoint.collection.exhausted, true);
  const result = after.results.find(value => value.id === child.id)!.result;
  assert.equal(result.usage?.transportCalls, transport); assert.equal(child.execution?.usage.transportCalls, transport);
  assert.equal(state.budget.used.toolCalls, f.before.state.budget.used.toolCalls + 1 + localReads.length);
  assert.equal(state.budget.reservedToolCalls, 0);
  assert.deepEqual(state.evidence.filter(value => value.status === 'accepted').map(value => value.facts['collection.record']).sort(), entryIds(f.options.scenario));
  assert.ok(state.evidence.every(value => value.artifact));
  assert.equal(after.history.entries.filter(entry => entry.role === 'assistant' && entry.text === entryAnswer(f.options.scenario)).length, 1);
  const finds = localReads.filter(value => value.toolId === 'core.evidence.find');
  const gets = localReads.filter(value => value.toolId === 'core.evidence.get');
  assert.equal(localReads.length, finds.length + gets.length); assert.ok(finds.length <= 1);
  assert.ok(gets.length === 0 || gets.length === entryIds(f.options.scenario).length);
  for (const attempt of localReads) {
    assert.equal(attempt.status, 'succeeded'); assert.equal(attempt.adopted, true); assert.equal(attempt.readProgress, undefined);
    assert.equal(attempt.toolVersion, '1'); assert.equal(attempt.execution?.mode, 'invoked');
    assert.equal(attempt.execution?.implementationCalls, 1);
    const original = after.dispatches.find(value => value.id === attempt.id)!.receipt!.state.plan!.tasks.find(value => value.id === attempt.taskId)!;
    assert.equal(original.readResume, undefined); assert.equal(original.maxAttempts, 1);
    const read = after.results.find(value => value.id === attempt.id)!.result;
    assert.equal(read.status, 'success'); assert.equal(read.coverage, 'complete'); assert.equal(read.collection, undefined);
    assert.deepEqual(read.evidence, []);
    // Core resource reads have no transport meter; the real peer audit proves MCP sends remain unchanged.
    assert.equal(read.usage, undefined); assert.equal(attempt.execution?.usage.transportCalls, null);
    const output = read.output; assert.ok(output && typeof output === 'object' && !Array.isArray(output));
    if (attempt.toolId === 'core.evidence.find') {
      assert.deepEqual(original.input, { query: 'collection.record', limit: entryIds(f.options.scenario).length });
      assert.equal(output.hasMore, false); assert.equal(output.truncated, false); assert.ok(Array.isArray(output.cards));
      assert.deepEqual(output.cards.map(value => {
        assert.ok(value && typeof value === 'object' && !Array.isArray(value)); assert.equal(value.facts, undefined); return value.id;
      }).sort(), state.evidence.map(value => value.id).sort());
    } else {
      assert.equal(original.input.detail, 'evidence'); assert.equal(original.input.maxBytes, 4096);
      assert.equal(output.status, 'available'); const value = output.value;
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      assert.equal(value.view, 'current_accepted_evidence');
      assert.deepEqual(value.evidence, state.evidence.find(evidence => evidence.id === original.input.evidenceId));
    }
  }
  assert.equal(new Set(gets.map(attempt => after.dispatches.find(value => value.id === attempt.id)!.receipt!.state.plan!.tasks
    .find(task => task.id === attempt.taskId)!.input.evidenceId)).size, gets.length);
  return { parent, child, checkpoint, localReads, finds, gets };
}

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: SIGKILL collection response resumes through actual CLI, compacts its real session and consumes an explicit complete successor offline`, { timeout: 60000 }, async t => {
  const f = await fixture(t, backend, 'complete'); assert.ok(f.marker.calibration);
  const status = await cli(f, 'status'); assert.notEqual(status.snapshot.status, 'completed');
  assert.deepEqual(await f.inspect(), f.before); f.noPeer();
  const done = await cli(f, 'resume'), after = await f.inspect(), observed = entryObservations(f.options);
  assert.equal(done.run?.control.kind, 'complete', JSON.stringify({ cli: done,
    attempts: after.state.attempts.map(value => ({ id: value.id, status: value.status, adopted: value.adopted,
      error: value.error, readProgress: value.readProgress })), evidence: after.state.evidence,
    turns: observed.filter(value => value.kind === 'turn').map(value => ({ result: value.result,
      evidence: value.input.packet.evidence, collections: value.input.packet.readCollections,
      references: value.input.packet.evidenceReferences, observations: value.input.packet.toolObservations,
      tools: value.options.tools.map(tool => tool.id), estimate: value.estimate })) }));
  assert.equal(done.snapshot.resultDelivery, 'delivered'); assert.equal(done.messages.find(value => value.kind === 'result')?.text, entryAnswer('complete'));
  const { parent, checkpoint, localReads, finds, gets } = completedLineage(f, after, 0);
  assert.equal(checkpoint.calls.length, 1); assert.equal(checkpoint.calls[0]!.attemptId, parent.id);
  assert.equal(checkpoint.calls[0]!.status, 'accepted'); assert.ok(checkpoint.calls[0]!.response);
  const compacts = observed.filter(value => value.kind === 'compact'), turns = observed.filter(value => value.kind === 'turn');
  assert.ok(compacts.length >= 1, 'the actual general resume must invoke and adopt a session summary, not only compact a derived frame');
  const recallPlans = turns.filter(value => value.result.kind === 'plan' && value.result.proposal.tasks.some(task => task.toolId.startsWith('core.evidence.')));
  assert.equal(recallPlans.length, finds.length + (gets.length > 0 ? 1 : 0)); assert.equal(turns.length, 2 + recallPlans.length);
  assert.equal(turns[0]!.result.kind, 'plan'); assert.equal(turns.at(-1)!.result.kind, 'answer');
  assert.equal(localReads.length, gets.length + finds.length);
  for (const observation of recallPlans) {
    assert.equal(observation.result.kind, 'plan'); if (observation.result.kind !== 'plan') assert.fail();
    const packet = observation.input.packet;
    assert.ok(packet.contextView!.omitted.evidence > 0);
    assert.ok(entryIds('complete').some(id => !packet.evidence.some(value => value.status === 'accepted' &&
      value.coverage === 'complete' && value.sourceId === `document:${id}` && typeof value.facts.value === 'number')),
    'recall is only needed when a requested full fact is absent from this model input');
    const visibleIds = new Set([...packet.evidence.map(value => value.id), ...(packet.evidenceReferences ?? []).map(value => value.id)]);
    for (const read of packet.toolObservations ?? []) {
      if (read.toolId !== 'core.evidence.find' || read.representation !== 'full' || read.status !== 'success') continue;
      const output = read.output; assert.ok(output && typeof output === 'object' && !Array.isArray(output));
      assert.ok(Array.isArray(output.cards));
      for (const value of output.cards) {
        assert.ok(value && typeof value === 'object' && !Array.isArray(value) && typeof value.id === 'string'); visibleIds.add(value.id);
      }
    }
    for (const task of observation.result.proposal.tasks) {
      assert.ok(observation.options.tools.some(tool => tool.id === task.toolId && tool.provider === 'core' && tool.effect === 'read'));
      if (task.toolId === 'core.evidence.get') {
        assert.equal(typeof task.input.evidenceId, 'string'); assert.ok(visibleIds.has(task.input.evidenceId as string), 'get ID must be disclosed in this actual model input');
      }
    }
  }
  const planning = turns[0]!.input.packet, tip = planning.readCollections!.find(value => value.attemptId === parent.id)!;
  assert.equal(tip.resumeMode, 'stored_complete'); assert.deepEqual(tip.progress.head, parent.readProgress!.head);
  assert.deepEqual(planning.plan!.tasks.find(value => value.id === f.marker.task.id), f.marker.task);
  assert.equal(planning.session?.schemaVersion, 2); assert.equal(turns.at(-1)!.input.packet.session?.schemaVersion, 2);
  let through = 0;
  for (const observation of compacts) {
    assert.ok(observation.input.prefix.throughSequence > through); through = observation.input.prefix.throughSequence;
    assert.ok(through < observation.input.basis.input.sequence);
    assert.ok(observation.estimate.tokens > 1); assert.ok(observation.estimate.tokens + observation.options.maxOutputTokens <= f.options.window!);
    assert.ok(observation.estimate.bytes > Buffer.byteLength(JSON.stringify({ compact: observation.input, options: observation.options })));
    assert.ok(observation.candidate.content.retained.some(value => value.citations.length > 0));
    for (const item of observation.candidate.content.retained) for (const citation of item.citations) assert.ok(f.before.history.entries.some(entry =>
      entry.sourceId === citation.sourceId && entry.sequence === citation.sequence && entry.role === citation.role && entry.text.includes(citation.quote)));
    const saved = after.modelInputs.find(value => value.id === observation.options.callId)!;
    assert.deepEqual(saved.value, { compact: observation.input, options: observation.options });
    assert.equal(after.state.modelCalls.find(value => value.id === observation.options.callId)!.status, 'accepted');
  }
  const answerCall = after.state.generatedAnswer!;
  const finalInput = AgentTurnCallInputSchema.parse(after.modelInputs.find(value => value.id === answerCall.callId)!.value);
  assert.deepEqual(finalInput.turn.packet.evidence.map(value => value.id).sort(), after.state.evidence.map(value => value.id).sort());
  assert.deepEqual(answerCall.evidenceIds.slice().sort(), after.state.evidence.map(value => value.id).sort());
  assert.equal(finalInput.turn.packet.session?.schemaVersion, 2);
  assert.equal(finalInput.turn.packet.session!.entries.find(entry => entry.sourceId === 'tail-8')?.text, COLLECTION_ENTRY_TAIL);
  assert.equal(answerCall.input.input.messageId, 'tail-8'); assert.equal(after.state.goal.responseRequirement!.requestMessageId, 'original-request');
  assert.equal(after.state.budget.used.modelCalls, compacts.length + turns.length);
  assert.equal(after.state.budget.used.tokens, compacts.length * 150 + turns.length * 250);
  for (const observation of turns) {
    assert.ok(observation.estimate.tokens + observation.options.maxOutputTokens <= f.options.window!);
    const saved = AgentTurnCallInputSchema.parse(after.modelInputs.find(value => value.id === observation.options.callId)!.value);
    assert.deepEqual(saved, { turn: observation.input, options: observation.options });
    assert.equal(after.state.modelCalls.find(value => value.id === observation.options.callId)!.status, 'accepted');
  }
  assert.equal(after.state.budget.reservedTokens, 0); assert.equal(after.state.budget.reservedModelCalls, 0);
  assert.equal(observed.filter(value => value.kind === 'fetch').length, 1); f.noPeer();
  const again = await cli(f, 'resume'); assert.equal(again.snapshot.status, 'completed');
  const repeated = await f.inspect(); assert.deepEqual(repeated.state.attempts, after.state.attempts); assert.deepEqual(repeated.state.budget, after.state.budget);
  assert.deepEqual(repeated.history, after.history);
  assert.equal(entryObservations(f.options).filter(value => value.kind === 'turn' || value.kind === 'compact').length, turns.length + compacts.length); f.noPeer();
});

async function partialFlow(t: TestContext, backend: 'sqlite' | 'file-journal', scenario: 'nonfinal' | 'adopted_partial') {
  const f = await fixture(t, backend, scenario);
  assert.equal(f.before.state.attempts[0]!.adopted, scenario === 'adopted_partial');
  const forbidden = (['discover', 'call', 'close'] as const).map(method =>
    t.mock.method(McpStdioClient.prototype, method, () => assert.fail(`stored HTTP invoked client.${method}`)));
  const web = await connect(f, 'stored_only');
  await web.request<WorkViewResult>(`/api/works/${f.marker.workId}/view`);
  assert.deepEqual(await f.inspect(), f.before); f.noPeer();
  const first = await web.run('stored-run-1'); assert.equal(first.view.kind, 'snapshot'); if (first.view.kind !== 'snapshot') assert.fail();
  assert.equal(first.view.view.progress.status, 'waiting'); assert.equal(first.view.view.progress.reason, 'connection_required');
  assert.equal(first.view.view.messages.some(value => value.kind === 'result'), false);
  const waiting = await f.inspect(); originals(f, waiting);
  assert.equal(waiting.state.attempts.length, 1); assert.equal(waiting.state.attempts[0]!.adopted, scenario === 'adopted_partial');
  assert.equal(waiting.state.attempts[0]!.readProgress!.unknownCalls, 0);
  assert.equal(waiting.state.attempts[0]!.readProgress!.phase, scenario === 'nonfinal' ? 'running' : 'partial');
  const oldHead = waiting.checkpoints[0]!.checkpoint, retained = oldHead.collection.pages.flatMap(page => page.items)
    .concat(oldHead.collection.pending?.items.filter(item => item.status === 'success') ?? []);
  assert.deepEqual(retained.map(value => value.id), scenario === 'nonfinal' ? ['a', 'b'] : ['a']);
  assert.deepEqual(waiting.state.budget, f.before.state.budget); assert.equal(waiting.state.modelCalls.length, 0); f.noPeer();
  const repeat = await web.run('stored-run-2'); assert.equal(repeat.view.kind, 'snapshot'); if (repeat.view.kind !== 'snapshot') assert.fail();
  assert.equal(repeat.view.view.progress.reason, 'connection_required');
  await web.app.close();
  const reopened = await connect(f, 'stored_only'), repeatOpen = await reopened.run('stored-run-3');
  assert.equal(repeatOpen.view.kind, 'snapshot'); if (repeatOpen.view.kind !== 'snapshot') assert.fail();
  assert.equal(repeatOpen.view.view.progress.reason, 'connection_required');
  const stable = await f.inspect(); assert.deepEqual(stable.state.attempts, waiting.state.attempts); assert.deepEqual(stable.state.budget, waiting.state.budget);
  assert.equal(entryObservations(f.options).filter(value => value.kind === 'turn' || value.kind === 'compact').length, 0);
  assert.equal(entryObservations(f.options).filter(value => value.kind === 'fetch').length, 1); f.noPeer(); await reopened.app.close();
  for (const method of forbidden) method.mock.restore();
  const online = await connect(f, 'online'), result = await online.run('online-run');
  assert.equal(result.view.kind, 'snapshot'); if (result.view.kind !== 'snapshot') assert.fail();
  assert.equal(result.view.view.progress.status, 'completed'); assert.equal(result.view.view.progress.resultDelivery, 'delivered');
  assert.equal(result.view.view.messages.find(value => value.kind === 'result')?.text, entryAnswer(scenario));
  const after = await f.inspect(), { checkpoint } = completedLineage(f, after, 1);
  const allItems = checkpoint.collection.pages.flatMap(page => page.items);
  for (const item of retained) assert.deepEqual(allItems.find(value => value.id === item.id), item);
  const calls = entryAudit(f.options).filter(row => row.event === 'call'); assert.equal(calls.length, 2);
  assert.notEqual(calls[1]!.requestId, calls[0]!.requestId);
  assert.deepEqual(calls[1]!.query, { ids: entryIds(scenario) });
  assert.deepEqual(calls[1]!.retryIds, scenario === 'adopted_partial' ? ['b'] : null);
  assert.equal(calls[1]!.snapshot, oldHead.collection.snapshot); assert.equal(calls[1]!.cursor, scenario === 'nonfinal' ? oldHead.collection.nextCursor : null);
  const responses = entryAudit(f.options).filter(row => row.event === 'handler-ready');
  assert.deepEqual(responses[1]!.returnedIds, scenario === 'nonfinal' ? ['c', 'd'] : ['b']);
  assert.equal(after.state.budget.used.modelCalls, 2); assert.equal(after.state.budget.used.tokens, 500);
  const duplicate = await online.run('online-run'); assert.equal(duplicate.duplicate, true);
  const again = await f.inspect(); assert.deepEqual(again.state.attempts, after.state.attempts); assert.deepEqual(again.state.budget, after.state.budget);
  assert.deepEqual(again.history, after.history); assert.equal(entryAudit(f.options).filter(row => row.event === 'call').length, 2);
  await online.app.close();
  for (const row of entryAudit(f.options).filter(value => value.event === 'start')) assert.equal(alive(row.pid), false);
}
for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: SIGKILL at a real nonfinal page resumes through HTTP, waits offline repeatedly and continues only the next online page`,
  { timeout: 60000 }, t => partialFlow(t, backend, 'nonfinal'));
test('sqlite: normally adopted partial batch retains its offline wait and explicitly retries only the failed item online',
  { timeout: 60000 }, t => partialFlow(t, 'sqlite', 'adopted_partial'));
