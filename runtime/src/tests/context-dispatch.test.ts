import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContextPacket, TaskSpec } from '../domain/model.js';
import type { ModelCallOptions, Tool, ToolDefinition } from '../application/ports.js';
import type { GuidanceManifest, GuidanceSource } from '../application/guidance.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FakeClock, FakeSink } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { StructuredPlannerAdapter, type StructuredPlannerRequest } from '../infrastructure/structured-planner.js';
import { adapters, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const definition: ToolDefinition = { provider: 'fixture', id: 'fixture.versioned', version: '1', description: 'Synthetic current definition.', effect: 'read',
  destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' } };
const guideBody = 'Synthetic instruction body retained across restart.';
const manifest: GuidanceManifest = { id: 'core.dispatch-guide', version: '1', title: 'Synthetic dispatch guidance', summary: 'Verify the current trusted manifest before model dispatch',
  source: 'fixture://dispatch-guide', tenantId: 'tenant-a', labels: ['synthetic'], supportedKinds: ['lookup'], sha256: createHash('sha256').update(guideBody).digest('hex'),
  byteLength: Buffer.byteLength(guideBody), requiredRules: ['Preserve original evidence identifiers.'] };
const tool = (value: ToolDefinition): Tool => ({ definition: structuredClone(value), execute: async () => { throw new Error('definition_fixture_must_not_execute'); } });
const guidance = (value: GuidanceManifest): GuidanceSource => ({ list: async () => [structuredClone(value)], read: async () => Buffer.from(guideBody) });

async function fixture(backend: Adapter, run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup(backend);
  try { await run(f); } finally { await f.close(); }
}
async function setup(backend: Adapter) {
  const directory = await mkdtemp(join(tmpdir(), 'context-dispatch-')); let state = openRepository(backend, directory);
  try {
    const value = initial('reserved-work'); value.policy.allowedTools = [definition.id, ...RESOURCE_TOOL_IDS];
    value.policy.allowedLabels = ['synthetic', 'public']; value.policy.allowedDestinations = ['local', 'other-local']; value.budget.limits.tokens = 1000000;
    assert.equal((await state.commit(command(value, 'seed'))).kind, 'committed');
    const requests: StructuredPlannerRequest[] = []; const clock = new FakeClock(1000);
    const compose = async (definitions: ToolDefinition[], guide: GuidanceManifest) => {
      const planner = new StructuredPlannerAdapter({ identity: { provider: 'fixture', model: 'dispatch-recorder', revision: '1' }, destination: 'local',
        capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 1000000 } }, {
        invoke: async request => {
          requests.push(structuredClone(request));
          return { finish: 'stop', content: JSON.stringify({ baseStateRevision: request.packet.stateRevision, baseGoalRevision: request.packet.goal.revision,
            basePlanRevision: request.packet.plan?.revision ?? 0, reason: 'Only a local transport fixture ran', tasks: [], hypotheses: request.packet.hypotheses }),
          usage: { inputTokens: 11, outputTokens: 7 }, provider: 'fixture', model: 'dispatch-recorder' };
        },
      });
      return composeRuntime({ services: { state, artifacts: new FileArtifactStore(join(directory, 'artifacts')), planner, clock, sink: new FakeSink(),
        ids: new RandomIds(), digester: new Sha256Digester(), tools: definitions.map(tool) }, schemas: new AjvSchemas(),
      guidanceSource: guidance(guide), owner: 'same-owner' });
    };
    const first = await compose([definition], manifest);
    const reserve = async (loadGuidance: boolean) => {
      if (loadGuidance) {
        const before = await first.runtime.state(value.id);
        const task: TaskSpec = { id: 'load-guide', toolId: 'core.guidance.load', toolVersion: '1', description: 'Load trusted original once before model reservation', effect: 'read',
          input: { id: manifest.id, version: manifest.version, kind: 'lookup', reason: 'Synthetic pre-dispatch validation', maxBytes: 4096 }, dependsOn: [], maxAttempts: 1, satisfies: [] };
        await first.runtime.submitPlan(value.id, 'guide-plan', { baseStateRevision: before.revision, baseGoalRevision: 1, basePlanRevision: 0, tasks: [task], reason: 'Load a guide', hypotheses: [] });
        const attempt = await first.runtime.reserve(value.id, task.id); await first.runtime.execute(value.id, attempt.id); await first.runtime.adopt(value.id, attempt.id);
        const adopted = (await first.runtime.state(value.id)).attempts.find(a => a.id === attempt.id)!; assert.equal(adopted.adopted, true);
        assert.ok(await state.receipt(value.id, `dispatch:${attempt.id}`));
      }
      const call = await first.planning!.reserve(value.id); const current = await first.runtime.state(value.id);
      const envelope = JSON.parse(new TextDecoder().decode(await first.services.artifacts.get(call.inputArtifact, current.policy))) as { packet: ContextPacket; options: ModelCallOptions };
      assert.equal(call.status, 'reserved'); assert.equal(call.usageStatus, 'reserved'); assert.equal(current.budget.used.modelCalls, 0);
      assert.equal(current.budget.reservedModelCalls, 1); assert.equal(current.budget.reservedTokens, call.tokenReservation);
      assert.ok(envelope.options.tools.some(d => d.id === definition.id && d.version === '1'));
      if (loadGuidance) {
        assert.equal(envelope.packet.activeGuidance?.length, 1); assert.equal(envelope.packet.activeGuidance[0]!.version, '1');
        assert.equal(envelope.packet.activeGuidance[0]!.manifestDigest, first.services.digester.digest(JSON.parse(JSON.stringify(manifest))));
      }
      assert.equal(requests.length, 0);
      return { call, envelope, current };
    };
    const restart = async (definitions: ToolDefinition[], guide: GuidanceManifest = manifest) => {
      await state.close(); state = openRepository(backend, directory); return compose(definitions, guide);
    };
    const close = async () => { await state.close(); await rm(directory, { recursive: true, force: true }); };
    return { workId: value.id, first, reserve, restart, requests, close };
  } catch (error) { await state.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}
type Harness = Awaited<ReturnType<typeof setup>>;
async function assertNotSent(f: Harness, restarted: Awaited<ReturnType<Harness['restart']>>, callId: string) {
  const before = await restarted.runtime.state(f.workId), original = before.modelCalls.find(c => c.id === callId)!;
  const input = await restarted.services.artifacts.get(original.inputArtifact, before.policy);
  await restarted.planning!.execute(f.workId, callId); assert.equal(f.requests.length, 0);
  assert.equal(await restarted.planning!.adopt(f.workId, callId), false);
  const state = await restarted.runtime.state(f.workId); const call = state.modelCalls.find(c => c.id === callId)!;
  assert.equal(call.status, 'cancelled'); assert.equal(call.usageStatus, 'not_called'); assert.equal(call.inputTokens, 0); assert.equal(call.outputTokens, 0);
  assert.equal(call.reason, 'model_tools_changed'); assert.equal(call.replyArtifact, null);
  assert.equal(state.budget.used.tokens, 0); assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.reservedModelCalls, 0);
  assert.equal(state.budget.used.modelCalls, 0); assert.equal(state.budget.used.unmeasuredModelCalls, 0); assert.equal(state.modelCalls.length, 1);
  assert.equal(state.modelCalls.some(c => c.status === 'accepted'), false);
  assert.deepEqual(state.policy, before.policy); assert.deepEqual(state.goal, before.goal); assert.deepEqual(state.plan, before.plan);
  assert.deepEqual(state.contextHead, before.contextHead); assert.deepEqual(call.inputArtifact, original.inputArtifact);
  assert.deepEqual(await restarted.services.artifacts.get(call.inputArtifact, state.policy), input);
  assert.equal(await restarted.services.state.receipt(f.workId, `model-dispatch:${callId}`), null);
  assert.equal((await restarted.services.state.events(f.workId, 0)).some(event => event.type === 'model_call_dispatched'), false);
}

const changedDefinitions: { name: string; definitions: ToolDefinition[] }[] = [
  { name: 'removed registration', definitions: [] },
  { name: 'replacement version', definitions: [{ ...definition, version: '2' }] },
  { name: 'changed input schema under the same ID and version', definitions: [{ ...definition, inputSchema: { type: 'object', properties: { requiredNow: { type: 'string' } }, required: ['requiredNow'], additionalProperties: false } }] },
  { name: 'changed allowed labels under the same ID and version', definitions: [{ ...definition, labels: ['synthetic', 'public'] }] },
  { name: 'changed allowed destination under the same ID and version', definitions: [{ ...definition, destination: 'other-local' }] },
];
for (const backend of adapters) for (const changed of changedDefinitions) test(`context dispatch ${backend}: persisted reservation does not send ${changed.name}`, async () => {
  await fixture(backend, async f => {
    const reserved = await f.reserve(false); const restarted = await f.restart(changed.definitions);
    assert.deepEqual(await restarted.runtime.state(f.workId), reserved.current, 'restart keeps the reserved state and immutable input unchanged');
    assert.equal(restarted.context.definitionsCurrent(reserved.envelope.packet, reserved.envelope.options, reserved.current), false);
    await assertNotSent(f, restarted, reserved.call.id);
  });
});

for (const backend of adapters) for (const changed of ['required-rules', 'version'] as const) test(`context dispatch ${backend}: persisted guidance ${changed} change is checked before transport`, async () => {
  await fixture(backend, async f => {
    const reserved = await f.reserve(true);
    const next = changed === 'version' ? { ...manifest, version: '2' } : { ...manifest, requiredRules: ['A new required rule under the same version and body hash.'] };
    assert.equal(next.sha256, manifest.sha256, 'body hash alone cannot detect the required-rule change');
    const restarted = await f.restart([definition], next);
    assert.equal(restarted.context.definitionsCurrent(reserved.envelope.packet, reserved.envelope.options, reserved.current), false);
    await assertNotSent(f, restarted, reserved.call.id);
  });
});

for (const backend of adapters) test(`context dispatch ${backend}: unchanged tool and trusted guidance contracts resume the stored request once`, async () => {
  await fixture(backend, async f => {
    const reserved = await f.reserve(true); const restarted = await f.restart([definition]);
    assert.equal(restarted.context.definitionsCurrent(reserved.envelope.packet, reserved.envelope.options, reserved.current), true);
    await restarted.planning!.execute(f.workId, reserved.call.id); assert.equal(f.requests.length, 1);
    assert.deepEqual(f.requests[0]!.packet, reserved.envelope.packet); assert.deepEqual(f.requests[0]!.options, reserved.envelope.options);
    assert.equal(await restarted.planning!.adopt(f.workId, reserved.call.id), true);
    const state = await restarted.runtime.state(f.workId); const call = state.modelCalls.find(c => c.id === reserved.call.id)!;
    assert.equal(call.status, 'accepted'); assert.equal(call.usageStatus, 'reported'); assert.equal(state.budget.used.tokens, 18);
    assert.equal(state.budget.used.modelCalls, 1); assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.reservedModelCalls, 0);
    assert.equal(state.budget.used.unmeasuredModelCalls, 0);
  });
});
