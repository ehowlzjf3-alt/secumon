// Run only after final collection and close-native. This script never connects to NAS or runs tests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEvaluationBuild } from '../../dist/infrastructure/local-evaluation.js';
import { directory, root, assertPin, requireCleanAudit } from './migration-c03-common.mjs';

const runtime = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
assert.equal(realpathSync(process.cwd()), runtime, 'run from runtime');
assert.equal(process.version, 'v24.20.0');
const outputPath = join(runtime, 'evidence/C03-migration-verification.json');
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
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => {
    const raw = [...text.matchAll(new RegExp('^# ' + key + ' (\\d+)\\r?$', 'gm'))].at(-1)?.[1];
    assert.notEqual(raw, undefined, 'TAP summary missing: ' + path + '/' + key); return [key, Number(raw)];
  }));
  assert.ok(counts.tests > 0); assert.equal(counts.tests, counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo);
  const timeoutFailures = [...text.matchAll(/failureType:\s*['"]?testTimeoutFailure\b/g)].length;
  if (passed) { assert.equal(counts.fail, 0); assert.equal(counts.cancelled, 0); assert.equal(timeoutFailures, 0); }
  const recoveryTests = [...text.matchAll(/^\s*ok \d+ - (.*(?:SIGKILL|backup|fence|receipt|activation|resume).*)$/gmi)].map(match => match[1]);
  return { ...counts, timeoutFailures, recoveryTests };
}
function passedLocal(selected, pin) {
  assert.ok(selected && /^[a-f0-9]{64}$/.test(selected.sha256));
  const result = json(selected.path); assert.equal(files.get(selected.path).sha256, selected.sha256); assert.deepEqual(result, selected.result);
  assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(result.timedOut, false); assert.ok(result.finishedAt);
  assert.deepEqual(result.sourceAndBuild, pin);
  assert.ok(selected.path.endsWith('-result.json'));
  const stem = selected.path.slice(0, -'-result.json'.length), tests = tap(stem + '.log');
  const before = json(stem + '-before.json'); assert.deepEqual(before, pin);
  return { result: 'runtime/' + selected.path, log: 'runtime/' + stem + '.log', finishedAt: result.finishedAt, durationMs: result.durationMs, tests, sourceAndBuild: pin };
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
  build: { status: 'current_build_manifest_verified', sourceAndBuild: pin },
  newTests: passedLocal(inputs.newTests, pin), relatedTests: passedLocal(inputs.relatedTests, pin),
  fullTests: { status: 'not_run_for_this_final_source_locally', nativeLinuxResultBelow: true } };
const uploads = json(stamp + '-uploads.json'), upload = json(stamp + '.json');
assert.equal(upload.attempt, metadata.attempt); assert.equal(upload.sourceDigest, pin.sourceDigest); assert.equal(upload.dependencyLockUnchanged, true);
assert.deepEqual(upload.uploads, uploads); requireCleanAudit(upload.beforeProcesses);
const remoteNames = new Set(['migration-c03-source-attempt' + metadata.attempt + '.tar.gz', 'verify-linux-migration-c03.mjs',
  'migration-c03-common.mjs', 'migration-c03-validation-inputs.json', 'migration-c03-targeted-files.json', 'migration-c03-build-pin.json']);
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
assert.equal(native.externalModelCalls, false); assert.equal(native.internalServiceIntegration, false); assert.equal(native.productionDeployment, false);
assert.equal(native.executionLimits.nodeTestTimeoutMs, 60000); assert.equal(native.executionLimits.fullStageDeadlineMs, 900000);
assert.equal(native.executionLimits.otherStageDeadlineMs, 180000); assert.equal(native.executionLimits.overallDeadlineMs, 1200000);
requireCleanAudit(native.beforeProcesses); requireCleanAudit(native.afterProcesses);
const stepNames = ['build', 'migration-new', 'migration-related', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures'];
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
const nativeTests = Object.fromEntries(['migration-new', 'migration-related', 'all-tests'].map(name => {
  const parsed = tap(directory + '/final/' + name + '.log'), stored = native.steps.find(step => step.name === name).tapSummary;
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) assert.equal(stored[key], parsed[key]);
  return [name, parsed];
}));
const lists = json(directory + '/targeted-files.json');
assert.deepEqual(native.targeted.files, lists.newFiles); assert.deepEqual(native.related.files, lists.relatedFiles);
assert.equal(native.targeted.observedTestCount, nativeTests['migration-new'].tests);
assert.equal(native.related.observedTestCount, nativeTests['migration-related'].tests);
assert.ok(Array.isArray(native.allTestFiles) && new Set(native.allTestFiles).size === native.allTestFiles.length);
for (const path of [...lists.newFiles, ...lists.relatedFiles]) assert.ok(native.allTestFiles.includes(path));
const cleanup = json(directory + '/cleanup.json'); requireCleanAudit(cleanup); assert.equal(cleanup.sshClosed, true);
assert.equal(cleanup.globalProcessAbsenceProven, false); assert.ok(Array.isArray(cleanup.inaccessiblePeers) && Array.isArray(cleanup.unresolved));
assert.equal(Date.parse(cleanup.at) >= Date.parse(native.finishedAt), true);
const controlDirectory = read(directory + '/control-directory.txt').toString('utf8').trim(); assert.ok(isAbsolute(controlDirectory));
assert.equal(existsSync(join(controlDirectory, 'control')), false); assert.equal(existsSync(controlDirectory), false);
requireCleanAudit(json(directory + '/preflight.json'));

const priorAttempts = [];
for (const [stem, interpretation] of [
  ['C03-migration-new1', 'Initial local run contained test-observation/fixture failures; retain raw failure counts and subsequent diagnoses.'],
  ['C03-migration-new2', 'Historical intermediate local new-tests pass, before the final source.'],
  ['C03-migration-related1', 'Historical existing-profile regression failures exposed WAL/SHM side effects in metadata inspection; final source separates metadata inspection and activation gates.'],
]) {
  const result = json('evidence/' + stem + '-result.json');
  priorAttempts.push({ result: 'runtime/evidence/' + stem + '-result.json', log: 'runtime/evidence/' + stem + '.log',
    exitCode: result.code, sourceAndBuild: result.sourceAndBuild, tests: tap('evidence/' + stem + '.log', result.code === 0), interpretation });
  json('evidence/' + stem + '-before.json');
}
const diagnoses = ['evidence/C03-migration-new1-backup-disconnect-diagnosis.json', 'evidence/C03-migration-new1-compact-diagnosis.json'];
for (const path of diagnoses) json(path);
const d2ProofPath = 'evidence/C03-drafts-verification.json', d2Proof = json(d2ProofPath);
const priorD2 = { proof: 'runtime/' + d2ProofPath, sha256: files.get(d2ProofPath).sha256, status: d2Proof.status, sourceAndBuild: d2Proof.sourceAndBuild,
  scope: 'historical_D2_evidence_not_current_D3_verification', unresolvedDiagnoses: [] };
for (const [key, path] of [['initializationDiagnosis', 'evidence/C03-drafts-initialization-diagnosis.json'],
  ['mcpDiagnosis', 'evidence/C03-drafts-mcp-diagnosis.json']]) {
  const diagnosis = json(path);
  assert.equal(diagnosis.status, d2Proof[key].status);
  priorD2.unresolvedDiagnoses.push({ evidence: 'runtime/' + path, sha256: files.get(path).sha256,
    status: diagnosis.status, summary: diagnosis.summary,
    originalEvidenceReferences: diagnosis.evidence, interpretation: 'Retained original diagnosis; a later D3 pass does not resolve the historical unexplained observation.' });
}
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
for (const name of ['finalize-evidence.mjs', 'collect-attempt.mjs', 'close-native.mjs', 'start-native.mjs', 'prepare-upload.mjs', 'preflight.mjs']) read(directory + '/' + name);
const result = { schemaVersion: 1, chapter: 'C03', scope: 'D3_explicit_personal_memory_sqlite_to_documents_backup_fence_seed_activation_recovery',
  status: 'verified_supported_local_posix_partial_chapter', recordedAt: new Date().toISOString(), chapterComplete: false, goalComplete: false,
  sourceAndBuild: pin, local,
  nativeLinux: { status: 'passed', attempt: metadata.attempt, startedAt: native.startedAt, finishedAt: native.finishedAt,
    environment: native.environment, sourceAndBuild: native.buildPin, tests: nativeTests['all-tests'], newTests: nativeTests['migration-new'],
    relatedTests: nativeTests['migration-related'], targetedFiles: lists.newFiles, relatedFiles: lists.relatedFiles, allTestFiles: native.allTestFiles,
    steps: native.steps, collectedFiles: collected.files, executionLimits: native.executionLimits,
    beforeProcesses: native.beforeProcesses, afterProcesses: native.afterProcesses, cleanup,
    processAuditConclusion: 'Observed same-UID dedicated-root processes and directly managed groups are absent; inaccessible peers remain unresolved, so global process absence is not established.' },
  upload: { attempt: metadata.attempt, sourceDigest: upload.sourceDigest, dependencyLockUnchanged: true, files: uploads },
  priorAttempts, priorD2, diagnoses: diagnoses.map(path => 'runtime/' + path),
  recovery: { evidence: 'nativeLinux.newTests.recoveryTests', realProcessSignalsInSyntheticFixtures: true, injectedFailuresAlsoUsed: true, powerLossTested: false },
  limitations: ['No real model/API, Knox/internal-service integration, or production deployment was tested.',
    'Native Windows runtime dispatch/file bindings and parts of the SQLite backup file lifecycle remain unimplemented or unconnected and unverified; the preliminary Rust setup experiment does not provide C03 Windows support.',
    'Registered PostgreSQL storage/migration support remains unimplemented and unverified; this D3 path is the supported POSIX SQLite-to-documents path.',
    'Synthetic content verifies structure and provenance, not real model quality.',
    'SIGKILL and injected I/O failures do not establish power-loss durability; filesystem mount options remain in the audit.',
    'Same-UID coordinated rollback of all canonical and witness files is outside the detectable boundary.',
    'Only directly spawned detached groups are signaled; separately regrouped descendants are outside that guarantee.',
    'Inaccessible same-UID /proc peers remain unresolved; observed owned zero is not global process absence.',
    'No migration throughput, physical I/O, or peak-memory performance benchmark is claimed.',
    'The historical D2 initialization failure and MCP stall remain bounded unresolved diagnoses; this D3 result does not establish their original causes.',
    'C03 as a whole and the overall implementation goal remain incomplete.'],
  files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
assert.deepEqual(await verifyEvaluationBuild(runtime), pin);
for (const [path, recorded] of files) { read(path); assert.equal(files.get(path).sha256, recorded.sha256); }
writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const counts = ({ recoveryTests: _recoveryTests, ...values }) => values;
console.log(JSON.stringify({ status: result.status, output: 'runtime/evidence/C03-migration-verification.json',
  newTests: counts(result.nativeLinux.newTests), relatedTests: counts(result.nativeLinux.relatedTests), tests: counts(result.nativeLinux.tests), sourceAndBuild: pin,
  observedOwnedProcesses: cleanup.observedOwnedProcesses, unresolvedPeers: cleanup.unresolved.length, sshClosed: cleanup.sshClosed }));
