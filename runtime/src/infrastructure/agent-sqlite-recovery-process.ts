import { fork } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { SqliteRecoveryWorkerRequestSchema, SqliteRecoveryWorkerReplySchema,
  type SqliteRecoveryWorkerRequest, type SqliteRecoveryWorkerReply, type SqliteRecoveryWorkerError,
  type SqliteRecoveryValidationResult } from '../application/agent-sqlite-recovery-validation-contracts.js';

export const sqliteRecoveryProcessLimits = Object.freeze({ timeoutMs: 60000, replyBytes: 65536,
  outputBytes: 65536, terminalMs: 5000 });
export interface SqliteRecoveryWorkerExit {
  readonly observed: boolean;
  readonly code: number | null;
  readonly signal: string | null;
  readonly pid: number | null;
  readonly closed: boolean;
}
export interface SqliteRecoveryWorkerFailure { readonly stage: string; readonly error: unknown }
export class SqliteRecoveryWorkerFault extends Error {
  readonly code = 'agent_sqlite_recovery_worker_failed';
  constructor(readonly failures: readonly SqliteRecoveryWorkerFailure[], readonly workerExit: SqliteRecoveryWorkerExit,
    readonly report: unknown, readonly output: Readonly<{ stdout: string; stderr: string }>) {
    super('agent_sqlite_recovery_worker_failed', failures.length ? { cause: failures[0]!.error } : undefined);
  }
}
export interface SqliteRecoveryWorkerOptions { readonly signal?: AbortSignal; readonly timeoutMs?: number }
const failure = (code: string, cause?: unknown) => Object.assign(
  new Error(`agent_sqlite_recovery_worker_${code}`, cause === undefined ? undefined : { cause }),
  { code: `agent_sqlite_recovery_worker_${code}` });

function remoteError(value: SqliteRecoveryWorkerError, depth = 0): Error {
  const error = new Error(value.message, value.cause === undefined ? undefined :
    { cause: depth < 16 ? remoteError(value.cause, depth + 1) : value.cause });
  error.name = value.name;
  return Object.assign(error, {
    ...(value.code === undefined ? {} : { code: value.code }),
    ...(value.errcode === undefined ? {} : { errcode: value.errcode }),
    ...(value.errors === undefined ? {} : { errors: value.errors.map(item => ({ stage: item.stage,
      error: depth < 16 ? remoteError(item.error, depth + 1) : item.error })) }),
  });
}

