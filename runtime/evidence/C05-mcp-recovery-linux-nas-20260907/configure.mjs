// Local evidence configuration only. Does not create an SSH socket, pin, archive, test result or final proof.
import assert from 'node:assert/strict';
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
assert.equal(previousNativeResult, 'evidence-mcp-c05/result.json', 'MCP stored-result recovery validation reuses the completed MCP general-entry dedicated root');
assert.ok(new Set(historyEvidence).size === historyEvidence.length && historyEvidence.every(path => /^evidence\/[a-zA-Z0-9_./-]+\.json$/.test(path) && !path.split('/').includes('..')), 'historical JSON paths must stay under runtime/evidence');
assert.ok(historyEvidence.includes('evidence/C05-mcp-linux-nas-20260907/verification.json'), 'completed MCP general-entry local proof must be retained as historical evidence');
const configPath = join(directory, 'mcp-recovery-c05-config.json'), controlPath = join(directory, 'control-directory.txt');
assert.equal(existsSync(configPath), false, 'configuration already exists');
if (existsSync(controlPath)) {
  const recorded = readFileSync(controlPath, 'utf8').trim();
  assert.ok(isAbsolute(recorded)); assert.equal(realpathSync(recorded), control, 'recorded control directory differs');
}
const configuration = { schemaVersion: 1, root, sshHost, expectedDefaultNode, previousNativeResult, historyEvidence,
  configuredAt: new Date().toISOString(), status: 'configured_not_executed' };
if (!existsSync(controlPath)) writeFileSync(controlPath, control + '\n', { flag: 'wx', mode: 0o600 });
writeFileSync(configPath, JSON.stringify(configuration, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ status: configuration.status, root, configPath, controlPath, historicalFiles: historyEvidence.length }));
