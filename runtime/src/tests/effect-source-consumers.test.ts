import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ArtifactRef, Evidence, TaskSpec, WorkState } from '../domain/model.js';
import type { ComputerReconciliation } from '../domain/computer-reconciliation.js';
import type { TrustedKnowledgeActor } from '../domain/knowledge.js';
import type { DisclosureRule } from '../domain/disclosure.js';
import type { ArtifactStore, CommitRequest, Tool } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { WorkResources } from '../application/work-resources.js';
import { DisclosureService } from '../application/disclosure-service.js';
import { KnowledgeService } from '../application/knowledge-service.js';
import { effectProofsCurrent, refreshEffectProofs } from '../application/effect-proofs.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { asJson } from '../application/plan-validator.js';
import { toolExecution } from '../application/tool-execution-usage.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { SqliteKnowledgeRepository } from '../infrastructure/sqlite-knowledge.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner, SequenceIds } from '../infrastructure/fakes.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { SyntheticComputerClock, SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { computerActor, computerActInput, computerHarness, mutateComputer, observeComputer, saveNoteSteps, submitComputerTask } from './computer-use-helpers.js';
import { advance, attempt, command, initial, openRepository } from './state-conformance-helpers.js';

const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
const narrowed = { ...actor, allowedTools: ['fixture.read'], allowedDestinations: ['local', 'outside'], allowWrites: false };
const marker = 'SYNTHETIC_SOURCE_CONTENT';

