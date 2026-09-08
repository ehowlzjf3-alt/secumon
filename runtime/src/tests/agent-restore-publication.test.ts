import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AGENT_RESTORE_RECONCILIATION, AGENT_RESTORE_RECONCILIATION_PENDING } from '../application/agent-restore-reconciliation-contracts.js';
import { hostMetadataFiles } from '../infrastructure/host-metadata-files.js';
import { backupAgent, restoreAgentBackup } from '../infrastructure/agent-lifecycle.js';
import { inspectAgentHostIdentity } from '../infrastructure/agent-host-identities.js';
import { rebindRestoredAgentHostIdentity } from '../infrastructure/agent-host-identity-recovery.js';
import { inspectAgentRestoreReconciliation, reconcileAgentRestore } from '../infrastructure/agent-restore-reconciliation.js';
import { restoreEffectsFixture } from './agent-restore-effects-fixture.js';

test('publication failure keeps a provisional receipt blocked and retries only the unchanged original proof', async t => {
  const f = await restoreEffectsFixture(t), opened = await f.open(); await f.close(opened.profile);
  const note = join(f.directory, 'notes.txt'); writeFileSync(note, 'original note', { mode: 0o600 });
  const backup = f.backup(), restored = await f.restore(backup.manifest.digest); await restored.rebind();
  const files = hostMetadataFiles(), originalSync = files.syncDirectory;
  const receiptPath = join(f.directory, AGENT_RESTORE_RECONCILIATION);
  const pendingPath = join(f.directory, AGENT_RESTORE_RECONCILIATION_PENDING);
  let changed = false;
  files.syncDirectory = function (directory, observer) {
    originalSync.call(this, directory, observer);
    if (!changed && existsSync(receiptPath)) { changed = true; writeFileSync(note, 'changed during publication', { mode: 0o600 }); }
  };
  try {
    await assert.rejects(reconcileAgentRestore(f.profiles, { directory: f.directory, offline: true },
      { ...f.identityOptions, sources: f.sources }), /agent_restore_basis_changed/);
  } finally { files.syncDirectory = originalSync; }
  assert.equal(changed, true); assert.equal(existsSync(pendingPath), true);
  const provisional = readFileSync(receiptPath);
  assert.equal(inspectAgentRestoreReconciliation(f.profiles, f.directory, f.identityOptions).status, 'required');
  await assert.rejects(f.open(), /agent_restore_reconciliation_required/);
  await assert.rejects(reconcileAgentRestore(f.profiles, { directory: f.directory, offline: true },
    { ...f.identityOptions, sources: f.sources }), /agent_restore_reconciliation_recovery_required/);
  writeFileSync(note, 'original note', { mode: 0o600 });
  const retried = await reconcileAgentRestore(f.profiles, { directory: f.directory, offline: true }, { ...f.identityOptions, sources: f.sources });
  assert.equal(retried.status, 'reconciled'); assert.equal(existsSync(pendingPath), false);
  assert.deepEqual(readFileSync(receiptPath), provisional, 'retry retains the original provisional receipt');
  const resumed = await f.open(); await f.close(resumed.profile);
});

test('the same backup has a new restore occurrence and cannot reuse copied clearance; new backups omit clearance', async t => {
  const f = await restoreEffectsFixture(t), opened = await f.open(); await f.close(opened.profile);
  const backup = f.backup(), first = await f.restore(backup.manifest.digest); await first.rebind();
  await reconcileAgentRestore(f.profiles, { directory: f.directory, offline: true }, { ...f.identityOptions, sources: f.sources });
  const clearance = readFileSync(join(f.directory, AGENT_RESTORE_RECONCILIATION));
  const newerBackup = backupAgent(f.profiles, f.directory, join(f.base, 'after-reconciliation-backup'), true);
  assert.ok(newerBackup.manifest.entries.every(entry => entry.path !== AGENT_RESTORE_RECONCILIATION && entry.path !== AGENT_RESTORE_RECONCILIATION_PENDING));
  const profile = f.profiles.inspect(f.directory); assert.equal(profile.status, 'ready');
  if (profile.status !== 'ready') throw new Error('fixture_profile_not_ready');
  const head = inspectAgentHostIdentity(profile, f.identityOptions)!;
  renameSync(f.directory, join(f.base, 'first-restored-agent'));
  const second = restoreAgentBackup(f.profiles, f.archive, f.directory, backup.manifest.digest, true);
  assert.ok(second.restorationId); assert.notEqual(second.restorationId, first.restored.restorationId);
  assert.equal(second.operationId, first.restored.operationId);
  await rebindRestoredAgentHostIdentity({ kind: 'local', directory: f.directory, backupDirectory: f.archive,
    operationId: second.operationId, expectedBackupDigest: backup.manifest.digest, expectedHeadDigest: head.digest, offline: true }, f.identityOptions);
  assert.equal(existsSync(join(f.directory, AGENT_RESTORE_RECONCILIATION)), false);
  writeFileSync(join(f.directory, AGENT_RESTORE_RECONCILIATION), clearance, { mode: 0o600 });
  await assert.rejects(f.open(), /agent_restore_reconciliation_required/);
  await assert.rejects(reconcileAgentRestore(f.profiles, { directory: f.directory, offline: true },
    { ...f.identityOptions, sources: f.sources }), /agent_restore_receipt_binding_mismatch/);
});

test('a synchronous source that starves the timer cannot publish beyond the shared deadline', async t => {
  const f = await restoreEffectsFixture(t), opened = await f.open(); await f.close(opened.profile);
  const backup = f.backup(), restored = await f.restore(backup.manifest.digest); await restored.rebind();
  const sources = new Map([...f.sources].map(([id, source]) => [id, { revision: source.revision,
    async inspect(basis: Parameters<typeof source.inspect>[0], signal: AbortSignal) {
      const until = performance.now() + 30;
      while (performance.now() < until) { /* Bounded synchronous host work prevents timer delivery. */ }
      return source.inspect(basis, signal);
    }, verify: source.verify.bind(source) }]));
  await assert.rejects(reconcileAgentRestore(f.profiles, { directory: f.directory, offline: true },
    { ...f.identityOptions, sources, timeoutMs: 5 }), /agent_restore_source_timeout/);
  assert.equal(existsSync(join(f.directory, AGENT_RESTORE_RECONCILIATION)), false);
  await assert.rejects(f.open(), /agent_restore_reconciliation_required/);
});
