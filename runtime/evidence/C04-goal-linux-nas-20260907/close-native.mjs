import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { directory, root, configuration, assertPin, controlPath, remoteJson, requireCleanAudit } from './goal-c04-common.mjs';
const native = JSON.parse(readFileSync(directory + '/final/result.json', 'utf8'));
assert.equal(native.status, 'passed'); assert.ok(native.finishedAt);
assert.deepEqual(native.buildPin, assertPin(JSON.parse(readFileSync(directory + '/build-pin.json', 'utf8'))));
const control = controlPath(), cleanup = { ...remoteJson(async root => await auditRoot(root), [root]), sshClosed: false };
writeFileSync(directory + '/cleanup.json', JSON.stringify(cleanup, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
requireCleanAudit(cleanup);
execFileSync('ssh', ['-S', control.socket, '-O', 'exit', configuration.sshHost], { timeout: 10000 }); cleanup.sshClosed = !existsSync(control.socket);
writeFileSync(directory + '/cleanup.json', JSON.stringify(cleanup, null, 2) + '\n', { mode: 0o600 });
if (!cleanup.sshClosed) throw new Error('ssh_control_still_present'); rmdirSync(control.directory);
const path = directory + '/run-metadata.json', metadata = JSON.parse(readFileSync(path, 'utf8'));
Object.assign(metadata, { status: native.status, finishedAt: native.finishedAt, sessionCompleted: true,
  logsCollected: ['result.json', ...native.steps.map(step => step.name + '.log')], sshClosed: true });
writeFileSync(path, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ status: native.status, finishedAt: native.finishedAt, cleanup }));
