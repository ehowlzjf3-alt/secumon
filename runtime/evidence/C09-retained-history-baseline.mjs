// Capture the unchanged checkpoint400 compiled baseline before building checkpoint401.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { evaluationBuildFiles } from '../dist/infrastructure/local-evaluation.js';
import { residentEntryFixture } from '../dist/tests/resident-missions-entry-fixture.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../dist/build-manifest.json', import.meta.url), 'utf8'));
const prior = JSON.parse(await readFile(new URL('./checkpoint400-final-source.json', import.meta.url), 'utf8'));
assert.equal(manifest.sourceDigest, prior.sourceDigest); assert.deepEqual(await evaluationBuildFiles(root), manifest.files);
const results = [];
for (const backend of ['sqlite', 'file-journal']) {
  const cleanups = [];
  try {
    const f = await residentEntryFixture({ after(callback) { cleanups.push(callback); } }, false, { stateBackend: backend });
    const registered = await f.register(), p = f.current(), writes = [], costs = [];
    const initialRefs = (await p.runtime.state(registered.workId)).artifacts.length;
    const commit = p.services.state.commit.bind(p.services.state);
    p.services.state.commit = async request => {
      const result = await commit(request);
      if (request.workId === registered.workId && result.kind === 'committed') writes.push({ refs: request.next.artifacts.length,
        requestBytes: Buffer.byteLength(JSON.stringify(request)), stateBytes: Buffer.byteLength(JSON.stringify(request.next)) });
      return result;
    };
    for (let i = 0; i < 7; i++) {
      await f.due(registered.workId); p.services.artifacts.resetMetrics();
      assert.equal((await f.driver().tick(registered.workId)).kind, 'wait'); costs.push(p.services.artifacts.metrics());
    }
    assert.equal(f.observed.inputs.first.length + f.observed.inputs.second.length + f.observed.compacts.length, 0);
    results.push({ backend, polls: 7, initialRefs, finalRefs: (await p.runtime.state(registered.workId)).artifacts.length,
      writes, firstPoll: costs[0], lastPoll: costs.at(-1), modelCalls: 0 });
  } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
}
const result = { baselineCommit: 'b9fa88d5acf051bc34e69d300b4b5a7f3003cc7a', sourceDigest: manifest.sourceDigest,
  compiledFilesMatch: true, node: process.version, platform: process.platform, arch: process.arch, results,
  measurement: 'Actual local artifact counters and serialized state/requests, not physical disk I/O or model tokens' };
await writeFile(new URL('./checkpoint401-baseline.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
