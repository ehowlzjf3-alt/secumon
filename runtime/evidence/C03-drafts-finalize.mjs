import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';
const base = 'evidence/C03-drafts-linux-nas-20260907';
const json = p => JSON.parse(readFileSync(p, 'utf8'));
const [buildAttempt, targetAttempt] = process.argv.slice(2);
assert.match(buildAttempt ?? '', /^[1-9]$/); assert.match(targetAttempt ?? '', /^[1-9]$/);
const pin = json(`evidence/C03-drafts-build${buildAttempt}-manifest.json`), native = json(base + '/final/result.json');
const metadata = json(base + '/run-metadata.json');
const initializationDiagnosis = json('evidence/C03-drafts-initialization-diagnosis.json');
const mcpDiagnosis = json('evidence/C03-drafts-mcp-diagnosis.json');
const documentConcurrencyDiagnosis = json('evidence/C03-drafts-native-attempt3-diagnosis.json');
assert.equal(documentConcurrencyDiagnosis.status, 'verified_matching_routes_original_cause_not_exclusive');
assert.equal(typeof documentConcurrencyDiagnosis.summary, 'string');
assert.deepEqual(documentConcurrencyDiagnosis.correctedSourceAndBuild, pin);
assert(['resolved', 'bounded_limitation'].includes(mcpDiagnosis.status));
assert.deepEqual(mcpDiagnosis.sourceAndBuild, json("evidence/C03-drafts-build3-manifest.json"));
assert.deepEqual(mcpDiagnosis.nextVerification.sourceAndBuild, pin);
assert.equal(mcpDiagnosis.nextVerification.status, 'passed');
assert.equal(mcpDiagnosis.nextVerification.sessionId, metadata.sessionId);
assert(['resolved', 'bounded_limitation'].includes(initializationDiagnosis.status));
assert.deepEqual(initializationDiagnosis.sourceAndBuild, json("evidence/C03-drafts-build3-manifest.json"));
assert(Number.isSafeInteger(metadata.sessionId));
const collection = json(base + '/final-collection.json'), cleanup = json(base + '/cleanup.json');
assert.equal(native.status, 'passed'); assert.equal(native.steps.length, 7);
assert(native.steps.every(step => step.status === 'passed' && step.exitCode === 0));
assert.deepEqual(native.buildPin, pin); assert.deepEqual(collection.sourceAndBuild, pin);
assert.deepEqual(await verifyEvaluationBuild(process.cwd()), pin);
assert.deepEqual(json(`evidence/C03-drafts-target${targetAttempt}-result.json`).sourceAndBuild, pin);
assert.equal(json(`evidence/C03-drafts-target${targetAttempt}-result.json`).code, 0);
assert.equal(collection.files.length, 8);
for (const file of collection.files) assert.equal(createHash('sha256').update(readFileSync(base + '/final/' + file.file)).digest('hex'), file.sha256);
assert.equal(cleanup.ownedProcesses, 0); assert.equal(cleanup.sshClosed, true); assert.equal(cleanup.rootMode, '700'); assert.equal(cleanup.defaultNode, 'v18.20.4');
function tap(path, requirePass = true) {
  const text = readFileSync(path, 'utf8'), result = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...text.matchAll(new RegExp('^# ' + key + ' (\\d+)$', 'gm'))]; assert.equal(matches.length, 1); result[key] = Number(matches[0][1]);
  }
  if (requirePass) { assert.equal(result.tests, result.pass); for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(result[key], 0); }
  return result;
}
const localTests = tap(`evidence/C03-drafts-target${targetAttempt}.log`), targeted = tap(base + '/final/drafts-targeted.log'), tests = tap(base + '/final/all-tests.log');
assert.deepEqual(localTests, targeted);
const architecture = JSON.parse(readFileSync(base + '/final/architecture.log', 'utf8').trim().split('\n').at(-1)); assert.deepEqual(architecture.failures, []);
const paths = ['evidence/C03-drafts-core1.log', 'evidence/C03-drafts-architecture1.log',
  base + '/final-collection.json', base + '/cleanup.json', base + '/preflight.json', base + '/run-metadata.json',
  ...collection.files.map(file => base + '/final/' + file.file)];
