// C05 MCP stored-only general resume runner adapted from completed C05 response custody; bounded process-group settlement and actual exits retained.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, readFileSync, readdirSync, writeFileSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { cpus, totalmem, release } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditRoot, assertPin, assertLocalResult, configuration } from './mcp-offline-c05-common.mjs';

if (process.platform !== 'linux' || process.version !== 'v24.20.0') throw new Error('linux_node24_required');
const root = realpathSync(process.argv[2]);
if (root !== configuration.root || (statSync(root).mode & 0o777) !== 0o700) throw new Error('unexpected_dedicated_test_root');
const cwd = join(root, 'runtime'), evidence = join(root, 'evidence-mcp-offline-c05');
const expectedPin = JSON.parse(readFileSync(join(root, 'mcp-offline-c05-build-pin.json'), 'utf8'));
mkdirSync(evidence, { mode: 0o700 }); process.umask(0o022);
const runStarted = performance.now();
const record = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(),
  environment: { platform: process.platform, arch: process.arch, node: process.version, kernel: release(),
    osRelease: readFileSync('/etc/os-release', 'utf8'), cpus: cpus().length, totalMemoryBytes: totalmem(),
    testConcurrency: 2, umask: '0022', temporaryDirectory: process.env.TMPDIR },
  scope: 'native_linux_mcp_offline_general_resume',
  runnerTemplate: 'evidence/C05-mcp-custody-linux-nas-20260907/verify-linux-mcp-custody-c05.mjs',
  executionLimits: { overallDeadlineMs: 1800000, nodeTestTimeoutMs: 60000, fullStageDeadlineMs: 1200000, testStageDeadlineMs: 300000, otherStageDeadlineMs: 180000,
    terminationGraceMs: 5000, postKillObservationMs: 5000, logFlushDeadlineMs: 5000 },
  processGroupScope: 'Only each directly spawned detached child group is signaled; descendants that create another group are not claimed absent.',
  targeted: null, related: null, externalModelCalls: false, internalServiceIntegration: false, productionDeployment: false,
  steps: [], buildPin: null, finishedAt: null };
