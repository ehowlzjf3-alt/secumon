// Run only after root has collected the terminal NAS run and completed cleanup.
// From runtime/: node evidence/C02-compact-linux-nas-20260907/finalize-evidence.mjs <expectedTotal> [expectedPinPath]
// This script validates existing evidence. It does not build, run tests, access NAS, or invoke a model.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { verifyEvaluationBuild } from '../../dist/infrastructure/local-evaluation.js';
import { Sha256Digester } from '../../dist/infrastructure/digest.js';

assert.equal(process.version, 'v24.20.0', 'use the pinned Node 24 runtime');
assert.ok(process.argv.length >= 3 && process.argv.length <= 4 && /^[1-9][0-9]*$/.test(process.argv[2]),
  'usage: finalize-evidence.mjs <expectedTotal> [expectedPinPath]');
const expectedTotal = Number(process.argv[2]);
assert.ok(Number.isSafeInteger(expectedTotal) && expectedTotal >= 46, 'invalid expectedTotal');
const directory = 'evidence/C02-compact-linux-nas-20260907';
const finalDirectory = join(directory, 'final');
const expectedPinPath = process.argv[3] ?? 'evidence/C02-compact-build-pin.json';
const output = 'evidence/C02-compact-verification.json';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const evidenceRef = path => ({ path, sha256: hash(path) });
const jsonLog = path => {
  const text = readFileSync(path, 'utf8'); const start = text.indexOf('{');
  assert.ok(start >= 0, `${path}: JSON result missing`);
  return JSON.parse(text.slice(start));
};
function observedCounts(path) {
  const text = readFileSync(path, 'utf8'); const result = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...text.matchAll(new RegExp(`^(?:# |ℹ )${key} (\\d+)\\r?$`, 'gm'))];
    assert.equal(matches.length, 1, `${path}: one final ${key} count required`);
    result[key] = Number(matches[0][1]); assert.ok(Number.isSafeInteger(result[key]));
  }
  return result;
}
function counts(path, tests, fail = 0) {
  const result = observedCounts(path);
  assert.deepEqual(result, { tests, pass: tests - fail, fail, cancelled: 0, skipped: 0, todo: 0 }, path);
  return result;
}
function coreFiles(path) {
  return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => total +
    (entry.isDirectory() ? coreFiles(join(path, entry.name)) : entry.isFile() && entry.name.endsWith('.ts') ? 1 : 0), 0);
}
function terminal(record, label) {
  assert.ok(['passed', 'failed'].includes(record.status), `${label}: terminal status required`);
  assert.ok(typeof record.finishedAt === 'string' && Number.isFinite(Date.parse(record.finishedAt)), `${label}: finishedAt required`);
  assert.ok(Array.isArray(record.steps) && record.steps.every(step => ['passed', 'failed'].includes(step.status)), `${label}: unfinished step`);
}
function collection(label, record) {
  const folder = join(directory, label); const path = join(directory, `${label}-collection.json`); const value = json(path);
  assert.equal(value.status, record.status); assert.equal(value.finishedAt, record.finishedAt);
  assert.deepEqual(value.sourceAndBuild, record.buildPin);
  const expected = ['result.json', ...record.steps.map(step => `${step.name}.log`)].sort();
  assert.deepEqual(value.files.map(item => item.file).sort(), expected, `${label}: collected files`);
  assert.equal(new Set(expected).size, expected.length, `${label}: duplicate step`);
  for (const item of value.files) {
    assert.equal(basename(item.file), item.file, `${label}: invalid file name`);
    assert.equal(hash(join(folder, item.file)), item.sha256, `${label}/${item.file}: collection hash`);
  }
  return { ...evidenceRef(path), files: expected.map(file => evidenceRef(join(folder, file))) };
}

