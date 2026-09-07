import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, readFileSync, existsSync, renameSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { bindAgentMemoryProfile } from '../infrastructure/agent-memory-profile.js';
import { openAgentLocalProfile, runtimeRoot } from '../presentation/local-profile.js';
import { LocalWorkbench } from '../presentation/local-workbench.js';
import { startWebServer } from '../presentation/web-server.js';
import { previewPersonalMemoryMigration, applyPersonalMemoryMigration, resumePersonalMemoryMigration } from '../infrastructure/personal-memory-migration.js';
import { migrationActivationPath, migrationOperationPath } from '../infrastructure/personal-memory-migration-profile.js';
import { readSqlitePersonalMemoryFence } from '../infrastructure/sqlite-personal-memory-migration.js';
import type { PersonalMemoryMigrationOptions } from '../application/personal-memory-migration-contracts.js';

const execute = promisify(execFile), cli = fileURLToPath(new URL('../presentation/agent-cli.js', import.meta.url));
const actor = { tenantId: 'synthetic', principalId: 'learner' }, original = '[합성 예제] 원문 보존. ' + '이관 전부터 이어 온 대화와 개인 기억. '.repeat(100);
async function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'personal-memory-migration-flow-'))), directory = join(base, 'agent');
  const profiles = new FileAgentProfileStore(runtimeRoot); let local = await openAgentLocalProfile(directory, { compactProvider: 'synthetic' });
  const workbench = new LocalWorkbench(local, actor);
  const accepted = await workbench.accept({ requestId: 'original-input', scenarioId: 'documents-simple', mode: 'auto', rawText: original });
  assert.ok(accepted.sessionId);
  const remember = { id: 'memory', requestId: 'remember', title: '이어갈 기억', source: { kind: 'existing' as const,
    sessionId: accepted.sessionId, messageId: 'original-input', quote: original } };
  const saved = await workbench.memoryRemember(remember);
  await workbench.input(accepted.workId, { requestId: 'tail-before-migration', expectedGoalRevision: 1, rawText: '[합성 예제] 원문 보존. ' + '계속 보존할 최신 문맥. '.repeat(200) });
  const compacted = await workbench.compact(accepted.workId, { requestId: 'compact-before-migration', expectedGoalRevision: 1 });
  if (compacted.status.stage !== 'ready' || !compacted.status.summary) {
    await local.close(); rmSync(base, { recursive: true, force: true });
    assert.fail(JSON.stringify(compacted.status));
  }
  const state = await local.runtime.state(accepted.workId), history = await workbench.history();
  await local.close();
  const before = profiles.inspect(directory); assert.equal(before.status, 'ready'); if (before.status !== 'ready') throw new Error('fixture');
  const options: PersonalMemoryMigrationOptions = { directory, source: before.paths.memory, target: join(directory, 'memory', 'documents'),
    operationId: randomUUID(), targetStoreId: randomUUID(), backupDirectory: join(base, 'backup'), from: 'sqlite', to: 'documents', scope: 'all-personal' };
  const preserved = ['config.json', '.secumon/identity.json', '.secumon/setup.json', '.secumon/setup-operation.json',
    '.secumon/personal-memory-profile.json', '.secumon/channel.sqlite', '.secumon/runtime.sqlite'].map(path => ({ path, bytes: readFileSync(join(directory, path)) }));
  return { base, directory, profiles, options, before, accepted, remember, saved, state, history, preserved,
    async reopen() { local = await openAgentLocalProfile(directory, { compactProvider: 'synthetic' }); return local; },
    async close() { await local.close(); rmSync(base, { recursive: true, force: true }); } };
}
const approved = (snapshotDigest: string) => ({ expectedSnapshotDigest: snapshotDigest, offlineConfirmed: true, effectsReconciled: true });
function memoryFiles(root: string, prefix = ''): { path: string; digest: string | null }[] {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(root, entry.name), relative = prefix + entry.name;
    return entry.isDirectory() ? [{ path: relative, digest: null }, ...memoryFiles(path, relative + '/')]
      : [{ path: relative, digest: createHash('sha256').update(readFileSync(path)).digest('hex') }];
  });
}

