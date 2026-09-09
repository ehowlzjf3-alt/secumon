import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { AGENT_LOCAL_RESTORE_COMPLETION, AgentLocalRestoreMarkerSchema } from '../application/agent-lifecycle-contracts.js';
import { AGENT_RESTORE_RECOVERY_PENDING, type AgentRestoreRecoveryPreparationProgress } from '../application/agent-restore-recovery-apply-contracts.js';
import { applyAgentRestoreRecovery } from '../infrastructure/agent-restore-recovery-apply.js';
import { captureLifecycleTree } from '../infrastructure/agent-lifecycle-files.js';
import { restoreRecoveryFixture } from './agent-restore-recovery-fixture.js';

const restorePending = '.secumon-restore-in-progress.json';
const original = (path: string) => path !== AGENT_RESTORE_RECOVERY_PENDING && path !== '.secumon/runtime-leases' &&
  !path.startsWith('.secumon/runtime-leases/') && path !== '.secumon/lifecycle-maintenance.json';
async function fixture(t: TestContext) {
  const f = await restoreRecoveryFixture(t), selected = f.prepare();
  const packageTree = captureLifecycleTree(selected.directory), oldTree = captureLifecycleTree(f.archive);
  const preservedTree = captureLifecycleTree(f.preserved), operationDirectory = `${selected.directory}.apply`;
  const retiredDirectory = join(dirname(f.directory), `.secumon-retired-${selected.manifest.operationId}`);
  const input = { recoveryDirectory: selected.directory, expectedDigest: selected.manifest.digest, offline: true };
  const apply = (onPreparation?: (phase: AgentRestoreRecoveryPreparationProgress) => void) =>
    applyAgentRestoreRecovery(f.profiles, input, f.identityOptions, onPreparation ? { onPreparation } : {});
  function originals() {
    assert.deepEqual(captureLifecycleTree(selected.directory), packageTree);
    assert.deepEqual(captureLifecycleTree(f.newer.directory), f.newerTree);
    assert.deepEqual(captureLifecycleTree(f.archive), oldTree);
    assert.deepEqual(captureLifecycleTree(f.preserved), preservedTree);
    assert.deepEqual(f.externalFiles(), f.effects); assert.deepEqual(f.counts(), f.countsBefore);
  }
  async function finish() {
    const result = await apply(), marker = AgentLocalRestoreMarkerSchema.parse(JSON.parse(readFileSync(join(f.directory, AGENT_LOCAL_RESTORE_COMPLETION), 'utf8')));
    assert.equal(result.operationId, selected.manifest.operationId); assert.equal(result.stage, 'restored');
    assert.equal(result.reconciliationRequired, true); assert.equal(marker.restorationId, result.restorationId);
    assert.equal(marker.backupDigest, f.newer.manifest.digest);
    assert.deepEqual(captureLifecycleTree(retiredDirectory, original), f.preservedEntries);
    assert.deepEqual(f.stored(), f.newerStored);
    const receipt = readFileSync(join(operationDirectory, 'complete.json'));
    assert.deepEqual(await apply(), result); assert.deepEqual(readFileSync(join(operationDirectory, 'complete.json')), receipt);
    await assert.rejects(f.open(), /agent_restore_reconciliation_required/); originals(); return result;
  }
  return { ...f, selected, operationDirectory, retiredDirectory, apply, originals, finish };
}
const options = { timeout: 60000 };

