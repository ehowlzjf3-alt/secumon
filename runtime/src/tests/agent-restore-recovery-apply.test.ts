import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs, { existsSync, fstatSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { AGENT_LOCAL_RESTORE_COMPLETION, AgentLocalRestoreMarkerSchema } from '../application/agent-lifecycle-contracts.js';
import { AGENT_RESTORE_RECONCILIATION } from '../application/agent-restore-reconciliation-contracts.js';
import { AGENT_RESTORE_RECOVERY_PENDING, type AgentRestoreRecoveryApplyProgress } from '../application/agent-restore-recovery-apply-contracts.js';
import { captureLifecycleTree } from '../infrastructure/agent-lifecycle-files.js';
import { inspectAgentHostIdentity } from '../infrastructure/agent-host-identities.js';
import { applyAgentRestoreRecovery } from '../infrastructure/agent-restore-recovery-apply.js';
import { inspectAgentRestoreRecovery } from '../infrastructure/agent-restore-recovery.js';
import { inspectAgentRestoreReconciliation, reconcileAgentRestore } from '../infrastructure/agent-restore-reconciliation.js';
import { restoreRecoveryFixture } from './agent-restore-recovery-fixture.js';

const different = (value: string) => value === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
const savedData = (path: string) => path !== AGENT_LOCAL_RESTORE_COMPLETION && path !== '.secumon/runtime-leases' &&
  !path.startsWith('.secumon/runtime-leases/') && path !== '.secumon/lifecycle-maintenance.json' &&
  !['.secumon/runtime.sqlite-shm', '.secumon/channel.sqlite-shm', 'memory/memory.sqlite-shm'].includes(path);
const completion = (directory: string) => AgentLocalRestoreMarkerSchema.parse(JSON.parse(readFileSync(join(directory, AGENT_LOCAL_RESTORE_COMPLETION), 'utf8')));
type Applied = Awaited<ReturnType<typeof applyAgentRestoreRecovery>>;

async function fixture(t: TestContext) {
  const f = await restoreRecoveryFixture(t), selected = f.prepare();
  const packageTree = captureLifecycleTree(selected.directory), oldArchiveTree = captureLifecycleTree(f.archive);
  const originalPreservedTree = captureLifecycleTree(f.preserved);
  const input = { recoveryDirectory: selected.directory, expectedDigest: selected.manifest.digest, offline: true };
  const retiredDirectory = join(dirname(f.directory), `.secumon-retired-${selected.manifest.operationId}`);
  const operationDirectory = `${selected.directory}.apply`;
  const apply = (onProgress?: (phase: AgentRestoreRecoveryApplyProgress) => void) =>
    applyAgentRestoreRecovery(f.profiles, input, f.identityOptions, onProgress ? { onProgress } : {});
  function originals() {
    assert.deepEqual(captureLifecycleTree(selected.directory), packageTree, 'applying never edits the immutable recovery package');
    assert.deepEqual(inspectAgentRestoreRecovery(selected.directory), selected);
    assert.deepEqual(captureLifecycleTree(f.newer.directory), f.newerTree);
    assert.deepEqual(captureLifecycleTree(f.archive), oldArchiveTree);
    assert.deepEqual(captureLifecycleTree(f.preserved), originalPreservedTree);
    assert.deepEqual(f.externalFiles(), f.effects);
  }
  function retired() {
    assert.equal(existsSync(join(retiredDirectory, AGENT_RESTORE_RECOVERY_PENDING)), true);
    assert.deepEqual(captureLifecycleTree(retiredDirectory, path => path !== AGENT_RESTORE_RECOVERY_PENDING), f.priorTree,
      'the old root retains every original; only the same-operation pending gate is added');
  }
  function restored(result: Applied) {
    assert.equal(result.operationId, selected.manifest.operationId); assert.equal(result.agentId, f.ready.identity.agentId);
    assert.equal(result.root, f.directory); assert.equal(result.retiredDirectory, retiredDirectory);
    assert.equal(result.operationDirectory, operationDirectory); assert.equal(result.stage, 'restored');
    assert.equal(result.reconciliationRequired, true);
    const marker = completion(f.directory);
    assert.equal(marker.restorationId, result.restorationId); assert.ok(marker.restorationId);
    assert.notEqual(marker.restorationId, selected.manifest.prior.restorationId);
    assert.equal(marker.backupDigest, f.newer.manifest.digest); assert.equal(marker.agentId, f.ready.identity.agentId);
    assert.equal(marker.originalRoot, f.directory);
    assert.deepEqual(captureLifecycleTree(f.directory, savedData), f.newer.manifest.entries,
      'all selected files, including DBs, raw artifacts, session originals and resource receipts, are restored unchanged');
    assert.deepEqual(f.stored(), f.newerStored);
    const profile = f.profiles.inspect(f.directory); assert.equal(profile.status, 'ready');
    if (profile.status !== 'ready') throw new Error('fixture_profile_not_ready');
    assert.equal(inspectAgentHostIdentity(profile, f.identityOptions)!.digest, result.identityHeadDigest);
    assert.notEqual(result.identityHeadDigest, selected.manifest.prior.identityHeadDigest);
    assert.equal(existsSync(join(f.directory, AGENT_RESTORE_RECOVERY_PENDING)), false);
    assert.equal(existsSync(join(f.directory, AGENT_RESTORE_RECONCILIATION)), false);
    assert.equal(inspectAgentRestoreReconciliation(f.profiles, f.directory, f.identityOptions).status, 'required');
    assert.deepEqual(f.counts(), f.countsBefore, 'apply and identity rebind do not run models, tools, delivery or external reconciliation');
    retired(); originals();
  }
  return { ...f, selected, packageTree, input, retiredDirectory, operationDirectory, apply, originals, retired, restored };
}

test('applying the newer full originals requires fresh reconciliation before the original work answers without repeating its external effect', { timeout: 60000 }, async t => {
  const f = await fixture(t), phases: AgentRestoreRecoveryApplyProgress[] = [];
  const applied = await f.apply(phase => phases.push(phase));
  assert.deepEqual(phases, ['original_preserved', 'restored', 'identity_rebound']); f.restored(applied);
  const restoredTree = captureLifecycleTree(f.directory), operationTree = captureLifecycleTree(f.operationDirectory);
  assert.deepEqual(await f.apply(), applied, 'a completed same-operation apply reuses its original occurrence and identity head');
  assert.deepEqual(captureLifecycleTree(f.directory), restoredTree);
  assert.deepEqual(captureLifecycleTree(f.operationDirectory), operationTree);
  await assert.rejects(f.open(), /agent_restore_reconciliation_required/);
  assert.deepEqual(captureLifecycleTree(f.directory), restoredTree); assert.deepEqual(f.counts(), f.countsBefore);

  const reconciled = await reconcileAgentRestore(f.profiles, { directory: f.directory, offline: true }, { ...f.identityOptions, sources: f.sources });
  assert.equal(reconciled.status, 'reconciled'); assert.equal(reconciled.basis.restorationId, applied.restorationId);
  assert.equal(reconciled.basis.identityHeadDigest, applied.identityHeadDigest);
  assert.notEqual(reconciled.basis.digest, f.unresolved.basis.digest);
  assert.equal(reconciled.reports[0]!.status, 'consistent'); assert.deepEqual(reconciled.reports[0]!.unresolved, []);
  assert.ok(f.counts().verifications > f.countsBefore.verifications);
  assert.deepEqual(f.stored(), f.newerStored, 'fresh clearance records no invented result, command or resource usage');
  assert.equal(f.counts().models, f.countsBefore.models); assert.equal(f.counts().writes, f.countsBefore.writes);
  assert.equal(f.counts().sends, f.countsBefore.sends);

  const opened = await f.open();
  assert.equal(opened.profile.agentId, f.ready.identity.agentId);
  assert.deepEqual(await opened.profile.runtime.state(f.accepted.workId), f.applied);
  const before = await opened.profile.sessions.history(opened.profile.actor, f.accepted.sessionId, opened.profile.policy, { limit: 100 });
  assert.equal(before.entries.filter(entry => entry.role === 'user').length, 1);
  const result = await opened.profile.workflow.run(f.accepted.workId, opened.profile.actor, { maxSteps: 12 });
  assert.equal(result.control.kind, 'complete', JSON.stringify(result.control));
  const done = await opened.profile.runtime.state(f.accepted.workId);
  assert.equal(done.status, 'completed'); assert.equal(done.conversation!.session!.scope.sessionId, f.accepted.sessionId);
  assert.deepEqual(done.attempts, f.applied.attempts); assert.deepEqual(done.evidence, f.applied.evidence);
  assert.equal(done.budget.used.toolCalls, 1); assert.equal(done.budget.used.modelCalls, 2);
  assert.equal(opened.host.observed.inputs.length, 1); assert.equal(opened.host.observed.writes, 0);
  const history = await opened.profile.sessions.history(opened.profile.actor, f.accepted.sessionId, opened.profile.policy, { limit: 100 });
  assert.equal(history.entries.filter(entry => entry.role === 'user').length, 1);
  assert.equal(history.entries.filter(entry => entry.kind === 'result').length, 1);
  for (const entry of before.entries) assert.ok(history.entries.some(current => JSON.stringify(current) === JSON.stringify(entry)));
  for (const row of f.newerStored.receipts) assert.ok(f.stored().receipts.some(current => JSON.stringify(current) === JSON.stringify(row)));
  await f.close(opened.profile);
  const counts = f.counts(), stored = f.stored(), replay = await f.open();
  assert.equal((await replay.profile.workflow.run(f.accepted.workId, replay.profile.actor, { maxSteps: 12 })).control.kind, 'complete');
  assert.equal(replay.host.observed.inputs.length, 0); assert.equal(replay.host.observed.writes, 0);
  await f.close(replay.profile);
  assert.equal(f.counts().models, counts.models); assert.equal(f.counts().writes, 1); assert.equal(f.counts().sends, counts.sends);
  assert.deepEqual(f.stored().messages, stored.messages); f.retired(); f.originals();
});

for (const cut of ['original_preserved', 'restored', 'identity_rebound'] as const) test(`same-operation apply resumes after an injected ${cut} callback failure without replacing originals or executing work`, { timeout: 60000 }, async t => {
  const f = await fixture(t), stop = new Error(`fixture_apply_cut:${cut}`), phases: AgentRestoreRecoveryApplyProgress[] = [];
  // This exercises a real persisted boundary followed by an exception, not a process crash or power-loss claim.
  await assert.rejects(f.apply(phase => { phases.push(phase); if (phase === cut) throw stop; }), error => error === stop);
  assert.equal(phases.filter(phase => phase === cut).length, 1); assert.equal(phases.at(-1), cut);
  assert.equal(existsSync(join(f.operationDirectory, 'complete.json')), false);
  const intent = readFileSync(join(f.operationDirectory, 'intent.json'));
  const retired = captureLifecycleTree(f.retiredDirectory);
  const marker = cut === 'original_preserved' ? undefined : readFileSync(join(f.directory, AGENT_LOCAL_RESTORE_COMPLETION));
  const profile = cut === 'identity_rebound' ? f.profiles.inspect(f.directory) : undefined;
  const head = profile?.status === 'ready' ? inspectAgentHostIdentity(profile, f.identityOptions) : undefined;
  if (cut === 'original_preserved') assert.equal(existsSync(f.directory), false);
  else {
    assert.deepEqual(f.stored(), f.newerStored);
    await assert.rejects(f.open(), cut === 'restored' ? /agent_host_identity_duplicate_identity/ : /agent_restore_reconciliation_required/);
  }
  assert.deepEqual(f.counts(), f.countsBefore); f.retired(); f.originals();
  const resumed = await f.apply(); f.restored(resumed);
  assert.deepEqual(readFileSync(join(f.operationDirectory, 'intent.json')), intent);
  assert.deepEqual(captureLifecycleTree(f.retiredDirectory), retired);
  if (marker) assert.deepEqual(readFileSync(join(f.directory, AGENT_LOCAL_RESTORE_COMPLETION)), marker);
  if (head) assert.equal(resumed.identityHeadDigest, head.digest);
  const currentTree = captureLifecycleTree(f.directory), operationTree = captureLifecycleTree(f.operationDirectory);
  assert.deepEqual(await f.apply(), resumed);
  assert.deepEqual(captureLifecycleTree(f.directory), currentTree); assert.deepEqual(captureLifecycleTree(f.operationDirectory), operationTree);
  await assert.rejects(f.open(), /agent_restore_reconciliation_required/);
  assert.deepEqual(f.counts(), f.countsBefore); f.originals();
});

test('apply refuses missing offline confirmation or a different package digest before publishing an operation', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(applyAgentRestoreRecovery(f.profiles, { ...f.input, offline: false }, f.identityOptions), /lifecycle_offline_confirmation_required/);
  await assert.rejects(applyAgentRestoreRecovery(f.profiles, { ...f.input, expectedDigest: different(f.input.expectedDigest) }, f.identityOptions), /agent_restore_recovery_application_binding_mismatch/);
  assert.equal(existsSync(f.operationDirectory), false); assert.equal(existsSync(f.retiredDirectory), false);
  f.unchanged(); f.originals();
});