const native = json(join(finalDirectory, 'result.json')); terminal(native, 'final');
assert.equal(native.status, 'passed');
assert.equal(native.environment.platform, 'linux'); assert.equal(native.environment.node, 'v24.20.0');
assert.equal(native.externalModelCalls, false); assert.equal(native.internalServiceIntegration, false); assert.equal(native.productionDeployment, false);
const stepNames = ['build', 'compact-targeted', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures'];
assert.deepEqual(native.steps.map(step => step.name), stepNames);
assert.ok(native.steps.every(step => step.status === 'passed' && step.exitCode === 0 && step.signal === null));
assert.equal(native.targetedExpectation.tests, 46); assert.equal(native.targetedExpectation.files, 5);
const pin = await verifyEvaluationBuild(process.cwd());
assert.deepEqual(pin, json(expectedPinPath), 'current source/build versus expected pin');
assert.deepEqual(native.buildPin, pin, 'terminal native run versus current source/build');
const collected = collection('final', native);
const expectedAssets = [
  'evidence/internal-io/v024-original-metrics.json', 'evidence/internal-io/v024-instrumented-metrics.json',
  'evidence/internal-io/v024-snapshot-manifest.json', 'evidence/internal-io/v024-instrumented-manifest.json',
  'evidence/internal-io/instrumented-file-artifacts.js', 'guidance/catalog.json', 'guidance/evidence-review.md',
];
assert.deepEqual(native.verifiedAssets.map(asset => asset.path).sort(), [...expectedAssets].sort());
for (const asset of native.verifiedAssets) assert.equal(hash(asset.path), asset.sha256, `${asset.path}: native static asset pin`);
const architecture = jsonLog(join(finalDirectory, 'architecture.log'));
const currentCoreFiles = coreFiles('src/domain') + coreFiles('src/application');
assert.ok(currentCoreFiles > 0); assert.equal(architecture.inspected, currentCoreFiles); assert.deepEqual(architecture.failures, []);
const architectureCli = jsonLog(join(finalDirectory, 'architecture-cli-fixtures.log'));
assert.equal(architectureCli.platform, 'linux'); assert.equal(architectureCli.node, 'v24.20.0');
assert.deepEqual(architectureCli.results.map(result => result.name), ['valid', 'domain-external-import', 'application-outer-import', 'empty-core']);
assert.deepEqual(architectureCli.results.map(result => result.exitCode), [0, 1, 1, 1]);
assert.deepEqual(architectureCli.results[0].failures, []);
assert.ok(architectureCli.results.slice(1).every(result => result.failures.length > 0));
const fixtures = jsonLog(join(finalDirectory, 'fixtures.log'));
assert.equal(fixtures.passed, true); assert.equal(fixtures.scenarios, 4); assert.equal(fixtures.checkpoints, 22);
const nativeTests = counts(join(finalDirectory, 'all-tests.log'), expectedTotal);
const nativeTargeted = counts(join(finalDirectory, 'compact-targeted.log'), 46);
const cleanupPath = join(directory, 'cleanup.json'); const cleanup = json(cleanupPath);
assert.equal(cleanup.ownedProcesses, 0); assert.equal(cleanup.sshClosed, true); assert.equal(cleanup.rootMode, '700');
assert.equal(cleanup.defaultNode, 'v18.20.4');
if (cleanup.ownedPids !== undefined) assert.deepEqual(cleanup.ownedPids, []);
assert.ok(Number.isFinite(Date.parse(cleanup.verifiedAt)) && Date.parse(cleanup.verifiedAt) >= Date.parse(native.finishedAt), 'cleanup must follow terminal native result');

// Prior pins are preserved as their own evidence. They are not upgraded to the final pin.
const build1ManifestPath = 'evidence/C02-compact-build1-manifest.json'; const build1Manifest = json(build1ManifestPath);
assert.equal(build1Manifest.version, 1); assert.equal(build1Manifest.node, 'v24.20.0');
const build1Pin = { sourceDigest: build1Manifest.sourceDigest, filesDigest: new Sha256Digester().digest(build1Manifest.files), fileCount: build1Manifest.files.length };
const build2PinPath = 'evidence/C02-compact-build2-pin.json'; const build2Pin = json(build2PinPath);
const build1Targeted = counts('evidence/C02-compact-targeted1.log', 46, 4);
const build1Regression = counts('evidence/C02-compact-regression1.log', 127);
const build2Presentation = counts('evidence/C02-compact-presentation2.log', 9);
const browserPath = 'evidence/C02-compact-browser-verification.json'; const browser = json(browserPath);
assert.deepEqual(browser.sourceAndBuild, build2Pin); assert.equal(browser.synthetic, true); assert.equal(browser.realModelInvoked, false);
for (const key of ['tabClosed', 'serverClosed', 'temporaryProfileRemoved']) assert.equal(browser.cleanup[key], true);
const measurementPath = 'evidence/C02-compact-measurement1.json'; const measurement = json(measurementPath);
assert.equal(measurement.status, 'passed'); assert.deepEqual(measurement.buildBefore, build2Pin); assert.deepEqual(measurement.buildAfter, build2Pin);
for (const key of ['realModelInvoked', 'externalApiInvoked', 'productionDataRead', 'actualModelTokenizationMeasured', 'physicalDiskIoMeasured']) assert.equal(measurement[key], false);
assert.equal(measurement.repeats, 1);

// Do not infer the first NAS attempt's outcome from a partial TAP file or the later successful run.
const attemptNames = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^attempt-[1-9][0-9]*$/.test(entry.name))
  .map(entry => entry.name).sort((left, right) => Number(left.slice(8)) - Number(right.slice(8)));
