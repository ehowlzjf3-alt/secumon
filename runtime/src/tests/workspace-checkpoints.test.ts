import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import type { ArtifactStore, StateRepository } from '../application/ports.js';
import type { Evidence, WorkState } from '../domain/model.js';
import type { KnowledgeDependency } from '../domain/knowledge.js';
import { WorkspaceCheckpoints, type WorkspaceStore } from '../application/workspace-checkpoints.js';
import { FileWorkspaceStore } from '../infrastructure/file-workspaces.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { FakeClock } from '../infrastructure/fakes.js';
import { Sha256Digester, sha256 } from '../infrastructure/digest.js';
import { transact } from '../application/work-transactions.js';
import { adapters, attempt, command, initial, openRepository } from './state-conformance-helpers.js';

const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
const content = Uint8Array.from([0, 1, 2, 127, 128, 255]);
const attributes = { tenantId: actor.tenantId, labels: ['synthetic'], lifecycleGeneration: 0 };
function source(): Evidence {
  return { id: 'source', tenantId: actor.tenantId, scope: 'fixture', sourceId: 'source', lineageId: 'source', locator: 'fixture://source',
    observedAt: 1000, recordedAt: 1000, labels: ['synthetic'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [], facts: { available: true }, artifact: null };
}
function work(id = 'work'): WorkState {
  const state = initial(id); state.attempts = [{ ...attempt('succeeded', 0), id: 'attempt', adopted: true, finishedAt: 1001 }]; state.evidence = [source()]; return state;
}
async function setup(directory: string, state: StateRepository = new MemoryStateRepository()) {
  const artifacts = new FileArtifactStore(join(directory, 'artifacts')); const clock = new FakeClock(2000); const digester = new Sha256Digester();
  const services = { state, artifacts, clock, digester }; await state.commit(command(work(), 'accept'));
  const files = new FileWorkspaceStore(join(directory, 'workspace')); const checkpoints = new WorkspaceCheckpoints(services, files);
  return { services, files, checkpoints };
}
async function withFixture(run: (fixture: Awaited<ReturnType<typeof setup>>, directory: string) => Promise<void>) {
  const temp = mkdtempSync(join(tmpdir(), 'workspace-checkpoint-')); const directory = realpathSync(temp); const fixture = await setup(directory);
  try { await run(fixture, directory); }
  finally { await fixture.services.state.close(); await fixture.files.close(); rmSync(directory, { recursive: true, force: true }); }
}
function generation(state: WorkState, value = 1) { state.dataLifecycle = { generation: value, blockedArtifactIds: [], changes: [] }; }
function filesAdapter(backing: WorkspaceStore, overrides: Partial<WorkspaceStore>): WorkspaceStore {
  return { stage: backing.stage.bind(backing), read: backing.read.bind(backing), list: backing.list.bind(backing), removeAttempt: backing.removeAttempt.bind(backing), ...overrides };
}
async function retainKnowledge(f: Awaited<ReturnType<typeof setup>>) {
  const dependency: KnowledgeDependency = { tenantId: actor.tenantId, knowledgeId: 'synthetic-memory', knowledgeRevision: 1, actorDigest: 'a'.repeat(64),
    sources: [{ workId: 'source-work', evidenceId: 'source', sourceVersion: 'b'.repeat(64), generation: 0, workRevision: 1, policyDigest: 'c'.repeat(64) }], parents: [] };
  await transact(f.services, 'work', 'retain-memory', 'test_memory_consumed', {}, state => { state.attempts[0]!.knowledgeDependencies = [dependency]; });
}

test('workspace: missing or denying memory validators block file operations before workspace I/O', async () => {
  await withFixture(async f => {
    await f.checkpoints.stage('work', actor, 'attempt', 'one.txt', content);
    const checkpoint = await f.checkpoints.checkpoint('work', actor, 'attempt', 'one.txt');
    await retainKnowledge(f); let calls = 0;
    const touched = async (): Promise<never> => { calls++; throw new Error('unexpected_workspace_io'); };
    const files: WorkspaceStore = { stage: touched, read: touched, list: touched, removeAttempt: touched };
    for (const knowledge of [undefined, { validate: async () => false }]) {
      const guarded = new WorkspaceCheckpoints({ ...f.services, knowledge }, files);
      await assert.rejects(guarded.stage('work', actor, 'attempt', 'two.txt', content), /workspace_knowledge_changed/);
      await assert.rejects(guarded.read('work', actor, 'attempt', 'one.txt'), /workspace_knowledge_changed/);
      await assert.rejects(guarded.checkpoint('work', actor, 'attempt', 'one.txt'), /workspace_knowledge_changed/);
      await assert.rejects(guarded.restore('work', actor, checkpoint.id), /workspace_knowledge_changed/);
      await assert.rejects(guarded.cleanup('work', actor, 'attempt'), /workspace_knowledge_changed/);
    }
    assert.equal(calls, 0); assert.equal((await f.files.list('work', 'attempt')).length, 1);
  });
});

for (const operation of ['stage', 'read', 'checkpoint', 'restore', 'cleanup'] as const) {
  test(`workspace: ${operation} rechecks memory custody after its asynchronous I/O`, async () => {
    await withFixture(async f => {
      await f.checkpoints.stage('work', actor, 'attempt', 'one.txt', content);
      const checkpoint = await f.checkpoints.checkpoint('work', actor, 'attempt', 'one.txt');
      await retainKnowledge(f); const before = await f.services.state.get('work'); let current = true; let triggered = false;
      const revoke = () => { current = false; triggered = true; };
      const files = filesAdapter(f.files, {
        stage: async (...args) => { const value = await f.files.stage(...args); if (operation === 'stage') revoke(); return value; },
        read: async (...args) => { const value = await f.files.read(...args); if (operation === 'read') revoke(); return value; },
        list: async (...args) => { const value = await f.files.list(...args); if (operation === 'cleanup') revoke(); return value; },
      });
      const artifacts: ArtifactStore = { exists: f.services.artifacts.exists.bind(f.services.artifacts),
        put: async (...args) => { const value = await f.services.artifacts.put(...args); if (operation === 'checkpoint') revoke(); return value; },
        get: async (...args) => { const value = await f.services.artifacts.get(...args); if (operation === 'restore') revoke(); return value; },
      };
      const guarded = new WorkspaceCheckpoints({ ...f.services, artifacts, knowledge: { validate: async () => current } }, files);
      const result = operation === 'stage' ? guarded.stage('work', actor, 'attempt', 'two.txt', content) :
        operation === 'read' ? guarded.read('work', actor, 'attempt', 'one.txt') :
        operation === 'checkpoint' ? guarded.checkpoint('work', actor, 'attempt', 'one.txt') :
        operation === 'restore' ? guarded.restore('work', actor, checkpoint.id) : guarded.cleanup('work', actor, 'attempt');
      await assert.rejects(result, /workspace_knowledge_changed/); assert.equal(triggered, true);
      assert.deepEqual(await f.services.state.get('work'), before);
      assert.equal((await f.files.list('work', 'attempt')).length, operation === 'stage' ? 2 : 1);
    });
  });
}

for (const adapter of adapters) test(`workspace: ${adapter} checkpoint and byte-for-byte restore survive new state, artifact and workspace instances`, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'workspace-restart-')); const directory = realpathSync(temp); let store = openRepository(adapter, directory);
  const f = await setup(directory, store);
  try {
    const before = (await store.get('work'))!;
    const staged = await f.checkpoints.stage('work', actor, 'attempt', 'reports/binary.dat', content);
    const saved = await f.checkpoints.checkpoint('work', actor, 'attempt', staged.path, { sourceEvidenceIds: ['source'] });
    assert.deepEqual(saved.sourceEvidenceIds, ['source']); assert.equal(saved.lifecycleGeneration, 0);
    assert.equal((await store.get('work'))!.revision, before.revision + 1); assert.deepEqual((await store.get('work'))!.budget, before.budget);
    assert.equal((await f.checkpoints.checkpoint('work', actor, 'attempt', staged.path, { sourceEvidenceIds: ['source'] })).id, saved.id);
    assert.deepEqual(await f.checkpoints.cleanup('work', actor, 'attempt'), { removed: 1 }); assert.deepEqual(await f.files.list('work', 'attempt'), []);
    await store.close(); await f.files.close(); store = openRepository(adapter, directory);
    const reopenedFiles = new FileWorkspaceStore(join(directory, 'workspace'));
    const reopened = new WorkspaceCheckpoints({ ...f.services, state: store, artifacts: new FileArtifactStore(join(directory, 'artifacts')) }, reopenedFiles);
    try {
      assert.equal((await reopened.restore('work', actor, saved.id)).sha256, saved.artifact.sha256);
      assert.deepEqual((await reopened.read('work', actor, 'attempt', staged.path)).bytes, content);
      assert.deepEqual(await store.get('work'), { ...before, revision: before.revision + 1, updatedAt: 2000, workspaceCheckpoints: [saved] });
    } finally { await reopenedFiles.close(); }
  } finally { await store.close(); await f.files.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('workspace: identical paths are isolated by both work and attempt and ownership is checked before file access', async () => {
  await withFixture(async f => {
    await f.services.state.commit(command(work('other-work'), 'accept'));
    await transact(f.services, 'work', 'second-attempt', 'test_attempt', {}, state => { state.attempts.push({ ...state.attempts[0]!, id: 'second' }); });
    for (const [workId, attemptId, text] of [['work', 'attempt', 'one'], ['other-work', 'attempt', 'two'], ['work', 'second', 'three']]) {
      await f.checkpoints.stage(workId!, actor, attemptId!, 'same.txt', Buffer.from(text!));
      assert.equal(Buffer.from((await f.checkpoints.read(workId!, actor, attemptId!, 'same.txt')).bytes).toString(), text);
    }
    await assert.rejects(f.checkpoints.read('work', { ...actor, principalId: 'other' }, 'attempt', 'same.txt'), /work_unavailable/);
    await assert.rejects(f.checkpoints.stage('work', actor, 'missing', 'same.txt', content), /workspace_attempt_unavailable/);
    await assert.rejects(f.checkpoints.read('other-work', actor, 'second', 'same.txt'), /workspace_attempt_unavailable/);
  });
});

test('workspace: traversal, absolute, ambiguous and platform-specific paths cannot be staged', async () => {
  await withFixture(async f => {
    for (const path of ['../outside', '/outside', 'a/../b', './b', 'a//b', 'a/', 'a\\b', 'C:outside', 'a\u0000b']) {
      await assert.rejects(f.checkpoints.stage('work', actor, 'attempt', path, content), /invalid_contract/);
    }
    assert.deepEqual(await f.files.list('work', 'attempt'), []);
  });
});

test('workspace: repeated identical staging is idempotent and different content cannot overwrite it', async () => {
  await withFixture(async f => {
    const first = await f.checkpoints.stage('work', actor, 'attempt', 'one.txt', content);
    assert.deepEqual(await f.checkpoints.stage('work', actor, 'attempt', 'one.txt', content), first);
    await assert.rejects(f.checkpoints.stage('work', actor, 'attempt', 'one.txt', Buffer.from('different')), /workspace_file_conflict/);
    assert.deepEqual((await f.checkpoints.read('work', actor, 'attempt', 'one.txt')).bytes, content);
    assert.equal((await f.services.state.get('work'))!.revision, 1);
  });
});

test('workspace: caller mutations after starting stage cannot change the bytes being staged', async () => {
  await withFixture(async f => {
    const bytes = content.slice(); const staging = f.checkpoints.stage('work', actor, 'attempt', 'one.txt', bytes); bytes.fill(42);
    await staging; assert.deepEqual((await f.checkpoints.read('work', actor, 'attempt', 'one.txt')).bytes, content);
  });
});

test('workspace: two processes cannot overwrite the same staged path with different bytes', { timeout: 20000 }, async () => {
  await withFixture(async (f, directory) => {
    const children = ['left', 'right'].map(text => {
      const child = fork(new URL('./workspace-worker.js', import.meta.url), [join(directory, 'workspace')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const exit = once(child, 'exit'); const ready = once(child, 'message', { signal: AbortSignal.timeout(10000) });
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000); return { child, text, exit, ready, timer };
    });
    try {
      for (const entry of children) assert.equal((await entry.ready)[0].type, 'ready');
      const replies = children.map(entry => once(entry.child, 'message', { signal: AbortSignal.timeout(10000) }));
      for (const entry of children) entry.child.send({ content: entry.text });
      const results = (await Promise.all(replies)).map(reply => reply[0]); await Promise.all(children.map(entry => entry.exit));
      assert.equal(results.filter(result => result.stored).length, 1);
      assert.match(results.find(result => !result.stored).code, /workspace_busy|workspace_file_conflict/);
      const winner = results.findIndex(result => result.stored);
      assert.equal(Buffer.from((await f.files.read('work', 'attempt', 'report.txt')).bytes).toString(), children[winner]!.text);
    } finally {
      for (const entry of children) { clearTimeout(entry.timer); if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL'); }
      await Promise.all(children.map(entry => entry.exit));
    }
  });
});

test('workspace: artifact saved during a state change remains uncommitted and cannot replace the authoritative revision', async () => {
  await withFixture(async f => {
    await f.checkpoints.stage('work', actor, 'attempt', 'one.txt', content); const backing = f.services.artifacts;
    const artifacts: ArtifactStore = { get: backing.get.bind(backing), exists: backing.exists.bind(backing), async put(bytes, attributes) {
      const ref = await backing.put(bytes, attributes); await transact(f.services, 'work', 'during-save', 'test_state_changed', {}, state => { state.statusReason = 'concurrent'; }); return ref;
    } };
    const checkpoints = new WorkspaceCheckpoints({ ...f.services, artifacts }, f.files);
    await assert.rejects(checkpoints.checkpoint('work', actor, 'attempt', 'one.txt'), /workspace_state_changed/);
    const state = (await f.services.state.get('work'))!; assert.equal(state.statusReason, 'concurrent'); assert.equal(state.workspaceCheckpoints, undefined);
    assert.deepEqual((await f.checkpoints.read('work', actor, 'attempt', 'one.txt')).bytes, content);
  });
});

test('workspace: narrower actor grants never replace the stored work policy during checkpoint commit', async () => {
  await withFixture(async f => {
    await transact(f.services, 'work', 'extra-label', 'test_policy', {}, state => { state.policy.allowedLabels.push('extra'); });
    const narrow = { ...actor, allowedLabels: ['synthetic'] }; const before = (await f.services.state.get('work'))!.policy;
    await f.checkpoints.stage('work', narrow, 'attempt', 'one.txt', content);
    const saved = await f.checkpoints.checkpoint('work', narrow, 'attempt', 'one.txt', { sourceEvidenceIds: ['source'] });
    assert.deepEqual(saved.artifact.labels, ['synthetic']); assert.deepEqual((await f.services.state.get('work'))!.policy, before);
  });
});

for (const change of ['policy', 'generation'] as const) test(`workspace: ${change} change during file read prevents returning previously read bytes`, async () => {
  await withFixture(async f => {
    await f.checkpoints.stage('work', actor, 'attempt', 'one.txt', content);
    const files = filesAdapter(f.files, { async read(...args) {
      const result = await f.files.read(...args);
      await transact(f.services, 'work', 'during-read', 'test_access_changed', {}, state => { if (change === 'policy') state.policy.allowedLabels = []; else generation(state); }); return result;
    } });
    await assert.rejects(new WorkspaceCheckpoints(f.services, files).read('work', actor, 'attempt', 'one.txt'), /workspace_state_changed/);
  });
});

for (const change of ['policy', 'generation'] as const) test(`workspace: ${change} change during staging prevents a successful stale response and preserves the local file`, async () => {
  await withFixture(async f => {
    const files = filesAdapter(f.files, { async stage(...args) {
      const result = await f.files.stage(...args);
      await transact(f.services, 'work', 'during-stage', 'test_access_changed', {}, state => { if (change === 'policy') state.policy.allowedLabels = []; else generation(state); }); return result;
    } });
    await assert.rejects(new WorkspaceCheckpoints(f.services, files).stage('work', actor, 'attempt', 'one.txt', content), /workspace_state_changed/);
    assert.equal((await f.files.list('work', 'attempt')).length, 1); assert.equal((await f.services.state.get('work'))!.workspaceCheckpoints, undefined);
  });
});

test('workspace: generation changes block even source-free checkpoints and preserve their staged files', async () => {
  await withFixture(async f => {
    await f.checkpoints.stage('work', actor, 'attempt', 'one.txt', content);
    const checkpoint = await f.checkpoints.checkpoint('work', actor, 'attempt', 'one.txt'); assert.deepEqual(checkpoint.sourceEvidenceIds, []);
    await transact(f.services, 'work', 'new-generation', 'test_lifecycle', {}, state => { generation(state); });
    await assert.rejects(f.checkpoints.restore('work', actor, checkpoint.id), /workspace_lifecycle_changed/);
    await assert.rejects(f.checkpoints.read('work', actor, 'attempt', 'one.txt'), /workspace_lifecycle_changed/);
    assert.equal((await f.files.list('work', 'attempt')).length, 1);
  });
});

for (const change of ['restricted', 'deleted', 'labels', 'artifact'] as const) test(`workspace: ${change} is checked when restoring a checkpoint even without a generation change`, async () => {
  await withFixture(async f => {
    await f.checkpoints.stage('work', actor, 'attempt', 'one.txt', content);
    const checkpoint = await f.checkpoints.checkpoint('work', actor, 'attempt', 'one.txt', { sourceEvidenceIds: ['source'] });
    await f.checkpoints.cleanup('work', actor, 'attempt');
    await transact(f.services, 'work', 'deny-source', 'test_access_changed', {}, state => {
      if (change === 'labels') state.evidence[0]!.labels = ['restricted'];
      else if (change === 'artifact') { generation(state); state.workspaceCheckpoints![0]!.lifecycleGeneration = 1; state.dataLifecycle!.blockedArtifactIds = [checkpoint.artifact.id]; }
      else state.evidence[0]!.access = change;
    });
    await assert.rejects(f.checkpoints.restore('work', actor, checkpoint.id), /workspace_source_unavailable|workspace_permission_denied/);
    assert.deepEqual(await f.files.list('work', 'attempt'), []);
  });
});

test('workspace: lifecycle changes during artifact restore prevent files from being staged', async () => {
  await withFixture(async f => {
    await f.checkpoints.stage('work', actor, 'attempt', 'one.txt', content); const checkpoint = await f.checkpoints.checkpoint('work', actor, 'attempt', 'one.txt');
    await f.checkpoints.cleanup('work', actor, 'attempt'); const backing = f.services.artifacts;
    const artifacts: ArtifactStore = { put: backing.put.bind(backing), exists: backing.exists.bind(backing), async get(...args) {
      const bytes = await backing.get(...args); await transact(f.services, 'work', 'during-restore', 'test_lifecycle', {}, state => { generation(state); }); return bytes;
    } };
    await assert.rejects(new WorkspaceCheckpoints({ ...f.services, artifacts }, f.files).restore('work', actor, checkpoint.id), /workspace_state_changed/);
    assert.deepEqual(await f.files.list('work', 'attempt'), []);
  });
});

for (const condition of ['active', 'unknown', 'obligation', 'uncheckpointed'] as const) test(`workspace: cleanup preserves files while ${condition}`, async () => {
  await withFixture(async f => {
    await f.checkpoints.stage('work', actor, 'attempt', 'one.txt', content);
    if (condition !== 'uncheckpointed') await f.checkpoints.checkpoint('work', actor, 'attempt', 'one.txt');
    if (condition !== 'uncheckpointed') await transact(f.services, 'work', 'guard-cleanup', 'test_cleanup_guard', {}, state => {
      if (condition === 'active') { state.attempts[0]!.status = 'running'; state.attempts[0]!.leaseUntil = 10000; state.attempts[0]!.finishedAt = null; }
      if (condition === 'unknown') { state.attempts[0]!.status = 'unknown'; state.attempts[0]!.effectState = 'unknown'; }
      if (condition === 'obligation') state.obligations.push({ id: 'effect', kind: 'effect_reconciliation', reason: 'uncertain effect', status: 'pending', wakeKey: null, dueAt: null });
    });
    await assert.rejects(f.checkpoints.cleanup('work', actor, 'attempt'), /workspace_attempt_active|workspace_unknown_obligation|workspace_uncheckpointed_file/);
    assert.deepEqual((await f.files.read('work', 'attempt', 'one.txt')).bytes, content);
  });
});

test('workspace: a file staged after cleanup inspection causes manifest conflict and remains preserved', async () => {
  await withFixture(async f => {
    await f.checkpoints.stage('work', actor, 'attempt', 'saved.txt', content); await f.checkpoints.checkpoint('work', actor, 'attempt', 'saved.txt');
    const files = filesAdapter(f.files, { async list(...args) { const prior = await f.files.list(...args); await f.files.stage(...args, 'unsaved.txt', content, attributes); return prior; } });
    await assert.rejects(new WorkspaceCheckpoints(f.services, files).cleanup('work', actor, 'attempt'), /workspace_manifest_changed/);
    assert.deepEqual((await f.files.list('work', 'attempt')).map(file => file.path), ['saved.txt', 'unsaved.txt']);
  });
});

test('workspace: missing checkpoint content prevents cleanup of the surviving staged file', async () => {
  await withFixture(async f => {
    await f.checkpoints.stage('work', actor, 'attempt', 'one.txt', content); await f.checkpoints.checkpoint('work', actor, 'attempt', 'one.txt');
    const backing = f.services.artifacts;
    const artifacts: ArtifactStore = { put: backing.put.bind(backing), get: backing.get.bind(backing), exists: async () => false };
    await assert.rejects(new WorkspaceCheckpoints({ ...f.services, artifacts }, f.files).cleanup('work', actor, 'attempt'), /workspace_checkpoint_unavailable/);
    assert.deepEqual((await f.files.read('work', 'attempt', 'one.txt')).bytes, content);
  });
});

test('workspace: a remaining lock is never stolen by staging or cleanup', async () => {
  await withFixture(async (f, directory) => {
    await f.checkpoints.stage('work', actor, 'attempt', 'one.txt', content); await f.checkpoints.checkpoint('work', actor, 'attempt', 'one.txt');
    const lock = join(directory, 'workspace', sha256('work'), sha256('attempt'), '.lock'); mkdirSync(lock, { mode: 0o700 });
    await assert.rejects(f.checkpoints.stage('work', actor, 'attempt', 'other.txt', content), /workspace_busy/);
    await assert.rejects(f.checkpoints.cleanup('work', actor, 'attempt'), /workspace_busy/);
    rmSync(lock, { recursive: true }); assert.equal((await f.files.list('work', 'attempt')).length, 1);
  });
});

test('workspace: symlink files and replaced roots are rejected instead of reading or overwriting them', async () => {
  await withFixture(async (f, directory) => {
    await f.checkpoints.stage('work', actor, 'attempt', 'one.txt', content);
    const root = join(directory, 'workspace'); const file = join(root, sha256('work'), sha256('attempt'), 'files', `${sha256('one.txt')}.json`);
    const saved = `${file}.saved`; renameSync(file, saved); symlinkSync(saved, file);
    await assert.rejects(f.checkpoints.read('work', actor, 'attempt', 'one.txt'), /workspace_file_unsafe/);
    const bytes = readFileSync(saved); await assert.rejects(f.checkpoints.stage('work', actor, 'attempt', 'one.txt', content), /workspace_file_unsafe|workspace_layout_invalid/); assert.deepEqual(readFileSync(saved), bytes);
    renameSync(root, `${root}.saved`); mkdirSync(root, { mode: 0o700 });
    await assert.rejects(f.checkpoints.read('work', actor, 'attempt', 'one.txt'), /workspace_directory_changed/);
  });
});

test('workspace: content corruption and configured byte or file capacity limits fail without silent truncation', async () => {
  await withFixture(async (f, directory) => {
    const limited = new FileWorkspaceStore(join(directory, 'limited'), { maxFileBytes: 4, maxFilesPerAttempt: 1, maxAttemptBytes: 4 });
    try {
      await assert.rejects(limited.stage('work', 'attempt', 'large', content, attributes), /workspace_file_too_large/);
      await limited.stage('work', 'attempt', 'small', Buffer.from('four'), attributes);
      await assert.rejects(limited.stage('work', 'attempt', 'extra', Buffer.from('x'), attributes), /workspace_capacity_exceeded/);
      assert.equal((await limited.list('work', 'attempt')).length, 1);
    } finally { await limited.close(); }
    await f.checkpoints.stage('work', actor, 'attempt', 'one.txt', content);
    const file = join(directory, 'workspace', sha256('work'), sha256('attempt'), 'files', `${sha256('one.txt')}.json`);
    const record = JSON.parse(readFileSync(file, 'utf8')); record.contentBase64 = Buffer.from('changed').toString('base64'); writeFileSync(file, JSON.stringify(record));
    await assert.rejects(f.checkpoints.read('work', actor, 'attempt', 'one.txt'), /workspace_file_integrity_failure/);
  });
});
