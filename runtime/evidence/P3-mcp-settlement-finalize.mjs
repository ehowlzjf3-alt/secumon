import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const prefix = 'evidence/P3-mcp-settlement-';
async function run(name, expected) {
  const path = `${prefix}${name}-exit.json`, result = await json(path);
  assert.equal(result.exitCode, 0); assert.equal(result.signal, null);
  const log = await readFile(result.log, 'utf8');
  const number = key => {
    const values = [...log.matchAll(new RegExp(`(?:ℹ|#)\\s+${key}\\s+([0-9.]+)`, 'g'))];
    assert.equal(values.length, 1, `${name}: ${key}`); return Number(values[0][1]);
  };
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms'].map(key => [key, number(key)]));
  assert.equal(counts.tests, expected); assert.equal(counts.pass, expected);
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(counts[key], 0);
  return { ...result, counts, exitRecord: path, logSha256: await hash(result.log) };
}
const full = await run('verify-final', 2117), targeted = await run('targeted-final', 154);
assert.deepEqual(full.command, ['npm', 'run', 'verify']);
const build = await verifyEvaluationBuild(process.cwd());
const log = await readFile(full.log, 'utf8');
const architecture = JSON.parse(log.split('\n').find(line => line.startsWith('{"inspected":')));
assert.deepEqual(architecture.failures, []);
const fixture = await json('evidence/fixture-baseline.json');
assert.equal(fixture.passed, true); assert.equal(fixture.scenarios, 4); assert.equal(fixture.checkpoints, 22);
assert.ok(fixture.createdAt >= full.startedAt && fixture.createdAt <= full.finishedAt);
const directory = 'evidence/mcp-settlement-final', measurements = [];
for (const name of (await readdir(directory)).filter(name => name.endsWith('.json')).sort()) {
  const path = `${directory}/${name}`, value = await json(path);
  assert.equal(value.codeDigest, build.sourceDigest); assert.equal(value.tempCleaned, true);
  assert.equal(value.recovery.transport.toolCalls, 0); assert.equal(value.recovery.transport.processStarts, 0);
  assert.equal(value.recovery.forbiddenCalls, 0); assert.equal(value.recovery.discoveryCalls, 0);
  assert.equal(value.final.modelCalls, 0); assert.equal(value.final.plannerCalls, 0);
  assert.equal(value.shutdown.worker.probe, 'ESRCH'); assert.equal(value.shutdown.peerBefore.probe, 'ESRCH');
  assert.ok(value.shutdown.peerAfter.started === false || value.shutdown.peerAfter.probe === 'ESRCH');
  measurements.push({ path, sha256: await hash(path), backend: value.backend, stage: value.stage,
    recoveryToolCalls: 0, recoveryProcessStarts: 0, finalToolCalls: value.transport.toolCalls,
    actualModelCalls: 0, cleanupConfirmed: true });
}
assert.equal(measurements.length, 6);
assert.equal(new Set(measurements.map(row => `${row.backend}/${row.stage}`)).size, 6);
const record = { schemaVersion: 1, chapter: 'P3-mcp-settlement', revision: 'v0.42', createdAt: new Date().toISOString(),
  node: process.version, full, targeted, build, coreTypecheck: 'passed_in_native_verify', architecture,
  fixtures: { path: 'evidence/fixture-baseline.json', createdAt: fixture.createdAt, scenarios: 4, checkpoints: 22, passed: true },
  newTests: { coverageDomain: 10, coverageIntegration: 7, storedResponseRecovery: 11, total: 28 },
  measurements, ownedWorkerSigkillTests: 11, separatelyRecordedMatrixCases: 6,
  scope: 'Current runtime source/build and current chapter execution records only',
  limitations: ['Finite host-approved read manifest only', 'No actual model/API or internal MCP/Knox service',
    'HTTP/OAuth, write-effect profiles and background scheduling remain unverified', 'Whole P0-P6 goal remains in progress'] };
await writeFile(`${prefix}local-verification.json`, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ record: `${prefix}local-verification.json`, full: full.counts, targeted: targeted.counts,
  build, architecture, measurements: measurements.length }));
