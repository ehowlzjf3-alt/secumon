import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { directory, root, configuration, assertPin, controlPath, remoteJson, requireCleanAudit } from './window-c04-common.mjs';
const attempt = Number(process.argv[2] ?? 1); assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= 9);
const sourceAndBuild = assertPin(JSON.parse(readFileSync(directory + '/build-pin.json', 'utf8')));
const validationInputs = JSON.parse(readFileSync(directory + '/upload-attempt' + attempt + '-validation-inputs.json', 'utf8'));
assert.deepEqual(sourceAndBuild, validationInputs.pin);
const upload = JSON.parse(readFileSync(directory + '/upload-attempt' + attempt + '.json', 'utf8'));
assert.equal(upload.attempt, attempt); assert.equal(upload.sourceDigest, sourceAndBuild.sourceDigest);
requireCleanAudit(remoteJson(async root => await auditRoot(root), [root]));
const metadataPath = directory + '/run-metadata.json';
if (existsSync(metadataPath)) {
  const prior = JSON.parse(readFileSync(metadataPath, 'utf8'));
  if (prior.attempt >= attempt || !existsSync(directory + '/attempt-' + prior.attempt + '/result.json')) throw new Error('previous_attempt_must_be_collected');
  const collected = JSON.parse(readFileSync(directory + '/attempt-' + prior.attempt + '/result.json', 'utf8'));
  if (collected.status !== 'failed' || !collected.finishedAt) throw new Error('previous_failure_not_finished');
  writeFileSync(directory + '/attempt-' + prior.attempt + '/run-metadata.json', JSON.stringify(prior, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
const control = controlPath();
const record = { status: 'running', attempt, root, sourceAndBuild, startedAt: new Date().toISOString(),
  externalModelCalls: false, internalServiceIntegration: false, duplicateRunStarted: false };
writeFileSync(metadataPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
const command = '/usr/bin/env -i PATH=' + root + '/node-v24.20.0-linux-x64/bin:/usr/bin:/bin TMPDIR=' + root + '/tmp NODE_COMPILE_CACHE=' +
  root + '/tmp/node-compile-cache npm_config_cache=' + root + '/npm-cache /usr/bin/nice -n 10 ' + root + '/node-v24.20.0-linux-x64/bin/node ' + root + '/verify-linux-window-c04.mjs ' + root;
const child = spawn('ssh', ['-S', control.socket, configuration.sshHost, command], { stdio: ['ignore', 'inherit', 'inherit'] });
child.once('error', error => {
  const latest = JSON.parse(readFileSync(metadataPath, 'utf8')); latest.observerError = String(error);
  writeFileSync(metadataPath, JSON.stringify(latest, null, 2) + '\n', { mode: 0o600 });
});
child.once('close', (code, signal) => {
  const latest = JSON.parse(readFileSync(metadataPath, 'utf8')); Object.assign(latest, { observerExitCode: code, observerSignal: signal, observerFinishedAt: new Date().toISOString() });
  writeFileSync(metadataPath, JSON.stringify(latest, null, 2) + '\n', { mode: 0o600 }); process.exitCode = code ?? 1;
});
