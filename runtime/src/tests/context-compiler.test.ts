import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ArtifactStore, Tool } from '../application/ports.js';
import type { Evidence, Hypothesis, TaskSpec, WorkState } from '../domain/model.js';
import { decide } from '../domain/control.js';
import { evaluateCompletion } from '../domain/completion.js';
import { ContextCompiler } from '../application/context-compiler.js';
import { ContextFrameSchema, type ContextFrame } from '../application/context-contracts.js';
import { buildContextPacket } from '../application/context-packet.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { ToolResultSchema } from '../application/contracts.js';
import { validateScenario } from '../application/fixtures.js';
import { newWork } from '../application/new-work.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import { transact } from '../application/work-transactions.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FakeClock, FakeSink, FixtureReadTool } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { StructuredPlannerAdapter, type StructuredPlannerRequest } from '../infrastructure/structured-planner.js';
import { adapters, openRepository, type Adapter } from './state-conformance-helpers.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
const now = 1788566400000;
const clueMarker = 'INITIAL_SMALL_CLUE_TO_REDISCOVER';
const families = [
  { id: 'documents-complex', support: 'doc-a-old', counter: 'doc-b' },
  { id: 'observations-complex', support: 'signal', counter: 'maintenance-ticket' },
] as const;
type Family = typeof families[number];
const load = (family: Family) => validateScenario(JSON.parse(readFileSync(new URL(`../../fixtures/${family.id}.json`, import.meta.url), 'utf8')));
const task = (id: string, toolId: string, input: TaskSpec['input'], effect: TaskSpec['effect'] = 'read'): TaskSpec => ({
  id, description: `Synthetic context check ${id}`, toolId, toolVersion: '1', input, effect, dependsOn: [], maxAttempts: 1, satisfies: [],
});
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

