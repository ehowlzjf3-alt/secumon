import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolResultSchema } from '../application/contracts.js';
import { readGeneratedAnswer } from '../application/generated-answer.js';
import { taskFailureKey } from '../application/execution-decision.js';
import { captureProgress } from '../application/work-progress.js';
import { transact } from '../application/work-transactions.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { assertMcpPeersStopped, MCP_AGENT_TEXT, MCP_AGENT_TOOL, mcpFixtureAnswer, readMcpAudit } from './mcp-agent-profile-helper.js';
import { storedResultHost, type StoredResultMarker, type StoredResultStage } from './helpers/mcp-stored-result-worker.js';

const calls = (path: string) => readMcpAudit(path).filter(row => row.event === 'call');
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function waitForExit(pid: number) {
  const deadline = Date.now() + 5000;
  while (alive(pid)) {
    if (Date.now() >= deadline) throw new Error(`stored_result_owned_process_not_exited:${pid}`);
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}
async function boundedExit<T>(exited: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([exited, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('stored_result_worker_exit_not_observed')), 5000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function killAt(base: string, backend: 'sqlite' | 'file-journal', stage: StoredResultStage): Promise<StoredResultMarker> {
  const child = fork(new URL('./helpers/mcp-stored-result-worker.js', import.meta.url), [base, backend, stage],
    { execPath: process.execPath, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout!.resume(); let stderr = '', peerPid: number | null = null;
  child.stderr!.on('data', value => { stderr = (stderr + String(value)).slice(-16384); });
  const exit = once(child, 'exit'); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const marker = await Promise.race([
      new Promise<StoredResultMarker>((resolve, reject) => {
        child.on('message', value => {
          try {
            const message = value as { kind?: string; marker?: StoredResultMarker };
            assert.equal(message.kind, 'stored-result-checkpoint'); assert.ok(message.marker);
            const item = message.marker;
            assert.equal(item.workerPid, child.pid); assert.equal(item.backend, backend); assert.equal(item.stage, stage);
            assert.ok(Number.isSafeInteger(item.peerPid) && item.peerPid > 0 && item.peerPid !== child.pid && item.peerPid !== process.pid);
            peerPid = item.peerPid; resolve(item);
          } catch (error) { reject(error); }
        });
      }),
      exit.then(([code, signal]) => { throw new Error(`stored_result_worker_early_exit:${String(code)}:${String(signal)}:${stderr}`); }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`stored_result_checkpoint_timeout:${stderr}`)), 20000); }),
    ]);
    assert.equal(child.kill('SIGKILL'), true);
    const [code, signal] = await boundedExit(exit); assert.equal(code, null, stderr); assert.equal(signal, 'SIGKILL', stderr);
    await waitForExit(marker.workerPid); await waitForExit(marker.peerPid);
    assertMcpPeersStopped(marker.auditFile);
    assert.ok(readMcpAudit(marker.auditFile).some(row => row.event === 'close' && row.pid === marker.peerPid && row.reason === 'stdin-ended'));
    assert.equal(calls(marker.auditFile).length, stage === 'intent' ? 0 : 1);
    return marker;
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await boundedExit(exit); }
    // If setup failed before IPC, the only fallback PIDs come from this fresh
    // fixture's private audit file, never from a broad process-name search.
    const peers = new Set(readMcpAudit(join(base, 'peer.jsonl')).filter(row => row.event === 'start').map(row => row.pid).filter((pid): pid is number => typeof pid === 'number'));
    if (peerPid !== null) peers.add(peerPid);
    for (const pid of peers) if (pid !== process.pid && pid !== child.pid && alive(pid)) { process.kill(pid, 'SIGKILL'); await waitForExit(pid); }
  }
}

async function fixture(t: TestContext, backend: 'sqlite' | 'file-journal', stage: StoredResultStage) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-stored-result-'))), active = new Set<AgentTurnProfile>();
  t.after(async () => {
    const errors: unknown[] = [];
    try { for (const profile of active) { try { await profile.close(); } catch (error) { errors.push(error); } } }
    finally { rmSync(base, { recursive: true, force: true }); }
    if (errors.length) throw new AggregateError(errors, 'stored_result_fixture_cleanup_failed');
  });
  const marker = await killAt(base, backend, stage);
  return { marker,
    async open() {
      const configured = storedResultHost({ auditFile: marker.auditFile, documentValue: 47 });
      const profile = await openAgentTurnProfile(marker.directory, { provider: 'registered' }, configured.host); active.add(profile);
      assert.equal(profile.agentId, marker.agentId); assert.notEqual(profile.runtime.owner, marker.state.attempts[0]!.owner);
      assert.ok(profile.services.clock.now() > marker.state.attempts[0]!.leaseUntil);
      assert.ok(profile.services.clock.now() < marker.state.deadlineAt);
      return { profile, observed: configured.observed };
    },
    async close(profile: AgentTurnProfile) { try { await profile.close(); } finally { active.delete(profile); } assertMcpPeersStopped(marker.auditFile); },
  };
}

