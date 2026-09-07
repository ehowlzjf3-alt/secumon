import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextCompiler } from '../application/context-compiler.js';
import { ModelInputBudgetError } from '../application/model-input-budget.js';
import { ToolContracts } from '../application/tool-contracts.js';
import type { ArtifactStore, ModelCallOptions, Tool } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock, FakeSink } from '../infrastructure/fakes.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { StructuredPlannerAdapter } from '../infrastructure/structured-planner.js';
import { initial, openRepository } from './state-conformance-helpers.js';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const limits = { callId: 'inspect-call', maxOutputTokens: 10, maxInputTokens: 1_000_000, maxInputBytes: 1_000_000 };
function tool(id: string): Tool {
  return { definition: { provider: id.startsWith('core.') ? 'core' : 'fixture', id, version: '1', description: '선택 경계 확인용 로컬 정의',
    effect: 'read', inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' }, destination: 'local', labels: ['synthetic'] },
  async execute() { throw new Error('no_tool_execution_expected'); } };
}
async function fixture(options: { optional?: boolean } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'context-selection-')));
  const repository = openRepository('sqlite', directory), store = new FileArtifactStore(join(directory, 'artifacts'));
  let writes = 0, calls = 0, estimates = 0;
  const artifacts: ArtifactStore = { get: store.get.bind(store), exists: store.exists.bind(store), async put(value, attributes) { writes++; return store.put(value, attributes); } };
  try {
    const tools = options.optional ? [tool('core.catalog.search'), tool('core.catalog.get'), tool('fixture.read')] : [tool('fixture.read')];
    const state = initial(); state.policy.allowedTools = tools.map(item => item.definition.id);
    assert.equal((await repository.commit({ workId: state.id, expectedRevision: 0, commandId: 'accept', commandDigest: 'accept', next: state,
      events: [{ type: 'accepted', at: state.createdAt, data: {} }], deliveries: [] })).kind, 'committed');
    const planner = new StructuredPlannerAdapter({ identity: { provider: 'fixture', model: 'selection', revision: '1' }, destination: 'local',
      capabilities: { structuredOutput: true, toolCalling: true, images: false, cancellation: true, maxInputTokens: 1_000_000 },
      ...(options.optional ? { inputEstimator: { profile: { id: 'fixture-selection', revision: '1', templateRevision: '1', kind: 'conservative_estimate' as const },
        estimate(request: unknown, serialized: string) { estimates++; const selected = (request as { options: ModelCallOptions }).options;
          return { tokens: selected.tools.some(item => item.id === 'fixture.read') ? 1000 : 1, bytes: Buffer.byteLength(serialized), method: 'fixture-token-pressure' }; } } } : {}),
    }, { async invoke() { calls++; throw new Error('no_model_execution_expected'); } });
    const services: RuntimeServices = { state: repository, artifacts, planner, clock: new FakeClock(state.createdAt), ids: new RandomIds(), digester: new Sha256Digester(), tools, sink: new FakeSink() };
    const compiler = new ContextCompiler(services, new ToolContracts(tools, new AjvSchemas()));
    return { state, repository, compiler, tools, writes: () => writes, calls: () => calls, estimates: () => estimates,
      close: async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await repository.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}

test('an exactly fitting mandatory request survives conservative selector item costs without writes during inspection', async t => {
  const f = await fixture(); t.after(f.close);
  const baseline = await f.compiler.inspect(f.state, limits); assert.equal(baseline.kind, 'fits');
  const exactLimits = { ...limits, maxInputBytes: baseline.requiredEstimate.bytes };
  const exact = await f.compiler.inspect(f.state, exactLimits);
  assert.equal(exact.kind, 'fits'); assert.deepEqual(exact.selectedEstimate, exact.requiredEstimate);
  assert.equal(f.writes(), 0); assert.equal(f.calls(), 0); assert.deepEqual(await f.repository.get(f.state.id), f.state);
  const prepared = await f.compiler.materialize(exact);
  assert.ok(prepared.estimate.bytes <= exactLimits.maxInputBytes); assert.deepEqual(prepared.options.tools, f.tools.map(item => item.definition));
  assert.equal(prepared.frame.decisions.filter(item => item.kind === 'tool').every(item => item.representation === 'full' && item.reason === 'required_full'), true);
  assert.equal(prepared.frame.memo.mode, 'compact'); assert.equal(f.writes(), 1); assert.equal(f.calls(), 0);
  assert.deepEqual(prepared.packet.goal, f.state.goal); assert.deepEqual(await f.repository.get(f.state.id), f.state);
  await assert.rejects(f.compiler.materialize(exact), /context_preparation_unavailable/);
});

test('token-driven optional reduction falls back to the verified mandatory selection and its normal memo', async t => {
  const f = await fixture({ optional: true }); t.after(f.close);
  const inspected = await f.compiler.inspect(f.state, { ...limits, maxInputTokens: 10 });
  assert.equal(inspected.kind, 'fits'); assert.equal(f.writes(), 0); assert.ok(f.estimates() <= 10, 'selection retries stay bounded');
  const prepared = await f.compiler.materialize(inspected);
  assert.deepEqual(prepared.options.tools.map(item => item.id).sort(), ['core.catalog.get', 'core.catalog.search']);
  assert.equal(prepared.frame.decisions.filter(item => item.kind === 'tool' && item.representation === 'omitted').length, 1);
  assert.equal(prepared.frame.decisions.filter(item => item.kind === 'tool' && item.representation === 'full').length, 2);
  assert.equal(prepared.estimate.tokens, 1); assert.equal(prepared.frame.memo.cycle, 1);
  assert.deepEqual(prepared.packet.goal, f.state.goal); assert.equal(f.calls(), 0);
});

test('invalid final request estimates remain provider-contract failures before a context frame is written', async t => {
  const f = await fixture(); t.after(f.close);
  for (const invalid of ['tokens', 'bytes', 'method'] as const) {
    const estimateInput = (packet: unknown, options: ModelCallOptions) => ({ tokens: invalid === 'tokens' ? NaN : 1,
      bytes: bytes({ packet, options }) - (invalid === 'bytes' ? 1 : 0), method: invalid === 'method' ? '' : 'fixture' });
    await assert.rejects(f.compiler.prepare(f.state, { ...limits, estimateInput }), error => error instanceof ModelInputBudgetError && error.code === 'model_input_estimate_invalid');
    const inspection = await f.compiler.inspect(f.state, { ...limits, estimateInput }); assert.equal(inspection.kind, 'fits');
    await assert.rejects(f.compiler.materialize(inspection), error => error instanceof ModelInputBudgetError && error.code === 'model_input_estimate_invalid');
  }
  await assert.rejects(f.compiler.prepare(f.state, { ...limits, maxInputTokens: 1,
    estimateInput: (packet, options) => ({ tokens: 2, bytes: bytes({ packet, options }), method: 'valid-too-large' }) }), /model_input_limit/);
  assert.equal(f.writes(), 0); assert.equal(f.calls(), 0); assert.deepEqual(await f.repository.get(f.state.id), f.state);
});
