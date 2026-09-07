import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { verifyEvaluationBuild } from '../../dist/infrastructure/local-evaluation.js';

const directory = 'evidence/C01-metadata-boundary-linux-nas-20260907';
const final = directory + '/final';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const logJson = path => { const value = readFileSync(path, 'utf8'); return JSON.parse(value.slice(value.indexOf('{'))); };
function counts(path, expected) {
  const log = readFileSync(path, 'utf8'); const result = {};
  for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...log.matchAll(new RegExp('^# ' + name + ' (\\d+)$', 'gm'))];
    assert.equal(matches.length, 1, path + ':' + name);
    result[name] = Number(matches[0][1]);
  }
  assert.deepEqual(result, { tests: expected, pass: expected, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  return result;
}
const native = json(final + '/result.json');
assert.equal(native.status, 'passed');
assert.equal(native.environment.platform, 'linux');
assert.equal(native.steps.length, 7);
assert.ok(native.steps.every(step => step.status === 'passed' && step.exitCode === 0 && step.signal === null));
const pin = await verifyEvaluationBuild(process.cwd());
assert.deepEqual(pin, json('evidence/C01-metadata-boundary-build-pin.json'));
assert.deepEqual(pin, native.buildPin);
assert.equal(native.verifiedAssets.length, 7);
for (const asset of native.verifiedAssets) assert.equal(hash(asset.path), asset.sha256, asset.path);
const architecture = logJson(final + '/architecture.log');
assert.equal(architecture.inspected, 125); assert.deepEqual(architecture.failures, []);
const cli = json(final + '/architecture-cli-fixtures.log');
assert.equal(cli.results.length, 4); assert.deepEqual(cli.results.map(row => row.exitCode), [0, 1, 1, 1]);
const fixtures = logJson(final + '/fixtures.log');
assert.equal(fixtures.passed, true); assert.equal(fixtures.scenarios, 4); assert.equal(fixtures.checkpoints, 22);
const cleanup = json(directory + '/cleanup.json');
assert.equal(cleanup.ownedProcesses, 0); assert.equal(cleanup.sshClosed, true); assert.equal(cleanup.rootMode, '700');
const record = {
  schemaVersion: 1, chapter: 'C01', status: 'metadata_boundary_scope_verified_partial_chapter',
  scope: 'common_posix_profile_and_journal_metadata_boundary_with_concurrent_profile_observation_fix',
  finishedAt: native.finishedAt, sourceAndBuild: pin, cleanup,
  nativeLinux: { environment: native.environment, tests: counts(final + '/all-tests.log', 2615),
    targeted: counts(final + '/metadata-targeted.log', 227), coreTypecheck: 'passed', architecture,
    architectureCliCases: cli.results, fixtures: { scenarios: fixtures.scenarios, checks: fixtures.checkpoints, passed: fixtures.passed } },
  macos: { platform: 'darwin', node: 'v24.20.0', targeted: counts('evidence/C01-metadata-boundary-targeted3.log', 227),
    buildArtifactsVerified: true, buildWrapperExit: 1,
    buildWrapperNote: 'Build completed before zsh rejected a readonly status variable. Build log and verifyEvaluationBuild confirmed artifacts; native Linux build independently exited zero.',
    fullSuiteOnThisSource: 'not_run' },
  newTests: { commonBoundary: 26, profileWrappers: 5, profileConcurrency: 4, total: 35 },
  lint: 'not_configured', externalModelCalls: false, internalServiceIntegration: false, productionDeployment: false,
  commands: native.steps.map(({ name, command, exitCode }) => ({ name, command, exitCode })),
  verifiedAssets: native.verifiedAssets,
  logHashes: readdirSync(final).sort().map(file => ({ file, sha256: hash(final + '/' + file) })),
  localLogHashes: ['C01-metadata-boundary-build4.log', 'C01-metadata-boundary-targeted3.log'].map(file => ({ file, sha256: hash('evidence/' + file) })),
  implementation: ['host_owned_directory_references', 'bounded_stable_posix_metadata_reads', 'storage_specific_link_policies',
    'platform_dispatch_before_profile_and_journal_creation', 'separate_actual_boundary_diagnostics',
    'one_reobservation_of_concurrently_published_profile_ownership', 'profile_open_and_later_read_error_preservation'],
  priorAttempts: [
    { log: 'C01-metadata-boundary-build1.log', status: 'failed', reason: 'readonly_lstatSync_test_worker_typing' },
    { log: 'C01-metadata-boundary-targeted1.log', status: 'failed', tests: 218, pass: 217, fail: 1, reason: 'concurrent_CLI_initialization_AggregateError_original_cause_not_established' },
    { log: 'C01-metadata-boundary-targeted2.log', status: 'passed_on_intermediate_source', tests: 221, pass: 221 },
    { log: 'C01-metadata-boundary-init-race-diagnostic.log', status: 'deterministic_race_reproduced_before_fix', sameCauseAsFirstFailure: 'not_established' },
  ],
  limitations: ['path_recheck_not_native_directory_handle_pinning', 'additional_parent_checks_not_an_IO_speedup',
    'platform_dispatch_and_foreign_uid_tests_use_emulation', 'all_linux_filesystems_not_verified', 'power_loss_not_tested'],
  remaining: ['journal_root_work_directory_reference_connection', 'workspace_artifact_and_publication_boundary_connections',
    'native_windows_implementation_and_execution', 'manual_copy_duplicate_identity_execution_ownership',
    'host_execution_write_boundary', 'C02_through_C10'],
  nextPlan: 'design/chapters/C01-journal-directory-boundary-plan.md',
};
writeFileSync('evidence/C01-metadata-boundary-verification.json', JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ status: record.status, sourceAndBuild: pin, linux: record.nativeLinux.tests, targeted: record.macos.targeted }));
