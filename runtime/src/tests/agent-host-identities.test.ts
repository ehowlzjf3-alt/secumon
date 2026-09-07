import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { claimAgentHostIdentity, inspectAgentHostIdentity, type AgentHostIdentityOptions, type AgentHostIdentityHead } from '../infrastructure/agent-host-identities.js';
import { hostMetadataFiles, releaseMetadataDirectory } from '../infrastructure/host-metadata-files.js';
import type { FilePublicationResult } from '../infrastructure/host-file-mutations.js';

const worker = fileURLToPath(new URL('./helpers/agent-host-identities-worker.js', import.meta.url));
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-host-identities-'))), engine = join(base, 'engine');
  mkdirSync(engine, { mode: 0o700 });
  const store = new FileAgentProfileStore(engine), profile = store.initialize(join(base, 'agent'), { name: '등록 시험 담당' });
  writeFileSync(join(profile.root, 'original.md'), 'Synthetic original agent data; preserve these bytes.\n', { mode: 0o600 });
  const registry = join(base, 'host-registry'), options: AgentHostIdentityOptions = { registryDirectory: registry, engineDirectories: [engine] };
  return { base, engine, store, profile, registry, options,
    records: join(registry, profile.identity.agentId.toLowerCase()), close: () => rmSync(base, { recursive: true, force: true }) };
}
function tree(root: string) {
  const entries: Array<{ path: string; mode: number; kind: 'file' | 'directory'; sha256: string | null }> = [];
  const visit = (path: string, name: string) => {
    const stat = lstatSync(path); assert.equal(stat.isSymbolicLink(), false);
    assert.ok(stat.isDirectory() || stat.isFile());
    entries.push({ path: name, mode: stat.mode & 0o777, kind: stat.isDirectory() ? 'directory' : 'file',
      sha256: stat.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : null });
    if (stat.isDirectory()) for (const child of readdirSync(path).sort()) visit(join(path, child), name ? `${name}/${child}` : child);
  };
  visit(root, ''); return entries;
}
function copyProfile(source: string, destination: string): void {
  const original = tree(source);
  cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
  // The duplicate-ID fixture must retain the source's private metadata modes, not fail an earlier permission check.
  for (const entry of original) chmodSync(entry.path ? join(destination, entry.path) : destination, entry.mode);
  assert.deepEqual(tree(destination), original); assert.deepEqual(tree(source), original);
}
function objectIdentity(path: string) {
  const files = hostMetadataFiles(), ref = files.inspectDirectory(path, 'owner-writable'); assert.ok(ref);
  try { return { ...ref.identity }; } finally { releaseMetadataDirectory(files, ref); }
}
function register(f: ReturnType<typeof fixture>): AgentHostIdentityHead {
  const claim = claimAgentHostIdentity(f.profile, f.options);
  try { claim.assertCurrent(); return { record: claim.record, digest: claim.digest }; } finally { claim.close(); }
}
type Reply = { root: string; entered: number; publication: FilePublicationResult | null; head: AgentHostIdentityHead | null;
  failure: { name: string; message: string; code: string | null } | null };
function start(args: string[]) {
  let resolveResult!: (value: { stdout: string; stderr: string }) => void, rejectResult!: (error: Error) => void;
  const completed = new Promise<{ stdout: string; stderr: string }>((yes, no) => { resolveResult = yes; rejectResult = no; });
  const child = execFile(process.execPath, [worker, ...args], { timeout: 25000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, encoding: 'utf8' },
    (error, stdout, stderr) => error ? rejectResult(Object.assign(error, { stdout, stderr })) : resolveResult({ stdout, stderr }));
  void completed.catch(() => {}); return { child, completed };
}
async function race(f: ReturnType<typeof fixture>, roots: readonly [string, string]): Promise<Reply[]> {
  const control = join(f.base, 'barrier'); mkdirSync(control, { mode: 0o700 });
  const jobs = roots.map((root, index) => start([f.engine, root, f.registry, control, String(index)]));
  async function waitFor(stage: string) {
    const deadline = performance.now() + 10000;
    while (![0, 1].every(index => existsSync(join(control, `${stage}-${index}.json`)))) {
      const ended = jobs.find(job => job.child.exitCode !== null || job.child.signalCode !== null);
      if (ended) { const output = await ended.completed; assert.fail(`claim exited before ${stage}: ${output.stdout}\n${output.stderr}`); }
      if (performance.now() >= deadline) assert.fail(`claim barrier timed out: ${stage}`);
      await delay(10);
    }
  }
  try {
    await waitFor('before');
    assert.equal(existsSync(join(f.records, '00000001.json')), false, 'both contenders must reach the actual first publication');
    writeFileSync(join(control, 'publish.go'), '', { mode: 0o600, flag: 'wx' });
    await waitFor('after');
    const observations = [0, 1].map(index => JSON.parse(readFileSync(join(control, `after-${index}.json`), 'utf8')));
    assert.ok(observations.every(value => value.failure === null), JSON.stringify(observations));
    assert.deepEqual(observations.map(value => value.publication.published).sort(), [false, true]);
    assert.deepEqual(readdirSync(f.records), ['00000001.json'], 'no pending file or second registration may remain');
    writeFileSync(join(control, 'inspect.go'), '', { mode: 0o600, flag: 'wx' });
    const replies = await Promise.all(jobs.map(async job => {
      const { stdout, stderr } = await job.completed;
      const reply = JSON.parse(stdout) as Reply; assert.equal(reply.entered, 1, `${stdout}\n${stderr}`); return reply;
    }));
    return replies;
  } finally {
    for (const job of jobs) if (job.child.exitCode === null && job.child.signalCode === null) job.child.kill('SIGKILL');
    await Promise.allSettled(jobs.map(job => job.completed));
  }
}

