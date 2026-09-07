import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileJournalStateRepository, JournalStateError, type JournalOptions, type JournalStage } from '../infrastructure/file-journal-state.js';
import { sha256 } from '../infrastructure/digest.js';
import { advance, command, delivery, initial, snapshot } from './state-conformance-helpers.js';

const stages: JournalStage[] = ['candidate_synced', 'published', 'directory_synced'];
const name = (revision: number) => `${String(revision).padStart(16, '0')}.json`;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function withJournal(run: (store: FileJournalStateRepository, root: string) => Promise<void>, options: JournalOptions = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'journal-fault-'));
  const root = join(fs.realpathSync(directory), 'journal');
  const store = new FileJournalStateRepository(root, options);
  try { await run(store, root); }
  finally { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
function recordPath(root: string, revision: number, workId = 'work-1') { return join(root, sha256(workId), name(revision)); }
function expectJournal(code: string) {
  return (error: unknown) => error instanceof JournalStateError && error.code === code;
}
async function assertStored(store: FileJournalStateRepository) {
  const request = command(initial(), 'accept', [delivery()]);
  const value = await snapshot(store, request.workId, ['accept']);
  assert.deepEqual(value.state, request.next);
  assert.deepEqual(value.receipts, { accept: { digest: request.commandDigest, state: request.next } });
  assert.deepEqual(value.deliveries, request.deliveries);
  assert.deepEqual(value.events.map(e => [e.sequence, e.revision, e.commandId]), [[1, 1, 'accept']]);
}
async function assertAbsent(store: FileJournalStateRepository) {
  assert.deepEqual(await snapshot(store, 'work-1', ['accept']), { state: null, events: [], deliveries: [], receipts: { accept: null } });
}

for (const stage of stages) {
  test(`file journal: exception at ${stage} preserves the publication boundary and retry identity`, async () => {
    await withJournal(async (store, root) => {
      const request = command(initial(), 'accept', [delivery()]);
      await assert.rejects(store.commit(request), stage === 'candidate_synced' ? /injected_stage_failure/ : expectJournal('journal_commit_unknown'));
      assert.equal(fs.existsSync(recordPath(root, 1)), stage !== 'candidate_synced');
      const reopened = new FileJournalStateRepository(root);
      try {
        if (stage === 'candidate_synced') await assertAbsent(reopened); else await assertStored(reopened);
        assert.equal((await reopened.commit(request)).kind, stage === 'candidate_synced' ? 'committed' : 'duplicate');
        await assertStored(reopened);
      } finally { await reopened.close(); }
    }, { onCommitStage(value) { if (value === stage) throw new Error('injected_stage_failure'); } });
  });

  test(`file journal: actual SIGKILL at ${stage} reopens a whole commit or no commit`, { timeout: 20000 }, async () => {
    await withJournal(async (store, root) => {
      const child = fork(new URL('./journal-fault-worker.js', import.meta.url), [root, stage], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let stderr = ''; child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
      const exited = once(child, 'exit');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      try {
        const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(10000) });
        assert.equal(ready.type, 'ready', stderr);
        const reached = once(child, 'message', { signal: AbortSignal.timeout(10000) });
        const request = command(initial(), 'accept', [delivery()]); child.send(request);
        const [[message], [, signal]] = await Promise.all([reached, exited]);
        assert.deepEqual(message, { type: 'stage', stage }, stderr); assert.equal(signal, 'SIGKILL', stderr);
        await store.close();
        const reopened = new FileJournalStateRepository(root);
        try {
          if (stage === 'candidate_synced') await assertAbsent(reopened); else await assertStored(reopened);
          assert.equal((await reopened.commit(request)).kind, stage === 'candidate_synced' ? 'committed' : 'duplicate');
          await assertStored(reopened);
        } finally { await reopened.close(); }
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      }
    });
  });
}

test('file journal: a reader and duplicate retry observe a whole published record while its writer is pending', async () => {
  const published = deferred(); const release = deferred();
  await withJournal(async (writer, root) => {
    const request = command(initial(), 'accept', [delivery()]);
    const pending = writer.commit(request); await published.promise;
    const reader = new FileJournalStateRepository(root);
    try {
      await assertStored(reader);
      assert.deepEqual(await reader.commit(request), { kind: 'duplicate', state: request.next });
      assert.deepEqual((await reader.events(request.workId, 0)).map(e => e.sequence), [1]);
    } finally { release.resolve(); await pending; await reader.close(); }
    await assertStored(writer);
  }, { onCommitStage(stage) { if (stage === 'published') { published.resolve(); return release.promise; } } });
});

