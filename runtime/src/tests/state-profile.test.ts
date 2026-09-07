import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openLocalProfile } from '../presentation/local-profile.js';
import { adapters } from './state-conformance-helpers.js';
import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';
import { FileJournalStateRepository } from '../infrastructure/file-journal-state.js';

const execute = promisify(execFile); const cli = fileURLToPath(new URL('../presentation/cli.js', import.meta.url));
async function call(directory: string, args: string[]) {
  const result = await execute(process.execPath, [cli, ...args, '--data-dir', directory, '--json'], { timeout: 20000, maxBuffer: 1048576 });
  assert.equal(result.stderr, ''); return JSON.parse(result.stdout);
}
for (const backend of adapters) {
  test(`${backend}: profile closes the opened state repository when channel initialization fails`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'state-profile-channel-failure-'));
    const prototype = backend === 'sqlite' ? SqliteStateRepository.prototype : FileJournalStateRepository.prototype;
    const original = prototype.close; let closed = 0;
    prototype.close = async function () { closed++; await original.call(this); };
    try {
      await mkdir(join(directory, 'channel.sqlite'));
      await assert.rejects(openLocalProfile(directory, backend));
      assert.equal(closed, 1);
    } finally { prototype.close = original; await rm(directory, { recursive: true, force: true }); }
  });
}
for (const backend of adapters) for (const family of ['documents-simple', 'observations-simple']) {
  test(`${backend}/${family}: CLI persists backend choice across processes and prevents an accidental switch`, { timeout: 20000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'state-profile-'));
    try {
      const done = await call(directory, ['demo', '--request-id', 'backend', '--scenario', family, '--state-backend', backend]);
      assert.equal(done.snapshot.status, 'completed'); assert.equal(done.snapshot.usage.toolCalls, 1);
      assert.equal(JSON.parse(await readFile(join(directory, 'profile.json'), 'utf8')).stateBackend, backend);
      const again = await call(directory, ['run', done.workId]); assert.equal(again.snapshot.status, 'completed'); assert.equal(again.snapshot.usage.toolCalls, 1);
      await assert.rejects(call(directory, ['status', done.workId, '--state-backend', backend === 'sqlite' ? 'file-journal' : 'sqlite']), (error: unknown) => {
        const value = error as { stdout: string; stderr: string }; assert.equal(value.stdout, ''); assert.match(value.stderr, /profile_backend_mismatch/); return true;
      });
      const messages = await call(directory, ['messages']); assert.deepEqual(messages.messages.map((message: { kind: string }) => message.kind), ['ack', 'result']);
      const after = await call(directory, ['status', done.workId]); assert.equal(after.snapshot.revision, again.snapshot.revision);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test('legacy SQLite profile acquires metadata without losing its work or accepting a backend switch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'state-profile-legacy-'));
  try {
    const accepted = await call(directory, ['accept', '--request-id', 'legacy']); await rm(join(directory, 'profile.json'));
    await assert.rejects(openLocalProfile(directory, 'file-journal'), /profile_backend_mismatch/);
    const current = await call(directory, ['status', accepted.workId]); assert.equal(current.snapshot.revision, accepted.snapshot.revision);
    assert.equal(JSON.parse(await readFile(join(directory, 'profile.json'), 'utf8')).stateBackend, 'sqlite');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('two processes choosing different backends create only one accepted profile', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'state-profile-race-'));
  try {
    const results = await Promise.allSettled(adapters.map(backend => call(directory, ['accept', '--request-id', 'race', '--state-backend', backend])));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.filter(r => r.status === 'rejected').length, 1);
    const failed = results.find(r => r.status === 'rejected')! as PromiseRejectedResult; assert.match(String(failed.reason.stderr), /profile_backend_mismatch/);
    const profile = await openLocalProfile(directory);
    try { assert.equal((await profile.conversation.list({ tenantId: 'synthetic', principalId: 'learner' }, 'cli', 'terminal')).length, 1); }
    finally { await profile.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid or linked profile metadata is rejected without opening a new backend', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'state-profile-invalid-'));
  try {
    await assert.rejects(openLocalProfile(directory, 'other'), /invalid_state_backend/);
    const file = join(directory, 'profile.json'); await writeFile(file, '{bad', { mode: 0o600 });
    await assert.rejects(openLocalProfile(directory), /profile_metadata_invalid/);
    await rm(file); const target = join(directory, 'other.json'); await writeFile(target, JSON.stringify({ kind: 'local-runtime-profile', schemaVersion: 1, stateBackend: 'sqlite' }), { mode: 0o600 }); await symlink(target, file);
    await assert.rejects(openLocalProfile(directory), /profile_metadata_invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
