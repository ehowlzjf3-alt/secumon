import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Evidence, Json, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import { evaluateCompletion } from '../domain/completion.js';
import { acceptedToolProgressKeys, captureProgress } from '../application/work-progress.js';
import { asJson } from '../application/plan-validator.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import { bounded } from '../application/work-resources.js';
import { ToolResultSchema } from '../application/contracts.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { adapters, attempt, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const digester = new Sha256Digester();
function evidence(id = 'a'): Evidence {
  return { id: `evidence-${id}`, tenantId: 'tenant-a', scope: 'fixture', sourceId: `source-${id}`, lineageId: `lineage-${id}`,
    locator: `document:${id}`, observedAt: 900, recordedAt: 1000, labels: ['synthetic'], coverage: 'complete', status: 'accepted',
    supersedes: [], derivedFrom: [], facts: { record: id, value: id === 'a' ? 30 : 40 }, artifact: null };
}
const selected = (id: string, toolId: string, input: TaskSpec['input'], dependsOn: string[] = []): TaskSpec => ({
  id, toolId, toolVersion: '1', description: 'Recall current evidence through a local resource', input, dependsOn,
  effect: 'read', maxAttempts: 1, satisfies: [],
});
const findTask = (id: string, query = 'source-a', limit = 20) => selected(id, 'core.evidence.find', { query, limit });
const getTask = (id: string, evidenceId = 'evidence-a', maxBytes = 4096) => selected(id, 'core.evidence.get', { evidenceId, detail: 'evidence', maxBytes });