test('a prepared package cannot retire current originals changed after preparation', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  writeFileSync(f.note, 'later original must remain in place\n', { mode: 0o600 });
  const changed = captureLifecycleTree(f.directory);
  await assert.rejects(f.apply(), /agent_restore_recovery_original_changed/);
  assert.deepEqual(captureLifecycleTree(f.directory), changed);
  assert.equal(existsSync(f.operationDirectory), false); assert.equal(existsSync(f.retiredDirectory), false);
  assert.equal(existsSync(join(f.directory, AGENT_RESTORE_RECOVERY_PENDING)), false);
  assert.deepEqual(f.counts(), f.countsBefore); f.originals();
});

test('unrelated occupied retirement and operation directories are preserved and never adopted for apply', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  mkdirSync(f.retiredDirectory, { mode: 0o700 }); writeFileSync(join(f.retiredDirectory, 'keep.txt'), 'unrelated retired tree\n', { mode: 0o600 });
  const occupiedRetired = captureLifecycleTree(f.retiredDirectory);
  await assert.rejects(f.apply(), /host_directory_retirement_destination_exists/);
  assert.deepEqual(captureLifecycleTree(f.retiredDirectory), occupiedRetired); assert.equal(existsSync(f.operationDirectory), false);
  const other = f.prepare({ destination: join(f.base, 'other-recovery'), operationId: randomUUID() });
  const operationDirectory = `${other.directory}.apply`;
  mkdirSync(operationDirectory, { mode: 0o700 }); writeFileSync(join(operationDirectory, 'keep.txt'), 'unrelated operation\n', { mode: 0o600 });
  const occupiedOperation = captureLifecycleTree(operationDirectory);
  await assert.rejects(applyAgentRestoreRecovery(f.profiles, { recoveryDirectory: other.directory, expectedDigest: other.manifest.digest, offline: true }, f.identityOptions), /agent_restore_recovery_application_intent_missing/);
  assert.deepEqual(captureLifecycleTree(operationDirectory), occupiedOperation);
  f.unchanged(); f.originals();
});

