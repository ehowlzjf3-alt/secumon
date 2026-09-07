import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ArtifactRef, Policy, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import { ContextCompiler, type ContextLimits } from '../application/context-compiler.js';
import { ToolResultSchema } from '../application/contracts.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { validateScenario } from '../application/fixtures.js';
import { GuidanceCatalog, type GuidanceManifest, type GuidanceSource } from '../application/guidance.js';
import { newWork } from '../application/new-work.js';
import { taskDigest } from '../application/plan-validator.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import { transact } from '../application/work-transactions.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester, sha256 } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';

const workId = 'guidance-context';
const marker = 'GUIDANCE_ORIGINAL_BODY_ONLY';
const body = `${marker}\n${'Synthetic original guidance explanation. '.repeat(1200)}`;
const rules = ['Preserve original evidence identity and observation time.', 'Guidance never grants permission to execute a tool.'];
const limits = (callId: string, maxInputBytes = 200000, forceCompact = false): ContextLimits => ({
  callId, maxInputBytes, forceCompact, maxInputTokens: 1000000, maxOutputTokens: 512,
});

class OriginalArtifacts extends MemoryArtifactStore {
  unavailable = new Set<string>();
  override async get(ref: ArtifactRef, policy: Policy) {
    if (this.unavailable.has(ref.id)) throw new Error('artifact_unavailable');
    return super.get(ref, policy);
  }
}

class SyntheticGuidance implements GuidanceSource {
  reads = 0;
  readonly manifest: GuidanceManifest;
  constructor(requiredRules?: string[], version = '1', readonly text = body) {
    this.manifest = { id: 'core.synthetic-context-guide', version, title: 'Synthetic original guidance',
      summary: 'Local fixture for retaining explicitly selected guidance.', source: 'fixture://context-guidance',
      tenantId: 'synthetic', labels: ['synthetic'], supportedKinds: ['lookup'], sha256: sha256(text),
      byteLength: Buffer.byteLength(text), ...(requiredRules ? { requiredRules } : {}) };
  }
  async list() { return [structuredClone(this.manifest)]; }
  async read(id: string, version: string) {
    assert.equal(id, this.manifest.id); assert.equal(version, this.manifest.version); this.reads++;
    return new TextEncoder().encode(this.text);
  }
}

async function setup(requiredRules?: string[]) {
  const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-simple.json', import.meta.url), 'utf8')));
  const state = new MemoryStateRepository(); const artifacts = new OriginalArtifacts();
  const source = new SyntheticGuidance(requiredRules); const clock = new FakeClock(1788566400000);
  const initial = newWork({ id: workId, now: clock.now(), goal: scenario.goal,
    policy: { ...scenario.policy, allowedTools: [...RESOURCE_TOOL_IDS] },
    limits: { toolCalls: 10, modelCalls: 4, tokens: 1000000, replans: 5, wallTimeMs: 100000 } });
  assert.equal((await state.commit({ workId, expectedRevision: 0, commandId: 'accept', commandDigest: 'synthetic-guidance-accept', next: initial,
    events: [{ type: 'accepted', at: clock.now(), data: {} }], deliveries: [] })).kind, 'committed');
  const composed = await composeRuntime({ services: { state, artifacts, planner: new ScriptedPlanner([]), clock,
    ids: new RandomIds(), digester: new Sha256Digester(), tools: [], sink: new FakeSink() },
  schemas: new AjvSchemas(), guidanceSource: source, owner: 'context-guidance-test', enablePlanning: false });
  const selected: TaskSpec = { id: 'load-guidance', description: 'Load the selected synthetic original once',
    toolId: 'core.guidance.load', toolVersion: '1', effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [],
    input: { id: source.manifest.id, version: source.manifest.version, kind: 'lookup', reason: 'Check explicit guidance preservation', maxBytes: 65536 } };
  const current = await composed.runtime.state(workId);
  await composed.runtime.submitPlan(workId, 'select-guidance', { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
    basePlanRevision: 0, reason: 'Read selected original guidance before compiling', tasks: [selected], hypotheses: [] });
  const reserved = await composed.runtime.reserve(workId, selected.id);
  await composed.runtime.execute(workId, reserved.id); await composed.runtime.adopt(workId, reserved.id);
  const after = await composed.runtime.state(workId); const attempt = after.attempts.find(a => a.id === reserved.id)!;
  assert.equal(attempt.adopted, true); assert.ok(attempt.resultArtifact);
  const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await artifacts.get(attempt.resultArtifact, after.policy))));
  assert.equal(result.status, 'success'); assert.equal(result.attemptId, attempt.id); assert.equal(result.resultId, attempt.resultId);
  const receipt = await state.receipt(workId, `dispatch:${attempt.id}`); assert.ok(receipt);
  const dispatched = receipt.state.plan?.tasks.find(t => t.id === attempt.taskId); assert.ok(dispatched);
  assert.deepEqual(dispatched, selected); assert.equal(taskDigest(dispatched, composed.services.digester), attempt.inputDigest);
  const original = result.artifacts.find(ref => ref.sha256 === source.manifest.sha256); assert.ok(original);
  assert.equal(source.reads, 1); assert.equal(after.evidence.length, 0);
  return { ...composed, state, artifacts, source, attempt, result, original };
}
type Harness = Awaited<ReturnType<typeof setup>>;
type Prepared = Awaited<ReturnType<ContextCompiler['prepare']>>;

