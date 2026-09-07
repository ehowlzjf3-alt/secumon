import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSqliteRecoveryWorker, SqliteRecoveryWorkerFault, sqliteRecoveryProcessLimits } from '../infrastructure/agent-sqlite-recovery-process.js';
import type { SqliteRecoveryWorkerRequest, SqliteRecoveryValidationResult } from '../application/agent-sqlite-recovery-validation-contracts.js';

// V03-R06: simulated child events only; no process, database or OS recovery is performed.
const request: SqliteRecoveryWorkerRequest = {
  mode: 'recover', candidatePath: join(tmpdir(), 'unopened-recovery-process-fixture.sqlite'),
  validation: { agentId: '11111111-1111-4111-8111-111111111111', kind: 'state' },
};
const report: SqliteRecoveryValidationResult = {
  agentId: request.validation.agentId, kind: 'state', schemaVersion: 1,
  pageSize: 4096, pageCount: 1, sqliteVersion: 'event-contract-fixture',
  schemaDigest: 'a'.repeat(64), personalMemoryFence: null,
};
const reply = () => ({ request, result: report });

class ChildStub extends EventEmitter {
  readonly pid = 424242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly sent: unknown[] = [];
  readonly kills: Array<NodeJS.Signals | number | undefined> = [];
  connected = true;
  disconnects = 0;
  unrefs = 0;
  killError: Error | undefined;
  send(value: unknown, callback: (error: Error | null) => void) {
    this.sent.push(value); callback(null); return true;
  }
  kill(signal?: NodeJS.Signals | number) {
    this.kills.push(signal);
    if (this.killError) throw this.killError;
    return true;
  }
  disconnect() { this.connected = false; this.disconnects++; }
  unref() { this.unrefs++; }
}

function fixture(t: TestContext) {
  const child = new ChildStub(), originalFork = childProcess.fork, forks: unknown[][] = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  Reflect.set(childProcess, 'fork', (...args: unknown[]) => {
    forks.push(args); return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    Reflect.set(childProcess, 'fork', originalFork); syncBuiltinESMExports();
    // Settle a pending invocation even if an earlier assertion failed, then remove its timers.
    child.emit('close', null, 'SIGKILL');
    child.stdout.destroy(); child.stderr.destroy(); t.mock.timers.reset();
  });
  return { child, forks };
}

function watch(promise: Promise<SqliteRecoveryValidationResult>) {
  let settled = false;
  const outcome = promise.then(
    value => { settled = true; return { kind: 'result' as const, value }; },
    (error: unknown) => { settled = true; return { kind: 'error' as const, error }; },
  );
  return { outcome, get settled() { return settled; } };
}
async function stillPending(run: ReturnType<typeof watch>) {
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(run.settled, false);
}
async function rejected(run: ReturnType<typeof watch>) {
  const outcome = await run.outcome;
  if (outcome.kind !== 'error') assert.fail('worker must reject');
  assert.ok(outcome.error instanceof SqliteRecoveryWorkerFault);
  return outcome.error;
}
function failureAt(error: SqliteRecoveryWorkerFault, stage: string, code: string) {
  const entry = error.failures.find(item => item.stage === stage);
  assert.ok(entry, `missing failure stage ${stage}`);
  assert.ok(entry.error instanceof Error);
  assert.equal((entry.error as Error & { code?: string }).code, `agent_sqlite_recovery_worker_${code}`);
  return entry.error;
}

test('recovery process event contract: a valid reply waits for both exit zero and matching close', async t => {
  const { child, forks } = fixture(t), run = watch(runSqliteRecoveryWorker(request));
  assert.equal(forks.length, 1);
  assert.deepEqual(forks[0]?.[0], new URL('../infrastructure/agent-sqlite-recovery-worker.js', import.meta.url));
  assert.deepEqual(child.sent, [request]);
  child.emit('message', reply()); await stillPending(run);
  child.emit('exit', 0, null); await stillPending(run);
  child.emit('close', 0, null);
  assert.deepEqual(await run.outcome, { kind: 'result', value: report });
  t.mock.timers.tick(sqliteRecoveryProcessLimits.timeoutMs + sqliteRecoveryProcessLimits.terminalMs);
  assert.deepEqual(child.kills, []);
});