test('migration preserves compacted session, profile bytes and receipts; ordinary memory edits continue on documents', async () => {
  const f = await fixture();
  try {
    const preview = previewPersonalMemoryMigration(f.profiles, f.options, [runtimeRoot]);
    assert.equal(preview.capacity.recordCount, 1); assert.equal(existsSync(f.options.backupDirectory), false);
    assert.equal(existsSync(migrationOperationPath(f.directory)), false);
    const result = await applyPersonalMemoryMigration(f.profiles, f.options, approved(preview.snapshot.snapshotDigest), [runtimeRoot]);
    assert.equal(result.phase, 'activated'); assert.equal(result.effectivePersonalMemory.backend, 'documents');
    for (const file of f.preserved) assert.deepEqual(readFileSync(join(f.directory, file.path)), file.bytes, file.path);
    const current = f.profiles.inspect(f.directory); assert.equal(current.status, 'ready');
    if (current.status !== 'ready') assert.fail();
    assert.equal(current.config.schemaVersion, 1); assert.deepEqual(current.identity, f.before.identity);
    assert.deepEqual(current.effectivePersonalMemory, { backend: 'documents', storeId: f.options.targetStoreId });
    const local = await f.reopen(), workbench = new LocalWorkbench(local, actor);
    assert.deepEqual(await local.runtime.state(f.accepted.workId), f.state);
    assert.deepEqual(await workbench.history(), f.history); assert.equal(workbench.config().memoryDrafts, true);
    const web = await startWebServer(new LocalWorkbench(local, actor, 'migration-http-check'));
    try {
      const login = await fetch(`${web.origin}/api/session`, { method: 'POST', headers: { Origin: web.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: new URL(web.connectUrl).hash.slice(9) }) });
      assert.equal(login.status, 200); const { config } = await login.json() as { config: { personalMemoryBackend: string; memoryDrafts: boolean } };
      assert.equal(config.personalMemoryBackend, 'documents'); assert.equal(config.memoryDrafts, true);
    } finally { await web.close(); }
    assert.deepEqual(await workbench.memoryRemember(f.remember), f.saved);
    const revised = await workbench.memoryRevise({ id: 'memory', requestId: 'after-migration', expectedRevision: 1, title: '이어갈 기억', reason: '정정',
      source: { kind: 'new_input', workId: f.accepted.workId, messageId: 'after-migration-input', expectedGoalRevision: 1, rawText: '이관 후 같은 대화에서 정정한 기억' } });
    assert.equal(revised.revision, 2); assert.equal((await workbench.memoryGet('memory')).card.body, '이관 후 같은 대화에서 정정한 기억');
    assert.equal((await workbench.history()).sessionId, f.accepted.sessionId);
    await local.close();
    const source = new DatabaseSync(f.options.source, { readOnly: true });
    try { assert.equal(source.prepare("SELECT revision FROM knowledge_records_v2 WHERE partition='personal' AND id='memory'").get()?.['revision'], 1); }
    finally { source.close(); }
    const continued = await f.reopen();
    assert.equal((await new LocalWorkbench(continued, actor).memoryGet('memory')).card.revision, 2);
    await continued.close();
    const sourceMemoryBefore = memoryFiles(join(f.directory, 'memory'));
    const clone = f.profiles.clone(f.directory, join(f.base, 'clone'));
    assert.deepEqual(memoryFiles(join(f.directory, 'memory')), sourceMemoryBefore);
    assert.equal(clone.effectivePersonalMemory.backend, 'documents'); assert.notEqual(clone.identity.agentId, f.before.identity.agentId);
    if (clone.effectivePersonalMemory.backend !== 'documents') assert.fail();
    assert.notEqual(clone.effectivePersonalMemory.storeId, f.options.targetStoreId);
    assert.equal(existsSync(migrationOperationPath(clone.root)), false);
    const cloneStores = await openAgentStores(f.profiles, clone.root); await cloneStores.close();
    const moved = join(f.base, 'moved-agent'); renameSync(f.directory, moved);
    const reopenedMoved = await openAgentLocalProfile(moved, { compactProvider: 'synthetic' });
    try {
      assert.equal(reopenedMoved.agentId, f.before.identity.agentId);
      const movedWorkbench = new LocalWorkbench(reopenedMoved, actor);
      assert.equal((await movedWorkbench.memoryGet('memory')).card.revision, 2);
      assert.equal((await movedWorkbench.history()).sessionId, f.accepted.sessionId);
      assert.equal(f.profiles.inspect(moved).status, 'ready');
      assert.equal((await resumePersonalMemoryMigration(f.profiles, moved, f.options.operationId, [runtimeRoot])).phase, 'activated');
    } finally { await reopenedMoved.close(); }
  } finally { await f.close(); }
});

