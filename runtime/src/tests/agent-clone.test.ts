import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AgentProfileError } from '../application/agent-profile-contracts.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { command, delivery, initial } from './state-conformance-helpers.js';
import type { KnowledgeRecord } from '../domain/knowledge.js';
import type { Delivery } from '../domain/model.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('./helpers/agent-cli-isolated-worker.js', import.meta.url));
const mib = 1024 * 1024;

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-clone-')));
  const engine = join(base, 'engine'); mkdirSync(engine, { mode: 0o700 });
  const store = new FileAgentProfileStore(engine);
  const source = store.initialize(join(base, 'source'), { name: '원본 담당', purpose: '여러 업무에 재사용하는 담당' });
  return { base, engine, registryDirectory: join(base, 'registry'), store, source, destination: join(base, 'copy'), close: () => rmSync(base, { recursive: true, force: true }) };
}
function put(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
type TreeEntry = { path: string; kind: string; mode: number; sha256?: string; target?: string };
function snapshot(root: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const visit = (path: string, name: string) => {
    const stat = lstatSync(path); const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) entries.push({ path: name, kind: 'link', mode, target: readlinkSync(path) });
    else if (stat.isDirectory()) {
      entries.push({ path: name, kind: 'directory', mode });
      for (const child of readdirSync(path).sort()) visit(join(path, child), name ? `${name}/${child}` : child);
    } else if (stat.isFile()) entries.push({ path: name, kind: 'file', mode, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
    else entries.push({ path: name, kind: 'special', mode });
  };
  visit(root, ''); return entries;
}
const privateNote = (): KnowledgeRecord => ({
  id: 'private-note', tenantId: 'tenant-a', namespace: 'private-fixture', scope: 'fixture', authorId: 'person-a',
  kind: 'experience', title: 'Synthetic private memory', body: 'Only the source agent remembers this fixture.', labels: ['synthetic'],
  revision: 1, contentRevision: 1, status: 'active', visibility: 'private', reviewState: 'private', review: null,
  sources: [{ workId: 'private-work', evidenceId: 'fixture-evidence', ownerId: 'person-a', sourceId: 'fixture-source',
    sourceVersion: 'a'.repeat(64), generation: 0, observedAt: 1000, recordedAt: 1000, coverage: 'complete', labels: ['synthetic'] }],
  derivedFrom: [], createdAt: 1000, updatedAt: 1000, expiresAt: null,
});
const privateMessage = (): Delivery => ({ ...delivery('private-work', 'private-ack'), text: 'Synthetic source-only conversation message',
  context: { binding: { id: 'fixture-binding', channel: 'test', conversationId: 'private-conversation', recipientId: 'person-a',
    destination: 'local', tenantId: 'tenant-a', principalId: 'person-a' }, labels: ['synthetic'], sourceRevision: 1,
  responseId: null, evidenceIds: [], evidenceDigest: null, obligationIds: [], artifact: null } });

test('clone creates a fresh identity while preserving reusable configuration and the original files', () => {
  const f = fixture();
  try {
    const identity = f.source.identity;
    const config = { ...f.source.config, identity, storage: { ...f.source.config.storage, state: 'file-journal' as const },
      model: { profile: 'synthetic-internal-model' }, features: { board: true, archive: true }, skills: { mode: 'explicit' as const } };
    put(join(f.source.root, 'config.json'), config);
    const before = snapshot(f.source.root); const startedAt = Date.now();
    const clone = f.store.clone(f.source.root, f.destination, { name: '새 담당' });
    assert.equal(clone.status, 'ready'); assert.notEqual(clone.identity.agentId, identity.agentId);
    assert.ok(clone.identity.createdAt >= startedAt); assert.ok(clone.identity.createdAt > identity.createdAt);
    assert.deepEqual(clone.config, { ...config, identity: clone.identity, name: '새 담당' });
    assert.equal(clone.paths.state, join(f.destination, '.secumon', 'state-journal'));
    assert.equal(clone.modelReady, false); assert.deepEqual(snapshot(f.source.root), before);
  } finally { f.close(); }
});

test('clone copies skill bytes, nested empty directories and executable bits without linking source files', () => {
  const f = fixture();
  try {
    const nested = join(f.source.paths.skills, '한글 지침'); mkdirSync(nested, { mode: 0o700 });
    mkdirSync(join(nested, 'empty'), { mode: 0o700 });
    writeFileSync(join(nested, 'SKILL.md'), '# Synthetic skill\nRead the task before acting.\n', { mode: 0o600 });
    writeFileSync(join(nested, 'fixture.bin'), new Uint8Array([0, 1, 127, 128, 255]), { mode: 0o600 });
    const executable = join(nested, 'helper.sh'); writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 }); chmodSync(executable, 0o700);
    const before = snapshot(f.source.root); const clone = f.store.clone(f.source.root, f.destination);
    assert.equal(clone.config.name, 'copy'); assert.deepEqual(snapshot(clone.paths.skills), snapshot(f.source.paths.skills));
    const copied = join(clone.paths.skills, '한글 지침', 'helper.sh');
    assert.equal(statSync(copied).mode & 0o111, 0o100); assert.equal(statSync(copied).nlink, 1);
    assert.notEqual(statSync(copied).ino, statSync(executable).ino); assert.deepEqual(snapshot(f.source.root), before);
  } finally { f.close(); }
});

