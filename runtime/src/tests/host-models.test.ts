import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentTurnProfile } from '../application/agent-turn-types.js';
import type { Planner } from '../application/ports.js';
import { StructuredAgentTurnAdapter } from '../infrastructure/structured-agent-turn.js';
import { closeAgentTurnResources, openRegisteredHostModel, resolveHostModelRegistration,
  type AgentTurnHost, type HostModelRegistration, type OpenedHostModel, type RegisteredTurnPlanner } from '../presentation/host-models.js';

const profile: AgentTurnProfile = { agentId: 'registered-unit-agent', purpose: '등록 경계를 확인한다.', skillsMode: 'off' };
function model(input = profile) {
  let calls = 0, closes = 0;
  const adapter = new StructuredAgentTurnAdapter({ profile: input, identity: { provider: 'host-fixture', model: 'json-unit', revision: '1' }, destination: 'local',
    capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 80000,
      contextWindowTokens: 90000, maxOutputTokens: 1024 } },
  { async invoke() { calls++; throw new Error('unexpected_model_call'); } });
  const planner: RegisteredTurnPlanner = { identity: structuredClone(adapter.identity), prompt: structuredClone(adapter.prompt),
    destination: adapter.destination, capabilities: structuredClone(adapter.capabilities), inputEstimation: structuredClone(adapter.inputEstimation),
    propose: adapter.propose.bind(adapter), turn: adapter.turn.bind(adapter), estimateTurnInput: adapter.estimateTurnInput.bind(adapter),
    estimateContextPreview: adapter.estimateContextPreview.bind(adapter) };
  const lease: OpenedHostModel = { planner, inputLimits: { maxInputBytes: 64000, maxOutputTokens: 512 }, close: async () => { closes++; } };
  return { lease, calls: () => calls, closes: () => closes };
}
function registration(lease: OpenedHostModel): HostModelRegistration {
  return { execution: 'deterministic_fixture', open: async () => lease };
}

test('host registration resolves one exact name and captures its method and execution before map changes', async () => {
  const f = model(), original = registration(f.lease), models = new Map([['local-contract', original]]);
  const selected = resolveHostModelRegistration({ models }, 'local-contract');
  original.open = async () => { throw new Error('replacement_not_selected'); };
  original.execution = 'host_transport'; models.delete('local-contract');
  assert.equal(selected.execution, 'deterministic_fixture'); assert.equal(Object.isFrozen(selected), true);
  const opened = await openRegisteredHostModel(selected, profile);
  assert.equal(opened.planner.identity.model, 'json-unit'); assert.equal(f.calls(), 0);
  await opened.close(); assert.equal(f.closes(), 1);
});

test('absent, foreign-shaped and malformed registrations never trigger a factory or module lookup', () => {
  let opens = 0;
  const host: AgentTurnHost = { models: new Map([['known', { execution: 'deterministic_fixture', open: async () => { opens++; return model().lease; } }]]) };
  for (const name of [null, 'unknown', '../some-module.js', 'file:///not-loaded'])
    assert.throws(() => resolveHostModelRegistration(host, name), /agent_turn_provider_unavailable/);
  assert.throws(() => resolveHostModelRegistration(undefined, 'known'), /agent_turn_provider_unavailable/);
  assert.throws(() => resolveHostModelRegistration(host, ' known '), /agent_model_registration_invalid/);
  assert.throws(() => resolveHostModelRegistration({ models: {} } as AgentTurnHost, 'known'), /agent_model_registration_invalid/);
  assert.throws(() => resolveHostModelRegistration({ models: new Map([['known', { execution: 'remote', open() {} }]]) } as unknown as AgentTurnHost, 'known'), /agent_model_registration_invalid/);
  assert.equal(opens, 0);
});