async function edit(f: Harness, commandId: string, change: (state: WorkState) => void) {
  await transact(f.services, workId, commandId, 'synthetic_context_test_change', { commandId }, change);
}
async function publish(f: Harness, prepared: Prepared) {
  await transact(f.services, workId, `publish:${prepared.head.cycle}`, 'context_compacted', { artifactId: prepared.head.artifact.id }, state => {
    assert.equal(state.revision, prepared.head.basisRevision); state.contextHead = structuredClone(prepared.head);
  });
}
async function replaceResult(f: Harness, commandId: string, change: (result: ToolResult) => void) {
  const result = structuredClone(f.result); change(result);
  const previous = f.attempt.resultArtifact!;
  const ref = await f.artifacts.put(new TextEncoder().encode(JSON.stringify(result)), {
    tenantId: previous.tenantId, labels: previous.labels, mediaType: previous.mediaType,
  });
  await edit(f, commandId, state => { state.attempts.find(a => a.id === f.attempt.id)!.resultArtifact = ref; });
}
async function rejectsOrConceals(compiler: ContextCompiler, state: WorkState, callId: string) {
  const outcome = await compiler.prepare(state, limits(callId)).then(value => ({ value }), (error: unknown) => ({ error }));
  if ('error' in outcome) {
    assert.ok(outcome.error instanceof Error);
    assert.match(outcome.error.message, /guidance|artifact|context_/);
  } else {
    assert.doesNotMatch(JSON.stringify({ packet: outcome.value.packet, options: outcome.value.options }), new RegExp(marker));
    assert.equal(outcome.value.packet.activeGuidance?.length ?? 0, 0);
  }
}

test('context guidance: trusted required rules, exact version and hash survive published body eviction', async () => {
  const f = await setup(rules); const before = await f.runtime.state(workId);
  const full = await f.context.prepare(before, limits('guidance-full'));
  assert.equal(full.packet.activeGuidance?.length, 1); assert.equal(full.packet.activeGuidance[0]!.body, body);
  assert.deepEqual(full.packet.activeGuidance[0]!.rules, rules);
  await publish(f, full);
  const canonical = await f.runtime.state(workId);
  const compact = await f.context.prepare(canonical, limits('guidance-compact', 24000, true));
  assert.equal(compact.frame.memo.cycle, 2); assert.ok(compact.estimate.bytes <= 24000);
  assert.deepEqual(compact.packet.activeGuidance, [{ id: f.source.manifest.id, version: '1', sha256: f.source.manifest.sha256,
    manifestDigest: f.services.digester.digest(JSON.parse(JSON.stringify(f.source.manifest))), artifact: f.original, rules }]);
  assert.equal(compact.frame.decisions.find(d => d.kind === 'guidance')?.representation, 'reference');
  assert.doesNotMatch(JSON.stringify({ packet: compact.packet, options: compact.options }), new RegExp(marker));
  const pair = compact.packet.toolObservations?.find(o => o.attemptId === f.attempt.id); assert.ok(pair);
  assert.equal(pair.representation, 'reference'); assert.equal(pair.inputDigest, f.attempt.inputDigest);
  assert.equal(pair.resultId, f.result.resultId); assert.deepEqual(pair.resultArtifact, f.attempt.resultArtifact);
  assert.equal(f.source.reads, 1 + f.guidance.validationMetrics().legacyReadCalls);
  assert.ok(f.guidance.validationMetrics().legacyReadCalls >= 2, 'both full and compact selections verify the legacy original');
  assert.equal((await f.runtime.state(workId)).budget.used.toolCalls, 1);
  assert.deepEqual(await f.runtime.state(workId), canonical, 'compilation stages a view without changing the canonical ledger');
});