test('initial apply resumes across intent staging and publication while retaining an unclaimed staging directory', options, async t => {
  const f = await fixture(t), cut = new Error('fixture_initial_intent_cut');
  // These are exceptions after real filesystem boundaries, not SIGKILL or power-loss observations.
  await assert.rejects(f.apply(phase => { if (phase === 'intent_directory_created') throw cut; }), error => error === cut);
  assert.equal(existsSync(f.operationDirectory), false); f.unchanged();
  const names = readdirSync(f.base).filter(name => name.startsWith('recovery.apply.staging-'));
  assert.equal(names.length, 1);
  const abandoned = join(f.base, names[0]!), before = lstatSync(abandoned);
  writeFileSync(join(abandoned, 'keep.txt'), 'unclaimed original staging content\n', { mode: 0o600 });
  const abandonedTree = captureLifecycleTree(abandoned);
  await assert.rejects(f.apply(phase => { if (phase === 'intent_published') throw cut; }), error => error === cut);
  assert.equal(existsSync(join(f.operationDirectory, 'intent.json')), true);
  assert.equal(existsSync(join(f.operationDirectory, 'gate-publication.json')), true);
  const intent = readFileSync(join(f.operationDirectory, 'intent.json'));
  assert.deepEqual(captureLifecycleTree(abandoned), abandonedTree); assert.equal(lstatSync(abandoned).ino, before.ino);
  f.unchanged(); await f.finish();
  assert.deepEqual(readFileSync(join(f.operationDirectory, 'intent.json')), intent);
  assert.deepEqual(captureLifecycleTree(abandoned), abandonedTree);
});

test('initial apply resumes the exact original gate after a real POSIX link and an injected publication exception', {
  ...options, skip: process.platform === 'win32' ? 'POSIX link-before-unlink seam; Windows uses native no-replace rename' : false,
}, async t => {
  const f = await fixture(t), stop = new Error('fixture_initial_gate_link_cut'), link = fs.linkSync;
  const staged = join(f.operationDirectory, 'original-gate.json'), target = join(f.directory, AGENT_RESTORE_RECOVERY_PENDING);
  let links = 0;
  try {
    fs.linkSync = ((source, destination) => {
      link(source, destination);
      if (String(source) === staged && String(destination) === target) { links++; throw stop; }
    }) as typeof fs.linkSync;
    syncBuiltinESMExports();
    await assert.rejects(f.apply(), error => error === stop);
  } finally { fs.linkSync = link; syncBuiltinESMExports(); }
  assert.equal(links, 1); assert.equal(lstatSync(target).nlink, 2);
  assert.equal(lstatSync(staged).ino, lstatSync(target).ino);
  const bytes = readFileSync(target), inode = lstatSync(target).ino;
  assert.deepEqual(captureLifecycleTree(f.directory, original), f.preservedEntries);
  assert.equal(existsSync(f.retiredDirectory), false); f.originals();
  await f.finish();
  assert.equal(existsSync(staged), false);
  const retained = join(f.retiredDirectory, AGENT_RESTORE_RECOVERY_PENDING);
  assert.equal(lstatSync(retained).ino, inode); assert.equal(lstatSync(retained).nlink, 1);
  assert.deepEqual(readFileSync(retained), bytes);
});

test('initial apply retains pre-nonce seeds and resumes the published exact seed with its original restoration nonce', options, async t => {
  const f = await fixture(t), stop = new Error('fixture_initial_restore_seed_cut');
  const prefix = `.secumon-restore-seed-${f.selected.manifest.operationId}-`;
  const orphanTrees = new Map<string, ReturnType<typeof captureLifecycleTree>>();
  for (const cut of ['restore_directory_created', 'restore_seeded', 'restore_published'] as const) {
    let observed = 0;
    await assert.rejects(f.apply(phase => { if (phase === cut) { observed++; throw stop; } }), error => error === stop);
    assert.equal(observed, 1);
    if (cut !== 'restore_published') {
      assert.equal(existsSync(f.directory), false);
      const names = readdirSync(dirname(f.directory)).filter(name => name.startsWith(prefix));
      assert.equal(names.length, cut === 'restore_directory_created' ? 1 : 2);
      for (const name of names) {
        const path = join(dirname(f.directory), name);
        if (!orphanTrees.has(path)) orphanTrees.set(path, captureLifecycleTree(path));
      }
    }
    for (const [path, tree] of orphanTrees) assert.deepEqual(captureLifecycleTree(path), tree);
    f.originals();
  }
  assert.deepEqual(readdirSync(f.directory), [restorePending]);
  const bytes = readFileSync(join(f.directory, restorePending)), marker = JSON.parse(bytes.toString('utf8'));
  const rootIdentity = lstatSync(f.directory), seedRecord = readFileSync(join(f.operationDirectory, `restore-seed-${marker.restorationId}.json`));
  const result = await f.finish();
  assert.equal(result.restorationId, marker.restorationId); assert.equal(lstatSync(f.directory).ino, rootIdentity.ino);
  assert.deepEqual(readFileSync(join(f.operationDirectory, `restore-seed-${marker.restorationId}.json`)), seedRecord);
  for (const [path, tree] of orphanTrees) assert.deepEqual(captureLifecycleTree(path), tree);
  assert.equal(readdirSync(dirname(f.directory)).some(name => name.startsWith(`.secumon-partial-${result.operationId}-`)), false);
});

