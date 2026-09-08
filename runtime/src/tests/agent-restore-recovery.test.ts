import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_LOCAL_RESTORE_COMPLETION } from '../application/agent-lifecycle-contracts.js';
import { AGENT_RESTORE_RECONCILIATION } from '../application/agent-restore-reconciliation-contracts.js';
import { backupAgent, inspectAgentBackup } from '../infrastructure/agent-lifecycle.js';
import { captureLifecycleTree, copyLifecycleTree, lifecycleDigest } from '../infrastructure/agent-lifecycle-files.js';
import { inspectAgentRestoreReconciliation } from '../infrastructure/agent-restore-reconciliation.js';
import { inspectAgentRestoreRecovery } from '../infrastructure/agent-restore-recovery.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { hostMetadataFiles } from '../infrastructure/host-metadata-files.js';
import { restoreRecoveryFixture as fixture } from './agent-restore-recovery-fixture.js';

const different = (value: string) => value === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);

test('preparing recovery from a complete newer backup preserves the lost real dispatch, effect, session and usage without activating them', { timeout: 60000 }, async t => {
  const f = await fixture(t), selected = f.prepare(), manifest = selected.manifest;
  assert.equal(selected.directory, f.input.destination); assert.equal(manifest.activation, 'not_applied');
  assert.equal(manifest.agentId, f.ready.identity.agentId); assert.equal(manifest.targetRoot, f.directory);
  assert.equal(manifest.operationId, f.input.operationId); assert.equal(manifest.prior.identityHeadDigest, f.input.expectedHeadDigest);
  assert.equal(manifest.selectedBackup.digest, f.newer.manifest.digest); assert.equal(manifest.selectedBackup.originalRoot, f.directory);
  assert.deepEqual(manifest.prior.entries, f.preservedEntries); assert.deepEqual(manifest.selectedBackup.entries, f.newerTree);
  assert.deepEqual(captureLifecycleTree(join(selected.directory, 'preserved')), f.preservedEntries);
  assert.deepEqual(captureLifecycleTree(join(selected.directory, 'selected-backup')), f.newerTree);
  assert.deepEqual(readFileSync(join(selected.directory, 'preserved', AGENT_LOCAL_RESTORE_COMPLETION)),
    readFileSync(join(f.directory, AGENT_LOCAL_RESTORE_COMPLETION)));
  assert.ok(manifest.comparison.changed.includes(f.paths.state));
  assert.ok(manifest.comparison.removed.includes(AGENT_LOCAL_RESTORE_COMPLETION));
  const attempt = f.applied.attempts[0]!;
  assert.ok(!JSON.stringify(f.oldStored).includes(attempt.id));
  assert.ok(f.newerStored.receipts.some(row => row.command_id === `dispatch:${attempt.id}`));
  assert.equal(f.applied.budget.used.toolCalls, 1); assert.equal(f.applied.budget.used.modelCalls, 1);
  assert.ok(attempt.resultArtifact && attempt.effectReceipt && f.applied.evidence.length);
  // Whole-file equality includes the actual old commands and all newer receipt bodies, not a recreated final WorkState.
  for (const path of Object.values(f.paths)) assert.deepEqual(readFileSync(join(selected.directory, 'selected-backup', 'data', path)),
    readFileSync(join(f.newer.directory, 'data', path)));
  assert.deepEqual(inspectAgentBackup(join(selected.directory, 'selected-backup')).manifest, f.newer.manifest);
  assert.deepEqual(inspectAgentRestoreRecovery(selected.directory), selected);
  const report = await f.source.inspect(f.unresolved.basis, new AbortController().signal);
  assert.equal(report.status, 'unresolved'); assert.ok(report.unresolved.includes(`unaccounted_external_effect:${attempt.id}`));
  await assert.rejects(f.open(), /agent_restore_reconciliation_required/);
  f.unchanged();
});