async function setup(backend: Adapter, family: Family, settings: { catalogSize?: number; unknownEffect?: boolean; largeGoal?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'context-compiler-'));
  const state = openRepository(backend, directory); const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
  try {
    const scenario = load(family); const clock = new FakeClock(now); const requests: StructuredPlannerRequest[] = [];
    const planner = new StructuredPlannerAdapter({ identity: { provider: 'local-fixture', model: 'request-recorder', revision: '1' }, destination: 'local',
      capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 2000000 }, maxRequestBytes: 4 * 1024 * 1024 }, {
      async invoke(request) {
        requests.push(structuredClone(request));
        return { finish: 'stop', content: JSON.stringify({ baseStateRevision: request.packet.stateRevision, baseGoalRevision: request.packet.goal.revision,
          basePlanRevision: request.packet.plan?.revision ?? 0, reason: 'Local transport shape verification only', tasks: [], hypotheses: request.packet.hypotheses }),
        usage: { inputTokens: null, outputTokens: null }, provider: 'local-fixture', model: 'request-recorder' };
      },
    });
    const original = await artifacts.put(Buffer.from(`Original synthetic note: ${clueMarker}`), { tenantId: actor.tenantId, labels: ['synthetic'], mediaType: 'text/plain' });
    const extra = (id: string, facts: Evidence['facts'], observedAt: number): Evidence => ({ id, tenantId: actor.tenantId, scope: scenario.goal.scope,
      sourceId: id, lineageId: id, locator: `fixture://${family.id}/${id}`, observedAt, recordedAt: observedAt, labels: ['synthetic'],
      coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [], facts, artifact: null });
    const early = { ...extra('early-small-clue', { clue: clueMarker }, now), artifact: original };
    const rounds = Array.from({ length: 5 }, (_, index) => extra(`round-${index + 1}`, { unrelatedDetail: `ROUND_${index + 1}_${'x'.repeat(9000)}` }, now + index + 1));
    const source = new FixtureReadTool([...scenario.evidence, early, ...rounds]); let unknownCalls = 0;
    const unknown: Tool = { definition: { provider: 'fixture', id: 'fixture.unknown', version: '1', description: 'Return a synthetic unknown effect without external I/O.',
      effect: 'write', inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' }, destination: 'local', labels: ['synthetic'] },
    async execute(_task, context) { unknownCalls++; return { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, status: 'error', effectState: 'unknown',
      evidence: [], artifacts: [], output: null, error: { code: 'synthetic_outcome_unknown', retryable: false }, cursor: null, coverage: 'unknown' }; } };
    const largeCatalog: Tool[] = Array.from({ length: settings.catalogSize ?? 0 }, (_, index) => ({
      definition: { ...source.definition, id: `fixture.unused${index.toString().padStart(3, '0')}`,
        description: `Unused synthetic schema ${index}. ${'catalog padding '.repeat(280)}`,
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Schema explanation '.repeat(120) } }, required: ['query'], additionalProperties: false } },
      execute: async () => { throw new Error('catalog_entry_must_not_execute'); },
    }));
    const tools = [source, ...largeCatalog, ...(settings.unknownEffect ? [unknown] : [])];
    const goal = { ...scenario.goal, ...(settings.largeGoal ? { description: 'mandatory goal '.repeat(650) } : {}), criteria: [...scenario.goal.criteria,
      { id: 'unfinished', description: 'Keep the synthetic investigation open', key: 'not-yet-observed', operator: 'present' as const, equals: null, minIndependentSources: 1, requireCompleteCoverage: true }] };
    const initial = newWork({ id: 'work', now, goal, policy: { ...scenario.policy, allowedTools: [...tools.map(t => t.definition.id), ...RESOURCE_TOOL_IDS], allowWrites: settings.unknownEffect === true },
      limits: { toolCalls: 40, modelCalls: 10, tokens: 10000000, replans: 30, wallTimeMs: 1000000 } });
    assert.equal((await state.commit({ workId: initial.id, expectedRevision: 0, commandId: 'accept', commandDigest: 'synthetic-accept', next: initial,
      events: [{ type: 'accepted', at: now, data: {} }], deliveries: [] })).kind, 'committed');
    const composed = await composeRuntime({ services: { state, artifacts, planner, clock, ids: new RandomIds(), digester: new Sha256Digester(), tools, sink: new FakeSink() },
      schemas: new AjvSchemas(), guidanceSource: { list: async () => [], read: async () => { throw new Error('no_guidance'); } }, owner: 'compiler-test', enablePlanning: false });
    const compiler = new ContextCompiler(composed.services, composed.contracts, composed.guidance);
    return { ...composed, compiler, source, state, artifacts, planner, requests, clock, family, early, rounds, directory, unknownCalls: () => unknownCalls };
  } catch (error) { await state.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}
type Harness = Awaited<ReturnType<typeof setup>>;
async function fixture(backend: Adapter, family: Family, run: (f: Harness) => Promise<void>, settings: Parameters<typeof setup>[2] = {}) {
  const f = await setup(backend, family, settings);
  try { await run(f); } finally { await f.state.close(); await rm(f.directory, { recursive: true, force: true }); }
}
async function submit(f: Harness, tasks: TaskSpec[], hypotheses?: Hypothesis[]) {
  const state = await f.runtime.state('work');
  await f.runtime.submitPlan('work', `plan:${state.revision}`, { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
    basePlanRevision: state.plan?.revision ?? 0, reason: 'Acquire the next original before compacting', tasks, hypotheses: hypotheses ?? state.hypotheses });
}
async function execute(f: Harness, value: TaskSpec) {
  const attempt = await f.runtime.reserve('work', value.id); await f.runtime.execute('work', attempt.id); await f.runtime.adopt('work', attempt.id);
  const state = await f.runtime.state('work'); const settled = state.attempts.find(a => a.id === attempt.id)!;
  assert.ok(settled.resultArtifact); assert.ok(await f.state.receipt('work', `dispatch:${attempt.id}`));
  const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await f.artifacts.get(settled.resultArtifact, state.policy))));
  assert.equal(result.attemptId, attempt.id); assert.equal(result.resultId, settled.resultId);
  return { attempt: settled, result };
}
async function publish(f: Harness, prepared: Awaited<ReturnType<ContextCompiler['prepare']>>) {
  return transact(f.services, 'work', `compact:${prepared.head.basisRevision}:${prepared.head.cycle}`, 'context_compacted', { artifactId: prepared.head.artifact.id }, state => {
    if (state.revision !== prepared.head.basisRevision) throw new Error('context_state_changed');
    state.contextHead = structuredClone(prepared.head);
  });
}
function canonical(state: WorkState) {
  const { revision: _revision, updatedAt: _updatedAt, contextHead: _head, ...value } = state; return value;
}
async function assertCanonicalPairs(f: Harness, frame: ContextFrame) {
  const state = await f.runtime.state('work');
  for (const observation of frame.packet.toolObservations ?? []) {
    const attempt = state.attempts.find(a => a.id === observation.attemptId); assert.ok(attempt?.resultArtifact);
    const receipt = await f.state.receipt('work', `dispatch:${attempt.id}`); assert.ok(receipt);
    const dispatched = receipt.state.plan?.tasks.find(t => t.id === attempt.taskId); assert.ok(dispatched);
    assert.equal(observation.taskId, dispatched.id); assert.equal(observation.toolId, dispatched.toolId); assert.equal(observation.toolVersion, dispatched.toolVersion);
    assert.equal(observation.inputDigest, attempt.inputDigest); assert.deepEqual(observation.resultArtifact, attempt.resultArtifact);
    const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await f.artifacts.get(attempt.resultArtifact, state.policy))));
    assert.equal(observation.resultId, result.resultId); assert.equal(observation.status, result.status);
    if (observation.representation === 'full') { assert.deepEqual(observation.input, dispatched.input); assert.deepEqual(observation.output, result.output); }
    else { assert.equal(observation.input, undefined); assert.equal(observation.output, undefined); }
  }
}

