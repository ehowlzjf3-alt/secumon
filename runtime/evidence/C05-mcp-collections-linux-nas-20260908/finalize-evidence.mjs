// Run only after final collection and close-native. This script never connects to NAS or runs tests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEvaluationBuild } from '../../dist/infrastructure/local-evaluation.js';
import { directory, root, configuration, assertPin, assertLocalResult, assertLocalStageObservation, parseTestSummary, selectedTestFiles, requireCleanAudit } from './mcp-collections-c05-common.mjs';

const runtime = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
assert.equal(realpathSync(process.cwd()), runtime, 'run from runtime');
const localBuildManifestBytes = readFileSync(join(runtime, 'dist/build-manifest.json'));
const localBuildManifest = JSON.parse(localBuildManifestBytes.toString('utf8'));
const localBuildManifestSha256 = createHash('sha256').update(localBuildManifestBytes).digest('hex');
assert.ok(/^v24\./.test(localBuildManifest.node), 'MCP collection general resume local build requires Node 24');
assert.equal(process.version, localBuildManifest.node, 'use the actual local build runtime; native Linux has its own recorded runtime');
const outputPath = join(runtime, directory, 'verification.json');
assert.equal(existsSync(outputPath), false, 'final evidence is immutable; do not overwrite');
const files = new Map();
function read(path) {
  assert.ok(typeof path === 'string' && /^evidence\/[a-zA-Z0-9_./-]+$/.test(path) && !path.split('/').includes('..'), 'evidence-only path required');
  const absolute = resolve(runtime, path), stat = lstatSync(absolute);
  assert.equal(realpathSync(absolute), absolute); assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.ok(stat.size <= 128 * 1024 * 1024, 'bounded evidence read');
  const bytes = readFileSync(absolute), sha256 = createHash('sha256').update(bytes).digest('hex');
  if (files.has(path)) assert.equal(files.get(path).sha256, sha256, 'evidence changed during finalization');
  files.set(path, { path: 'runtime/' + path, sha256 }); return bytes;
}
const json = path => JSON.parse(read(path).toString('utf8'));
function tap(path, passed = true) {
  const text = read(path).toString('utf8');
  const counts = parseTestSummary(text);
  const timeoutFailures = [...text.matchAll(/failureType:\s*['"]?testTimeoutFailure\b/g)].length;
  if (passed) { assert.equal(counts.fail, 0); assert.equal(counts.cancelled, 0); assert.equal(timeoutFailures, 0); }
  const recoveryTests = [...text.matchAll(/^\s*(?:ok \d+ - |✔ )(.*(?:SIGKILL|receipt|previous|draft|source|resume|compact|delivery|reply|restart).*)$/gmi)].map(match => match[1]);
  return { ...counts, timeoutFailures, recoveryTests };
}
function passedLocal(selected, pin) {
  assert.ok(selected && /^[a-f0-9]{64}$/.test(selected.sha256));
  const result = json(selected.path); assert.equal(files.get(selected.path).sha256, selected.sha256); assert.deepEqual(result, selected.result);
  assertLocalResult(result, pin);
  for (const item of result.evidence) { read(item.path); assert.equal(files.get(item.path).sha256, item.sha256); }
  assert.deepEqual(json(result.sourceObservation.pinPath), pin);
  const tests = tap(result.logPath);
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) assert.equal(result.counts[key], tests[key]);
  const observedExit = json(result.evidence.find(item => item.role === 'recorded_exec_exit_observations').path);
  assert.ok(Array.isArray(observedExit.executions));
  assert.ok(observedExit.executions.some(item => item.sessionId === result.processEvidence.sessionId && item.exitCode === 0 &&
    `evidence/C05-mcp-collections-${item.stage}.log` === result.logPath));
  let stageObservation = null;
  if (result.sourceObservation.kind === 'per_run_source_and_build_verification') {
    stageObservation = assertLocalStageObservation(result, pin, json(result.sourceObservation.runnerPath));
  } else if (result.processEvidence.path) {
    const actual = json(result.processEvidence.path);
    assert.equal(actual.code, 0); assert.equal(actual.signal, null); assert.equal(actual.timedOut, false);
    assert.equal(actual.startedAt, result.startedAt); assert.equal(actual.finishedAt, result.finishedAt);
  }
  return { result: 'runtime/' + selected.path, log: 'runtime/' + result.logPath,
    ...(result.startedAt ? { startedAt: result.startedAt } : {}), ...(result.finishedAt ? { finishedAt: result.finishedAt } : {}),
    ...(result.completedObservedAt ? { completedObservedAt: result.completedObservedAt } : {}), timestampMeaning: result.timestampMeaning,
    exactFinishedAtCaptured: result.exactFinishedAtCaptured ?? (result.timestampMeaning === 'actual_child_exit_observed_by_stage_runner' && !!result.finishedAt),
    stageObservation, testNode: result.testNode ?? null, processEvidence: result.processEvidence,
    sourceObservation: result.sourceObservation, evidence: result.evidence, durationMs: result.durationMs, tests, sourceAndBuild: pin };
}
const pin = assertPin(json(directory + '/build-pin.json'));
assert.deepEqual(await verifyEvaluationBuild(runtime), pin);
const metadata = json(directory + '/run-metadata.json');
assert.equal(metadata.status, 'passed'); assert.equal(metadata.sessionCompleted, true); assert.equal(metadata.sshClosed, true);
assert.equal(metadata.observerExitCode, 0); assert.equal(metadata.observerSignal, null);
assert.equal(metadata.root, root); assert.deepEqual(metadata.sourceAndBuild, pin);
assert.ok(Number.isSafeInteger(metadata.attempt) && metadata.attempt >= 1 && metadata.attempt <= 9);
const stamp = directory + '/upload-attempt' + metadata.attempt;
const inputs = json(stamp + '-validation-inputs.json'); assert.deepEqual(inputs.pin, pin);
const local = { platform: process.platform, arch: process.arch, node: process.version,
  nodeScope: 'finalization_process_only', testNodeVersions: { newTests: inputs.newTests.result.testNode ?? null, relatedTests: inputs.relatedTests.result.testNode ?? null },
  build: { status: 'current_build_manifest_verified', node: localBuildManifest.node,
    manifest: 'runtime/dist/build-manifest.json', manifestSha256: localBuildManifestSha256,
    manifestSnapshot: localBuildManifest, sourceAndBuild: pin },
  newTests: passedLocal(inputs.newTests, pin), relatedTests: passedLocal(inputs.relatedTests, pin),
  fullTests: { status: 'not_run_for_this_final_source_locally', nativeLinuxResultBelow: true } };
const uploads = json(stamp + '-uploads.json'), upload = json(stamp + '.json');
assert.equal(upload.attempt, metadata.attempt); assert.equal(upload.sourceDigest, pin.sourceDigest); assert.equal(upload.dependencyLockUnchanged, true);
assert.deepEqual(upload.uploads, uploads); requireCleanAudit(upload.beforeProcesses);
const remoteNames = new Set(['mcp-collections-c05-source-attempt' + metadata.attempt + '.tar.gz', 'verify-linux-mcp-collections-c05.mjs',
  'mcp-collections-c05-common.mjs', 'mcp-collections-c05-config.json', 'mcp-collections-c05-validation-inputs.json', 'mcp-collections-c05-targeted-files.json', 'mcp-collections-c05-build-pin.json']);
assert.equal(uploads.length, remoteNames.size); assert.equal(new Set(uploads.map(item => item.remote)).size, remoteNames.size);
for (const item of uploads) {
  assert.ok(remoteNames.has(item.remote.slice(root.length + 1)) && item.remote.startsWith(root + '/'));
  read(item.local); assert.equal(files.get(item.local).sha256, item.sha256);
}
const collected = json(directory + '/final-collection.json'), native = json(directory + '/final/result.json');
assert.equal(collected.status, 'passed'); assert.equal(native.status, 'passed'); assert.ok(native.finishedAt);
assert.equal(collected.finishedAt, native.finishedAt); assert.equal(metadata.finishedAt, native.finishedAt);
assert.deepEqual(collected.sourceAndBuild, pin); assert.deepEqual(native.buildPin, pin); assert.deepEqual(native.localValidationInputs, inputs);
assert.equal(native.environment.platform, 'linux'); assert.equal(native.environment.node, 'v24.20.0');
assert.equal(native.scope, 'native_linux_mcp_collections_general_resume'); assert.deepEqual(native.predecessor, configuration.predecessor);
assert.equal(native.externalModelCalls, false); assert.equal(native.internalServiceIntegration, false); assert.equal(native.productionDeployment, false);
assert.equal(native.executionLimits.nodeTestTimeoutMs, 60000); assert.equal(native.executionLimits.fullStageDeadlineMs, 1200000);
assert.equal(native.executionLimits.otherStageDeadlineMs, 180000);
assert.equal(native.executionLimits.testStageDeadlineMs, 300000); assert.equal(native.executionLimits.overallDeadlineMs, 1800000);
requireCleanAudit(native.beforeProcesses); requireCleanAudit(native.afterProcesses);
const stepNames = ['build', 'new-mcp-collections-tests', 'related-existing-tests', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures'];
assert.deepEqual(native.steps.map(step => step.name), stepNames);
assert.deepEqual(metadata.logsCollected, ['result.json', ...stepNames.map(name => name + '.log')]);
assert.equal(collected.files.length, stepNames.length + 1); assert.equal(new Set(collected.files.map(item => item.file)).size, collected.files.length);
for (const item of collected.files) {
  assert.ok(item.file === 'result.json' || stepNames.some(name => item.file === name + '.log'));
  const path = directory + '/final/' + item.file; read(path); assert.equal(files.get(path).sha256, item.sha256);
}
for (const step of native.steps) {
  assert.equal(step.status, 'passed'); assert.equal(step.exitCode, 0); assert.equal(step.signal, null);
  assert.equal(step.timedOut, false); assert.equal(step.terminationReason, null); assert.equal(step.nodeTestTimeoutFailures, 0);
  assert.equal(step.groupAbsentConfirmed, true); assert.equal(step.finalGroupState, 'absent'); assert.equal(step.logFlushCompleted, true);
  assert.deepEqual(step.errors, []); assert.ok(step.leaderExit && step.stdioClose && step.finishedAt);
  assert.equal(step.leaderExit.code, 0); assert.equal(step.stdioClose.code, 0);
}
const nativeTests = Object.fromEntries(['new-mcp-collections-tests', 'related-existing-tests', 'all-tests'].map(name => {
  const parsed = tap(directory + '/final/' + name + '.log'), stored = native.steps.find(step => step.name === name).tapSummary;
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) assert.equal(stored[key], parsed[key]);
  return [name, parsed];
}));
const lists = json(directory + '/targeted-files.json');
assert.deepEqual(json(stamp + '-targeted-files.json'), lists);
for (const [key, source, path] of [
  ['newFiles', 'newTests', 'evidence/C05-mcp-collections-new-files.json'],
  ['relatedFiles', 'relatedTests', 'evidence/C05-mcp-collections-related-files.json'],
]) {
  const selected = inputs.selections[source]; assert.equal(selected.path, path);
  const current = json(path); assert.equal(files.get(path).sha256, selected.sha256);
  assert.deepEqual(current, selected.files); assert.deepEqual(lists[key], selected.files);
  assert.ok(Array.isArray(current) && current.length > 0 && new Set(current).size === current.length);
  const observed = json(inputs[source].result.sourceObservation.runnerPath);
  assert.deepEqual(selectedTestFiles(observed.args).sort(), [...current].sort());
}
assert.equal(lists.newFiles.some(file => lists.relatedFiles.includes(file)), false);
assert.deepEqual(native.targeted.files, lists.newFiles); assert.deepEqual(native.related.files, lists.relatedFiles);
assert.equal(native.targeted.observedTestCount, nativeTests['new-mcp-collections-tests'].tests);
assert.equal(native.related.observedTestCount, nativeTests['related-existing-tests'].tests);
assert.ok(Array.isArray(native.allTestFiles) && new Set(native.allTestFiles).size === native.allTestFiles.length);
assert.deepEqual(native.allTestFiles, readdirSync(join(runtime, 'dist/tests')).filter(name => name.endsWith('.test.js')).sort().map(name => 'dist/tests/' + name),
  'the full suite must cover every test file in the exact verified build');
for (const path of [...lists.newFiles, ...lists.relatedFiles]) assert.ok(native.allTestFiles.includes(path));
const cleanup = json(directory + '/cleanup.json'); requireCleanAudit(cleanup); assert.equal(cleanup.sshClosed, true);
assert.equal(cleanup.globalProcessAbsenceProven, false); assert.ok(Array.isArray(cleanup.inaccessiblePeers) && Array.isArray(cleanup.unresolved));
assert.equal(Date.parse(cleanup.at) >= Date.parse(native.finishedAt), true);
const controlDirectory = read(directory + '/control-directory.txt').toString('utf8').trim(); assert.ok(isAbsolute(controlDirectory));
assert.equal(existsSync(join(controlDirectory, 'control')), false); assert.equal(existsSync(controlDirectory), false);
const preflight = json(directory + '/preflight.json'); requireCleanAudit(preflight);
assert.equal(preflight.previousNative.status, 'passed'); assert.equal(preflight.previousNative.sha256, configuration.predecessor.nativeResultSha256);

const priorAttempts = [];
const historicalEvidence = configuration.historyEvidence.map(path => {
  const record = json(path);
  if (path === configuration.predecessor.path) {
    assert.equal(files.get(path).sha256, configuration.predecessor.sha256, 'predecessor proof changed');
    assert.equal(record.scope, 'mcp_offline_general_resume'); assert.equal(record.nativeLinux.status, 'passed');
    assert.deepEqual(record.nativeLinux.collectedFiles.filter(item => item.file === 'result.json'),
      [{ file: 'result.json', sha256: configuration.predecessor.nativeResultSha256 }]);
  }
  return { path: 'runtime/' + path, sha256: files.get(path).sha256, status: record.status ?? null,
    interpretation: 'Operator-selected historical evidence; retained without promoting its pin, counts or diagnosis to this C05 run.' };
});
for (let attempt = 1; attempt < metadata.attempt; attempt++) {
  const collection = json(directory + '/attempt-' + attempt + '-collection.json');
  const old = json(directory + '/attempt-' + attempt + '/result.json'); assert.equal(old.status, 'failed'); assert.ok(old.finishedAt);
  for (const item of collection.files) {
    assert.ok(item.file === 'result.json' || stepNames.some(name => item.file === name + '.log'));
    const path = directory + '/attempt-' + attempt + '/' + item.file; read(path); assert.equal(files.get(path).sha256, item.sha256);
  }
  priorAttempts.push({ nativeAttempt: attempt, sourceAndBuild: old.buildPin, finishedAt: old.finishedAt,
    evidence: 'runtime/' + directory + '/attempt-' + attempt + '/result.json', status: old.status });
}
for (const name of ['configure.mjs', 'mcp-collections-c05-config.json', 'script-provenance.json', 'mcp-collections-c05-common.mjs', 'verify-linux-mcp-collections-c05.mjs', 'finalize-evidence.mjs', 'collect-attempt.mjs', 'close-native.mjs', 'start-native.mjs', 'prepare-upload.mjs', 'preflight.mjs', 'select-local.mjs']) read(directory + '/' + name);
const result = { schemaVersion: 1, chapter: 'C05', scope: 'mcp_collections_general_resume',
  status: 'verified_supported_local_posix_partial_chapter', recordedAt: new Date().toISOString(), chapterComplete: false, goalComplete: false,
  sourceAndBuild: pin, local,
  nativeLinux: { status: 'passed', attempt: metadata.attempt, startedAt: native.startedAt, finishedAt: native.finishedAt,
    environment: native.environment, sourceAndBuild: native.buildPin, tests: nativeTests['all-tests'], newTests: nativeTests['new-mcp-collections-tests'],
    relatedTests: nativeTests['related-existing-tests'], targetedFiles: lists.newFiles, relatedFiles: lists.relatedFiles, allTestFiles: native.allTestFiles,
    steps: native.steps, collectedFiles: collected.files, executionLimits: native.executionLimits,
    beforeProcesses: native.beforeProcesses, afterProcesses: native.afterProcesses, cleanup,
    processAuditConclusion: 'Observed same-UID dedicated-root processes and directly managed groups are absent; inaccessible peers remain unresolved, so global process absence is not established.' },
  upload: { attempt: metadata.attempt, sourceDigest: upload.sourceDigest, dependencyLockUnchanged: true, files: uploads },
  priorAttempts, historicalEvidence,
  recovery: { evidence: 'nativeLinux.newTests.recoveryTests', realProcessSignalsInSyntheticFixtures: 'Inspect retained recovery test names and source; not inferred from totals', injectedFailuresAlsoUsed: 'See test source', powerLossTested: false },
  limitations: ['No real model/API, Knox/internal-service integration, or production deployment was tested.',
    'Native Windows runtime/file bindings remain unimplemented or unconnected and unverified; this Linux run cannot establish Windows support.',
    'Registered PostgreSQL storage remains unimplemented and unverified.',
    'Synthetic content verifies structure and provenance, not real model quality.',
    'SIGKILL and injected I/O failures do not establish power-loss durability; filesystem mount options remain in the audit.',
    'Same-UID coordinated rollback of all canonical and witness files is outside the detectable boundary.',
    'Only directly spawned detached groups are signaled; separately regrouped descendants are outside that guarantee.',
    'Inaccessible same-UID /proc peers remain unresolved; observed owned zero is not global process absence.',
    'No real-model answer quality, throughput, physical I/O, or peak-memory performance benchmark is claimed.',
    'The historical D2 initialization failure and MCP stall remain bounded unresolved diagnoses; this C05 result does not establish their original causes.',
    'Decoded response custody and known transport measurements are separate from body adoption; a sent flag is not proof of remote execution or billing.',
    'CLI/Web usage reconciliation does not authorize inaccessible original session input; such resume remains denied after bookkeeping. The public-input fixture exercises a valid checkpoint separately.',
    'Raw-only or intent-only gaps do not prove a response commit; they cannot trigger a retransmission or invent known usage.',
    'Explicit stored_only MCP registration skips peer construction/discovery; it is not an automatic fallback or a guarantee that the selected model/provider uses no network.',
    'Collection acceptance is limited to the exact selected test files and retained logs; historical plain-read CLI/HTTP counts do not establish collection coverage.',
    'Collection/page/wait behavior beyond the retained final tests remains unverified; a stored_complete marker is not execution authority or permission for automatic online fallback.',
    'This script does not decide C05 chapter acceptance or complete the overall implementation goal.'],
  files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
assert.deepEqual(await verifyEvaluationBuild(runtime), pin);
assert.equal(createHash('sha256').update(readFileSync(join(runtime, 'dist/build-manifest.json'))).digest('hex'), localBuildManifestSha256, 'build manifest changed during finalization');
for (const [path, recorded] of files) { read(path); assert.equal(files.get(path).sha256, recorded.sha256); }
writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const counts = ({ recoveryTests: _recoveryTests, ...values }) => values;
console.log(JSON.stringify({ status: result.status, output: 'runtime/' + directory + '/verification.json',
  newTests: counts(result.nativeLinux.newTests), relatedTests: counts(result.nativeLinux.relatedTests), tests: counts(result.nativeLinux.tests), sourceAndBuild: pin,
  observedOwnedProcesses: cleanup.observedOwnedProcesses, unresolvedPeers: cleanup.unresolved.length, sshClosed: cleanup.sshClosed }));