test('clone starts with independent empty stores despite source work, memory, conversation and artifacts', async () => {
  const f = fixture(); const source = await openAgentStores(f.store, f.source.root, undefined, { identityRegistryDirectory: f.registryDirectory });
  try {
    const message = privateMessage();
    assert.equal((await source.state.commit(command(initial('private-work'), 'seed-work', [message]))).kind, 'committed');
    assert.equal((await source.knowledge.commit({ expectedRevision: 0, commandId: 'seed-memory', commandDigest: 'synthetic-note', next: privateNote() })).kind, 'committed');
    assert.equal((await source.channel.send(message)).status, 'delivered');
    assert.equal((await source.channel.messages({ tenantId: 'tenant-a', principalId: 'person-a' }, 'test', 'private-conversation')).length, 1);
    const artifact = await source.artifacts.put(new TextEncoder().encode('Source-only synthetic artifact'), { tenantId: 'tenant-a', labels: ['synthetic'], mediaType: 'text/plain' });
    await source.workspace.stage('private-work', 'private-attempt', 'report.txt', new TextEncoder().encode('Source-only report'),
      { tenantId: 'tenant-a', labels: ['synthetic'], lifecycleGeneration: 0 });
    writeFileSync(join(f.source.root, 'memory', 'private.md'), 'Source-only memory document', { mode: 0o600 });
    mkdirSync(join(f.source.root, 'credentials'), { mode: 0o700 });
    put(join(f.source.root, 'credentials', 'fixture.json'), { value: 'synthetic placeholder, not a real credential' });
    writeFileSync(join(f.source.root, '.env'), 'SYNTHETIC_PLACEHOLDER=not-a-real-credential\n', { mode: 0o600 });
    await source.close(); const before = snapshot(f.source.root);
    const clone = f.store.clone(f.source.root, f.destination); const target = await openAgentStores(f.store, clone.root, undefined, { identityRegistryDirectory: f.registryDirectory });
    try {
      assert.equal(await target.state.get('private-work'), null); assert.deepEqual(await target.state.deliveries('private-work'), []);
      assert.equal(await target.knowledge.get('tenant-a', 'private-note'), null);
      assert.deepEqual(await target.channel.messages({ tenantId: 'tenant-a', principalId: 'person-a' }, 'test', 'private-conversation'), []);
      assert.equal(await target.artifacts.exists(artifact), false); assert.deepEqual(await target.workspace.list('private-work', 'private-attempt'), []);
      for (const path of [join(clone.root, 'credentials'), join(clone.root, '.env'), join(clone.root, 'memory', 'private.md')]) assert.equal(existsSync(path), false);
      assert.equal((await target.state.commit(command(initial('private-work'), 'seed-work'))).kind, 'committed');
      assert.equal((await target.knowledge.commit({ expectedRevision: 0, commandId: 'seed-memory', commandDigest: 'target-note',
        next: { ...privateNote(), body: 'Independent target memory' } })).kind, 'committed');
    } finally { await target.close(); }
    assert.deepEqual(snapshot(f.source.root), before);
  } finally { await source.close(); f.close(); }
});

