import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { verifyEvaluationBuild } from '../../dist/infrastructure/local-evaluation.js';

const directory = 'evidence/C01-workspace-boundary-linux-nas-20260907';
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
assert.equal(native.environment.node, 'v24.20.0'); assert.equal(native.steps.length, 7);
assert.ok(native.steps.every(step => step.status === 'passed' && step.exitCode === 0 && step.signal === null));
const pin = await verifyEvaluationBuild(process.cwd());
assert.deepEqual(pin, json('evidence/C01-workspace-boundary-build-pin.json')); assert.deepEqual(pin, native.buildPin);
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
assert.equal(cleanup.defaultNode, 'v18.20.4');
const record = {
  schemaVersion: 1, chapter: 'C01', status: 'workspace_directory_lock_and_sync_scope_verified_partial_chapter',
  scope: 'workspace_root_work_attempt_files_parent_references_transient_lock_cleanup_and_directory_sync',
  finishedAt: native.finishedAt, sourceAndBuild: pin, cleanup,
  nativeLinux: { environment: native.environment, tests: counts(final + '/all-tests.log', 2669),
    targeted: counts(final + '/workspace-targeted.log', 122), coreTypecheck: 'passed', architecture,
    architectureCliCases: cli.results, fixtures: { scenarios: fixtures.scenarios, checks: fixtures.checkpoints, passed: fixtures.passed } },
  macos: { platform: 'darwin', node: 'v24.20.0', build: 'passed', targeted: counts('evidence/C01-workspace-boundary-targeted1.log', 122), fullSuiteOnThisSource: 'not_run' },
  newTests: { directoryReferencesAndLocks: 17, syncAndCleanup: 11, actualProcessInterruptions: 3, total: 31 },
  lint: 'not_configured', externalModelCalls: false, internalServiceIntegration: false, productionDeployment: false,
  commands: native.steps.map(({ name, command, exitCode }) => ({ name, command, exitCode })),
  verifiedAssets: native.verifiedAssets,
  logHashes: readdirSync(final).sort().map(file => ({ file, sha256: hash(final + '/' + file) })),
  localLogHashes: ['C01-workspace-boundary-build1.log', 'C01-workspace-boundary-targeted1.log'].map(file => ({ file, sha256: hash('evidence/' + file) })),
  implementation: ['host_issued_workspace_directory_references', 'parent_sync_reference_captured_before_root_creation',
    'no_recreation_of_disappeared_observed_directories', 'transient_per_invocation_lock_reference',
    'ancestor_and_lock_validation_before_action_and_release', 'lost_or_replaced_lock_prevents_success',
    'ordered_common_sync_and_final_directory_validation', 'single_original_error_or_double_failure_cause_and_cleanupError',
    'later_owner_lock_preserved_after_unlock', 'unsupported_platform_rejected_before_creation', 'references_cleared_on_close'],
  reuse: ['workspace_v1_record_format_checksums_and_hash_paths', 'existing_file_stage_publication_and_idempotence',
    'manifest_compare_before_removal', 'checkpoint_restore_tenant_labels_and_lifecycle_contracts'],
  processInterruptionContract: { stages: ['lock_created', 'candidate_file_synced', 'final_hardlink_published'],
    actualSignal: 'SIGKILL', outcome: 'preserve_original_files_and_lock_then_refuse_with_workspace_busy', automaticLockRecovery: false },
  limitations: ['path_recheck_not_native_directory_handle_pinning', 'mkdir_to_first_inspection_and_check_to_rmdir_are_not_atomic',
    'directory_checks_add_IO_not_a_performance_claim', 'some_race_timing_and_EIO_are_injected_in_isolated_test_workers',
    'missing_directory_null_uses_synthetic_ENOENT', 'file_read_and_publication_calls_still_use_existing_raw_fs',
    'interrupted_lock_and_pending_files_are_preserved_not_automatically_recovered',
    'removeAttempt_multiple_unlinks_are_not_one_atomic_transaction', 'all_linux_filesystems_not_verified', 'power_loss_not_tested'],
  remaining: ['workspace_stable_reads_and_duplicate_list_IO', 'artifact_and_publication_boundary_connections',
    'native_windows_implementation_and_execution', 'manual_copy_duplicate_identity_execution_ownership',
    'host_execution_write_boundary', 'C02_through_C10'],
};
writeFileSync('evidence/C01-workspace-boundary-verification.json', JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ status: record.status, sourceAndBuild: pin, linux: record.nativeLinux.tests, targeted: record.macos.targeted }));