for (const backend of adapters) for (const family of families) test(`context compiler ${backend}/${family.id}: five published working sets retain counterevidence and rediscover an early original`, async () => {
  await fixture(backend, family, async f => {
    const first = task('read-initial', 'fixture.read', { evidenceIds: [f.early.id, family.support, family.counter] });
    const tasks = [first]; await submit(f, tasks); const initialCall = await execute(f, first); assert.equal(initialCall.attempt.adopted, true);
    const hypothesis: Hypothesis = { id: 'initial-explanation', question: 'Which explanation fits the original records?', claim: 'The initial explanation is sufficient',
      predictedObservation: 'The independent record supports the initial explanation', falsifier: 'An independent record contradicts the initial explanation',
      status: 'contested', supportIds: [family.support], counterIds: [family.counter], reason: 'Keep both original records available for review' };
    const heads: string[] = []; const workingSets = new Set<string>(); let last: Awaited<ReturnType<ContextCompiler['prepare']>> | undefined;
    for (let index = 0; index < 5; index++) {
      f.clock.advance(1); const next = task(`read-round-${index + 1}`, 'fixture.read', { evidenceIds: [f.rounds[index]!.id] }); tasks.push(next);
      await submit(f, tasks, [hypothesis]); assert.equal((await execute(f, next)).attempt.adopted, true);
      const before = await f.runtime.state('work');
      const prepared = await f.compiler.prepare(before, { callId: `compact-${index + 1}`, maxOutputTokens: 512, maxInputBytes: 40000, maxInputTokens: 2000000, forceCompact: true });
      assert.deepEqual(await f.runtime.state('work'), before, 'prepare stages a frame without installing a head or modifying canonical state');
      assert.equal(prepared.frame.memo.cycle, index + 1); assert.equal(prepared.frame.memo.mode, 'compact'); assert.ok(prepared.estimate.bytes <= 40000);
      assert.equal(prepared.frame.basis.stateRevision, before.revision); assert.equal(prepared.head.basisRevision, before.revision);
      assert.deepEqual(prepared.packet.goal, before.goal); assert.deepEqual(prepared.packet.hypotheses, [hypothesis]);
      assert.deepEqual(prepared.packet.evidence.find(e => e.id === family.counter), before.evidence.find(e => e.id === family.counter));
      assert.deepEqual(prepared.packet.execution?.budget, before.budget); assert.equal(prepared.packet.execution?.deadlineAt, before.deadlineAt);
      assert.equal(prepared.frame.metrics.extraModelCalls, 0); assert.equal(f.requests.length, 0);
      assert.ok(prepared.packet.toolObservations?.length, 'canonical result pairs must be represented, not checked vacuously');
      workingSets.add(JSON.stringify(prepared.frame.decisions.filter(d => d.representation !== 'omitted').map(d => [d.key, d.digest, d.representation])));
      await assertCanonicalPairs(f, prepared.frame);
      const stored = ContextFrameSchema.parse(JSON.parse(new TextDecoder().decode(await f.artifacts.get(prepared.head.artifact, before.policy))));
      assert.deepEqual(stored, prepared.frame); const committed = await publish(f, prepared); assert.equal(committed.committed, true);
      assert.deepEqual(canonical(committed.state), canonical(before)); assert.equal(committed.state.artifacts.some(a => a.id === prepared.head.artifact.id), false);
      heads.push(prepared.head.artifact.id); last = prepared;
    }
    assert.equal(new Set(heads).size, 5); assert.equal(workingSets.size, 5); assert.ok(last);
    assert.equal(last.packet.evidence.some(e => e.id === f.early.id), false, 'the old clue body must actually leave the active context');
    assert.equal(last.frame.metrics.evictions > 0, true); assert.equal(f.source.invocations.length, 6);
    const compacted = await f.runtime.state('work');
    assert.deepEqual(compacted.evidence.find(e => e.id === f.early.id), f.early);
    assert.equal(evaluateCompletion(compacted.goal, compacted.evidence, compacted.obligations, compacted.policy).complete, false);
    const queries = [task('find-early', 'core.evidence.find', { query: clueMarker, limit: 5 }),
      task('reload-early', 'core.evidence.get', { evidenceId: f.early.id, detail: 'original', maxBytes: 4096 }),
      task('reload-counter', 'core.evidence.get', { evidenceId: family.counter, detail: 'evidence', maxBytes: 4096 }),
      task('replay-initial', 'core.calls.get', { attemptId: initialCall.attempt.id, maxBytes: 16384 })];
    await submit(f, [...tasks, ...queries]);
    for (const query of queries) {
      const result = await execute(f, query); assert.equal(result.attempt.adopted, true); assert.equal(result.result.status, 'success');
      if (query.id === 'find-early') assert.match(JSON.stringify(result.result.output), /early-small-clue/);
      if (query.id === 'reload-early') assert.match(JSON.stringify(result.result.output), /INITIAL_SMALL_CLUE_TO_REDISCOVER/);
      if (query.id === 'reload-counter') assert.match(JSON.stringify(result.result.output), new RegExp(family.counter));
      if (query.id === 'replay-initial') { assert.match(JSON.stringify(result.result.output), /historical_tool_result/); assert.match(JSON.stringify(result.result.output), /INITIAL_SMALL_CLUE_TO_REDISCOVER/); }
    }
    assert.equal(f.source.invocations.length, 6, 'resource retrieval must not execute the original source again'); assert.equal(f.requests.length, 0);
    assert.ok((await f.state.events('work', 0)).filter(e => e.type === 'context_compacted').length === 5);
  });
});

