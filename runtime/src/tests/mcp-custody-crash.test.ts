import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkState } from '../domain/model.js';
import { toolExecution } from '../application/tool-execution-usage.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { assertMcpPeersStopped, readMcpAudit } from './mcp-agent-profile-helper.js';
import type { CustodyCrashObservation, CustodyCrashStage } from './mcp-custody-crash-worker.js';

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function exited(pid: number) {
  const until = Date.now() + 5000;
  while (alive(pid)) {
    if (Date.now() >= until) throw new Error(`custody_crash_owned_process_live:${pid}`);
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}
async function bounded<T>(pending: Promise<T>, ms: number, reason: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(reason())), ms);
  })]); } finally { if (timer) clearTimeout(timer); }
}
async function runWorker(base: string, backend: 'sqlite' | 'file-journal', stage: CustodyCrashStage,
  mode: 'crash' | 'recover', attemptId?: string): Promise<CustodyCrashObservation> {
  const child = fork(new URL('./mcp-custody-crash-worker.js', import.meta.url), [base, backend, stage, mode, ...(attemptId ? [attemptId] : [])],
    { execPath: process.execPath, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout!.resume(); let stderr = '';
  child.stderr!.on('data', value => { stderr = (stderr + String(value)).slice(-16384); });
  const exit = once(child, 'exit');
  const message = new Promise<CustodyCrashObservation>((resolve, reject) => {
    child.once('error', reject); child.once('message', value => {
      try {
        const observation = value as CustodyCrashObservation;
        assert.equal(observation.kind, mode === 'crash' ? 'checkpoint' : 'recovered');
        assert.equal(observation.pid, child.pid); assert.equal(observation.backend, backend); assert.equal(observation.stage, stage);
        resolve(observation);
      } catch (error) { reject(error); }
    });
  });
  try {
    const result = await bounded(Promise.race([message, exit.then(([code, signal]) => {
      throw new Error(`custody_crash_early_exit:${String(code)}:${String(signal)}:${stderr}`);
    })]), 20000, () => `custody_crash_checkpoint_timeout:${stderr}`);
    if (mode === 'crash') {
      assert.equal(child.kill('SIGKILL'), true);
      const [code, signal] = await bounded(exit, 5000, () => `custody_crash_kill_timeout:${stderr}`);
      assert.equal(code, null, stderr); assert.equal(signal, 'SIGKILL', stderr);
      assert.ok(Number.isSafeInteger(result.peerPid) && result.peerPid! > 0 && result.peerPid !== child.pid && result.peerPid !== process.pid);
      await exited(result.pid); await exited(result.peerPid!);
      assertMcpPeersStopped(join(base, 'peer.jsonl'));
    } else {
      const [code, signal] = await bounded(exit, 5000, () => `custody_crash_reopen_exit_timeout:${stderr}`);
      assert.equal(code, 0, stderr); assert.equal(signal, null, stderr);
    }
    return result;
  } finally {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL'); await bounded(exit, 5000, () => `custody_crash_cleanup_timeout:${stderr}`);
      }
    } finally {
      // Only the crash worker acquires a peer. The offline worker cannot claim historical audit PIDs.
      if (mode === 'crash') {
        const peers = readMcpAudit(join(base, 'peer.jsonl')).filter(row => row.event === 'start').map(row => row.pid);
        for (const pid of peers) if (typeof pid === 'number' && pid > 0 && pid !== process.pid && pid !== child.pid && alive(pid)) {
          process.kill(pid, 'SIGKILL'); await exited(pid);
        }
      }
    }
  }
}
function originalAttempt(state: WorkState, id: string) {
  assert.equal(state.attempts.length, 1); const attempt = state.attempts[0]!; assert.equal(attempt.id, id); return attempt;
}