async function sourceReceipts(profile: AgentTurnProfile, marker: StoredResultMarker) {
  return Promise.all(['dispatch', 'mcp-intent', 'mcp-response'].map(name => profile.services.state.receipt(marker.workId, `${name}:${marker.attemptId}`)));
}

for (const backend of ['sqlite', 'file-journal'] as const) for (const stage of ['response', 'receive'] as const) {
  test(`${backend}: actual SIGKILL after MCP ${stage} commit resumes the original call after its owner's lease without duplicate usage or conversation`, { timeout: 60000 }, async t => {
    const f = await fixture(t, backend, stage), marker = f.marker;
    let { profile, observed } = await f.open();
    const before = await profile.runtime.state(marker.workId), original = before.attempts[0]!;
    assert.deepEqual(before, marker.state); assert.equal(original.id, marker.attemptId);
    assert.equal(original.status, stage === 'receive' ? 'received' : 'running'); assert.equal(original.adopted, false);
    assert.equal(before.budget.used.toolCalls, before.budget.limits.toolCalls); assert.equal(before.budget.used.toolCalls, 1);
    assert.equal(before.budget.used.modelCalls, 1); assert.deepEqual(before.evidence, []);
    assert.ok(marker.raw);
    assert.equal(Buffer.from(await profile.services.artifacts.get(marker.raw.ref, before.policy)).toString('utf8'), marker.raw.text);
    const raw = JSON.parse(marker.raw.text) as { recordedAt: number; workId: string; attemptId: string; contractDigest: string; inputDigest: string };
    assert.equal(raw.recordedAt, marker.originalClock); assert.equal(raw.workId, before.id); assert.equal(raw.attemptId, original.id);
    assert.equal(raw.contractDigest, original.contractDigest); assert.equal(raw.inputDigest, original.inputDigest);
    const receipts = await sourceReceipts(profile, marker); assert.ok(receipts.every(Boolean));
    const priorReceive = await profile.services.state.receipt(before.id, `receive:${original.id}`);
    assert.equal(priorReceive !== null, stage === 'receive');
    assert.equal(profile.contracts.visible(profile.policy).find(tool => tool.id === MCP_AGENT_TOOL)?.version, original.toolVersion);
    assert.equal(observed.modelInputs.length, 0);

    if (stage === 'response') {
      await profile.runtime.recover(before.id, original.id);
      const recovered = await profile.runtime.state(before.id), attempt = recovered.attempts[0]!;
      assert.equal(attempt.status, 'received'); assert.equal(attempt.error, null); assert.equal(attempt.adopted, false);
      assert.equal(attempt.owner, original.owner); assert.equal(attempt.startedAt, original.startedAt); assert.equal(attempt.leaseUntil, original.leaseUntil);
      assert.ok(attempt.finishedAt! > attempt.leaseUntil); assert.equal(recovered.deadlineAt, before.deadlineAt);
      assert.deepEqual(recovered.budget, before.budget); assert.equal(observed.modelInputs.length, 0);
    }
    const received = await profile.runtime.state(before.id), attempt = received.attempts[0]!;
    assert.ok(attempt.resultArtifact);
    const result = ToolResultSchema.parse(JSON.parse(Buffer.from(await profile.services.artifacts.get(attempt.resultArtifact, received.policy)).toString('utf8')));
    assert.equal(result.status, 'success'); assert.deepEqual(result.artifacts, [marker.raw.ref]);
    assert.equal(result.usage?.transportCalls, 1); assert.equal(attempt.execution?.usage.transportCalls, 1);
    assert.equal(attempt.execution?.implementationCalls, 1); assert.equal(attempt.execution?.mode, 'invoked');
    assert.equal(await profile.contracts.validateResult(received, result), true);
    assert.deepEqual(await sourceReceipts(profile, marker), receipts);
    if (priorReceive) assert.deepEqual(await profile.services.state.receipt(before.id, `receive:${original.id}`), priorReceive);

    assert.equal((await profile.workflow.run(before.id, profile.actor)).control.kind, 'complete');
    const done = await profile.runtime.state(before.id);
    assert.equal(done.attempts.length, 1); assert.equal(done.attempts[0]!.id, original.id); assert.equal(done.attempts[0]!.owner, original.owner);
    assert.equal(done.attempts[0]!.adopted, true); assert.equal(done.attempts[0]!.error, null);
    assert.equal(done.evidence.length, 1); assert.equal(done.evidence[0]!.facts.value, 47); assert.deepEqual(done.evidence[0]!.artifact, marker.raw.ref);
    assert.equal((await readGeneratedAnswer(profile.services, done))?.text, mcpFixtureAnswer(47));
    assert.equal(done.budget.used.toolCalls, 1); assert.equal(done.budget.used.modelCalls, 2); assert.equal(done.budget.used.tokens, 500);
    assert.equal(observed.modelInputs.length, 1); assert.equal(calls(marker.auditFile).length, 1);
    const events = await profile.services.state.events(done.id, 0);
    assert.equal(events.filter(event => event.type === 'result_received').length, 1);
    assert.equal(events.filter(event => event.type === 'result_settled').length, 1);
    const sessionId = done.conversation!.session!.scope.sessionId;
    const history = await profile.sessions.history(profile.actor, sessionId, profile.policy, { limit: 100 });
    assert.equal(history.entries.filter(entry => entry.role === 'user' && entry.text === MCP_AGENT_TEXT).length, 1);
    assert.equal(history.entries.filter(entry => entry.role === 'assistant' && entry.text === mcpFixtureAnswer(47)).length, 1);
    await f.close(profile);

    ({ profile, observed } = await f.open());
    assert.equal((await profile.workflow.run(done.id, profile.actor)).control.kind, 'complete');
    assert.deepEqual((await profile.runtime.state(done.id)).budget, done.budget);
    assert.deepEqual((await profile.runtime.state(done.id)).progress, done.progress);
    assert.deepEqual(await profile.sessions.history(profile.actor, sessionId, profile.policy, { limit: 100 }), history);
    assert.deepEqual(await sourceReceipts(profile, marker), receipts);
    assert.equal(observed.modelInputs.length, 0); assert.equal(calls(marker.auditFile).length, 1);
    assert.equal(readMcpAudit(marker.auditFile).filter(row => row.event === 'method' && row.method === 'tools/list').length, 3,
      'each profile still performs discovery; this is not offline recovery');
    assert.equal((await profile.services.state.deliveries(done.id)).filter(delivery => delivery.kind === 'result' && delivery.status === 'delivered').length, 1);
    await f.close(profile);
  });
}

