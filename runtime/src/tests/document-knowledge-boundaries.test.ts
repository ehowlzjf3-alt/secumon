import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DocumentKnowledgeRepository, registerDocumentKnowledgeStore } from '../infrastructure/document-knowledge.js';
import { decodeDocumentEvent, documentDigest, documentEventName, documentLimits, documentNamespaceName, encodeDocumentEvent } from '../infrastructure/document-knowledge-codec.js';
import { storageFixture, ownerScope, personalRecord, storageCommand } from './personal-knowledge-storage-helpers.js';

function fixture() {
  const f = storageFixture(), directory = join(f.directory, 'documents'), binding = { agentId: f.agentId, storeId: 'store' }, scope = ownerScope(f.agentId);
  const namespace = { tenantId: 'tenant-a', ...scope, namespace: 'personal' as const };
  registerDocumentKnowledgeStore(directory, binding);
  return { ...f, directory, temporary: f.directory, binding, scope, namespace,
    records: join(directory, documentNamespaceName(namespace)), witnesses: join(directory, `witness-${documentDigest(namespace)}`) };
}
function worker(mode: string, f: ReturnType<typeof fixture>, gate?: string) {
  const child = fork(fileURLToPath(new URL('./helpers/document-knowledge-worker.js', import.meta.url)), [mode, f.directory, f.agentId, ...(gate ? [gate] : [])],
    { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-8000); });
  type Message = Record<string, unknown>;
  type Waiter = { resolve(value: Message): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
  const queue: Message[] = [], history: Message[] = [], waiters: Waiter[] = [];
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null, closed = false, spawnError: Error | undefined;
  const failure = (reason: string) => new Error(`${reason}: ${JSON.stringify({ mode, pid: child.pid, exit, closed, messages: history, stderr })}`,
    spawnError ? { cause: spawnError } : undefined);
  const rejectWaiting = (reason: string) => {
    for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(failure(reason)); }
  };
  // Subscribe at spawn, retain early messages, and fail on actual close after stderr has drained.
  child.on('message', value => {
    const message = value as Message; history.push(message); const waiter = waiters.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(message); } else queue.push(message);
  });
  child.on('error', error => { spawnError = error; rejectWaiting('document_worker_spawn_error'); });
  const exited = new Promise<[number | null, NodeJS.Signals | null]>(resolve => child.once('exit', (code, signal) => { exit = { code, signal }; resolve([code, signal]); }));
  const closure = new Promise<void>(resolve => child.once('close', () => { closed = true; rejectWaiting('document_worker_closed_before_message'); resolve(); }));
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  return { child, exited, closure, stderr: () => stderr,
    message(): Promise<Message> {
      const message = queue.shift(); if (message) return Promise.resolve(message);
      if (closed || spawnError) return Promise.reject(failure(closed ? 'document_worker_closed_before_message' : 'document_worker_spawn_error'));
      return new Promise((resolve, reject) => {
        const waiter: Waiter = { resolve, reject, timer: setTimeout(() => {
          const index = waiters.indexOf(waiter); if (index !== -1) waiters.splice(index, 1);
          reject(failure('document_worker_message_timeout'));
        }, 12000) };
        waiters.push(waiter);
      });
    },
    async close() { clearTimeout(timer); rejectWaiting('document_worker_parent_cleanup'); if (!closed) child.kill('SIGKILL'); await closure; } };
}

test('document worker retains early IPC and reports a closed child with its original stderr', { timeout: 30000 }, async () => {
  const f = fixture(), process = worker('orchestration-burst-exit', f);
  try {
    await process.closure;
    assert.deepEqual(await process.message(), { checkpoint: 'early' });
    assert.deepEqual(await process.message(), { done: true, sequence: 2 });
    await assert.rejects(process.message(), error => {
      assert.match((error as Error).message, /document_worker_closed_before_message/);
      assert.match((error as Error).message, /synthetic_document_worker_exit_before_next_message/);
      assert.match((error as Error).message, /"code":23/); return true;
    });
  } finally { await process.close(); f.close(); }
});

