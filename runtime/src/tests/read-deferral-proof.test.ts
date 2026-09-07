import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskSpec } from '../domain/model.js';
import type { ReadCollectionSource, ReadDeferralProofInput, Tool, ToolDefinition } from '../application/ports.js';
import { createReadCollectionTool } from '../application/read-collections.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { artifact, attempt, initial } from './state-conformance-helpers.js';

const definition: ToolDefinition = { provider: 'fixture', id: 'fixture.read', version: '1', description: 'Synthetic deferral custody',
  effect: 'read', destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
  collection: { kind: 'paged', limits: { maxPages: 2, maxItems: 2, maxCalls: 4, maxPageBytes: 65536, maxCheckpointBytes: 262144, pageSize: 1 },
    deferralValidation: 'artifact-proof-v1' } };
const task: TaskSpec = { id: 'task', description: 'Read records', dependsOn: [], toolId: 'fixture.read', toolVersion: '1', effect: 'read',
  input: {}, maxAttempts: 1, satisfies: [] };
function pair() {
  const state = initial(); state.attempts = [attempt('running')];
  const input: ReadDeferralProofInput = { attemptId: 'attempt', task: structuredClone(task),
    request: { requestId: 'request', cursor: null, snapshot: null, retryItems: null, itemLimit: 1 },
    deferral: { kind: 'read_deferral', requestId: 'request', dueAt: 2000, reason: 'rate_limited', rawArtifact: artifact() } };
  return { state, input };
}
const tool = (validateReadDeferral?: Tool['validateReadDeferral']): Tool => ({ definition, execute: async () => { throw new Error('must_not_execute'); },
  ...(validateReadDeferral ? { validateReadDeferral } : {}) });

test('read deferral proof: a pinned marker rejects callback removal without replacing the active provider', () => {
  const contracts = new ToolContracts([tool(async () => true)], new AjvSchemas()); const installed = contracts.get('fixture.read', '1');
  assert.throws(() => new ToolContracts([tool()], new AjvSchemas()), /tool_deferral_validator_required/);
  assert.throws(() => contracts.replaceProvider('fixture', [tool()], { expectedEpoch: 1, sourceRevision: 'removed' }), /tool_deferral_validator_required/);
  assert.strictEqual(contracts.get('fixture.read', '1'), installed); assert.equal(contracts.providerEpoch('fixture'), 1);
  assert.throws(() => createReadCollectionTool({ definition, source: { fetch: async () => { throw new Error('must_not_fetch'); } } },
    () => { throw new Error('must_not_run'); }), /tool_deferral_validator_required/);
});

test('read deferral proof: callback capture and detached authority inputs prevent adapter mutation from changing validation', async () => {
  const { state, input } = pair(); const before = structuredClone({ state, input }); let checks = 0;
  const source: ReadCollectionSource = { fetch: async () => { throw new Error('must_not_fetch'); }, validateDeferral: async (copy, value) => {
    checks++; copy.policy.allowedLabels = []; value.task.id = 'other'; value.request.requestId = 'other'; value.deferral.dueAt = 0; return false;
  } };
  const registered = createReadCollectionTool({ definition, source }, () => { throw new Error('must_not_run'); });
  const contracts = new ToolContracts([registered], new AjvSchemas()); source.validateDeferral = async () => true;
  assert.equal(await contracts.validateReadDeferral(state, input), false); assert.equal(checks, 1); assert.deepEqual({ state, input }, before);
  const { rawArtifact: _raw, ...withoutOriginal } = input.deferral;
  assert.equal(await contracts.validateReadDeferral(state, { ...input, deferral: withoutOriginal }), false); assert.equal(checks, 1);
  assert.equal(await contracts.validateReadDeferral(state, { ...input, attemptId: 'other-attempt' }), false);
});

test('read deferral proof: same-definition replacement during async verification invalidates the in-flight claim', async () => {
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const contracts = new ToolContracts([tool(async () => { entered(); await gate; return true; })], new AjvSchemas());
  const { state, input } = pair(); const pending = contracts.validateReadDeferral(state, input); await ready;
  contracts.replaceProvider('fixture', [tool(async () => true)], { expectedEpoch: 1, sourceRevision: 'replaced' });
  release(); assert.equal(await pending, false); assert.equal(await contracts.validateReadDeferral(state, input), true);
});