for (let n = 1; n <= Number(buildAttempt); n++) for (const suffix of ['.log', '-manifest.json']) {
  const path = `evidence/C03-drafts-build${n}${suffix}`; if (existsSync(path)) paths.push(path);
}
const earlierLocalTargets = [];
for (let n = 1; n <= Number(targetAttempt); n++) {
  for (const suffix of ['.log', '-files.json', '-before.json', '-result.json']) paths.push(`evidence/C03-drafts-target${n}${suffix}`);
  if (n < Number(targetAttempt)) earlierLocalTargets.push({ attempt: n, sourceAndBuild: json(`evidence/C03-drafts-target${n}-before.json`), tests: tap(`evidence/C03-drafts-target${n}.log`, false) });
}
paths.push('evidence/C03-drafts-initialization-diagnosis.json', ...initializationDiagnosis.evidence.map(path => path.replace(/^runtime\//, '')),
  'evidence/C03-drafts-mcp-diagnosis.json', ...mcpDiagnosis.evidence.map(path => path.replace(/^runtime\//, '')));
paths.push('evidence/C03-drafts-native-attempt3-diagnosis.json', ...documentConcurrencyDiagnosis.evidence.map(path => path.replace(/^runtime\//, '')));
const earlierNativeAttempts = [];
for (let n = 1; n < metadata.attempt; n++) {
  const previous = json(`${base}/attempt-${n}/result.json`), collected = json(`${base}/attempt-${n}-collection.json`);
  earlierNativeAttempts.push({ attempt: n, status: previous.status, sourceAndBuild: previous.buildPin, finishedAt: previous.finishedAt,
    targeted: tap(`${base}/attempt-${n}/drafts-targeted.log`, false), fullTestsRun: previous.steps.some(step => step.name === 'all-tests'),
    fullTests: existsSync(`${base}/attempt-${n}/all-tests.log`) ? tap(`${base}/attempt-${n}/all-tests.log`, false) : null,
    intervention: existsSync(`${base}/test-intervention-attempt${n}.json`) ? json(`${base}/test-intervention-attempt${n}.json`) : null });
  paths.push(`${base}/attempt-${n}-collection.json`, ...collected.files.map(file => `${base}/attempt-${n}/${file.file}`));
}
const result = { schemaVersion: 1, chapter: 'C03', scope: 'D2_document_draft_explicit_apply_source_and_memory_receipt_recovery',
  status: 'verified_supported_local_posix_partial_chapter', recordedAt: new Date().toISOString(), chapterComplete: false, goalComplete: false,
  sourceAndBuild: pin,
  implementation: ['editable_draft_origin_and_immutable_apply_intent_outside_memory_canonical_store',
    'existing_source_input_and_personal_revision_with_exact_original_command_receipt', 'inputOnly_preserves_other_pending_intakes',
    'CLI_and_Web_management_panel_fixed_apply_identity_derived_status_and_resume', 'existing_selected_context_currentness_and_source_history_preserved'],
  local: { platform: 'darwin', arch: 'arm64', node: 'v24.20.0', build: 'passed', targeted: localTests, core: 'passed', architecture,
    fullTests: 'not_run', coreArchitectureSourceScope: 'before_infrastructure_narrowing_and_presentation_contention_retry_same_inner_source' },
  nativeLinux: { status: 'passed', sessionId: metadata.sessionId, attempt: metadata.attempt, startedAt: native.startedAt, finishedAt: native.finishedAt,
    environment: native.environment, tests, targeted, targetedFiles: native.targeted.fileCount, architecture,
    steps: native.steps.map(({ name, status, exitCode }) => ({ name, status, exitCode })), staticAssets: native.verifiedAssets,
    sourceAndBuild: native.buildPin, collectedFiles: collection.files.length, cleanup, executionLimits: native.executionLimits, mcpTrace: native.mcpTrace,
    stepProcessResults: native.steps.map(({name, timedOut, terminationReason, finalGroupState, groupAbsentConfirmed, leaderExit, stdioClose}) => ({name, timedOut, terminationReason, finalGroupState, groupAbsentConfirmed, leaderExit, stdioClose})) },
  browser: { status: 'not_run_this_unit', productWeb: 'actual_HTTP_API_and_static_UI_contract_tests_passed_browser_render_not_run',
    guideRender: 'file_url_policy_blocked_not_bypassed' },
  recovery: { realProcessKill: { flow: 6, filePublication: 2 }, realConcurrentProcesses: true,
    injectedFailuresAlsoUsed: true, powerLossTested: false },
  priorAttempts: [{ evidence: 'runtime/evidence/C03-drafts-build1.log', status: 'typecheck_failed',
    reason: 'possibly_undefined_draft_buffer_after_indirect_never_function', fixed: 'explicit_return_preserves_missing_error_and_narrows_buffer' }],
  earlierLocalTargets, earlierNativeAttempts, initializationDiagnosis, mcpDiagnosis, documentConcurrencyDiagnosis,
  sourceContentionFix: { retry: 'exact_knowledge_contention_max_three_attempts_same_intent_and_IDs',
    evidence: 'two_actual_history_snapshot_interleavings_and_receipt_after_commit_bounded_persistent_contention',
    broad_storage_and_permission_failuresRetried: false },
  preExecutionReviewFixes: ['strict_resume_test_arguments', 'missing_test_engine_directory',
    'bounded_exact_request_reobservation_when_another_caller_completes_after_absent_operation_snapshot'],
  limitations: ['no_real_model_API_Knox_internal_service_or_production_test', 'native_Windows_not_connected_or_executed',
    'no_browser_render_this_unit', 'no_general_editor_automatic_file_watch_or_bulk_import', 'SQLite_remains_default_draft_UI_requires_documents',
    'no_data_migration_or_PostgreSQL_in_this_unit', 'no_atomic_transaction_across_session_and_memory_stores',
    'same_OS_identity_and_POSIX_path_recheck_limits_remain', 'physical_delete_power_loss_shared_filesystem_and_large_history_cleanup_not_verified',
    'draft_and_intent_retention_and_repeated_scans_need_C05_C10_followup',
    'intermittent_macOS_initialization_and_native_MCP_stall_causes_remain_unresolved',
    'full_native_MCP_trace_is_observational_and_may_change_timing'],
  next: 'design/chapters/C03-personal-memory-migration-plan.md',
  files: [...new Set(paths)].map(path => ({ path: 'runtime/' + path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })),
};
writeFileSync('evidence/C03-drafts-verification.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: result.status, localTests, nativeTests: tests, targeted, sourceAndBuild: pin }));