for (const backend of ['sqlite', 'file-journal'] as const) for (const stage of ['intent', 'artifact'] as const) {
  test(`${backend}: actual SIGKILL after MCP ${stage} without a response receipt blocks recovery and never hides another read`, { timeout: 60000 }, async t => {
    const f = await fixture(t, backend, stage), marker = f.marker;
    let { profile, observed } = await f.open();
    const before = await profile.runtime.state(marker.workId), receipts = await sourceReceipts(profile, marker);
    assert.ok(receipts[0] && receipts[1]); assert.equal(receipts[2], null);
    assert.equal(before.attempts[0]!.resultArtifact, null); assert.equal(before.attempts[0]!.execution?.mode, 'unreported');
    assert.equal(before.attempts[0]!.execution?.usage.transportCalls, null);
    assert.equal(marker.raw !== null, stage === 'artifact');
    if (marker.raw) assert.equal(Buffer.from(await profile.services.artifacts.get(marker.raw.ref, before.policy)).toString('utf8'), marker.raw.text);
    await profile.runtime.recover(before.id, marker.attemptId);
    const stopped = await profile.runtime.state(before.id);
    assert.equal(stopped.status, 'blocked'); assert.equal(stopped.statusReason, 'stored_result_unavailable');
    assert.equal(stopped.attempts[0]!.status, 'failed'); assert.deepEqual(stopped.attempts[0]!.error, { code: 'stored_result_unavailable', retryable: false });
    assert.equal(stopped.attempts[0]!.resultArtifact, null); assert.deepEqual(stopped.attempts[0]!.execution, before.attempts[0]!.execution);
    assert.deepEqual(stopped.budget, before.budget); assert.equal(stopped.generatedAnswer, undefined); assert.deepEqual(stopped.evidence, []);
    assert.equal(await profile.services.state.receipt(before.id, `receive:${marker.attemptId}`), null);
    assert.equal((await profile.workflow.run(before.id, profile.actor)).control.kind, 'blocked');
    assert.equal(observed.modelInputs.length, 0); assert.equal(calls(marker.auditFile).length, stage === 'intent' ? 0 : 1);
    await f.close(profile);
    ({ profile, observed } = await f.open());
    assert.equal((await profile.workflow.run(before.id, profile.actor)).control.kind, 'blocked');
    const again = await profile.runtime.state(before.id);
    assert.equal(again.attempts.length, 1); assert.equal(again.attempts[0]!.id, marker.attemptId); assert.deepEqual(again.budget, before.budget);
    assert.deepEqual(await sourceReceipts(profile, marker), receipts); assert.equal(observed.modelInputs.length, 0);
    assert.equal(calls(marker.auditFile).length, stage === 'intent' ? 0 : 1);
    assert.equal((await profile.services.state.events(before.id, 0)).filter(event => event.type === 'result_received').length, 0);
    assert.equal((await profile.services.state.deliveries(before.id)).filter(delivery => delivery.kind === 'result').length, 0);
    await f.close(profile);
  });
}