for (const mismatch of ['request', 'result-agent', 'result-kind', 'duplicate'] as const) {
  test(`recovery process event contract: ${mismatch} reply cannot succeed even with exit zero`, async t => {
    const { child } = fixture(t), run = watch(runSqliteRecoveryWorker(request));
    if (mismatch === 'request') child.emit('message', { request: { ...request, mode: 'verify' }, result: report });
    else if (mismatch === 'result-agent') child.emit('message', { request, result: { ...report, agentId: '22222222-2222-4222-8222-222222222222' } });
    else if (mismatch === 'result-kind') child.emit('message', { request, result: { ...report, kind: 'channel' } });
    else { child.emit('message', reply()); child.emit('message', reply()); }
    assert.deepEqual(child.kills, ['SIGKILL']); await stillPending(run);
    child.emit('exit', 0, null); child.emit('close', 0, null);
    const error = await rejected(run);
    failureAt(error, 'protocol', mismatch === 'duplicate' ? 'multiple_replies' : mismatch === 'request' ? 'request_mismatch' : 'result_mismatch');
    assert.deepEqual(error.workerExit, { observed: true, code: 0, signal: null, pid: child.pid, closed: true });
  });
}

for (const reason of ['deadline', 'abort'] as const) {
  test(`recovery process event contract: ${reason} survives a late successful reply and still waits for exit and close`, async t => {
    const { child } = fixture(t), controller = new AbortController(), cause = new Error('host-abort-reason');
    const run = watch(runSqliteRecoveryWorker(request, { timeoutMs: 25, signal: controller.signal }));
    if (reason === 'deadline') {
      t.mock.timers.tick(24); assert.deepEqual(child.kills, []);
      t.mock.timers.tick(1);
    } else controller.abort(cause);
    assert.deepEqual(child.kills, ['SIGKILL']); await stillPending(run);
    child.emit('message', reply()); await stillPending(run);
    // A racing success and clean termination cannot undo the host's earlier stop decision.
    child.emit('exit', 0, null); await stillPending(run);
    child.emit('close', 0, null);
    const error = await rejected(run), first = failureAt(error, reason, reason === 'abort' ? 'aborted' : 'deadline');
    assert.equal(error.cause, first);
    if (reason === 'abort') assert.equal(first.cause, cause);
    assert.deepEqual(error.failures.map(item => item.stage), [reason]);
    assert.deepEqual(error.report, reply());
    assert.deepEqual(error.workerExit, { observed: true, code: 0, signal: null, pid: child.pid, closed: true });
    assert.deepEqual(child.kills, ['SIGKILL']);
  });
}

test('recovery process event contract: process and kill errors retain their original objects', async t => {
  const { child } = fixture(t), primary = new Error('process-error'), cleanup = new Error('kill-error');
  child.killError = cleanup;
  const run = watch(runSqliteRecoveryWorker(request));
  child.emit('error', primary); await stillPending(run);
  child.emit('exit', 1, null); child.emit('close', 1, null);
  const error = await rejected(run);
  assert.equal(error.cause, primary);
  assert.equal(error.failures.find(item => item.stage === 'process')?.error, primary);
  assert.equal(error.failures.find(item => item.stage === 'kill')?.error, cleanup);
  assert.equal(error.workerExit.observed, true); assert.equal(error.workerExit.closed, true);
});

