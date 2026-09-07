import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { verifyEvaluationBuild } from '../../dist/infrastructure/local-evaluation.js';

const directory = 'evidence/C01-journal-sync-linux-nas-20260907';
const final = directory + '/final';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const logJson = path => { const value = readFileSync(path, 'utf8'); return JSON.parse(value.slice(value.indexOf('{'))); };
function counts(path, expected) {
  const log = readFileSync(path, 'utf8'); const result = {};
  for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...log.matchAll(new RegExp('^# ' + name + ' (\\d+)$', 'gm'))];
    assert.equal(matches.length, 1, path + ':' + name); result[name] = Number(matches[0][1]);
  }
  assert.deepEqual(result, { tests: expected, pass: expected, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  return result;
}
const native = json(final + '/result.json');
assert.equal(native.status, 'passed'); assert.equal(native.environment.platform, 'linux');
assert.equal(native.steps.length, 7);
assert.ok(native.steps.every(step => step.status === 'passed' && step.exitCode === 0 && step.signal === null));
const pin = await verifyEvaluationBuild(process.cwd());
assert.deepEqual(pin, json('evidence/C01-journal-sync-build-pin.json')); assert.deepEqual(pin, native.buildPin);
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
const intermediate = json('evidence/C01-journal-directory-verification.json');
assert.equal(intermediate.status, 'root_work_scope_locally_verified_pending_combined_full');
const record = {
  schemaVersion: 1, chapter: 'C01', status: 'journal_directory_and_sync_scope_verified_partial_chapter',
  scope: 'journal_root_work_parent_references_directory_race_guards_and_common_sync_with_attempt_accounting',
  finishedAt: native.finishedAt, sourceAndBuild: pin, cleanup,
  nativeLinux: { environment: native.environment, tests: counts(final + '/all-tests.log', 2638),
    targeted: counts(final + '/sync-targeted.log', 166), coreTypecheck: 'passed', architecture,
    architectureCliCases: cli.results, fixtures: { scenarios: fixtures.scenarios, checks: fixtures.checkpoints, passed: fixtures.passed } },
  macos: { platform: 'darwin', node: 'v24.20.0', build: 'passed', targeted: counts('evidence/C01-journal-sync-targeted1.log', 166), fullSuiteOnThisSource: 'not_run' },
  intermediateRootWork: { evidence: 'evidence/C01-journal-directory-verification.json', sourceAndBuild: intermediate.sourceAndBuild,
    targeted: counts('evidence/C01-journal-directory-targeted1.log', 151), fullSuiteOnIntermediateSource: 'not_run' },
  newTests: { directoryReferencesAndRaces: 8, commonSyncObserver: 7, journalSync: 8, total: 23 },
  lint: 'not_configured', externalModelCalls: false, internalServiceIntegration: false, productionDeployment: false,
  commands: native.steps.map(({ name, command, exitCode }) => ({ name, command, exitCode })),
  verifiedAssets: native.verifiedAssets,
  logHashes: readdirSync(final).sort().map(file => ({ file, sha256: hash(final + '/' + file) })),
  localLogHashes: ['C01-journal-sync-build2.log', 'C01-journal-sync-targeted1.log'].map(file => ({ file, sha256: hash('evidence/' + file) })),
  implementation: ['host_issued_root_work_and_parent_directory_references', 'expected_reference_revalidation_before_map_updates',
    'no_recreation_of_disappeared_observed_work_directory', 'missing_newly_created_work_directory_explicit_failure',
    'empty_work_listing_revalidation', 'optional_synchronous_beforeSync_observer', 'same_directory_fsync_order_and_attempt_accounting',
    'parent_reference_capture_before_root_creation', 'original_IO_cause_and_post_publication_commit_unknown_preservation'],
  priorAttempts: [{ log: 'C01-journal-sync-build1.log', status: 'failed', reason: 'test_worker_argv_narrowing_in_function_declaration' }],
  limitations: ['path_recheck_not_native_directory_handle_pinning', 'additional_parent_and_opened_object_checks_not_an_IO_speedup',
    'some_race_timing_and_EIO_are_injected_in_isolated_test_workers', 'null_directory_inspection_uses_synthetic_ENOENT_cause',
    'raw_readdir_errors_not_unified', 'all_linux_filesystems_not_verified', 'power_loss_not_tested'],
  remaining: ['workspace_artifact_and_publication_boundary_connections', 'native_windows_implementation_and_execution',
    'manual_copy_duplicate_identity_execution_ownership', 'host_execution_write_boundary', 'C02_through_C10'],
};
writeFileSync('evidence/C01-journal-sync-verification.json', JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ status: record.status, sourceAndBuild: pin, linux: record.nativeLinux.tests, targeted: record.macos.targeted }));