test('document codec preserves body bytes and rejects malformed UTF-8, checksum, identity and schema changes', () => {
  const f = storageFixture(), scope = { tenantId: 'tenant-a', ...ownerScope(f.agentId), namespace: 'personal' as const };
  try {
    const next = personalRecord(f.agentId, 'user-a', 'tenant-a', '한글\r\n\n-->\n 끝  '), command = storageCommand(next);
    const event = { schemaVersion: 1 as const, scope, sequence: 1, previous: null, change: { kind: 'record' as const, expectedRevision: 0,
      commandId: command.commandId, commandDigest: command.commandDigest, next } };
    const bytes = encodeDocumentEvent(event); assert.deepEqual(decodeDocumentEvent(bytes), event);
    const altered = Buffer.from(bytes); altered[altered.length - 1] = 120; assert.throws(() => decodeDocumentEvent(altered), /document_knowledge_record_invalid/);
    assert.throws(() => decodeDocumentEvent(Buffer.from([0xff])), /document_knowledge_record_invalid/);
    assert.throws(() => encodeDocumentEvent({ ...event, scope: { ...scope, agentId: f.otherAgentId } }), /knowledge_scope_mismatch/);
    assert.throws(() => encodeDocumentEvent({ ...event, change: { ...event.change, next: { ...next, revision: 0 } } }));
    assert.throws(() => decodeDocumentEvent(Buffer.alloc(documentLimits.file + 1)), /document_knowledge_limit_exceeded/);
  } finally { f.close(); }
});

test('a deleted forgotten tail or whole namespace cannot resurrect prior active memory after reopening', async () => {
  for (const deletion of ['tail', 'namespace'] as const) {
    const f = fixture(); let repository = new DocumentKnowledgeRepository(f.directory, f.binding);
    try {
      const next = personalRecord(f.agentId); await repository.commit(storageCommand(next, 'create', f.scope));
      const forgotten = { ...next, revision: 2, updatedAt: 111, status: 'deleted' as const, body: '',
        sources: next.sources.map(source => source.type === 'session_user_receipt' ? { ...source, quote: '' } : source) };
      await repository.commit(storageCommand(forgotten, 'forget', f.scope));
      if (deletion === 'tail') unlinkSync(join(f.records, '00000002.md')); else rmSync(f.records, { recursive: true });
      await assert.rejects(repository.get('tenant-a', next.id, f.scope));
      await repository.close(); repository = new DocumentKnowledgeRepository(f.directory, f.binding);
      await assert.rejects(repository.get('tenant-a', next.id, f.scope), /document_knowledge_history_missing/);
      assert.equal(existsSync(join(f.witnesses, '00000002.json')), true);
    } finally { await repository.close(); f.close(); }
  }
});

test('document reads reject external links, unsafe permissions, unknown files and tampered witnesses without falling back', async () => {
  for (const corruption of ['hardlink', 'symlink', 'mode', 'unknown', 'witness'] as const) {
    const f = fixture(), repository = new DocumentKnowledgeRepository(f.directory, f.binding);
    try {
      const record = personalRecord(f.agentId); await repository.commit(storageCommand(record, 'create', f.scope));
      const path = join(f.records, '00000001.md');
      if (corruption === 'hardlink') linkSync(path, join(f.temporary, 'external-link'));
      else if (corruption === 'symlink') {
        const bytes = readFileSync(path); unlinkSync(path); writeFileSync(join(f.temporary, 'outside.md'), bytes, { mode: 0o600 }); symlinkSync(join(f.temporary, 'outside.md'), path);
      } else if (corruption === 'mode') chmodSync(path, 0o644);
      else if (corruption === 'unknown') writeFileSync(join(f.records, 'notes.md'), 'not a canonical record', { mode: 0o600 });
      else writeFileSync(join(f.witnesses, '00000001.json'), JSON.stringify({ scope: f.namespace, sequence: 1, digest: 'f'.repeat(64) }), { mode: 0o600 });
      await assert.rejects(repository.get('tenant-a', record.id, f.scope));
    } finally { await repository.close(); f.close(); }
  }
});

test('bounded namespace enumeration and file bytes fail explicitly rather than truncating history', async () => {
  for (const limit of ['entries', 'file'] as const) {
    const f = fixture(), repository = new DocumentKnowledgeRepository(f.directory, f.binding);
    try {
      mkdirSync(f.records, { mode: 0o700 });
      if (limit === 'entries') for (let n = 1; n <= documentLimits.entries + 1; n++) writeFileSync(join(f.records, documentEventName(n)), '', { mode: 0o600 });
      else writeFileSync(join(f.records, documentEventName(1)), Buffer.alloc(documentLimits.file + 1), { mode: 0o600 });
      await assert.rejects(repository.get('tenant-a', 'same-memory', f.scope), error => /limit_exceeded|too_large/.test((error as Error).message));
    } finally { await repository.close(); f.close(); }
  }
});

