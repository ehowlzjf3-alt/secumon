import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AGENT_RESTORE_RECONCILIATION } from '../application/agent-restore-reconciliation-contracts.js';
import { backupAgent } from '../infrastructure/agent-lifecycle.js';
import { captureLifecycleTree } from '../infrastructure/agent-lifecycle-files.js';
import { inspectAgentHostIdentity } from '../infrastructure/agent-host-identities.js';
import { inspectAgentRestoreReconciliation, reconcileAgentRestore } from '../infrastructure/agent-restore-reconciliation.js';
import { prepareAgentRestoreRecovery } from '../infrastructure/agent-restore-recovery.js';
import { restoreEffectsFixture } from './agent-restore-effects-fixture.js';

const noLease = (path: string) => path !== '.secumon/runtime-leases' && !path.startsWith('.secumon/runtime-leases/') &&
  path !== '.secumon/lifecycle-maintenance.json';
type RecoveryInput = Parameters<typeof prepareAgentRestoreRecovery>[1];

export async function restoreRecoveryFixture(t: TestContext) {
  const f = await restoreEffectsFixture(t), opened = await f.open(), accepted = await f.accept(opened.profile);
  const note = join(f.directory, 'recovery-original.txt');
  writeFileSync(note, '원래 담당 자료: 기존 사용자 입력과 함께 보존합니다.\n', { mode: 0o600 });
  await f.close(opened.profile);
  const old = f.backup(), oldStored = f.stored();
  const writer = await f.open(), applied = await f.writeAndAdopt(writer.profile, accepted.workId);
  await f.close(writer.profile);
  const newerStored = f.stored(), profile = f.profiles.inspect(f.directory);
  assert.equal(profile.status, 'ready'); if (profile.status !== 'ready') throw new Error('fixture_profile_not_ready');
  const paths = { state: relative(f.directory, profile.paths.state), memory: relative(f.directory, profile.paths.memory),
    channel: relative(f.directory, join(profile.paths.metadata, 'channel.sqlite')) };
  const newer = backupAgent(f.profiles, f.directory, join(f.base, 'newer-backup'), true);
  const restored = await f.restore(old.manifest.digest); await restored.rebind();
  const unresolved = await reconcileAgentRestore(f.profiles, { directory: f.directory, offline: true }, { ...f.identityOptions, sources: f.sources });
  assert.equal(unresolved.status, 'unresolved'); assert.deepEqual(f.stored(), oldStored);
  const current = f.profiles.inspect(f.directory); assert.equal(current.status, 'ready');
  if (current.status !== 'ready') throw new Error('fixture_profile_not_ready');
  const head = inspectAgentHostIdentity(current, f.identityOptions); assert.ok(head);
  const input: RecoveryInput = { directory: f.directory, backupDirectory: newer.directory, destination: join(f.base, 'recovery'),
    expectedBackupDigest: newer.manifest.digest, expectedHeadDigest: head.digest, operationId: randomUUID(), offline: true };
  const priorTree = captureLifecycleTree(f.directory), preservedEntries = captureLifecycleTree(f.directory, noLease);
  const newerTree = captureLifecycleTree(newer.directory), effects = f.externalFiles(), counts = f.counts();
  const prepare = (override: Partial<RecoveryInput> = {}) => prepareAgentRestoreRecovery(f.profiles, { ...input, ...override }, f.identityOptions);
  function unchanged() {
    assert.deepEqual(captureLifecycleTree(f.directory), priorTree);
    assert.deepEqual(captureLifecycleTree(newer.directory), newerTree);
    assert.deepEqual(f.externalFiles(), effects); assert.deepEqual(f.counts(), counts);
    const inspected = f.profiles.inspect(f.directory);
    if (inspected.status !== 'ready') throw new Error('fixture_profile_not_ready');
    assert.deepEqual(inspectAgentHostIdentity(inspected, f.identityOptions), head);
    assert.equal(inspectAgentRestoreReconciliation(f.profiles, f.directory, f.identityOptions).status, 'required');
    assert.equal(existsSync(join(f.directory, AGENT_RESTORE_RECONCILIATION)), false);
    restored.unchangedOriginals();
  }
  return { ...f, old, newer, accepted, applied, oldStored, newerStored, paths, note, unresolved, input,
    priorTree, preservedEntries, newerTree, effects, countsBefore: counts, prepare, unchanged };
}
