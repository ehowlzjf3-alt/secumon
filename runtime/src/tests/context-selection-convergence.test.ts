import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextCompiler, type PreparedContext } from '../application/context-compiler.js';
import { ToolContracts } from '../application/tool-contracts.js';
import type { ArtifactStore, ModelCallOptions, Tool } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock, FakeSink } from '../infrastructure/fakes.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { StructuredPlannerAdapter } from '../infrastructure/structured-planner.js';
import { initial, openRepository } from './state-conformance-helpers.js';

const limits = { callId: 'convergence', maxOutputTokens: 10, maxInputTokens: 150, maxInputBytes: 1_000_000 };
const mandatory = ['core.catalog.get', 'core.catalog.search'];
const selectedIds = (options: ModelCallOptions) => options.tools.map(tool => tool.id).sort();

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'context-convergence-')));
  const repository = openRepository('sqlite', directory), store = new FileArtifactStore(join(directory, 'artifacts'));
  t.after(async () => { try { await repository.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  let writes = 0, modelCalls = 0, toolCalls = 0;
  const estimates: { tools: string[]; tokens: number; bytes: number }[] = [];
  const tools: Tool[] = [...mandatory, 'fixture.a', 'fixture.b'].map(id => ({
    definition: { provider: id.startsWith('core.') ? 'core' : 'fixture', id, version: '1',
      description: `Selection fixture ${id}. ` + 'x'.repeat(id === 'fixture.a' ? 1000 : id === 'fixture.b' ? 4000 : 0),
      effect: 'read', inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' },
      destination: 'local', labels: ['synthetic'] },
    async execute() { toolCalls++; throw new Error('unexpected_tool_execution'); },
  }));
  const artifacts: ArtifactStore = { get: store.get.bind(store), exists: store.exists.bind(store),
    async put(value, attributes) { writes++; return store.put(value, attributes); } };
  const state = initial(); state.policy.allowedTools = tools.map(tool => tool.definition.id);
  assert.equal((await repository.commit({ workId: state.id, expectedRevision: 0, commandId: 'accept', commandDigest: 'accept', next: state,
    events: [{ type: 'accepted', at: state.createdAt, data: {} }], deliveries: [] })).kind, 'committed');
  const planner = new StructuredPlannerAdapter({ identity: { provider: 'fixture', model: 'convergence', revision: '1' }, destination: 'local',
    capabilities: { structuredOutput: true, toolCalling: true, images: false, cancellation: true, maxInputTokens: 1_000_000 },
    inputEstimator: { profile: { id: 'optional-subset', revision: '1', templateRevision: '1', kind: 'conservative_estimate' },
      // Explicit finite estimator: exact wire bytes and independent token pressure. No tokenizer-quality claim.
      estimate(request: unknown, serialized: string) {
        const options = (request as { options: ModelCallOptions }).options;
        const tokens = 100 + options.tools.filter(tool => tool.id.startsWith('fixture.')).length * 40;
        const bytes = Buffer.byteLength(serialized); estimates.push({ tools: selectedIds(options), tokens, bytes });
        return { tokens, bytes, method: 'fixture-optional-token-pressure' };
      } },
  }, { async invoke() { modelCalls++; throw new Error('unexpected_model_execution'); } });
  const services: RuntimeServices = { state: repository, artifacts, planner, clock: new FakeClock(state.createdAt), ids: new RandomIds(),
    digester: new Sha256Digester(), tools, sink: new FakeSink() };
  const compiler = new ContextCompiler(services, new ToolContracts(tools, new AjvSchemas()));
  return { state, repository, planner, compiler, estimates, writes: () => writes,
    calls: () => ({ modelCalls, toolCalls }) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function proveIntermediateFit(f: Fixture) {
  const full = await f.compiler.prepare(f.state, { ...limits, maxInputTokens: 1000 });
  assert.deepEqual(selectedIds(full.options), [...mandatory, 'fixture.a', 'fixture.b']);
  assert.equal(full.estimate.tokens, 180); assert.ok(full.estimate.bytes < limits.maxInputBytes);
  const packet = structuredClone(full.packet), options = structuredClone(full.options);
  options.tools = options.tools.filter(tool => tool.id !== 'fixture.b');
  packet.activeToolIds = packet.activeToolIds.filter(id => id !== 'fixture.b');
  packet.policy.allowedTools = packet.policy.allowedTools.filter(id => id !== 'fixture.b');
  packet.contextView!.omitted.tools++;
  const intermediate = f.planner.estimateInput(packet, options);
  assert.equal(intermediate.tokens, 140); assert.ok(intermediate.tokens <= limits.maxInputTokens);
  assert.ok(intermediate.bytes <= limits.maxInputBytes);
  assert.deepEqual(selectedIds(options), [...mandatory, 'fixture.a']);
  assert.deepEqual(await f.repository.get(f.state.id), f.state);
  return { full: full.estimate, intermediate, candidateBytes: full.frame.decisions.reduce((sum, decision) => sum + decision.bytes, 0) };
}

async function assertRetained(f: Fixture, prepared: PreparedContext, writesBefore: number) {
  assert.deepEqual(selectedIds(prepared.options), [...mandatory, 'fixture.a'], 'a fitting optional subset must survive unused-byte-budget convergence');
  assert.equal(prepared.estimate.tokens, 140); assert.ok(prepared.estimate.bytes <= limits.maxInputBytes);
  assert.deepEqual(prepared.packet.activeToolIds.slice().sort(), selectedIds(prepared.options));
  assert.deepEqual(prepared.packet.policy.allowedTools.slice().sort(), selectedIds(prepared.options));
  assert.deepEqual(prepared.packet.goal, f.state.goal);
  assert.ok(prepared.frame.decisions.filter(value => mandatory.some(id => value.key.includes(id))).every(value => value.representation === 'full'));
  assert.equal(prepared.frame.memo.cycle, 1); assert.equal(f.writes(), writesBefore + 1);
  assert.deepEqual(f.calls(), { modelCalls: 0, toolCalls: 0 });
  assert.deepEqual(await f.repository.get(f.state.id), f.state);
}

test('inspect retains a measured fitting optional subset when byte capacity exceeds the chosen items', { timeout: 15000 }, async t => {
  const f = await fixture(t), proof = await proveIntermediateFit(f), writesBefore = f.writes(), estimatesBefore = f.estimates.length;
  const inspection = await f.compiler.inspect(f.state, limits);
  assert.equal(inspection.kind, 'fits'); assert.equal(f.writes(), writesBefore);
  assert.deepEqual(await f.repository.get(f.state.id), f.state);
  const prepared = await f.compiler.materialize(inspection);
  t.diagnostic(JSON.stringify({ path: 'inspect', proof, selected: selectedIds(prepared.options),
    observedEstimates: f.estimates.slice(estimatesBefore), frameWrites: f.writes() - writesBefore, calls: f.calls() }));
  assert.ok(f.estimates.length - estimatesBefore <= 10, 'inspection selection and final measurement remain bounded');
  await assertRetained(f, prepared, writesBefore);
});

test('prepare retains a measured fitting optional subset instead of exhausting unused-byte-budget retries', { timeout: 15000 }, async t => {
  const f = await fixture(t), proof = await proveIntermediateFit(f), writesBefore = f.writes(), estimatesBefore = f.estimates.length;
  let prepared: PreparedContext;
  try { prepared = await f.compiler.prepare(f.state, limits); }
  catch (error) {
    t.diagnostic(JSON.stringify({ path: 'prepare', proof, error: error instanceof Error ? error.message : String(error),
      observedEstimates: f.estimates.slice(estimatesBefore), frameWrites: f.writes() - writesBefore, calls: f.calls() }));
    throw error;
  }
  t.diagnostic(JSON.stringify({ path: 'prepare', proof, selected: selectedIds(prepared.options),
    observedEstimates: f.estimates.slice(estimatesBefore), frameWrites: f.writes() - writesBefore, calls: f.calls() }));
  assert.ok(f.estimates.length - estimatesBefore <= 8, 'prepare selection and final measurement remain bounded');
  await assertRetained(f, prepared, writesBefore);
});
