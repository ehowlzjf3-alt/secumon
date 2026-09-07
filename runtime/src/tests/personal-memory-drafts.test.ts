import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { FilePersonalMemoryDrafts, encodeMemoryDraft, memoryDraftFileLimits } from '../infrastructure/personal-memory-drafts.js';
import { registerDocumentKnowledgeStore } from '../infrastructure/document-knowledge.js';
import { hostMetadataFiles } from '../infrastructure/host-metadata-files.js';
import type { MemoryDraftIntent, MemoryDraftOrigin } from '../application/personal-memory-draft-contracts.js';
import { sha256 } from '../infrastructure/digest.js';
import { storageFixture } from './personal-knowledge-storage-helpers.js';

function fixture() {
  const f = storageFixture(), root = join(f.directory, 'agent'), runtimeRoot = join(f.directory, 'engine'), memoryDirectory = join(root, 'memory'), storeId = randomUUID();
  mkdirSync(root, { mode: 0o755 }); mkdirSync(runtimeRoot, { mode: 0o700 }); mkdirSync(memoryDirectory, { mode: 0o700 });
  registerDocumentKnowledgeStore(join(memoryDirectory, 'documents'), { root, agentId: f.agentId, storeId });
  const options = { root, runtimeRoot, memoryDirectory, agentId: f.agentId, storeId }, owner = { tenantId: 'tenant', agentId: f.agentId, principalId: 'user' };
  const create = { draftId: randomUUID(), memoryId: 'memory', baseRevision: 3, title: '원래 제목', body: '원래 기억\r\n 끝  ' };
  return { ...f, options, owner, create, repository: new FilePersonalMemoryDrafts(options) };
}
const intentFor = (origin: MemoryDraftOrigin, overrides: Partial<MemoryDraftIntent> = {}): MemoryDraftIntent => ({ schemaVersion: 1,
  applyId: randomUUID(), origin, title: '수정 제목', body: '수정한 기억', reason: '직접 편집', sessionId: 'session', workId: 'work',
  expectedGoalRevision: 2, sourceMessageId: 'source-message', memoryCommandId: 'memory-command', action: 'revise', ...overrides });
function worker(mode: string, f: ReturnType<typeof fixture>, intent: MemoryDraftIntent, gate?: string) {
  const child = fork(fileURLToPath(new URL('./helpers/personal-memory-draft-worker.js', import.meta.url)),
    [mode, JSON.stringify(f.options), JSON.stringify(f.owner), JSON.stringify(intent), ...(gate ? [gate] : [])],
    { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-8000); });
  const exited = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  return { child, exited, stderr: () => stderr,
    message: () => once(child, 'message', { signal: AbortSignal.timeout(12000) }).then(([value]) => value as Record<string, unknown>),
    async close() { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } } };
}

test('draft export preserves an editable rename, exact body and immutable origin on duplicate create', async () => {
  const f = fixture();
  try {
    const saved = await f.repository.create(f.owner, f.create), originPath = join(dirname(saved.path), `${f.create.draftId}.origin.json`), original = readFileSync(originPath);
    assert.equal(saved.origin.baseBodyDigest, sha256(Buffer.from(f.create.body, 'utf8')));
    assert.equal(statSync(f.options.root).mode & 0o777, 0o755); assert.equal(statSync(saved.path).mode & 0o777, 0o600);
    assert.deepEqual(await f.repository.read(f.owner, f.create.draftId), { origin: saved.origin, title: f.create.title, body: f.create.body });
    const body = '수정한 본문\r\n\n---\n 끝  ', title = '줄바꿈\n제목', replacement = join(dirname(saved.path), 'editor.tmp');
    const bytes = encodeMemoryDraft(title, body); writeFileSync(replacement, bytes, { mode: 0o600 }); renameSync(replacement, saved.path);
    const renamed = statSync(saved.path).ino;
    assert.deepEqual(await f.repository.read(f.owner, f.create.draftId), { origin: saved.origin, title, body });
    assert.deepEqual(await f.repository.create(f.owner, f.create), saved);
    assert.equal(statSync(saved.path).ino, renamed); assert.deepEqual(readFileSync(saved.path), bytes); assert.deepEqual(readFileSync(originPath), original);
    await assert.rejects(f.repository.create(f.owner, { ...f.create, baseRevision: 4 }), /personal_memory_draft_conflict/);
    await assert.rejects(f.repository.create(f.owner, { ...f.create, body: '다른 원본' }), /personal_memory_draft_conflict/);
    assert.deepEqual(readdirSync(join(f.options.memoryDirectory, 'documents')).sort(), ['format.json', 'owner.json']);
  } finally { f.close(); }
});