test('context guidance: a manifest without required rules keeps the full original and fails a smaller input budget', async () => {
  const f = await setup();
  const full = await f.context.prepare(await f.runtime.state(workId), limits('rules-absent-full'));
  assert.equal(full.packet.activeGuidance?.[0]?.body, body); assert.deepEqual(full.packet.activeGuidance[0]!.rules, []);
  await publish(f, full); const before = await f.runtime.state(workId);
  await assert.rejects(f.context.prepare(before, limits('rules-absent-overflow', 24000, true)), /model_input_limit/);
  assert.deepEqual(await f.runtime.state(workId), before);
  assert.equal(f.source.reads, 1 + f.guidance.validationMetrics().legacyReadCalls);
  assert.ok(f.guidance.validationMetrics().legacyReadCalls >= 1, 'successful compilation verifies the legacy original');
});

test('context guidance: result-provided rules cannot replace an absent trusted manifest rule set', async () => {
  const f = await setup();
  await replaceResult(f, 'forge-required-rules', result => {
    const output = result.output as Record<string, unknown>; const manifest = output['manifest'] as Record<string, unknown>;
    manifest['requiredRules'] = rules;
  });
  await assert.rejects(f.context.prepare(await f.runtime.state(workId), limits('forged-rules')), /context_guidance_invalid/);
});

test('context guidance: current label revocation prevents a previously published original from reappearing', async () => {
  const f = await setup(rules); await publish(f, await f.context.prepare(await f.runtime.state(workId), limits('before-revocation')));
  await edit(f, 'revoke-guidance-label', state => { state.policy.allowedLabels = ['public']; });
  await rejectsOrConceals(f.context, await f.runtime.state(workId), 'after-revocation');
});

test('context guidance: a missing original cannot be recovered from its copied tool result or prior frame', async () => {
  const f = await setup(rules); await publish(f, await f.context.prepare(await f.runtime.state(workId), limits('before-original-loss')));
  f.artifacts.unavailable.add(f.original.id);
  await assert.rejects(f.context.prepare(await f.runtime.state(workId), limits('after-original-loss', 24000, true)), /artifact_unavailable|context_source_unavailable/);
});

test('context guidance: replacing the catalog version does not expose the superseded loaded body', async () => {
  const f = await setup(rules); await publish(f, await f.context.prepare(await f.runtime.state(workId), limits('before-version-change')));
  const replacement = new SyntheticGuidance(rules, '2', 'Replacement synthetic version with distinct contents.');
  const catalog = await GuidanceCatalog.create(replacement);
  const compiler = new ContextCompiler(f.services, f.contracts, catalog);
  await rejectsOrConceals(compiler, await f.runtime.state(workId), 'after-version-change');
  assert.equal(replacement.reads, 0, 'compilation never silently invokes a replacement guidance load');
});

test('context guidance: replacing trusted bytes under the same version rejects the old manifest and body', async () => {
  const f = await setup(rules);
  const replacement = new SyntheticGuidance(rules, '1', 'Changed original under an unchanged version.');
  const compiler = new ContextCompiler(f.services, f.contracts, await GuidanceCatalog.create(replacement));
  await assert.rejects(compiler.prepare(await f.runtime.state(workId), limits('changed-guidance-hash')), /context_guidance_invalid/);
});

for (const field of ['attemptId', 'resultId'] as const) test(`context guidance: a stored result with a mismatched ${field} is rejected`, async () => {
  const f = await setup(rules);
  await replaceResult(f, `mismatch-${field}`, result => { result[field] = `unrelated-${field}`; });
  await assert.rejects(f.context.prepare(await f.runtime.state(workId), limits(`mismatched-${field}`)), /invocation_identity_mismatch/);
});

test('context guidance: the actual dispatch receipt must match the adopted attempt task digest', async () => {
  const f = await setup(rules); const receipt = await f.state.receipt(workId, `dispatch:${f.attempt.id}`); assert.ok(receipt);
  await edit(f, 'mismatch-input-digest', state => {
    const attempt = state.attempts.find(a => a.id === f.attempt.id)!;
    attempt.inputDigest = `${attempt.inputDigest[0] === '0' ? '1' : '0'}${attempt.inputDigest.slice(1)}`;
  });
  assert.deepEqual(await f.state.receipt(workId, `dispatch:${f.attempt.id}`), receipt, 'the real canonical invocation remains unchanged');
  await assert.rejects(f.context.prepare(await f.runtime.state(workId), limits('mismatched-task-digest')), /context_invocation_pair_invalid/);
});