async function fixture(t: TestContext, backend: Adapter = 'sqlite', records: Evidence[] = [evidence('a'), evidence('b')]) {
  const directory = await mkdtemp(join(tmpdir(), 'evidence-recall-progress-'));
  const repository = openRepository(backend, directory), artifacts = new FileArtifactStore(join(directory, 'artifacts'));
  t.after(async () => { try { await repository.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  const state = initial('evidence-recall'); state.policy.allowedTools = [...RESOURCE_TOOL_IDS];
  state.evidence = structuredClone(records); state.budget.limits.toolCalls = 20;
  captureProgress(state, digester, 'existing-evidence', state.createdAt);
  assert.equal((await repository.commit(command(state, 'create'))).kind, 'committed');
  const planner = new ScriptedPlanner([]);
  const core = await composeRuntime({ services: { state: repository, artifacts, clock: new FakeClock(state.createdAt),
    digester, ids: new RandomIds(), planner, tools: [], sink: new FakeSink() }, schemas: new AjvSchemas(), owner: 'recall-progress' });
  const actor = { tenantId: state.policy.tenantId, principalId: state.policy.principalId };
  const current = () => core.runtime.state(state.id);
  const find = (query = 'source-a', limit = 20) => core.resources.findEvidence(state.id, actor, { query, limit });
  const get = (id = 'evidence-a', maxBytes = 4096) => core.resources.evidence(state.id, actor, id, maxBytes);
  const update = async (edit: (next: WorkState) => void) => {
    const before = await current(), next = structuredClone(before); edit(next); next.revision++; next.updatedAt++;
    assert.equal((await repository.commit(command(next, `edit-${next.revision}`))).kind, 'committed'); return next;
  };
  return { state, current, update, core, artifacts, repository, planner, actor, find, get };
}
function adopted(state: WorkState, task: TaskSpec, output: unknown, partial = false) {
  const id = `recall-${state.attempts.length}-${task.id}`;
  const result: ToolResult = { resultId: `${id}:result`, attemptId: id, status: partial ? 'partial' : 'success', effectState: 'none',
    evidence: [], artifacts: [], output: asJson(output), error: null, cursor: null, coverage: partial ? 'partial' : 'complete' };
  state.attempts.push({ ...attempt(partial ? 'partial' : 'succeeded'), id, taskId: task.id, toolId: task.toolId, toolVersion: task.toolVersion,
    goalRevision: state.goal.revision, scope: state.goal.scope, resultId: result.resultId, adopted: true });
  return { task, result, keys: () => acceptedToolProgressKeys(state, task, result, digester),
    capture: () => captureProgress(state, digester, `${id}:settled`, 2000, { additionalKeys: acceptedToolProgressKeys(state, task, result, digester) }) };
}
function object(value: Json | undefined): Record<string, Json> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value;
}

test('current provenance discovery followed by exact body reading earns one further preparation step per evidence', async t => {
  const f = await fixture(t), state = await f.current(), original = structuredClone(state), baseline = state.progress!.productiveSteps;
  const find = adopted(state, findTask('find-a'), await f.find()); assert.equal(find.keys().length, 1);
  assert.equal(find.capture().productiveSteps, baseline + 1);
  const get = adopted(state, getTask('get-a'), await f.get()); assert.equal(get.keys().length, 2);
  assert.ok(find.keys().every(key => get.keys().includes(key))); assert.equal(get.capture().productiveSteps, baseline + 2);
  const b = adopted(state, getTask('get-b', 'evidence-b'), await f.get('evidence-b'));
  assert.equal(b.keys().length, 2); assert.equal(b.keys().some(key => get.keys().includes(key)), false);
  assert.equal(b.capture().productiveSteps, baseline + 3);
  assert.deepEqual(state.evidence, original.evidence); assert.deepEqual(state.goal, original.goal); assert.deepEqual(state.policy, original.policy);
  assert.equal(evaluateCompletion(state.goal, state.evidence, [], state.policy).complete, false);
});

test('body reading subsumes later provenance discovery without another preparation credit', async t => {
  const f = await fixture(t), state = await f.current(), baseline = state.progress!.productiveSteps;
  const get = adopted(state, getTask('get-first'), await f.get()); assert.equal(get.capture().productiveSteps, baseline + 1);
  const find = adopted(state, findTask('find-later', 'document:a', 1), await f.find('document:a', 1));
  assert.ok(find.keys().every(key => get.keys().includes(key)));
  assert.equal(find.capture().productiveSteps, baseline + 1); assert.equal(state.progress!.consecutiveUnproductive, 1);
});

test('query, limits, revision, locator, timestamps and alias IDs cannot make the same evidence newly productive', async t => {
  const f = await fixture(t, 'sqlite', [evidence()]);
  const state = await f.current(), originalGet = adopted(state, getTask('first'), await f.get()), originalFind = adopted(state, findTask('card'), await f.find());
  originalGet.capture(); const productive = state.progress!.productiveSteps;
  const again = adopted(state, getTask('different-size', 'evidence-a', 8192), await f.get('evidence-a', 8192));
  assert.deepEqual(again.keys(), originalGet.keys()); assert.equal(again.capture().productiveSteps, productive);
  const query = adopted(state, findTask('different-query', 'record', 1), await f.find('record', 1));
  assert.deepEqual(query.keys(), originalFind.keys()); assert.equal(query.capture().productiveSteps, productive);
  const current = await f.update(next => { Object.assign(next.evidence[0]!, { id: 'alias-a', locator: 'display-only:a', observedAt: 950, recordedAt: 1001 }); });
  // Keep the accumulated observations while comparing an actual later resource response against the current aliased evidence.
  const aliased = { ...current, progress: structuredClone(state.progress) };
  const aliasGet = adopted(aliased, getTask('alias', 'alias-a', 65536), await f.get('alias-a', 65536));
  const aliasFind = adopted(aliased, findTask('alias-card', 'display-only', 20), await f.find('display-only', 20));
  assert.deepEqual(aliasGet.keys(), originalGet.keys()); assert.deepEqual(aliasFind.keys(), originalFind.keys());
  assert.equal(aliasGet.capture().productiveSteps, productive); assert.equal(aliasFind.capture().productiveSteps, productive);
  assert.equal(aliased.progress!.policy.maxUnproductiveSteps, 3);
});

test('a genuinely changed current fact body has a distinct body credit while stale copies have none', async t => {
  const f = await fixture(t, 'sqlite', [evidence()]), oldState = await f.current(), oldOutput = await f.get();
  const old = adopted(oldState, getTask('old'), oldOutput); const oldKeys = old.keys(); assert.equal(oldKeys.length, 2);
  const current = await f.update(next => { next.evidence[0]!.facts.value = 31; });
  const stale = adopted(current, getTask('stale'), oldOutput); assert.deepEqual(stale.keys(), []);
  const body = adopted(current, getTask('changed'), await f.get()), card = adopted(current, findTask('changed-card'), await f.find());
  assert.equal(body.keys().length, 2); assert.equal(card.keys().length, 1);
  const newBody = body.keys().filter(key => !card.keys().includes(key)); assert.equal(newBody.length, 1);
  assert.equal(oldKeys.includes(newBody[0]!), false);
});

test('derived copies cannot mint recall credit through fresh lineage or wrapper hashes, and mixed find credits only the original', async t => {
  const original = evidence(), f = await fixture(t, 'sqlite', [original]), wrapperHashes = new Set<string>();
  let carried = structuredClone((await f.current()).progress!);
  const productive = carried.productiveSteps;
  for (let index = 0; index < 3; index++) {
    const artifact = await f.artifacts.put(new TextEncoder().encode(JSON.stringify({ copied: original.facts, wrapper: index })),
      { tenantId: original.tenantId, labels: [...original.labels], mediaType: 'application/json' });
    wrapperHashes.add(artifact.sha256);
    const derived: Evidence = { ...structuredClone(original), id: `derived-${index}`, sourceId: `copy-${index}`, lineageId: `new-copy-lineage-${index}`,
      locator: `derived-wrapper:${index}`, derivedFrom: [original.id], artifact };
    const state = await f.update(next => { next.evidence = [structuredClone(original), derived]; next.artifacts.push(artifact); });
    state.progress = structuredClone(carried);
    const find = adopted(state, findTask(`derived-find-${index}`, 'derived-wrapper'), await f.find('derived-wrapper'));
    const get = adopted(state, getTask(`derived-get-${index}`, derived.id), await f.get(derived.id));
    assert.deepEqual(find.keys(), []); assert.deepEqual(get.keys(), []);
    find.capture(); carried = get.capture(); assert.equal(carried.productiveSteps, productive);
    const mixed = adopted(state, findTask(`mixed-${index}`, 'record'), await f.find('record'));
    const originals = adopted(state, findTask(`original-${index}`, 'source-a'), await f.find('source-a'));
    assert.equal(mixed.keys().length, 1); assert.deepEqual(mixed.keys(), originals.keys());
  }
  assert.equal(wrapperHashes.size, 3); assert.equal(carried.policy.maxUnproductiveSteps, 3);
});

test('a valid shortened or paged find card earns only preparation, whereas partial get bodies do not', async t => {
  const source = evidence(); source.locator = 'long source '.repeat(40);
  const f = await fixture(t, 'sqlite', [source, evidence('b')]), state = await f.current();
  const page = await f.find('', 1); assert.equal(page.hasMore, true);
  const shortened = await f.find('source-a', 20); assert.equal(shortened.truncated, true);
  for (const [id, input, output] of [['page', findTask('page', '', 1), page], ['short', findTask('short'), shortened]] as const) {
    const item = adopted(state, input, output, true); assert.equal(item.keys().length, 1, id); assert.deepEqual(item.result.evidence, []);
  }
  const get = adopted(state, getTask('partial-get'), await f.get(), true); assert.deepEqual(get.keys(), []);
  assert.equal(evaluateCompletion(state.goal, state.evidence, [], state.policy).complete, false);
});

test('malformed, denied, foreign, noncurrent, reused or unadopted recall cannot fabricate preparation', async t => {
  const f = await fixture(t, 'sqlite', [evidence()]), current = await f.current(), cardOutput = await f.find(), bodyOutput = await f.get();
  for (const kind of ['find', 'get'] as const) for (const fault of ['malformed', 'denied-tool', 'denied-destination', 'foreign-scope', 'foreign-tenant',
    'restricted-label', 'retracted', 'stale-card', 'not-adopted', 'result-reuse', 'attempt-reuse', 'foreign-goal', 'bad-input'] as const) {
    const state = structuredClone(current), task = kind === 'find' ? findTask(`${kind}-${fault}`) : getTask(`${kind}-${fault}`);
    const item = adopted(state, task, structuredClone(kind === 'find' ? cardOutput : bodyOutput));
    const a = state.attempts.at(-1)!;
    if (fault === 'malformed') item.result.output = { cards: [{ id: 'evidence-a' }], status: 'available' };
    if (fault === 'denied-tool') state.policy.allowedTools = [];
    if (fault === 'denied-destination') state.policy.allowedDestinations = [];
    if (fault === 'foreign-scope') state.evidence[0]!.scope = 'other';
    if (fault === 'foreign-tenant') state.evidence[0]!.tenantId = 'other';
    if (fault === 'restricted-label') state.evidence[0]!.labels = ['secret'];
    if (fault === 'retracted') state.evidence[0]!.status = 'retracted';
    if (fault === 'stale-card') state.evidence[0]!.sourceId = 'different-source';
    if (fault === 'not-adopted') a.adopted = false;
    if (fault === 'result-reuse' || fault === 'attempt-reuse') {
      const reuse = { attemptId: 'prior', resultId: 'prior-result', resultArtifact: { id: 'old', sha256: 'a'.repeat(64), byteLength: 1,
        tenantId: 'tenant-a', labels: ['synthetic'], mediaType: 'application/json' }, observedAt: 1000, cacheKey: 'b'.repeat(64) };
      if (fault === 'result-reuse') item.result.reuse = reuse; else a.reuse = reuse;
    }
    if (fault === 'foreign-goal') a.goalRevision++;
    if (fault === 'bad-input') { if (kind === 'find') task.input.limit = 0; else task.input.maxBytes = 1; }
    assert.deepEqual(item.keys(), [], `${kind}/${fault}`);
  }
  for (const fault of ['too-large', 'original-detail', 'wrong-view', 'forged-body', 'restricted-artifact', 'blocked-artifact'] as const) {
    const state = structuredClone(current), task = getTask(fault), output = structuredClone(bodyOutput);
    const item = adopted(state, task, output);
    if (fault === 'too-large') {
      const tooLarge = await f.get('evidence-a', 256); assert.equal(tooLarge.status, 'too_large');
      item.result.output = asJson(tooLarge);
    }
    if (fault === 'original-detail') task.input.detail = 'original';
    if (fault === 'wrong-view') object(object(item.result.output!).value).view = 'historical_evidence';
    if (fault === 'forged-body') object(object(object(item.result.output!).value).evidence).facts = { record: 'a', value: 999 };
    if (fault === 'restricted-artifact' || fault === 'blocked-artifact') {
      const ref = { id: 'raw', sha256: 'a'.repeat(64), byteLength: 1, tenantId: 'tenant-a', labels: fault === 'restricted-artifact' ? ['secret'] : ['synthetic'], mediaType: 'text/plain' };
      state.evidence[0]!.artifact = ref; state.artifacts.push(ref);
      if (fault === 'blocked-artifact') state.dataLifecycle = { generation: 1, blockedArtifactIds: ['raw'], changes: [] };
      item.result.output = asJson(bounded(asJson({ evidence: state.evidence[0]!, view: 'current_accepted_evidence', stateRevision: state.revision }), 4096, {}));
    }
    assert.deepEqual(item.keys(), [], fault);
  }
});

for (const backend of adapters) test(`${backend}: actual find/get adoption earns first recall progress then identical reads stop at the default limit`, { timeout: 20000 }, async t => {
  const f = await fixture(t, backend), original = await f.current();
  const tasks = [findTask('find-a'), getTask('get-a'), getTask('get-b', 'evidence-b'),
    ...Array.from({ length: 4 }, (_, index) => getTask(`repeat-${index}`, 'evidence-a', [2048, 4096, 8192, 65536][index]!))];
  tasks.forEach((task, index) => { task.dependsOn = index ? [tasks[index - 1]!.id] : []; });
  await f.core.runtime.submitPlan(original.id, 'recall-plan', { baseStateRevision: original.revision, baseGoalRevision: original.goal.revision,
    basePlanRevision: 0, reason: 'Find provenance then read actual current bodies; repeating a known body is not progress', tasks, hypotheses: [] });
  for (const [index, task] of tasks.slice(0, 3).entries()) {
    const active = await f.core.runtime.reserve(original.id, task.id); await f.core.runtime.execute(original.id, active.id); await f.core.runtime.settlePending(active.id);
    const state = await f.core.runtime.adopt(original.id, active.id), adopted = state.attempts.find(value => value.id === active.id)!;
    assert.equal(adopted.adopted, true); assert.equal(adopted.status, 'succeeded'); assert.ok(adopted.resultArtifact);
    const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await f.artifacts.get(adopted.resultArtifact, state.policy))));
    assert.deepEqual(result.evidence, []); assert.deepEqual(result.artifacts, []); assert.equal(result.status, 'success');
    assert.equal(state.progress!.productiveSteps, original.progress!.productiveSteps + index + 1);
    assert.equal(state.progress!.consecutiveUnproductive, 0); assert.deepEqual(state.evidence, original.evidence);
  }
  const stopped = await f.core.runtime.runUntilYield(original.id, 20);
  assert.equal(stopped.kind, 'blocked'); assert.equal(stopped.reason, 'no_progress_limit');
  const state = await f.current(); assert.equal(state.progress!.policy.maxUnproductiveSteps, 3);
  assert.equal(state.progress!.productiveSteps, original.progress!.productiveSteps + 3); assert.equal(state.progress!.consecutiveUnproductive, 3);
  assert.equal(state.attempts.length, 6); assert.equal(state.attempts.filter(value => value.adopted).length, 6);
  assert.equal(state.attempts.some(value => value.taskId === 'repeat-3'), false);
  assert.equal(state.budget.used.toolCalls, 6); assert.equal(state.budget.reservedToolCalls, 0);
  assert.deepEqual(state.evidence, original.evidence); assert.deepEqual(state.goal, original.goal); assert.deepEqual(state.policy, original.policy);
  assert.equal(evaluateCompletion(state.goal, state.evidence, [], state.policy).complete, false); assert.equal(f.planner.inputs.length, 0);
  const beforeRepeat = structuredClone(state), repeat = await f.core.runtime.runUntilYield(original.id, 20); assert.equal(repeat.reason, 'no_progress_limit');
  const afterRepeat = await f.current(); assert.deepEqual(afterRepeat.attempts, beforeRepeat.attempts); assert.deepEqual(afterRepeat.budget, beforeRepeat.budget);
});