test('unregistered inspection creates neither registry parents nor an agent registration', () => {
  const f = fixture(); try {
    const before = tree(f.base);
    for (const registry of [f.registry, join(f.base, 'missing-parent', 'registry')]) {
      assert.equal(inspectAgentHostIdentity(f.profile, { ...f.options, registryDirectory: registry }), null);
      assert.deepEqual(tree(f.base), before);
    }
    mkdirSync(f.registry, { mode: 0o700 }); const existing = tree(f.base);
    assert.equal(inspectAgentHostIdentity(f.profile, f.options), null); assert.deepEqual(tree(f.base), existing);
  } finally { f.close(); }
});

test('claim and same-object reopen preserve original data and the immutable registration', () => {
  const f = fixture(); try {
    const original = tree(f.profile.root), first = claimAgentHostIdentity(f.profile, f.options);
    const record = readFileSync(join(f.records, '00000001.json'));
    try {
      assert.deepEqual(first.record.identity, f.profile.identity); assert.equal(first.record.sequence, 1); assert.equal(first.record.previous, null);
      assert.deepEqual(first.record.rootIdentity, objectIdentity(f.profile.root)); assert.deepEqual(first.record.reason, { kind: 'claim' });
      assert.equal(first.digest, createHash('sha256').update(record).digest('hex'));
      const second = claimAgentHostIdentity(f.profile, f.options);
      try { second.assertCurrent(); assert.deepEqual({ record: second.record, digest: second.digest }, { record: first.record, digest: first.digest }); }
      finally { second.close(); }
      first.assertCurrent(); assert.deepEqual(tree(f.profile.root), original); assert.deepEqual(readFileSync(join(f.records, '00000001.json')), record);
      assert.deepEqual(readdirSync(f.records), ['00000001.json']);
    } finally { first.close(); first.close(); }
    assert.throws(() => first.assertCurrent(), /agent_host_identity_closed/);
  } finally { f.close(); }
});

