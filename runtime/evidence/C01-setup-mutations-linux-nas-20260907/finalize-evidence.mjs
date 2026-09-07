import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { verifyEvaluationBuild } from '../../dist/infrastructure/local-evaluation.js';

const directory = 'evidence/C01-setup-mutations-linux-nas-20260907';
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
assert.deepEqual(pin, json('evidence/C01-setup-mutations-build-pin.json')); assert.deepEqual(pin, native.buildPin);
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
 schemaVersion:1, chapter:'C01', status:'posix_setup_mutation_lifecycle_verified_partial_chapter',
 scope:'profile_setup_clone_and_state_profile_scoped_creation_publication_and_resume',
 finishedAt:native.finishedAt, sourceAndBuild:pin, cleanup,
 nativeLinux:{environment:native.environment,tests:counts(final+'/all-tests.log',2737),targeted:counts(final+'/setup-targeted.log',133),
 coreTypecheck:'passed',architecture,architectureCliCases:cli.results,fixtures:{scenarios:fixtures.scenarios,checks:fixtures.checkpoints,passed:fixtures.passed}},
 macos:{platform:'darwin',node:'v24.20.0',build:'passed',targeted:counts('evidence/C01-setup-mutations-targeted2.log',133),fullSuiteOnThisSource:'not_run'},
 newTests:{commonMutationLifecycle:13,setupIntegrationIncludingProcessKills:14,actualProcessKills:3,total:27},
 priorAttempt:{targeted:'evidence/C01-setup-mutations-targeted1.log',buildPin:'evidence/C01-setup-mutations-build1-pin.json',pass:130,fail:3,
 reason:'sync error observer compared wrapper directly instead of verifying preserved original EIO cause; observer corrected, product source unchanged after build1'},
 lint:'not_configured',externalModelCalls:false,internalServiceIntegration:false,productionDeployment:false,
 commands:native.steps.map(({name,command,exitCode})=>({name,command,exitCode})),verifiedAssets:native.verifiedAssets,
 logHashes:readdirSync(final).sort().map(file=>({file,sha256:hash(final+'/'+file)})),
 localLogHashes:['C01-setup-mutations-build1.log','C01-setup-mutations-targeted1.log','C01-setup-mutations-build2.log','C01-setup-mutations-targeted2.log'].map(file=>({file,sha256:hash('evidence/'+file)})),
 implementation:['explicit_host_owned_mutation_scope_and_directory_reference_lifetime','root_parent_and_ancestor_checks_before_mutation','canonical_engine_overlap_refusal',
 'private_creation_without_adopting_existing_permissions','parent_sync_after_creation_and_existing_directory_reconciliation','no_overwrite_candidate_publication',
 'candidate_identity_based_cleanup_and_independent_parent_sync','publication_creation_and_cleanup_uncertainty_with_all_original_causes',
 'profile_initialize_clone_and_backend_pin_use_explicit_scopes','ready_reopen_reconciles_parent_and_metadata_namespace_barriers'],
 reuse:['profile_schemas_IDs_operation_marker_and_repair_rules','clone_manifest_source_checks_limits_and_fresh_identity','SQLite_and_file_journal_state_ports',
 'common_metadata_reads_and_sync','workspace_read_lock_sync_and_checkpoint_contracts','journal_owner_receipts_and_recovery'],
 processInterruptionContract:{stages:['identity_candidate_file_synced','config_published','setup_receipt_published'],actualSignal:'SIGKILL',
 outcome:'reopen_existing_operation_and_identity_then_finish_setup_without_replacing_originals',automaticOrphanDeletion:false},
 limitations:['posix_path_recheck_not_native_handle_relative_atomicity','same_OS_account_arbitrary_shell_not_sandboxed','post_publish_content_checks_and_directory_sync_add_IO',
 'some_EIO_and_races_injected_in_isolated_workers','all_linux_filesystems_not_verified','power_loss_not_tested','native_windows_addon_not_dispatched_or_run_on_Windows'],
 remaining:['C02_through_C10','native_windows_setup_execution_and_store_connections','workspace_journal_artifact_mutation_connections_for_Windows',
 'SQLite_owner_sidecar_lifetime_on_Windows','manual_copy_duplicate_identity_execution_ownership','engine_install_permissions_and_tool_write_boundary'],
 nextPlan:'design/chapters/C02-persistent-session-plan.md'
};
writeFileSync('evidence/C01-setup-mutations-verification.json',JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify({status:record.status,sourceAndBuild:pin,linux:record.nativeLinux.tests,targeted:record.macos.targeted}));
