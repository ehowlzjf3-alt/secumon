import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

const [suite, attempt] = process.argv.slice(2);
assert(['new', 'related'].includes(suite)); assert.match(attempt ?? '', /^[1-9][0-9]?$/);
const prefix = `evidence/C03-migration-${suite}${attempt}`;
const files = suite === 'new' ? ['document-knowledge-import', 'sqlite-personal-memory-migration', 'personal-memory-backup',
  'personal-memory-migration-flow', 'personal-memory-migration-activation-barrier'].map(name => `dist/tests/${name}.test.js`)
  : [...JSON.parse(readFileSync('evidence/C03-drafts-target4-files.json', 'utf8')), 'dist/tests/session-compact-presentation.test.js'];
files.sort(); assert.equal(new Set(files).size, files.length); files.forEach(file => assert(existsSync(file), file));
const before = await verifyEvaluationBuild(process.cwd());
writeFileSync(`${prefix}-files.json`, JSON.stringify(files, null, 2) + '\n', { flag: 'wx' });
writeFileSync(`${prefix}-before.json`, JSON.stringify(before, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ event: 'starting', suite, files: files.length, sourceAndBuild: before }));
const started = Date.now();
const child = spawn(process.execPath, ['--test', '--test-concurrency=2', '--test-timeout=60000', '--test-reporter=tap', ...files], { stdio: 'inherit', detached: true });
let timedOut = false, escalation;
const signal = value => { try { process.kill(-child.pid, value); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
const timer = setTimeout(() => { timedOut = true; signal('SIGTERM'); escalation = setTimeout(() => signal('SIGKILL'), 5000); }, 300000);
const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
clearTimeout(timer); if (escalation) clearTimeout(escalation);
const after = await verifyEvaluationBuild(process.cwd()); assert.deepEqual(after, before);
writeFileSync(`${prefix}-result.json`, JSON.stringify({ ...exit, timedOut, durationMs: Date.now() - started,
  sourceAndBuild: after, finishedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
process.exitCode = timedOut ? 1 : exit.code ?? 1;