test('renaming the same directory permits a new claim while invalidating the old path claim', () => {
  const f = fixture(); try {
    const before = tree(f.profile.root), originalObject = objectIdentity(f.profile.root), first = claimAgentHostIdentity(f.profile, f.options);
    const moved = join(f.base, 'renamed-agent');
    try {
      renameSync(f.profile.root, moved); assert.throws(() => first.assertCurrent(), /agent_host_identity_directory_changed/);
    } finally { first.close(); }
    const profile = f.store.initialize(moved), reopened = claimAgentHostIdentity(profile, f.options);
    try {
      reopened.assertCurrent(); assert.equal(reopened.record.registeredRoot, f.profile.root);
      assert.deepEqual(reopened.record.rootIdentity, originalObject); assert.deepEqual(profile.identity, f.profile.identity);
      assert.deepEqual(tree(moved), before); assert.equal(existsSync(f.profile.root), false);
      assert.deepEqual(readdirSync(f.records), ['00000001.json']);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('a full folder copy can inspect the old head but cannot claim it or alter either source', () => {
  const f = fixture(); try {
    const head = register(f), copy = join(f.base, 'manual-copy'); copyProfile(f.profile.root, copy);
    const original = tree(f.profile.root), copied = tree(copy), registry = tree(f.registry), profile = f.store.inspect(copy); assert.equal(profile.status, 'ready');
    if (profile.status !== 'ready') return assert.fail('copy fixture must remain a valid complete profile');
    assert.notDeepEqual(objectIdentity(copy), head.record.rootIdentity);
    assert.deepEqual(inspectAgentHostIdentity(profile, f.options), head);
    assert.throws(() => claimAgentHostIdentity(profile, f.options), /agent_host_identity_duplicate_identity/);
    assert.deepEqual(tree(f.profile.root), original); assert.deepEqual(tree(copy), copied); assert.deepEqual(tree(f.registry), registry);
    assert.deepEqual(register(f), head);
  } finally { f.close(); }
});

test('two processes claiming the same unregistered object share the one actual CAS winner', { timeout: 35000 }, async () => {
  const f = fixture(); try {
    const before = tree(f.profile.root), replies = await race(f, [f.profile.root, f.profile.root]);
    assert.ok(replies.every(reply => reply.failure === null && reply.head !== null), JSON.stringify(replies));
    assert.deepEqual(replies[0]!.head, replies[1]!.head);
    assert.deepEqual(inspectAgentHostIdentity(f.profile, f.options), replies[0]!.head);
    assert.deepEqual(tree(f.profile.root), before); assert.deepEqual(readdirSync(f.records), ['00000001.json']);
  } finally { f.close(); }
});

test('two processes claiming copied objects admit only the actual no-replace winner', { timeout: 35000 }, async () => {
  const f = fixture(); try {
    const copy = join(f.base, 'manual-copy'); copyProfile(f.profile.root, copy);
    const original = tree(f.profile.root), copied = tree(copy), replies = await race(f, [f.profile.root, copy]);
    const winner = replies.find(reply => reply.publication?.published === true), loser = replies.find(reply => reply.publication?.published === false);
    assert.ok(winner); assert.ok(loser); assert.equal(winner.failure, null); assert.ok(winner.head); assert.equal(loser.head, null);
    assert.equal(loser.failure?.code, 'agent_host_identity_claim_conflict');
    assert.deepEqual(winner.head.record.rootIdentity, objectIdentity(winner.root));
    const saved = readFileSync(join(f.records, '00000001.json'));
    assert.equal(createHash('sha256').update(saved).digest('hex'), winner.head.digest);
    const loserProfile = f.store.inspect(loser.root); assert.equal(loserProfile.status, 'ready');
    if (loserProfile.status !== 'ready') return assert.fail('loser source must remain ready');
    assert.throws(() => claimAgentHostIdentity(loserProfile, f.options), /agent_host_identity_duplicate_identity/);
    assert.deepEqual(tree(f.profile.root), original); assert.deepEqual(tree(copy), copied); assert.deepEqual(readFileSync(join(f.records, '00000001.json')), saved);
  } finally { f.close(); }
});

test('a stalled publication and a corrupted registration are preserved and rejected', () => {
  const f = fixture(); try {
    const claim = claimAgentHostIdentity(f.profile, f.options), path = join(f.records, '00000001.json'), original = tree(f.profile.root);
    try {
      const pending = join(f.records, '.secumon-init-00000000-0000-4000-8000-000000000000.pending');
      const bytes = readFileSync(path); writeFileSync(pending, bytes, { mode: 0o600, flag: 'wx' }); const stalled = tree(f.registry);
      const started = performance.now();
      assert.throws(() => claimAgentHostIdentity(f.profile, f.options), /agent_host_identity_publication_incomplete/);
      assert.ok(performance.now() - started < 5000, 'a leftover candidate must stop waiting within a finite bound');
      assert.deepEqual(tree(f.registry), stalled); assert.deepEqual(tree(f.profile.root), original);
      unlinkSync(pending); // Only the test owner removes its stalled fixture; the production call must preserve it.
      claim.assertCurrent(); assert.deepEqual(readFileSync(path), bytes);
      writeFileSync(path, '{corrupted registration', { mode: 0o600 }); const corrupted = tree(f.registry);
      assert.throws(() => inspectAgentHostIdentity(f.profile, f.options), SyntaxError);
      assert.throws(() => claimAgentHostIdentity(f.profile, f.options), SyntaxError);
      assert.throws(() => claim.assertCurrent(), SyntaxError);
      assert.deepEqual(tree(f.registry), corrupted); assert.deepEqual(tree(f.profile.root), original);
    } finally { claim.close(); }
  } finally { f.close(); }
});

test('a missing sequence is rejected without repairing or adopting the remaining record', () => {
  const f = fixture(); try {
    register(f); renameSync(join(f.records, '00000001.json'), join(f.records, '00000002.json')); const before = tree(f.base);
    assert.throws(() => inspectAgentHostIdentity(f.profile, f.options), /agent_host_identity_history_invalid/);
    assert.throws(() => claimAgentHostIdentity(f.profile, f.options), /agent_host_identity_history_invalid/);
    assert.deepEqual(tree(f.base), before);
  } finally { f.close(); }
});

test('replacing the held registration object with identical bytes fails its current check', () => {
  const f = fixture(); try {
    const claim = claimAgentHostIdentity(f.profile, f.options), path = join(f.records, '00000001.json'), saved = join(f.base, 'original-head.json');
    try {
      const bytes = readFileSync(path); renameSync(path, saved); writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
      const before = tree(f.base); assert.throws(() => claim.assertCurrent(), /agent_host_identity_registration_changed/);
      assert.deepEqual(readFileSync(saved), bytes); assert.deepEqual(readFileSync(path), bytes); assert.deepEqual(tree(f.base), before);
    } finally { claim.close(); }
  } finally { f.close(); }
});

test('replacing the held identity file with identical bytes cannot retain its source binding', () => {
  const f = fixture(); try {
    const claim = claimAgentHostIdentity(f.profile, f.options), path = join(f.profile.root, '.secumon', 'identity.json');
    try {
      const bytes = readFileSync(path), saved = join(f.base, 'original-identity.json'); renameSync(path, saved);
      writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' }); const before = tree(f.base);
      assert.throws(() => claim.assertCurrent(), /agent_host_identity_source_changed/);
      assert.deepEqual(tree(f.base), before); assert.deepEqual(readFileSync(saved), bytes);
    } finally { claim.close(); }
  } finally { f.close(); }
});

test('the same agent ID with a different creation identity cannot reuse an existing registration', () => {
  const f = fixture(); try {
    register(f); const copy = join(f.base, 'different-creation'); copyProfile(f.profile.root, copy);
    const identity = { ...f.profile.identity, createdAt: f.profile.identity.createdAt + 1 };
    writeFileSync(join(copy, '.secumon', 'identity.json'), JSON.stringify(identity), { mode: 0o600 });
    const subject = { root: copy, identity }, before = tree(f.base);
    assert.throws(() => inspectAgentHostIdentity(subject, f.options), /agent_host_identity_history_invalid/);
    assert.throws(() => claimAgentHostIdentity(subject, f.options), /agent_host_identity_history_invalid/);
    assert.deepEqual(tree(f.base), before);
  } finally { f.close(); }
});

test('registry, agent and engine overlap is rejected in either direction before a write', () => {
  const f = fixture(); try {
    const before = tree(f.base);
    const options: AgentHostIdentityOptions[] = [
      ...[f.profile.root, join(f.profile.root, 'registry'), f.base, f.engine, join(f.engine, 'registry')]
        .map(registryDirectory => ({ registryDirectory, engineDirectories: [f.engine] })),
      { registryDirectory: f.registry, engineDirectories: [f.profile.root] },
      { registryDirectory: f.registry, engineDirectories: [join(f.profile.root, 'skills')] },
      { registryDirectory: f.registry, engineDirectories: [f.base] },
    ];
    for (const option of options) {
      assert.throws(() => claimAgentHostIdentity(f.profile, option), /agent_host_identity_directory_overlap/);
      assert.throws(() => inspectAgentHostIdentity(f.profile, option), /agent_host_identity_directory_overlap/);
      assert.deepEqual(tree(f.base), before);
    }
  } finally { f.close(); }
});

test('the real clone operation receives a new ID and an independent first registration', () => {
  const f = fixture(); try {
    const sourceHead = register(f), original = tree(f.profile.root), sourceRecord = readFileSync(join(f.records, '00000001.json'));
    const clone = f.store.clone(f.profile.root, join(f.base, 'explicit-clone')), claim = claimAgentHostIdentity(clone, f.options);
    try {
      assert.notEqual(clone.identity.agentId, f.profile.identity.agentId); assert.deepEqual(claim.record.identity, clone.identity);
      assert.equal(claim.record.sequence, 1); assert.equal(claim.record.previous, null); claim.assertCurrent();
      assert.deepEqual(claim.record.rootIdentity, objectIdentity(clone.root)); assert.notDeepEqual(claim.record.rootIdentity, sourceHead.record.rootIdentity);
      assert.deepEqual(inspectAgentHostIdentity(f.profile, f.options), sourceHead);
      assert.deepEqual(readdirSync(f.registry).sort(), [f.profile.identity.agentId.toLowerCase(), clone.identity.agentId.toLowerCase()].sort());
      assert.deepEqual(tree(f.profile.root), original); assert.deepEqual(readFileSync(join(f.records, '00000001.json')), sourceRecord);
    } finally { claim.close(); }
  } finally { f.close(); }
});
