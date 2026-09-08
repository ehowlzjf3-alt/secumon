import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { Tool } from '../application/ports.js';
import { acceptedToolProgressKeys, captureProgress, progressGate } from '../application/work-progress.js';
import { markCollaborationTool, collaborationToolKind } from '../application/collaboration-tool-identity.js';
import { snapshotTool } from '../application/tool-contracts.js';
import { asJson } from '../application/plan-validator.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { artifact, attempt, initial } from './state-conformance-helpers.js';

type Kind = Exclude<Parameters<typeof markCollaborationTool>[1], 'budget' | 'a2a'>;
const digester = new Sha256Digester();
const card = { id: 'case-1', title: 'Previous case', path: 'db://cases/1', sourceVersion: 'original-v1', revision: 1, status: 'active' as const };
const body = 'The previous deployment failed.';
const kinds: Kind[] = ['archive-search', 'archive-get', 'board-read', 'board-requests', 'board-command'];
const ids: Record<Kind, string> = { 'archive-search': 'archive.search', 'archive-get': 'archive.get',
  'board-read': 'core.board.read', 'board-requests': 'core.board.requests.read', 'board-command': 'core.board.publish' };
const publish = { boardId: 'discussion', expectedRevision: 1, id: 'post-1', entityId: 'entity', kind: 'question', body: 'Has anyone seen this failure?',
  labels: ['synthetic'], evidenceIds: [], quotedPostIds: [], replyTo: null, relation: null, causeId: 'cause-1', expiresAt: null };
function input(kind: Kind): TaskSpec['input'] {
  return kind === 'archive-search' ? { query: 'case', limit: 4, maxBytes: 8192 } : kind === 'archive-get' ? { id: card.id, maxBytes: 8192 } :
    kind === 'board-command' ? structuredClone(publish) : { boardId: 'discussion', maxPosts: 4, maxRequests: 4, maxBytes: 8192 };
}
function output(kind: Kind) {
  if (kind === 'archive-search') return { kind: 'archive_reference', provider: 'archive', documents: [card], truncated: false };
  if (kind === 'archive-get') return { kind: 'archive_reference', provider: 'archive', document: { ...card, body } };
  if (kind === 'board-command') return { boardId: 'discussion', postId: publish.id, status: 'published' };
  if (kind === 'board-read') return { id: 'discussion', revision: 1, roleId: 'participant', observedAt: 1000,
    interpretation: 'discussion_not_independent_evidence', visibility: 'permitted_current_posts_only', findingsBasis: 'returned_posts_only',
    entities: [], posts: [], findings: [], nextCursor: null };
  return { boardId: 'discussion', revision: 1, roleId: 'participant', observedAt: 1000,
    interpretation: 'observed_coordination_metadata', visibility: 'permitted_participant_requests', requests: [{
      id: 'request-1', questionId: 'question-1', fromAgentId: 'requester', toAgentId: 'participant', fromWorkId: 'other-work', fromGoalRevision: 1,
      dueAt: 2000, status: 'offered', acceptedWorkId: null, acceptedGoalRevision: null, answerPostId: null, updatedAt: 1000, effectiveStatus: 'offered',
    }], nextCursor: null };
}