test('ordinary clone never overwrites an existing empty, populated or initialized destination', () => {
  const f = fixture();
  try {
    const populated = join(f.base, 'populated'); const initialized = join(f.base, 'initialized');
    mkdirSync(f.destination, { mode: 0o700 }); mkdirSync(populated, { mode: 0o700 });
    writeFileSync(join(populated, 'keep.txt'), 'Keep existing user data', { mode: 0o600 }); f.store.initialize(initialized);
    const original = snapshot(f.source.root);
    for (const destination of [f.destination, populated, initialized]) {
      const before = snapshot(destination); assert.throws(() => f.store.clone(f.source.root, destination), AgentProfileError);
      assert.deepEqual(snapshot(destination), before);
    }
    assert.deepEqual(snapshot(f.source.root), original);
  } finally { f.close(); }
});

test('clone rejects source overlap, nested agents and engine destinations without changing either tree', () => {
  const f = fixture();
  try {
    const original = snapshot(f.source.root); const engine = snapshot(f.engine);
    for (const destination of [f.source.root, join(f.source.paths.workspace, 'nested'), f.engine, join(f.engine, 'nested'), f.base]) {
      assert.throws(() => f.store.clone(f.source.root, destination), AgentProfileError);
      assert.deepEqual(snapshot(f.source.root), original); assert.deepEqual(snapshot(f.engine), engine);
    }
  } finally { f.close(); }
});

test('clone rejects missing or malformed sources and invalid options without creating a destination', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.clone(join(f.base, 'missing-source'), f.destination), AgentProfileError);
    assert.equal(existsSync(f.destination), false);
    assert.throws(() => f.store.clone(f.source.root, f.destination, { name: '\u0000' }), AgentProfileError);
    assert.equal(existsSync(f.destination), false);
    writeFileSync(join(f.source.root, 'config.json'), '{broken'); const before = snapshot(f.source.root);
    assert.throws(() => f.store.clone(f.source.root, f.destination), AgentProfileError);
    assert.equal(existsSync(f.destination), false); assert.deepEqual(snapshot(f.source.root), before);
  } finally { f.close(); }
});

test('clone rejects skill file and directory symlinks without modifying their outside targets', () => {
  const f = fixture();
  try {
    const outside = join(f.engine, 'outside.txt'); writeFileSync(outside, 'Outside synthetic content', { mode: 0o600 });
    const link = join(f.source.paths.skills, 'linked'); const original = snapshot(f.engine);
    for (const target of [outside, f.engine]) {
      symlinkSync(target, link); const before = snapshot(f.source.root);
      assert.throws(() => f.store.clone(f.source.root, join(f.base, target === outside ? 'file-link-copy' : 'directory-link-copy')), AgentProfileError);
      assert.deepEqual(snapshot(f.source.root), before); assert.deepEqual(snapshot(f.engine), original); unlinkSync(link);
    }
  } finally { f.close(); }
});

test('clone rejects hard-linked skill files and leaves both links unchanged', () => {
  const f = fixture();
  try {
    const outside = join(f.engine, 'outside.txt'); writeFileSync(outside, 'Outside synthetic content', { mode: 0o600 });
    const linked = join(f.source.paths.skills, 'linked.txt'); linkSync(outside, linked); const before = snapshot(f.source.root);
    assert.throws(() => f.store.clone(f.source.root, f.destination), AgentProfileError);
    assert.deepEqual(snapshot(f.source.root), before); assert.equal(readFileSync(outside, 'utf8'), 'Outside synthetic content');
    assert.equal(statSync(outside).nlink, 2); assert.equal(statSync(linked).nlink, 2);
  } finally { f.close(); }
});

test('clone rejects a POSIX FIFO skill instead of blocking on its contents', {
  skip: process.platform === 'win32' ? 'POSIX FIFO fixture; native Windows special-file validation requires its own fixture.' : false,
  timeout: 10000,
}, async () => {
  const f = fixture();
  try {
    const fifo = join(f.source.paths.skills, 'pipe'); execFileSync('mkfifo', [fifo]); chmodSync(fifo, 0o600); const before = snapshot(f.source.root);
    await assert.rejects(execute(process.execPath, [cli, 'clone', '--directory', f.source.root, '--destination', f.destination, '--json'], { timeout: 5000, env: { ...process.env, SECUMON_TEST_IDENTITY_REGISTRY: f.registryDirectory } }),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'stderr' in error && /agent_/.test(String(error.stderr)) && 'killed' in error && !error.killed));
    assert.ok(lstatSync(fifo).isFIFO()); assert.deepEqual(snapshot(f.source.root), before);
  } finally { f.close(); }
});