test('recovery preparation requires explicit offline input and the exact current identity head and selected backup digest', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  for (const [change, error] of [
    [{ offline: false }, /lifecycle_offline_confirmation_required/],
    [{ expectedHeadDigest: different(f.input.expectedHeadDigest) }, /agent_restore_recovery_binding_mismatch/],
    [{ expectedBackupDigest: different(f.input.expectedBackupDigest) }, /agent_restore_recovery_binding_mismatch/],
  ] as const) {
    assert.throws(() => f.prepare(change), error); assert.equal(existsSync(f.input.destination), false); f.unchanged();
  }
});

test('a foreign agent archive or a self-consistent archive naming another original root cannot become this agents recovery candidate', { timeout: 60000 }, async t => {
  const f = await fixture(t), otherRoot = join(f.base, 'foreign-agent');
  f.profiles.initialize(otherRoot, { stateBackend: 'sqlite' });
  const stores = await openAgentStores(f.profiles, otherRoot, undefined, { identityRegistryDirectory: f.identityOptions.registryDirectory });
  await stores.close();
  const other = backupAgent(f.profiles, otherRoot, join(f.base, 'foreign-backup'), true);
  assert.throws(() => f.prepare({ backupDirectory: other.directory, expectedBackupDigest: other.manifest.digest }), /agent_restore_recovery_binding_mismatch/);
  const wrongRoot = join(f.base, 'wrong-root-backup'); mkdirSync(wrongRoot, { mode: 0o700 });
  copyLifecycleTree(f.newer.directory, wrongRoot, f.newerTree);
  // This negative input has a valid archive digest and unchanged data, but a deliberately incompatible binding.
  const { digest: _ignored, ...body } = f.newer.manifest;
  const wrongBody = { ...body, originalRoot: otherRoot }, manifest = { ...wrongBody, digest: lifecycleDigest(wrongBody) };
  writeFileSync(join(wrongRoot, 'backup.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  assert.equal(inspectAgentBackup(wrongRoot).manifest.digest, manifest.digest);
  assert.throws(() => f.prepare({ backupDirectory: wrongRoot, expectedBackupDigest: manifest.digest }), /agent_restore_recovery_binding_mismatch/);
  assert.equal(existsSync(f.input.destination), false); f.unchanged();
});

test('recovery preparation refuses an occupied destination and source or current-root overlap without overwriting either tree', { timeout: 60000 }, async t => {
  const f = await fixture(t); mkdirSync(f.input.destination, { mode: 0o700 });
  const sentinel = join(f.input.destination, 'keep.txt'); writeFileSync(sentinel, 'occupied output remains original\n', { mode: 0o600 });
  const occupied = captureLifecycleTree(f.input.destination);
  assert.throws(() => f.prepare(), /agent_restore_recovery_destination_exists/);
  for (const destination of [join(f.directory, 'nested-recovery'), join(f.newer.directory, 'nested-recovery'), f.base])
    assert.throws(() => f.prepare({ destination }), /lifecycle_directory_overlap/);
  assert.deepEqual(captureLifecycleTree(f.input.destination), occupied); f.unchanged();
});

test('recovery inspection rejects changed preserved originals and changed selected archive copies while retaining both failed candidates', { timeout: 60000 }, async t => {
  const f = await fixture(t), first = f.prepare(), second = f.prepare({ destination: join(f.base, 'second-recovery'), operationId: randomUUID() });
  const firstNote = join(first.directory, 'preserved', 'recovery-original.txt');
  writeFileSync(firstNote, 'changed preserved original\n', { mode: 0o600 });
  const firstTree = captureLifecycleTree(first.directory);
  assert.throws(() => inspectAgentRestoreRecovery(first.directory), /agent_restore_recovery_digest_mismatch/);
  assert.deepEqual(captureLifecycleTree(first.directory), firstTree);
  const secondNote = join(second.directory, 'selected-backup', 'data', 'recovery-original.txt');
  writeFileSync(secondNote, 'changed selected archive copy\n', { mode: 0o600 });
  const secondTree = captureLifecycleTree(second.directory);
  assert.throws(() => inspectAgentRestoreRecovery(second.directory), /agent_restore_recovery_digest_mismatch|lifecycle_backup_digest_mismatch/);
  assert.deepEqual(captureLifecycleTree(second.directory), secondTree); f.unchanged();
});

test('a missing or changed candidate manifest cannot be inspected as a completed recovery preparation', { timeout: 60000 }, async t => {
  const f = await fixture(t), first = f.prepare(), second = f.prepare({ destination: join(f.base, 'second-recovery'), operationId: randomUUID() });
  unlinkSync(join(first.directory, 'recovery.json'));
  const firstTree = captureLifecycleTree(first.directory);
  assert.throws(() => inspectAgentRestoreRecovery(first.directory), /agent_restore_recovery_incomplete/);
  assert.deepEqual(captureLifecycleTree(first.directory), firstTree);
  const changed = { ...second.manifest, digest: different(second.manifest.digest) };
  writeFileSync(join(second.directory, 'recovery.json'), JSON.stringify(changed, null, 2) + '\n', { mode: 0o600 });
  const secondTree = captureLifecycleTree(second.directory);
  assert.throws(() => inspectAgentRestoreRecovery(second.directory), /agent_restore_recovery_digest_mismatch/);
  assert.deepEqual(captureLifecycleTree(second.directory), secondTree); f.unchanged();
});

for (const changedSource of ['current', 'archive'] as const) test(`a ${changedSource} original changed after both copies prevents manifest publication and leaves the incomplete recovery package`,
  { timeout: 60000, skip: process.platform === 'win32' ? 'POSIX host metadata read seam; native Windows recovery is a separate acceptance' : false }, async t => {
    const f = await fixture(t), files = hostMetadataFiles(), originalRead = files.readStableRegularFile;
    const copiedArchive = join(f.input.destination, 'selected-backup');
    const path = changedSource === 'current' ? f.note : join(f.newer.directory, 'data', 'recovery-original.txt');
    const replacement = `changed ${changedSource} source during the final original revalidation\n`;
    let changed = 0;
    // The final owner/config read follows both copies and precedes the manifest. The underlying read still runs.
    files.readStableRegularFile = function (directory, leaf, policy) {
      const bytes = originalRead.call(this, directory, leaf, policy);
      if (changed === 0 && leaf === 'config.json' && existsSync(join(copiedArchive, 'backup.json'))) {
        assert.equal(existsSync(join(f.input.destination, 'recovery.json')), false);
        assert.deepEqual(captureLifecycleTree(copiedArchive), f.newerTree, 'the whole selected archive was copied before interference');
        assert.deepEqual(captureLifecycleTree(join(f.input.destination, 'preserved')), f.preservedEntries);
        changed++; writeFileSync(path, replacement, { mode: 0o600 });
      }
      return bytes;
    };
    try {
      assert.throws(() => f.prepare(), changedSource === 'current' ? /lifecycle_source_changed/ : /lifecycle_source_changed|lifecycle_backup_digest_mismatch/);
    } finally { files.readStableRegularFile = originalRead; }
    assert.equal(changed, 1); assert.equal(readFileSync(path, 'utf8'), replacement);
    assert.equal(existsSync(join(f.input.destination, 'recovery.json')), false);
    assert.deepEqual(captureLifecycleTree(join(f.input.destination, 'preserved')), f.preservedEntries);
    assert.deepEqual(captureLifecycleTree(copiedArchive), f.newerTree);
    assert.throws(() => inspectAgentRestoreRecovery(f.input.destination), /agent_restore_recovery_incomplete/);
    const pendingTree = captureLifecycleTree(f.input.destination);
    assert.throws(() => f.prepare(), /agent_restore_recovery_destination_exists/);
    assert.deepEqual(captureLifecycleTree(f.input.destination), pendingTree, 'retry never adopts or deletes an incomplete candidate');
    if (changedSource === 'current') assert.deepEqual(captureLifecycleTree(f.newer.directory), f.newerTree);
    else assert.deepEqual(captureLifecycleTree(f.directory), f.priorTree);
    assert.deepEqual(f.externalFiles(), f.effects); assert.deepEqual(f.counts(), f.countsBefore);
    assert.equal(inspectAgentRestoreReconciliation(f.profiles, f.directory, f.identityOptions).status, 'required');
    assert.equal(existsSync(join(f.directory, AGENT_RESTORE_RECONCILIATION)), false);
  });
