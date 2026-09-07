// Bounded single-file diagnostic; create locally, upload/run only under parent coordination.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.argv.length, 2, 'No path/command overrides');
assert.equal(process.platform, 'linux'); assert.match(process.version, /^v24\./);
const root = '/home/shaneee/secumon-linux-test.pCJ0bd', cwd = join(root, 'runtime');
assert.equal(realpathSync(root), root); assert.equal(statSync(root).mode & 0o777, 0o700);
const evidence = join(root, 'evidence-drafts-mcp-diagnostic1'), preload = join(root, 'mcp-phase-trace.mjs');
assert.equal(realpathSync(preload), preload); assert(statSync(preload).isFile());
const expected = JSON.parse(readFileSync(join(root, 'drafts-c03-build-pin.json'), 'utf8'));
const { verifyEvaluationBuild } = await import(pathToFileURL(join(cwd, 'dist/infrastructure/local-evaluation.js')).href);
const beforePin = await verifyEvaluationBuild(cwd); assert.deepEqual(beforePin, expected);
const inside = value => value === root || value.startsWith(root + '/');
const transient = error => ['ENOENT', 'ESRCH'].includes(error?.code);
function inventory() {
  const processes = [], errors = [], inaccessiblePeers = [], unresolved = [];
  for (const name of readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
    const pid = Number(name); if (pid === process.pid) continue;
    try {
      if (statSync(`/proc/${pid}`).uid !== process.getuid()) continue;
      const paths = {}, unavailableFields = [];
      for (const field of ['exe', 'cwd']) {
        try { paths[field] = readlinkSync(`/proc/${pid}/${field}`); }
        catch (error) {
          if (['EACCES', 'EPERM'].includes(error.code)) unavailableFields.push({ field, code: error.code });
          else if (!transient(error)) throw error;
        }
      }
      const owned = Object.values(paths).some(inside);
      if (unavailableFields.length) {
        inaccessiblePeers.push({ pid, visiblePaths: paths, unavailableFields, scope: owned ? 'observed_owned' : 'unresolved' });
        if (!owned) unresolved.push({ pid, visiblePaths: paths, unavailableFields, reason: 'scope_not_proven_from_accessible_paths' });
      }
      if (!owned) continue;
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      processes.push({ pid, ...paths, unavailableFields, state: fields[0], parentPid: Number(fields[1]), processGroup: Number(fields[2]) });
    } catch (error) { if (!transient(error)) errors.push({ pid, code: error.code ?? error.name }); }
  }
  return { processes: processes.sort((a, b) => a.pid - b.pid), inaccessiblePeers, unresolved, errors };
}
const beforeProcesses = inventory(); assert.deepEqual(beforeProcesses.errors, []);
assert.deepEqual(beforeProcesses.processes, [], 'No observable process may own a dedicated-root exe/cwd except this runner');
mkdirSync(evidence, { mode: 0o700 }); assert.equal(statSync(evidence).mode & 0o777, 0o700);
const writeNew = (name, value) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const args = ['--test', '--test-concurrency=1', '--test-timeout=30000', '--test-reporter=tap', '--import', pathToFileURL(preload).href, 'dist/tests/mcp-read-tools.test.js'];
const record = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), runnerPid: process.pid,
  node: process.version, platform: process.platform, command: [process.execPath, ...args], cwd, beforePin, expectedPin: expected,
  processAuditScope: 'Observable same-UID exe/cwd paths inside the dedicated root plus the directly spawned child group; inaccessible peers retain unresolved scope, not proof of global process absence.',
  beforeProcesses, deadlineMs: 120000, killGraceMs: 5000, logLimitBytes: 16 * 1024 * 1024,
  externalModelCalls: false, environmentDumped: false, terminationReason: null, signals: [], errors: [] };
