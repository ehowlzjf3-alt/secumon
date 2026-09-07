import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
export const directory = 'evidence/C05-mcp-offline-linux-nas-20260907';
export const configuration = JSON.parse(readFileSync(new URL('./mcp-offline-c05-config.json', import.meta.url), 'utf8'));
assert.equal(configuration.schemaVersion, 1);
assert.ok(typeof configuration.root === 'string' && /^\/[a-zA-Z0-9_./-]+$/.test(configuration.root) && !configuration.root.split('/').some(part => part === '..' || part === '.') && !configuration.root.endsWith('/'));
assert.ok(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(configuration.sshHost));
assert.ok(/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(configuration.expectedDefaultNode));
assert.ok(/^evidence-[a-zA-Z0-9_-]+\/result\.json$/.test(configuration.previousNativeResult));
assert.equal(configuration.previousNativeResult, 'evidence-mcp-custody-c05/result.json');
assert.ok(Array.isArray(configuration.historyEvidence) && configuration.historyEvidence.every(path => /^evidence\/[a-zA-Z0-9_./-]+\.json$/.test(path) && !path.split('/').includes('..')));
assert.ok(configuration.historyEvidence.includes('evidence/C05-mcp-custody-linux-nas-20260907/verification.json'));
assert.deepEqual(configuration.predecessor, { path: 'evidence/C05-mcp-custody-linux-nas-20260907/verification.json',
  sha256: '3783a0a1f5ba3a4eea5a9a2231d5def3dbaf44a163c4444b8e559642283e463c',
  nativeResultSha256: '739ddb55922a08ed87cb5e7b324e26b1d05f0c0f4d79175c77d6ffa8dabd1999' });
