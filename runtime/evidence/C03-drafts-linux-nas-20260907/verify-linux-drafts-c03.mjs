// Adapted from evidence/C03-personal-linux-nas-20260907/verify-linux-personal-c03.mjs; no test totals are assumed.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, readFileSync, readdirSync, writeFileSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { cpus, totalmem, release } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform !== 'linux' || process.version !== 'v24.20.0') throw new Error('linux_node24_required');
const root = realpathSync(process.argv[2]);
if (root !== '/home/shaneee/secumon-linux-test.pCJ0bd' || (statSync(root).mode & 0o777) !== 0o700) throw new Error('unexpected_dedicated_test_root');
const cwd = join(root, 'runtime'), evidence = join(root, 'evidence-drafts-c03');
const expectedPin = JSON.parse(readFileSync(join(root, 'drafts-c03-build-pin.json'), 'utf8'));
mkdirSync(evidence, { mode: 0o700 }); process.umask(0o022);
const record = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(),
  environment: { platform: process.platform, arch: process.arch, node: process.version, kernel: release(),
    osRelease: readFileSync('/etc/os-release', 'utf8'), cpus: cpus().length, totalMemoryBytes: totalmem(),
    testConcurrency: 2, umask: '0022', temporaryDirectory: process.env.TMPDIR },
  scope: 'native_linux_document_draft_apply_receipt_recovery_build_targeted_full_tests_and_fixtures',
  runnerTemplate: 'evidence/C03-personal-linux-nas-20260907/verify-linux-personal-c03.mjs',
  executionLimits: { nodeTestTimeoutMs: 60000, fullStageDeadlineMs: 900000, otherStageDeadlineMs: 180000,
    terminationGraceMs: 5000, postKillObservationMs: 5000, logFlushDeadlineMs: 5000 },
  processGroupScope: 'Only each directly spawned detached child group is signaled; descendants that create another group are not claimed absent.',
  targeted: null, externalModelCalls: false, internalServiceIntegration: false, productionDeployment: false,
  steps: [], buildPin: null, finishedAt: null };
const persist = () => writeFileSync(join(evidence, 'result.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
persist();
async function run(name, command, args, envOverrides = {}) {
  const log = join(evidence, name + '.log');
  const deadlineMs = name === 'all-tests' ? record.executionLimits.fullStageDeadlineMs : record.executionLimits.otherStageDeadlineMs;
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
  try { step.nodeTestTimeoutFailures = [...readFileSync(log, 'utf8').matchAll(/failureType:\s*['"]?testTimeoutFailure\b/g)].length; }
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
  record.buildPin = await verifyEvaluationBuild(cwd);
  record.personalMemoryAsset = { path: 'dist/presentation/web/personal-memory.js', sha256: createHash('sha256').update(readFileSync(join(cwd, 'dist/presentation/web/personal-memory.js'))).digest('hex') };
  persist();
  if (JSON.stringify(record.buildPin) !== JSON.stringify(expectedPin)) throw new Error('initial_build_pin_mismatch');
  const available = readdirSync(join(cwd, 'dist/tests')).filter(name => name.endsWith('.test.js')).sort();
  const targeted = [
  "dist/tests/agent-backend-binding.test.js",
  "dist/tests/agent-clone-recovery.test.js",
  "dist/tests/agent-clone.test.js",
  "dist/tests/agent-document-memory.test.js",
  "dist/tests/agent-memory-profile-concurrency.test.js",
  "dist/tests/agent-profile-concurrency.test.js",
  "dist/tests/agent-profile.test.js",
  "dist/tests/agent-setup-mutations.test.js",
  "dist/tests/agent-state-binding-recovery.test.js",
  "dist/tests/agent-stores.test.js",
  "dist/tests/document-knowledge-boundaries.test.js",
  "dist/tests/document-knowledge-storage.test.js",
  "dist/tests/document-memory-recovery-regressions.test.js",
  "dist/tests/document-owner-registration-races.test.js",
  "dist/tests/document-personal-memory-presentation.test.js",
  "dist/tests/document-profile.test.js",
  "dist/tests/memory-draft-web.test.js",
  "dist/tests/persistent-session-presentation.test.js",
  "dist/tests/personal-knowledge-service.test.js",
  "dist/tests/personal-memory-context.test.js",
  "dist/tests/personal-memory-draft-cli.test.js",
  "dist/tests/personal-memory-draft-flow.test.js",
  "dist/tests/personal-memory-draft-recovery.test.js",
  "dist/tests/personal-memory-drafts.test.js",
  "dist/tests/personal-memory-presentation.test.js",
  "dist/tests/personal-memory-revision-status.test.js",
  "dist/tests/session-context-runtime.test.js",
  "dist/tests/session-flow-boundaries.test.js",
  "dist/tests/session-flow-kill.test.js",
  "dist/tests/session-flow.test.js",
  "dist/tests/session-input-only.test.js",
  "dist/tests/sqlite-knowledge-migration.test.js",
  "dist/tests/sqlite-personal-knowledge.test.js",
  "dist/tests/sqlite-sessions.test.js"
];
  if(targeted.some(file=>!available.includes(file.slice('dist/tests/'.length))))throw new Error('targeted_tests_missing');
  record.targeted={discovery:'same_34_files_as_local_targeted_run',files:targeted,fileCount:targeted.length,testCount:null};persist();
  await run('drafts-targeted',process.execPath,['--test','--test-concurrency=2','--test-timeout=60000','--test-reporter=tap',...targeted]);
  await run('typecheck-core', 'npm', ['run', 'typecheck:core']);
  await run('architecture', 'npm', ['run', 'check:architecture']);
  await run('architecture-cli-fixtures', process.execPath, [join(root, 'architecture-cli-check.mjs')]);
  const tests = available.map(name => 'dist/tests/' + name); record.allTestFiles = tests; persist();
  const preload = join(root, 'mcp-phase-trace.mjs'), traceDirectory = join(evidence, 'mcp-trace');
  const preloadSha256 = createHash('sha256').update(readFileSync(preload)).digest('hex');
  if (realpathSync(preload) !== preload || preloadSha256 !== '2e53d80341c0a3f418eae62f65d2f3743ef6785e41999beeb8f5dbda2f16773e') throw new Error('mcp_trace_preload_mismatch');
  mkdirSync(traceDirectory, { mode: 0o700 });
  if ((statSync(traceDirectory).mode & 0o777) !== 0o700) throw new Error('mcp_trace_directory_not_private');
  record.mcpTrace = { preload, sha256: preloadSha256, directory: traceDirectory,
    activation: 'mcp-read-tools.test.js child only; preload leaves other test files unchanged',
    limitation: 'Evidence-only instrumentation adds observation/timing overhead, has bounded detail, and does not establish the cause of the prior stalled run.' }; persist();
  await run('all-tests', process.execPath, ['--test', '--test-concurrency=2', '--test-timeout=60000', '--test-reporter=tap', '--import', pathToFileURL(preload).href, ...tests],
    { SECUMON_MCP_DIAG_DIR: traceDirectory });
  await run('fixtures', 'npm', ['run', 'fixtures']);
  record.buildPin = await verifyEvaluationBuild(cwd);
  if (JSON.stringify(record.buildPin) !== JSON.stringify(expectedPin)) throw new Error('final_build_pin_mismatch');
  record.status = 'passed';
} catch (error) { record.status = 'failed'; record.error = String(error); process.exitCode = 1; }
finally { record.finishedAt = new Date().toISOString(); persist(); console.log(JSON.stringify({ status: record.status, finishedAt: record.finishedAt })); }
