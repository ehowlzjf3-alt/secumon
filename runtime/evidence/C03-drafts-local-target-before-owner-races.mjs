import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';
const attempt = process.argv[2]; assert.match(attempt ?? '', /^[1-9]$/);
const files = JSON.parse(readFileSync('evidence/C03-documents-target1-files.json', 'utf8'));
files.push(...['memory-draft-web', 'personal-memory-drafts', 'personal-memory-draft-flow', 'personal-memory-draft-recovery',
  'personal-memory-draft-cli', 'personal-memory-revision-status', 'session-input-only', 'session-flow', 'session-flow-kill',
  'session-flow-boundaries', 'session-context-runtime', 'persistent-session-presentation', 'sqlite-sessions'].map(name => `dist/tests/${name}.test.js`));
files.sort(); assert.equal(new Set(files).size, files.length); files.forEach(file => assert(existsSync(file), file));
const before = await verifyEvaluationBuild(process.cwd());
writeFileSync(`evidence/C03-drafts-target${attempt}-files.json`, JSON.stringify(files, null, 2) + '\n', { flag: 'wx' });
writeFileSync(`evidence/C03-drafts-target${attempt}-before.json`, JSON.stringify(before, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ event: 'starting', files: files.length, sourceAndBuild: before }));
const child = spawn(process.execPath, ['--test', '--test-concurrency=2', '--test-reporter=tap', ...files], { stdio: 'inherit' });
const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
const after = await verifyEvaluationBuild(process.cwd()); assert.deepEqual(after, before);
writeFileSync(`evidence/C03-drafts-target${attempt}-result.json`, JSON.stringify({ ...exit, sourceAndBuild: after, finishedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
process.exitCode = exit.code ?? 1;