test('management CLI rejects unconfirmed or stale previews without creating an operation, then activates the fixed request', async () => {
  const f = await fixture();
  const args = ['--directory', f.directory, '--from', 'sqlite', '--source', f.options.source, '--to', 'documents', '--target', f.options.target,
    '--operation-id', f.options.operationId, '--target-store-id', f.options.targetStoreId, '--backup-directory', f.options.backupDirectory, '--scope', 'all-personal', '--json'];
  const run = (command: string, extra: string[] = []) => execute(process.execPath, [cli, 'memory-migrate', command, ...args, ...extra], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  try {
    const preview = JSON.parse((await run('preview')).stdout) as ReturnType<typeof previewPersonalMemoryMigration>;
    await assert.rejects(run('apply', ['--snapshot-digest', preview.snapshot.snapshotDigest]), /agent_migration_offline_confirmation_required/);
    assert.equal(existsSync(migrationOperationPath(f.directory)), false);
    await assert.rejects(run('apply', ['--snapshot-digest', '0'.repeat(64), '--offline-confirmed', '--effects-reconciled']), /agent_migration_snapshot_changed/);
    assert.equal(existsSync(f.options.backupDirectory), false);
    const result = JSON.parse((await run('apply', ['--snapshot-digest', preview.snapshot.snapshotDigest, '--offline-confirmed', '--effects-reconciled'])).stdout) as { phase: string };
    assert.equal(result.phase, 'activated');
    const status = await execute(process.execPath, [cli, 'status', '--directory', f.directory], { timeout: 15000 });
    assert.match(status.stdout, /개인 기억: 문서/);
    await assert.rejects(execute(process.execPath, [cli, 'memory-migrate', 'resume', '--directory', f.directory, '--operation-id', randomUUID()], { timeout: 15000 }), /agent_migration_operation_conflict/);
  } finally { await f.close(); }
});

test('activation loss gates ordinary opening; same-operation resume restores routing and a damaged target never falls back', async () => {
  const f = await fixture();
  try {
    const preview = previewPersonalMemoryMigration(f.profiles, f.options, [runtimeRoot]);
    await applyPersonalMemoryMigration(f.profiles, f.options, approved(preview.snapshot.snapshotDigest), [runtimeRoot]);
    const activation = migrationActivationPath(f.directory), saved = readFileSync(activation); unlinkSync(activation);
    await assert.rejects(openAgentStores(f.profiles, f.directory), /agent_migration_resume_required/);
    assert.ok(readSqlitePersonalMemoryFence(f.options.source, f.before.identity.agentId));
    assert.equal((await resumePersonalMemoryMigration(f.profiles, f.directory, f.options.operationId, [runtimeRoot])).phase, 'activated');
    assert.deepEqual(readFileSync(activation), saved);
    renameSync(f.options.target, f.options.target + '-held');
    await assert.rejects(openAgentStores(f.profiles, f.directory)); assert.equal(existsSync(f.options.target), false);
    renameSync(f.options.target + '-held', f.options.target);
    const configPath = join(f.directory, 'config.json'), config = readFileSync(configPath);
    writeFileSync(configPath, Buffer.concat([config, Buffer.from(' ')]));
    assert.throws(() => f.profiles.inspect(f.directory), /agent_migration_profile_mismatch/);
    writeFileSync(configPath, config);
  } finally { await f.close(); }
});

test('preview does not adopt an invalid original personal-memory assignment or conflicting ready marker', async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, '.secumon', 'personal-memory-profile.json'), originalAssignment = readFileSync(path);
    for (const assignment of [{ schemaVersion: 1, agentId: randomUUID(), backend: 'sqlite' },
      { schemaVersion: 1, agentId: f.before.identity.agentId, backend: 'documents', storeId: randomUUID() }]) {
      const bytes = Buffer.from(JSON.stringify(assignment)); writeFileSync(path, bytes);
      assert.throws(() => previewPersonalMemoryMigration(f.profiles, f.options, [runtimeRoot]), /agent_migration_initial_assignment_invalid/);
      assert.deepEqual(readFileSync(path), bytes); assert.equal(existsSync(migrationOperationPath(f.directory)), false);
    }
    writeFileSync(path, originalAssignment);
    const marker = join(f.directory, '.secumon', 'document-memory-ready.json');
    writeFileSync(marker, JSON.stringify({ schemaVersion: 1, agentId: f.before.identity.agentId, backend: 'documents', storeId: randomUUID() }), { mode: 0o600 });
    assert.throws(() => previewPersonalMemoryMigration(f.profiles, f.options, [runtimeRoot]), /agent_migration_preview_target_exists/);
    assert.equal(existsSync(f.options.target), false); assert.equal(existsSync(f.options.backupDirectory), false);
  } finally { await f.close(); }
});

