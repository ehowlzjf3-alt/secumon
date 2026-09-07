import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const directory = 'evidence/C03-documents-linux-nas-20260907', root = '/home/shaneee/secumon-linux-test.pCJ0bd';
const control = readFileSync(directory + '/control-directory.txt', 'utf8').trim() + '/control';
const attempt = Number(process.argv[2] ?? 1); assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= 9);
const sourceAndBuild = JSON.parse(readFileSync(directory + '/build-pin.json', 'utf8'));
const upload = JSON.parse(readFileSync(directory + '/upload-verification.json', 'utf8'));
assert.equal(upload.attempt, attempt); assert.equal(upload.sourceDigest, sourceAndBuild.sourceDigest);
const metadataPath = directory + '/run-metadata.json';
if (existsSync(metadataPath)) {
  const prior = JSON.parse(readFileSync(metadataPath, 'utf8'));
  if (prior.attempt >= attempt || !existsSync(directory + '/attempt-' + prior.attempt + '/result.json')) throw new Error('previous_attempt_must_be_collected');
  const collected = JSON.parse(readFileSync(directory + '/attempt-' + prior.attempt + '/result.json', 'utf8'));
  if (collected.status !== 'failed' || !collected.finishedAt) throw new Error('previous_failure_not_finished');
  writeFileSync(directory + '/attempt-' + prior.attempt + '/run-metadata.json', JSON.stringify(prior, null, 2) + '\n', { flag: 'wx' });
}
const record = { status: 'running', attempt, root, control, sourceAndBuild, startedAt: new Date().toISOString(),
  externalModelCalls: false, internalServiceIntegration: false, duplicateRunStarted: false };
writeFileSync(metadataPath, JSON.stringify(record, null, 2) + '\n');
const command = '/usr/bin/env -i PATH=' + root + '/node-v24.20.0-linux-x64/bin:/usr/bin:/bin TMPDIR=' + root + '/tmp NODE_COMPILE_CACHE=' +
  root + '/tmp/node-compile-cache npm_config_cache=' + root + '/npm-cache /usr/bin/nice -n 10 ' + root + '/node-v24.20.0-linux-x64/bin/node ' + root + '/verify-linux-documents-c03.mjs ' + root;
const child = spawn('ssh', ['-S', control, 'nas', command], { stdio: ['ignore', 'inherit', 'inherit'] });
child.on('error', error => {
  const latest = JSON.parse(readFileSync(metadataPath, 'utf8')); latest.observerError = String(error); writeFileSync(metadataPath, JSON.stringify(latest, null, 2) + '\n');
});
child.on('close', (code, signal) => {
  const latest = JSON.parse(readFileSync(metadataPath, 'utf8')); Object.assign(latest, { observerExitCode: code, observerSignal: signal, observerFinishedAt: new Date().toISOString() });
  writeFileSync(metadataPath, JSON.stringify(latest, null, 2) + '\n'); process.exitCode = code ?? 1;
});
