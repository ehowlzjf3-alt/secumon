import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { evaluationBuildFiles } from '../dist/infrastructure/local-evaluation.js';
import { SqliteStateRepository } from '../dist/infrastructure/sqlite-state.js';
import { FileJournalStateRepository } from '../dist/infrastructure/file-journal-state.js';
import { FileArtifactStore } from '../dist/infrastructure/file-artifacts.js';
import { DocumentKnowledgeRepository } from '../dist/infrastructure/document-knowledge.js';
import { SqliteKnowledgeRepository } from '../dist/infrastructure/sqlite-knowledge.js';

// Fixed local deployment fixture only. No bodies, credentials, or personal paths are recorded.
const manifest = JSON.parse(readFileSync(new URL('../dist/build-manifest.json', import.meta.url), 'utf8'));
const files = await evaluationBuildFiles(process.cwd());
assert.deepEqual(files, manifest.files, 'measurement must use an unchanged compiled build');
if (process.env.SECUMON_BASELINE_SOURCE) assert.equal(manifest.sourceDigest, process.env.SECUMON_BASELINE_SOURCE);
const counts = {}, inclusiveMs = {}, requests = [];
for (const type of [SqliteStateRepository, FileJournalStateRepository, FileArtifactStore, DocumentKnowledgeRepository, SqliteKnowledgeRepository]) {
  for (const method of ['get', 'receipt', 'events', 'eventPage', 'history', 'exists', 'search', 'index', 'list', 'commit']) {
    const original = type.prototype[method];
    if (typeof original !== 'function') continue;
    const key = `${type.name}.${method}`;
    type.prototype[method] = function (...args) {
      counts[key] = (counts[key] ?? 0) + 1;
      const started = performance.now();
      const finish = () => { inclusiveMs[key] = (inclusiveMs[key] ?? 0) + performance.now() - started; };
      try {
        const value = original.apply(this, args);
        if (value && typeof value.then === 'function') return value.then(result => { finish(); return result; }, error => { finish(); throw error; });
        finish(); return value;
      } catch (error) { finish(); throw error; }
    };
  }
}
const delta = (current, before) => Object.fromEntries(Object.entries(current).map(([key, value]) => [key, value - (before[key] ?? 0)]).filter(([, value]) => value !== 0));
const originalFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'measurement must stay on loopback');
  const started = performance.now(), before = { ...counts }, timings = { ...inclusiveMs };
  const path = url.pathname.replace(/\/works\/[^/]+/, '/works/:id').replace(/\/memories\/[^/]+/, '/memories/:id');
  let recorded = false;
  const record = (status, failure = false) => {
    if (recorded) return; recorded = true;
    requests.push({ method: init?.method ?? 'GET', path, status, failure, elapsedMs: performance.now() - started,
      calls: delta(counts, before), inclusiveMs: delta(inclusiveMs, timings) });
  };
  try {
    const response = await originalFetch(input, init), json = response.json.bind(response);
    response.json = async () => { try { const value = await json(); record(response.status); return value; }
      catch (error) { record(response.status, true); throw error; } };
    return response;
  } catch (error) { record(null, true); throw error; }
};
process.on('exit', () => {
  if (!requests.length) return;
  writeFileSync(process.env.SECUMON_MEASUREMENT_PATH, JSON.stringify({ sourceDigest: manifest.sourceDigest,
    compiledFileCount: files.length, node: process.version, platform: process.platform, arch: process.arch,
    scenario: 'same-ID personal memory isolation through two local HTTP deployments',
    inference: 'deterministic_fixture', actualModelCalls: 0, requests, counts, inclusiveMs,
    caveats: ['single local run', 'method timings are inclusive and must not be summed', 'logical calls are not physical disk I/O'] }, null, 2) + '\n');
});
