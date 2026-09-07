import test from 'node:test';
import assert from 'node:assert/strict';
import type { Evidence } from '../domain/model.js';
import { evaluateCompletion } from '../domain/completion.js';
import { collectionCoverageCandidates, validateReadCoverage, validateReadCoverageManifest } from '../domain/read-coverage.js';
import { initialize } from '../application/read-collection-validation.js';
import { artifact, attempt, initial } from './state-conformance-helpers.js';

const queryDigest = 'b'.repeat(64); const key = (id: string) => ({ id, inputDigest: 'c'.repeat(64) });
function fixture() {
  const state = initial(); state.goal.criteria[0]!.requireCollection = { queryDigest };
  const evidence: Evidence = { id: 'fact', tenantId: 'tenant-a', scope: 'fixture', sourceId: 'original', lineageId: 'original',
    locator: '/available', observedAt: 900, recordedAt: 1000, labels: ['synthetic'], facts: { available: true },
    coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [], artifact: artifact() };
  state.evidence = [evidence]; state.attempts = [{ ...attempt('succeeded'), adopted: true, readProgress: {
    operationId: 'collection', head: artifact(), callCount: 1, remainingCalls: 2, completedPages: 1, completedItems: 2,
    pendingItems: 0, unknownCalls: 0, phase: 'complete', successorAttemptId: null,
    coverage: { queryDigest, snapshot: 'snapshot', expectedItems: 2, completedItems: 2, complete: true } } }];
  return { state, check: () => evaluateCompletion(state.goal, state.evidence, state.obligations, state.policy, state.attempts) };
}
test('collection coverage: an individually complete fact does not prove the required full query', () => {
  const f = fixture(); f.state.attempts[0]!.status = 'partial'; f.state.attempts[0]!.readProgress!.coverage!.complete = false;
  const original = structuredClone(f.state.evidence); assert.equal(f.check().complete, false);
  assert.ok(f.check().criteria[0]!.reasons.includes('collection_coverage_required')); assert.deepEqual(f.state.evidence, original);
});
test('collection coverage: complete query is an additional gate and adds no independent evidence', () => {
  const f = fixture(); assert.equal(f.check().complete, true);
  f.state.goal.criteria[0]!.minIndependentSources = 2; assert.equal(f.check().complete, false);
  assert.deepEqual(f.check().criteria[0]!.reasons, ['insufficient_independent_evidence']);
});
for (const field of ['query', 'snapshot', 'goal', 'permission', 'unadopted'] as const) test(`collection coverage: ${field} mismatch cannot satisfy the requirement`, () => {
  const f = fixture();
  if (field === 'query') f.state.goal.criteria[0]!.requireCollection!.queryDigest = 'd'.repeat(64);
  if (field === 'snapshot') f.state.goal.criteria[0]!.requireCollection!.snapshot = 'different';
  if (field === 'goal') f.state.goal.revision++;
  if (field === 'permission') f.state.policy.allowedTools = [];
  if (field === 'unadopted') f.state.attempts[0]!.adopted = false;
  assert.equal(f.check().complete, false);
});
test('collection coverage: an earlier unknown read retains its history without negating a complete later manifest', () => {
  const f = fixture(); f.state.attempts[0]!.readProgress!.unknownCalls = 1;
  assert.equal(f.check().complete, true);
});
test('collection coverage: empty enumeration does not invent a business fact', () => {
  const f = fixture(); const progress = f.state.attempts[0]!.readProgress!;
  progress.completedItems = 0; progress.coverage!.expectedItems = 0; progress.coverage!.completedItems = 0; f.state.evidence = [];
  assert.equal(collectionCoverageCandidates(f.state.goal, f.state.policy, f.state.attempts, { queryDigest }).length, 1);
  assert.equal(f.check().complete, false);
  assert.deepEqual(f.check().criteria[0]!.reasons, ['insufficient_independent_evidence']);
});
test('collection coverage: manifest validation rejects duplicates, mismatched keys and premature EOF even without a remote total', () => {
  assert.throws(() => validateReadCoverageManifest([key('a'), key('a')]));
  const state = initialize('paged');
  state.pages = [{ requestId: 'request', sourceSnapshot: 'snapshot', cursor: null, nextCursor: null, exhausted: true,
    totalItems: null, expected: [key('a')], items: [{ ...key('a'), status: 'success', output: null, evidence: [], artifacts: [], coverage: 'complete', error: null }] }];
  state.exhausted = true;
  assert.throws(() => validateReadCoverage([key('a'), key('b')], state), /read_coverage_incomplete/);
  assert.throws(() => validateReadCoverage([key('b')], state), /read_coverage_item_mismatch/);
  assert.doesNotThrow(() => validateReadCoverage([key('a')], state));
});