for (const backend of adapters) test(`context compiler ${backend}: five compactions preserve canonical unknown effect and timed response obligations`, async () => {
  await fixture(backend, families[0], async f => {
    const unknown = task('unknown-local-effect', 'fixture.unknown', {}, 'write'); await submit(f, [unknown]);
    const executed = await execute(f, unknown); assert.equal(executed.attempt.status, 'unknown'); assert.equal(executed.attempt.adopted, false);
    await f.runtime.command('work', 'wait-response', actor, 1, { kind: 'wait', obligation: { id: 'answer', kind: 'response', reason: 'Await the synthetic source owner',
      status: 'pending', wakeKey: 'source-owner-response', dueAt: now + 60000 } });
    for (let index = 0; index < 5; index++) {
      const before = await f.runtime.state('work'); const prepared = await f.compiler.prepare(before, { callId: `unknown-${index + 1}`, maxOutputTokens: 512,
        maxInputBytes: 40000, maxInputTokens: 2000000, forceCompact: true });
      assert.deepEqual(prepared.packet.obligations, before.obligations); assert.equal(prepared.packet.obligations.some(o => o.kind === 'effect_reconciliation' && o.status === 'pending'), true);
      const attempt = prepared.packet.execution?.attempts.find(a => a.id === executed.attempt.id); assert.ok(attempt);
      assert.equal(attempt.effectState, 'unknown'); assert.equal(attempt.status, 'unknown'); assert.deepEqual(attempt.resultArtifact, executed.attempt.resultArtifact);
      assert.deepEqual(decide(before, f.clock.now()), { kind: 'blocked', reason: 'effect_unknown' });
      assert.equal(prepared.frame.memo.cycle, index + 1); await assertCanonicalPairs(f, prepared.frame);
      const installed = await publish(f, prepared); assert.deepEqual(canonical(installed.state), canonical(before));
    }
    assert.equal(f.unknownCalls(), 1); assert.equal(f.requests.length, 0); assert.equal((await f.runtime.state('work')).budget.used.toolCalls, 1);
  }, { unknownEffect: true });
});