test('clone permits a four-MiB skill file and rejects a file exceeding that limit', () => {
  const f = fixture();
  try {
    const path = join(f.source.paths.skills, 'bounded.bin'); writeFileSync(path, Buffer.alloc(4 * mib, 7), { mode: 0o600 });
    const clone = f.store.clone(f.source.root, f.destination);
    assert.deepEqual(readFileSync(join(clone.paths.skills, 'bounded.bin')), readFileSync(path));
    writeFileSync(path, Buffer.alloc(4 * mib + 1, 9)); const before = snapshot(f.source.root);
    assert.throws(() => f.store.clone(f.source.root, join(f.base, 'oversized-copy')), AgentProfileError);
    assert.deepEqual(snapshot(f.source.root), before);
  } finally { f.close(); }
});

test('clone enforces snapshot entry, total-byte and directory-depth limits', () => {
  const cases: { name: string; populate: (skills: string) => void }[] = [
    { name: 'more than 512 entries', populate: skills => {
      for (let index = 0; index < 513; index++) writeFileSync(join(skills, `${index}.md`), 'Synthetic skill entry', { mode: 0o600 });
    } },
    { name: 'more than 32 MiB total with bounded individual files', populate: skills => {
      const bytes = Buffer.alloc(4 * mib, 11);
      for (let index = 0; index < 8; index++) writeFileSync(join(skills, `${index}.bin`), bytes, { mode: 0o600 });
      writeFileSync(join(skills, 'overflow.bin'), new Uint8Array([1]), { mode: 0o600 });
    } },
    { name: 'directory depth above sixteen', populate: skills => {
      let path = skills;
      for (let index = 0; index < 17; index++) { path = join(path, `level-${index}`); mkdirSync(path, { mode: 0o700 }); }
      writeFileSync(join(path, 'SKILL.md'), 'Deep synthetic skill', { mode: 0o600 });
    } },
  ];
  for (const scenario of cases) {
    const f = fixture();
    try {
      scenario.populate(f.source.paths.skills); const before = snapshot(f.source.root);
      assert.throws(() => f.store.clone(f.source.root, f.destination), AgentProfileError, scenario.name);
      assert.deepEqual(snapshot(f.source.root), before, scenario.name);
    } finally { f.close(); }
  }
});

test('pending clone rejects changed source skills or config and cannot be completed by ordinary init or repair', () => {
  for (const change of ['skill', 'config'] as const) {
    const f = fixture();
    try {
      writeFileSync(join(f.source.paths.skills, 'SKILL.md'), 'Original synthetic skill', { mode: 0o600 });
      const clone = f.store.clone(f.source.root, f.destination); unlinkSync(join(clone.paths.metadata, 'clone-complete.json'));
      if (change === 'skill') writeFileSync(join(f.source.paths.skills, 'SKILL.md'), 'Changed since clone began');
      else put(join(f.source.root, 'config.json'), { ...f.source.config, purpose: 'Changed since clone began' });
      const targetBefore = snapshot(clone.root); const sourceBefore = snapshot(f.source.root);
      const status = f.store.inspect(clone.root); assert.equal(status.status, 'incomplete');
      assert.equal(status.status === 'incomplete' && status.recovery, 'clone');
      assert.throws(() => f.store.initialize(clone.root), /agent_clone_resume_required/);
      assert.throws(() => f.store.initialize(clone.root, { repair: true }), /agent_clone_resume_required/);
      assert.throws(() => f.store.clone(f.source.root, clone.root, { resume: true }), /agent_clone_source_changed/);
      assert.deepEqual(snapshot(clone.root), targetBefore); assert.deepEqual(snapshot(f.source.root), sourceBefore);
    } finally { f.close(); }
  }
});

