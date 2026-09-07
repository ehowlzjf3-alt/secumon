import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { directory, root, configuration, assertPin, controlPath } from './mcp-offline-c05-common.mjs';
const label = process.argv[2]; if (!/^(attempt-[1-9][0-9]*|final)$/.test(label ?? '')) throw new Error('collection_label_required');
const control = controlPath();
const get = name => execFileSync('ssh', ['-S', control.socket, configuration.sshHost, '/bin/cat ' + root + '/evidence-mcp-offline-c05/' + name], { timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
const bytes = get('result.json'), result = JSON.parse(bytes);
if (!result.finishedAt || !['passed', 'failed'].includes(result.status)) throw new Error('native_run_not_finished');
if (label === 'final') { assert.equal(result.status, 'passed'); assert.deepEqual(result.buildPin, assertPin(JSON.parse(readFileSync(directory + '/build-pin.json', 'utf8')))); }
const allowed = new Set(['build', 'new-mcp-offline-tests', 'related-existing-tests', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures']);
if (!Array.isArray(result.steps) || result.steps.some(step => !allowed.has(step.name)) || new Set(result.steps.map(step => step.name)).size !== result.steps.length) throw new Error('invalid_step_name');
if (label === 'final') {
  assert.equal(result.steps.length, allowed.size);
  assert.ok(result.steps.every(step => step.status === 'passed' && step.exitCode === 0 && step.nodeTestTimeoutFailures === 0 && step.groupAbsentConfirmed));
}
mkdirSync(directory + '/' + label, { mode: 0o700 }); writeFileSync(directory + '/' + label + '/result.json', bytes, { flag: 'wx', mode: 0o600 });
const names = ['result.json'];
for (const step of result.steps) {
  const name = step.name + '.log'; writeFileSync(directory + '/' + label + '/' + name, get(name), { flag: 'wx', mode: 0o600 }); names.push(name);
}
const hashes = names.map(file => ({ file, sha256: createHash('sha256').update(readFileSync(directory + '/' + label + '/' + file)).digest('hex') }));
writeFileSync(directory + '/' + label + '-collection.json', JSON.stringify({ collectedAt: new Date().toISOString(), status: result.status,
  finishedAt: result.finishedAt, sourceAndBuild: result.buildPin, files: hashes }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ status: result.status, finishedAt: result.finishedAt, collectedFiles: names.length, sourceAndBuild: result.buildPin }));
