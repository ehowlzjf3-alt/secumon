import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { A2aTask } from '../application/a2a-contracts.js';
import type { Tool } from '../application/ports.js';
import type { TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import { collaborationToolKind } from '../application/collaboration-tool-identity.js';
import { snapshotTool } from '../application/tool-contracts.js';
import { acceptedToolProgressKeys, captureProgress, progressGate } from '../application/work-progress.js';
import { asJson } from '../application/plan-validator.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { openHostA2a } from '../presentation/host-a2a.js';
import { A2A_REGISTRATION_ID, a2aRegistrationProbe } from './host-a2a-registration-fixture.js';
import { artifact, attempt, initial } from './state-conformance-helpers.js';

type Operation = 'send' | 'get' | 'cancel';
const digester = new Sha256Digester();
const request: TaskSpec['input'] = { parts: [{ text: 'Check the current retention rule.', metadata: { trace: 'one' } },
  { data: { system: 'documents', revision: 1 }, metadata: { trace: 'one' } }], metadata: { sentAt: 'first' } };
function remote(id = 'remote-task'): A2aTask {
  return { id, contextId: 'remote-context', status: { state: 'TASK_STATE_INPUT_REQUIRED', timestamp: '2026-09-08T00:00:00Z',
    message: { messageId: 'remote-question', taskId: id, contextId: 'remote-context', role: 'ROLE_AGENT',
      parts: [{ text: 'Which document system?', metadata: { trace: 'one' } }, { data: { options: ['records', 'contracts'] } }] } },
    artifacts: [{ artifactId: 'remote-artifact', name: 'Current observation', parts: [{ text: 'The applicable system is not yet known.' },
      { data: { candidates: 2 } }], metadata: { trace: 'one' } }], metadata: { trace: 'one' } };
}
function churn(source: A2aTask, suffix: string): A2aTask {
  const value = structuredClone(source); value.id = 'remote-task-' + suffix; value.contextId = 'context-' + suffix;
  value.metadata = { trace: suffix }; value.status.timestamp = '2026-09-08T01:00:00Z';
  if (value.status.message) {
    value.status.message.messageId = 'message-' + suffix; value.status.message.taskId = value.id;
    value.status.message.contextId = value.contextId; value.status.message.metadata = { trace: suffix };
    value.status.message.parts.forEach(part => { part.metadata = { trace: suffix }; });
  }
  value.artifacts?.forEach((item, index) => {
    item.artifactId = 'artifact-' + suffix + '-' + index; item.name = 'Display name ' + suffix;
    item.description = 'Display description ' + suffix; item.metadata = { trace: suffix };
    item.parts.forEach(part => { part.metadata = { trace: suffix }; });
  });
  return value;
}

// The real host factory supplies identity. These units supply already adopted state/results; the entry suite executes transport and custody.
async function fixture(t: TestContext) {
  const probe = a2aRegistrationProbe(true), controller = new AbortController(), state = initial('a2a-progress');
  state.policy.allowedLabels.push('internal'); state.policy.allowWrites = true;
  const opened = await openHostA2a(probe.registration, { agentId: 'unit-agent', root: '/a2a-progress-unit', scope: state.goal.scope,
    actor: state.policy, signal: controller.signal });
  assert.ok(opened); t.after(async () => { controller.abort(); await opened.close(); });
  state.policy.allowedTools.push(...opened.allowedTools);
  function adopted(operation: Operation, value: WorkState = state, reply: A2aTask = remote(), supplied?: TaskSpec['input']) {
    const original = opened!.tools.find(tool => tool.definition.id === A2A_REGISTRATION_ID + '.' + operation); assert.ok(original);
    const tool = snapshotTool(original), id = 'step-' + value.attempts.length;
    const task: TaskSpec = { id, description: 'Observe an authenticated external reply', toolId: tool.definition.id,
      toolVersion: tool.definition.version, effect: tool.definition.effect,
      input: structuredClone(supplied ?? (operation === 'send' ? request : { taskId: reply.id })), dependsOn: [], satisfies: [], maxAttempts: 1 };
    const result: ToolResult = { resultId: id + ':result', attemptId: id, status: 'success', effectState: operation === 'get' ? 'none' : 'confirmed',
      output: asJson({ kind: 'unreviewed_a2a_reply', peer: A2A_REGISTRATION_ID, reply: operation === 'send' ? { task: reply } : reply }),
      evidence: [], artifacts: [], cursor: null, error: null, coverage: 'complete' };
    const ownAttempt = { ...attempt('succeeded'), id, taskId: id, toolId: task.toolId, toolVersion: task.toolVersion,
      effect: task.effect, effectState: result.effectState, scope: value.goal.scope, goalRevision: value.goal.revision,
      adopted: true, resultId: result.resultId };
    value.attempts.push(ownAttempt);
    const keys = (selected: Tool | undefined = tool) => acceptedToolProgressKeys(value, task, result, digester, false, selected);
    return { state: value, original, tool, task, result, ownAttempt, keys,
      capture: () => captureProgress(value, digester, id + ':settled', 1000, { additionalKeys: keys() }) };
  }
  return { state, probe, adopted };
}

test('a2a progress: actual host identity survives snapshots while matching metadata and output alone earn no credit', async t => {
  const f = await fixture(t);
  for (const operation of ['send', 'get', 'cancel'] as const) {
    const item = f.adopted(operation);
    assert.equal(collaborationToolKind(item.tool), 'a2a'); assert.ok(item.keys().length > 0, operation);
    assert.deepEqual(item.keys(snapshotTool(snapshotTool(item.tool))), item.keys());
    const copied: Tool = { ...item.tool, definition: structuredClone(item.tool.definition) };
    assert.equal(collaborationToolKind(copied), undefined);
    assert.deepEqual(item.keys(copied), []); assert.deepEqual(item.keys(snapshotTool(copied)), []);
    assert.deepEqual(acceptedToolProgressKeys(item.state, item.task, item.result, digester), []);
  }
  assert.equal(f.probe.counts.sends + f.probe.counts.gets + f.probe.counts.cancels, 0, 'classification is not transport verification');
});

test('a2a progress: an accepted send credits original text and data once despite fresh request and reply identifiers', async t => {
  const f = await fixture(t), first = f.adopted('send'), keys = first.keys(); assert.ok(keys.length > 0);
  assert.equal(first.capture().productiveSteps, 1);
  for (let n = 1; n <= 3; n++) {
    const repeatedRequest = structuredClone(request); repeatedRequest['taskId'] = 'follow-up-' + n;
    repeatedRequest['contextId'] = 'sender-context-' + n; repeatedRequest['metadata'] = { sentAt: n, rpcId: 'rpc-' + n };
    repeatedRequest['parts'] = [{ text: 'Check the current retention rule.', metadata: { trace: n } },
      { data: { revision: 1, system: 'documents' }, metadata: { trace: n } }];
    const repeated = f.adopted('send', f.state, churn(remote(), String(n)), repeatedRequest);
    assert.notEqual(repeated.task.id, first.task.id); assert.notEqual(repeated.result.resultId, first.result.resultId);
    assert.deepEqual(repeated.keys(), keys); assert.equal(repeated.capture().productiveSteps, 1);
  }
  const changedText = f.adopted('send', f.state, remote(), { parts: [{ text: 'Check the deletion rule.' }, { data: { system: 'documents', revision: 1 } }] });
  const changedData = f.adopted('send', f.state, remote(), { parts: [{ text: 'Check the current retention rule.' }, { data: { system: 'documents', revision: 2 } }] });
  assert.notDeepEqual(changedText.keys(), keys); assert.notDeepEqual(changedData.keys(), keys);
  assert.equal(f.state.progress?.policy.maxUnproductiveSteps, 3);
  assert.deepEqual(progressGate(f.state, 1000), { kind: 'blocked', reason: 'no_progress_limit' });
  assert.deepEqual(f.state.evidence, []); assert.equal(f.state.generatedAnswer, undefined);
});

test('a2a progress: rereading the same task meaning ignores message, artifact, context, timestamp and metadata churn', async t => {
  const f = await fixture(t), first = f.adopted('get'), keys = first.keys(); assert.ok(keys.length > 0);
  assert.equal(first.capture().productiveSteps, 1);
  for (let n = 1; n <= 3; n++) {
    const sameTask = churn(remote(), String(n)); sameTask.id = 'remote-task';
    sameTask.status.message!.taskId = sameTask.id;
    const repeated = f.adopted('get', f.state, sameTask);
    assert.equal(repeated.task.input['taskId'], first.task.input['taskId']);
    assert.notEqual(repeated.task.id, first.task.id);
    assert.deepEqual(repeated.keys(), keys); assert.equal(repeated.capture().productiveSteps, 1);
  }
  const otherTask = f.adopted('get', f.state, remote('another-requested-task'));
  assert.notDeepEqual(otherTask.keys(), keys, 'the first read of a different requested resource remains useful even with the same response meaning');
  assert.ok(otherTask.keys().some(key => !f.state.progress!.knownKeys.includes(key)));
  assert.equal(f.state.progress?.policy.maxUnproductiveSteps, 3);
  assert.deepEqual(progressGate(f.state, 1000), { kind: 'blocked', reason: 'no_progress_limit' });
  assert.deepEqual(f.state.evidence, []); assert.equal(f.state.generatedAnswer, undefined);
});

test('a2a progress: task status, question text and artifact data changes are preparation but never evidence or completion', async t => {
  const f = await fixture(t), first = f.adopted('get'), keys = first.keys(), originalGoal = structuredClone(f.state.goal);
  const status = remote(); status.status.state = 'TASK_STATE_WORKING';
  const question = remote(); question.status.message!.parts[0] = { text: 'Which retention date applies?' };
  const text = remote(); text.artifacts![0]!.parts[0] = { text: 'The applicable system is records.' };
  const data = remote(); data.artifacts![0]!.parts[1] = { data: { candidates: 1 } };
  for (const changed of [status, question, text, data]) assert.notDeepEqual(f.adopted('get', f.state, changed).keys(), keys);
  const cancelled = remote(); cancelled.status.state = 'TASK_STATE_CANCELED';
  const cancel = f.adopted('cancel', f.state, cancelled), laterGet = f.adopted('get', f.state, cancelled);
  assert.ok(cancel.keys().length > 0); assert.deepEqual(cancel.keys(), laterGet.keys(), 'reading the same cancellation cannot create another semantic milestone');
  const completed = remote(); completed.status.state = 'TASK_STATE_COMPLETED';
  f.adopted('get', f.state, completed).capture();
  assert.deepEqual(f.state.evidence, []); assert.equal(f.state.generatedAnswer, undefined);
  assert.deepEqual(f.state.goal, originalGoal); assert.notEqual(f.state.status, 'completed');
});

test('a2a progress: provider, version, destination, policy, envelope and selected remote task must remain consistent', async t => {
  const f = await fixture(t);
  for (const fault of ['provider', 'version', 'destination', 'policy', 'peer', 'kind', 'task'] as const) {
    const value = structuredClone(f.state); value.attempts = [];
    const item = f.adopted('get', value), definition = structuredClone(item.original.definition);
    try {
      if (fault === 'provider') item.original.definition.provider = 'different-peer';
      if (fault === 'version') { item.original.definition.version = '2.0'; item.task.toolVersion = '2.0'; item.ownAttempt.toolVersion = '2.0'; }
      if (fault === 'destination') value.policy.allowedDestinations = [];
      if (fault === 'policy') value.policy.allowedTools = [];
      if (fault === 'peer' || fault === 'kind') item.result.output = asJson({ kind: fault === 'kind' ? 'trusted_a2a_reply' : 'unreviewed_a2a_reply',
        peer: fault === 'peer' ? 'different-peer' : A2A_REGISTRATION_ID, reply: remote() });
      if (fault === 'task') item.task.input['taskId'] = 'a-different-task';
      if (fault === 'provider') assert.throws(() => snapshotTool(item.original), /invalid_contract/);
      else assert.deepEqual(item.keys(snapshotTool(item.original)), [], fault);
    } finally { Object.assign(item.original.definition, definition); }
  }
});

test('a2a progress: unknown or unapplied sends and unadopted, reused, partial or contaminated replies earn no progress', async t => {
  const f = await fixture(t);
  for (const fault of ['unknown', 'not-applied', 'unadopted', 'reused', 'partial', 'artifacts', 'evidence'] as const) {
    const value = structuredClone(f.state); value.attempts = [];
    const item = f.adopted('send', value);
    if (fault === 'unknown' || fault === 'not-applied') {
      item.result.effectState = fault === 'unknown' ? 'unknown' : 'none'; item.ownAttempt.effectState = item.result.effectState;
    }
    if (fault === 'unadopted') item.ownAttempt.adopted = false;
    if (fault === 'reused') item.result.reuse = { attemptId: 'prior', resultId: 'prior-result', resultArtifact: artifact(), observedAt: 999, cacheKey: 'a'.repeat(64) };
    if (fault === 'partial') { item.result.status = 'partial'; item.result.coverage = 'partial'; item.ownAttempt.status = 'partial'; }
    if (fault === 'artifacts') item.result.artifacts = [artifact()];
    if (fault === 'evidence') item.result.evidence = [{ id: 'foreign-observation', tenantId: value.policy.tenantId, scope: value.goal.scope,
      sourceId: 'remote', lineageId: 'foreign', locator: 'a2a:unverified', observedAt: 1000, recordedAt: 1000, labels: ['internal'],
      status: 'accepted', coverage: 'complete', supersedes: [], derivedFrom: [], facts: { available: true }, artifact: null }];
    assert.deepEqual(item.keys(), [], fault);
  }
});