// This unit fixture marks native adapter identity and supplies an already adopted result. It does not execute the adapter or authenticate its storage proof.
function native(kind: Kind): Tool {
  return markCollaborationTool({ definition: { provider: kind.startsWith('archive') ? 'archive' : 'core', id: ids[kind], version: '1',
    description: 'Native collaboration preparation unit fixture', effect: kind === 'board-command' ? 'write' : 'read',
    destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
    async execute() { throw new Error('unit_fixture_does_not_execute'); } }, kind);
}
function adopted(kind: Kind, state: WorkState = initial('collaboration-progress'), value: unknown = output(kind), supplied: TaskSpec['input'] = input(kind)) {
  const tool = native(kind), id = 'step-' + state.attempts.length;
  state.policy.allowedTools = [...new Set([...state.policy.allowedTools, tool.definition.id])];
  if (kind === 'board-command') state.policy.allowWrites = true;
  const task: TaskSpec = { id, description: 'Prepare collaboration', toolId: tool.definition.id, toolVersion: '1',
    effect: tool.definition.effect, input: supplied, dependsOn: [], maxAttempts: 1, satisfies: [] };
  const result: ToolResult = { resultId: id + ':result', attemptId: id, status: 'success', effectState: task.effect === 'write' ? 'confirmed' : 'none',
    output: asJson(value), evidence: [], artifacts: [], cursor: null, error: null, coverage: 'complete',
    ...(task.effect === 'write' ? { effectReceipt: { provider: 'board', operationId: id, outcome: 'applied' as const,
      origin: 'execution' as const, artifact: artifact(), observedAt: 1000 } } : {}) };
  const ownAttempt = { ...attempt('succeeded'), id, taskId: id, toolId: task.toolId, toolVersion: task.toolVersion,
    effect: task.effect, effectState: result.effectState, scope: state.goal.scope, goalRevision: state.goal.revision, adopted: true, resultId: result.resultId };
  state.attempts.push(ownAttempt);
  const keys = (selected: Tool | undefined = tool) => acceptedToolProgressKeys(state, task, result, digester, false, selected);
  return { state, tool, task, result, ownAttempt, keys,
    capture: () => captureProgress(state, digester, id + ':settled', 1000, { additionalKeys: keys() }) };
}

test('collaboration progress: lookalikes and copied metadata never inherit native identity, including request-list fallback', () => {
  for (const kind of kinds) {
    const item = adopted(kind);
    assert.ok(item.keys().length > 0, kind);
    const copied: Tool = { ...item.tool, definition: structuredClone(item.tool.definition) };
    assert.equal(collaborationToolKind(copied), undefined);
    assert.deepEqual(item.keys(copied), [], kind);
    assert.deepEqual(item.keys(snapshotTool(copied)), [], kind);
    assert.deepEqual(acceptedToolProgressKeys(item.state, item.task, item.result, digester), [], kind);
  }
});

test('collaboration progress: registration snapshots preserve native identity without serializing it', () => {
  for (const kind of kinds) {
    const item = adopted(kind), snapshot = snapshotTool(item.tool), second = snapshotTool(snapshot);
    assert.notEqual(snapshot, item.tool); assert.equal(collaborationToolKind(snapshot), kind);
    assert.equal(collaborationToolKind(second), kind); assert.deepEqual(item.keys(snapshot), item.keys());
    assert.deepEqual(item.keys(second), item.keys());
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot.definition)), item.tool.definition);
  }
});

test('collaboration progress: archive discovery and original body are distinct stages while revision, order, query and task churn add no credit', () => {
  const state = initial('archive-progress-stages');
  const first = adopted('archive-search', state, { kind: 'archive_reference', provider: 'archive',
    documents: [card, { ...card, id: 'case-2', path: 'db://cases/2' }], truncated: false });
  const originalKeys = first.keys(); assert.equal(originalKeys.length, 2); assert.equal(first.capture().productiveSteps, 1);
  const reordered = adopted('archive-search', state, { kind: 'archive_reference', provider: 'archive',
    documents: [{ ...card, id: 'case-2', path: 'db://cases/2', revision: 9 }, { ...card, revision: 8 }], truncated: false },
    { query: 'Previous', limit: 8, maxBytes: 16384 });
  assert.notEqual(reordered.task.id, first.task.id); assert.deepEqual(reordered.keys().sort(), [...originalKeys].sort());
  assert.equal(reordered.capture().productiveSteps, 1);
  const read = adopted('archive-get', state); assert.equal(read.keys().length, 2);
  assert.ok(read.keys().some(key => originalKeys.includes(key))); assert.equal(read.capture().productiveSteps, 2);
  for (let revision = 2; revision <= 4; revision++) {
    const again = adopted('archive-get', state, { kind: 'archive_reference', provider: 'archive', document: { ...card, body, revision } },
      { id: card.id, maxBytes: 16384 });
    assert.deepEqual(again.keys(), read.keys()); assert.equal(again.capture().productiveSteps, 2);
  }
  assert.equal(state.progress?.policy.maxUnproductiveSteps, 3);
  assert.deepEqual(progressGate(state, 1000), { kind: 'blocked', reason: 'no_progress_limit' });
  assert.deepEqual(state.evidence, []);
});

test('collaboration progress: empty and oversized archive reads add no credit, but changed original content does', () => {
  for (const [kind, value] of [
    ['archive-search', { kind: 'archive_reference', provider: 'archive', documents: [], truncated: false }],
    ['archive-get', { kind: 'archive_reference', provider: 'archive', document: null }],
    ['archive-get', { kind: 'archive_reference', status: 'too_large', byteLength: 10000 }],
  ] as const) assert.deepEqual(adopted(kind, undefined, value).keys(), []);
  const state = initial('changed-archive-original'), first = adopted('archive-get', state); first.capture();
  const changed = adopted('archive-get', state, { kind: 'archive_reference', provider: 'archive', document: { ...card, body: 'Changed original.' } });
  assert.equal(changed.keys()[0], first.keys()[0]); assert.notEqual(changed.keys()[1], first.keys()[1]);
  assert.equal(changed.capture().productiveSteps, 2); assert.deepEqual(state.evidence, []);
});