test('file journal: directory sync failure prevents reads and duplicate acknowledgements without rolling back publication', { concurrency: false }, async () => {
  const published = deferred(); const release = deferred();
  await withJournal(async (writer, root) => {
    const reader = new FileJournalStateRepository(root); const request = command(initial(), 'accept', [delivery()]);
    const pending = writer.commit(request); await published.promise;
    const originalSync = fs.fsyncSync;
    fs.fsyncSync = fd => {
      if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('injected_directory_sync_failure'), { code: 'EIO' });
      originalSync(fd);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(reader.get(request.workId), /injected_directory_sync_failure/);
      await assert.rejects(reader.receipt(request.workId, request.commandId), /injected_directory_sync_failure/);
      await assert.rejects(reader.commit(request), /injected_directory_sync_failure/);
      assert.equal(fs.existsSync(recordPath(root, 1)), true);
    } finally { fs.fsyncSync = originalSync; syncBuiltinESMExports(); release.resolve(); await pending; await reader.close(); }
    await assertStored(writer);
  }, { onCommitStage(stage) { if (stage === 'published') { published.resolve(); return release.promise; } } });
});

test('file journal: listing retries the first record when publication follows its initial ENOENT', { concurrency: false }, async () => {
  const reached = deferred(); const release = deferred();
  await withJournal(async (store, root) => {
    const request = command(initial(), 'accept', [delivery()]); const writing = store.commit(request); await reached.promise;
    const folder = join(root, sha256(request.workId)); const target = recordPath(root, 1);
    const candidateName = fs.readdirSync(folder).find(item => item.endsWith('.pending')); assert.ok(candidateName);
    const originalOpen = fs.openSync; let injected = false;
    fs.openSync = ((path, ...args) => {
      if (path === target && !injected) {
        injected = true; fs.linkSync(join(folder, candidateName), target);
        throw Object.assign(new Error('open_before_concurrent_publication'), { code: 'ENOENT' });
      }
      return originalOpen(path, ...args);
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
    try { assert.deepEqual(await store.runnable(1000), [request.workId]); assert.equal(injected, true); }
    finally { fs.openSync = originalOpen; syncBuiltinESMExports(); release.resolve(); await writing; }
    await assertStored(store);
  }, { onCommitStage(stage) { if (stage === 'candidate_synced') { reached.resolve(); return release.promise; } } });
});

test('file journal: checksum corruption blocks reads and subsequent commits without overwriting the damaged record', async () => {
  await withJournal(async (store, root) => {
    const first = command(initial(), 'accept', [delivery()]); await store.commit(first);
    const path = recordPath(root, 1); const record = JSON.parse(fs.readFileSync(path, 'utf8'));
    record.request.next.statusReason = 'changed_without_checksum'; const corrupt = JSON.stringify(record); fs.writeFileSync(path, corrupt);
    await assert.rejects(store.get(first.workId), expectJournal('journal_record_invalid'));
    await assert.rejects(store.commit(command(advance(first.next), 'next')), expectJournal('journal_record_invalid'));
    assert.equal(fs.readFileSync(path, 'utf8'), corrupt); assert.equal(fs.existsSync(recordPath(root, 2)), false);
  });
});

test('file journal: an intact record checksum does not hide a broken previous-hash link', async () => {
  await withJournal(async (store, root) => {
    const first = command(initial(), 'accept'); await store.commit(first); await store.commit(command(advance(first.next), 'next'));
    const path = recordPath(root, 2); const record = JSON.parse(fs.readFileSync(path, 'utf8'));
    record.previousHash = '0'.repeat(64); const { checksum: _checksum, ...payload } = record;
    fs.writeFileSync(path, JSON.stringify({ ...payload, checksum: sha256(JSON.stringify(payload)) }));
    await assert.rejects(store.receipt(first.workId, 'next'), expectJournal('journal_record_invalid'));
  });
});

test('file journal: deleting a middle revision rejects the incomplete prefix', async () => {
  await withJournal(async (store, root) => {
    let state = initial(); await store.commit(command(state, 'one'));
    state = advance(state); await store.commit(command(state, 'two')); state = advance(state); await store.commit(command(state, 'three'));
    fs.unlinkSync(recordPath(root, 2));
    await assert.rejects(store.get(state.id), expectJournal('journal_history_gap'));
    await assert.rejects(store.runnable(1000), expectJournal('journal_history_gap'));
  });
});

test('file journal: changing store identity is rejected by an open instance and by replay after reopening', async () => {
  await withJournal(async (store, root) => {
    await store.commit(command(initial(), 'accept'));
    const path = join(root, 'format.json'); const header = JSON.parse(fs.readFileSync(path, 'utf8')); header.storeId = randomUUID();
    fs.writeFileSync(path, JSON.stringify(header));
    await assert.rejects(store.get('work-1'), expectJournal('journal_store_changed'));
    const reopened = new FileJournalStateRepository(root);
    try { await assert.rejects(reopened.get('work-1'), expectJournal('journal_record_invalid')); }
    finally { await reopened.close(); }
  });
});

test('file journal: a missing format header does not initialize a populated store as empty', async () => {
  await withJournal(async (store, root) => {
    await store.commit(command(initial(), 'accept')); fs.unlinkSync(join(root, 'format.json'));
    assert.throws(() => new FileJournalStateRepository(root), expectJournal('journal_format_missing'));
    assert.equal(fs.existsSync(join(root, 'format.json')), false); assert.equal(fs.existsSync(recordPath(root, 1)), true);
  });
});

test('file journal: existing root, work and record symlinks are rejected without following their contents', async () => {
  for (const location of ['root', 'work', 'record'] as const) await withJournal(async (store, root) => {
    await store.commit(command(initial(), 'accept'));
    const path = location === 'root' ? root : location === 'work' ? join(root, sha256('work-1')) : recordPath(root, 1);
    const saved = `${path}.saved`; fs.renameSync(path, saved); fs.symlinkSync(saved, path);
    await assert.rejects(store.get('work-1'), expectJournal(location === 'record' ? 'journal_record_unavailable' : 'journal_directory_unsafe'));
    if (location === 'root') assert.throws(() => new FileJournalStateRepository(root), expectJournal('journal_directory_unsafe'));
  });
});

test('file journal: group or other permissions on the root and records are rejected', async () => {
  for (const location of ['root', 'record'] as const) await withJournal(async (store, root) => {
    await store.commit(command(initial(), 'accept')); const path = location === 'root' ? root : recordPath(root, 1);
    fs.chmodSync(path, location === 'root' ? 0o750 : 0o640);
    await assert.rejects(store.get('work-1'), expectJournal(location === 'root' ? 'journal_directory_unsafe' : 'journal_record_unavailable'));
  });
});

test('file journal: an observed root or work directory replacement cannot reset the open repository', async () => {
  for (const location of ['root', 'work'] as const) await withJournal(async (store, root) => {
    await store.commit(command(initial(), 'accept'));
    const path = location === 'root' ? root : join(root, sha256('work-1')); fs.renameSync(path, `${path}.saved`); fs.mkdirSync(path, { mode: 0o700 });
    await assert.rejects(store.get('work-1'), expectJournal('journal_directory_changed'));
    await assert.rejects(store.commit(command(initial(), 'replacement')), expectJournal('journal_directory_changed'));
  });
});

test('file journal: record size limits reject both publication and oversized persisted input', async () => {
  await withJournal(async (store, root) => {
    const limited = new FileJournalStateRepository(root, { maxRecordBytes: 1 }); const request = command(initial(), 'accept');
    try {
      await assert.rejects(limited.commit(request), expectJournal('journal_record_too_large'));
      await assertAbsent(store); assert.equal(fs.existsSync(recordPath(root, 1)), false);
      await store.commit(request);
      await assert.rejects(limited.get(request.workId), expectJournal('journal_record_unavailable'));
    } finally { await limited.close(); }
    for (const maxRecordBytes of [0, -1, 1.5, Number.NaN]) assert.throws(() => new FileJournalStateRepository(root, { maxRecordBytes }), expectJournal('invalid_journal_configuration'));
  });
});

test('file journal: closed instances reject every repository operation while reopening retains data', async () => {
  await withJournal(async (store, root) => {
    const request = command(initial(), 'accept', [delivery()]); await store.commit(request); await store.close();
    for (const operation of [() => store.get('work-1'), () => store.receipt('work-1', 'accept'), () => store.events('work-1', 0),
      () => store.deliveries('work-1'), () => store.runnable(1000), () => store.workIdsForConversation('tenant-a', 'person-a', 'test', 'chat'), () => store.commit(request)]) {
      await assert.rejects(operation(), expectJournal('store_closed'));
    }
    const reopened = new FileJournalStateRepository(root);
    try { await assertStored(reopened); } finally { await reopened.close(); }
  });
});

test('file journal: revision zero is invalid layout and cannot be silently ignored', async () => {
  await withJournal(async (store, root) => {
    await store.commit(command(initial(), 'accept'));
    fs.writeFileSync(recordPath(root, 0), '{}', { mode: 0o600 });
    await assert.rejects(store.get('work-1'), expectJournal('journal_layout_invalid'));
  });
});