const persist = () => writeFileSync(join(evidence, 'result.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
persist();
async function run(name, command, args, envOverrides = {}) {
  const log = join(evidence, name + '.log');
  const remaining = record.executionLimits.overallDeadlineMs - (performance.now() - runStarted);
  if (remaining <= 0) throw new Error('overall_deadline_exceeded');
  const stageLimit = name === 'all-tests' ? record.executionLimits.fullStageDeadlineMs :
    ['new-mcp-offline-tests', 'related-existing-tests'].includes(name) ? record.executionLimits.testStageDeadlineMs : record.executionLimits.otherStageDeadlineMs;
  const deadlineMs = Math.min(remaining, stageLimit);
  const step = { name, command: [command, ...args], startedAt: new Date().toISOString(), status: 'running', log,
    exitCode: null, signal: null, finishedAt: null, deadlineMs, timedOut: false, terminationReason: null,
    leaderExit: null, stdioClose: null, childPid: null, processGroup: null, groupAbsentConfirmed: false,
    signals: [], errors: [], envOverrides, nodeTestTimeoutFailures: null, logFlushCompleted: false };
  record.steps.push(step); persist(); console.log(JSON.stringify({ event: 'started', name, at: step.startedAt }));
  const output = createWriteStream(log, { mode: 0o600 });
  const progress = name === 'all-tests' ? setInterval(() => {
    try {
      const text = readFileSync(log, 'utf8'), passed = [...text.matchAll(/^ok (\d+) - (.*)$/gm)], failed = [...text.matchAll(/^not ok (\d+) - (.*)$/gm)];
      console.log(JSON.stringify({ event: 'progress', name, reportedPassed: passed.length,
        reportedFailures: failed.map(row => row[2]), latest: passed.at(-1)?.[2], at: new Date().toISOString() }));
    } catch (error) { console.log(JSON.stringify({ event: 'progress_unavailable', error: String(error) })); }
  }, 45000) : null;
  let child, deadline, escalation, finalObservation, afterLeader, groupPoll, finished = false;
  let onExit, onClose, terminate;
  const smallError = error => ({ code: error?.code ?? error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 1000) });
  const checkpoint = () => { try { persist(); } catch (error) { step.errors.push({ stage: 'persist', ...smallError(error) }); } };
  const groupState = () => {
    if (!child?.pid) return 'not_spawned';
    try { process.kill(-child.pid, 0); return 'present'; }
    catch (error) {
      if (error.code === 'ESRCH') return 'absent';
      if (!step.errors.some(item => item.stage === 'group_probe' && item.code === error.code)) step.errors.push({ stage: 'group_probe', ...smallError(error) });
      return 'unknown';
    }
  };
  const signalGroup = signal => {
    if (!child?.pid) return;
    const entry = { signal, processGroup: child.pid, at: new Date().toISOString(), sent: false };
    try { process.kill(-child.pid, signal); entry.sent = true; }
    catch (error) {
      entry.error = smallError(error);
      if (error.code !== 'ESRCH') step.errors.push({ stage: 'group_signal', ...smallError(error) });
    }
    step.signals.push(entry); checkpoint();
  };
  const clearTimers = () => {
    clearTimeout(deadline); clearTimeout(escalation); clearTimeout(finalObservation); clearTimeout(afterLeader); clearInterval(groupPoll);
    if (progress !== null) clearInterval(progress);
  };
  const onTerm = () => terminate?.('runner_SIGTERM'), onInt = () => terminate?.('runner_SIGINT');
  try {
    await new Promise(resolve => {
      const finish = reason => {
        if (finished) return;
        finished = true; clearTimers(); step.settlementReason = reason; resolve();
      };
      terminate = reason => {
        if (finished || step.terminationReason) return;
        step.terminationReason = reason; step.terminationAt = new Date().toISOString();
        step.timedOut = reason === 'stage_deadline'; clearTimeout(deadline); clearTimeout(afterLeader);
        signalGroup('SIGTERM'); checkpoint();
        if (!child?.pid) { finish('no_child_process'); return; }
        // Neither inherited pipes nor a group that survives SIGKILL may hold this Promise forever.
        escalation = setTimeout(() => {
          if (groupState() !== 'absent') signalGroup('SIGKILL');
          step.killGraceExpiredAt = new Date().toISOString(); checkpoint();
        }, record.executionLimits.terminationGraceMs);
        finalObservation = setTimeout(() => {
          step.cleanupObservationExpired = true; finish('bounded_cleanup_observation_expired');
        }, record.executionLimits.terminationGraceMs + record.executionLimits.postKillObservationMs);
        groupPoll = setInterval(() => {
          if (step.stdioClose && groupState() === 'absent') finish('child_closed_and_group_absent');
        }, 100);
      };
      output.on('error', error => { step.errors.push({ stage: 'log_write', ...smallError(error) }); terminate('log_write_error'); });
      try { child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...envOverrides } }); }
      catch (error) { step.errors.push({ stage: 'spawn', ...smallError(error) }); finish('spawn_failed'); return; }
      step.childPid = child.pid ?? null; step.processGroup = child.pid ?? null; checkpoint();
      child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
      child.stdout.on('error', error => { step.errors.push({ stage: 'stdout', ...smallError(error) }); terminate('stream_error'); });
      child.stderr.on('error', error => { step.errors.push({ stage: 'stderr', ...smallError(error) }); terminate('stream_error'); });
      child.once('error', error => { step.errors.push({ stage: 'spawn', ...smallError(error) }); terminate('spawn_error'); });
      onExit = (code, signal) => {
        step.leaderExit = { code, signal, at: new Date().toISOString() }; checkpoint();
        if (!step.terminationReason) afterLeader = setTimeout(() => terminate('leader_exited_without_stdio_close'), 1000);
      };
      onClose = (code, signal) => {
        step.stdioClose = { code, signal, at: new Date().toISOString() }; clearTimeout(afterLeader); checkpoint();
        if (groupState() === 'absent') finish('child_closed_and_group_absent');
        else terminate('child_group_remains_after_close');
      };
      child.once('exit', onExit); child.once('close', onClose);
      process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
      deadline = setTimeout(() => terminate('stage_deadline'), deadlineMs);
    });
  } catch (error) {
    step.errors.push({ stage: 'runner', ...smallError(error) });
  } finally {
    clearTimers(); process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
    if (child) {
      child.off('exit', onExit); child.off('close', onClose);
      child.stdout?.unpipe(output); child.stderr?.unpipe(output);
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
    }
    step.finalGroupState = groupState(); step.groupAbsentConfirmed = step.finalGroupState === 'absent';
    await new Promise(resolve => {
      let settled = false;
      const done = flushed => { if (settled) return; settled = true; clearTimeout(timer); step.logFlushCompleted = flushed; resolve(); };
      const timer = setTimeout(() => { step.errors.push({ stage: 'log_flush', code: 'deadline', message: 'log flush deadline exceeded' }); output.destroy(); done(false); }, record.executionLimits.logFlushDeadlineMs);
      output.once('error', () => done(false));
      if (output.destroyed) done(false); else output.end(() => done(true));
    });
  }
  try {
    const text = readFileSync(log, 'utf8');
    step.nodeTestTimeoutFailures = [...text.matchAll(/failureType:\s*['"]?testTimeoutFailure\b/g)].length;
    if (['new-mcp-offline-tests', 'related-existing-tests', 'all-tests'].includes(name)) {
      step.tapSummary = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => {
        const value = [...text.matchAll(new RegExp('^# ' + key + ' (\\d+)$', 'gm'))].at(-1)?.[1]; return [key, value === undefined ? null : Number(value)];
      }));
      if (!(step.tapSummary.tests > 0) || step.tapSummary.fail !== 0 || step.tapSummary.cancelled !== 0) step.errors.push({ stage: 'tap_summary', code: 'test_failure_or_missing_summary' });
      if (name === 'new-mcp-offline-tests') record.targeted.observedTestCount = step.tapSummary.tests;
      if (name === 'related-existing-tests') record.related.observedTestCount = step.tapSummary.tests;
    }
  }
  catch (error) { step.errors.push({ stage: 'log_summary', ...smallError(error) }); }
  const actualExit = step.leaderExit ?? step.stdioClose;
  Object.assign(step, { exitCode: actualExit?.code ?? null, signal: actualExit?.signal ?? null, finishedAt: new Date().toISOString() });
  const passed = step.exitCode === 0 && step.stdioClose !== null && !step.timedOut && !step.terminationReason &&
    step.nodeTestTimeoutFailures === 0 && step.groupAbsentConfirmed && step.logFlushCompleted && step.errors.length === 0;
  step.status = step.timedOut || step.nodeTestTimeoutFailures > 0 ? 'timeout' : passed ? 'passed' : 'failed';
  persist(); console.log(JSON.stringify({ event: 'finished', name, status: step.status, timedOut: step.timedOut,
    exitCode: step.exitCode, signal: step.signal, terminationReason: step.terminationReason, finalGroupState: step.finalGroupState, at: step.finishedAt }));
  if (!passed) throw new Error('step_' + step.status + ':' + name);
}
try {
  assertPin(expectedPin);
  const predecessorBytes = readFileSync(join(root, configuration.previousNativeResult));
  if (createHash('sha256').update(predecessorBytes).digest('hex') !== configuration.predecessor.nativeResultSha256 ||
    JSON.parse(predecessorBytes.toString('utf8')).status !== 'passed') throw new Error('predecessor_result_mismatch');
  record.predecessor = configuration.predecessor;
  const validationInputs = JSON.parse(readFileSync(join(root, 'mcp-offline-c05-validation-inputs.json'), 'utf8'));
  if (JSON.stringify(expectedPin) !== JSON.stringify(validationInputs.pin)) throw new Error('unapproved_build_pin');
  for (const key of ['newTests', 'relatedTests']) {
    const result = validationInputs[key]?.result;
    assertLocalResult(result, expectedPin);
  }
  record.localValidationInputs = validationInputs;
  record.beforeProcesses = await auditRoot(root);
  if (record.beforeProcesses.auditErrors.length || record.beforeProcesses.observedOwnedProcesses) throw new Error('preflight_process_gate');
  const expectedAssets = [
    { path: 'evidence/internal-io/v024-original-metrics.json', sha256: '6c46bb940bb981a738ca72f7c7bfe99630d96bf75cc564a8565b7689cd216c54' },
    { path: 'evidence/internal-io/v024-instrumented-metrics.json', sha256: '3e1c4c6f0c001ee9c4c8565149014a1ef7178432e6f6910cb142fe2194f367b1' },
    { path: 'evidence/internal-io/v024-snapshot-manifest.json', sha256: 'dc3a32a845192825e002d5f4863e206c947a2b1be8fb5f65ba739a36fabdb1d1' },
    { path: 'evidence/internal-io/v024-instrumented-manifest.json', sha256: '5f09ea9071f3cbd056ae0bba25b7d66714f7f84034d1370b4b0b67495aef99a2' },
    { path: 'evidence/internal-io/instrumented-file-artifacts.js', sha256: '0a92314eea2befcc8d7ce03bf04821afc5773536911a9ddee1e00baa6d0bb9d1' },
    { path: 'guidance/catalog.json', sha256: 'f1b628d9d062d9d9c3ac2eadb2e962fcf46fd0c9b6e0fb1ffee96d4084add1fa' },
    { path: 'guidance/evidence-review.md', sha256: 'e3c770b05cef3d9e96c5992d399d3c8eef0a238ab03cd8f9bd5c57bd47b81315' },
  ];
  record.verifiedAssets = [];
  for (const item of expectedAssets) {
    const actual = createHash('sha256').update(readFileSync(join(cwd, item.path))).digest('hex');
    if (actual !== item.sha256) throw new Error('asset_hash_mismatch:' + item.path); record.verifiedAssets.push(item);
  }
  persist(); await run('build', 'npm', ['run', 'build']);
  const { verifyEvaluationBuild } = await import(pathToFileURL(resolve(cwd, 'dist/infrastructure/local-evaluation.js')).href);
  record.buildPin = await verifyEvaluationBuild(cwd); persist();
  if (JSON.stringify(record.buildPin) !== JSON.stringify(expectedPin)) throw new Error('initial_build_pin_mismatch');
  const lists = JSON.parse(readFileSync(join(root, 'mcp-offline-c05-targeted-files.json'), 'utf8'));
  const available = readdirSync(join(cwd, 'dist/tests')).filter(name => name.endsWith('.test.js')).sort();
  for (const key of ['newFiles', 'relatedFiles']) {
    const files = lists[key];
    if (!Array.isArray(files) || files.length === 0 || new Set(files).size !== files.length || files.some(file => !/^dist\/tests\/[a-z0-9-]+\.test\.js$/.test(file) || !available.includes(file.slice('dist/tests/'.length)))) throw new Error('invalid_targeted_files:' + key);
  }
  if (lists.newFiles.some(file => lists.relatedFiles.includes(file))) throw new Error('overlapping_targeted_lists');
  for (const [key, source] of [['newFiles', 'newTests'], ['relatedFiles', 'relatedTests']]) {
    const selected = validationInputs.selections?.[source];
    if (!selected || !/^[a-f0-9]{64}$/.test(selected.sha256) ||
      JSON.stringify(lists[key]) !== JSON.stringify(selected.files)) throw new Error('local_selection_snapshot_mismatch:' + key);
  }
  record.targeted = { files: lists.newFiles, fileCount: lists.newFiles.length, observedTestCount: null };
  record.related = { files: lists.relatedFiles, fileCount: lists.relatedFiles.length, observedTestCount: null }; persist();
  await run('new-mcp-offline-tests', process.execPath, ['--test', '--test-concurrency=2', '--test-timeout=60000', '--test-reporter=tap', ...lists.newFiles]);
  await run('related-existing-tests', process.execPath, ['--test', '--test-concurrency=2', '--test-timeout=60000', '--test-reporter=tap', ...lists.relatedFiles]);
  await run('typecheck-core', 'npm', ['run', 'typecheck:core']);
  await run('architecture', 'npm', ['run', 'check:architecture']);
  await run('architecture-cli-fixtures', process.execPath, [join(root, 'architecture-cli-check.mjs')]);
  record.allTestFiles = available.map(name => 'dist/tests/' + name); persist();
  await run('all-tests', process.execPath, ['--test', '--test-concurrency=2', '--test-timeout=60000', '--test-reporter=tap', ...record.allTestFiles]);
  await run('fixtures', 'npm', ['run', 'fixtures']);
  record.buildPin = await verifyEvaluationBuild(cwd);
  if (JSON.stringify(record.buildPin) !== JSON.stringify(expectedPin)) throw new Error('final_build_pin_mismatch');
  record.afterProcesses = await auditRoot(root);
  if (record.afterProcesses.auditErrors.length || record.afterProcesses.observedOwnedProcesses) throw new Error('postflight_process_gate');
  record.status = 'passed';
} catch (error) { record.status = 'failed'; record.error = String(error); process.exitCode = 1; }
finally { record.finishedAt = new Date().toISOString(); persist(); console.log(JSON.stringify({ status: record.status, finishedAt: record.finishedAt })); }
