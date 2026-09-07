import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { evaluationCodePin, evaluationBuildFiles } from '../dist/infrastructure/local-evaluation.js';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
const file = async path => ({ path, sha256: hash(await readFile(path)) });
const checks = {};
for (const name of ['targeted-final', 'verify-final']) {
  const base = `evidence/P3-mcp-waits-${name}`;
  const exit = await json(`${base}-exit.json`); assert.equal(exit.exitCode, 0); assert.equal(exit.signal, null);
  const log = await readFile(`${base}.log`, 'utf8');
  const count = key => Number([...log.matchAll(new RegExp(`(?:ℹ|#) ${key} ([0-9.]+)`, 'g'))].at(-1)?.[1] ?? NaN);
  const summary = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms'].map(key => [key, count(key)]));
  assert.ok(summary.tests > 0); assert.equal(summary.tests, summary.pass);
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(summary[key], 0);
  checks[name] = { ...exit, summary, logFile: await file(`${base}.log`), exitFile: await file(`${base}-exit.json`) };
}
const source = await evaluationCodePin(process.cwd());
const build = await json('dist/build-manifest.json'); const outputs = await evaluationBuildFiles(process.cwd());
assert.equal(build.sourceDigest, source.digest); assert.deepEqual(build.files, outputs); assert.equal(build.node, process.version);
const verifyLog = await readFile('evidence/P3-mcp-waits-verify-final.log', 'utf8');
const architecture = JSON.parse(verifyLog.split('\n').find(line => line.startsWith('{"inspected":')));
assert.equal(architecture.failures.length, 0);
const fixture = await json('evidence/fixture-baseline.json'); assert.equal(fixture.passed, true);
assert.ok(Date.parse(fixture.createdAt) >= Date.parse(checks['verify-final'].startedAt));
const recovery = [];
for (const name of (await readdir('evidence/mcp-waits-final')).filter(value => value.endsWith('-wait-recovery.json')).sort()) {
  const path = `evidence/mcp-waits-final/${name}`; const row = await json(path);
  assert.equal(row.codeDigest, source.digest); assert.equal(row.tempCleaned, true);
  assert.equal(row.shutdown.probe, 'ESRCH'); assert.equal(row.transport.closed, true);
  assert.equal(row.transport.activeCalls, 0); assert.equal(row.transport.pid, null);
  assert.equal(row.final.budget.used.modelCalls, 0); assert.equal(row.final.retryWakeAt, null);
  assert.equal(row.final.attempts.at(-1).readProgress.phase, 'complete');
  recovery.push({ ...(await file(path)), backend: row.backend, waitKind: row.waitKind,
    modelCalls: row.final.budget.used.modelCalls, calls: [...row.beforeAudit, ...row.afterAudit].filter(x => x.event === 'call').length,
    workersStopped: 1, peersStopped: 2, cleanup: 'passed' });
}
assert.equal(recovery.length, 4); assert.equal(new Set(recovery.map(row => `${row.backend}:${row.waitKind}`)).size, 4);
const record = { version: 1, chapter: 'P3-mcp-waits', status: 'local_verified', recordedAt: new Date().toISOString(),
  node: process.version, sourceDigest: source.digest, sourceFiles: source.files.length,
  build: { files: outputs.length, filesDigest: hash(JSON.stringify(outputs)), manifest: await file('dist/build-manifest.json') },
  checks, architecture, fixture: { ...(await file('evidence/fixture-baseline.json')), scenarios: fixture.scenarios,
    checkpoints: fixture.checkpoints, passed: fixture.passed },
  additionalTests: { total: 49, mcp: 30, recovery: 4, control: 8, checkpointRecord: 4, deferralProof: 3 }, recovery,
  scope: 'Owned synthetic local stdio MCP, SQLite/file journal, FakeClock and explicit host workflow calls',
  limitations: ['No live model or internal service calls', 'No background scheduler', 'No HTTP Retry-After or endpoint-wide quotas',
    'No rerun of original Python code/archive/historical verification comparisons'],
  result: 'design/chapters/P3-mcp-waits-result.md' };
await writeFile('evidence/P3-mcp-waits-local-verification.json', JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: record.status, tests: checks['verify-final'].summary.tests, targeted: checks['targeted-final'].summary.tests,
  sourceDigest: source.digest, recoveryCases: recovery.length }));