test('initial apply refuses an unrelated replacement root with no marker or copied seed bytes without changing either object', options, async t => {
  const f = await fixture(t), stop = new Error('fixture_seed_identity_cut');
  await assert.rejects(f.apply(phase => { if (phase === 'restore_published') throw stop; }), error => error === stop);
  const retainedSeed = join(f.base, 'retained-seed'); renameSync(f.directory, retainedSeed);
  const seedTree = captureLifecycleTree(retainedSeed), intent = readFileSync(join(f.operationDirectory, 'intent.json'));
  mkdirSync(f.directory, { mode: 0o700 }); writeFileSync(join(f.directory, 'keep.txt'), 'unrelated root\n', { mode: 0o600 });
  const unrelated = captureLifecycleTree(f.directory), inode = lstatSync(f.directory).ino;
  await assert.rejects(f.apply(), /lifecycle_restore_destination_exists/);
  assert.deepEqual(captureLifecycleTree(f.directory), unrelated);
  copyFileSync(join(retainedSeed, restorePending), join(f.directory, restorePending));
  const copiedMarkerTree = captureLifecycleTree(f.directory);
  await assert.rejects(f.apply(), /agent_restore_recovery_application_binding_mismatch/);
  assert.equal(lstatSync(f.directory).ino, inode); assert.deepEqual(captureLifecycleTree(f.directory), copiedMarkerTree);
  assert.deepEqual(captureLifecycleTree(retainedSeed), seedTree);
  assert.deepEqual(readFileSync(join(f.operationDirectory, 'intent.json')), intent);
  assert.equal(existsSync(join(f.operationDirectory, 'complete.json')), false); f.originals();
});

test('initial apply refuses same-byte replacement of the recorded gate object and retains the original gate', options, async t => {
  const f = await fixture(t), stop = new Error('fixture_gate_identity_cut');
  await assert.rejects(f.apply(phase => { if (phase === 'intent_published') throw stop; }), error => error === stop);
  const source = join(f.operationDirectory, 'original-gate.json'), retained = join(f.operationDirectory, 'retained-original-gate.json');
  const bytes = readFileSync(source); renameSync(source, retained); copyFileSync(retained, source);
  const originalIdentity = lstatSync(retained), replacementIdentity = lstatSync(source);
  assert.notEqual(originalIdentity.ino, replacementIdentity.ino);
  await assert.rejects(f.apply(), /agent_restore_recovery_gate_changed/);
  assert.deepEqual(readFileSync(source), bytes); assert.deepEqual(readFileSync(retained), bytes);
  assert.equal(lstatSync(source).ino, replacementIdentity.ino); assert.equal(lstatSync(retained).ino, originalIdentity.ino);
  assert.equal(existsSync(join(f.directory, AGENT_RESTORE_RECOVERY_PENDING)), false);
  assert.equal(existsSync(f.retiredDirectory), false);
  assert.deepEqual(captureLifecycleTree(f.directory, original), f.preservedEntries); f.originals();
});
