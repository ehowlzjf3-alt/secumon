import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerInputAssurance } from '../domain/computer-use.js';
import type { TaskSpec } from '../domain/model.js';
import type { ComputerBinding, ComputerDriver } from '../application/computer-use-ports.js';
import type { Tool } from '../application/ports.js';
import { ComputerInputAssuranceSchema } from '../application/computer-use-contracts.js';
import { createComputerTools, prepareComputerBinding } from '../application/computer-use.js';
import { ToolDefinitionSchema } from '../application/resource-contracts.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { BrokerError, ToolBroker } from '../application/tool-broker.js';
import { asJson } from '../application/plan-validator.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { computerHarness, computerLimits, submitComputerTask } from './computer-use-helpers.js';

function unusedDriver(inputAssurance?: ComputerInputAssurance) {
  let calls = 0; const unexpected = async (): Promise<never> => { calls++; throw new Error('assurance_test_must_not_call_driver'); };
  const driver: ComputerDriver = { identity: { id: 'assurance-fixture', version: '1' },
    ...(inputAssurance === undefined ? {} : { inputAssurance }), acquire: unexpected, observe: unexpected, act: unexpected, wait: unexpected, release: unexpected };
  return { driver, calls: () => calls };
}
function binding(driver: ComputerDriver): ComputerBinding {
  return { provider: 'fixture', id: 'fixture.ui', version: '1', description: 'Registered synthetic input contract', destination: 'local',
    labels: ['synthetic'], sessionId: 'fixture-document', limits: { ...computerLimits }, driver };
}
const tools = (driver: ComputerDriver) => createComputerTools(binding(driver), () => { throw new Error('assurance_test_must_not_execute_runner'); });
const digest = (value: unknown) => new Sha256Digester().digest(asJson(value));

test('computer input assurance: omission keeps the old tool shape without silently adding a default to its digest', () => {
  const legacy = unusedDriver(); const explicit = unusedDriver('synchronous-local-v1');
  const old = tools(legacy.driver); const declared = tools(explicit.driver);
  assert.equal(Object.hasOwn(prepareComputerBinding(binding(legacy.driver)).driver, 'inputAssurance'), false);
  for (let index = 0; index < old.length; index++) {
    assert.equal(Object.hasOwn(old[index]!.definition, 'computerInputAssurance'), false);
    assert.equal(Object.hasOwn(ToolDefinitionSchema.parse(old[index]!.definition), 'computerInputAssurance'), false);
    const { computerInputAssurance, ...withoutDeclaration } = declared[index]!.definition;
    assert.equal(computerInputAssurance, 'synchronous-local-v1');
    assert.deepEqual(old[index]!.definition, withoutDeclaration);
    assert.equal(digest(old[index]!.definition), digest(withoutDeclaration));
    assert.notEqual(digest(old[index]!.definition), digest(declared[index]!.definition));
  }
  assert.equal(legacy.calls(), 0); assert.equal(explicit.calls(), 0);
});

test('computer input assurance: renderer semantics are pinned for all four tools and cannot be changed through the original driver', () => {
  const source = unusedDriver('renderer-gated-dom-v1'); const bound = prepareComputerBinding(binding(source.driver));
  const registered = createComputerTools(bound, () => { throw new Error('unused'); });
  Object.defineProperty(source.driver, 'inputAssurance', { value: 'synchronous-local-v1', configurable: true });
  Object.defineProperty(source.driver, 'act', { value: async () => { throw new Error('replacement_must_not_run'); } });
  assert.equal(bound.driver.inputAssurance, 'renderer-gated-dom-v1'); assert.equal(Object.isFrozen(bound.driver), true);
  assert.deepEqual(registered.map(value => value.definition.computerInputAssurance), Array(4).fill('renderer-gated-dom-v1'));
  assert.deepEqual(registered.map(value => value.definition.effect), ['read', 'write', 'write', 'read']);
  assert.notEqual(bound.driver.act, source.driver.act); assert.equal(source.calls(), 0);
});

