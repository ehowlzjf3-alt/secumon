import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

const base = 'evidence/C03-documents-linux-nas-20260907';
const json = p => JSON.parse(readFileSync(p, 'utf8'));
const pin = json('evidence/C03-documents-build2-manifest.json');
const native = json(base + '/final/result.json');
const collection = json(base + '/final-collection.json');
const cleanup = json(base + '/cleanup.json');
const measurement = json('evidence/C03-documents-measurement1.json');
assert.equal(native.status, 'passed');
assert.equal(native.steps.length, 7);
assert(native.steps.every(step => step.status === 'passed' && step.exitCode === 0));
assert.deepEqual(native.buildPin, pin);
assert.deepEqual(collection.sourceAndBuild, pin);
assert.deepEqual(await verifyEvaluationBuild(process.cwd()), pin);
assert.equal(collection.files.length, 8);
for (const file of collection.files) assert.equal(createHash('sha256').update(readFileSync(base + '/final/' + file.file)).digest('hex'), file.sha256);
assert.equal(cleanup.ownedProcesses, 0);
assert.equal(cleanup.sshClosed, true);
assert.equal(cleanup.rootMode, '700');
assert.equal(cleanup.defaultNode, 'v18.20.4');
assert.equal(measurement.status, 'passed');
assert.deepEqual(measurement.buildBefore, pin);
assert.deepEqual(measurement.buildAfter, pin);
function tap(p, requirePass = true) {
  const text = readFileSync(p, 'utf8'), result = {};
  for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const rows = [...text.matchAll(new RegExp('^# ' + name + ' (\\d+)$', 'gm'))];
    assert.equal(rows.length, 1, p + ':' + name); result[name] = Number(rows[0][1]);
  }
  if (requirePass) { assert.equal(result.tests, result.pass); for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(result[key], 0); }
  return result;
}
const localTests = tap('evidence/C03-documents-target2.log');
const targeted = tap(base + '/final/documents-targeted.log');
const allTests = tap(base + '/final/all-tests.log');
assert.deepEqual(localTests, targeted);
const architecture = JSON.parse(readFileSync(base + '/final/architecture.log', 'utf8').trim().split('\n').at(-1));
assert.deepEqual(architecture.failures, []);
const files = [
  'evidence/C03-documents-build2.log', 'evidence/C03-documents-build2-manifest.json', 'evidence/C03-documents-target2.log',
  'evidence/C03-documents-core2.log', 'evidence/C03-documents-architecture1.log', 'evidence/C03-documents-typecheck1.log',
  'evidence/C03-documents-build1.log', 'evidence/C03-documents-build1-manifest.json', 'evidence/C03-documents-target1.log',
  'evidence/C03-documents-target1-files.json', 'evidence/C03-documents-measurement1.json',
  base + '/final-collection.json', base + '/cleanup.json', base + '/run-metadata.json', base + '/preflight.json',
  ...collection.files.map(file => base + '/final/' + file.file),
].map(path => ({ path: 'runtime/' + path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
const result = {
  schemaVersion: 1, chapter: 'C03', scope: 'D1_explicit_document_personal_memory_backend_existing_service_CLI_Web_context',
  status: 'verified_supported_local_posix_partial_chapter', recordedAt: new Date().toISOString(), chapterComplete: false, goalComplete: false,
  sourceAndBuild: pin,
  implementation: ['explicit_documents_setup_v2_immutable_assignment_and_completion', 'personal_markdown_canonical_work_sqlite_router',
    'owner_scope_hash_CAS_receipt_recovery_and_publication_witness', 'existing_memory_lifecycle_tools_CLI_Web_API_and_actual_context_frame'],
  local: { platform: 'darwin', arch: 'arm64', node: 'v24.20.0', build: 'passed', targeted: localTests,
    core: { status: 'passed', sourceScope: 'core2_before_infrastructure_only_pending_retry_fix_core_source_unchanged' },
    architecture: { ...architecture, sourceScope: 'architecture1_before_infrastructure_only_pending_retry_fix_inner_files_unchanged' }, fullTests: 'not_run' },
  nativeLinux: { status: 'passed', sessionId: 63469, startedAt: native.startedAt, finishedAt: native.finishedAt,
    environment: native.environment, tests: allTests, targeted, targetedFiles: native.targeted.fileCount,
    architecture, steps: native.steps.map(({ name, status, exitCode }) => ({ name, status, exitCode })),
    staticAssets: native.verifiedAssets, sourceAndBuild: native.buildPin, collectedFiles: collection.files.length, cleanup },
  browser: { status: 'not_run_this_unit', guideRender: 'file_url_policy_blocked_not_bypassed', productWeb: 'actual_local_HTTP_API_tests_passed_without_browser_render' },
  measurement: { status: measurement.status, evidence: 'runtime/evidence/C03-documents-measurement1.json', phases: measurement.phases.length,
    concurrentLocalTargetedRun: true, physicalDiskIO: false, fullSyscalls: false, actualModelTokenization: false,
    limits: 'single_fixture_port_and_common_metadata_counters_exclude_direct_adapter_opendir_lstat_mutation_SQL_and_artifact_IO_no_throughput_claim' },
  priorAttempts: [
    { evidence: 'runtime/evidence/C03-documents-typecheck1.log', status: 'failed', reason: 'nullable_assignment_narrowing_and_test_helper_config_union', fixed: true },
    { evidence: 'runtime/evidence/C03-documents-target1.log', sourceAndBuild: json('evidence/C03-documents-build1-manifest.json'),
      tests: tap('evidence/C03-documents-target1.log', false), reason: 'actual_four_process_first_open_saw_disappearing_root_pending_file',
      fix: 'bounded_same_root_pending_only_reobservation_with_canonical_owner_format_errors_preserved', deterministicRegressionAdded: true },
  ],
  limitations: ['D2_draft_apply_and_D3_migration_not_implemented', 'postgres_adapter_not_implemented', 'native_windows_runtime_not_connected_or_executed',
    'same_os_identity_consistent_rollback_of_events_and_witnesses_requires_external_trust', 'POSIX_path_rechecks_not_descriptor_rooted_host_isolation',
    'SIGKILL_and_injected_EIO_are_not_power_loss_or_network_filesystem_tests', 'bounded_append_history_no_physical_forget_or_compaction',
    'document_read_amplification_observed_C05_followup', 'no_real_model_API_Knox_internal_service_or_production_test'],
  next: 'design/chapters/C03-document-draft-plan.md', files,
};
writeFileSync('evidence/C03-documents-verification.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: result.status, localTests, nativeTests: allTests, targeted, sourceAndBuild: pin }));