test('collaboration progress: unknown, not-applied, recovered, reused or rejected writes cannot claim publication progress', () => {
  for (const fault of ['unknown', 'not-applied', 'recovered', 'missing-receipt', 'result-reuse', 'attempt-reuse', 'not-adopted', 'foreign-goal', 'denied-write'] as const) {
    const item = adopted('board-command');
    const reuse = { attemptId: 'prior', resultId: 'prior-result', resultArtifact: artifact(), observedAt: 999, cacheKey: 'a'.repeat(64) };
    if (fault === 'unknown') { item.result.effectState = 'unknown'; item.ownAttempt.effectState = 'unknown'; }
    if (fault === 'not-applied') { item.result.effectState = 'none'; item.ownAttempt.effectState = 'none'; item.result.effectReceipt!.outcome = 'not_applied'; }
    if (fault === 'recovered') item.result.effectReceipt!.origin = 'reconciliation';
    if (fault === 'missing-receipt') delete item.result.effectReceipt;
    if (fault === 'result-reuse') item.result.reuse = reuse;
    if (fault === 'attempt-reuse') item.ownAttempt.reuse = reuse;
    if (fault === 'not-adopted') item.ownAttempt.adopted = false;
    if (fault === 'foreign-goal') item.ownAttempt.goalRevision++;
    if (fault === 'denied-write') item.state.policy.allowWrites = false;
    assert.deepEqual(item.keys(), [], fault);
  }
});

test('collaboration progress: changing publication IDs, cause IDs and revision cannot renew the same content credit', () => {
  const state = initial('repeat-publication'), first = adopted('board-command', state); first.capture();
  for (let revision = 2; revision <= 4; revision++) {
    const next = adopted('board-command', state, { boardId: 'discussion', postId: 'post-' + revision, status: 'published' },
      { ...publish, id: 'post-' + revision, causeId: 'cause-' + revision, expectedRevision: revision });
    assert.notEqual(next.task.id, first.task.id); assert.deepEqual(next.keys(), first.keys());
    assert.equal(next.capture().productiveSteps, 1);
  }
  assert.equal(state.progress?.policy.maxUnproductiveSteps, 3);
  assert.deepEqual(progressGate(state, 1000), { kind: 'blocked', reason: 'no_progress_limit' });
  const changed = adopted('board-command', initial('different-publication'), undefined, { ...publish, body: 'A distinct question about the service.' });
  assert.notDeepEqual(changed.keys(), first.keys()); assert.deepEqual(state.evidence, []);
});

test('collaboration progress: reading the same publication under a new post ID and cause ID does not renew content credit', () => {
  const state = initial('repeat-publication-read');
  const post = { id: 'post-1', authorId: 'participant', workId: 'publishing-work', goalRevision: 1, entityId: 'entity',
    kind: 'question', body: 'Has anyone seen this failure?', labels: ['synthetic'], citations: [], quotedPostIds: [],
    replyTo: null, relation: null, causeId: 'cause-1', createdAt: 1000, expiresAt: null, status: 'active', retractedAt: null,
    generation: 0, referencedSources: 0, support: 'question' };
  const page = { id: 'discussion', revision: 1, roleId: 'participant', observedAt: 1000,
    interpretation: 'discussion_not_independent_evidence', visibility: 'permitted_current_posts_only', findingsBasis: 'returned_posts_only',
    entities: [], posts: [post], findings: [], nextCursor: null };
  const first = adopted('board-read', state, page); assert.equal(first.keys().length, 2); first.capture();
  const repeated = adopted('board-read', state, { ...page, revision: 8, observedAt: 1200,
    posts: [{ ...post, id: 'post-2', causeId: 'cause-2', createdAt: 1100, generation: 1 }] });
  assert.deepEqual(repeated.keys(), first.keys()); assert.equal(repeated.capture().productiveSteps, 1);
  const reply = adopted('board-read', state, { ...page, posts: [{ ...post, replyTo: 'actual-other-question', relation: 'clarifies' }] });
  assert.notDeepEqual(reply.keys(), first.keys(), 'the actual addressed discussion remains part of the content identity');
  assert.deepEqual(state.evidence, []);
});
