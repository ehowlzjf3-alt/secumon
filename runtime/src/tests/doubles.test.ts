import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateScenario } from '../application/fixtures.js';
import { newWork } from '../application/new-work.js';
import { parseContract, PlanProposalSchema, ToolResultSchema } from '../application/contracts.js';
import type { ContextPacket, Delivery, TaskSpec } from '../domain/model.js';
import type { RuntimeServices } from '../application/services.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { FakeClock, FakeSink, FixtureReadTool, ScriptedPlanner, SequenceIds } from '../infrastructure/fakes.js';
import { Sha256Digester } from '../infrastructure/digest.js';

const load = (name: string) => validateScenario(JSON.parse(readFileSync(new URL(`../../fixtures/${name}.json`, import.meta.url), 'utf8')));
for (const name of ['documents-simple', 'observations-simple']) {
  test(`inject all local ports without a database or channel SDK: ${name}`, async () => {
    const s = load(name);
    const services: RuntimeServices = { state: new MemoryStateRepository(), artifacts: new MemoryArtifactStore(), clock: new FakeClock(1000), ids: new SequenceIds(), digester: new Sha256Digester(),
      planner: new ScriptedPlanner([packet => ({ status: 'ok', proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: 0, reason: 'synthetic script', tasks: [], hypotheses: [] }, inputTokens: 0, outputTokens: 0, provider: 'scripted', model: 'fixture' })]), tools: [new FixtureReadTool(s.evidence)], sink: new FakeSink() };
    const state = newWork({ id: services.ids.next('work'), goal: s.goal, policy: s.policy, limits: { toolCalls: 10, modelCalls: 2, tokens: 1000, replans: 2, wallTimeMs: 60000 }, now: services.clock.now() });
    const command = { workId: state.id, expectedRevision: 0, commandId: 'accept', commandDigest: 'accept-digest', next: state, events: [{ type: 'accepted', at: 1000, data: {} }], deliveries: [] };
    assert.equal((await services.state.commit(command)).kind, 'committed');
    const packet: ContextPacket = { schemaVersion: 1, workId: state.id, stateRevision: 1, goal: state.goal, policy: state.policy, plan: null, hypotheses: [], obligations: [], evidence: [], activeToolIds: ['fixture.read'], purpose: 'plan' };
    const result = await services.planner.propose(packet, new AbortController().signal);
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') assert.equal(parseContract(PlanProposalSchema, result.proposal).baseStateRevision, 1);
    const task: TaskSpec = { id: 'read', description: 'read fixture', dependsOn: [], toolId: 'fixture.read', toolVersion: '1', input: { evidenceIds: [s.evidence[0]!.id] }, effect: 'read', maxAttempts: 1, satisfies: [] };
    const output = parseContract(ToolResultSchema, await services.tools[0]!.execute(task, { workId: state.id, attemptId: 'a1', policy: s.policy, signal: new AbortController().signal }));
    assert.equal(output.evidence.length, 1);
    const loaded = (await services.state.get(state.id))!; loaded.goal.description = 'mutated copy';
    assert.equal((await services.state.get(state.id))!.goal.description, s.goal.description);
    assert.equal((await services.state.commit(command)).kind, 'duplicate');
    assert.equal((await services.state.events(state.id, 0)).length, 1);
    await services.state.close();
  });
}
test('scripted planner honors cancellation and cannot mutate caller state', async () => {
  const s = load('documents-simple');
  const packet: ContextPacket = { schemaVersion: 1, workId: 'w', stateRevision: 1, goal: s.goal, policy: s.policy, plan: null, hypotheses: [], obligations: [], evidence: [], activeToolIds: [], purpose: 'plan' };
  const planner = new ScriptedPlanner([p => { p.goal.description = 'mutated'; return { status: 'error', code: 'synthetic', inputTokens: null, outputTokens: null }; }]);
  const abort = new AbortController(); abort.abort();
  assert.equal((await planner.propose(packet, abort.signal)).status, 'cancelled');
  assert.equal(planner.inputs.length, 0);
  await planner.propose(packet, new AbortController().signal);
  assert.equal(packet.goal.description, s.goal.description);
  assert.equal(planner.inputs[0]!.goal.description, s.goal.description);
  assert.equal((await planner.propose(packet, new AbortController().signal)).status, 'error');
});
test('fake sink exposes delivery uncertainty and deduplicates only matching content', async () => {
  const sink = new FakeSink();
  const d: Delivery = { id: 'ack', workId: 'w', goalRevision: 1, destination: 'local', kind: 'ack', text: 'accepted', status: 'pending', externalId: null };
  await sink.send(d); await sink.send(d);
  assert.equal(sink.delivered.size, 1);
  assert.equal((await sink.send({ ...d, destination: 'another' })).status, 'unknown');
  sink.outcome = 'unknown';
  assert.equal((await sink.send({ ...d, id: 'result' })).status, 'unknown');
  assert.equal(sink.delivered.size, 1);
});