test('pending clone preserves target file conflicts instead of overwriting or accepting them', () => {
  for (const conflict of ['changed-skill', 'unexpected-file'] as const) {
    const f = fixture();
    try {
      writeFileSync(join(f.source.paths.skills, 'SKILL.md'), 'Original synthetic skill', { mode: 0o600 });
      const clone = f.store.clone(f.source.root, f.destination); unlinkSync(join(clone.paths.metadata, 'clone-complete.json'));
      if (conflict === 'changed-skill') writeFileSync(join(clone.paths.skills, 'SKILL.md'), 'Preserve the destination edit');
      else writeFileSync(join(clone.root, 'keep.txt'), 'Preserve the unexpected destination file', { mode: 0o600 });
      const targetBefore = snapshot(clone.root); const sourceBefore = snapshot(f.source.root);
      assert.throws(() => f.store.clone(f.source.root, clone.root, { resume: true }), AgentProfileError);
      assert.deepEqual(snapshot(clone.root), targetBefore); assert.deepEqual(snapshot(f.source.root), sourceBefore);
      assert.equal(f.store.inspect(clone.root).status, 'incomplete'); assert.equal(existsSync(join(clone.paths.metadata, 'clone-complete.json')), false);
    } finally { f.close(); }
  }
});

test('finished clone resumes idempotently and ordinary reopen preserves subsequent skill edits', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.source.paths.skills, 'SKILL.md'), 'Original synthetic skill', { mode: 0o600 });
    const clone = f.store.clone(f.source.root, f.destination, { name: 'Independent copy' }); const original = snapshot(f.source.root);
    writeFileSync(join(clone.paths.skills, 'SKILL.md'), 'Edited only in the new agent'); const before = snapshot(clone.root);
    const resumed = f.store.clone(f.source.root, f.destination, { resume: true });
    assert.deepEqual(resumed.identity, clone.identity); assert.equal(resumed.config.name, 'Independent copy');
    assert.deepEqual(f.store.initialize(clone.root).identity, clone.identity); assert.equal(f.store.inspect(clone.root).status, 'ready');
    assert.deepEqual(snapshot(clone.root), before); assert.deepEqual(snapshot(f.source.root), original);
    assert.throws(() => f.store.clone(f.source.root, f.destination), AgentProfileError); assert.deepEqual(snapshot(clone.root), before);
  } finally { f.close(); }
});

test('CLI clone reports the new ready profile and supports explicit completed-clone resume', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.source.paths.skills, 'SKILL.md'), 'CLI synthetic skill', { mode: 0o600 }); const before = snapshot(f.source.root);
    const args = [cli, 'clone', '--directory', f.source.root, '--destination', f.destination, '--name', 'CLI clone', '--json'];
    const clone = JSON.parse((await execute(process.execPath, args, { timeout: 15000, env: { ...process.env, SECUMON_TEST_IDENTITY_REGISTRY: f.registryDirectory } })).stdout);
    assert.equal(clone.status, 'ready'); assert.equal(clone.config.name, 'CLI clone'); assert.notEqual(clone.identity.agentId, f.source.identity.agentId);
    assert.equal(clone.runtimeConnected, false); assert.equal(clone.modelReady, false); assert.equal(clone.storageInitialized, true);
    assert.equal(readFileSync(join(f.destination, 'skills', 'SKILL.md'), 'utf8'), 'CLI synthetic skill');
    const resumed = JSON.parse((await execute(process.execPath, [...args, '--resume'], { timeout: 15000, env: { ...process.env, SECUMON_TEST_IDENTITY_REGISTRY: f.registryDirectory } })).stdout);
    assert.equal(resumed.identity.agentId, clone.identity.agentId);
    await assert.rejects(execute(process.execPath, args, { timeout: 15000, env: { ...process.env, SECUMON_TEST_IDENTITY_REGISTRY: f.registryDirectory } }), /agent_/);
    await assert.rejects(execute(process.execPath, [cli, 'clone', '--directory', f.source.root, '--json'], { timeout: 15000, env: { ...process.env, SECUMON_TEST_IDENTITY_REGISTRY: f.registryDirectory } }), /agent_/);
    assert.deepEqual(snapshot(f.source.root), before);
  } finally { f.close(); }
});