export const root = configuration.root;
export function assertPin(pin) {
  assert.ok(pin && /^[a-f0-9]{64}$/.test(pin.sourceDigest) && /^[a-f0-9]{64}$/.test(pin.filesDigest) && Number.isSafeInteger(pin.fileCount) && pin.fileCount > 0);
  return pin;
}
export function assertLocalResult(result, pin) {
  assert.equal(result?.sourceObservation?.kind, 'per_run_source_and_build_verification', 'MCP stored-only general resume run requires actual per-run source/build observations');
  assert.ok(/^v24\./.test(result.testNode), 'MCP stored-only general resume local tests require Node 24');
  assert.equal(result?.code, 0); assert.equal(result.signal, null); assert.equal(result.timedOut, false);
  assert.deepEqual(result.sourceAndBuild, pin);
  if (result.finishedAt !== undefined) {
    assert.ok(Number.isFinite(Date.parse(result.finishedAt)));
    assert.ok(['actual_child_exit_observed_by_stage_runner', 'child_exit_then_log_close_observed_by_stage_runner'].includes(result.timestampMeaning));
  } else {
    assert.ok(Number.isFinite(Date.parse(result.completedObservedAt)));
    assert.equal(result.timestampMeaning, 'completion_observed_after_actual_exit'); assert.equal(result.exactFinishedAtCaptured, false);
  }
  assert.equal(result.processEvidence?.exitCode, 0); assert.ok(Number.isSafeInteger(result.processEvidence.sessionId));
  if (result.sourceObservation?.kind === 'per_run_source_and_build_verification') {
    assert.equal(result.sourceObservation.perRunBeforeCaptured, true);
    assert.deepEqual(assertPin(result.sourceObservation.before), pin);
    assert.deepEqual(assertPin(result.sourceObservation.after), pin);
    assert.equal(result.timestampMeaning, 'child_exit_then_log_close_observed_by_stage_runner');
    assert.ok(/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(result.testNode));
    assert.ok(Number.isFinite(Date.parse(result.startedAt)) && Date.parse(result.finishedAt) >= Date.parse(result.startedAt));
  } else {
    assert.equal(result.sourceObservation?.kind, 'frozen_build_plus_current_verification');
    assert.equal(result.sourceObservation.perRunBeforeCaptured, false);
  }
  const evidencePath = path => typeof path === 'string' && /^evidence\/[a-zA-Z0-9_./-]+$/.test(path) && !path.split('/').includes('..');
  assert.ok(evidencePath(result.logPath) && evidencePath(result.sourceObservation.pinPath) && evidencePath(result.sourceObservation.buildLogPath));
  if (result.sourceObservation.kind === 'per_run_source_and_build_verification') assert.ok(evidencePath(result.sourceObservation.runnerPath));
  assert.ok(Array.isArray(result.evidence) && result.evidence.length > 0 && result.evidence.length <= 32);
  assert.equal(new Set(result.evidence.map(item => item.path)).size, result.evidence.length);
  for (const item of result.evidence) assert.ok(evidencePath(item.path) && /^[a-f0-9]{64}$/.test(item.sha256) && typeof item.role === 'string');
  for (const path of [result.logPath, result.sourceObservation.pinPath, result.sourceObservation.buildLogPath, result.processEvidence.path, result.sourceObservation.runnerPath].filter(Boolean)) {
    assert.ok(result.evidence.some(item => item.path === path), 'original evidence reference missing from hash manifest');
  }
  assert.ok(result.evidence.some(item => item.role === 'recorded_exec_exit_observations'));
  return result;
}
/** Compare an alias with the retained stage observation; absent timedOut is not a captured false field. */
export function assertLocalStageObservation(result, pin, actual) {
  assert.equal(result.sourceObservation.kind, 'per_run_source_and_build_verification');
  assert.equal(actual.status, 'passed'); assert.equal(actual.timedOut, false);
  assert.equal(actual.groupAbsentConfirmed, true); assert.equal(actual.finalGroupState, 'absent');
  assert.equal(actual.logCloseCompleted, true); assert.deepEqual(actual.errors, []);
  assert.equal(actual.leaderExit?.code, 0); assert.equal(actual.stdioClose?.code, 0);
  assert.equal(actual.exitCode, 0); assert.equal(actual.signal, null); assert.notEqual(actual.timedOut, true);
  assert.equal(actual.sourceUnchanged, true); assert.equal(actual.sourceBefore, pin.sourceDigest); assert.equal(actual.sourceAfter, pin.sourceDigest);
  assert.deepEqual(actual.buildBefore, pin); assert.deepEqual(actual.buildAfter, pin);
  assert.equal(actual.node, result.testNode); assert.equal(actual.pid, result.processEvidence.childPid);
  assert.equal(actual.startedAt, result.startedAt); assert.equal(actual.finishedAt, result.finishedAt);
  return { path: result.sourceObservation.runnerPath, timedOutFieldCaptured: Object.hasOwn(actual, 'timedOut'),
    successfulExitObserved: true, timestampMeaning: result.timestampMeaning, node: actual.node };
}
export function parseTestSummary(raw) {
  const text = raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => {
    const matches = [...text.matchAll(new RegExp('^(?:#|ℹ) ' + key + ' (\\d+)\\r?$', 'gm'))];
    assert.equal(matches.length, 1, 'exactly one final test summary required: ' + key); return [key, Number(matches[0][1])];
  }));
  assert.ok(counts.tests > 0); assert.equal(counts.tests, counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo);
  return counts;
}
export function selectedTestFiles(args) {
  assert.ok(Array.isArray(args)); assert.equal(args[0], '--test'); assert.match(args[1], /^--test-concurrency=[12]$/);
  assert.equal(args[2], '--test-timeout=60000');
  const explicitReporter = args[3]?.startsWith('--test-reporter=');
  if (explicitReporter) assert.equal(args[3], '--test-reporter=tap');
  const files = args.slice(explicitReporter ? 4 : 3);
  assert.ok(files.length > 0 && new Set(files).size === files.length && files.every(file => typeof file === 'string' && /^dist\/tests\/[a-z0-9-]+\.test\.js$/.test(file)));
  return files;
}
export function controlPath() {
  const path = readFileSync(directory + '/control-directory.txt', 'utf8').trim(), stat = lstatSync(path);
  assert.ok(isAbsolute(path) && stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700 && stat.uid === process.getuid());
  const canonical = realpathSync(path);
  assert.ok(lstatSync(join(canonical, 'control')).isSocket()); return { directory: canonical, socket: join(canonical, 'control') };
}
export function remoteJson(fn, args = []) {
  const control = controlPath();
  return JSON.parse(execFileSync('ssh', ['-S', control.socket, configuration.sshHost, '/usr/bin/env -i PATH=/usr/bin:/bin ' + root + '/node-v24.20.0-linux-x64/bin/node --input-type=module'],
    { input: 'const auditRoot = (' + auditRoot.toString() + '); console.log(JSON.stringify(await (' + fn.toString() + ')(...' + JSON.stringify(args) + ')));',
      encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 }));
}
/** All comm names; only observable same-UID exe/cwd paths establish ownership. */
export async function auditRoot(root) {
  const fs = await import('node:fs'), { execFileSync } = await import('node:child_process');
  const inside = value => value === root || value.startsWith(root + '/');
  const transient = error => ['ENOENT', 'ESRCH'].includes(error?.code);
  const observedProcesses = [], inaccessiblePeers = [], unresolved = [], auditErrors = [];
  for (const name of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
    const pid = Number(name); if (pid === process.pid) continue;
    try {
      if (fs.statSync(`/proc/${pid}`).uid !== process.getuid()) continue;
      const paths = {}, unavailableFields = [];
      for (const field of ['exe', 'cwd']) {
        try { paths[field] = fs.readlinkSync(`/proc/${pid}/${field}`); }
        catch (error) {
          if (['EACCES', 'EPERM'].includes(error.code)) unavailableFields.push({ field, code: error.code });
          else if (!transient(error)) auditErrors.push({ pid, field, code: error.code ?? error.name });
        }
      }
      const owned = Object.values(paths).some(inside);
      if (unavailableFields.length) {
        inaccessiblePeers.push({ pid, visiblePaths: paths, unavailableFields, scope: owned ? 'observed_owned' : 'unresolved' });
        if (!owned) unresolved.push({ pid, visiblePaths: paths, unavailableFields, reason: 'scope_not_proven_from_accessible_paths' });
      }
      if (owned) observedProcesses.push({ pid, ...paths, unavailableFields });
    } catch (error) { if (!transient(error)) auditErrors.push({ pid, field: 'process_owner', code: error.code ?? error.name }); }
  }
  const ownedPids = observedProcesses.map(item => item.pid).sort((a, b) => a - b);
  return { at: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
    realRoot: fs.realpathSync(root), rootMode: (fs.statSync(root).mode & 0o777).toString(8),
    observedOwnedProcesses: ownedPids.length, ownedProcesses: ownedPids.length, ownedPids, observedProcesses,
    inaccessiblePeers, unresolved, auditErrors, globalProcessAbsenceProven: false,
    processAuditScope: 'Same-UID observable exe/cwd inside dedicated root, excluding this audit process; inaccessible peers remain unresolved. No comm/cmdline/environ filter or read.',
    defaultNode: execFileSync('/usr/bin/node', ['--version'], { encoding: 'utf8' }).trim(),
    filesystem: execFileSync('/usr/bin/findmnt', ['--target', root, '--noheadings', '--output', 'FSTYPE,OPTIONS'], { encoding: 'utf8' }).trim() };
}
export function requireCleanAudit(audit) {
  assert.equal(audit.platform, 'linux'); assert.equal(audit.node, 'v24.20.0'); assert.equal(audit.realRoot, root);
  assert.equal(audit.rootMode, '700'); assert.equal(audit.defaultNode, configuration.expectedDefaultNode);
  assert.deepEqual(audit.auditErrors, []); assert.equal(audit.observedOwnedProcesses, 0);
}