test('a historical lease-only recovery receipt preserves its failure history and records restored progress once on the next general step', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'sqlite', 'response'), marker = f.marker;
  let { profile, observed } = await f.open();
  const before = await profile.runtime.state(marker.workId), receipts = await sourceReceipts(profile, marker);
  // Reproduce the previous executor's persisted transition, not the new recover
  // behavior. This is a historical fixture after a real response-commit SIGKILL.
  await transact(profile.services, before.id, `recover:${marker.attemptId}`, 'attempt_recovered', { attemptId: marker.attemptId }, state => {
    const attempt = state.attempts.find(value => value.id === marker.attemptId)!;
    assert.equal(attempt.status, 'running'); assert.ok(profile.services.clock.now() >= attempt.leaseUntil);
    attempt.status = 'failed'; attempt.effectState = 'none'; attempt.finishedAt = profile.services.clock.now();
    attempt.error = { code: 'lease_expired', retryable: true };
    const task = state.plan!.tasks.find(value => value.id === attempt.taskId)!;
    captureProgress(state, profile.services.digester, `attempt:${attempt.id}:settled`, profile.services.clock.now(),
      { failureKey: taskFailureKey(state, task, profile.services.digester) });
    state.status = 'ready'; state.statusReason = 'lease_expired';
  });
  const expired = await profile.runtime.state(before.id), oldReceipt = await profile.services.state.receipt(before.id, `recover:${marker.attemptId}`);
  assert.ok(oldReceipt); assert.ok(expired.progress!.processed.includes(`attempt:${marker.attemptId}:settled`));
  await profile.runtime.step(before.id);
  const restored = await profile.runtime.state(before.id);
  assert.ok(await profile.services.state.receipt(before.id, `receive:${marker.attemptId}`));
  assert.equal(restored.attempts.length, 1); assert.deepEqual(restored.budget, expired.budget);
  assert.equal(observed.modelInputs.length, 0); assert.equal(calls(marker.auditFile).length, 1);
  assert.equal((await profile.workflow.run(before.id, profile.actor)).control.kind, 'complete');
  const done = await profile.runtime.state(before.id);
  assert.equal(done.attempts[0]!.adopted, true); assert.equal(done.budget.used.toolCalls, 1);
  assert.ok(done.progress!.processed.includes(`attempt:${marker.attemptId}:settled`));
  assert.ok(done.progress!.productiveSteps > expired.progress!.productiveSteps);
  assert.deepEqual(await profile.services.state.receipt(before.id, `recover:${marker.attemptId}`), oldReceipt);
  assert.equal((await profile.services.state.events(before.id, 0)).filter(event => event.type === 'attempt_recovered').length, 1);
  assert.deepEqual(await sourceReceipts(profile, marker), receipts);
  await f.close(profile);
  ({ profile, observed } = await f.open());
  assert.equal((await profile.workflow.run(before.id, profile.actor)).control.kind, 'complete');
  assert.deepEqual((await profile.runtime.state(before.id)).progress, done.progress);
  assert.deepEqual((await profile.runtime.state(before.id)).budget, done.budget);
  assert.equal(observed.modelInputs.length, 0); assert.equal(calls(marker.auditFile).length, 1);
  await f.close(profile);
});