test('intent binding is immutable, owner scoped and resumes without the editable file', async () => {
  const f = fixture();
  try {
    const saved = await f.repository.create(f.owner, f.create), intent = intentFor(saved.origin);
    assert.equal(await f.repository.operation(f.owner, intent.applyId), null);
    await assert.rejects(f.repository.bind(f.owner, { ...intent, action: 'unchanged' }), /personal_memory_draft_invalid/);
    assert.deepEqual(await f.repository.bind(f.owner, intent), intent); assert.deepEqual(await f.repository.bind(f.owner, intent), intent);
    await assert.rejects(f.repository.bind(f.owner, { ...intent, reason: '다른 이유' }), /personal_memory_draft_conflict/);
    unlinkSync(saved.path); const reopened = new FilePersonalMemoryDrafts(f.options);
    assert.deepEqual(await reopened.operation(f.owner, intent.applyId), intent); assert.deepEqual(await reopened.bind(f.owner, intent), intent);
    await assert.rejects(reopened.read(f.owner, f.create.draftId), /personal_memory_draft_missing/);
    for (const owner of [{ ...f.owner, tenantId: 'other' }, { ...f.owner, principalId: 'other' }]) {
      assert.equal(await reopened.operation(owner, intent.applyId), null);
      await assert.rejects(reopened.bind(owner, intent), /personal_memory_draft_missing/);
    }
    await assert.rejects(reopened.operation({ ...f.owner, agentId: f.otherAgentId }, intent.applyId), /personal_memory_draft_owner_mismatch/);
    await assert.rejects(new FilePersonalMemoryDrafts({ ...f.options, storeId: randomUUID() }).operation(f.owner, intent.applyId), /document_knowledge_owner_mismatch/);
    await assert.rejects(reopened.read(f.owner, '../escape'));
    assert.throws(() => new FilePersonalMemoryDrafts({ ...f.options, memoryDirectory: dirname(f.options.root) }), /personal_memory_draft_owner_mismatch/);
    await assert.rejects(new FilePersonalMemoryDrafts({ ...f.options, runtimeRoot: f.options.root }).read(f.owner, f.create.draftId), /metadata_directory_unsafe/);
  } finally { f.close(); }
});

test('draft parsing supports CRLF front matter but rejects nontext metadata, invalid UTF-8 and invalid content', async () => {
  const f = fixture();
  try {
    const saved = await f.repository.create(f.owner, f.create), expected = '한글\r\n공백  ';
    writeFileSync(saved.path, `---\r\nsecumon-memory-draft: 1\r\ntitle: "편집"\r\n---\r\n${expected}`);
    assert.equal((await f.repository.read(f.owner, f.create.draftId)).body, expected);
    for (const bytes of [Buffer.from([0xff]), Buffer.from('# unsupported\nbody'), Buffer.from('---\nsecumon-memory-draft: 1\ntitle: {}\n---\nbody'),
      encodeMemoryDraft('title', ' '.repeat(10)), encodeMemoryDraft('title', 'x'.repeat(10001))]) {
      writeFileSync(saved.path, bytes); await assert.rejects(f.repository.read(f.owner, f.create.draftId), /personal_memory_draft_invalid/);
    }
  } finally { f.close(); }
});

test('draft paths reject symlinks, external hardlinks and permissive editor saves without chmod or fallback', async () => {
  for (const mode of ['symlink', 'hardlink', 'mode'] as const) {
    const f = fixture();
    try {
      const saved = await f.repository.create(f.owner, f.create), outside = join(f.directory, 'outside.md'), bytes = readFileSync(saved.path);
      if (mode === 'symlink') { writeFileSync(outside, bytes, { mode: 0o600 }); unlinkSync(saved.path); symlinkSync(outside, saved.path); }
      else if (mode === 'hardlink') { linkSync(saved.path, outside); linkSync(saved.path, join(f.directory, 'third-link')); }
      else chmodSync(saved.path, 0o644);
      await assert.rejects(f.repository.read(f.owner, f.create.draftId));
      if (mode === 'mode') assert.equal(statSync(saved.path).mode & 0o777, 0o644);
    } finally { f.close(); }
  }
});