for (const backend of adapters) test(`context compiler ${backend}: selected schemas reduce the actual structured transport request and preserve precise byte accounting`, async t => {
  await fixture(backend, families[0], async f => {
    const state = await f.runtime.state('work'); const all = f.contracts.visible(state.policy);
    const baseline = f.planner.estimateInput(buildContextPacket(state, f.contracts), { callId: 'catalog-size', maxOutputTokens: 512, tools: all });
    const prepared = await f.compiler.prepare(state, { callId: 'catalog-size', maxOutputTokens: 512, maxInputBytes: 64000, maxInputTokens: 2000000, forceCompact: true });
    assert.equal(f.requests.length, 0, 'compaction must not invoke a model'); assert.deepEqual(await f.runtime.state('work'), state);
    assert.ok(prepared.options.tools.length < all.length); assert.ok(prepared.estimate.bytes < baseline.bytes / 2); assert.ok(prepared.estimate.bytes <= 64000);
    assert.deepEqual([...prepared.packet.activeToolIds].sort(), prepared.options.tools.map(t => t.id).sort());
    assert.deepEqual([...prepared.packet.policy.allowedTools].sort(), [...prepared.packet.activeToolIds].sort());
    assert.ok(prepared.packet.contextView!.omitted.tools > 0);
    const response = await f.planner.propose(prepared.packet, new AbortController().signal, prepared.options); assert.equal(response.status, 'ok'); assert.equal(f.requests.length, 1);
    const request = f.requests[0]!; const actual = bytes(request); const metrics = prepared.frame.metrics;
    assert.equal(actual, prepared.estimate.bytes); assert.equal(metrics.requestBytes, actual); assert.equal(metrics.packetBytes, bytes(request.packet));
    assert.equal(metrics.toolBytes, bytes(request.options.tools)); assert.equal(metrics.envelopeBytes, bytes({ packet: request.packet, options: request.options }));
    assert.ok(actual > metrics.envelopeBytes, 'the provider request includes identity, instructions and the response schema beyond the planner envelope');
    assert.equal(metrics.baselineToolBytes, bytes(all)); assert.equal(metrics.estimatedTokens, prepared.estimate.tokens); assert.equal(metrics.estimateMethod, 'utf8_bytes_estimate');
    assert.equal(metrics.outputTokenReservation, 512); assert.equal(metrics.extraModelCalls, 0); assert.equal(f.source.invocations.length, 0);
    assert.match(request.instructions, /JSON schema/); assert.equal(response.inputTokens, null); assert.equal(response.outputTokens, null);
    t.diagnostic(JSON.stringify({ backend, baselinePacketBytes: metrics.baselinePacketBytes, baselineToolBytes: metrics.baselineToolBytes,
      packetBytes: metrics.packetBytes, toolBytes: metrics.toolBytes, envelopeBytes: metrics.envelopeBytes, requestBytes: metrics.requestBytes,
      selectedToolCount: prepared.options.tools.length, catalogTotal: all.length }));
  }, { catalogSize: 72 });
});

for (const backend of adapters) test(`context compiler ${backend}: an oversized mandatory goal fails before candidate storage or transport`, async () => {
  await fixture(backend, families[0], async f => {
    const before = await f.runtime.state('work'); let writes = 0;
    const artifacts: ArtifactStore = { get: f.artifacts.get.bind(f.artifacts), exists: f.artifacts.exists.bind(f.artifacts),
      put: async (...args) => { writes++; return f.artifacts.put(...args); } };
    const compiler = new ContextCompiler({ ...f.services, artifacts }, f.contracts, f.guidance);
    await assert.rejects(compiler.prepare(before, { callId: 'mandatory-overflow', maxOutputTokens: 512, maxInputBytes: 8192, maxInputTokens: 2000000, forceCompact: true }), /model_input_limit/);
    assert.equal(writes, 0); assert.equal(f.requests.length, 0); assert.deepEqual(await f.runtime.state('work'), before);
  }, { largeGoal: true });
});
