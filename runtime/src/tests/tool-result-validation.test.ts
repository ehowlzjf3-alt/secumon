import test from 'node:test';
import assert from 'node:assert/strict';
import type { ToolResult } from '../domain/model.js';
import type { Tool } from '../application/ports.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { asJson } from '../application/plan-validator.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { attempt, initial } from './state-conformance-helpers.js';

function source(validateResult?: Tool['validateResult'], marker = true): Tool {
  return { definition: { provider: 'fixture', id: 'fixture.read', version: '1', description: 'Read original artifact proof', effect: 'read',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, destination: 'local', labels: ['synthetic'],
    ...(marker ? { resultValidation: 'artifact-proof-v1' as const } : {}) },
    execute: async () => { throw new Error('validation_must_not_execute'); }, ...(validateResult ? { validateResult } : {}) };
}
function pair() {
  const state = initial(); state.attempts = [attempt('received')];
  const result: ToolResult = { resultId: 'result', attemptId: state.attempts[0]!.id, status: 'success', effectState: 'none',
    evidence: [], artifacts: [], output: { checked: true }, error: null, cursor: null, coverage: 'complete' };
  return { state, result };
}
const makeContracts = (tools: Tool[]) => new ToolContracts(tools, new AjvSchemas());

test('tool result validation: proof requirement is part of the contract and missing callbacks reject registration atomically', () => {
  const digester = new Sha256Digester(); const plain = source(undefined, false); const marked = source();
  assert.notEqual(digester.digest(asJson(plain.definition)), digester.digest(asJson(marked.definition)));
  assert.throws(() => makeContracts([marked]), /tool_result_validator_required/);
  const contracts = makeContracts([source(async () => true)]); const before = contracts.get('fixture.read', '1'); const revision = contracts.revision;
  assert.throws(() => contracts.replaceProvider('fixture', [marked], { expectedEpoch: 1, sourceRevision: 'callback-removed' }), /tool_result_validator_required/);
  assert.equal(contracts.providerEpoch('fixture'), 1); assert.equal(contracts.revision, revision);
  assert.strictEqual(contracts.get('fixture.read', '1'), before, 'a rejected listing must leave the prior validator installed');
});

test('tool result validation: assigning new fields or callback on the original adapter cannot alter a registered proof', async () => {
  let checks = 0;
  const original = source(async () => { checks++; return false; }); const contracts = makeContracts([original]);
  original.validateResult = async () => true; original.definition.description = 'mutated metadata'; delete original.definition.resultValidation;
  const registered = contracts.get('fixture.read', '1')!;
  assert.equal(registered.tool.definition.resultValidation, 'artifact-proof-v1'); assert.equal(registered.tool.definition.description, 'Read original artifact proof');
  const { state, result } = pair(); assert.equal(await contracts.validateResult(state, result), false); assert.equal(checks, 1);
  assert.equal(Object.isFrozen(registered.tool), true); assert.equal(Object.isFrozen(registered.tool.definition), true);
});

test('tool result validation: provider callback receives detached state and result values', async () => {
  const { state, result } = pair(); const before = structuredClone({ state, result });
  const contracts = makeContracts([source(async (view, response) => {
    view.goal.description = 'changed by adapter'; view.policy.allowedLabels.push('unrequested'); view.attempts[0]!.toolId = 'another.tool';
    response.output = { changed: true }; response.evidence.push({ id: 'fabricated' } as never); response.status = 'error';
    return true;
  })]);
  assert.equal(await contracts.validateResult(state, result), true); assert.deepEqual({ state, result }, before);
});

test('tool result validation: same-version replacement while awaiting a proof invalidates the pending answer', async () => {
  let entered!: () => void; const entering = new Promise<void>(resolve => { entered = resolve; });
  let release!: (value: boolean) => void; const held = new Promise<boolean>(resolve => { release = resolve; });
  const contracts = makeContracts([source(async () => { entered(); return held; })]); const { state, result } = pair();
  const pending = contracts.validateResult(state, result); await entering;
  contracts.replaceProvider('fixture', [source(async () => true)], { expectedEpoch: 1, sourceRevision: 'same-definition-new-registration' });
  release(true); assert.equal(await pending, false);
  assert.equal(await contracts.validateResult(state, result), true, 'a subsequent validation uses the newly installed proof callback');
});

test('tool result validation: removal or unrelated provider refresh has the correct registration scope', async () => {
  for (const change of ['remove', 'unrelated'] as const) {
    let entered!: () => void; const entering = new Promise<void>(resolve => { entered = resolve; });
    let release!: (value: boolean) => void; const held = new Promise<boolean>(resolve => { release = resolve; });
    const contracts = makeContracts([source(async () => { entered(); return held; })]); const { state, result } = pair();
    const pending = contracts.validateResult(state, result); await entering;
    if (change === 'remove') contracts.replaceProvider('fixture', [], { expectedEpoch: 1, sourceRevision: 'removed' });
    else contracts.replaceProvider('other', [], { expectedEpoch: 0, sourceRevision: 'unrelated' });
    release(true); assert.equal(await pending, change === 'unrelated');
  }
});

test('tool result validation: legacy tools retain optional validation and rejected or malformed proofs fail closed', async () => {
  const { state, result } = pair(); assert.equal(await makeContracts([source(undefined, false)]).validateResult(state, result), true);
  const validators: Tool['validateResult'][] = [async () => false, async () => { throw new Error('SYNTHETIC_PRIVATE_VALIDATOR_ERROR'); },
    async () => 'true' as never];
  for (const validate of validators) assert.equal(await makeContracts([source(validate, false)]).validateResult(state, result), false);
  assert.equal(await makeContracts([source(async () => true)]).validateResult(state, { ...result, attemptId: 'unregistered-attempt' }), false);
});
