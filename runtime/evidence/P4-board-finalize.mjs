import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
async function run(name, expected) {
  const path = `evidence/P4-board-${name}-exit.json`, result = await json(path);
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
const full = await run('verify-final', 2160), targeted = await run('targeted-final', 86);
assert.deepEqual(full.command, ['npm', 'run', 'verify']);
const build = await verifyEvaluationBuild(process.cwd()), log = await readFile(full.log, 'utf8');
const architecture = JSON.parse(log.split('\n').find(line => line.startsWith('{"inspected":')));
assert.deepEqual(architecture.failures, []);
const fixture = await json('evidence/fixture-baseline.json');
assert.equal(fixture.passed, true); assert.equal(fixture.scenarios, 4); assert.equal(fixture.checkpoints, 22);
assert.ok(fixture.createdAt >= full.startedAt && fixture.createdAt <= full.finishedAt);
const directory = 'evidence/P4-board-cases-final', cases = [];
for (const name of (await readdir(directory)).filter(name => name.endsWith('.json')).sort()) {
  const path = `${directory}/${name}`, value = await json(path);
  assert.equal(value.codeDigest, build.sourceDigest); assert.equal(value.actualModelCalls, 0);
  assert.equal(value.privateMemoryVisible, false); assert.equal(value.originalSourcesAfterQuote, 1);
  assert.equal(value.sourcesAfterCounterevidence, 2); assert.equal(value.conflictRetained, true); assert.equal(value.reopenedViewMatches, true);
  assert.equal(value.runtimeToolIntegration, 'pending');
  cases.push({ path, sha256: await hash(path), backend: value.backend, family: value.family,
    privateMemoryVisible: false, quotedSourceCount: 1, withCounterevidenceSourceCount: 2, reopenedViewMatches: true });
}
assert.equal(cases.length, 4); assert.equal(new Set(cases.map(value => `${value.backend}/${value.family}`)).size, 4);
const record = { schemaVersion: 1, chapter: 'P4-board-foundation', revision: 'v0.43', createdAt: new Date().toISOString(),
  node: process.version, full, targeted, build, coreTypecheck: 'passed_in_native_verify', architecture,
  fixtures: { path: 'evidence/fixture-baseline.json', createdAt: fixture.createdAt, scenarios: 4, checkpoints: 22, passed: true },
  newTests: 43, actualOwnedWorkerSigkillTests: 2, sigkillEvidence: 'Both board.test cases assert SIGKILL, ESRCH, reopened posts and duplicate receipt in the passing native suite',
  cases, scope: 'Current board service/store implementation and current runtime regression; no legacy archive or old report sweep',
  remaining: ['P4-01 runtime tool bindings, work obligations, parent/child budget and context dependency integration',
    'Bounded agent-facing cards with coverage and two-runtime hypothesis/replan/compact recovery evaluation',
    'Actual model/internal service/A2A/Knox/scheduler integration and operational storage retention/performance'],
  goalStatus: 'in_progress' };
await writeFile('evidence/P4-board-local-verification.json', JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ record: 'evidence/P4-board-local-verification.json', full: full.counts, targeted: targeted.counts, build, architecture, cases: cases.length }));