writeNew('before.json', record);
let fd = null, child = null, deadline = null, escalation = null, escalated = null, closed = false, logStopped = false, logBytes = 0, observedBytes = 0, tail = Buffer.alloc(0);
const smallError = error => ({ code: error.code ?? error.name, message: String(error.message).slice(0, 1000) });
const groupSignal = signal => {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); record.signals.push({ signal, at: new Date().toISOString(), processGroup: child.pid }); }
  catch (error) { if (error.code !== 'ESRCH') record.errors.push({ stage: 'group_signal', ...smallError(error) }); }
};
const groupAlive = () => {
  if (!child?.pid) return false;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; record.errors.push({ stage: 'group_probe', ...smallError(error) }); return true; }
};
const terminate = reason => {
  if (closed || record.terminationReason) return;
  record.terminationReason = reason; groupSignal('SIGTERM');
  escalated = new Promise(resolve => { escalation = setTimeout(() => { if (groupAlive()) groupSignal('SIGKILL'); resolve(); }, 5000); });
};
const onTerm = () => terminate('runner_SIGTERM'), onInt = () => terminate('runner_SIGINT');
try {
  fd = openSync(join(evidence, 'mcp-read-tools.log'), 'wx', 0o600);
  const exit = await new Promise(resolve => {
    child = spawn(process.execPath, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SECUMON_MCP_DIAG_DIR: evidence } });
    record.childPid = child.pid ?? null; record.processGroup = child.pid ?? null;
    const capture = chunk => {
      observedBytes += chunk.length; tail = Buffer.concat([tail, chunk]).subarray(-65536);
      if (logStopped) return;
      const bytes = chunk.subarray(0, Math.max(0, record.logLimitBytes - logBytes));
      try { let offset = 0; while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); if (n <= 0) throw new Error('log_write_no_progress'); offset += n; logBytes += n; } }
      catch (error) { logStopped = true; record.errors.push({ stage: 'log_write', ...smallError(error) }); terminate('log_write_error'); }
      if (observedBytes > record.logLimitBytes) { logStopped = true; terminate('log_limit'); }
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.stdout.on('error', error => { record.errors.push({ stage: 'stdout', ...smallError(error) }); terminate('stream_error'); });
    child.stderr.on('error', error => { record.errors.push({ stage: 'stderr', ...smallError(error) }); terminate('stream_error'); });
    child.once('error', error => { record.errors.push({ stage: 'spawn', ...smallError(error) }); });
    child.once('exit', (code, signal) => { record.leaderExit = { code, signal, at: new Date().toISOString() }; });
    child.once('close', (code, signal) => { closed = true; clearTimeout(deadline); resolve({ code, signal }); });
    process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
    deadline = setTimeout(() => terminate('deadline'), 120000);
  });
  if (record.terminationReason && groupAlive()) await escalated;
  record.exit = exit;
  record.status = record.terminationReason === 'deadline' ? 'timeout' : exit.signal ? 'signal' : 'exited';
} catch (error) { record.status = 'error'; record.errors.push({ stage: 'runner', ...smallError(error) }); }
finally {
  clearTimeout(deadline); clearTimeout(escalation); process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
  if (fd !== null) try { closeSync(fd); } catch (error) { record.errors.push({ stage: 'log_close', ...smallError(error) }); }
  record.log = { path: join(evidence, 'mcp-read-tools.log'), storedBytes: logBytes, observedBytes, limitBytes: record.logLimitBytes, exceeded: observedBytes > record.logLimitBytes };
  record.tapTail = tail.toString('utf8'); record.finishedAt = new Date().toISOString();
  try { record.afterPin = await verifyEvaluationBuild(cwd); assert.deepEqual(record.afterPin, expected); record.pinUnchanged = true; }
  catch (error) { record.pinUnchanged = false; record.errors.push({ stage: 'after_pin', ...smallError(error) }); }
  try { record.afterProcesses = inventory(); } catch (error) { record.errors.push({ stage: 'after_inventory', ...smallError(error) }); }
  record.directChildGroupAlive = groupAlive();
  writeNew('result.json', record);
  process.exitCode = record.status === 'exited' && record.exit?.code === 0 && !record.terminationReason && record.errors.length === 0 &&
    record.afterProcesses?.processes.length === 0 && record.afterProcesses?.errors.length === 0 && !record.directChildGroupAlive && record.pinUnchanged ? 0 : 1;
  console.log(JSON.stringify({ status: record.status, exit: record.exit ?? null, terminationReason: record.terminationReason,
    finishedAt: record.finishedAt, logBytes, pinUnchanged: record.pinUnchanged, observedOwnedProcesses: record.afterProcesses?.processes.length ?? null,
    unresolvedPeers: record.afterProcesses?.unresolved.length ?? null, directChildGroupAlive: record.directChildGroupAlive, result: join(evidence, 'result.json') }));
}