test('recovery process event contract: remote validation cause and independent close error survive rejection', async t => {
  const { child } = fixture(t), run = watch(runSqliteRecoveryWorker(request));
  child.emit('message', { request, error: {
    name: 'AggregateError', message: 'validation-and-close',
    cause: { name: 'Error', message: 'integrity-invalid', code: 'SQLITE_CORRUPT', errcode: 11 },
    errors: [{ stage: 'close', error: { name: 'Error', message: 'close-error', code: 'EIO' } }],
  } });
  await stillPending(run); child.emit('exit', 1, null); child.emit('close', 1, null);
  const error = await rejected(run), remote = error.failures.find(item => item.stage === 'worker')?.error;
  assert.ok(remote instanceof Error); assert.equal(error.cause, remote);
  assert.equal(remote.name, 'AggregateError'); assert.equal(remote.message, 'validation-and-close');
  assert.ok(remote.cause instanceof Error); assert.equal(remote.cause.message, 'integrity-invalid');
  const cause = remote.cause as Error & { code: string; errcode: number };
  assert.equal(cause.code, 'SQLITE_CORRUPT'); assert.equal(cause.errcode, 11);
  const independent = (remote as Error & { errors: Array<{ stage: string; error: Error & { code: string } }> }).errors;
  assert.equal(independent.length, 1); assert.equal(independent[0]?.stage, 'close');
  assert.equal(independent[0]?.error.message, 'close-error'); assert.equal(independent[0]?.error.code, 'EIO');
});

test('recovery process event contract: stdout and stderr share one bounded output allowance', async t => {
  const { child } = fixture(t), run = watch(runSqliteRecoveryWorker(request));
  const half = sqliteRecoveryProcessLimits.outputBytes / 2;
  child.stdout.write(Buffer.alloc(half, 'a')); child.stderr.write(Buffer.alloc(half, 'b'));
  assert.deepEqual(child.kills, []);
  child.stderr.write(Buffer.from('c'));
  assert.deepEqual(child.kills, ['SIGKILL']); await stillPending(run);
  child.emit('exit', null, 'SIGKILL'); child.emit('close', null, 'SIGKILL');
  const error = await rejected(run); failureAt(error, 'output', 'output_limit');
  assert.equal(error.output.stdout, 'a'.repeat(half)); assert.equal(error.output.stderr, 'b'.repeat(half));
  assert.equal(Buffer.byteLength(error.output.stdout) + Buffer.byteLength(error.output.stderr), sqliteRecoveryProcessLimits.outputBytes);
});

test('recovery process event contract: oversized IPC reply is rejected before accepting a report', async t => {
  const { child } = fixture(t), run = watch(runSqliteRecoveryWorker(request));
  child.emit('message', 'x'.repeat(sqliteRecoveryProcessLimits.replyBytes));
  assert.deepEqual(child.kills, ['SIGKILL']); await stillPending(run);
  child.emit('exit', 0, null); child.emit('close', 0, null);
  const error = await rejected(run); failureAt(error, 'protocol', 'reply_limit');
  assert.equal(error.report, null);
});

for (const terminal of ['no-exit', 'no-close'] as const) {
  test(`recovery process event contract: ${terminal} rejects at the bounded observation deadline with honest flags`, async t => {
    const { child } = fixture(t), controller = new AbortController();
    const run = watch(runSqliteRecoveryWorker(request, { signal: controller.signal }));
    if (terminal === 'no-exit') controller.abort(new Error('stop-without-terminal-events'));
    else { child.emit('message', reply()); child.emit('exit', 0, null); }
    t.mock.timers.tick(sqliteRecoveryProcessLimits.terminalMs - 1); await stillPending(run);
    t.mock.timers.tick(1);
    const error = await rejected(run), observed = terminal === 'no-close';
    failureAt(error, observed ? 'close_observation' : 'exit_observation', observed ? 'close_unobserved' : 'exit_unobserved');
    assert.deepEqual(error.workerExit, { observed, code: observed ? 0 : null, signal: null, pid: child.pid, closed: false });
    assert.deepEqual(child.kills, observed ? [] : ['SIGKILL', 'SIGKILL']);
    assert.equal(child.disconnects, 1); assert.equal(child.unrefs, 1);
    assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
  });
}

test('recovery process event contract: close without a preceding exit is not successful termination', async t => {
  const { child } = fixture(t), run = watch(runSqliteRecoveryWorker(request));
  child.emit('message', reply()); child.emit('close', 0, null);
  const error = await rejected(run); failureAt(error, 'exit', 'exit_invalid');
  assert.deepEqual(error.workerExit, { observed: false, code: null, signal: null, pid: child.pid, closed: true });
});
