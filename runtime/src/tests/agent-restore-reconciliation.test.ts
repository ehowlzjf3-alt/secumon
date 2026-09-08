import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextImmediate } from 'node:timers/promises';
import { AGENT_RESTORE_RECONCILIATION, type AgentRestoreReconciliationBasis,
  type AgentRestoreReconciliationReport, type AgentRestoreReconciliationSource } from '../application/agent-restore-reconciliation-contracts.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { backupAgent, restoreAgentBackup } from '../infrastructure/agent-lifecycle.js';
import { captureLifecycleTree } from '../infrastructure/agent-lifecycle-files.js';
import { acquireAgentMaintenance } from '../infrastructure/agent-lifecycle-lease.js';
import { inspectAgentHostIdentity } from '../infrastructure/agent-host-identities.js';
import { rebindRestoredAgentHostIdentity } from '../infrastructure/agent-host-identity-recovery.js';
import { inspectAgentRestoreReconciliation, reconcileAgentRestore } from '../infrastructure/agent-restore-reconciliation.js';
import { sha256 } from '../infrastructure/digest.js';

const original = '복원 직전 보관한 로컬 원문입니다.\n';
function consistent(basis: AgentRestoreReconciliationBasis, sourceId = 'local-history'): AgentRestoreReconciliationReport {
  return { sourceId, sourceRevision: '1', basisDigest: basis.digest, status: 'consistent', sourceHead: sha256(original),
    evidence: [{ reference: 'fixture:local-original', digest: sha256(original) }], unresolved: [] };
}
function sourceFor(sourceId = 'local-history'): AgentRestoreReconciliationSource {
  return { revision: '1', async inspect(basis, signal) { signal.throwIfAborted(); return consistent(basis, sourceId); },
    async verify(basis, report, signal) { signal.throwIfAborted(); return report.basisDigest === basis.digest && report.sourceId === sourceId; } };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-restore-reconciliation-')));
  const engine = join(base, 'engine'), root = join(base, 'agent'), archive = join(base, 'backup'), preserved = join(base, 'original');
  const registry = join(base, 'registry');
  mkdirSync(engine, { mode: 0o700 });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const profiles = new FileAgentProfileStore(engine), profile = profiles.initialize(root, { stateBackend: 'sqlite' });
  const identityOptions = { registryDirectory: registry, engineDirectories: [engine] };
  const stores = await openAgentStores(profiles, root, undefined, { identityRegistryDirectory: registry });
  await stores.close();
  const note = join(root, 'original.txt'); writeFileSync(note, original, { mode: 0o600 });
  const head = inspectAgentHostIdentity(profile, identityOptions); assert.ok(head);
  const backup = backupAgent(profiles, root, archive, true);
  const originalTree = captureLifecycleTree(root), archiveTree = captureLifecycleTree(archive);
  renameSync(root, preserved);
  const restored = restoreAgentBackup(profiles, archive, root, backup.manifest.digest, true);
  await rebindRestoredAgentHostIdentity({ kind: 'local', directory: root, backupDirectory: archive,
    operationId: restored.operationId, expectedBackupDigest: backup.manifest.digest, expectedHeadDigest: head.digest, offline: true }, identityOptions);
  const receiptPath = join(root, AGENT_RESTORE_RECONCILIATION);
  function status() { return inspectAgentRestoreReconciliation(profiles, root, identityOptions); }
  function noClearance() {
    assert.equal(existsSync(receiptPath), false);
    assert.equal(status().status, 'required');
    assert.deepEqual(captureLifecycleTree(preserved), originalTree);
    assert.deepEqual(captureLifecycleTree(archive), archiveTree);
  }
  function reconcile(sources: ReadonlyMap<string, AgentRestoreReconciliationSource>, timeoutMs?: number) {
    return reconcileAgentRestore(profiles, { directory: root, offline: true }, {
      ...identityOptions, sources, ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }
  assert.equal(status().status, 'required');
  return { root, note, receiptPath, profiles, identityOptions, reconcile, status, noClearance };
}

test('restore reconciliation rejects absent sources and reports without matching identity, basis, or original evidence', async t => {
  const f = await fixture(t);
  await assert.rejects(f.reconcile(new Map()), /agent_restore_sources_required/); f.noClearance();
  for (const invalid of [
    (report: AgentRestoreReconciliationReport) => ({ ...report, sourceId: 'unregistered-source' }),
    (report: AgentRestoreReconciliationReport) => ({ ...report, sourceRevision: 'different-revision' }),
    (report: AgentRestoreReconciliationReport) => ({ ...report, basisDigest: 'f'.repeat(64) }),
    (report: AgentRestoreReconciliationReport) => ({ ...report, evidence: [] }),
  ]) {
    let verifications = 0;
    const source: AgentRestoreReconciliationSource = { revision: '1', async inspect(basis) { return invalid(consistent(basis)); },
      async verify() { verifications++; return true; } };
    await assert.rejects(f.reconcile(new Map([['local-history', source]])), /agent_restore_report_invalid/);
    assert.equal(verifications, 0); f.noClearance();
  }
});

test('an unresolved source preserves its findings and keeps restore startup blocked', async t => {
  const f = await fixture(t); let verifications = 0;
  const source: AgentRestoreReconciliationSource = { revision: '1', async inspect(basis) {
    return { ...consistent(basis), status: 'unresolved', unresolved: ['missing_post_backup_delivery:delivery-1'] };
  }, async verify() { verifications++; return true; } };
  const result = await f.reconcile(new Map([['local-history', source]]));
  assert.equal(result.status, 'unresolved');
  if (result.status !== 'unresolved') throw new Error('expected_unresolved_restore');
  assert.deepEqual(result.reports[0]?.unresolved, ['missing_post_backup_delivery:delivery-1']);
  assert.equal(verifications, 0); f.noClearance();
});

test('a source that changes before verification cannot publish restore clearance', async t => {
  const f = await fixture(t); let inspected = 0, verified = 0;
  const source: AgentRestoreReconciliationSource = { revision: '1', async inspect(basis) { inspected++; return consistent(basis); },
    async verify() { verified++; return false; } };
  await assert.rejects(f.reconcile(new Map([['local-history', source]])), /agent_restore_source_changed/);
  assert.equal(inspected, 1); assert.equal(verified, 1); f.noClearance();
});

test('changing a restored original during source inspection invalidates the captured basis', async t => {
  const f = await fixture(t); let verified = 0;
  const source: AgentRestoreReconciliationSource = { revision: '1', async inspect(basis) {
    writeFileSync(f.note, '자료가 대조 중 변경되었습니다.\n'); return consistent(basis);
  }, async verify() { verified++; return true; } };
  await assert.rejects(f.reconcile(new Map([['local-history', source]])), /agent_restore_basis_changed/);
  assert.equal(verified, 0); assert.equal(readFileSync(f.note, 'utf8'), '자료가 대조 중 변경되었습니다.\n'); f.noClearance();
});

test('a timed out reader is aborted and its later consistent report cannot issue clearance', async t => {
  const f = await fixture(t), late = deferred<void>(), started = deferred<void>(), finished = deferred<void>();
  let observedSignal: AbortSignal | undefined, verified = 0;
  const source: AgentRestoreReconciliationSource = { revision: '1', async inspect(basis, signal) {
    observedSignal = signal; started.resolve(); await late.promise; finished.resolve(); return consistent(basis);
  }, async verify() { verified++; return true; } };
  const rejected = assert.rejects(f.reconcile(new Map([['local-history', source]]), 20), /agent_restore_source_timeout/);
  await started.promise;
  try { await rejected; assert.equal(observedSignal?.aborted, true); f.noClearance(); }
  finally { late.resolve(); }
  await finished.promise; await nextImmediate();
  assert.equal(verified, 0); f.noClearance();
});

test('every registered source must inspect and verify before restore clearance is published', async t => {
  const f = await fixture(t), calls: string[] = [];
  const make = (id: string, current: boolean): AgentRestoreReconciliationSource => ({ revision: '1',
    async inspect(basis) { calls.push(`inspect:${id}`); return consistent(basis, id); },
    async verify() { calls.push(`verify:${id}`); return current; } });
  await assert.rejects(f.reconcile(new Map([['tools', make('tools', true)], ['deliveries', make('deliveries', false)]])), /agent_restore_source_changed/);
  assert.deepEqual(calls, ['inspect:tools', 'inspect:deliveries', 'verify:tools', 'verify:deliveries']); f.noClearance();
});

test('source functions and registration are captured before an awaited reader permits host replacement', async t => {
  const f = await fixture(t), entered = deferred<void>(), resume = deferred<void>(), calls: string[] = [];
  let replacements = 0;
  const first = { revision: '1', async inspect(basis: AgentRestoreReconciliationBasis) {
    calls.push('inspect:first'); entered.resolve(); await resume.promise; return consistent(basis, 'first');
  }, async verify() { calls.push('verify:first'); return true; } };
  const second = { revision: '1', async inspect(basis: AgentRestoreReconciliationBasis) {
    calls.push('inspect:second'); return consistent(basis, 'second');
  }, async verify() { calls.push('verify:second'); return true; } };
  const sources = new Map<string, AgentRestoreReconciliationSource>([['first', first], ['second', second]]);
  const pending = f.reconcile(sources);
  await entered.promise;
  first.verify = async () => { replacements++; return false; };
  second.revision = '2';
  second.inspect = async basis => { replacements++; return consistent(basis, 'replacement'); };
  second.verify = async () => { replacements++; return false; };
  sources.clear(); sources.set('replacement', sourceFor('replacement'));
  resume.resolve();
  const result = await pending;
  assert.equal(result.status, 'reconciled'); assert.equal(replacements, 0);
  assert.deepEqual(calls, ['inspect:first', 'inspect:second', 'verify:first', 'verify:second']);
  assert.equal(f.status().status, 'reconciled');
});

test('an active maintenance owner blocks source inspection and retains its own lease', async t => {
  const f = await fixture(t), lease = acquireAgentMaintenance(f.root, true);
  const leasePath = join(f.root, '.secumon', 'lifecycle-maintenance.json'), originalLease = readFileSync(leasePath);
  let inspected = 0;
  const source: AgentRestoreReconciliationSource = { ...sourceFor(), async inspect(basis) { inspected++; return consistent(basis); } };
  try {
    await assert.rejects(f.reconcile(new Map([['local-history', source]])), /agent_maintenance_active/);
    assert.equal(inspected, 0); assert.deepEqual(readFileSync(leasePath), originalLease); f.noClearance();
  } finally { lease.close(); }
  assert.equal(existsSync(leasePath), false);
});

test('repeating a matching restore clearance preserves its receipt and does not re-read completed sources', async t => {
  const f = await fixture(t); let inspected = 0, verified = 0;
  const source: AgentRestoreReconciliationSource = { revision: '1', async inspect(basis) { inspected++; return consistent(basis); },
    async verify() { verified++; return true; } };
  const sources = new Map([['local-history', source]]), first = await f.reconcile(sources);
  assert.equal(first.status, 'reconciled');
  const receipt = readFileSync(f.receiptPath);
  writeFileSync(f.note, original + '대조 완료 후 다음 작업에서 작성한 내용입니다.\n');
  const second = await f.reconcile(sources);
  assert.deepEqual(second, first); assert.equal(inspected, 1); assert.equal(verified, 1);
  assert.deepEqual(readFileSync(f.receiptPath), receipt); assert.equal(f.status().status, 'reconciled');
  assert.equal(readFileSync(f.note, 'utf8'), original + '대조 완료 후 다음 작업에서 작성한 내용입니다.\n');
});
