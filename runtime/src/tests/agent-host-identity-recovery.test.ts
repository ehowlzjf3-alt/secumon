import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_LOCAL_RESTORE_COMPLETION } from '../application/agent-lifecycle-contracts.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { backupAgent, inspectAgentBackup, restoreAgentBackup } from '../infrastructure/agent-lifecycle.js';
import { captureLifecycleTree, copyLifecycleTree } from '../infrastructure/agent-lifecycle-files.js';
import { acquireAgentRuntimeLease } from '../infrastructure/agent-lifecycle-lease.js';
import { inspectAgentHostIdentity } from '../infrastructure/agent-host-identities.js';
import { rebindRestoredAgentHostIdentity, type RebindRestoredAgentHostIdentityInput } from '../infrastructure/agent-host-identity-recovery.js';
import { reconcileAgentRestore } from '../infrastructure/agent-restore-reconciliation.js';
import type { AgentRestoreReconciliationSource } from '../application/agent-restore-reconciliation-contracts.js';
import { sha256 } from '../infrastructure/digest.js';
import { advance, command, delivery, initial, snapshot, type Adapter } from './state-conformance-helpers.js';

type Stores = Awaited<ReturnType<typeof openAgentStores>>;
const pendingName = '.secumon-restore-in-progress.json';
const rawText = '복원 이전 사용자의 원문입니다.\n이 문장과 과거 영수증을 보존합니다.\n';
const differentDigest = (value: string) => value === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);

