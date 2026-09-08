import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readCrashEvidence, RecoveredSchema, StoppedSchema } from './peer-acceptance-crash-fixture.js';

const MessageSchema = z.strictObject({ kind: z.enum(['stopped', 'recovered']), pid: z.number().int().positive() });
async function bounded<T>(value: Promise<T>, milliseconds: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([value, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function runWorker(directory: string, mode: 'crash' | 'recover', signal: AbortSignal) {
  signal.throwIfAborted();
  const child = fork(new URL('./peer-acceptance-crash-worker.js', import.meta.url), [directory, mode],
    { execPath: process.execPath, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '', spawnError: Error | undefined, closedObserved = false, exitObserved = false;
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.stdout!.resume(); child.stderr!.on('data', value => { stderr = (stderr + String(value)).slice(-16384); });
  child.on('error', error => { spawnError = error; });
  child.once('exit', (code, signal) => { exitObserved = true; exited = { code, signal }; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => { closedObserved = true; resolve({ code, signal }); });
  });
  const abort = () => { if (!exitObserved) child.kill('SIGKILL'); };
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  const messages: unknown[] = [];
  const announced = new Promise<unknown>(resolve => { child.on('message', value => { messages.push(value); resolve(value); }); });
  let failure: unknown;
  try {
    // Parent deadlines are bounded independently of the worker's 55-second emergency exit.
    const message = MessageSchema.parse(await bounded(Promise.race([announced, closed.then(() => {
      throw new Error(`peer_acceptance_${mode}_closed_before_checkpoint: ${stderr}`, { cause: spawnError });
    })]), mode === 'crash' ? 15000 : 45000, `peer_acceptance_${mode}_checkpoint_timeout`));
    assert.equal(message.pid, child.pid); assert.equal(message.kind, mode === 'crash' ? 'stopped' : 'recovered');
    if (mode === 'crash') {
      const marker = StoppedSchema.parse(readCrashEvidence(directory, 'stopped'));
      assert.equal(marker.pid, child.pid); assert.equal(exitObserved, false);
      assert.equal(child.kill('SIGKILL'), true, 'kill only the owned process after its durable acceptance evidence');
    }
    const terminal = await bounded(closed, 5000, `peer_acceptance_${mode}_terminal_unobserved`);
    assert.equal(exitObserved, true); assert.deepEqual(terminal, exited); assert.equal(messages.length, 1, stderr);
    assert.equal(spawnError, undefined); assert.equal(terminal.code, mode === 'crash' ? null : 0, stderr);
    assert.equal(terminal.signal, mode === 'crash' ? 'SIGKILL' : null, stderr);
  } catch (error) { failure = error; }
  finally {
    if (!closedObserved) {
      if (!exitObserved) child.kill('SIGKILL');
      try { await bounded(closed, 5000, 'peer_acceptance_cleanup_terminal_unobserved'); }
      catch (error) { failure = failure ? new AggregateError([failure, error], 'peer_acceptance_cleanup_failed', { cause: failure }) : error; }
    }
    signal.removeEventListener('abort', abort);
  }
  // If the terminal state is unknown, leave the private directory intact for inspection.
  if (failure) throw Object.assign(new Error(`peer_acceptance_${mode}_failed: ${stderr}`, { cause: failure }), { terminalObserved: closedObserved });
}

test('SIGKILL after peer acceptance before caller ticket custody reuses the original recipient and settles one explicit resume',
  { timeout: 60000, skip: process.platform === 'win32' ? 'POSIX SIGKILL and directory fsync acceptance; native Windows crash recovery is separate.' : false }, async t => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'peer-acceptance-crash-')));
    let removable = true;
    try {
      await runWorker(directory, 'crash', t.signal);
      const stopped = StoppedSchema.parse(readCrashEvidence(directory, 'stopped'));
      assert.equal(stopped.caller.attempts[0]!.status, 'running'); assert.equal(stopped.receiver.attempts.length, 0);
      assert.equal(stopped.receiver.modelCalls.length, 0);
      await runWorker(directory, 'recover', t.signal);
      const recovered = RecoveredSchema.parse(readCrashEvidence(directory, 'recovered'));
      assert.notEqual(recovered.pid, stopped.pid); assert.deepEqual(recovered.ticket, stopped.ticket);
      assert.equal(recovered.callerId, stopped.caller.id); assert.equal(recovered.receiverId, stopped.receiver.id);
      assert.equal(recovered.oldAttemptId, stopped.caller.attempts[0]!.id); assert.notEqual(recovered.resumeAttemptId, recovered.oldAttemptId);
      assert.equal(recovered.callerModels, 1); assert.equal(recovered.callerTools, 2);
      assert.equal(recovered.receiverModels, 1); assert.equal(recovered.receiverTools, 0);
      assert.equal(recovered.receiverResultDeliveries, 1); assert.equal(recovered.oldLeasesPreserved, true);
      assert.equal(recovered.callerCompleted, false);
    } catch (error) {
      if (error && typeof error === 'object' && 'terminalObserved' in error && error.terminalObserved === false) removable = false;
      throw error;
    } finally { if (removable) rmSync(directory, { recursive: true, force: true }); }
  });
