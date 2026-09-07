// Local evidence configuration only. Does not create an SSH socket, pin, archive, test result or final proof.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('./', import.meta.url));
const [root, sshHost, expectedDefaultNode, controlDirectory, previousNativeResult, ...historyEvidence] = process.argv.slice(2);
assert.ok(typeof root === 'string' && /^\/[a-zA-Z0-9_./-]+$/.test(root) && !root.split('/').some(part => part === '..' || part === '.') && !root.endsWith('/'), 'explicit canonical dedicated Linux root required');
assert.ok(typeof sshHost === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(sshHost), 'explicit SSH config host required');
assert.ok(typeof expectedDefaultNode === 'string' && /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(expectedDefaultNode), 'explicit observed /usr/bin/node version required');
assert.ok(typeof controlDirectory === 'string' && isAbsolute(controlDirectory), 'existing private control directory required');
const stat = lstatSync(controlDirectory), control = realpathSync(controlDirectory);
assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700);
assert.ok(lstatSync(join(control, 'control')).isSocket(), 'operator must first create the private control socket');
assert.ok(typeof previousNativeResult === 'string' && /^evidence-[a-zA-Z0-9_-]+\/result\.json$/.test(previousNativeResult), 'explicit prior finished native result relative to dedicated root required');
assert.equal(previousNativeResult, 'evidence-mcp-offline-c05/result.json', 'collection validation requires the completed plain-read offline predecessor');
assert.ok(new Set(historyEvidence).size === historyEvidence.length && historyEvidence.every(path => /^evidence\/[a-zA-Z0-9_./-]+\.json$/.test(path) && !path.split('/').includes('..')), 'historical JSON paths must stay under runtime/evidence');
const predecessor = { path: 'evidence/C05-mcp-offline-linux-nas-20260907/verification.json',
  sha256: '28cdec0cdcaa8d7e308e8341258218a6b85e31d5053f50cf914e5e6edd7f38b9',
  nativeResultSha256: 'a64d5f74827c2db5ae3ecb103ce1863663d4de148f189129e0ac75b10a3607c3' };
assert.ok(historyEvidence.includes(predecessor.path), 'completed plain-read offline proof must remain historical evidence');
const predecessorBytes = readFileSync(predecessor.path), predecessorProof = JSON.parse(predecessorBytes.toString('utf8'));
assert.equal(createHash('sha256').update(predecessorBytes).digest('hex'), predecessor.sha256, 'predecessor proof changed');
assert.equal(predecessorProof.scope, 'mcp_offline_general_resume'); assert.equal(predecessorProof.nativeLinux.status, 'passed');
assert.deepEqual(predecessorProof.nativeLinux.collectedFiles.filter(item => item.file === 'result.json'), [{ file: 'result.json', sha256: predecessor.nativeResultSha256 }]);
const configPath = join(directory, 'mcp-collections-c05-config.json'), controlPath = join(directory, 'control-directory.txt');
assert.equal(existsSync(configPath), false, 'configuration already exists');
if (existsSync(controlPath)) {
  const recorded = readFileSync(controlPath, 'utf8').trim();
  assert.ok(isAbsolute(recorded)); assert.equal(realpathSync(recorded), control, 'recorded control directory differs');
}
const configuration = { schemaVersion: 1, root, sshHost, expectedDefaultNode, previousNativeResult, historyEvidence, predecessor,
  configuredAt: new Date().toISOString(), status: 'configured_not_executed' };
if (!existsSync(controlPath)) writeFileSync(controlPath, control + '\n', { flag: 'wx', mode: 0o600 });
writeFileSync(configPath, JSON.stringify(configuration, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ status: configuration.status, root, configPath, controlPath, historicalFiles: historyEvidence.length }));