for (const backend of ['sqlite', 'file-journal'] as const) for (const stage of ['raw', 'response', 'usage'] as const) {
  test(`${backend}: actual stdio SIGKILL after ${stage} preserves cancelled, narrowed custody and accounts only a receipted original`, { timeout: 60000 }, async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-custody-crash-')));
    try {
      const stopped = await runWorker(base, backend, stage, 'crash');
      const original = originalAttempt(stopped.state, stopped.attemptId), responseId = `mcp-response:${original.id}`;
      assert.equal(stopped.state.status, 'cancelled'); assert.equal(stopped.state.statusReason, 'explicit stop after the real SDK reply');
      assert.deepEqual(stopped.state.policy.allowedLabels, []); assert.equal(original.adopted, false); assert.equal(original.resultArtifact, null);
      assert.equal(original.owner, stopped.runtimeOwner); assert.equal(original.startedAt, 1000); assert.equal(original.leaseUntil, 6000);
      assert.equal(stopped.state.budget.used.toolCalls, 1); assert.equal(stopped.state.budget.limits.toolCalls, 1);
      assert.equal(stopped.state.budget.used.modelCalls, 0); assert.equal(stopped.counters.calls, 1);
      assert.equal(stopped.counters.discoveries, 1); assert.equal(stopped.counters.executes, 1); assert.equal(stopped.counters.projections, 0);
      assert.ok(stopped.raw); assert.equal(stopped.counters.rawPuts, 1);
      assert.equal(createHash('sha256').update(stopped.raw.text).digest('hex'), stopped.raw.ref.sha256);
      assert.equal(Buffer.byteLength(stopped.raw.text), stopped.raw.ref.byteLength);
      const envelope = JSON.parse(stopped.raw.text) as { recordedAt: number; workId: string; attemptId: string; transportCalls: number; failure: unknown };
      assert.equal(envelope.recordedAt, 1000, 'SDK capture uses the original host clock, not the later commit clock');
      assert.equal(envelope.workId, stopped.workId); assert.equal(envelope.attemptId, original.id);
      assert.equal(envelope.transportCalls, 1); assert.equal(envelope.failure, null);
      const reported = toolExecution('invoked', { transportCalls: 1, internalOperations: null, imageBytes: null, waitMs: null });
      assert.deepEqual(original.execution, stage === 'usage' ? reported : toolExecution('unreported'));
      assert.equal(stopped.receipts[responseId] !== null, stage !== 'raw');
      const dispatch = stopped.receipts[`dispatch:${original.id}`]; assert.ok(dispatch);
      assert.deepEqual(dispatch.state.policy.allowedLabels, ['synthetic']);
      assert.equal(dispatch.state.policy.tenantId, stopped.state.policy.tenantId);
      assert.equal(dispatch.state.policy.principalId, stopped.state.policy.principalId);
      assert.deepEqual(dispatch.state.goal, stopped.state.goal);
      const auditBefore = readMcpAudit(join(base, 'peer.jsonl'));
      assert.equal(auditBefore.filter(row => row.event === 'call').length, 1);
      assert.ok(auditBefore.some(row => row.event === 'close' && row.pid === stopped.peerPid && row.reason === 'stdin-ended'));

      // This is a different process. It receives only the original work/attempt identity, never a raw-file path or candidate ref.
      const recovered = await runWorker(base, backend, stage, 'recover', stopped.attemptId);
      assert.notEqual(recovered.pid, stopped.pid); assert.notEqual(recovered.runtimeOwner, original.owner);
      assert.equal(recovered.agentId, stopped.agentId); assert.deepEqual(recovered.before, stopped.state);
      const after = originalAttempt(recovered.state, original.id);
      const normalized = structuredClone(recovered.state); normalized.revision = stopped.state.revision; normalized.updatedAt = stopped.state.updatedAt;
      normalized.attempts[0]!.execution = structuredClone(original.execution!);
      assert.deepEqual(normalized, stopped.state, 'accounting may only refine the original execution measurement');
      assert.deepEqual(after.execution, stage === 'raw' ? toolExecution('unreported') : reported);
      assert.equal(after.owner, original.owner); assert.equal(after.startedAt, original.startedAt); assert.equal(after.leaseUntil, original.leaseUntil);
      assert.deepEqual(recovered.state.policy, stopped.state.policy); assert.deepEqual(recovered.state.budget, stopped.state.budget);
      assert.deepEqual(recovered.state.evidence, []); assert.equal(after.resultArtifact, null); assert.equal(after.adopted, false);
      const usageEvents = recovered.events.filter(event => event.type === 'tool_execution_usage_recorded');
      assert.equal(usageEvents.length, stage === 'raw' ? 0 : 1);
      assert.equal(recovered.events.filter(event => ['result_received', 'result_settled'].includes(event.type)).length, 0);
      for (const [id, receipt] of Object.entries(stopped.receipts)) assert.deepEqual(recovered.receipts[id], receipt, `original receipt ${id}`);
      if (stage === 'raw') {
        assert.equal(recovered.returned, null); assert.equal(recovered.raw, null); assert.equal(recovered.counters.accountingRawReads, 0);
        assert.deepEqual(recovered.state, stopped.state); assert.deepEqual(recovered.state.artifacts, []);
        // Only after the recovery process has exited, inspect the test-observed exact orphan ref for byte preservation.
        // The recovery worker never receives this ref or enumerates the artifact directory.
        const profile = new FileAgentProfileStore(join(base, 'engine')).inspect(join(base, 'agent'));
        assert.equal(profile.status, 'ready'); assert.ok(profile.status === 'ready');
        const artifacts = new FileArtifactStore(profile.paths.artifacts);
        assert.equal(Buffer.from(await artifacts.get(stopped.raw.ref, dispatch.state.policy)).toString('utf8'), stopped.raw.text);
      } else {
        assert.deepEqual(recovered.returned, recovered.state); assert.deepEqual(recovered.raw, stopped.raw);
        assert.ok(recovered.receipts[usageEvents[0]!.commandId]); assert.ok(recovered.counters.accountingRawReads > 0);
        if (stage === 'usage') { assert.deepEqual(recovered.state, stopped.state); assert.deepEqual(recovered.events, stopped.events); }
      }
      assert.equal(recovered.counters.calls, 0); assert.equal(recovered.counters.discoveries, 0);
      assert.equal(recovered.counters.executes, 0); assert.equal(recovered.counters.projections, 0); assert.equal(recovered.counters.rawPuts, 0);
      assert.deepEqual(readMcpAudit(join(base, 'peer.jsonl')), auditBefore, 'recovery neither starts a peer nor adds a transport call');
      assertMcpPeersStopped(join(base, 'peer.jsonl'));
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}