test('factory receives only the frozen prompt profile and opened metadata and methods are captured without mutating the host object', async () => {
  const f = model(); let received: AgentTurnProfile | undefined, originalEstimates = 0;
  f.lease.planner.estimateTurnInput = () => { originalEstimates++; return { bytes: 77, tokens: 77, method: 'captured-unit' }; };
  const opened = await openRegisteredHostModel({ execution: 'host_transport', async open(value) { received = value; return f.lease; } }, profile);
  assert.deepEqual(received, profile); assert.notEqual(received, profile); assert.equal(Object.isFrozen(received), true);
  assert.deepEqual(Object.keys(received!).sort(), ['agentId', 'purpose', 'skillsMode']);
  assert.equal(Object.isFrozen(f.lease.planner), false); assert.equal(Object.isFrozen(opened.planner), true);
  assert.equal(Object.isFrozen(opened.planner.capabilities), true); assert.equal(Object.isFrozen(opened.planner.prompt.profile), true);
  assert.equal(Object.isFrozen(opened.inputLimits), true);
  f.lease.planner.identity.model = 'changed'; f.lease.planner.capabilities.maxInputTokens = 1;
  f.lease.planner.prompt.profile.purpose = 'changed'; f.lease.inputLimits.maxOutputTokens = 900;
  f.lease.planner.estimateTurnInput = () => { throw new Error('replacement_not_called'); };
  assert.equal(opened.planner.identity.model, 'json-unit'); assert.equal(opened.planner.capabilities.maxInputTokens, 80000);
  assert.equal(opened.planner.prompt.profile.purpose, profile.purpose); assert.equal(opened.inputLimits.maxOutputTokens, 512);
  const measured = opened.planner.estimateTurnInput({} as never, {} as never);
  assert.equal(measured.method, 'captured-unit'); assert.equal(originalEstimates, 1); assert.equal(f.calls(), 0);
  await Promise.all([opened.close(), opened.close()]); await opened.close(); assert.equal(f.closes(), 1);
});

test('prompt identity, fixed instructions, capabilities and input reservation failures close the acquired lease', async () => {
  const cases: ((f: ReturnType<typeof model>) => void)[] = [
    f => { f.lease.planner.prompt.profile.agentId = 'other-agent'; },
    f => { f.lease.planner.prompt.instructions += '\nchanged'; },
    f => { f.lease.planner.capabilities.structuredOutput = false; },
    f => { f.lease.inputLimits.maxOutputTokens = 1025; },
    f => { f.lease.inputLimits.maxInputBytes = Number.NaN; },
    f => { Reflect.set(f.lease.planner, 'estimateContextPreview', undefined); },
    f => { Reflect.set(f.lease.planner, 'identity', { provider: 'fixture', model: 'missing-revision' }); },
  ];
  for (const change of cases) {
    const f = model(); change(f);
    await assert.rejects(openRegisteredHostModel(registration(f.lease), profile), /agent_model_registration_invalid/);
    assert.equal(f.closes(), 1); assert.equal(f.calls(), 0);
  }
});

test('compact requires both methods and captured methods keep their host receiver', async () => {
  for (const which of ['compact', 'estimateCompactInput'] as const) {
    const f = model(); Reflect.set(f.lease.planner, which, () => undefined);
    await assert.rejects(openRegisteredHostModel(registration(f.lease), profile), /agent_model_registration_invalid/);
    assert.equal(f.closes(), 1);
  }
  const f = model(); const source = f.lease.planner;
  source.compact = async function (this: Planner) {
    assert.equal(this, source);
    return { status: 'refused', code: 'local_fixture_only', inputTokens: 0, outputTokens: 0 };
  };
  source.estimateCompactInput = function (this: Planner) { assert.equal(this, source); return { tokens: 1, bytes: 1, method: 'unit' }; };
  const opened = await openRegisteredHostModel(registration(f.lease), profile);
  assert.equal((await opened.planner.compact!({} as never, new AbortController().signal, {} as never)).status, 'refused');
  assert.equal(opened.planner.estimateCompactInput!({} as never, {} as never).method, 'unit');
  await opened.close(); assert.equal(f.closes(), 1); assert.equal(f.calls(), 0);
});

test('factory errors retain their original object and validation plus cleanup failures retain both causes', async () => {
  const original = new Error('factory_open_failed');
  await assert.rejects(openRegisteredHostModel({ execution: 'host_transport', open: async () => { throw original; } }, profile), error => error === original);
  const f = model(), cleanup = new Error('close_failed'); f.lease.inputLimits.maxInputBytes = 0;
  f.lease.close = async () => { throw cleanup; };
  await assert.rejects(openRegisteredHostModel(registration(f.lease), profile), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2);
    assert.match((error.errors[0] as Error).message, /agent_model_registration_invalid/);
    assert.equal(error.errors[1], cleanup); assert.equal(error.cause, error.errors[0]); return true;
  });
});

test('resource cleanup attempts every closer and preserves single or multiple original failures', async () => {
  const primary = new Error('original'), modelError = new Error('model_close'), storesError = new Error('stores_close'), order: string[] = [];
  await assert.rejects(closeAgentTurnResources([
    async () => { order.push('model'); throw modelError; }, async () => { order.push('stores'); throw storesError; },
  ], { error: primary }), error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [primary, modelError, storesError]); assert.equal(error.cause, primary); return true;
  });
  assert.deepEqual(order, ['model', 'stores']);
  await assert.rejects(closeAgentTurnResources([async () => { throw modelError; }]), error => error === modelError);
});
