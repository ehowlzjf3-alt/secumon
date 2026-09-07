import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ioAdapters, ioFamilies, ioPageCounts, loadIoRuntime, measureCollectionIo, type IoFixtureResult } from './read-collection-io-helpers.js';

const semanticFields = ['itemBodyBytes', 'sourceSignature', 'resultSignature', 'coreStateSignature', 'sourceCalls', 'externalUsage', 'copyRepresentation', 'evidence'] as const;
const physicalFields = ['bodyReadBytes', 'hashBytes', 'bodyWriteBytes'] as const;
type ProvenanceFile = { path: string; sha256: string };
type LegacyCase = Pick<IoFixtureResult, 'adapter' | 'family' | 'pages' | typeof semanticFields[number]> & {
  physicalTotals: Record<typeof physicalFields[number], number>;
};
type LegacyFixture = { schemaVersion: 1; cases: LegacyCase[]; provenance: Record<'semanticSource' | 'physicalSource' | 'originalManifest' | 'instrumentedManifest' | 'instrumentedAdapter', ProvenanceFile> };
const legacy = JSON.parse(readFileSync(new URL('../../fixtures/internal-io/legacy-v024.json', import.meta.url), 'utf8')) as LegacyFixture;
assert.equal(legacy.schemaVersion, 1); assert.equal(legacy.cases.length, ioAdapters.length * ioFamilies.length * ioPageCounts.length);
assert.equal(new Set(legacy.cases.map(value => `${value.adapter}:${value.family}:${value.pages}`)).size, legacy.cases.length);
for (const name of ['semanticSource', 'physicalSource', 'originalManifest', 'instrumentedManifest', 'instrumentedAdapter'] as const) {
  const source = legacy.provenance[name]; assert.match(source.sha256, /^[0-9a-f]{64}$/);
  assert.equal(createHash('sha256').update(readFileSync(new URL(`../../${source.path}`, import.meta.url))).digest('hex'), source.sha256,
    `legacy I/O provenance changed: ${name}`);
}

for (const adapter of ioAdapters) for (const family of ioFamilies) for (const pages of ioPageCounts) {
  test(`collection I/O ${adapter} ${family}: ${pages} pages retain semantics across reads, copying and reopening`, { timeout: 120000 }, async t => {
    const modules = await loadIoRuntime(new URL('../', import.meta.url));
    const result = await measureCollectionIo(modules, new URL('../../fixtures/', import.meta.url), { adapter, family, pages });
    const expected = legacy.cases.find(value => value.adapter === adapter && value.family === family && value.pages === pages); assert.ok(expected);
    for (const field of semanticFields) assert.deepEqual(result[field], expected[field], `frozen v0.24 semantic regression: ${field}`);
    assert.equal(result.sourceCalls, pages); assert.equal(result.evidence.length, pages); assert.equal(new Set(result.evidence.map(e => e.id)).size, pages);
    assert.match(result.sourceSignature, /^[0-9a-f]{64}$/); assert.match(result.resultSignature, /^[0-9a-f]{64}$/); assert.match(result.coreStateSignature, /^[0-9a-f]{64}$/);
    assert.deepEqual(result.stages.map(stage => stage.name), ['collect', 'checkpointRead', 'callsGet', 'contextPrepare', 'reopenAndPrepare']);
    for (const stage of result.stages) {
      assert.ok(stage.artifactApi.get.calls > 0); assert.ok(stage.artifactApi.get.returnedBodyBytes > 0); assert.ok(stage.stateApi.get > 0);
      assert.equal(stage.artifactApi.get.failures, 0); assert.equal(stage.artifactApi.put.failures, 0);
      assert.ok(stage.physical, `physical instrumentation required: ${stage.name}`);
      for (const value of Object.values(stage.physical)) assert.ok(Number.isSafeInteger(value) && value >= 0);
    }
    for (const field of physicalFields) {
      const total = result.stages.reduce((sum, stage) => {
        const value = stage.physical![field]; assert.ok(value !== undefined && Number.isSafeInteger(value) && value >= 0); return sum + value;
      }, 0);
      assert.ok(total > 0 && total < expected.physicalTotals[field], `${field} must remain below instrumented v0.24: ${total} >= ${expected.physicalTotals[field]}`);
    }
    t.diagnostic(JSON.stringify({ adapter, family, pages, sourceCalls: result.sourceCalls, resultSignature: result.resultSignature,
      stages: result.stages.map(stage => ({ name: stage.name, get: stage.artifactApi.get.calls, exists: stage.artifactApi.exists.calls,
        put: stage.artifactApi.put.calls, returnedBodyBytes: stage.artifactApi.get.returnedBodyBytes, stateReads: stage.stateApi.get,
        receipts: stage.stateApi.receipt, commits: stage.stateApi.commit, physicalBodyBytes: stage.physical?.['bodyReadBytes'] ?? null })) }));
  });
}