assert.ok(attemptNames.includes('attempt-1'), 'collect terminal attempt-1 evidence before finalization');
const priorNativeAttempts = attemptNames.map(label => {
  const attempt = json(join(directory, label, 'result.json')); terminal(attempt, label);
  const original = collection(label, attempt);
  const steps = attempt.steps.map(step => ({ name: step.name, status: step.status, exitCode: step.exitCode, signal: step.signal,
    ...(step.name === 'all-tests' || step.name === 'compact-targeted' ? { counts: observedCounts(join(directory, label, `${step.name}.log`)) } : {}) }));
  return { label, status: attempt.status, finishedAt: attempt.finishedAt, sourceAndBuild: attempt.buildPin, error: attempt.error ?? null, steps, original };
});
const localNames = readdirSync('evidence').filter(name => /^C02-compact-.*\.log$/.test(name)).sort();
const ownerLogNames = localNames.filter(name => name.startsWith('C02-compact-owner-'));
assert.ok(ownerLogNames.some(name => name.includes('baseline')) && ownerLogNames.some(name => name.includes('fixed')),
  'baseline and fixed owner boundary logs must be preserved');
const ownerMetadata = readdirSync('evidence').filter(name => /^C02-compact-owner-.*(?:-exit|-pin|-manifest)\.json$/.test(name)).sort();
const ownerFixedBuildPath = 'evidence/C02-compact-owner-fixed-build-exit.json';
const ownerFixedTestsPath = 'evidence/C02-compact-owner-fixed-tests-exit.json';
const ownerFixedBuild = json(ownerFixedBuildPath); const ownerFixedTests = json(ownerFixedTestsPath);
for (const value of [ownerFixedBuild, ownerFixedTests]) {
  assert.equal(value.exitCode, 0); assert.equal(value.signal, null); assert.equal(value.launchError, null);
  assert.equal(value.node, 'v24.20.0'); assert.equal(value.platform, 'darwin');
  assert.ok(Number.isFinite(Date.parse(value.finishedAt)));
}
assert.deepEqual(ownerFixedBuild.pin, pin, 'owner fixed build versus final source/build');
assert.equal(ownerFixedTests.sourceDigest, pin.sourceDigest, 'owner fixed tests versus final source');
const ownerFixedCounts = counts('evidence/C02-compact-owner-fixed-tests.log', 43);