test('same-operation apply preserves a real partially copied file and restores from the untouched archive into a fresh root', {
  timeout: 60000, skip: process.platform === 'win32' ? 'POSIX writeSync copy-failure seam; native Windows recovery has a separate implementation' : false,
}, async t => {
  const f = await fixture(t), stop = new Error('fixture_partial_restore_write');
  const entry = f.newer.manifest.entries.find(item => item.kind === 'file' && item.bytes > 1);
  assert.ok(entry?.kind === 'file');
  const partialPath = join(f.directory, entry.path), originalWrite = fs.writeSync;
  const source = readFileSync(join(f.selected.directory, 'selected-backup', 'data', entry.path));
  let installed = false, writes = 0, partialBytes = 0;
  try {
    await assert.rejects(f.apply(phase => {
      if (phase !== 'original_preserved' || installed) return;
      installed = true;
      fs.writeSync = ((fd: number, value: string | NodeJS.ArrayBufferView, ...args: unknown[]) => {
        if (!writes && ArrayBuffer.isView(value) && typeof args[0] === 'number' && typeof args[1] === 'number' && args[1] > 1 && existsSync(partialPath)) {
          const opened = fstatSync(fd), named = lstatSync(partialPath);
          if (opened.ino === named.ino && opened.dev === named.dev) {
            const count = Math.min(7, args[1] - 1);
            partialBytes = originalWrite(fd, value, args[0], count); writes++;
            throw stop;
          }
        }
        return Reflect.apply(originalWrite, fs, [fd, value, ...args]);
      }) as typeof fs.writeSync;
      syncBuiltinESMExports();
    }), error => error === stop);
  } finally { fs.writeSync = originalWrite; syncBuiltinESMExports(); }
  assert.equal(installed, true); assert.equal(writes, 1); assert.ok(partialBytes > 0 && partialBytes < source.length);
  assert.deepEqual(readFileSync(partialPath), source.subarray(0, partialBytes));
  const pending = JSON.parse(readFileSync(join(f.directory, '.secumon-restore-in-progress.json'), 'utf8'));
  assert.equal(pending.agentId, f.ready.identity.agentId); assert.equal(pending.backupDigest, f.newer.manifest.digest);
  assert.equal(typeof pending.restorationId, 'string');
  assert.equal(existsSync(join(f.directory, AGENT_LOCAL_RESTORE_COMPLETION)), false);
  assert.equal(existsSync(join(f.operationDirectory, 'complete.json')), false);
  const partial = captureLifecycleTree(f.directory), intent = readFileSync(join(f.operationDirectory, 'intent.json'));
  const preserved = captureLifecycleTree(f.retiredDirectory);
  const result = await f.apply(); f.restored(result);
  assert.notEqual(result.restorationId, pending.restorationId);
  const partialDirectory = join(dirname(f.directory), `.secumon-partial-${result.operationId}-${pending.restorationId}`);
  assert.deepEqual(captureLifecycleTree(partialDirectory), partial, 'failed copied bytes and their original pending occurrence remain inspectable');
  assert.deepEqual(captureLifecycleTree(f.retiredDirectory), preserved);
  assert.deepEqual(readFileSync(join(f.operationDirectory, 'intent.json')), intent);
  assert.deepEqual(readFileSync(join(f.directory, entry.path)), source);
  await assert.rejects(f.open(), /agent_restore_reconciliation_required/);
  assert.deepEqual(f.counts(), f.countsBefore); f.originals();
});
