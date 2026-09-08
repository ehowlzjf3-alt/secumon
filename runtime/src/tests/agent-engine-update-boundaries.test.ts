import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { backupAgent, checkAgentLifecycle, inspectAgentBackup, pinAgentEngine } from '../infrastructure/agent-lifecycle.js';
import { captureLifecycleTree, lifecycleDigest } from '../infrastructure/agent-lifecycle-files.js';
import { readAgentEnginePin } from '../infrastructure/agent-engine-release.js';
import { openHostSqliteDatabase } from '../infrastructure/windows-sqlite.js';
import { createEngineUpdateReleases } from './helpers/agent-engine-update-releases.js';

let installedRoot: string | undefined, installed: ReturnType<typeof createEngineUpdateReleases> | undefined;
before(() => {
  if (process.platform === 'win32') return;
  installedRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agent-engine-shared-')));
  installed = createEngineUpdateReleases(installedRoot);
}, { timeout: 180000 });
after(() => { if (installedRoot) rmSync(installedRoot, { recursive: true, force: true }); });

function checkpointedData(entries: ReturnType<typeof captureLifecycleTree>) {
  const databases = ['.secumon/runtime.sqlite', '.secumon/channel.sqlite', 'memory/memory.sqlite'];
  return entries.filter(entry => {
    // SQLite read-only owner/schema inspection can create coordination files. Never ignore a populated WAL.
    if (databases.some(path => entry.path === path + '-shm')) {
      assert.equal(entry.kind, 'file'); assert.ok(entry.kind === 'file');
      assert.equal(entry.bytes, 32768); assert.equal(entry.executable, false); return false;
    }
    if (databases.some(path => entry.path === path + '-wal') && entry.kind === 'file' && entry.bytes === 0) {
      assert.equal(entry.executable, false); return false;
    }
    return true;
  });
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`engine update ${backend}: backup and runtime boundaries preserve data, and rollback changes only the engine pin`,
    { timeout: 180000, skip: process.platform === 'win32' ? 'POSIX release fixture; native Windows acceptance is separate.' : false }, async t => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-engine-boundaries-'))), active = new Set<Awaited<ReturnType<typeof openAgentStores>>>();
      t.after(async () => {
        try { for (const store of active) await store.close(); }
        finally { rmSync(base, { recursive: true, force: true }); }
      });
      const releases = installed; assert.ok(releases);
      const root = join(base, 'agent'), registry = join(base, 'host-identities');
      const profileOptions = { engineRegistryDirectory: join(base, 'engine-registry') };
      const profiles = new FileAgentProfileStore(releases.a.directory, profileOptions);
      const profile = profiles.initialize(root, { stateBackend: backend, personalMemory: backend === 'file-journal' ? 'documents' : 'sqlite' });
      async function open(directory = root, selected = profiles) {
        const store = await openAgentStores(selected, directory, undefined, { identityRegistryDirectory: registry }); active.add(store); return store;
      }
      async function close(store: Awaited<ReturnType<typeof open>>) { await store.close(); active.delete(store); }
      await close(await open());
      const automatic = readAgentEnginePin(root); assert.ok(automatic); assert.equal(automatic.releaseDigest, releases.a.release.digest);
      const first = pinAgentEngine(profiles, root, releases.a.directory, { offline: true, expectedPrevious: automatic.releaseDigest });
      assert.equal(first.applied, false); assert.equal(first.pin.sequence, 1); assert.deepEqual(first.pin, automatic);
      const originalPin = readAgentEnginePin(root), initialTree = captureLifecycleTree(root), registryTree = captureLifecycleTree(registry);
      const target = releases.b.directory, previous = releases.a.release.digest;
      const unchanged = (tree = initialTree) => {
        assert.deepEqual(captureLifecycleTree(root), tree);
        assert.deepEqual(readAgentEnginePin(root), originalPin);
        assert.deepEqual(captureLifecycleTree(registry), registryTree);
        assert.equal(existsSync(join(root, '.secumon', 'lifecycle-maintenance.json')), false);
      };
      assert.throws(() => pinAgentEngine(profiles, root, target, { offline: false, expectedPrevious: previous }), /lifecycle_offline_confirmation_required/);
      unchanged();
      assert.throws(() => pinAgentEngine(profiles, root, target, { offline: true, expectedPrevious: previous }), /engine_update_backup_required/);
      unchanged();

      const old = backupAgent(profiles, root, join(base, 'old-backup'), true), oldTree = captureLifecycleTree(old.directory);
      const note = '사용자가 백업 이후 추가한 자료입니다. 버전 되돌리기는 이 자료를 지우지 않습니다.\n';
      writeFileSync(join(root, 'after-backup.txt'), note, { mode: 0o600 });
      const changedTree = captureLifecycleTree(root);
      assert.throws(() => pinAgentEngine(profiles, root, target, { offline: true, expectedPrevious: previous, backup: old.directory }), /engine_update_backup_stale/);
      unchanged(changedTree); assert.deepEqual(captureLifecycleTree(old.directory), oldTree);

      const otherRoot = join(base, 'other-agent'); profiles.initialize(otherRoot, { stateBackend: backend });
      await close(await open(otherRoot));
      const otherPin = readAgentEnginePin(otherRoot); assert.ok(otherPin); assert.equal(otherPin.releaseDigest, releases.a.release.digest);
      const foreign = backupAgent(profiles, otherRoot, join(base, 'foreign-backup'), true);
      const updatedRegistry = captureLifecycleTree(registry), beforeForeign = captureLifecycleTree(root);
      assert.throws(() => pinAgentEngine(profiles, root, target, { offline: true, expectedPrevious: previous, backup: foreign.directory }), /engine_update_backup_stale/);
      assert.deepEqual(captureLifecycleTree(root), beforeForeign); assert.deepEqual(readAgentEnginePin(root), originalPin);
      assert.deepEqual(captureLifecycleTree(registry), updatedRegistry);

      const live = await open(), liveTree = captureLifecycleTree(root);
      try {
        assert.throws(() => backupAgent(profiles, root, join(base, 'live-backup'), true), /agent_runtime_active/);
        assert.equal(existsSync(join(base, 'live-backup')), false);
        assert.throws(() => pinAgentEngine(profiles, root, target, { offline: true, expectedPrevious: previous, backup: old.directory }), /agent_runtime_active/);
        assert.deepEqual(captureLifecycleTree(root), liveTree); assert.deepEqual(readAgentEnginePin(root), originalPin);
      } finally { await close(live); }

      // Change a real owned schema version, without forging a release compatibility declaration.
      const database = openHostSqliteDatabase(profile.paths.memory), version = database.prepare('SELECT version FROM knowledge_schema').get()!['version'];
      assert.ok(typeof version === 'number'); database.exec('UPDATE knowledge_schema SET version=999'); database.close();
      const incompatibleTree = captureLifecycleTree(root);
      try {
        assert.throws(() => checkAgentLifecycle(profiles, root, target), /engine_storage_incompatible/);
        assert.deepEqual(checkpointedData(captureLifecycleTree(root)), checkpointedData(incompatibleTree));
        assert.deepEqual(readAgentEnginePin(root), originalPin);
      } finally {
        const restore = openHostSqliteDatabase(profile.paths.memory);
        try { restore.prepare('UPDATE knowledge_schema SET version=?').run(version); } finally { restore.close(); }
      }

      const changedFile = join(target, 'dist/infrastructure/synthetic-agent-turn.js'), originalBytes = readFileSync(changedFile);
      writeFileSync(changedFile, Buffer.concat([originalBytes, Buffer.from('\n// Fixture corruption after the release was installed.\n')]));
      const beforeCorruption = captureLifecycleTree(root);
      try {
        assert.throws(() => checkAgentLifecycle(profiles, root, target), /engine_release_files_changed/);
        assert.deepEqual(captureLifecycleTree(root), beforeCorruption); assert.deepEqual(readAgentEnginePin(root), originalPin);
      } finally { writeFileSync(changedFile, originalBytes); }

      const dataTree = () => checkpointedData(captureLifecycleTree(root, path => path !== '.secumon/engine-pins' && !path.startsWith('.secumon/engine-pins/')));
      const beforeUpdate = dataTree(), fresh = backupAgent(profiles, root, join(base, 'fresh-backup'), true);
      assert.equal(inspectAgentBackup(fresh.directory).manifest.digest, fresh.manifest.digest);
      const updated = pinAgentEngine(profiles, root, target, { offline: true, expectedPrevious: previous, backup: fresh.directory });
      assert.equal(updated.applied, true); assert.equal(updated.pin.sequence, 2);
      assert.equal(updated.pin.previous, lifecycleDigest(originalPin)); assert.equal(updated.pin.backupDigest, fresh.manifest.digest);
      assert.equal(updated.pin.agentId, profile.identity.agentId); assert.equal(updated.pin.releaseDigest, releases.b.release.digest);
      assert.deepEqual(dataTree(), beforeUpdate);
      await assert.rejects(open(), /agent_engine_update_required/);
      await close(await open(root, new FileAgentProfileStore(target, profileOptions)));

      // Rollback selects the old engine using a fresh backup of current data; it does not restore old data.
      const beforeRollback = dataTree(), rollbackBackup = backupAgent(new FileAgentProfileStore(target, profileOptions), root, join(base, 'rollback-backup'), true);
      const rolledBack = pinAgentEngine(new FileAgentProfileStore(target, profileOptions), root, releases.a.directory,
        { offline: true, expectedPrevious: releases.b.release.digest, backup: rollbackBackup.directory });
      assert.equal(rolledBack.applied, true); assert.equal(rolledBack.pin.sequence, 3);
      assert.equal(rolledBack.pin.previous, lifecycleDigest(updated.pin)); assert.equal(rolledBack.pin.backupDigest, rollbackBackup.manifest.digest);
      assert.equal(rolledBack.pin.releaseDigest, previous); assert.deepEqual(dataTree(), beforeRollback);
      assert.equal(readFileSync(join(root, 'after-backup.txt'), 'utf8'), note);
      await close(await open());
      assert.deepEqual(captureLifecycleTree(old.directory), oldTree);
      assert.deepEqual(captureLifecycleTree(registry), updatedRegistry);
    });
}
