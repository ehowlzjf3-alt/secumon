// Run only against the retained checkpoint399 build, before rebuilding checkpoint400.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { evaluationBuildFiles } from '../dist/infrastructure/local-evaluation.js';
import { windowFixture } from '../dist/tests/session-window-helpers.js';
const root = new URL('../', import.meta.url).pathname;
const prior = JSON.parse(await readFile(new URL('./checkpoint399-final-source.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../dist/build-manifest.json', import.meta.url), 'utf8'));
assert.equal(manifest.sourceDigest, prior.sourceDigest);
assert.deepEqual(await evaluationBuildFiles(root), manifest.files);
const cleanups = [], results = [];
try {
  const f = await windowFixture({ after(callback) { cleanups.push(callback); } }, 129, { maxContextBytes: 262144 }, 128);
  const state = await f.current(), originals = {
    state: f.services.state.get.bind(f.services.state), history: f.repository.history.bind(f.repository), input: f.repository.input.bind(f.repository),
  };
  let counts;
  f.services.state.get = async (...args) => { counts.stateReads++; const value = await originals.state(...args); counts.stateBytes += Buffer.byteLength(JSON.stringify(value)); return value; };
  f.repository.history = async (...args) => { const page = await originals.history(...args); counts.historyPages++; counts.historyEntries += page.entries.length;
    counts.historyBytes += Buffer.byteLength(JSON.stringify(page)); return page; };
  f.repository.input = async (...args) => { counts.inputReads++; return originals.input(...args); };
  async function measure(name, run) {
    counts = { stateReads: 0, stateBytes: 0, historyPages: 0, historyEntries: 0, historyBytes: 0, inputReads: 0 };
    const start = performance.now(), value = await run(); results.push({ operation: name, ...counts, elapsedMs: performance.now() - start,
      returnedBytes: Buffer.byteLength(JSON.stringify(value)) }); return value;
  }
  const context = await measure('context', () => f.sessions.context(state)); assert.equal(context.entries.length, 129);
  assert.equal(await measure('current', () => f.sessions.current(state, context)), true);
  const draft = await measure('inspect', () => f.sessions.inspectContext(state)); assert.equal(draft.status, 'complete');
  await measure('materialize', () => f.sessions.materializeContext(state, draft));
  assert.equal(f.planner.inputs.length, 0);
  const result = { baselineCommit: 'ab5c0761ed80936fce86b3497b19fe22da454294', sourceDigest: manifest.sourceDigest,
    compiledFilesMatchPriorManifest: true, node: process.version, platform: process.platform, arch: process.arch,
    sourceEntries: 129, storage: 'SQLite session intake and memory work state/artifacts', modelCalls: 0, results,
    measurement: 'Repository calls/returned UTF-8 bytes and one local elapsed sample; not physical disk I/O or model tokens' };
  await writeFile(new URL('./checkpoint400-baseline.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
