import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile, symlink, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';
import { commitWithArtifacts } from '../application/commit-artifacts.js';
import { newWork } from '../application/new-work.js';
import { validateScenario } from '../application/fixtures.js';
import type { Attempt, ToolResult } from '../domain/model.js';
import { ToolResultSchema, parseContract } from '../application/contracts.js';

const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-simple.json', import.meta.url), 'utf8')));
const attributes = { tenantId: 'synthetic', labels: ['synthetic'], mediaType: 'text/plain' };

test('content, metadata and permissions survive artifact store restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-artifact-'));
  try {
    const first = new FileArtifactStore(dir);
    const ref = await first.put(Buffer.from('합성 원문\nline 2'), attributes);
    const reopened = new FileArtifactStore(dir);
    assert.equal(Buffer.from(await reopened.get(ref, scenario.policy)).toString('utf8'), '합성 원문\nline 2');
    assert.deepEqual(await reopened.put(Buffer.from('합성 원문\nline 2'), attributes), ref);
    assert.deepEqual((await readdir(dir)).sort(), [`${ref.id}.blob`, `${ref.id}.json`].sort());
    await assert.rejects(reopened.get(ref, { ...scenario.policy, tenantId: 'another' }), /artifact_access_denied/);
    await assert.rejects(reopened.get(ref, { ...scenario.policy, allowedLabels: [] }), /artifact_access_denied/);
    await assert.rejects(reopened.get({ ...ref, labels: [] }, { ...scenario.policy, allowedLabels: [] }), /artifact_reference_mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('same bytes under different tenant/labels never share an accessible reference', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-artifact-scope-'));
  try {
    const store = new FileArtifactStore(dir); const bytes = Buffer.from('same synthetic bytes');
    const publicRef = await store.put(bytes, attributes);
    const privateRef = await store.put(bytes, { ...attributes, labels: ['restricted'] });
    const otherRef = await store.put(bytes, { ...attributes, tenantId: 'another' });
    assert.notEqual(publicRef.id, privateRef.id); assert.notEqual(publicRef.id, otherRef.id);
    assert.equal(publicRef.sha256, privateRef.sha256);
    await assert.rejects(store.get({ ...privateRef, labels: ['synthetic'] }, scenario.policy), /artifact_reference_mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('corrupt bytes, missing originals, path traversal and symlink substitution are rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-artifact-integrity-'));
  try {
    const store = new FileArtifactStore(dir); const ref = await store.put(Buffer.from('evidence'), attributes);
    await writeFile(join(dir, `${ref.id}.blob`), 'corrupt');
    await assert.rejects(store.get(ref, scenario.policy), /artifact_integrity_failure/);
    assert.equal(await store.exists(ref), false);
    await unlink(join(dir, `${ref.id}.blob`));
    assert.equal(await store.exists(ref), false);
    await writeFile(join(dir, 'unrelated'), 'evidence');
    await symlink(join(dir, 'unrelated'), join(dir, `${ref.id}.blob`));
    await assert.rejects(store.get(ref, scenario.policy));
    await assert.rejects(store.get({ ...ref, id: '../unrelated' }, scenario.policy), /invalid_artifact_id/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('artifact stored before failed state commit is reused after reopening, without dangling references', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-artifact-commit-')); const database = join(dir, 'state.sqlite'); const objects = join(dir, 'objects');
  let state = new SqliteStateRepository(database);
  try {
    let artifacts = new FileArtifactStore(objects);
    const initial = newWork({ id: 'w', goal: scenario.goal, policy: scenario.policy, limits: { toolCalls: 5, modelCalls: 1, tokens: 1000, replans: 1, wallTimeMs: 10000 }, now: 0 });
    const request = { workId: 'w', expectedRevision: 0, commandId: 'accept', commandDigest: 'accept', next: initial, events: [{ type: 'accepted', at: 0, data: {} }], deliveries: [] };
    await state.commit(request);
    const ref = await artifacts.put(Buffer.from('original synthetic document'), attributes);
    const next = { ...initial, revision: 2, artifacts: [ref] };
    const conflict = await commitWithArtifacts(state, artifacts, { ...request, commandId: 'attach-stale', next: { ...next, revision: 1 } });
    assert.equal(conflict.kind, 'conflict');
    assert.equal((await state.get('w'))!.artifacts.length, 0);
    await state.close(); state = new SqliteStateRepository(database); artifacts = new FileArtifactStore(objects);
    assert.equal(await artifacts.exists(ref), true);
    const attached = await commitWithArtifacts(state, artifacts, { ...request, expectedRevision: 1, commandId: 'attach', commandDigest: 'attach', next });
    assert.equal(attached.kind, 'committed');
    await unlink(join(objects, `${ref.id}.blob`));
    await assert.rejects(commitWithArtifacts(state, artifacts, { ...request, expectedRevision: 2, commandId: 'after-loss', next: { ...next, revision: 3 } }), /artifact_unavailable/);
    assert.equal((await state.get('w'))!.revision, 2);
  } finally { await state.close(); await rm(dir, { recursive: true, force: true }); }
});

test('execution intent and unadopted result persist independently of evidence acceptance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-result-journal-')); const database = join(dir, 'state.sqlite');
  let store = new SqliteStateRepository(database);
  const artifacts = new FileArtifactStore(join(dir, 'objects'));
  try {
    const initial = newWork({ id: 'w', goal: scenario.goal, policy: scenario.policy, limits: { toolCalls: 5, modelCalls: 1, tokens: 1000, replans: 1, wallTimeMs: 10000 }, now: 0 });
    const attempt: Attempt = { id: 'a1', taskId: 'read', planRevision: 1, goalRevision: 1, toolId: 'fixture.read', toolVersion: '1', inputDigest: 'input-hash', scope: initial.goal.scope,
      effect: 'read', effectState: 'none', status: 'reserved', owner: 'worker-1', leaseUntil: 1000, startedAt: 0, finishedAt: null, resultId: null, resultArtifact: null, adopted: false, error: null };
    const intent = { ...initial, attempts: [attempt], budget: { ...initial.budget, reservedToolCalls: 1 } };
    await store.commit({ workId: 'w', expectedRevision: 0, commandId: 'reserve', commandDigest: 'reserve', next: intent, events: [{ type: 'attempt_reserved', at: 0, data: { attemptId: 'a1' } }], deliveries: [] });
    await store.close(); store = new SqliteStateRepository(database);
    assert.equal((await store.get('w'))!.attempts[0]!.status, 'reserved');
    const result: ToolResult = { resultId: 'r1', attemptId: 'a1', status: 'success', effectState: 'none', evidence: [scenario.evidence[0]!], artifacts: [], output: { source: 'synthetic' }, error: null, cursor: null, coverage: 'complete' };
    const ref = await artifacts.put(Buffer.from(JSON.stringify(result)), { ...attributes, mediaType: 'application/json' });
    const received = { ...intent, revision: 2, attempts: [{ ...attempt, status: 'received' as const, resultId: 'r1', resultArtifact: ref }], budget: { ...intent.budget, reservedToolCalls: 0, used: { ...intent.budget.used, toolCalls: 1 } } };
    const request = { workId: 'w', expectedRevision: 1, commandId: 'received:a1', commandDigest: 'received:r1', next: received, events: [{ type: 'result_received', at: 1, data: { attemptId: 'a1', artifactId: ref.id } }], deliveries: [] };
    await commitWithArtifacts(store, artifacts, request);
    await store.close(); store = new SqliteStateRepository(database);
    const restored = (await store.get('w'))!;
    assert.equal(restored.attempts[0]!.adopted, false);
    assert.equal(restored.evidence.length, 0);
    const bytes = await artifacts.get(restored.attempts[0]!.resultArtifact!, scenario.policy);
    assert.equal(parseContract(ToolResultSchema, JSON.parse(Buffer.from(bytes).toString('utf8'))).resultId, 'r1');
    assert.equal((await commitWithArtifacts(store, artifacts, request)).kind, 'duplicate');
    assert.equal((await store.events('w', 0)).length, 2);
    assert.equal((await store.get('w'))!.budget.used.toolCalls, 1);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});
