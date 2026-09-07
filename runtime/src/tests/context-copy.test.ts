import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { GuidanceSource } from '../application/guidance.js';
import type { Tool } from '../application/ports.js';
import type { TaskSpec } from '../domain/model.js';
import { ContextCompiler } from '../application/context-compiler.js';
import { GuidanceCatalog } from '../application/guidance.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import { transact } from '../application/work-transactions.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { FakeClock, FakeSink, ScriptedPlanner, SequenceIds } from '../infrastructure/fakes.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { initial, command } from './state-conformance-helpers.js';

const guidanceMarker = 'SYNTHETIC_OLD_GUIDANCE_BODY_COPIED_TWICE';
const privateMarker = 'SYNTHETIC_REVOKED_TOOL_BODY_COPIED_TWICE';
const limits = { callId: 'copy-review', maxOutputTokens: 100, maxInputBytes: 100000, maxInputTokens: 200000, forceCompact: true };
function source(version: string, body: string): GuidanceSource {
  return { list: async () => [{ id: 'core.copy-guide', version, title: 'Synthetic copy guidance', summary: 'Local copied guidance review', source: 'synthetic',
    tenantId: 'tenant-a', labels: ['synthetic'], supportedKinds: ['lookup'], sha256: createHash('sha256').update(body).digest('hex'),
    byteLength: Buffer.byteLength(body), requiredRules: ['Keep source provenance.'] }], read: async () => Buffer.from(body) };
}
async function setup() {
  const state = new MemoryStateRepository(); const value = initial(); value.policy.allowedTools = [...RESOURCE_TOOL_IDS, 'fixture.private']; value.budget.limits.tokens = 1000000;
  assert.equal((await state.commit(command(value, 'seed'))).kind, 'committed');
  let invocations = 0;
  const tool: Tool = { definition: { provider: 'fixture', id: 'fixture.private', version: '1', description: 'Return a synthetic tool body.', effect: 'read',
    inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' }, destination: 'local', labels: ['synthetic'] },
  async execute(_task, context) { invocations++; return { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, status: 'success', effectState: 'none',
    evidence: [], artifacts: [], output: { body: privateMarker }, error: null, cursor: null, coverage: 'complete' }; } };
  const planner = new ScriptedPlanner([]);
  const composed = await composeRuntime({ services: { state, artifacts: new MemoryArtifactStore(), clock: new FakeClock(1000), sink: new FakeSink(), planner,
    ids: new SequenceIds(), digester: new Sha256Digester(), tools: [tool] }, schemas: new AjvSchemas(),
  guidanceSource: source('1', guidanceMarker), owner: 'copy-test', enablePlanning: false });
  const tasks: TaskSpec[] = [];
  async function run(id: string, toolId: string, input: TaskSpec['input']) {
    const before = await composed.runtime.state(value.id);
    tasks.push({ id, toolId, toolVersion: '1', description: 'Synthetic canonical copy', input, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] });
    await composed.runtime.submitPlan(value.id, `plan:${id}`, { baseStateRevision: before.revision, baseGoalRevision: 1, basePlanRevision: before.plan?.revision ?? 0,
      tasks, reason: 'Read an original or a recorded call', hypotheses: [] });
    const reserved = await composed.runtime.reserve(value.id, id); await composed.runtime.execute(value.id, reserved.id); await composed.runtime.adopt(value.id, reserved.id);
    const current = await composed.runtime.state(value.id); const attempt = current.attempts.find(a => a.id === reserved.id)!;
    assert.equal(attempt.status, 'succeeded'); assert.equal(attempt.adopted, true); assert.ok(attempt.resultArtifact);
    const receipt = await state.receipt(value.id, `dispatch:${attempt.id}`); assert.ok(receipt);
    assert.deepEqual(receipt.state.plan!.tasks.find(t => t.id === id)!.input, input);
    return attempt;
  }
  return { ...composed, state, planner, workId: value.id, run, invocations: () => invocations };
}

test('context copy: a canonical two-level invocation copy cannot restore guidance body after its catalog version is replaced', async () => {
  const f = await setup();
  try {
    const original = await f.run('guide', 'core.guidance.load', { id: 'core.copy-guide', version: '1', kind: 'lookup', reason: 'Inspect the original synthetic guide', maxBytes: 4096 });
    const first = await f.run('copy-one', 'core.calls.get', { attemptId: original.id, maxBytes: 16384 });
    const second = await f.run('copy-two', 'core.calls.get', { attemptId: first.id, maxBytes: 32768 });
    const current = await f.runtime.state(f.workId);
    const before = await new ContextCompiler(f.services, f.contracts, f.guidance).prepare(current, limits);
    assert.match(JSON.stringify(before.packet), new RegExp(guidanceMarker));
    const replacement = await GuidanceCatalog.create(source('2', 'SYNTHETIC_CURRENT_GUIDANCE_BODY'));
    const prepared = await new ContextCompiler(f.services, f.contracts, replacement).prepare(current, limits);
    assert.doesNotMatch(JSON.stringify(prepared.packet), new RegExp(guidanceMarker));
    for (const attempt of [original, first, second]) {
      const observation = prepared.packet.toolObservations?.find(o => o.attemptId === attempt.id);
      if (observation) { assert.equal(observation.representation, 'reference'); assert.equal(observation.input, undefined); assert.equal(observation.output, undefined); }
    }
    assert.deepEqual(await f.runtime.state(f.workId), current); assert.equal(f.planner.inputs.length, 0); assert.equal(f.invocations(), 0);
  } finally { await f.state.close(); }
});

test('context copy: two nested call results stop exposing a tool body when original tool permission is revoked', async () => {
  const f = await setup();
  try {
    const original = await f.run('read-private', 'fixture.private', {});
    const first = await f.run('copy-one', 'core.calls.get', { attemptId: original.id, maxBytes: 16384 });
    const second = await f.run('copy-two', 'core.calls.get', { attemptId: first.id, maxBytes: 32768 });
    const before = await new ContextCompiler(f.services, f.contracts, f.guidance).prepare(await f.runtime.state(f.workId), limits);
    assert.match(JSON.stringify(before.packet), new RegExp(privateMarker));
    await transact(f.services, f.workId, 'revoke-source-tool', 'policy_changed', {}, state => { state.policy.allowedTools = state.policy.allowedTools.filter(id => id !== 'fixture.private'); });
    const current = await f.runtime.state(f.workId); const prepared = await new ContextCompiler(f.services, f.contracts, f.guidance).prepare(current, limits);
    assert.doesNotMatch(JSON.stringify(prepared.packet), new RegExp(privateMarker)); assert.equal(prepared.packet.activeToolIds.includes('fixture.private'), false);
    for (const attempt of [first, second]) {
      const observation = prepared.packet.toolObservations?.find(o => o.attemptId === attempt.id);
      if (observation) { assert.equal(observation.representation, 'reference'); assert.equal(observation.input, undefined); assert.equal(observation.output, undefined); }
    }
    assert.deepEqual(await f.runtime.state(f.workId), current); assert.equal(f.planner.inputs.length, 0); assert.equal(f.invocations(), 1);
  } finally { await f.state.close(); }
});