const record = {
  schemaVersion: 1, chapter: 'C02', status: 'repeated_session_compact_verified_partial_chapter', finishedAt: native.finishedAt,
  sourceAndBuild: pin, expectedPinEvidence: evidenceRef(expectedPinPath),
  scope: 'Persistent session compact lifecycle, source validation, accepted summary plus raw tail, CLI/Web synthetic flow, and current registered runtime suite on native Linux.',
  completion: { currentSourceBuildAndRegisteredSuiteVerified: true, chapterComplete: false, goalComplete: false,
    meaning: 'The current source/build and registered checks passed; this is not proof of every design requirement or deployed model quality.' },
  nativeLinux: { environment: native.environment, tests: nativeTests, targeted: nativeTargeted, build: 'passed', coreTypecheck: 'passed',
    architecture: { ...architecture, expectedFromCurrentCoreFiles: currentCoreFiles }, architectureCliCases: architectureCli.results,
    fixtures: { passed: true, scenarios: 4, checks: 22 }, collection: collected },
  macos: {
    node: 'v24.20.0', fullSuiteOnFinalSource: 'not_run',
    build1: { sourceAndBuild: build1Pin, manifest: evidenceRef(build1ManifestPath), buildLog: evidenceRef('evidence/C02-compact-build1.log'),
      targeted: build1Targeted, regression: build1Regression, outcome: 'targeted_failure_preserved' },
    build2: { sourceAndBuild: build2Pin, pinEvidence: evidenceRef(build2PinPath), buildLog: evidenceRef('evidence/C02-compact-build2.log'), presentation: build2Presentation },
    ownerFixed: { sourceAndBuild: ownerFixedBuild.pin, tests: ownerFixedCounts,
      buildEvidence: evidenceRef(ownerFixedBuildPath), testEvidence: evidenceRef(ownerFixedTestsPath) },
    browser: { ...evidenceRef(browserPath), sourceAndBuild: browser.sourceAndBuild, environment: browser.environment,
      observed: browser.observed, limitations: browser.limitations, cleanup: browser.cleanup, verifiedOnFinalSource: false,
      provenance: 'Observed on its preserved build2 pin, not rerun as final-source browser verification.' },
    measurement: { ...evidenceRef(measurementPath), sourceAndBuild: measurement.buildBefore, repeats: measurement.repeats,
      verifiedOnFinalSource: false, realModelInvoked: false, actualModelTokenizationMeasured: false, physicalDiskIoMeasured: false,
      provenance: 'One build2 synthetic observation; no general latency, token, disk-I/O, or real-model quality improvement claim.' },
  },
  priorAttempts: { localTargeted1: { ...build1Targeted, sourceAndBuild: build1Pin,
    observedFailures: ['three token_budget_exhausted failures in the then-unestimated local synthetic adapter', 'automatic compact acceptance assertion failed'],
    followup: 'Synthetic-only identity/estimation and stronger automatic-flow preconditions were added; final current-source tests are recorded separately.' }, native: priorNativeAttempts },
  ownerBoundaryRegression: { details: 'Read the separate baseline/fixed phase exit metadata and original logs; this finalizer does not reclassify their individual outcomes.',
    verifiedFixed: { sourceAndBuild: ownerFixedBuild.pin, tests: ownerFixedCounts, buildExitCode: ownerFixedBuild.exitCode, testExitCode: ownerFixedTests.exitCode },
    logs: ownerLogNames.map(name => evidenceRef(join('evidence', name))), metadata: ownerMetadata.map(name => evidenceRef(join('evidence', name))) },
  reuse: ['C01 agent ownership and stores', 'work event receipts and budget reservation/settlement', 'existing model call cancellation and recovery',
    'session transcript and head boundaries', 'ContextCompiler and recovery artifacts', 'CLI/Web session authorization and delivery surfaces'],
  implemented: ['durable accepted summary references with unchanged raw transcript', 'bounded repeated compact with source citations and protected retained items',
    'summary publication and adoption recovery with current-input validation', 'automatic compact before eligible work execution',
    'explicit CLI/Web compact with persistent request identity and separate status presentation', 'continued raw input and cancellation during compact'],
  limitations: ['actual model and API quality were not tested', 'the local rule fixture is not general semantic summarization',
    'the synthetic-only minimum input reservation does not validate a real model tokenizer or token estimate',
    'native Windows execution remains unverified/unsupported by the current host boundary',
    'browser and single measurement evidence belong to build2, not the final pin',
    'session summary/transcript storage remains SQLite even when work state uses file-journal',
    'power-loss durability, every filesystem and arbitrary same-UID host-code isolation are not established'],
  remaining: ['C02 remaining design acceptance items', 'C01 native Windows and host isolation', 'C03 memory/storage adapters',
    'C04 generic prompt/model contract and real-model quality evaluation', 'C06 interface refinement', 'remaining C03-C10 implementation'],
  externalModelCalls: false, internalServiceIntegration: false, productionDeployment: false, nativeWindowsTested: false,
  lint: 'not_configured', cleanup, cleanupEvidence: evidenceRef(cleanupPath),
  commands: native.steps.map(({ name, command, exitCode, signal }) => ({ name, command, exitCode, signal })),
  verifiedAssets: native.verifiedAssets, logHashes: collected.files, localLogHashes: localNames.map(name => evidenceRef(join('evidence', name))),
  finalizer: evidenceRef(join(directory, 'finalize-evidence.mjs')), nextPlan: 'design/chapters/C03-personal-memory-plan.md',
};
writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ status: record.status, output, sourceAndBuild: pin, nativeTests, nativeTargeted,
  architectureInspected: currentCoreFiles, priorAttempts: priorNativeAttempts.map(attempt => ({ label: attempt.label, status: attempt.status })),
  chapterComplete: false, goalComplete: false }));