async function fixture(t: TestContext, backend: 'sqlite' | 'file-journal') {
  const directory = await mkdtemp(join(tmpdir(), 'effect-source-consumers-'));
  const state = openRepository(backend, directory); const backing = new FileArtifactStore(join(directory, 'artifacts'));
  const repository = new SqliteKnowledgeRepository(join(directory, 'knowledge.sqlite'));
  t.after(async () => { await state.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); });
  let afterGet: ((ref: ArtifactRef) => void) | null = null; let afterExists: ((ref: ArtifactRef) => void) | null = null;
  const artifacts: ArtifactStore = { put: backing.put.bind(backing),
    async get(ref, policy) { const bytes = await backing.get(ref, policy); afterGet?.(ref); return bytes; },
    async exists(ref) { const found = await backing.exists(ref); afterExists?.(ref); return found; } };
  const original = await artifacts.put(new TextEncoder().encode(marker), { tenantId: actor.tenantId, labels: ['internal'], mediaType: 'text/plain' });
  const evidence: Evidence = { id: 'original', tenantId: actor.tenantId, scope: 'fixture', sourceId: 'source-1', lineageId: 'source-1', locator: 'fixture://original',
    observedAt: 1000, recordedAt: 1000, labels: ['internal'], coverage: 'complete', status: 'accepted', access: 'available', supersedes: [], derivedFrom: [],
    facts: { available: true }, artifact: original };
  const tool: Tool = { definition: { provider: 'fixture', id: 'fixture.read', version: '1', description: 'A synthetic source result', effect: 'read',
    destination: 'local', labels: ['internal'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
    async execute(_task, context) { return { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, status: 'success', effectState: 'none',
      output: { body: marker }, evidence: [evidence], artifacts: [original], error: null, cursor: null, coverage: 'complete' }; } };
  const work = initial(); work.policy = { ...work.policy, allowedLabels: ['internal', 'public'], allowedTools: ['fixture.read', 'unused.tool'],
    allowedDestinations: ['local', 'outside'], allowWrites: true, disclosure: { revision: 'synthetic-disclosure-v1',
      destinations: [{ destination: 'local', surfaces: ['model', 'artifact', 'tool'], allowedLabels: ['internal', 'public'] },
        { destination: 'outside', surfaces: ['model'], allowedLabels: ['public'] }], maxReleasesPerWork: 10, maxReleasedBytesPerWork: 10000 } };
  work.disclosureLabels = ['internal', 'public'];
  const policy = structuredClone(work.policy); await state.commit(command(work, 'seed'));
  const clock = new FakeClock(1100); const digester = new Sha256Digester(); let valid = true; let checks = 0;
  const effects = { async current(raw: WorkState) {
    checks++; assert.deepEqual(raw.policy, policy, 'proof authentication receives canonical policy, not the caller projection'); return valid;
  }, async refresh(workId: string) { return (await state.get(workId))!; } };
  const services: RuntimeServices = { state, artifacts, clock, digester, effects, tools: [tool], planner: new ScriptedPlanner([]), ids: new SequenceIds(), sink: new FakeSink() };
  const contracts = new ToolContracts([tool], new AjvSchemas()); const runtime = new ExecutionRuntime(services, contracts, 'source-worker');
  const task: TaskSpec = { id: 'read-source', toolId: 'fixture.read', toolVersion: '1', description: 'Read original', input: {}, effect: 'read',
    dependsOn: [], maxAttempts: 1, satisfies: [] };
  await runtime.submitPlan(work.id, 'source-plan', { baseStateRevision: 1, baseGoalRevision: 1, basePlanRevision: 0, reason: 'Read source', tasks: [task], hypotheses: [] });
  const source = await runtime.reserve(work.id, task.id); await runtime.execute(work.id, source.id);
  const received = await runtime.state(work.id); const sourceResult = received.attempts.find(value => value.id === source.id)!;
  assert.equal(sourceResult.status, 'received', 'fixture source execution must persist its result');
  assert.equal(sourceResult.execution?.mode, 'invoked', 'fixture source must pass the tool disclosure gate');
  assert.ok(sourceResult.resultArtifact);
  const body = JSON.parse(new TextDecoder().decode(await artifacts.get(sourceResult.resultArtifact, received.policy)));
  assert.equal(body.status, 'success', 'fixture source must produce a successful result');
  assert.deepEqual(body.output, { body: marker }); assert.deepEqual(body.evidence, [evidence]);
  const adopted = await runtime.adopt(work.id, source.id); const adoptedSource = adopted.attempts.find(value => value.id === source.id)!;
  assert.equal(adoptedSource.status, 'succeeded'); assert.equal(adoptedSource.adopted, true);
  assert.deepEqual(adopted.evidence, [evidence], 'fixture must adopt the original evidence before installing effect proof metadata');
  const refs: ArtifactRef[] = [];
  for (const kind of ['head', 'request', 'response', 'proof']) refs.push(await artifacts.put(new TextEncoder().encode(JSON.stringify({ synthetic: kind })),
    { tenantId: actor.tenantId, labels: ['internal'], mediaType: 'application/json' }));
  let serial = 0;
  const edit = async (change: (next: WorkState) => void) => {
    const next = advance((await state.get(work.id))!); change(next); assert.equal((await state.commit(command(next, `fixture-${++serial}`))).kind, 'committed');
  };
  await edit(next => {
    next.attempts.push({ ...attempt('unknown'), id: 'effect-source', taskId: 'effect-task', toolId: 'fixture.write', effect: 'write', effectState: 'unknown',
      execution: toolExecution('unreported'), finishedAt: 1000, computerUse: { head: refs[0]!, phase: 'unknown', completedSteps: 0, pendingOperationId: 'operation' } });
    next.budget.used.toolCalls++; next.artifacts.push(...refs);
    next.obligations.push({ id: 'effect:effect-source', kind: 'effect_reconciliation', reason: 'Uncertain original input', status: 'pending', wakeKey: null, dueAt: null });
  });
  const record: ComputerReconciliation = { id: 'effect-proof', sourceAttemptId: 'effect-source', obligationId: 'effect:effect-source',
    sourceHead: refs[0]!, sourceResultArtifact: null, requestArtifact: refs[1]!, responseArtifact: null, proofArtifact: null, operationId: 'operation', stepIndex: 0,
    goalRevision: 1, policyDigest: digester.digest(asJson(policy)), generation: 0, contractDigest: 'c'.repeat(64), driver: { id: 'synthetic', version: '1' },
    owner: 'effect-worker', leaseUntil: 2000, createdAt: 1000, dispatchedAt: null, finishedAt: null, status: 'reserved', execution: toolExecution('not_invoked'),
    reason: null, outcome: null, effectState: 'unknown' };
  await edit(next => { next.computerReconciliations = [record]; next.budget.reservedToolCalls++; });
  await edit(next => { const r = next.computerReconciliations![0]!; r.status = 'running'; r.dispatchedAt = 1000; r.execution = toolExecution('unreported');
    next.budget.reservedToolCalls--; next.budget.used.toolCalls++; });
  await edit(next => { const r = next.computerReconciliations![0]!; r.status = 'received'; r.finishedAt = 1000; r.responseArtifact = refs[2]!;
    r.outcome = 'applied'; r.execution = toolExecution('invoked', { transportCalls: 1, internalOperations: 0, imageBytes: 0, waitMs: 0 }); });
  await edit(next => { const r = next.computerReconciliations![0]!; r.status = 'settled'; r.effectState = 'confirmed'; r.proofArtifact = refs[3]!;
    next.obligations.find(value => value.id === r.obligationId)!.status = 'satisfied'; });
  const rule: DisclosureRule = { id: 'release', version: '1', ...actor, scope: 'fixture', destination: 'outside', surface: 'model', sourceLabels: ['internal'],
    releasedLabels: ['public'], fields: [{ sourceKey: 'available', outputKey: 'available', values: [{ from: true, to: 'yes' }] }],
    includeCoverage: true, maxSources: 3, maxBytes: 1000 };
  let trusted: TrustedKnowledgeActor = { ...actor, allowedLabels: ['internal', 'public'], allowedNamespaces: ['local'], allowedScopes: ['fixture'], canPublish: true, canReview: false };
  const dependencies = { repository, states: state, actors: { async current() { return structuredClone(trusted); } }, digester, clock };
  return { state, artifacts, services, contracts, effects, runtime, repository, dependencies, rule, workId: work.id, original, source, evidence,
    resources: new WorkResources(state, artifacts, contracts, digester, undefined, undefined, effects),
    disclosure: new DisclosureService(services, [rule]), knowledge: new KnowledgeService({ ...dependencies, effects }),
    valid(value: boolean) { valid = value; }, checks: () => checks, actor(value: TrustedKnowledgeActor) { trusted = value; },
    onGet(hook: ((ref: ArtifactRef) => void) | null) { afterGet = hook; }, onExists(hook: ((ref: ArtifactRef) => void) | null) { afterExists = hook; } };
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: work resource bodies and metadata use canonical effect proof with a narrowed caller and fail without a checker`, async t => {
    const f = await fixture(t, backend); const before = await f.state.get(f.workId);
    assert.equal((await f.resources.original(f.workId, narrowed, f.evidence.id, 65536)).status, 'available');
    assert.equal((await f.resources.result(f.workId, narrowed, f.source.id, 65536)).status, 'available');
    const query = { toolId: 'fixture.read', toolVersion: '1', inputDigest: null, limit: 10 };
    assert.equal((await f.resources.calls(f.workId, narrowed, query)).cards.length, 1); assert.ok(f.checks() > 0);
    const noChecker = new WorkResources(f.state, f.artifacts, f.contracts, f.services.digester);
    await assert.rejects(noChecker.original(f.workId, narrowed, f.evidence.id, 65536), /resource_state_changed/);
    await assert.rejects(noChecker.result(f.workId, narrowed, f.source.id, 65536), /resource_state_changed/);
    f.valid(false);
    await assert.rejects(f.resources.evidence(f.workId, narrowed, f.evidence.id, 65536), /resource_state_changed/);
    await assert.rejects(f.resources.findEvidence(f.workId, narrowed, { query: '', limit: 10 }), /resource_state_changed/);
    await assert.rejects(f.resources.calls(f.workId, narrowed, query), /resource_state_changed/);
    assert.deepEqual(await f.state.get(f.workId), before);
  });

  test(`${backend}: proof invalidation during original or stored result I/O cannot return the already read body`, async t => {
    const f = await fixture(t, backend); const before = await f.state.get(f.workId); let fired = 0;
    f.onGet(ref => { if (ref.id === f.original.id) { fired++; f.onGet(null); f.valid(false); } });
    await assert.rejects(f.resources.original(f.workId, narrowed, f.evidence.id, 65536), /resource_state_changed/);
    f.valid(true);
    f.onGet(ref => { if (ref.id === f.original.id) { fired++; f.onGet(null); f.valid(false); } });
    await assert.rejects(f.resources.result(f.workId, narrowed, f.source.id, 65536), /resource_state_changed/);
    assert.equal(fired, 2); assert.deepEqual(await f.state.get(f.workId), before);
  });

  test(`${backend}: disclosure release, saved payload, raw read and receiver entry all retain current source effect proof`, async t => {
    const f = await fixture(t, backend); const request = { requestId: 'first', ruleId: f.rule.id, evidenceIds: [f.evidence.id] };
    const released = await f.disclosure.release(f.workId, narrowed, request); assert.equal(released.payload.observations[0]!.facts['available'], 'yes');
    const before = await f.state.get(f.workId); let entries = 0; let fired = 0;
    const revokeOnOriginal = () => { f.valid(true); f.onGet(ref => { if (ref.id === f.original.id) { fired++; f.onGet(null); f.valid(false); } }); };
    revokeOnOriginal(); await assert.rejects(f.disclosure.read(f.workId, narrowed, 'first'), /disclosure_effect_proof_changed/);
    revokeOnOriginal(); await assert.rejects(f.disclosure.readRaw(f.workId, narrowed, { artifact: f.original, destination: 'local', surface: 'artifact' }), /disclosure_effect_proof_changed/);
    revokeOnOriginal(); await assert.rejects(f.disclosure.dispatchReleased(f.workId, narrowed, 'first', { destination: 'outside', surface: 'model',
      async receive() { entries++; return 'sent'; } }), /disclosure_effect_proof_changed/);
    revokeOnOriginal(); await assert.rejects(f.disclosure.release(f.workId, narrowed, { ...request, requestId: 'second' }), /disclosure_effect_proof_changed/);
    assert.equal(entries, 0); assert.equal(fired, 4); assert.deepEqual(await f.state.get(f.workId), before);
    const { effects: _effects, ...withoutChecker } = f.services;
    await assert.rejects(new DisclosureService(withoutChecker, [f.rule]).read(f.workId, narrowed, 'first'), /disclosure_effect_proof_changed/);
  });

  test(`${backend}: private, derived and cached shared memory cannot outlive the original work effect proof`, async t => {
    const f = await fixture(t, backend);
    const create = { id: 'memory', commandId: 'create-memory', namespace: 'local', scope: 'fixture', kind: 'fact' as const,
      title: 'Synthetic observed fact', body: marker, labels: [] as string[], sources: [{ workId: f.workId, evidenceId: f.evidence.id }], expiresAt: null };
    const noChecker = new KnowledgeService(f.dependencies);
    await assert.rejects(noChecker.create({ ...create, id: 'unproven', commandId: 'unproven' }), /knowledge_unavailable/);
    assert.equal(await f.repository.get(actor.tenantId, 'unproven'), null);
    await f.knowledge.create(create);
    await f.knowledge.submitForReview({ id: 'memory', expectedRevision: 1, commandId: 'submit', reason: 'Review the original source' });
    f.actor({ ...actor, principalId: 'reviewer', allowedLabels: ['internal', 'public'], allowedNamespaces: ['local'], allowedScopes: ['fixture'], canPublish: true, canReview: true });
    await f.knowledge.reviewAndPromote({ id: 'memory', expectedRevision: 2, expectedContentRevision: 1, commandId: 'promote', reason: 'Reviewed source' });
    f.actor({ ...actor, allowedLabels: ['internal', 'public'], allowedNamespaces: ['local'], allowedScopes: ['fixture'], canPublish: true, canReview: false });
    await f.knowledge.create({ ...create, id: 'derived', commandId: 'create-derived', sources: [], derivedFrom: ['memory'] });
    assert.equal((await f.knowledge.get('derived')).card.body, marker);
    f.actor({ ...actor, principalId: 'reader', allowedLabels: ['internal'], allowedNamespaces: ['local'], allowedScopes: ['fixture'], canPublish: false, canReview: false });
    const read = await f.knowledge.get('memory'); assert.equal(read.card.body, marker);
    await f.knowledge.syncIndex('local'); const query = { namespace: 'local', scope: 'fixture', text: 'Synthetic' };
    assert.equal((await f.knowledge.search(query)).cards.length, 1);
    const before = await f.state.get(f.workId); f.valid(false);
    await assert.rejects(f.knowledge.get('memory'), /knowledge_unavailable/);
    assert.equal(await f.knowledge.validateDependencies([read.dependency]), false);
    const cached = await f.knowledge.search(query); assert.equal(cached.index.cached, true); assert.deepEqual(cached.cards, []);
    f.actor({ ...actor, allowedLabels: ['internal', 'public'], allowedNamespaces: ['local'], allowedScopes: ['fixture'], canPublish: true, canReview: false });
    await assert.rejects(f.knowledge.get('derived'), /knowledge_unavailable/);
    await assert.rejects(f.knowledge.create({ ...create, id: 'laundered', commandId: 'laundered', sources: [], derivedFrom: ['memory'] }), /knowledge_unavailable/);
    assert.equal(await f.repository.get(actor.tenantId, 'laundered'), null); assert.deepEqual(await f.state.get(f.workId), before);
  });

  test(`${backend}: source proof authentication does not recursively validate memory copied into that same work`, { timeout: 15000 }, async t => {
    const clock = new SyntheticComputerClock(1000); const driver = new SyntheticComputerDriver({ clock });
    driver.injectNextAction({}); driver.injectNextAction({ outcome: 'applied_unknown' });
    const h = await computerHarness(backend, { clock, driver }); const repository = new SqliteKnowledgeRepository(join(h.directory, 'knowledge.sqlite'));
    t.after(async () => { await repository.close(); await h.close(); });
    const observed = await observeComputer(h); const source = await submitComputerTask(h, 'act', computerActInput(observed.observationId, saveNoteSteps));
    await h.runtime.execute(h.workId, source.id); await h.runtime.settlePending(source.id); await h.runtime.adopt(h.workId, source.id);
    const before = await h.runtime.state(h.workId); const attempt = before.attempts.find(value => value.id === source.id)!; assert.ok(attempt.computerUse);
    const settled = await h.computerReconciliations.reconcile(h.workId, 'before-memory', computerActor,
      { attemptId: source.id, checkpointId: attempt.computerUse.head.id }); assert.equal(settled.status, 'settled');
    await mutateComputer(h, state => { state.evidence.push({ id: 'remembered', tenantId: computerActor.tenantId, scope: state.goal.scope,
      sourceId: 'synthetic-memory-original', lineageId: 'synthetic-memory-original', locator: 'fixture://remembered', observedAt: 1000, recordedAt: 1000,
      labels: ['public'], coverage: 'complete', status: 'accepted', access: 'available', supersedes: [], derivedFrom: [], facts: { available: true }, artifact: null }); });
    let proofCalls = 0; let knowledgeCalls = 0;
    const memory = new KnowledgeService({ states: h.state, repository, clock, digester: h.services.digester,
      actors: { async current() { return { ...computerActor, allowedLabels: ['public'], allowedNamespaces: ['local'], allowedScopes: ['computer-lesson'], canPublish: false, canReview: false }; } },
      effects: { async current(state) { if (++proofCalls > 40) throw new Error('fixture_effect_recursion'); return h.services.effects!.current(state); } } });
    const read = await memory.create({ id: 'self-source', commandId: 'create-self-source', namespace: 'local', scope: 'computer-lesson', kind: 'fact',
      title: 'Synthetic memory', body: 'A separately observed original', labels: [], sources: [{ workId: h.workId, evidenceId: 'remembered' }], expiresAt: null });
    await mutateComputer(h, state => { state.attempts.find(value => value.id === source.id)!.knowledgeDependencies = [read.dependency]; });
    h.services.knowledge = { async validate(dependencies) {
      if (++knowledgeCalls > 4) throw new Error('fixture_knowledge_recursion'); return memory.validateDependencies(dependencies);
    } };
    proofCalls = 0; const canonical = await h.runtime.state(h.workId); const app = driver.snapshot();
    assert.equal(await h.services.effects!.current(canonical), true);
    assert.equal((await memory.get('self-source')).card.body, 'A separately observed original');
    assert.equal(await memory.validateDependencies([read.dependency]), true);
    assert.equal(knowledgeCalls, 0, 'raw artifact/receipt effect authentication must not call the knowledge validator');
    assert.ok(proofCalls > 0 && proofCalls <= 40); assert.deepEqual(await h.runtime.state(h.workId), canonical); assert.deepEqual(driver.snapshot(), app);
  });

  test(`${backend}: a failed historical effect proof stays required after refresh and reopen until the same source is explicitly proved again`, { timeout: 30000 }, async t => {
    const clock = new SyntheticComputerClock(1000); let h = await computerHarness(backend, { clock, store: backing => new Proxy(backing, {
      get(target, key) {
        if (key === 'commit') return async (input: CommitRequest) => {
          const request = structuredClone(input);
          if (request.expectedRevision === 0) {
            request.next.policy.disclosure = { revision: 'proof-retirement-fixture', destinations: [
              { destination: 'local', surfaces: ['tool', 'model', 'artifact'], allowedLabels: ['public'] },
            ], maxReleasesPerWork: 10, maxReleasedBytesPerWork: 10000 };
            request.next.disclosureLabels = ['public'];
          }
          return target.commit(request);
        };
        const value: unknown = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      },
    }) });
    const directory = h.directory; let repository = new SqliteKnowledgeRepository(join(directory, 'knowledge.sqlite'));
    t.after(async () => { await repository.close(); await h.close(true); });
    const driver = h.driver as SyntheticComputerDriver;
    driver.injectNextAction({}); driver.injectNextAction({ outcome: 'applied_unknown' });
    const observed = await observeComputer(h); const source = await submitComputerTask(h, 'act', computerActInput(observed.observationId, saveNoteSteps));
    await h.runtime.execute(h.workId, source.id); await h.runtime.settlePending(source.id); await h.runtime.adopt(h.workId, source.id);
    const originalState = await h.runtime.state(h.workId); const originalAttempt = originalState.attempts.find(value => value.id === source.id)!;
    assert.equal(originalAttempt.status, 'unknown'); assert.ok(originalAttempt.computerUse);
    const input = { attemptId: source.id, checkpointId: originalAttempt.computerUse.head.id };
    const first = await h.computerReconciliations.reconcile(h.workId, 'first-source-proof', computerActor, input);
    assert.equal(first.status, 'settled'); assert.ok(first.proofArtifact);
    const original = await h.artifacts.put(new TextEncoder().encode(marker), { tenantId: computerActor.tenantId, labels: ['public'], mediaType: 'text/plain' });
    const evidence: Evidence = { id: 'proof-dependent-original', tenantId: computerActor.tenantId, scope: 'computer-lesson', sourceId: 'fixture-proof-source',
      lineageId: 'fixture-proof-source', locator: 'fixture://proof-source', observedAt: 1000, recordedAt: 1000, labels: ['public'], coverage: 'complete',
      status: 'accepted', access: 'available', supersedes: [], derivedFrom: [], facts: { available: true }, artifact: original };
    await mutateComputer(h, state => { state.evidence.push(evidence); state.artifacts.push(original); });
    const actor = { ...computerActor, allowedLabels: ['public'], allowedTools: ['synthetic.ui.observe'], allowedDestinations: ['local'], allowWrites: false };
    const rule: DisclosureRule = { id: 'proof-release', version: '1', ...computerActor, scope: 'computer-lesson', destination: 'local', surface: 'model',
      sourceLabels: ['public'], releasedLabels: ['public'], fields: [{ sourceKey: 'available', outputKey: 'available', values: [{ from: true, to: 'yes' }] }],
      includeCoverage: true, maxSources: 3, maxBytes: 1000 };
    const memoryDependencies = () => ({ states: h.state, repository, clock, digester: h.services.digester,
      actors: { async current() { return { ...computerActor, allowedLabels: ['public'], allowedNamespaces: ['local'], allowedScopes: ['computer-lesson'],
        canPublish: false, canReview: false }; } } });
    const readers = () => ({ memory: new KnowledgeService({ ...memoryDependencies(), effects: h.services.effects }), disclosure: new DisclosureService(h.services, [rule]) });
    let current = readers();
    await current.memory.create({ id: 'retained-memory', commandId: 'create-retained-memory', namespace: 'local', scope: 'computer-lesson', kind: 'fact',
      title: 'Source proof remains required', body: marker, labels: [], sources: [{ workId: h.workId, evidenceId: evidence.id }], expiresAt: null });
    const release = await current.disclosure.release(h.workId, actor, { requestId: 'retained-release', ruleId: rule.id, evidenceIds: [evidence.id] });
    assert.equal(release.payload.observations[0]!.facts['available'], 'yes');
    assert.equal((await h.resources.original(h.workId, actor, evidence.id, 65536)).status, 'available');
    assert.equal((await current.memory.get('retained-memory')).card.body, marker);
    const { effects: _effects, ...withoutChecker } = h.services;
    const failed = await refreshEffectProofs(withoutChecker, h.workId);
    const historical = structuredClone(failed.computerReconciliations!.find(value => value.id === first.id)!);
    assert.equal(historical.status, 'failed'); assert.deepEqual(historical.proofArtifact, first.proofArtifact);
    assert.equal(failed.obligations.find(value => value.id === first.obligationId)!.status, 'pending');
    assert.equal(await effectProofsCurrent({}, failed), false, 'a historical proof still requires an injected checker');
    let delegated = 0;
    assert.equal(await effectProofsCurrent({ effects: { async current() { delegated++; return true; } } }, failed), true);
    assert.equal(delegated, 1, 'the helper delegates proof semantics; a fake true checker is not proof authentication');

    const denied = async () => {
      const state = await h.runtime.state(h.workId);
      assert.equal(await h.services.effects!.current(state), false, 'the actual proof reader rejects failed evidence without a replacement proof');
      await assert.rejects(h.resources.original(h.workId, actor, evidence.id, 65536), /resource_state_changed/);
      await assert.rejects(current.memory.get('retained-memory'), /knowledge_unavailable/);
      await assert.rejects(current.disclosure.read(h.workId, actor, 'retained-release'), /disclosure_effect_proof_changed/);
      const resources = new WorkResources(h.state, h.artifacts, h.contracts, h.services.digester);
      await assert.rejects(resources.original(h.workId, actor, evidence.id, 65536), /resource_state_changed/);
      await assert.rejects(new KnowledgeService(memoryDependencies()).get('retained-memory'), /knowledge_unavailable/);
      const { effects: _checker, ...services } = h.services;
      await assert.rejects(new DisclosureService(services, [rule]).read(h.workId, actor, 'retained-release'), /disclosure_effect_proof_changed/);
      assert.deepEqual(await h.runtime.state(h.workId), state, 'denied consumers do not mutate the historical claim');
    };
    await denied();
    await repository.close(); await h.close(false);
    h = await computerHarness(backend, { directory, clock }); repository = new SqliteKnowledgeRepository(join(directory, 'knowledge.sqlite'));
    current = readers(); await denied();
    const app = (h.driver as SyntheticComputerDriver).snapshot(); const beforeReproof = await h.runtime.state(h.workId);
    const second = await h.computerReconciliations.reconcile(h.workId, 'replacement-source-proof', computerActor, input);
    assert.equal(second.status, 'settled'); assert.notEqual(second.id, first.id);
    assert.deepEqual(second.sourceHead, first.sourceHead); assert.equal(second.sourceAttemptId, first.sourceAttemptId);
    const restored = await h.runtime.state(h.workId);
    assert.deepEqual(restored.computerReconciliations!.find(value => value.id === first.id), historical, 'reproof does not rewrite the failed historical claim');
    assert.deepEqual(restored.attempts.find(value => value.id === source.id), originalAttempt, 'reproof does not rewrite or reexecute the original attempt');
    assert.equal(await h.services.effects!.current(restored), true);
    assert.equal((await h.resources.original(h.workId, actor, evidence.id, 65536)).status, 'available');
    assert.equal((await current.memory.get('retained-memory')).card.body, marker);
    assert.equal((await current.disclosure.read(h.workId, actor, 'retained-release')).payload.observations[0]!.facts['available'], 'yes');
    assert.deepEqual(second.execution, toolExecution('invoked', { transportCalls: 1, internalOperations: 1, imageBytes: 0, waitMs: 0 }));
    assert.equal(restored.budget.used.toolCalls, beforeReproof.budget.used.toolCalls + 1, 'explicit receipt lookup consumes one logical read');
    assert.deepEqual((h.driver as SyntheticComputerDriver).snapshot(), { ...app, fence: app.fence + 2,
      usage: { ...app.usage, transportCalls: app.usage.transportCalls + 1, internalOperations: app.usage.internalOperations + 1 },
      sessionCalls: { acquire: app.sessionCalls.acquire + 1, release: app.sessionCalls.release + 1 } },
    'one lookup acquires and releases a fenced session while preserving every input, app and screen field');
  });
}
