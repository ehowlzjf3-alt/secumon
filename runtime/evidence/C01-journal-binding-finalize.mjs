import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

const directory = 'evidence/C01-journal-binding-linux-nas-20260907/final';
const record = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
assert.equal(record.status, 'passed'); assert.equal(record.environment.platform, 'linux');
for (const name of ['build', 'binding-targeted', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures']) {
  const step = record.steps.find(item => item.name === name);
  assert.equal(step?.status, 'passed'); assert.equal(step.exitCode, 0); assert.equal(step.signal, null);
}
function totals(path, expected) {
  const log = readFileSync(path, 'utf8'); const values = {};
  for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...log.matchAll(new RegExp('^# ' + name + ' (\\d+)$', 'gm'))];
    assert.ok(matches.length); values[name] = Number(matches.at(-1)[1]);
  }
  assert.equal(values.tests, expected); assert.equal(values.pass, values.tests);
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(values[key], 0);
  return values;
}
const tests = totals(join(directory, 'all-tests.log'), 2580);
const targeted = totals(join(directory, 'binding-targeted.log'), 192);
const local = totals('evidence/C01-journal-binding-targeted2.log', 192);
function output(file) { const log = readFileSync(join(directory, file), 'utf8'); return JSON.parse(log.slice(log.indexOf('{'))); }
const architecture = output('architecture.log'); assert.equal(architecture.inspected, 125); assert.deepEqual(architecture.failures, []);
const fixtures = output('fixtures.log'); assert.equal(fixtures.passed, true); assert.equal(fixtures.scenarios, 4); assert.equal(fixtures.checkpoints, 22); assert.equal(fixtures.actualModelCalls, 0);
const architectureCases = output('architecture-cli-fixtures.log'); assert.equal(architectureCases.platform, 'linux');
assert.deepEqual(architectureCases.results.map(item => [item.name, item.exitCode]), [
  ['valid', 0], ['domain-external-import', 1], ['application-outer-import', 1], ['empty-core', 1],
]);
const currentBuild = await verifyEvaluationBuild(process.cwd());
assert.deepEqual(currentBuild, record.buildPin);
assert.deepEqual(currentBuild, JSON.parse(readFileSync('evidence/C01-journal-binding-build-pin.json', 'utf8')));
for (const asset of record.verifiedAssets) assert.equal(createHash('sha256').update(readFileSync(asset.path)).digest('hex'), asset.sha256);
const hashes = readdirSync(directory).filter(file => file.endsWith('.log') || file === 'result.json').sort()
  .map(file => ({ file, sha256: createHash('sha256').update(readFileSync(join(directory, file))).digest('hex') }));
const result = { schemaVersion: 1, chapter: 'C01', status: 'journal_binding_scope_verified_partial_chapter',
  scope: 'owned_file_journal_immutable_backend_selection_and_existing_runtime_contracts', finishedAt: record.finishedAt,
  sourceAndBuild: currentBuild, nativeLinux: { environment: record.environment, tests, targeted, architecture,
    architectureCliCases: architectureCases.results, fixtures: { scenarios: fixtures.scenarios, checks: fixtures.checkpoints, passed: true }, coreTypecheck: 'passed' },
  macos: { platform: process.platform, node: process.version, targeted: local, fullSuiteOnThisSource: 'not_run' },
  newTests: 57, actualProcessTerminationCases: { automaticResume: 10, preservationAndRefusal: 2, total: 12 }, lint: 'not_configured',
  commands: record.steps.map(step => ({ name: step.name, command: step.command, exitCode: step.exitCode })),
  verifiedAssets: record.verifiedAssets, logHashes: hashes,
  implementation: ['v2_owner_in_atomic_journal_header', 'standalone_v1_compatibility_without_automatic_adoption',
    'immutable_agent_state_backend_assignment', 'file_journal_state_with_sqlite_memory_and_channel',
    'foreign_owner_and_config_only_backend_switch_refusal', 'fresh_cloned_file_journal_and_private_stores',
    'sqlite_owner_snapshot_and_same_process_lock_preservation', 'bounded_owned_sqlite_wal_mode_initialization',
    'process_interruption_resume_or_preservation_with_explicit_error'],
  priorAttempts: [
    { log: 'C01-journal-binding-build1.log', status: 'failed', reason: 'owner_narrowing_and_test_worker_type_errors' },
    { log: 'C01-journal-binding-targeted1.log', status: 'failed', tests: 139, pass: 137, fail: 2,
      reasons: ['copy_fixture_directory_permission', 'reproduced_concurrent_sqlite_wal_transition_busy'] },
    { log: 'C01-journal-binding-build3.log', status: 'failed', reason: 'test_worker_statement_get_overload' },
  ],
  notClaimed: ['C01_complete', 'native_windows_verified', 'all_linux_filesystems_verified', 'power_loss_durability',
    'whole_same_OS_user_sandbox', 'manual_folder_copy_duplicate_identity_runtime_detection',
    'read_only_sqlite_never_creates_coordination_sidecars', 'automatic_recovery_when_owner_cannot_be_read',
    'first_setup_cli_backend_selection', 'backend_data_migration', 'cross_work_session_implemented',
    'real_model_quality', 'internal_MCP_or_Knox_integration', 'global_installation_or_production_ready'],
  next: 'Windows file boundary extraction; C03/C10 owned recovery and migration; C06 first-setup selection. Keep C01-C10 goal active.' };
assert.equal(process.platform, 'darwin');
writeFileSync('evidence/C01-journal-binding-verification.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ status: result.status, tests, targeted, local, sourceAndBuild: currentBuild, finishedAt: result.finishedAt }));
