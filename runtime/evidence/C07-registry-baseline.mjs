import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { BoardWorkSourceRegistry } from '../dist/application/board-work-source-registry.js';
import { initial, artifact } from '../dist/tests/state-conformance-helpers.js';

const state = initial(), owner = { tenantId: state.policy.tenantId, principalId: state.policy.principalId };
const identity = { ...owner, workId: state.id };
const inspection = { version: 'fixture', sourceWorkIds: [], knowledgeDependencies: [], bytesRead: 0, current: async () => true };
const source = id => ({ inputs: { id, state: { get: async key => key === state.id ? state : null },
  authority: { resolve: async () => null }, inspectInput: async () => inspection, inspectMemory: async () => inspection,
  inspectCoverage: async () => inspection, effectsCurrent: async () => true },
  artifacts: { get: async () => new Uint8Array(), exists: async () => false }, current: async () => true });
const observed = [];
{
  const registry = new BoardWorkSourceRegistry();
  const oldClose = registry.register(owner, source('same-source')); oldClose();
  registry.register(owner, source('same-source')); oldClose();
  const replacementMissing = await registry.resolve(identity) === null;
  assert.equal(replacementMissing, true, 'baseline reproduction expects the original defect');
  observed.push({ case: 'repeated_old_unregister_removes_new_registration', reproduced: replacementMissing });
}
for (const operation of ['inspectInput', 'inspectMemory', 'inspectCoverage']) {
  const registry = new BoardWorkSourceRegistry(), raw = source(operation);
  let release; const gate = new Promise(resolve => { release = resolve; });
  raw.inputs[operation] = async () => { await gate; return inspection; };
  const unregister = registry.register(owner, raw), selected = await registry.resolve(identity);
  const args = operation === 'inspectInput' ? [{ provider: 'fixture', workId: state.id, artifact: artifact() }, state, owner, new AbortController().signal]
    : operation === 'inspectMemory' ? [[], owner, new AbortController().signal, state] : [state];
  const pending = selected.inputs[operation](...args); unregister(); release();
  const deliveredAfterUnregister = await pending === inspection;
  assert.equal(deliveredAfterUnregister, true, 'baseline reproduction expects the original defect');
  observed.push({ case: `${operation}_delivers_after_unregister`, reproduced: deliveredAfterUnregister });
}
const manifest = JSON.parse(readFileSync(new URL('../dist/build-manifest.json', import.meta.url), 'utf8'));
const result = { purpose: 'defect reproduction, not passing acceptance', baselineCommit: '69f84d5', sourceDigest: manifest.sourceDigest, observed };
writeFileSync(new URL('./C07-registry-baseline.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