test('draft namespace and individual byte limits reject explicitly before another export is published', async () => {
  for (const boundary of ['entries', 'bytes', 'file', 'unknown'] as const) {
    const f = fixture();
    try {
      const saved = await f.repository.create(f.owner, f.create), directory = dirname(saved.path), draftId = randomUUID();
      if (boundary === 'entries') for (let n = 0; n < memoryDraftFileLimits.entries - 1; n++) writeFileSync(join(directory, `${randomUUID()}.md`), '', { mode: 0o600 });
      else if (boundary === 'bytes') for (let n = 0; n < memoryDraftFileLimits.bytes / memoryDraftFileLimits.file; n++) writeFileSync(join(directory, `${randomUUID()}.md`), Buffer.alloc(memoryDraftFileLimits.file), { mode: 0o600 });
      else if (boundary === 'file') writeFileSync(saved.path, Buffer.alloc(memoryDraftFileLimits.file + 1));
      else writeFileSync(join(directory, 'unregistered.txt'), 'unknown', { mode: 0o600 });
      await assert.rejects(f.repository.create(f.owner, { ...f.create, draftId }), error => /limit_exceeded|too_large|draft_invalid/.test((error as Error).message));
      assert.equal(existsSync(join(directory, `${draftId}.origin.json`)), false);
    } finally { f.close(); }
  }
});

test('a pending unlink during an observed draft read is re-enumerated without losing immutable bytes', async () => {
  const f = fixture(), files = hostMetadataFiles(), original = files.readStableRegularFile;
  try {
    const saved = await f.repository.create(f.owner, f.create), pending = `.secumon-init-${randomUUID()}.pending`, path = join(dirname(saved.path), pending);
    const before = readFileSync(saved.path); writeFileSync(path, before, { mode: 0o600 }); let injected = 0;
    files.readStableRegularFile = (ref, name, policy) => { if (name === pending && !injected++) unlinkSync(path); return original.call(files, ref, name, policy); };
    assert.equal((await f.repository.read(f.owner, f.create.draftId)).body, f.create.body); assert.equal(injected, 1); assert.deepEqual(readFileSync(saved.path), before);
  } finally { files.readStableRegularFile = original; f.close(); }
});

for (const checkpoint of ['candidate', 'intent'] as const) test(`actual SIGKILL at draft ${checkpoint} resumes one intent without needing the editable file`, { timeout: 30000 }, async () => {
  const f = fixture(); let process: ReturnType<typeof worker> | undefined;
  try {
    const saved = await f.repository.create(f.owner, f.create), intent = intentFor(saved.origin); process = worker(checkpoint, f, intent);
    assert.deepEqual(await process.message(), { checkpoint }, process.stderr()); assert.equal(process.child.kill('SIGKILL'), true);
    const [, signal] = await process.exited; assert.equal(signal, 'SIGKILL', process.stderr());
    const pendingBefore = readdirSync(dirname(saved.path)).filter(name => name.endsWith('.pending')); assert.equal(pendingBefore.length, 1);
    unlinkSync(saved.path); const reopened = new FilePersonalMemoryDrafts(f.options);
    assert.deepEqual(await reopened.operation(f.owner, intent.applyId), checkpoint === 'intent' ? intent : null);
    assert.deepEqual(await reopened.bind(f.owner, intent), intent);
    assert.equal(readdirSync(dirname(saved.path)).filter(name => name.endsWith('.intent.json')).length, 1);
    assert.deepEqual(readdirSync(dirname(saved.path)).filter(name => name.endsWith('.pending')), pendingBefore);
  } finally { await process?.close(); f.close(); }
});

test('draft intent sync EIO preserves its original cause and published status before read-side retry', { timeout: 30000 }, async () => {
  const f = fixture(); let process: ReturnType<typeof worker> | undefined;
  try {
    const saved = await f.repository.create(f.owner, f.create); process = worker('sync-fault', f, intentFor(saved.origin));
    const result = await process.message(); assert.equal(result['done'], true); assert.equal(result['originalCause'], true); assert.equal(result['publication'], 'published');
    const [code] = await process.exited; assert.equal(code, 0, process.stderr());
  } finally { await process?.close(); f.close(); }
});

test('two processes bind one apply ID once and reject different immutable intent bytes', { timeout: 30000 }, async () => {
  const f = fixture(); let a: ReturnType<typeof worker> | undefined, b: ReturnType<typeof worker> | undefined;
  try {
    const saved = await f.repository.create(f.owner, f.create), intent = intentFor(saved.origin), gate = join(f.directory, 'release');
    a = worker('contend', f, intent, gate); b = worker('contend', f, { ...intent, body: '경쟁 수정' }, gate);
    assert.deepEqual(await Promise.all([a.message(), b.message()]), [{ checkpoint: 'contend' }, { checkpoint: 'contend' }]);
    const results = Promise.all([a.message(), b.message()]); writeFileSync(gate, 'release', { mode: 0o600 });
    assert.deepEqual((await results).map(value => value['result']).sort(), ['bound', 'personal_memory_draft_conflict']);
    assert.ok((await Promise.all([a.exited, b.exited])).every(([code]) => code === 0), a.stderr() + b.stderr());
    assert.equal(readdirSync(dirname(saved.path)).filter(name => name.endsWith('.intent.json')).length, 1);
  } finally { await a?.close(); await b?.close(); f.close(); }
});
