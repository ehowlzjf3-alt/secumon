// Local stage observation only; root chooses when to execute and which command to run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { evaluationCodePin, verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

const [stage, command, ...args] = process.argv.slice(2);
assert.ok(stage && /^[a-z0-9-]+$/.test(stage) && command, 'stage and command required');
assert.match(process.version, /^v24\./); assert.ok(['darwin', 'linux'].includes(process.platform));
const root = resolve('.'), file = resolve('evidence', `C05-mcp-collections-${stage}`);
assert.ok(!existsSync(`${file}.log`) && !existsSync(`${file}.json`), 'stage evidence already exists');
const selected = stage.startsWith('new') || stage.startsWith('related');
const result = { stage, command, args, node: process.version, startedAt: new Date().toISOString(),
  sourceBefore: (await evaluationCodePin(root)).digest, timedOut: false, status: 'running',
  deadlineMs: selected ? 300000 : 180000, exitCode: null, signal: null, errors: [], signals: [],
  leaderExit: null, stdioClose: null, groupAbsentConfirmed: false,
  processGroupScope: 'Only the directly spawned detached group; independently regrouped descendants are not claimed absent.' };
if (selected) result.buildBefore = await verifyEvaluationBuild(root);
const output = await open(`${file}.log`, 'wx', 0o600);
let child, deadline, escalation, finalObservation, afterExit, poll, finished = false;
const smallError = error => ({ code: error?.code ?? error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 1000) });
const clear = () => { clearTimeout(deadline); clearTimeout(escalation); clearTimeout(finalObservation); clearTimeout(afterExit); clearInterval(poll); };
const groupState = () => {
  if (!child?.pid) return 'not_spawned';
  try { process.kill(-child.pid, 0); return 'present'; }
  catch (error) { if (error.code === 'ESRCH') return 'absent'; result.errors.push({ stage: 'group_probe', ...smallError(error) }); return 'unknown'; }
};
const signalGroup = signal => {
  if (!child?.pid) return;
  const sent = { signal, processGroup: child.pid, at: new Date().toISOString(), sent: false };
  try { process.kill(-child.pid, signal); sent.sent = true; }
  catch (error) { sent.error = smallError(error); if (error.code !== 'ESRCH') result.errors.push({ stage: 'group_signal', ...smallError(error) }); }
  result.signals.push(sent);
};
let terminate;
const onTerm = () => terminate?.('runner_SIGTERM'), onInt = () => terminate?.('runner_SIGINT');
try {
  await new Promise(resolve => {
    const finish = reason => { if (finished) return; finished = true; result.settlementReason = reason; clear(); resolve(); };
    terminate = reason => {
      if (finished || result.terminationReason) return;
      result.terminationReason = reason; result.timedOut = reason === 'stage_deadline'; clearTimeout(deadline); clearTimeout(afterExit);
      signalGroup('SIGTERM');
      if (!child?.pid) { finish('not_spawned'); return; }
      escalation = setTimeout(() => { if (groupState() !== 'absent') signalGroup('SIGKILL'); }, 5000);
      finalObservation = setTimeout(() => finish('bounded_cleanup_observation_expired'), 10000);
      poll = setInterval(() => { if (result.stdioClose && groupState() === 'absent') finish('child_closed_and_group_absent'); }, 50);
    };
    try { child = spawn(command, args, { cwd: root, detached: true,
      env: { ...process.env, PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? '') }, stdio: ['ignore', output.fd, output.fd] }); }
    catch (error) { result.errors.push({ stage: 'spawn', ...smallError(error) }); finish('spawn_failed'); return; }
    result.pid = child.pid ?? null; result.processGroup = child.pid ?? null;
    child.once('error', error => { result.errors.push({ stage: 'spawn', ...smallError(error) }); terminate('spawn_error'); });
    child.once('exit', (code, signal) => {
      result.leaderExit = { code, signal, at: new Date().toISOString() };
      if (!result.terminationReason) afterExit = setTimeout(() => terminate('leader_exited_without_close'), 1000);
    });
    child.once('close', (code, signal) => {
      result.stdioClose = { code, signal, at: new Date().toISOString() }; clearTimeout(afterExit);
      if (groupState() === 'absent') finish('child_closed_and_group_absent'); else terminate('group_remains_after_close');
    });
    process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
    deadline = setTimeout(() => terminate('stage_deadline'), result.deadlineMs);
  });
} finally {
  clear(); process.off('SIGTERM', onTerm); process.off('SIGINT', onInt); child?.unref();
  result.finalGroupState = groupState(); result.groupAbsentConfirmed = result.finalGroupState === 'absent';
  try { await output.close(); result.logCloseCompleted = true; }
  catch (error) { result.logCloseCompleted = false; result.errors.push({ stage: 'log_close', ...smallError(error) }); }
}
const actualExit = result.leaderExit ?? result.stdioClose;
result.exitCode = actualExit?.code ?? null; result.signal = actualExit?.signal ?? null;
result.finishedAt = new Date().toISOString();
result.sourceAfter = (await evaluationCodePin(root)).digest;
result.sourceUnchanged = result.sourceBefore === result.sourceAfter;
if (result.exitCode === 0 && (stage.startsWith('build') || selected)) result.buildAfter = await verifyEvaluationBuild(root);
result.status = result.exitCode === 0 && result.signal === null && !result.timedOut && !result.terminationReason &&
  result.stdioClose !== null && result.groupAbsentConfirmed && result.logCloseCompleted && result.sourceUnchanged && result.errors.length === 0 ? 'passed' : 'failed';
await writeFile(`${file}.json`, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ stage, status: result.status, exitCode: result.exitCode, sourceUnchanged: result.sourceUnchanged,
  timedOut: result.timedOut, finalGroupState: result.finalGroupState, log: `${file}.log` }));
process.exitCode = result.status === 'passed' ? 0 : result.exitCode || 1;