test('computer input assurance: unknown profiles and proof-free declarations are rejected before any adapter call', () => {
  const source = unusedDriver('renderer-gated-dom-v1'); const valid = tools(source.driver)[0]!;
  assert.equal(ComputerInputAssuranceSchema.parse('renderer-gated-dom-v1'), 'renderer-gated-dom-v1');
  for (const inputAssurance of ['native', 'exactly-once', '', null, {}, false]) {
    assert.equal(ComputerInputAssuranceSchema.safeParse(inputAssurance).success, false);
    assert.throws(() => prepareComputerBinding(binding({ ...source.driver, inputAssurance } as unknown as ComputerDriver)), /invalid_contract/);
    assert.equal(ToolDefinitionSchema.safeParse({ ...valid.definition, computerInputAssurance: inputAssurance }).success, false);
  }
  const { resultValidation: _proof, ...noProof } = valid.definition;
  assert.equal(ToolDefinitionSchema.safeParse(noProof).success, false);
  const missingValidator: Tool = { definition: valid.definition, execute: valid.execute };
  assert.throws(() => new ToolContracts([missingValidator], new AjvSchemas()), /tool_result_validator_required/);
  const contracts = new ToolContracts([valid], new AjvSchemas()); const previous = contracts.get(valid.definition.id, '1');
  assert.throws(() => contracts.replaceProvider('fixture', [missingValidator], { expectedEpoch: 1, sourceRevision: 'invalid-replacement' }), /tool_result_validator_required/);
  assert.strictEqual(contracts.get(valid.definition.id, '1'), previous); assert.equal(contracts.providerEpoch('fixture'), 1); assert.equal(source.calls(), 0);
});

test('computer input assurance: a profile declaration grants neither tool permission nor arbitrary browser commands', () => {
  const source = unusedDriver('renderer-gated-dom-v1'); const registered = tools(source.driver); const contracts = new ToolContracts(registered, new AjvSchemas());
  const task: TaskSpec = { id: 'observe', toolId: 'fixture.ui.observe', toolVersion: '1', description: 'Read the registered fixture',
    input: {}, dependsOn: [], effect: 'read', maxAttempts: 1, satisfies: [] };
  const policy = { tenantId: 'synthetic', principalId: 'learner', allowedTools: ['fixture.ui.observe'], allowedLabels: ['synthetic'], allowedDestinations: ['local'], allowWrites: true };
  assert.equal(contracts.check(task, policy), null);
  assert.equal(contracts.check(task, { ...policy, allowedTools: [] }), 'tool_permission_denied');
  assert.equal(contracts.check({ ...task, input: { url: 'unregistered-origin' } }, policy), 'invalid_tool_input');
  assert.equal(contracts.check({ ...task, input: { script: 'unregistered-script' } }, policy), 'invalid_tool_input');
  const continuation: TaskSpec = { ...task, toolId: 'fixture.ui.continue', effect: 'write', computerResume: { attemptId: 'parent', checkpointId: 'head', reconciliation: null } };
  assert.equal(contracts.check(continuation, { ...policy, allowedTools: ['fixture.ui.continue'], allowWrites: false }), 'tool_permission_denied');
  assert.equal(source.calls(), 0);
});

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: replacing input assurance after dispatch invalidates the pinned attempt before driver entry`, async t => {
    for (const original of [undefined, 'renderer-gated-dom-v1'] as const) {
      const source = unusedDriver(original); const h = await computerHarness(backend, { driver: source.driver }); t.after(() => h.close());
      const attempt = await submitComputerTask(h, 'observe'); assert.equal(await h.runtime.dispatch(h.workId, attempt.id), true);
      const before = (await h.state.get(h.workId))!; let entered = 0;
      const replacement = h.services.tools.filter(tool => tool.definition.provider === 'synthetic').map(tool => ({ ...tool,
        definition: { ...tool.definition, computerInputAssurance: original === undefined ? 'renderer-gated-dom-v1' as const : 'synchronous-local-v1' as const },
        async execute(): Promise<never> { entered++; throw new Error('changed_assurance_must_not_execute'); } }));
      h.contracts.replaceProvider('synthetic', replacement, { expectedEpoch: 1, sourceRevision: 'assurance-changed' });
      const broker = new ToolBroker(h.state, h.contracts, h.services.digester, h.services.clock);
      await assert.rejects(broker.invoke(h.workId, attempt.id, h.runtime.owner, new AbortController().signal),
        error => error instanceof BrokerError && error.code === 'tool_contract_changed');
      assert.equal(entered, 0); assert.equal(source.calls(), 0); assert.deepEqual(await h.state.get(h.workId), before);
    }
  });
}