async function fixture(t: TestContext, backend: Adapter = 'sqlite') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-identity-recovery-')));
  const engine = join(base, 'engine'), root = join(base, 'agent'), archive = join(base, 'backup');
  const preserved = join(base, 'preserved-original'), registry = join(base, 'host-identities');
  mkdirSync(engine, { mode: 0o700 });
  writeFileSync(join(engine, 'engine-sentinel.txt'), 'host-owned engine directory\n', { mode: 0o600 });
  const profiles = new FileAgentProfileStore(engine);
  const active = new Set<Stores>();
  t.after(async () => {
    const errors: unknown[] = [];
    try { for (const stores of active) try { await stores.close(); } catch (error) { errors.push(error); } }
    finally { rmSync(base, { recursive: true, force: true }); }
    if (errors.length) throw new AggregateError(errors, 'identity_recovery_fixture_cleanup_failed');
  });
  const identityOptions = { registryDirectory: registry, engineDirectories: [engine] };
  const profile = profiles.initialize(root, { stateBackend: backend, name: '복원 담당', purpose: '기존 원문과 업무 이력 보존' });
  async function open(directory = root) {
    const stores = await openAgentStores(profiles, directory, undefined, { identityRegistryDirectory: registry });
    active.add(stores); return stores;
  }
  async function close(stores: Stores) { try { await stores.close(); } finally { active.delete(stores); } }
  const stores = await open();
  const state = initial('historical-work');
  assert.equal(await stores.state.get(state.id), null);
  const artifact = await stores.artifacts.put(Buffer.from(rawText), {
    tenantId: state.policy.tenantId, labels: ['synthetic'], mediaType: 'text/plain; charset=utf-8',
  });
  state.artifacts.push(artifact);
  const first = command(state, 'original-accept', [delivery(state.id)]);
  assert.equal((await stores.state.commit(first)).kind, 'committed');
  const next = advance(state, 'operator_reply_required'); next.status = 'waiting';
  next.obligations.push({ id: 'operator-reply', kind: 'response', status: 'pending', reason: '원래 답변 대기', wakeKey: 'operator-reply', dueAt: null });
  const second = command(next, 'original-wait');
  assert.equal((await stores.state.commit(second)).kind, 'committed');
  const session = await stores.sessions.open({ agentId: profile.identity.agentId,
    tenantId: state.policy.tenantId, principalId: state.policy.principalId }, { route: 'test:identity-recovery', now: 1000 });
  const received = await stores.sessions.receive({ scope: session.scope, messageId: 'original-message', digest: sha256(rawText),
    text: rawText, payload: { rawText }, kind: 'work', workId: state.id, labels: ['synthetic'], receivedAt: 1000 });
  await stores.sessions.settle(session.scope, received.input.messageId, received.input.digest, { status: 'applied' });
  const originalInput = await stores.sessions.input(session.scope, received.input.messageId);
  const originalSession = await stores.sessions.get(session.scope);
  const originalHistory = await stores.sessions.history(session.scope, state.policy, { limit: 10 });
  const originalWork = await snapshot(stores.state, state.id, [first.commandId, second.commandId]);
  assert.equal(originalInput?.text, rawText);
  assert.deepEqual(originalHistory.entries.map(entry => entry.text), [rawText]);
  assert.deepEqual(originalWork.state, next);
  await close(stores);
  writeFileSync(join(root, 'notes.txt'), rawText, { mode: 0o600 });
  const before = inspectAgentHostIdentity(profile, identityOptions); assert.ok(before);
  assert.equal(before.record.sequence, 1);
  const backup = backupAgent(profiles, root, archive, true);
  assert.equal(backup.manifest.agentId, profile.identity.agentId);
  assert.equal(inspectAgentBackup(archive).manifest.digest, backup.manifest.digest);
  const archiveTree = captureLifecycleTree(archive), originalTree = captureLifecycleTree(root);
  renameSync(root, preserved);
  const restored = restoreAgentBackup(profiles, archive, root, backup.manifest.digest, true);
  assert.equal(restored.agentId, profile.identity.agentId);
  assert.equal(restored.operationId, `local:${backup.manifest.digest}`);
  assert.equal(restored.recoveryRequired, true);
  assert.equal(existsSync(join(root, pendingName)), false);
  const completionBytes = readFileSync(join(root, AGENT_LOCAL_RESTORE_COMPLETION));
  const request: RebindRestoredAgentHostIdentityInput = { kind: 'local', directory: root, backupDirectory: archive,
    operationId: restored.operationId, expectedBackupDigest: backup.manifest.digest, expectedHeadDigest: before.digest, offline: true };
  const registryTree = captureLifecycleTree(registry);
  const head = () => inspectAgentHostIdentity({ root, identity: profile.identity }, identityOptions);
  const rebind = (override: Partial<RebindRestoredAgentHostIdentityInput> = {}) => rebindRestoredAgentHostIdentity({ ...request, ...override }, identityOptions);
  const unchangedOriginals = () => {
    assert.deepEqual(captureLifecycleTree(preserved), originalTree, 'the renamed original agent is preserved');
    assert.deepEqual(captureLifecycleTree(archive), archiveTree, 'the archive and its original files are preserved');
  };
  const unchangedRegistration = () => {
    assert.deepEqual(head(), before);
    assert.deepEqual(captureLifecycleTree(registry), registryTree);
  };
  // This fixture has only local notes and seeded history, with no external execution registration.
  const source: AgentRestoreReconciliationSource = { revision: '1', async inspect(basis, signal) {
    signal.throwIfAborted(); unchangedOriginals();
    assert.equal(basis.agentId, profile.identity.agentId); assert.equal(basis.root, root);
    assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), rawText);
    return { sourceId: 'fixture-original-notes', sourceRevision: '1', basisDigest: basis.digest, status: 'consistent',
      sourceHead: sha256(rawText), evidence: [{ reference: 'fixture:notes.txt', digest: sha256(rawText) }], unresolved: [] };
  }, async verify(basis, report, signal) {
    signal.throwIfAborted(); unchangedOriginals();
    return basis.agentId === profile.identity.agentId && report.basisDigest === basis.digest && report.sourceHead === sha256(rawText) &&
      readFileSync(join(root, 'notes.txt'), 'utf8') === rawText;
  } };
  const reconcile = () => reconcileAgentRestore(profiles, { directory: root, offline: true },
    { ...identityOptions, sources: new Map([['fixture-original-notes', source]]) });
  return { base, root, preserved, archive, registry, profile, before, request, identityOptions, profiles,
    completionBytes, originalWork, originalInput, originalSession, originalHistory, artifact, state, session,
    first, second, open, close, head, rebind, reconcile, unchangedOriginals, unchangedRegistration };
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: a verified local restore needs explicit rebind before stores reopen with all original records`, async t => {
    const f = await fixture(t, backend);
    const beforeOpen = captureLifecycleTree(f.root);
    await assert.rejects(f.open(), /agent_host_identity_duplicate_identity/);
    assert.deepEqual(captureLifecycleTree(f.root), beforeOpen, 'duplicate open stops before store/lease writes');
    f.unchangedRegistration();
    const rebound = await f.rebind();
    assert.equal(rebound.record.sequence, 2); assert.equal(rebound.record.previous, f.before.digest);
    assert.deepEqual(rebound.record.identity, f.profile.identity);
    assert.notDeepEqual(rebound.record.rootIdentity, f.before.record.rootIdentity);
    assert.deepEqual(rebound.record.reason, { kind: 'restore', operationId: f.request.operationId,
      backupDigest: f.request.expectedBackupDigest, originalRoot: f.root });
    await assert.rejects(f.open(), /agent_restore_reconciliation_required/);
    assert.equal((await f.reconcile()).status, 'reconciled');
    const stores = await f.open();
    try {
      stores.assertIdentityCurrent();
      assert.deepEqual(await snapshot(stores.state, f.state.id, [f.first.commandId, f.second.commandId]), f.originalWork);
      assert.deepEqual(await stores.sessions.get(f.session.scope), f.originalSession);
      assert.deepEqual(await stores.sessions.input(f.session.scope, 'original-message'), f.originalInput);
      assert.deepEqual(await stores.sessions.history(f.session.scope, f.state.policy, { limit: 10 }), f.originalHistory);
      assert.equal(Buffer.from(await stores.artifacts.get(f.artifact, f.state.policy)).toString('utf8'), rawText);
      assert.equal((await stores.state.commit(f.first)).kind, 'duplicate');
      assert.deepEqual(await snapshot(stores.state, f.state.id, [f.first.commandId, f.second.commandId]), f.originalWork);
      assert.equal((await stores.state.get(f.state.id))?.status, 'waiting');
      assert.deepEqual((await stores.state.get(f.state.id))?.budget, f.originalWork.state?.budget);
    } finally { await f.close(stores); }
    assert.deepEqual(readFileSync(join(f.root, AGENT_LOCAL_RESTORE_COMPLETION)), f.completionBytes);
    assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), rawText);
    f.unchangedOriginals();
  });
}

test('rebind rejects the wrong expected head, backup, operation, and missing offline confirmation without changing registration', async t => {
  const f = await fixture(t);
  await assert.rejects(f.rebind({ expectedHeadDigest: differentDigest(f.before.digest) }), /agent_host_identity_rebind_conflict/);
  await assert.rejects(f.rebind({ expectedBackupDigest: differentDigest(f.request.expectedBackupDigest) }), /lifecycle_restore_binding_mismatch/);
  await assert.rejects(f.rebind({ operationId: `local:${differentDigest(f.request.expectedBackupDigest)}` }), /lifecycle_restore_binding_mismatch/);
  await assert.rejects(f.rebind({ offline: false }), /lifecycle_offline_confirmation_required/);
  assert.equal(existsSync(join(f.root, '.secumon', 'lifecycle-maintenance.json')), false);
  assert.deepEqual(readdirSync(join(f.root, '.secumon', 'runtime-leases')), []);
  f.unchangedRegistration(); f.unchangedOriginals();
});

test('a pending restore marker prevents rebind even when a matching completion marker exists', async t => {
  const f = await fixture(t), pending = Buffer.from(JSON.stringify({ schemaVersion: 1,
    backupDigest: f.request.expectedBackupDigest, agentId: f.profile.identity.agentId }));
  writeFileSync(join(f.root, pendingName), pending, { mode: 0o600, flag: 'wx' });
  await assert.rejects(f.rebind(), /lifecycle_restore_incomplete/);
  assert.deepEqual(readFileSync(join(f.root, pendingName)), pending);
  assert.deepEqual(readFileSync(join(f.root, AGENT_LOCAL_RESTORE_COMPLETION)), f.completionBytes);
  assert.equal(existsSync(join(f.root, '.secumon', 'lifecycle-maintenance.json')), false);
  f.unchangedRegistration(); f.unchangedOriginals();
});

test('an older restore without a completion marker is preserved and cannot manufacture rebind authority', async t => {
  const f = await fixture(t);
  unlinkSync(join(f.root, AGENT_LOCAL_RESTORE_COMPLETION));
  await assert.rejects(f.rebind(), /lifecycle_restore_completion_required/);
  assert.equal(existsSync(join(f.root, AGENT_LOCAL_RESTORE_COMPLETION)), false);
  await assert.rejects(f.open(), /agent_host_identity_duplicate_identity/);
  f.unchangedRegistration(); f.unchangedOriginals();
});

test('a real live runtime lease blocks restore rebind and is neither deleted nor taken over', async t => {
  const f = await fixture(t), lease = acquireAgentRuntimeLease(f.root);
  const leasesPath = join(f.root, '.secumon', 'runtime-leases');
  const names = readdirSync(leasesPath); assert.equal(names.length, 1);
  const path = join(leasesPath, names[0]!), bytes = readFileSync(path);
  assert.equal(JSON.parse(bytes.toString('utf8')).pid, process.pid);
  try {
    await assert.rejects(f.rebind(), /agent_runtime_active/);
    assert.deepEqual(readdirSync(leasesPath), names);
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal(existsSync(join(f.root, '.secumon', 'lifecycle-maintenance.json')), false);
    f.unchangedRegistration(); f.unchangedOriginals();
  } finally { lease.close(); }
});

test('same-operation rebind retry is idempotent and does not authorize another copy or the preserved old object', async t => {
  const f = await fixture(t), first = await f.rebind();
  const registeredTree = captureLifecycleTree(f.registry);
  assert.deepEqual(await f.rebind(), first);
  assert.deepEqual(captureLifecycleTree(f.registry), registeredTree);
  const copy = join(f.base, 'another-copy'); mkdirSync(copy, { mode: 0o700 });
  copyLifecycleTree(f.root, copy, captureLifecycleTree(f.root));
  const copiedTree = captureLifecycleTree(copy);
  await assert.rejects(f.open(copy), /agent_host_identity_duplicate_identity/);
  assert.deepEqual(captureLifecycleTree(copy), copiedTree);
  await assert.rejects(f.rebind({ directory: copy }), /lifecycle_restore_binding_mismatch/);
  await assert.rejects(f.open(f.preserved), /agent_host_identity_duplicate_identity/);
  assert.deepEqual(f.head(), first);
  assert.deepEqual(captureLifecycleTree(f.registry), registeredTree);
  assert.deepEqual(readFileSync(join(copy, AGENT_LOCAL_RESTORE_COMPLETION)), f.completionBytes);
  f.unchangedOriginals();
});

test('changed restored bytes are not accepted solely on the completion marker', async t => {
  const f = await fixture(t), changed = 'edited after restoration; preserve this evidence\n';
  writeFileSync(join(f.root, 'notes.txt'), changed, { mode: 0o600 });
  await assert.rejects(f.rebind(), /lifecycle_restore_digest_mismatch/);
  assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), changed);
  assert.deepEqual(readFileSync(join(f.root, AGENT_LOCAL_RESTORE_COMPLETION)), f.completionBytes);
  f.unchangedRegistration(); f.unchangedOriginals();
});

test('changed archive originals are rejected and retained instead of trusting only the saved digest field', async t => {
  const f = await fixture(t), changed = 'damaged archive bytes remain available for diagnosis\n';
  const path = join(f.archive, 'data', 'notes.txt'); writeFileSync(path, changed, { mode: 0o600 });
  const alteredArchive = captureLifecycleTree(f.archive), preserved = captureLifecycleTree(f.preserved);
  await assert.rejects(f.rebind(), /lifecycle_backup_digest_mismatch/);
  assert.equal(readFileSync(path, 'utf8'), changed);
  assert.deepEqual(captureLifecycleTree(f.archive), alteredArchive);
  assert.deepEqual(captureLifecycleTree(f.preserved), preserved);
  assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), rawText);
  f.unchangedRegistration();
});
