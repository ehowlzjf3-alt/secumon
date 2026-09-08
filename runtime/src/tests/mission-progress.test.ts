import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { MissionEvent, MissionRule } from '../application/mission-contracts.js';
import type { RuntimeServices } from '../application/services.js';
import type { Tool } from '../application/ports.js';
import type { TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import { collaborationToolKind } from '../application/collaboration-tool-identity.js';
import { snapshotTool } from '../application/tool-contracts.js';
import { acceptedToolProgressKeys, captureProgress, progressGate } from '../application/work-progress.js';
import { asJson } from '../application/plan-validator.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { openHostMissions } from '../presentation/host-missions.js';
import { missionRegistrationProbe } from './host-missions-registration-fixture.js';
import { artifact, attempt, initial } from './state-conformance-helpers.js';

const digester = new Sha256Digester();
const rule = (id = 'observations'): MissionRule => ({ id, sourceId: 'observations', resourceId: 'resource-' + id,
  pollIntervalMs: 1000, maxResumes: 4, maxIdlePolls: 4, maxNoProgress: 3 });
const event = (id = 'envelope-one'): MissionEvent => ({ id, kind: 'observation', referenceId: 'original-reference', occurredAt: 1000,
  body: { text: 'Current original observation.', id: 'original-id', occurredAt: 900, cursor: 7, metadata: { version: 1 } } });
const list = (rules = [rule()]) => ({ kind: 'mission_rules', rules: rules.map(value => ({ rule: value, cursor: 1, pendingRun: false, nextPollAt: 2000 })) });
const events = (selected = rule(), values = [event()]) => ({ kind: 'unreviewed_mission_events', rule: selected,
  events: values, cursor: 1, status: 'active' as const, reason: null });

// The actual host factory supplies identity. Only construction uses ids; adoption is a fixture, and tool/storage/source execution belongs to the entry suite.
async function fixture(t: TestContext) {
  const state = initial('mission-progress'), probe = missionRegistrationProbe(), controller = new AbortController();
  state.policy.allowedLabels.push('internal');
  const services = { ids: { next: (prefix: string) => prefix + '-progress-unit' } } as RuntimeServices;
  const opened = await openHostMissions(probe.registration, { agentId: 'unit-agent', root: '/mission-progress-unit', scope: state.goal.scope,
    actor: state.policy, signal: controller.signal }, { services });
  assert.ok(opened); t.after(async () => { controller.abort(); await opened.close(); });
  state.policy.allowedTools.push(...opened.allowedTools);
  const tool = snapshotTool(opened.tools[0]!);
  function adopted(output: unknown = events(), supplied: TaskSpec['input'] = { ruleId: rule().id, maxBytes: 8192 }, value: WorkState = state) {
    const id = 'step-' + value.attempts.length;
    const task: TaskSpec = { id, description: 'Read a registered mission observation', toolId: tool.definition.id,
      toolVersion: tool.definition.version, effect: 'read', input: structuredClone(supplied), dependsOn: [], satisfies: [], maxAttempts: 1 };
    const result: ToolResult = { resultId: id + ':result', attemptId: id, status: 'success', effectState: 'none',
      output: asJson(output), evidence: [], artifacts: [], cursor: null, error: null, coverage: 'complete' };
    const ownAttempt = { ...attempt('succeeded'), id, taskId: id, toolId: task.toolId, toolVersion: task.toolVersion,
      scope: value.goal.scope, goalRevision: value.goal.revision, adopted: true, resultId: result.resultId };
    value.attempts.push(ownAttempt);
    const keys = (selected: Tool | undefined = tool) => acceptedToolProgressKeys(value, task, result, digester, false, selected);
    return { state: value, task, result, ownAttempt, keys,
      capture: () => captureProgress(value, digester, id + ':settled', 1000, { additionalKeys: keys() }) };
  }
  return { state, tool, probe, adopted };
}

test('mission progress: actual host identity survives snapshots while copied metadata and matching output alone grant no credit', async t => {
  const f = await fixture(t);
  for (const item of [f.adopted(list(), { maxBytes: 8192 }), f.adopted()]) {
    assert.equal(collaborationToolKind(f.tool), 'mission'); assert.ok(item.keys().length > 0);
    assert.deepEqual(item.keys(snapshotTool(snapshotTool(f.tool))), item.keys());
    const copied: Tool = { ...f.tool, definition: structuredClone(f.tool.definition) };
    assert.equal(collaborationToolKind(copied), undefined);
    assert.deepEqual(item.keys(copied), []); assert.deepEqual(item.keys(snapshotTool(copied)), []);
    assert.deepEqual(acceptedToolProgressKeys(item.state, item.task, item.result, digester), []);
  }
  assert.equal(f.probe.counts.polls, 0, 'unit adoption does not authenticate a source read');
});

test('mission progress: list cursor, pending flag, poll time and ordering cannot renew the same rules past the default limit', async t => {
  const f = await fixture(t), rules = [rule(), rule('second')], first = f.adopted(list(rules), { maxBytes: 8192 });
  const keys = first.keys(); assert.equal(keys.length, 2); assert.equal(first.capture().productiveSteps, 1);
  for (let n = 1; n <= 3; n++) {
    const page = list([...rules].reverse());
    page.rules.forEach(value => { value.cursor += n; value.pendingRun = n % 2 === 1; value.nextPollAt += n * 1000; });
    const repeated = f.adopted(page, { maxBytes: 16384 });
    assert.notEqual(repeated.task.id, first.task.id); assert.deepEqual(repeated.keys().sort(), [...keys].sort());
    assert.equal(repeated.capture().productiveSteps, 1);
  }
  assert.deepEqual(f.adopted(list([]), { maxBytes: 8192 }).keys(), []);
  assert.equal(f.state.progress?.policy.maxUnproductiveSteps, 3);
  assert.deepEqual(progressGate(f.state, 1000), { kind: 'blocked', reason: 'no_progress_limit' });
});

test('mission progress: reissued event IDs, receipt times, cursor and event order keep the same source-body keys and default stop', async t => {
  const f = await fixture(t), originals = [event(), { ...event('envelope-two'), referenceId: 'second-original', body: { text: 'Another original.' } }];
  const first = f.adopted(events(rule(), originals)), keys = first.keys(); assert.equal(keys.length, 3);
  const originalOutput = structuredClone(first.result.output); assert.equal(first.capture().productiveSteps, 1);
  for (let n = 1; n <= 3; n++) {
    const repeatedEvents = [...originals].reverse().map((value, index) => ({ ...structuredClone(value), id: 'reissued-' + n + '-' + index, occurredAt: 1000 + n }));
    const page = { ...events(rule(), repeatedEvents), cursor: n + 1 }, repeated = f.adopted(page);
    assert.deepEqual(repeated.keys().sort(), [...keys].sort()); assert.equal(repeated.capture().productiveSteps, 1);
  }
  assert.deepEqual(first.result.output, originalOutput, 'classifying progress does not strip the stored original');
  assert.equal(f.state.progress?.policy.maxUnproductiveSteps, 3);
  assert.deepEqual(progressGate(f.state, 1000), { kind: 'blocked', reason: 'no_progress_limit' });
});

test('mission progress: actual body content and another rule remain distinct preparation without becoming evidence or completion', async t => {
  const f = await fixture(t), first = f.adopted(), keys = first.keys(), goal = structuredClone(f.state.goal);
  first.capture();
  for (const body of [
    { text: 'A changed observation.', id: 'original-id', occurredAt: 900, cursor: 7, metadata: { version: 1 } },
    { text: 'Current original observation.', id: 'original-id', occurredAt: 901, cursor: 7, metadata: { version: 1 } },
    { text: 'Current original observation.', id: 'original-id', occurredAt: 900, cursor: 7, metadata: { version: 2 } },
  ]) {
    const changed = f.adopted(events(rule(), [{ ...event(), body }])), original = structuredClone(changed.result.output);
    assert.notDeepEqual(changed.keys(), keys, 'metadata inside the source body is original data, not envelope metadata');
    assert.deepEqual(changed.result.output, original);
  }
  const another = rule('another-rule'), distinct = f.adopted(events(another), { ruleId: another.id, maxBytes: 8192 });
  assert.notDeepEqual(distinct.keys(), keys); assert.equal(distinct.capture().productiveSteps, 2);
  const readAfterList = f.adopted(list(), { maxBytes: 8192 });
  assert.ok(keys.includes(readAfterList.keys()[0]!), 'list and event reads share the same rule milestone');
  assert.deepEqual(f.state.evidence, []); assert.equal(f.state.generatedAnswer, undefined);
  assert.deepEqual(f.state.goal, goal); assert.notEqual(f.state.status, 'completed');
});

test('mission progress: rule selection, current authority and adopted work identity must match', async t => {
  const f = await fixture(t);
  for (const fault of ['rule-id', 'list-for-rule', 'denied-tool', 'denied-destination', 'unadopted', 'foreign-goal', 'foreign-scope'] as const) {
    const state = structuredClone(f.state); state.attempts = []; const item = f.adopted(events(), undefined, state);
    if (fault === 'rule-id') item.task.input['ruleId'] = 'different-rule';
    if (fault === 'list-for-rule') item.result.output = asJson(list());
    if (fault === 'denied-tool') state.policy.allowedTools = [];
    if (fault === 'denied-destination') state.policy.allowedDestinations = [];
    if (fault === 'unadopted') item.ownAttempt.adopted = false;
    if (fault === 'foreign-goal') item.ownAttempt.goalRevision++;
    if (fault === 'foreign-scope') item.ownAttempt.scope = 'another-agent-scope';
    assert.deepEqual(item.keys(), [], fault);
  }
});

test('mission progress: partial, oversized, reused or contaminated event replies never earn preparation credit', async t => {
  const f = await fixture(t);
  for (const fault of ['partial', 'too-large', 'reused', 'artifacts', 'foreign-evidence', 'result-cursor'] as const) {
    const state = structuredClone(f.state); state.attempts = []; const item = f.adopted(events(), undefined, state);
    if (fault === 'partial') { item.result.status = 'partial'; item.result.coverage = 'partial'; item.ownAttempt.status = 'partial'; }
    if (fault === 'too-large') item.result.output = { kind: 'unreviewed_mission_events', status: 'too_large', byteLength: 1000000 };
    if (fault === 'reused') item.result.reuse = { attemptId: 'prior', resultId: 'prior-result', resultArtifact: artifact(), observedAt: 999, cacheKey: 'a'.repeat(64) };
    if (fault === 'artifacts') item.result.artifacts = [artifact()];
    if (fault === 'foreign-evidence') item.result.evidence = [{ id: 'foreign-observation', tenantId: 'another-tenant', scope: 'another-agent',
      sourceId: 'observations', lineageId: 'foreign', locator: 'mission:unverified', observedAt: 1000, recordedAt: 1000, labels: ['internal'],
      status: 'accepted', coverage: 'complete', supersedes: [], derivedFrom: [], facts: { available: true }, artifact: null }];
    if (fault === 'result-cursor') item.result.cursor = 'unsettled-page';
    assert.deepEqual(item.keys(), [], fault);
  }
});
