import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactRef, Attempt, Evidence, Goal, Policy, ToolResult } from '../domain/model.js';
import { accessibleEvidence, evaluateCompletion, historicalEvidence } from '../domain/completion.js';
import { validSupersession } from '../domain/evidence-access.js';
import { validateEvidence, validateEvidenceRecords } from '../application/evidence-intake.js';
import { newWork } from '../application/new-work.js';
import { Sha256Digester } from '../infrastructure/digest.js';

const policy: Policy = { tenantId: 'tenant', principalId: 'owner', allowedLabels: ['public', 'restricted'], allowedTools: ['read'], allowedDestinations: ['local'], allowWrites: false };
const publicPolicy: Policy = { ...policy, allowedLabels: ['public'] };
const goal: Goal = { revision: 1, scope: 'scope', mode: 'auto', description: 'Check current records', criteria: [
  { id: 'value', key: 'value', description: 'Current value', operator: 'equals', equals: true, minIndependentSources: 1, requireCompleteCoverage: true },
] };
const digester = new Sha256Digester();
function evidence(id: string, changes: Partial<Evidence> = {}): Evidence {
  return { id, tenantId: 'tenant', scope: 'scope', sourceId: 'source', lineageId: 'lineage', locator: `fixture:${id}`, observedAt: 1000, recordedAt: 1000,
    labels: ['public'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [], facts: { value: true }, artifact: null, ...changes };
}
function artifact(labels = ['public']): ArtifactRef {
  return { id: 'original', sha256: 'a'.repeat(64), byteLength: 1, mediaType: 'text/plain', tenantId: 'tenant', labels };
}
function state(records: Evidence[] = []) {
  const value = newWork({ id: 'work', goal, policy, limits: { toolCalls: 10, modelCalls: 2, tokens: 1000, replans: 2, wallTimeMs: 60000 }, now: 1000 });
  value.evidence = structuredClone(records); return value;
}
const ids = (records: Evidence[]) => records.map(record => record.id).sort();
function current(records: Evidence[], access = publicPolicy) { return ids(accessibleEvidence(records, access, 'scope')); }
function historical(records: Evidence[], access = publicPolicy) { return ids(historicalEvidence(records, access, 'scope')); }
function validate(incoming: Evidence[], existing: Evidence[] = []) { validateEvidenceRecords(incoming, 'scope', state(existing), digester); }

test('current and historical views enforce own access, tenant, scope and artifact labels while omitted access stays available', () => {
  const records = [evidence('default'), evidence('explicit', { access: 'available' }), evidence('retracted', { status: 'retracted' }),
    evidence('restricted', { access: 'restricted' }), evidence('deleted', { access: 'deleted' }), evidence('label', { labels: ['restricted'] }),
    evidence('foreign', { tenantId: 'other' }), evidence('different-scope', { scope: 'other' }), evidence('protected-original', { artifact: artifact(['restricted']) })];
  assert.deepEqual(current(records), ['default', 'explicit']);
  assert.deepEqual(historical(records), ['default', 'explicit', 'retracted']);
});

test('two generations of derived evidence lose current validity when an ancestor is retracted or superseded, while history stays readable', () => {
  const root = evidence('root'); const child = evidence('child', { derivedFrom: ['root'] }); const summary = evidence('summary', { derivedFrom: ['child'] });
  const original = [root, child, summary]; assert.deepEqual(current(original), ['child', 'root', 'summary']);
  for (const records of [[{ ...root, status: 'retracted' as const }, child, summary], [root, child, summary, evidence('replacement', { supersedes: ['root'] })]]) {
    assert.deepEqual(current(records), records.length === 4 ? ['replacement'] : []);
    assert.deepEqual(historical(records), ids(records));
  }
  assert.equal(root.status, 'accepted'); assert.deepEqual(child.derivedFrom, ['root']);
});

test('ancestor restriction, deletion, missing reference or revoked labels blocks current and historical descendants', () => {
  const root = evidence('root'); const child = evidence('child', { derivedFrom: ['root'] }); const summary = evidence('summary', { derivedFrom: ['child'] });
  const cases: Evidence[][] = [[child, summary], [{ ...root, access: 'restricted' }, child, summary], [{ ...root, access: 'deleted' }, child, summary],
    [{ ...root, labels: ['restricted'] }, child, summary], [{ ...root, tenantId: 'other' }, child, summary], [{ ...root, scope: 'other' }, child, summary]];
  for (const records of cases) { assert.deepEqual(current(records), []); assert.deepEqual(historical(records), []); }
});

test('a correction remains a monotonic supersession after retraction, restriction, deletion or permission loss', () => {
  const old = evidence('old'); const child = evidence('old-summary', { derivedFrom: ['old'] });
  for (const changes of [{ status: 'retracted' }, { access: 'restricted' }, { access: 'deleted' }, { labels: ['restricted'] }] as Partial<Evidence>[]) {
    const replacement = evidence('replacement', { supersedes: ['old'], ...changes });
    assert.deepEqual(current([old, child, replacement]), []);
    assert.equal(evaluateCompletion(goal, [old, child, replacement], [], publicPolicy).complete, false);
  }
});

test('supersession uses the full valid version chain and is independent of record ordering', () => {
  const first = evidence('first'); const second = evidence('second', { supersedes: ['first'], access: 'restricted' });
  const last = evidence('last', { supersedes: ['second'] });
  for (const records of [[first, second, last], [last, first, second], [second, last, first]]) assert.deepEqual(current(records), ['last']);
  assert.deepEqual(current([first, second, { ...last, status: 'retracted' }]), []);
  assert.deepEqual(historical([first, second, last]), ['first', 'last']);
});

test('foreign tenant, scope, source, lineage and invalid time cannot suppress a valid original', () => {
  const old = evidence('old');
  for (const changes of [{ tenantId: 'other' }, { scope: 'other' }, { sourceId: 'other' }, { lineageId: 'other' }, { observedAt: 999 }, { observedAt: 1001, recordedAt: 1000 }] as Partial<Evidence>[]) {
    const forged = evidence('forged', { supersedes: ['old'], ...changes });
    assert.equal(validSupersession(forged, old), false); assert.ok(current([old, forged]).includes('old'));
  }
  assert.equal(validSupersession(evidence('replacement', { supersedes: ['old'] }), old), true);
});

test('a replacement does not depend on a superseded body being current or present in a selected view', () => {
  const replacement = evidence('replacement', { supersedes: ['old'] });
  assert.deepEqual(current([replacement]), ['replacement']); assert.deepEqual(historical([replacement]), ['replacement']);
  assert.deepEqual(current([evidence('old', { status: 'retracted' }), replacement]), ['replacement']);
});

test('cyclic, missing and ambiguous derived references fail closed without removing independent evidence', () => {
  const records = [evidence('first', { derivedFrom: ['second'] }), evidence('second', { derivedFrom: ['first'] }), evidence('downstream', { derivedFrom: ['second'] }),
    evidence('self', { derivedFrom: ['self'] }), evidence('absent', { derivedFrom: ['missing'] }), evidence('duplicate'), evidence('duplicate', { facts: { value: false } }),
    evidence('ambiguous-child', { derivedFrom: ['duplicate'] }), evidence('independent')];
  assert.deepEqual(current(records), ['independent']); assert.deepEqual(historical(records), ['independent']);
});

test('deep derived chains are evaluated without recursive call-stack growth and do not become independent sources', () => {
  const records = Array.from({ length: 4000 }, (_, index) => evidence(`record-${index}`, { derivedFrom: index ? [`record-${index - 1}`] : [], lineageId: `claimed-${index}` }));
  assert.equal(accessibleEvidence(records, publicPolicy, 'scope').length, records.length);
  assert.equal(historicalEvidence([...records].reverse(), publicPolicy, 'scope').length, records.length);
  const needTwo = { ...goal, criteria: [{ ...goal.criteria[0]!, minIndependentSources: 2 }] };
  assert.equal(evaluateCompletion(needTwo, records, [], publicPolicy).complete, false);
});

test('record intake accepts parents and descendants in either order and preserves caller objects', () => {
  const parent = evidence('parent', { labels: ['public', 'restricted'] });
  const child = evidence('child', { labels: ['public', 'restricted'], derivedFrom: ['parent'], artifact: artifact(['public', 'restricted']) });
  const before = structuredClone([parent, child]); validate([child, parent]); validate([parent, child]); assert.deepEqual([parent, child], before);
});

test('record intake requires inherited labels on both derivation and replacement edges', () => {
  const parent = evidence('parent', { labels: ['public', 'restricted'] });
  for (const relation of [{ derivedFrom: ['parent'] }, { supersedes: ['parent'] }]) {
    assert.throws(() => validate([evidence('next', relation)], [parent]), /evidence_labels_not_inherited/);
    validate([evidence('next', { ...relation, labels: ['public', 'restricted'] })], [parent]);
  }
});

test('record intake requires artifact labels to cover the evidence and rejects artifacts outside policy', () => {
  assert.throws(() => validate([evidence('record', { labels: ['public', 'restricted'], artifact: artifact() })]), /artifact_labels_insufficient/);
  assert.throws(() => validate([evidence('record', { artifact: { ...artifact(), tenantId: 'other' } })]), /artifact_scope_invalid/);
  assert.throws(() => validate([evidence('record', { artifact: artifact(['ungranted']) })]), /artifact_scope_invalid/);
  validate([evidence('record', { labels: ['public', 'restricted'], artifact: artifact(['public', 'restricted']) })]);
});

test('new records inherit transitive dependency labels even if a legacy intermediate record was under-labelled', () => {
  const root = evidence('root', { labels: ['public', 'restricted'] });
  const legacy = evidence('legacy', { derivedFrom: ['root'] }); const incoming = evidence('new', { derivedFrom: ['legacy'] });
  assert.throws(() => validate([incoming], [root, legacy]), /evidence_labels_not_inherited/);
  validate([{ ...incoming, labels: ['public', 'restricted'], artifact: artifact(['public', 'restricted']) }], [root, legacy]);
});

test('shared ancestry across multiple parents is not mistaken for a cycle', () => {
  const root = evidence('root'); const left = evidence('left', { derivedFrom: ['root'] }); const right = evidence('right', { derivedFrom: ['root'] });
  const combined = evidence('combined', { derivedFrom: ['left', 'right'] });
  validate([combined, left, right, root]); assert.deepEqual(current([combined, left, right, root]), ['combined', 'left', 'right', 'root']);
});

test('derived intake refuses historical or inaccessible ancestors and checks validity after the whole incoming batch', () => {
  const root = evidence('root'); const parent = evidence('parent', { derivedFrom: ['root'] }); const child = evidence('child', { derivedFrom: ['parent'] });
  for (const change of [{ status: 'retracted' }, { access: 'restricted' }, { access: 'deleted' }] as Partial<Evidence>[]) {
    assert.throws(() => validate([child], [{ ...root, ...change }, parent]), /derived_evidence_not_current/);
  }
  assert.throws(() => validate([child, evidence('replacement', { supersedes: ['root'] })], [root, parent]), /derived_evidence_not_current/);
  assert.throws(() => validate([child], [parent]), /derived_evidence_not_current/);
});

test('replacement intake permits an accessible retracted target but never an inaccessible historical target', () => {
  const previous = evidence('previous', { status: 'retracted' }); const replacement = evidence('replacement', { supersedes: ['previous'] });
  validate([replacement], [previous]);
  for (const access of ['restricted', 'deleted'] as const) assert.throws(() => validate([replacement], [{ ...previous, access }]), /unavailable_evidence_reference/);
});

test('record intake rejects missing references and invalid tenant, scope, source, lineage or time on replacements', () => {
  assert.throws(() => validate([evidence('next', { derivedFrom: ['missing'] })]), /unavailable_evidence_reference/);
  assert.throws(() => validate([evidence('next', { supersedes: ['missing'] })]), /unavailable_evidence_reference/);
  const original = evidence('original');
  for (const changes of [{ sourceId: 'other' }, { lineageId: 'other' }, { observedAt: 999 }] as Partial<Evidence>[]) {
    assert.throws(() => validate([evidence('next', { supersedes: ['original'], ...changes })], [original]), /invalid_supersession/);
  }
  for (const changes of [{ tenantId: 'other' }, { scope: 'other' }, { observedAt: 1001, recordedAt: 1000 }] as Partial<Evidence>[]) {
    assert.throws(() => validate([evidence('next', { supersedes: ['original'], ...changes })], [original]), /evidence_scope_or_time_invalid/);
  }
});

test('record intake rejects self, indirect and mixed cycles before accepting partial lineage', () => {
  for (const records of [[evidence('self', { derivedFrom: ['self'] })],
    [evidence('first', { derivedFrom: ['second'] }), evidence('second', { derivedFrom: ['first'] })],
    [evidence('first', { supersedes: ['second'] }), evidence('second', { derivedFrom: ['first'] })]]) {
    assert.throws(() => validate(records), /cyclic_evidence/);
  }
});

test('omitted and explicit available access are idempotently equivalent but content or access changes cannot overwrite an ID', () => {
  const original = evidence('existing'); validate([{ ...original, access: 'available' }], [original]); validate([original], [{ ...original, access: 'available' }]);
  assert.throws(() => validate([{ ...original, facts: { value: false } }], [original]), /evidence_id_collision/);
  assert.throws(() => validate([original], [{ ...original, access: 'deleted' }]), /evidence_id_collision/);
  assert.throws(() => validate([original, original]), /duplicate_result_evidence/);
  for (const access of ['restricted', 'deleted'] as const) assert.throws(() => validate([{ ...original, access }]), /evidence_access_unavailable/);
});

test('tool-result validation preserves effect, error and artifact guards while using the shared record intake', () => {
  const run: Attempt = { id: 'attempt', taskId: 'task', planRevision: 1, goalRevision: 1, toolId: 'read', toolVersion: '1', inputDigest: 'input', scope: 'scope',
    effect: 'read', effectState: 'none', status: 'running', owner: 'worker', leaseUntil: 2000, startedAt: 1000, finishedAt: null,
    resultId: null, resultArtifact: null, adopted: false, error: null };
  const result: ToolResult = { resultId: 'result', attemptId: run.id, status: 'success', effectState: 'none', evidence: [evidence('root')], artifacts: [], output: null, error: null, cursor: null, coverage: 'complete' };
  validateEvidence(result, run, state(), digester);
  assert.throws(() => validateEvidence({ ...result, effectState: 'confirmed' }, run, state(), digester), /unexpected_effect/);
  assert.throws(() => validateEvidence({ ...result, status: 'error' }, run, state(), digester), /failed_result_contains_evidence/);
  assert.throws(() => validateEvidence({ ...result, artifacts: [artifact(['ungranted'])] }, run, state(), digester), /artifact_scope_invalid/);
  assert.throws(() => validateEvidence({ ...result, evidence: [evidence('derived', { derivedFrom: ['missing'] })] }, run, state(), digester), /unavailable_evidence_reference/);
});
