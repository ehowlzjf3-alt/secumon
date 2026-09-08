import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreRecoveryFixture } from '../dist/tests/agent-restore-recovery-fixture.js';
import { applyAgentRestoreRecovery } from '../dist/infrastructure/agent-restore-recovery-apply.js';
import { reconcileAgentRestore } from '../dist/infrastructure/agent-restore-reconciliation.js';
import { captureLifecycleTree } from '../dist/infrastructure/agent-lifecycle-files.js';
import { assertAgentRuntimeAvailable, acquireAgentRuntimeLease } from '../dist/infrastructure/agent-lifecycle-lease.js';
import { AGENT_LOCAL_RESTORE_COMPLETION } from '../dist/application/agent-lifecycle-contracts.js';
for (const phase of ['original_preserved', 'restored', 'identity_rebound']) test('actual SIGKILL and same-operation recovery after ' + phase,
  { timeout: 60000, skip: process.platform === 'win32' ? 'POSIX signal fixture; native Windows termination not run' : false }, async t => {
    const f = await restoreRecoveryFixture(t), prepared = f.prepare(), before = f.counts();
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./C10-restore-recovery-apply-crash-worker.mjs', import.meta.url)),
      prepared.directory, prepared.manifest.digest, f.identityOptions.registryDirectory, phase], { encoding: 'utf8', timeout: 30000 });
    assert.equal(child.error, undefined); assert.equal(child.status, null, child.stderr); assert.equal(child.signal, 'SIGKILL', child.stderr);
    const operationDirectory = prepared.directory + '.apply';
    assert.equal(existsSync(join(operationDirectory, '.secumon/lifecycle-maintenance.json')), true);
    assert.equal(existsSync(join(operationDirectory, 'complete.json')), false);
    const intent = readFileSync(join(operationDirectory, 'intent.json'));
    const marker = phase === 'original_preserved' ? null : readFileSync(join(f.directory, AGENT_LOCAL_RESTORE_COMPLETION));
    const applied = await applyAgentRestoreRecovery(f.profiles, { recoveryDirectory: prepared.directory, expectedDigest: prepared.manifest.digest, offline: true }, f.identityOptions);
    assert.equal(applied.stage, 'restored'); assert.equal(existsSync(join(operationDirectory, '.secumon/lifecycle-maintenance.json')), false);
    assert.deepEqual(readFileSync(join(operationDirectory, 'intent.json')), intent);
    if (marker) assert.deepEqual(readFileSync(join(f.directory, AGENT_LOCAL_RESTORE_COMPLETION)), marker);
    assert.deepEqual(captureLifecycleTree(applied.retiredDirectory, path => path !== '.secumon-restore-recovery-pending.json'), f.priorTree);
    assert.throws(() => assertAgentRuntimeAvailable(applied.retiredDirectory), /agent_restore_recovery_apply_required/);
    assert.throws(() => acquireAgentRuntimeLease(applied.retiredDirectory), /agent_restore_recovery_apply_required/);
    assert.deepEqual(f.stored(), f.newerStored); assert.deepEqual(f.counts(), before);
    await assert.rejects(f.open(), /agent_restore_reconciliation_required/);
    const reconciled = await reconcileAgentRestore(f.profiles, { directory: f.directory, offline: true }, { ...f.identityOptions, sources: f.sources });
    assert.equal(reconciled.status, 'reconciled'); assert.equal(reconciled.basis.restorationId, applied.restorationId);
    const reopened = await f.open(); assert.deepEqual(await reopened.profile.runtime.state(f.accepted.workId), f.applied);
    await f.close(reopened.profile); assert.equal(f.counts().models, before.models); assert.equal(f.counts().writes, before.writes);
    assert.deepEqual(f.externalFiles(), f.effects);
  });