test('lost migration metadata cannot reopen a fenced source or create replacement state and channel stores', async () => {
  const f = await fixture();
  try {
    const preview = previewPersonalMemoryMigration(f.profiles, f.options, [runtimeRoot]);
    await applyPersonalMemoryMigration(f.profiles, f.options, approved(preview.snapshot.snapshotDigest), [runtimeRoot]);
    for (const path of [migrationOperationPath(f.directory), migrationActivationPath(f.directory), join(f.directory, '.secumon', 'state-profile.json'),
      join(f.directory, '.secumon', 'runtime.sqlite'), join(f.directory, '.secumon', 'channel.sqlite')]) renameSync(path, path + '.held');
    const metadataOnly = f.profiles.inspect(f.directory); assert.equal(metadataOnly.status, 'ready');
    if (metadataOnly.status !== 'ready') assert.fail();
    await assert.rejects(openAgentStores(f.profiles, f.directory), /agent_migration_operation_missing/);
    assert.throws(() => bindAgentMemoryProfile(metadataOnly), /agent_migration_operation_missing/);
    for (const name of ['state-profile.json', 'runtime.sqlite', 'channel.sqlite']) assert.equal(existsSync(join(f.directory, '.secumon', name)), false);
    assert.ok(readSqlitePersonalMemoryFence(f.options.source, f.before.identity.agentId));
  } finally { await f.close(); }
});

for (const mode of ['before-activation', 'after-activation'] as const) test(`actual SIGKILL ${mode} resumes the same agent and migration`, async () => {
  const f = await fixture();
  const child = fork(new URL('./helpers/personal-memory-migration-flow-worker.js', import.meta.url), [mode, JSON.stringify(f.options)],
    { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
  const exited = once(child, 'exit');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 45000);
  try {
    const arrived = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(40000) }).then(([message]) => message),
      exited.then(([code]) => { throw new Error(`worker exited ${code}: ${stderr}`); })]);
    assert.deepEqual(arrived, { phase: mode }); assert.equal(child.kill('SIGKILL'), true);
    const [code, signal] = await exited; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    assert.equal(existsSync(migrationActivationPath(f.directory)), mode === 'after-activation');
    const result = await resumePersonalMemoryMigration(f.profiles, f.directory, f.options.operationId, [runtimeRoot]);
    assert.equal(result.phase, 'activated');
    for (const file of f.preserved) assert.deepEqual(readFileSync(join(f.directory, file.path)), file.bytes, file.path);
    const local = await f.reopen(), workbench = new LocalWorkbench(local, actor);
    assert.deepEqual(await workbench.memoryRemember(f.remember), f.saved);
    assert.equal((await workbench.history()).sessionId, f.accepted.sessionId);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await f.close();
  }
});
