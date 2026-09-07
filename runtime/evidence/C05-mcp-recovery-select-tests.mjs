// Selection preparation only. No imports of build output, models, or transports.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const runtime = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
assert.match(process.version, /^v24\./);
assert.equal(realpathSync(process.cwd()), runtime, 'run from runtime');
assert.deepEqual(process.argv.slice(2).filter(value => value !== '--write'), [], 'only --write is accepted');
assert.ok(process.argv.length <= 3);
const newNames = ['stored-tool-results', 'stored-result-runtime', 'mcp-stored-result', 'mcp-stored-result-recovery', 'stored-result-workflow'];
const groups = [
  { name: 'MCP original adapters and P3 recovery', reason: 'The plain proof reader changes while collection/wait use adjacent original receipts and old recovery order.',
    names: ['mcp-stdio-client', 'mcp-read-tools', 'mcp-read-collections', 'mcp-read-coverage', 'mcp-read-collections-recovery', 'mcp-read-settlement-recovery', 'mcp-read-waits', 'mcp-read-waits-recovery'] },
  { name: 'Current C01 host and public entry', reason: 'The same provider source, profile custody, discovery/close and CLI/Web composition must continue working.',
    names: ['host-provider-tools', 'mcp-host-tools', 'mcp-agent-profile', 'mcp-agent-entry'] },
  { name: 'Execution and result authority', reason: 'Internal restored receive must preserve normal owner checks, late result usage, policy/currentness, validation and result reuse.',
    names: ['execution', 'recovery', 'tool-result-validation', 'tool-result-reuse', 'execution-authority', 'tool-usage-authority', 'tool-broker-refresh'] },
  { name: 'Contract capture', reason: 'The optional callback uses the existing tool/source snapshot and contract-version lifecycle.',
    names: ['tool-catalog-lifecycle', 'host-tools'] },
  { name: 'Workflow and persistent general turn', reason: 'Recovery precedes a new reservation; completion, crash/reopen and a new answer must retain their existing sequence.',
    names: ['workflow', 'workflow-crash', 'persistent-workflow', 'agent-turn-flow'] },
  { name: 'Planning and compact ordering', reason: 'A pending stored result must settle before automatic compact or a new model call, including context capacity boundaries.',
    names: ['model-runtime', 'session-compact-runtime', 'session-compact-window', 'agent-turn-compact'] },
  { name: 'Disclosure', reason: 'Reopening a stored result does not broaden the existing policy/disclosure surface.', names: ['disclosure-workflow'] },
];
const path = name => `dist/tests/${name}.test.js`;
const newFiles = newNames.map(path), relatedFiles = groups.flatMap(group => group.names.map(path));
assert.equal(new Set([...newFiles, ...relatedFiles]).size, newFiles.length + relatedFiles.length);
for (const name of [...newNames, ...groups.flatMap(group => group.names)]) {
  const file = resolve(runtime, 'src/tests', name + '.test.ts'), stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink()); assert.equal(realpathSync(file), file);
}
const selection = { newFiles, relatedFiles };
const directory = 'evidence/C05-mcp-recovery-linux-nas-20260907';
const notes = { schemaVersion: 1, status: 'selected_not_executed', newFiles,
  groups: groups.map(({ names, ...group }) => ({ ...group, files: names.map(path) })),
  excludedFromRelated: ['Unchanged C01 filesystem/setup/migration and C03 CRUD/UI suites remain covered by the later full suite.',
    'General UI appearance, model registration/adapter and unrelated computer/board/A2A paths are not reselected without a changed dependency.',
    'Collection/wait passing does not establish a new general-entry collection/wait implementation.'],
  countsMeaning: 'File counts only. Actual TAP supplies test/pass/fail counts; these groups are not additive performance or quality evidence.',
  fullSuite: 'Discover all dist/tests/*.test.js only after the future exact-pin native build.',
  selectorSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex') };
if (process.argv[2] === '--write') {
  const outputs = [[`evidence/C05-mcp-recovery-new-files.json`, newFiles], [`evidence/C05-mcp-recovery-related-files.json`, relatedFiles],
    [`${directory}/targeted-files.json`, selection], [`${directory}/selection-notes.json`, notes]];
  for (const [file] of outputs) { assert.ok(!existsSync(join(runtime, file)), 'selection output already exists: ' + file); assert.ok(lstatSync(dirname(join(runtime, file))).isDirectory()); }
  for (const [file, value] of outputs) writeFileSync(join(runtime, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: 'selected_not_executed', newFileCount: newFiles.length, relatedFileCount: relatedFiles.length, files: outputs.map(([file]) => file) }));
} else console.log(JSON.stringify({ ...selection, notes }, null, 2));
