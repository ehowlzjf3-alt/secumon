import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { verifyEvaluationBuild } from '../../dist/infrastructure/local-evaluation.js';

const directory = 'evidence/C01-workspace-read-linux-nas-20260907';
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
assert.equal(native.environment.node, 'v24.20.0'); assert.equal(native.steps.length, 8);
assert.ok(native.steps.every(step => step.status === 'passed' && step.exitCode === 0 && step.signal === null));
const pin = await verifyEvaluationBuild(process.cwd());
assert.deepEqual(pin, json('evidence/C01-workspace-read-build-pin.json')); assert.deepEqual(pin, native.buildPin);
assert.equal(native.verifiedAssets.length, 14);
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
const paired = json(final + '/linux-paired-measurement.json');
assert.equal(paired.phase, 'compare'); assert.equal(paired.environment.platform, 'linux'); assert.equal(paired.environment.node, 'v24.20.0');
assert.equal(paired.reports.length, 16); assert.equal(paired.measuredCurrentDistSha256, hash('dist/infrastructure/file-workspaces.js'));
assert.equal(paired.workerSha256, hash('evidence/C01-workspace-read-io/measure-worker.mjs'));
const ioPairs = [];
for (const before of paired.reports.filter(row => row.variant === 'baseline')) {
  const after = paired.reports.find(row => row.variant === 'after' && row.operation === before.operation && row.fixture.fixtureName === before.fixture.fixtureName);
  assert.ok(after); assert.equal(before.fixtureSha256, after.fixtureSha256); assert.equal(before.resultSha256, after.resultSha256);
  assert.deepEqual(before.uniqueValidationInputSha256, after.uniqueValidationInputSha256);
  assert.equal(before.samples.length, 5); assert.equal(after.samples.length, 5);
  const factor = before.operation === 'list' ? 2 : 1;
  for (let i = 0; i < 5; i++) {
    assert.equal(before.samples[i].opens.record, after.samples[i].opens.record * factor);
    assert.equal(before.samples[i].deliveredBytesWithoutNestedDoubleCount, after.samples[i].deliveredBytesWithoutNestedDoubleCount * factor);
    assert.equal(before.samples[i].jsonParseCalls, after.samples[i].jsonParseCalls * factor);
  }
  ioPairs.push({ fixture: before.fixture.fixtureName, operation: before.operation,
    before: { opens: before.samples[0].opens.record, bytes: before.samples[0].deliveredBytesWithoutNestedDoubleCount, parses: before.samples[0].jsonParseCalls },
    after: { opens: after.samples[0].opens.record, bytes: after.samples[0].deliveredBytesWithoutNestedDoubleCount, parses: after.samples[0].jsonParseCalls },
    metadataBefore: before.samples[0].metadata, metadataAfter: after.samples[0].metadata });
}
assert.equal(ioPairs.length, 8);
const ioEvidence = { localBaseline: 'evidence/C01-workspace-read-io/baseline-measurement.json', localAfter: 'evidence/C01-workspace-read-io/after-measurement.json',
  nativePaired: final + '/linux-paired-measurement.json', pairs: ioPairs,
  meaning: 'warm_stable_fixture_public_calls_with_instrumentation_not_disk_device_IO_or_all_tool_latency',
  commonCompiledDependenciesMatched: json('evidence/C01-workspace-read-io/baseline-build-provenance.json').sharedCompiledDependenciesMatched,
  provenanceHashes: ['baseline-measurement.json', 'after-measurement.json', 'baseline-build-provenance.json', 'baseline-nas-build-manifest.json', 'baseline-manifest.json', 'baseline-dependencies.json', 'measure-worker.mjs', 'run-measurement.mjs'].map(file => ({ file, sha256: hash('evidence/C01-workspace-read-io/' + file) })) };
const record = {
  schemaVersion: 1, chapter: 'C01', status: 'workspace_stable_read_scope_verified_partial_chapter',
  scope: 'workspace_stable_record_reads_and_single_pass_list_validation',
  finishedAt: native.finishedAt, sourceAndBuild: pin, cleanup,
  nativeLinux: { environment: native.environment, tests: counts(final + '/all-tests.log', 2710),
    targeted: counts(final + '/workspace-targeted.log', 163), coreTypecheck: 'passed', architecture,
    architectureCliCases: cli.results, fixtures: { scenarios: fixtures.scenarios, checks: fixtures.checkpoints, passed: fixtures.passed } },
  macos: { platform: 'darwin', node: 'v24.20.0', build: 'passed', targeted: counts('evidence/C01-workspace-read-targeted1.log', 163), fullSuiteOnThisSource: 'not_run' },
  newTests: { stableReadingAndFaults: 19, recordValidationAndCompatibility: 22, total: 41 },
  lint: 'not_configured', externalModelCalls: false, internalServiceIntegration: false, productionDeployment: false,
  commands: native.steps.map(({ name, command, exitCode }) => ({ name, command, exitCode })),
  verifiedAssets: native.verifiedAssets,
  logHashes: readdirSync(final).sort().map(file => ({ file, sha256: hash(final + '/' + file) })),
  localLogHashes: ['C01-workspace-read-build1.log', 'C01-workspace-read-targeted1.log'].map(file => ({ file, sha256: hash('evidence/' + file) })),
  implementation: ['shared_single_stable_read_and_record_parse_for_read_and_list',
    'same_checksum_base64_length_hash_and_scope_validation', 'existing_hardlink_compatibility_retained_by_host_policy',
    'bounded_read_and_at_most_two_attempts_in_common_adapter', 'first_open_absence_distinguished_from_later_disappearance',
    'workspace_file_changed_preserves_boundary_cause', 'actual_record_read_IO_cause_preserved'],
  reuse: ['directory_lock_sync_and_interruption_preservation', 'v1_records_hash_paths_and_limits',
    'pending_list_rejection_and_single_file_read_scope', 'stage_idempotence_publication_manifest_removal_and_checkpoint_contracts'],
  io: ioEvidence,
  limitations: ['path_recheck_not_native_directory_handle_pinning', 'mkdir_to_first_inspection_and_check_to_rmdir_are_not_atomic',
    'directory_checks_add_IO_not_a_performance_claim', 'some_race_timing_and_EIO_are_injected_in_isolated_test_workers',
    'missing_directory_null_uses_synthetic_ENOENT', 'publication_and_directory_mutations_still_use_existing_raw_fs',
    'interrupted_lock_and_pending_files_are_preserved_not_automatically_recovered',
    'removeAttempt_multiple_unlinks_are_not_one_atomic_transaction', 'all_linux_filesystems_not_verified', 'power_loss_not_tested'],
  remaining: ['artifact_and_publication_boundary_connections',
    'native_windows_implementation_and_execution', 'manual_copy_duplicate_identity_execution_ownership',
    'host_execution_write_boundary', 'C02_through_C10'],
};
writeFileSync('evidence/C01-workspace-read-verification.json', JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ status: record.status, sourceAndBuild: pin, linux: record.nativeLinux.tests, targeted: record.macos.targeted }));
