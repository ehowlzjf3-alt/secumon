import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, openSync, closeSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { evaluationBuildFiles, evaluationCodePin } from '../dist/infrastructure/local-evaluation.js';
import { Sha256Digester, sha256 } from '../dist/infrastructure/digest.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const name = 'C04-registered-flow-diagnostic';
const path = suffix => join(root, 'evidence', `${name}${suffix}`);
const sourcePath = join(root, 'dist/tests/registered-agent-flow.test.js');
const original = readFileSync(sourcePath, 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'dist/build-manifest.json'), 'utf8'));
const historical = JSON.parse(readFileSync(join(root, 'evidence/C04-registered-build1.json'), 'utf8')).buildAfter;
const digest = value => new Sha256Digester().digest(value);
const buildFilesBefore = await evaluationBuildFiles(root);
assert.equal(digest(buildFilesBefore), historical.filesDigest);
assert.equal(manifest.sourceDigest, historical.sourceDigest);
let transformed = original.slice(0, original.indexOf("test('a registered reply already stored"));
assert.ok(transformed.length > 1000 && transformed.length < original.length);
transformed = transformed.replaceAll("from '../application/", "from '../dist/application/")
  .replaceAll("from '../infrastructure/", "from '../dist/infrastructure/")
  .replaceAll("from '../presentation/", "from '../dist/presentation/")
  .replace("new URL('../../', import.meta.url)", "new URL('../', import.meta.url)");
const target = "assert.equal((await profile.workflow.run(y.workId, profile.executionActor, { maxSteps: 80 })).control.kind, 'complete');";
assert.equal(transformed.split(target).length, 2);
transformed = transformed.replace(target, `const actualRun = await profile.workflow.run(y.workId, profile.executionActor, { maxSteps: 80 });
    writeFileSync(new URL('./${name}-data.json', import.meta.url), JSON.stringify({ actualRun, state: await profile.runtime.state(y.workId), observations: f.observed, beforeHistory: before, inspection, narrow, inputLimit, totalWindow, directory: f.directory }, null, 2), { flag: 'wx', mode: 0o600 });
    assert.equal(actualRun.control.kind, 'complete');`);
writeFileSync(path('-test.mjs'), transformed, { flag: 'wx', mode: 0o600 });
const result = { startedAt: new Date().toISOString(), historicalBuild: historical,
  currentSourceBefore: (await evaluationCodePin(root)).digest, node: process.version,
  scriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), originalTestSha256: sha256(original),
  derivedTestSha256: sha256(transformed), transformations: ['first test only', 'relative dist imports/root corrected', 'record result/state/fixture observations immediately before original failing assertion'],
  limitations: 'One isolated fixed local fixture; no external model or network. Current source is recorded separately from the frozen historical dist.',
  timeoutMs: 60000, timedOut: false };
const log = openSync(path('.log'), 'wx', 0o600);
try {
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=60000', path('-test.mjs')],
    { cwd: root, detached: true, stdio: ['ignore', log, log] });
  result.pid = child.pid;
  const signal = kind => { try { process.kill(-child.pid, kind); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  let killTimer;
  const timer = setTimeout(() => { result.timedOut = true; signal('SIGTERM'); killTimer = setTimeout(() => signal('SIGKILL'), 5000); }, 60000);
  try { await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { result.exitCode = code; result.signal = signal; resolve(); }); }); }
  finally { clearTimeout(timer); clearTimeout(killTimer); }
} finally { closeSync(log); }
result.finishedAt = new Date().toISOString();
result.currentSourceAfter = (await evaluationCodePin(root)).digest;
result.distUnchanged = digest(await evaluationBuildFiles(root)) === historical.filesDigest;
if (existsSync(path('-data.json'))) {
  const data = JSON.parse(readFileSync(path('-data.json'), 'utf8'));
  result.fixtureDirectory = data.directory;
  result.fixtureRemoved = !existsSync(data.directory);
  result.actualControl = data.actualRun.control;
  result.observedTurnCount = data.observations.turns.length;
  result.observedCompactCount = data.observations.compacts.length;
}
result.logSha256 = sha256(readFileSync(path('.log')));
writeFileSync(path('.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