/** Runs only the fixed validator worker. Path ownership and publication stay with the supervising host. */
export async function runSqliteRecoveryWorker(value: SqliteRecoveryWorkerRequest,
  options: SqliteRecoveryWorkerOptions = {}): Promise<SqliteRecoveryValidationResult> {
  const encodedRequest = JSON.stringify(SqliteRecoveryWorkerRequestSchema.parse(value));
  const timeoutMs = options.timeoutMs ?? sqliteRecoveryProcessLimits.timeoutMs, signal = options.signal;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > sqliteRecoveryProcessLimits.timeoutMs) throw failure('timeout_invalid');
  if (Buffer.byteLength(encodedRequest) > sqliteRecoveryProcessLimits.replyBytes) throw failure('request_limit');
  // Compare the actual JSON request sent over IPC, including omission of optional undefined fields.
  const request = SqliteRecoveryWorkerRequestSchema.parse(JSON.parse(encodedRequest));
  if (signal?.aborted) throw failure('aborted', signal.reason);
  return new Promise((resolve, reject) => {
    const child = fork(new URL('./agent-sqlite-recovery-worker.js', import.meta.url), [], {
      execPath: process.execPath, execArgv: [], serialization: 'json',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const failures: SqliteRecoveryWorkerFailure[] = [];
    let reply: SqliteRecoveryWorkerReply | undefined, seenMessage = false, settled = false, stopping = false;
    let exitObserved = false, exitCode: number | null = null, exitSignal: string | null = null;
    let deadlineTimer: NodeJS.Timeout | undefined, terminalTimer: NodeJS.Timeout | undefined;
    let outputBytes = 0;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const add = (stage: string, error: unknown) => { failures.push({ stage, error }); };
    const snapshot = (closed: boolean): SqliteRecoveryWorkerExit => Object.freeze({
      observed: exitObserved, code: exitCode, signal: exitSignal, pid: child.pid ?? null, closed,
    });
    const fault = (closed: boolean) => new SqliteRecoveryWorkerFault(
      Object.freeze(failures.map(item => Object.freeze({ ...item }))), snapshot(closed), reply ?? null,
      Object.freeze({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
    const clear = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (terminalTimer) clearTimeout(terminalTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    const armTerminalObservation = () => {
      if (terminalTimer || settled) return;
      terminalTimer = setTimeout(() => {
        if (settled) return;
        settled = true; clear();
        add(exitObserved ? 'close_observation' : 'exit_observation', failure(exitObserved ? 'close_unobserved' : 'exit_unobserved'));
        // Never report success or a confirmed terminal state merely because a kill was requested.
        if (!exitObserved) try { child.kill('SIGKILL'); } catch (error) { add('kill', error); }
        try { if (child.connected) child.disconnect(); } catch (error) { add('disconnect', error); }
        for (const stream of [child.stdout, child.stderr]) try { stream?.destroy(); } catch (error) { add('stream_close', error); }
        try { child.unref(); } catch (error) { add('unref', error); }
        reject(fault(false));
      }, sqliteRecoveryProcessLimits.terminalMs);
    };
    const stop = (stage: string, error: unknown) => {
      if (settled) return;
      add(stage, error);
      if (stopping) return;
      stopping = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (!exitObserved) {
        try { if (!child.kill('SIGKILL')) add('kill', failure('kill_not_delivered')); }
        catch (cause) { add('kill', cause); }
      }
      armTerminalObservation();
    };
    const onAbort = () => stop('abort', failure('aborted', signal?.reason));
    const output = (chunks: Buffer[], chunk: Buffer) => {
      if (settled) return;
      const available = Math.max(0, sqliteRecoveryProcessLimits.outputBytes - outputBytes);
      if (available) chunks.push(Buffer.from(chunk.subarray(0, available)));
      outputBytes = Math.min(sqliteRecoveryProcessLimits.outputBytes + 1, outputBytes + chunk.length);
      if (outputBytes > sqliteRecoveryProcessLimits.outputBytes && !stopping) stop('output', failure('output_limit'));
    };
    child.stdout?.on('data', (chunk: Buffer) => output(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => output(stderr, chunk));
    child.stdout?.on('error', error => stop('stdout', error));
    child.stderr?.on('error', error => stop('stderr', error));
    child.on('error', error => stop('process', error));
    child.on('message', (message: unknown) => {
      if (settled) return;
      if (seenMessage) { if (!stopping) stop('protocol', failure('multiple_replies')); return; }
      seenMessage = true;
      try {
        const encoded = JSON.stringify(message);
        if (encoded === undefined || Buffer.byteLength(encoded) > sqliteRecoveryProcessLimits.replyBytes) throw failure('reply_limit');
        const parsed = SqliteRecoveryWorkerReplySchema.parse(message);
        reply = parsed;
        if (!isDeepStrictEqual(parsed.request, request)) throw failure('request_mismatch');
        if ('result' in parsed && (parsed.result.agentId !== request.validation.agentId || parsed.result.kind !== request.validation.kind)) {
          throw failure('result_mismatch');
        }
      } catch (error) { stop('protocol', error); }
    });
    child.once('exit', (code, childSignal) => {
      exitObserved = true; exitCode = code; exitSignal = childSignal;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (!settled) armTerminalObservation();
    });
    child.once('close', (code, childSignal) => {
      if (settled) return;
      settled = true; clear();
      if (reply && 'error' in reply) add('worker', remoteError(reply.error));
      if (!exitObserved || exitCode !== 0 || exitSignal !== null || code !== exitCode || childSignal !== exitSignal) {
        add('exit', failure('exit_invalid'));
      }
      if (!reply) add('protocol', failure('reply_missing'));
      if (failures.length || !reply || !('result' in reply)) { reject(fault(true)); return; }
      resolve(reply.result);
    });
    deadlineTimer = setTimeout(() => stop('deadline', failure('deadline')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    // The signal may have changed while fork was being configured; never dispatch in that case.
    if (signal?.aborted) { onAbort(); return; }
    try { child.send(request, error => { if (error) stop('send', error); }); }
    catch (error) { stop('send', error); }
  });
}
