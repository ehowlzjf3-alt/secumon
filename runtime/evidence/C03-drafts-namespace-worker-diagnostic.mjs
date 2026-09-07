import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocumentKnowledgeRepository, registerDocumentKnowledgeStore } from '../dist/infrastructure/document-knowledge.js';
import { storageFixture, ownerScope } from '../dist/tests/personal-knowledge-storage-helpers.js';

assert.equal(process.version, 'v24.20.0'); process.umask(0o022);
const output = fileURLToPath(new URL('./C03-drafts-namespace-worker-diagnostic.json', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const compiled = path => fileURLToPath(new URL('../dist/' + path, import.meta.url));
const report = { schemaVersion: 1, kind: 'one-local-pair-original-dist-worker-diagnostic', status: 'running', startedAt: new Date().toISOString(),
  node: process.version, platform: process.platform, scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
  distManifestSha256: hash(readFileSync(compiled('build-manifest.json'))), distSourceDigest: JSON.parse(readFileSync(compiled('build-manifest.json'), 'utf8')).sourceDigest,
  compiledFileHashes: Object.fromEntries(['tests/helpers/document-knowledge-worker.js', 'infrastructure/document-knowledge.js', 'infrastructure/document-knowledge-owner.js'].map(path => [path, hash(readFileSync(compiled(path)))])),
  fixturePairs: 1, automaticRetries: 0, originalFailure: 'attempt-3/drafts-targeted.log #113 ABORT_ERR, no captured child diagnostic',
  interpretation: 'This observation exposes child messages/exit/stderr. A pass cannot establish the cause or resolve the prior NAS failure.',
  children: [], cleanup: { fixtureRemoved: false, childrenClosed: false }, externalCalls: false };
writeFileSync(output, '', { mode: 0o600, flag: 'wx' });
const f = storageFixture(), directory = join(f.directory, 'documents'), gate = join(f.directory, 'release');
const workers = []; let repository;
function start() {
  const child = fork(compiled('tests/helpers/document-knowledge-worker.js'), ['contend-different', directory, f.agentId, gate], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const row = { pid: child.pid, messages: [], stderr: '', exit: null, closed: false }; report.children.push(row);
  const listeners = new Set();
  const update = () => { for (const listener of listeners) listener(); };
  child.stderr.on('data', bytes => { row.stderr = (row.stderr + bytes).slice(-16000); });
  child.on('message', message => { row.messages.push(message); update(); });
  child.on('error', error => { row.spawnError = { name: error.name, message: error.message, stack: error.stack }; update(); });
  child.once('exit', (code, signal) => { row.exit = { code, signal }; });
  const closed = new Promise(resolve => child.once('close', () => { row.closed = true; update(); resolve(); }));
  const timer = setTimeout(() => { row.deadline = true; child.kill('SIGKILL'); }, 15000);
  const message = predicate => new Promise((resolve, reject) => {
    const wait = setTimeout(() => finish(new Error('diagnostic_message_deadline: ' + JSON.stringify(row))), 12000);
    function finish(error, value) { clearTimeout(wait); listeners.delete(check); error ? reject(error) : resolve(value); }
    function check() {
      const value = row.messages.find(predicate);
      if (value) finish(null, value);
      else if (row.closed || row.spawnError) finish(new Error('diagnostic_worker_ended_before_message: ' + JSON.stringify(row)));
    }
    listeners.add(check); check();
  });
  const worker = { row, message, closed, async close() { clearTimeout(timer); if (!row.closed) child.kill('SIGKILL'); await closed; } };
  workers.push(worker); return worker;
}
try {
  registerDocumentKnowledgeStore(directory, { agentId: f.agentId, storeId: 'store' });
  const a = start(), b = start();
  await Promise.all([a, b].map(worker => worker.message(value => value?.checkpoint === 'contend')));
  writeFileSync(gate, 'release', { mode: 0o600 });
  const results = await Promise.all([a, b].map(worker => worker.message(value => value?.done === true)));
  assert.deepEqual(results.map(value => value.result.kind), ['committed', 'committed']);
  await Promise.all([a.closed, b.closed]);
  assert.ok([a, b].every(worker => worker.row.exit?.code === 0), JSON.stringify(report.children));
  repository = new DocumentKnowledgeRepository(directory, { agentId: f.agentId, storeId: 'store' });
  assert.equal((await repository.indexHead('tenant-a', 'personal', ownerScope(f.agentId))).revision, 2);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { name: error.name, message: error.message, stack: error.stack }; }
finally {
  await repository?.close(); await Promise.all(workers.map(worker => worker.close()));
  report.cleanup.childrenClosed = report.children.every(child => child.closed);
  f.close(); report.cleanup.fixtureRemoved = true; report.finishedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2)); process.exitCode = report.status === 'passed' ? 0 : 1;
}