for (const checkpoint of ['candidate', 'event'] as const) test(`actual SIGKILL at document ${checkpoint} keeps only canonical publication and resumes witness through get`, { timeout: 30000 }, async () => {
  const f = fixture(), process = worker(checkpoint, f); let repository: DocumentKnowledgeRepository | undefined;
  try {
    assert.deepEqual(await process.message(), { checkpoint }, process.stderr());
    assert.equal(process.child.kill('SIGKILL'), true); const [, signal] = await process.exited; assert.equal(signal, 'SIGKILL', process.stderr());
    assert.equal(existsSync(join(f.records, '00000001.md')), checkpoint === 'event');
    assert.equal(existsSync(join(f.witnesses, '00000001.json')), false);
    repository = new DocumentKnowledgeRepository(f.directory, f.binding);
    const read = await repository.get('tenant-a', 'same-memory', f.scope);
    if (checkpoint === 'event') {
      assert.deepEqual(read, personalRecord(f.agentId)); assert.equal(existsSync(join(f.witnesses, '00000001.json')), true);
      assert.deepEqual(await repository.commit(storageCommand(personalRecord(f.agentId), 'create', f.scope)), { kind: 'duplicate', revision: 1 });
    } else {
      assert.equal(read, null); assert.equal(await repository.receipt('tenant-a', 'same-memory', 'create', f.scope), null);
      assert.deepEqual(await repository.commit(storageCommand(personalRecord(f.agentId), 'create', f.scope)), { kind: 'committed', revision: 1 });
    }
    assert.equal(readdirSync(f.records).filter(name => name.endsWith('.md')).length, 1);
  } finally { await process.close(); await repository?.close(); f.close(); }
});

test('post-publication sync EIO preserves original cause and publication state; receipt-first retry recovers', { timeout: 30000 }, async () => {
  const f = fixture(), process = worker('sync-fault', f);
  try {
    const result = await process.message(); assert.equal(result['done'], true); assert.equal(result['originalCause'], true);
    assert.equal(result['publication'], 'published'); assert.equal(result['receiptRevision'], 1);
    const [code] = await process.exited; assert.equal(code, 0, process.stderr());
  } finally { await process.close(); f.close(); }
});

for (const kind of ['same', 'different'] as const) test(`separate processes contend on one namespace with ${kind} memory IDs`, { timeout: 30000 }, async () => {
  const f = fixture(), gate = join(f.temporary, 'release'), mode = kind === 'same' ? 'contend' : 'contend-different';
  const a = worker(mode, f, gate), b = worker(mode, f, gate);
  try {
    assert.deepEqual(await Promise.all([a.message(), b.message()]), [{ checkpoint: 'contend' }, { checkpoint: 'contend' }]);
    const results = Promise.all([a.message(), b.message()]); writeFileSync(gate, 'release', { mode: 0o600 });
    const messages = await results;
    assert.ok(messages.every(value => value['done'] === true), JSON.stringify({ messages, a: a.stderr(), b: b.stderr() }));
    const values = messages.map(value => value['result'] as { kind: string });
    assert.deepEqual(values.map(value => value.kind).sort(), kind === 'same' ? ['committed', 'conflict'] : ['committed', 'committed']);
    const exits = await Promise.all([a.exited, b.exited]); assert.ok(exits.every(([code]) => code === 0), a.stderr() + b.stderr());
    const repository = new DocumentKnowledgeRepository(f.directory, f.binding);
    try {
      assert.equal((await repository.indexHead('tenant-a', 'personal', f.scope)).revision, kind === 'same' ? 1 : 2);
      if (kind === 'same') assert.equal((await repository.get('tenant-a', 'same-memory', f.scope))?.revision, 1);
    }
    finally { await repository.close(); }
  } finally { await a.close(); await b.close(); f.close(); }
});

test('namespace retries its full snapshot when a canonical link appears after the pending-only listing', { timeout: 30000 }, async () => {
  const f = fixture(), process = worker('namespace-stale-pending-list', f);
  try {
    const message = await process.message();
    assert.equal(message['done'], true, JSON.stringify(message)); assert.equal(message['injectedPendingLink'], true);
    assert.deepEqual(message['result'], { kind: 'committed', revision: 1 });
    const [code] = await process.exited; assert.equal(code, 0, process.stderr());
    const repository = new DocumentKnowledgeRepository(f.directory, f.binding);
    try {
      assert.equal((await repository.get('tenant-a', 'same-memory', f.scope))?.revision, 1);
      assert.equal((await repository.get('tenant-a', 'second-memory', f.scope))?.revision, 1);
      assert.equal((await repository.indexHead('tenant-a', 'personal', f.scope)).revision, 2);
      assert.deepEqual(readdirSync(f.records).filter(name => name.endsWith('.md')).sort(), ['00000001.md', '00000002.md']);
    } finally { await repository.close(); }
  } finally { await process.close(); f.close(); }
});
