import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileWorkspaceStore } from '../infrastructure/file-workspaces.js';
import { WorkspaceError } from '../application/workspace-checkpoints.js';
import { sha256 } from '../infrastructure/digest.js';

type Stage = 'lock-created' | 'candidate-synced' | 'file-published';
const workId = 'interrupted-work'; const attemptId = 'interrupted-attempt'; const path = 'report.txt';
const content = Buffer.from('Synthetic interruption content\n');
const attributes = { tenantId: 'tenant-a', labels: ['synthetic'], lifecycleGeneration: 0 };
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-interruption-'))); const root = join(base, 'workspace');
  const attempt = join(root, sha256(workId), sha256(attemptId));
  return { base, root, attempt, files: join(attempt, 'files'), lock: join(attempt, '.lock'), close: () => rmSync(base, { recursive: true, force: true }) };
}
function snapshot(root: string) {
  const entries: Array<{ path: string; mode: number; identity: string; links: number; bytes?: Buffer }> = [];
  const visit = (path: string, name: string) => {
    const stat = lstatSync(path); assert.equal(stat.isSymbolicLink(), false);
    const entry = { path: name, mode: stat.mode & 0o777, identity: `${stat.dev}:${stat.ino}`, links: stat.nlink };
    if (stat.isDirectory()) {
      entries.push(entry); for (const child of readdirSync(path).sort()) visit(join(path, child), name ? `${name}/${child}` : child);
    } else { assert.equal(stat.isFile(), true); entries.push({ ...entry, bytes: readFileSync(path) }); }
  };
  visit(root, ''); return entries;
}
async function interrupt(root: string, stage: Stage) {
  const child = fork(new URL('./helpers/workspace-interruption-worker.js', import.meta.url), [root, stage],
    { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; let timedOut = false;
  child.stderr!.on('data', value => { stderr = (stderr + String(value)).slice(-8000); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15000);
  const message = () => new Promise<unknown>((resolve, reject) => {
    const cleanup = () => { child.off('message', received); child.off('exit', exited); child.off('error', failed); };
    const received = (value: unknown) => { cleanup(); resolve(value); };
    const exited = () => { cleanup(); reject(new Error(`workspace_worker_exited_before_boundary:${timedOut}:${stderr}`)); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    child.once('message', received); child.once('exit', exited); child.once('error', failed);
  });
  try {
    assert.deepEqual(await message(), { type: 'ready' }, stderr);
    const reached = message();
    const sent = new Promise<void>((resolve, reject) => child.send({ type: 'stage' }, error => error ? reject(error) : resolve()));
    const [boundary] = await Promise.all([reached, sent]);
    assert.deepEqual(boundary, { type: 'boundary', stage }, stderr); assert.equal(timedOut, false, stderr);
    assert.equal(child.kill('SIGKILL'), true); const stopped = await closed;
    assert.equal(stopped.code, null, stderr); assert.equal(stopped.signal, 'SIGKILL', stderr);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}

for (const stage of ['lock-created', 'candidate-synced', 'file-published'] as const) {
  test(`workspace: actual SIGKILL at ${stage} preserves interruption artifacts and never steals the remaining lock`, { timeout: 25000 }, async () => {
    const f = fixture(); let reopened: FileWorkspaceStore | undefined;
    try {
      await interrupt(f.root, stage);
      assert.equal(lstatSync(f.lock).isDirectory(), true); assert.equal(lstatSync(f.lock).mode & 0o077, 0);
      // There is no persisted lock-owner receipt or automatic stale-lock recovery in this store.
      assert.deepEqual(readdirSync(f.lock), []);
      const published = join(f.files, `${sha256(path)}.json`);
      if (stage === 'lock-created') {
        assert.equal(existsSync(f.files), false); assert.deepEqual(readdirSync(f.attempt), ['.lock']);
      } else {
        const names = readdirSync(f.files).sort(); const candidates = names.filter(name => /^[a-f0-9-]{36}\.pending$/.test(name));
        assert.equal(candidates.length, 1); assert.equal(names.length, stage === 'file-published' ? 2 : 1);
        const candidate = join(f.files, candidates[0]!); const bytes = readFileSync(candidate); const record = JSON.parse(bytes.toString('utf8'));
        assert.equal(record.schemaVersion, 1);
        assert.deepEqual(record.file, { workId, attemptId, path, ...attributes, byteLength: content.length, sha256: sha256(content) });
        assert.equal(record.contentBase64, content.toString('base64'));
        assert.equal(record.checksum, sha256(JSON.stringify({ schemaVersion: record.schemaVersion, file: record.file, contentBase64: record.contentBase64 })));
        assert.equal(existsSync(published), stage === 'file-published');
        assert.equal(lstatSync(candidate).nlink, stage === 'file-published' ? 2 : 1);
        if (stage === 'file-published') {
          assert.deepEqual(readFileSync(published), bytes); assert.equal(lstatSync(published).ino, lstatSync(candidate).ino);
          assert.equal(lstatSync(published).nlink, 2);
        }
      }
      const interrupted = snapshot(f.root); reopened = new FileWorkspaceStore(f.root);
      assert.deepEqual(snapshot(f.root), interrupted);
      for (const action of [
        () => reopened!.stage(workId, attemptId, path, content, attributes),
        () => reopened!.read(workId, attemptId, path),
        () => reopened!.list(workId, attemptId),
        () => reopened!.removeAttempt(workId, attemptId, []),
      ]) {
        await assert.rejects(action(), error => error instanceof WorkspaceError && error.code === 'workspace_busy');
        assert.deepEqual(snapshot(f.root), interrupted);
      }
    } finally { await reopened?.close(); f.close(); }
  });
}
