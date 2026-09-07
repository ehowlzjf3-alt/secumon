import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileJournalStateRepository, inspectJournalOwnership, JournalStateError, type JournalOwner } from '../infrastructure/file-journal-state.js';
import { sha256 } from '../infrastructure/digest.js';
import { command, initial } from './state-conformance-helpers.js';

const owner = (): JournalOwner => ({ agentId: randomUUID(), kind: 'state' });
const expectedError = (code: string) => (error: unknown) => error instanceof JournalStateError && error.code === code;
function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'journal-owner-')));
  return { directory, root: join(directory, 'journal'), close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
const header = (root: string) => JSON.parse(fs.readFileSync(join(root, 'format.json'), 'utf8'));
const headerBytes = (root: string) => fs.readFileSync(join(root, 'format.json'));
function put(path: string, value: unknown) { fs.writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
function ownedHeader(value: JournalOwner) { return { kind: 'long-horizon-file-journal', schemaVersion: 2, storeId: randomUUID(), owner: value }; }

test('journal owner: existing standalone v1 headers and v1 records remain compatible', async () => {
  const f = fixture(); let store: FileJournalStateRepository | undefined;
  try {
    store = new FileJournalStateRepository(f.root); const before = headerBytes(f.root);
    const request = command(initial(), 'accept'); assert.equal((await store.commit(request)).kind, 'committed');
    assert.equal(header(f.root).schemaVersion, 1); assert.equal(header(f.root).owner, undefined);
    await store.close(); store = new FileJournalStateRepository(f.root);
    assert.deepEqual(headerBytes(f.root), before); assert.deepEqual(await store.get(request.workId), request.next);
    const record = JSON.parse(fs.readFileSync(join(f.root, sha256(request.workId), '0000000000000001.json'), 'utf8'));
    assert.equal(record.schemaVersion, 1);
  } finally { await store?.close(); f.close(); }
});

for (const populated of [false, true]) test(`journal owner: v1 ${populated ? 'populated' : 'empty'} journals are never automatically adopted`, async () => {
  const f = fixture(); const store = new FileJournalStateRepository(f.root);
  try {
    if (populated) await store.commit(command(initial(), 'accept'));
    const before = headerBytes(f.root); const names = fs.readdirSync(f.root).sort(); const expected = owner();
    assert.throws(() => inspectJournalOwnership(f.root, expected), expectedError('journal_owner_missing'));
    assert.throws(() => new FileJournalStateRepository(f.root, { owner: expected }), expectedError('journal_owner_missing'));
    assert.deepEqual(headerBytes(f.root), before); assert.deepEqual(fs.readdirSync(f.root).sort(), names);
  } finally { await store.close(); f.close(); }
});

test('journal owner: owner is published with v2 header and current records remain v1', async () => {
  const f = fixture(); const expected = owner(); let store: FileJournalStateRepository | undefined;
  try {
    assert.equal(inspectJournalOwnership(f.root, expected), 'uninitialized'); assert.equal(fs.existsSync(f.root), false);
    store = new FileJournalStateRepository(f.root, { owner: expected }); const before = headerBytes(f.root);
    assert.equal(header(f.root).schemaVersion, 2); assert.deepEqual(header(f.root).owner, expected);
    const request = command(initial(), 'accept'); await store.commit(request); await store.close();
    store = new FileJournalStateRepository(f.root, { owner: expected });
    assert.equal(inspectJournalOwnership(f.root, expected), 'owned'); assert.deepEqual(headerBytes(f.root), before);
    assert.deepEqual(await store.get(request.workId), request.next);
    assert.equal(JSON.parse(fs.readFileSync(join(f.root, sha256(request.workId), '0000000000000001.json'), 'utf8')).schemaVersion, 1);
  } finally { await store?.close(); f.close(); }
});

test('journal owner: foreign v2 and absent expected owner preserve the published header', async () => {
  const f = fixture(); const expected = owner(); const store = new FileJournalStateRepository(f.root, { owner: expected });
  try {
    const before = headerBytes(f.root);
    assert.throws(() => new FileJournalStateRepository(f.root), expectedError('journal_owner_required'));
    assert.throws(() => new FileJournalStateRepository(f.root, { owner: owner() }), expectedError('journal_owner_mismatch'));
    assert.throws(() => inspectJournalOwnership(f.root, owner()), expectedError('journal_owner_mismatch'));
    assert.deepEqual(headerBytes(f.root), before);
  } finally { await store.close(); f.close(); }
});

test('journal owner: expected owner is copied and frozen before any storage is initialized', async () => {
  const f = fixture(); const supplied = owner(); const saved = { ...supplied }; const options = { owner: supplied };
  let store: FileJournalStateRepository | undefined;
  try {
    assert.throws(() => new FileJournalStateRepository(f.root, { owner: { agentId: 'invalid', kind: 'state' } }), expectedError('journal_owner_invalid'));
    assert.equal(fs.existsSync(f.root), false);
    store = new FileJournalStateRepository(f.root, options); supplied.agentId = randomUUID(); options.owner = owner();
    assert.deepEqual(store.options.owner, saved); assert.equal(Object.isFrozen(store.options.owner), true);
    assert.throws(() => { store!.options.owner!.agentId = randomUUID(); }, TypeError);
    await store.commit(command(initial(), 'accept')); assert.deepEqual(header(f.root).owner, saved);
  } finally { await store?.close(); f.close(); }
});

for (const mutation of ['agentId', 'kind', 'version', 'storeId'] as const) test(`journal owner: ${mutation} mutation is rejected before cached reads and writes`, async () => {
  const f = fixture(); const expected = owner(); const store = new FileJournalStateRepository(f.root, { owner: expected });
  try {
    const request = command(initial(), 'accept'); await store.commit(request); await store.get(request.workId);
    const value = header(f.root);
    if (mutation === 'agentId') value.owner.agentId = randomUUID();
    if (mutation === 'kind') value.owner.kind = 'memory';
    if (mutation === 'version') { value.schemaVersion = 1; delete value.owner; }
    if (mutation === 'storeId') value.storeId = randomUUID();
    put(join(f.root, 'format.json'), value); const before = headerBytes(f.root);
    const code = mutation === 'agentId' ? 'journal_owner_mismatch' : mutation === 'kind' ? 'journal_format_invalid' :
      mutation === 'version' ? 'journal_owner_missing' : 'journal_store_changed';
    await assert.rejects(store.get(request.workId), expectedError(code));
    await assert.rejects(store.commit(request), expectedError(code)); assert.deepEqual(headerBytes(f.root), before);
  } finally { await store.close(); f.close(); }
});

test('journal owner: read-only preflight preserves empty roots and validates header candidates by content', async () => {
  const f = fixture(); const expected = owner();
  try {
    fs.mkdirSync(f.root, { mode: 0o700 }); assert.equal(inspectJournalOwnership(f.root, expected), 'uninitialized');
    assert.deepEqual(fs.readdirSync(f.root), []);
    const candidate = join(f.root, `${randomUUID()}.pending`); const value = ownedHeader(expected); put(candidate, value);
    const before = fs.readFileSync(candidate);
    assert.equal(inspectJournalOwnership(f.root, expected), 'uninitialized'); assert.equal(fs.existsSync(join(f.root, 'format.json')), false);
    const store = new FileJournalStateRepository(f.root, { owner: expected });
    try { assert.deepEqual(header(f.root).owner, expected); assert.deepEqual(fs.readFileSync(candidate), before); }
    finally { await store.close(); }
  } finally { f.close(); }
});

for (const kind of ['unknown', 'record-directory', 'invalid-pending', 'foreign-pending', 'v1-pending', 'oversized-pending'] as const) {
  test(`journal owner: missing header with ${kind} cannot mint a replacement store ID`, () => {
    const f = fixture(); const expected = owner();
    try {
      fs.mkdirSync(f.root, { mode: 0o700 });
      const pending = join(f.root, `${randomUUID()}.pending`);
      if (kind === 'unknown') put(join(f.root, 'unknown.json'), {});
      if (kind === 'record-directory') fs.mkdirSync(join(f.root, 'a'.repeat(64)), { mode: 0o700 });
      if (kind === 'invalid-pending') put(pending, { schemaVersion: 1, request: {} });
      if (kind === 'foreign-pending') put(pending, ownedHeader(owner()));
      if (kind === 'v1-pending') put(pending, { kind: 'long-horizon-file-journal', schemaVersion: 1, storeId: randomUUID() });
      if (kind === 'oversized-pending') fs.writeFileSync(pending, 'x'.repeat(4097), { mode: 0o600 });
      const names = fs.readdirSync(f.root).sort();
      const code = kind === 'foreign-pending' ? 'journal_owner_mismatch' : kind === 'v1-pending' ? 'journal_owner_missing' :
        kind === 'oversized-pending' ? 'journal_record_too_large' : kind === 'invalid-pending' ? 'journal_format_invalid' : 'journal_format_missing';
      assert.throws(() => inspectJournalOwnership(f.root, expected), expectedError(code));
      assert.throws(() => new FileJournalStateRepository(f.root, { owner: expected }), expectedError(code));
      assert.equal(fs.existsSync(join(f.root, 'format.json')), false); assert.deepEqual(fs.readdirSync(f.root).sort(), names);
    } finally { f.close(); }
  });
}

test('journal owner: external header hardlinks are rejected while interrupted publication links are preserved', async () => {
  const f = fixture(); const expected = owner(); let store = new FileJournalStateRepository(f.root, { owner: expected });
  try {
    const format = join(f.root, 'format.json'); const outside = join(f.directory, 'outside.json'); const before = headerBytes(f.root);
    fs.linkSync(format, outside);
    assert.throws(() => inspectJournalOwnership(f.root, expected), expectedError('journal_file_unsafe'));
    await assert.rejects(store.get('work-1'), expectedError('journal_file_unsafe')); fs.unlinkSync(outside);
    const pending = join(f.root, `${randomUUID()}.pending`); fs.linkSync(format, pending);
    assert.equal(inspectJournalOwnership(f.root, expected), 'owned'); await store.close();
    store = new FileJournalStateRepository(f.root, { owner: expected });
    assert.equal(await store.get('work-1'), null); assert.equal(fs.existsSync(pending), true); assert.deepEqual(headerBytes(f.root), before);
  } finally { await store.close(); f.close(); }
});

for (const kind of ['root-symlink', 'header-symlink', 'public-header', 'external-pending-hardlink', 'pending-symlink'] as const) {
  test(`journal owner: ${kind} is rejected without changing the outside file`, async () => {
    const f = fixture(); const expected = owner(); const outside = join(f.directory, 'outside'); const value = ownedHeader(expected);
    try {
      if (kind === 'root-symlink') { fs.mkdirSync(outside, { mode: 0o700 }); fs.symlinkSync(outside, f.root, 'dir'); }
      else {
        fs.mkdirSync(f.root, { mode: 0o700 }); put(outside, value);
        if (kind === 'header-symlink') fs.symlinkSync(outside, join(f.root, 'format.json'));
        if (kind === 'public-header') { put(join(f.root, 'format.json'), value); fs.chmodSync(join(f.root, 'format.json'), 0o644); }
        if (kind === 'external-pending-hardlink') fs.linkSync(outside, join(f.root, `${randomUUID()}.pending`));
        if (kind === 'pending-symlink') fs.symlinkSync(outside, join(f.root, `${randomUUID()}.pending`));
      }
      assert.throws(() => inspectJournalOwnership(f.root, expected), expectedError(kind === 'root-symlink' ? 'journal_directory_unsafe' : 'journal_file_unsafe'));
      if (kind !== 'root-symlink') assert.deepEqual(JSON.parse(fs.readFileSync(outside, 'utf8')), value);
    } finally { f.close(); }
  });
}

test('journal owner: header candidate count is bounded without truncation or adoption', () => {
  const f = fixture(); const expected = owner();
  try {
    fs.mkdirSync(f.root, { mode: 0o700 });
    for (let index = 0; index < 513; index++) put(join(f.root, `${randomUUID()}.pending`), ownedHeader(expected));
    assert.throws(() => inspectJournalOwnership(f.root, expected), expectedError('journal_pending_limit'));
    assert.equal(fs.existsSync(join(f.root, 'format.json')), false); assert.equal(fs.readdirSync(f.root).length, 513);
  } finally { f.close(); }
});

async function worker(root: string, expected: JournalOwner, stage = 'open', marker = '') {
  const child = fork(new URL('./journal-owner-worker.js', import.meta.url), [root, expected.agentId, stage, marker], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
  const exited = once(child, 'exit'); const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  try { const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(10000) }); assert.equal(ready.type, 'ready', stderr); }
  catch (error) { clearTimeout(timer); child.kill('SIGKILL'); await exited; throw error; }
  return { child, exited, stderr: () => stderr, async close() {
    clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  } };
}

for (const mixed of [false, true]) test(`journal owner: concurrent initializers ${mixed ? 'reject another owner' : 'join one atomic header'}`, { timeout: 25000 }, async () => {
  const f = fixture(); const first = owner(); const owners = mixed ? [first, owner()] : Array.from({ length: 6 }, () => first);
  const children: Awaited<ReturnType<typeof worker>>[] = [];
  try {
    const opened = await Promise.allSettled(owners.map(value => worker(f.root, value)));
    for (const item of opened) if (item.status === 'fulfilled') children.push(item.value);
    assert.equal(children.length, owners.length);
    const messages = children.map(child => once(child.child, 'message', { signal: AbortSignal.timeout(15000) }));
    children.forEach(child => child.child.send('open'));
    const results = await Promise.all(messages); await Promise.all(children.map(child => child.exited));
    const winner = header(f.root); const accepted = results.filter(([result]) => result.type === 'opened');
    assert.equal(accepted.length, mixed ? 1 : owners.length);
    for (const [result] of accepted) assert.deepEqual(result.header, winner);
    for (const [result] of results.filter(([value]) => value.type !== 'opened')) assert.equal(result.code, 'journal_owner_mismatch');
    assert.equal(winner.schemaVersion, 2); assert.equal(inspectJournalOwnership(f.root, winner.owner), 'owned');
  } finally { await Promise.all(children.map(child => child.close())); f.close(); }
});

for (const stage of ['candidate_synced', 'published', 'directory_synced']) test(`journal owner: actual SIGKILL at header ${stage} safely resumes the same owner`, { timeout: 25000 }, async () => {
  const f = fixture(); const expected = owner(); const marker = join(f.directory, 'boundary.json'); const child = await worker(f.root, expected, stage, marker);
  try {
    child.child.send('open'); const [, signal] = await child.exited;
    assert.equal(signal, 'SIGKILL', child.stderr()); assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { stage, owner: expected });
    const published = stage !== 'candidate_synced'; const before = published ? headerBytes(f.root) : null;
    assert.equal(fs.existsSync(join(f.root, 'format.json')), published);
    assert.equal(inspectJournalOwnership(f.root, expected), published ? 'owned' : 'uninitialized');
    const store = new FileJournalStateRepository(f.root, { owner: expected });
    try {
      if (before) assert.deepEqual(headerBytes(f.root), before);
      assert.deepEqual(header(f.root).owner, expected); assert.equal(await store.get('work-1'), null);
      const request = command(initial(), 'accept'); assert.equal((await store.commit(request)).kind, 'committed');
      assert.equal((await store.commit(request)).kind, 'duplicate');
    } finally { await store.close(); }
  } finally { await child.close(); f.close(); }
});
