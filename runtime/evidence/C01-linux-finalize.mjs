import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

const directory = 'evidence/C01-linux-nas-20260906/final';
const record = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
assert.equal(record.status, 'passed'); assert.equal(record.environment.platform, 'linux');
for (const name of ['build', 'portability-targeted', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures']) {
  const step = record.steps.find(item => item.name === name); assert.equal(step?.status, 'passed'); assert.equal(step.exitCode, 0); assert.equal(step.signal, null);
}
function totals(file) {
  const log = readFileSync(join(directory, file), 'utf8'); const values = {};
  for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...log.matchAll(new RegExp('^# ' + name + ' (\\d+)$', 'gm'))];
    assert.ok(matches.length); values[name] = Number(matches.at(-1)[1]);
  }
  assert.equal(values.pass, values.tests); for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(values[key], 0);
  return values;
}
const tests = totals('all-tests.log'); assert.equal(tests.tests, 2491);
const targeted = totals('portability-targeted.log'); assert.equal(targeted.tests, 106);
function jsonOutput(file) { const log = readFileSync(join(directory, file), 'utf8'); return JSON.parse(log.slice(log.indexOf('{'))); }
const architecture = jsonOutput('architecture.log'); assert.ok(architecture.inspected > 0); assert.deepEqual(architecture.failures, []);
const fixtures = jsonOutput('fixtures.log'); assert.equal(fixtures.passed, true); assert.equal(fixtures.scenarios, 4); assert.equal(fixtures.checkpoints, 22); assert.equal(fixtures.actualModelCalls, 0);
const architectureCases = jsonOutput('architecture-cli-fixtures.log'); assert.equal(architectureCases.platform, 'linux'); assert.equal(architectureCases.results.length, 4);
const currentBuild = await verifyEvaluationBuild(process.cwd()); assert.deepEqual(currentBuild, record.buildPin);
for (const asset of record.verifiedAssets) assert.equal(createHash('sha256').update(readFileSync(asset.path)).digest('hex'), asset.sha256);
const hashes = readdirSync(directory).filter(file => file.endsWith('.log') || file === 'result.json').sort().map(file => ({ file, sha256: createHash('sha256').update(readFileSync(join(directory, file))).digest('hex') }));
const result = { schemaVersion: 1, chapter: 'C01', status: 'native_linux_scope_verified_partial_chapter',
  scope: 'filesystem_path_portability_and_full_runtime_contract_verification', finishedAt: record.finishedAt,
  environment: record.environment, sourceAndBuild: currentBuild, tests, targeted, architecture,
  architectureCliCases: architectureCases.results, fixtures: { scenarios: fixtures.scenarios, checks: fixtures.checkpoints, passed: true },
  coreTypecheck: 'passed', lint: 'not_configured', commands: record.steps.map(step => ({ name: step.name, command: step.command, exitCode: step.exitCode })),
  verifiedAssets: record.verifiedAssets, logHashes: hashes,
  preservedFailures: ['C01-linux-nas-20260906/attempt-1', 'C01-linux-nas-20260906/baseline', 'C01-linux-nas-20260906/attempt-2'],
  notClaimed: ['C01_complete', 'native_windows_verified', 'all_linux_distributions_or_filesystems_verified', 'power_loss_durability',
    'clone_implemented', 'cross_work_session_implemented', 'real_model_quality', 'internal_MCP_or_Knox_integration', 'production_ready'],
  next: 'Windows file boundary and fresh agent clone; continue C01-C10 goal' };
writeFileSync('evidence/C01-linux-native-verification.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ status: result.status, tests, targeted, sourceAndBuild: currentBuild, finishedAt: result.finishedAt }));
