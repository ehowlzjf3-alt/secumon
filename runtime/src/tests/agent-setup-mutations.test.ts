import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { AgentSetupOperationSchema } from '../application/agent-profile-contracts.js';

const worker = new URL('./helpers/agent-setup-mutations-worker.js', import.meta.url);
const posix = process.platform === 'linux' || process.platform === 'darwin';
const options = { name: 'mutation-fixture', purpose: 'synthetic setup failure boundaries' };
type Reply = {
  injections: number; openDescriptors: number; profile: { status: string; agentId: string } | null;
  error: null | { code: string | null; message: string; stack?: string; exactInjected: boolean; containsInjected: boolean;
    mutation: null | { operation: string; stage: string; status: { publication: string; created: boolean; fileSynced: boolean; directorySynced: boolean; cleanup: string };
      causeIsInjected: boolean; primaryCauseContainsInjected: boolean;
      errors: Array<{ stage: string; code: string | null; sameInjected: boolean; containsInjected: boolean }> } };
  events: Array<{ operation: string; path: string }>;
  replacement: null | { relocated: string; foreign: string; originalBefore: unknown; originalAfter: unknown; foreignBefore: unknown; foreignAfter: unknown };
};
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-setup-mutations-')));
  const engine = join(base, 'engine'); mkdirSync(engine, { mode: 0o700 });
  writeFileSync(join(engine, 'engine-sentinel.txt'), 'engine is not a setup target', { mode: 0o600 });
  const parent = join(base, 'profiles'); mkdirSync(parent, { mode: 0o755 }); chmodSync(parent, 0o755);
  const root = join(parent, 'agent'); const metadata = join(root, '.secumon');
  return { base, engine, parent, root, metadata, close: () => rmSync(base, { recursive: true, force: true }) };
}
function run(f: ReturnType<typeof fixture>, scenario: string, root = f.root): Reply {
  const child = spawnSync(process.execPath, [fileURLToPath(worker), f.engine, root, scenario], {
    encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(child.status, 0, `${scenario}: ${child.error?.stack ?? ''}\n${child.stdout}\n${child.stderr}`);
  return JSON.parse(child.stdout) as Reply;
}
function operation(f: ReturnType<typeof fixture>) {
  const path = join(f.metadata, 'setup-operation.json'); const bytes = readFileSync(path);
  const parsed = AgentSetupOperationSchema.parse(JSON.parse(bytes.toString('utf8')));
  assert.equal(parsed.kind, 'initialize'); return { path, bytes, value: parsed };
}
function resume(f: ReturnType<typeof fixture>, before: ReturnType<typeof operation>) {
  const profiles = new FileAgentProfileStore(f.engine); const ready = profiles.initialize(f.root, options);
  assert.equal(ready.status, 'ready'); assert.deepEqual(ready.identity, before.value.identity);
  assert.deepEqual(readFileSync(before.path), before.bytes);
  assert.equal(operation(f).value.operationId, before.value.operationId);
  assert.deepEqual(profiles.initialize(f.root, options), ready);
  return ready;
}

test('setup mutations: a new private root syncs its unchanged 0755 parent before publishing ownership', { skip: !posix }, () => {
  const f = fixture(); try {
    const parentIdentity = lstatSync(f.parent); const reply = run(f, 'normal');
    assert.equal(reply.error, null); assert.equal(reply.profile?.status, 'ready'); assert.equal(reply.openDescriptors, 0);
    assert.equal(lstatSync(f.parent).mode & 0o777, 0o755); assert.equal(lstatSync(f.parent).ino, parentIdentity.ino);
    assert.equal(lstatSync(f.root).mode & 0o777, 0o700); assert.equal(lstatSync(f.metadata).mode & 0o777, 0o700);
    const created = reply.events.findIndex(entry => entry.operation === 'mkdir' && entry.path === f.root);
    const synced = reply.events.findIndex((entry, index) => index > created && entry.operation === 'fsync' && entry.path === f.parent);
    const published = reply.events.findIndex(entry => entry.operation === 'link' && entry.path === join(f.metadata, 'setup-operation.json'));
    assert.ok(created >= 0 && synced > created && published > synced, JSON.stringify(reply.events));
  } finally { f.close(); }
});

test('setup mutations: a failed new-root parent barrier reports creation uncertainty and a retry finishes the existing directory', { skip: !posix }, () => {
  const f = fixture(); try {
    const reply = run(f, 'root-parent-sync-failure');
    assert.equal(reply.injections, 1); assert.equal(reply.openDescriptors, 0);
    assert.equal(reply.error?.code, 'agent_directory_create_unknown', JSON.stringify(reply.error)); assert.ok(reply.error);
    assert.equal(reply.error.containsInjected, true); const fault = reply.error.mutation; assert.ok(fault);
    assert.equal(fault.operation, 'directory'); assert.equal(fault.status.created, true);
    assert.equal(fault.status.directorySynced, false); assert.equal(fault.primaryCauseContainsInjected, true);
    assert.ok(fault.errors.some(entry => entry.containsInjected));
    assert.equal(lstatSync(f.parent).mode & 0o777, 0o755); const created = lstatSync(f.root);
    assert.deepEqual(readdirSync(f.root), []);
    // No operation was published yet, so no durable identity is assumed for the failed call.
    const ready = new FileAgentProfileStore(f.engine).initialize(f.root, options);
    assert.equal(ready.status, 'ready'); assert.equal(lstatSync(f.root).ino, created.ino);
    assert.equal(operation(f).value.identity.agentId, ready.identity.agentId);
  } finally { f.close(); }
});

for (const scenario of ['write-failure', 'file-sync-failure']) {
  test(`setup mutations: ${scenario} before identity publication preserves the original I/O cause and resumes the same operation`, { skip: !posix }, () => {
    const f = fixture(); try {
      const reply = run(f, scenario);
      assert.equal(reply.injections, 1); assert.equal(reply.openDescriptors, 0);
      assert.equal(reply.error?.code, 'EIO'); assert.equal(reply.error?.exactInjected, true, JSON.stringify(reply.error));
      assert.ok(reply.error);
      assert.equal(reply.error.containsInjected, true); assert.equal(existsSync(join(f.metadata, 'identity.json')), false);
      assert.equal(existsSync(join(f.root, 'config.json')), false);
      const before = operation(f);
      assert.deepEqual(readdirSync(f.metadata), ['setup-operation.json']);
      resume(f, before);
    } finally { f.close(); }
  });
}

for (const scenario of ['link-after-failure', 'unlink-failure', 'directory-sync-failure']) {
  test(`setup mutations: ${scenario} reports published uncertainty with the original cause and can re-observe the same identity`, { skip: !posix }, () => {
    const f = fixture(); try {
      const reply = run(f, scenario);
      assert.equal(reply.injections, 1); assert.equal(reply.openDescriptors, 0);
      assert.equal(reply.error?.code, 'agent_metadata_publish_unknown', JSON.stringify(reply.error));
      assert.ok(reply.error);
      assert.equal(reply.error.containsInjected, true);
      const fault = reply.error.mutation; assert.ok(fault); assert.equal(fault.operation, 'publish');
      assert.ok(['published', 'unknown'].includes(fault.status.publication)); assert.equal(fault.status.fileSynced, true);
      if (scenario === 'directory-sync-failure') {
        assert.equal(fault.primaryCauseContainsInjected, true); assert.ok(fault.errors.some(entry => entry.containsInjected));
      } else {
        assert.equal(fault.causeIsInjected, true); assert.ok(fault.errors.some(entry => entry.sameInjected && entry.code === 'EIO'));
      }
      const before = operation(f); const identityPath = join(f.metadata, 'identity.json'); const identityBytes = readFileSync(identityPath);
      assert.deepEqual(JSON.parse(identityBytes.toString('utf8')), before.value.identity);
      assert.equal(existsSync(join(f.root, 'config.json')), false);
      if (scenario === 'unlink-failure') {
        assert.equal(fault.status.cleanup, 'retained'); assert.equal(fault.status.directorySynced, true);
        const failedAt = reply.events.findIndex(entry => entry.operation === 'injected');
        assert.ok(reply.events.some((entry, index) => index > failedAt && entry.operation === 'fsync' && entry.path === f.metadata));
        const pending = readdirSync(f.metadata).filter(name => name.endsWith('.pending')); assert.equal(pending.length, 1);
        assert.equal(lstatSync(join(f.metadata, pending[0]!)).ino, lstatSync(identityPath).ino);
      }
      if (scenario === 'directory-sync-failure') {
        assert.equal(fault.status.cleanup, 'removed'); assert.equal(fault.status.directorySynced, false);
      }
      resume(f, before); assert.deepEqual(readFileSync(identityPath), identityBytes);
    } finally { f.close(); }
  });
}

for (const scenario of ['swap-parent', 'swap-root', 'swap-metadata']) {
  test(`setup mutations: ${scenario} after a candidate fsync rejects substitution without cleaning foreign names`, { skip: !posix }, () => {
    const f = fixture(); try {
      const reply = run(f, scenario);
      assert.equal(reply.injections, 1); assert.equal(reply.openDescriptors, 0);
      assert.ok(reply.error, 'a substituted setup scope must never return ready'); assert.equal(reply.profile, null);
      assert.ok(reply.replacement);
      assert.deepEqual(reply.replacement.originalAfter, reply.replacement.originalBefore);
      assert.deepEqual(reply.replacement.foreignAfter, reply.replacement.foreignBefore);
      assert.equal(existsSync(join(f.root, 'config.json')), false);
      assert.deepEqual(readdirSync(f.engine), ['engine-sentinel.txt']);
    } finally { f.close(); }
  });
}

test('setup mutations: the engine boundary rejects before any mutation scope can create a target', { skip: !posix }, () => {
  const f = fixture(); try {
    const target = join(f.engine, 'inner'); const before = readFileSync(join(f.engine, 'engine-sentinel.txt'));
    const reply = run(f, 'engine', target);
    assert.equal(reply.error?.code, 'agent_engine_overlap'); assert.equal(reply.openDescriptors, 0);
    assert.equal(existsSync(target), false);
    assert.equal(reply.events.some(entry => ['mkdir', 'write', 'link', 'unlinked'].includes(entry.operation)), false);
    assert.deepEqual(readFileSync(join(f.engine, 'engine-sentinel.txt')), before);
  } finally { f.close(); }
});

async function interrupt(f: ReturnType<typeof fixture>, boundary: string) {
  const child = fork(worker, [f.engine, f.root, boundary], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; let timedOut = false;
  child.stderr!.on('data', value => { stderr = (stderr + String(value)).slice(-8000); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15000);
  const nextMessage = () => new Promise<unknown>((resolve, reject) => {
    const cleanup = () => { child.off('message', received); child.off('exit', exited); child.off('error', failed); };
    const received = (value: unknown) => { cleanup(); resolve(value); };
    const exited = () => { cleanup(); reject(new Error(`setup_mutation_worker_exited_before_boundary:${timedOut}:${stderr}`)); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    child.once('message', received); child.once('exit', exited); child.once('error', failed);
  });
  try {
    assert.deepEqual(await nextMessage(), { type: 'ready' }, stderr);
    const reached = nextMessage();
    const sent = new Promise<void>((resolve, reject) => child.send({ type: 'initialize' }, error => error ? reject(error) : resolve()));
    const [message] = await Promise.all([reached, sent]);
    assert.deepEqual(message, { type: 'boundary', boundary }, stderr); assert.equal(timedOut, false);
    assert.equal(child.kill('SIGKILL'), true); const stopped = await closed;
    assert.equal(stopped.code, null); assert.equal(stopped.signal, 'SIGKILL', stderr);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}

for (const boundary of ['kill-identity-synced', 'kill-config-linked', 'kill-receipt-linked']) {
  test(`setup mutations: actual SIGKILL at ${boundary} preserves the published operation and resumes without reallocating identity`, { skip: !posix, timeout: 25000 }, async () => {
    const f = fixture(); try {
      await interrupt(f, boundary);
      const before = operation(f);
      const pendingParent = boundary === 'kill-config-linked' ? f.root : f.metadata;
      const pending = readdirSync(pendingParent).filter(name => /^\.secumon-init-[a-f0-9-]+\.pending$/.test(name));
      assert.equal(pending.length, 1);
      const candidate = join(pendingParent, pending[0]!); const candidateBytes = readFileSync(candidate);
      assert.equal(lstatSync(candidate).mode & 0o077, 0);
      const final = boundary === 'kill-identity-synced' ? join(f.metadata, 'identity.json')
        : boundary === 'kill-config-linked' ? join(f.root, 'config.json') : join(f.metadata, 'setup.json');
      if (boundary === 'kill-identity-synced') {
        assert.equal(existsSync(final), false); assert.equal(lstatSync(candidate).nlink, 1);
        assert.deepEqual(JSON.parse(candidateBytes.toString('utf8')), before.value.identity);
      } else {
        assert.equal(lstatSync(candidate).nlink, 2); assert.equal(lstatSync(final).ino, lstatSync(candidate).ino);
        assert.deepEqual(readFileSync(final), candidateBytes);
      }
      const interrupted = new FileAgentProfileStore(f.engine).inspect(f.root);
      assert.equal(interrupted.status, boundary === 'kill-receipt-linked' ? 'ready' : 'incomplete');
      resume(f, before);
      if (boundary !== 'kill-identity-synced') assert.deepEqual(readFileSync(final), candidateBytes);
    } finally { f.close(); }
  });
}
