import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import type { KnowledgeRecord } from '../domain/knowledge.js';
import { ownerScope, personalRecord, storageCommand } from './personal-knowledge-storage-helpers.js';

const worker = fileURLToPath(new URL('./helpers/agent-memory-profile-race-worker.js', import.meta.url));
const posix = process.platform === 'darwin' || process.platform === 'linux';
type Reply = { injections: number; status: string; agentId: string; assignment: string; ready: string; retained: KnowledgeRecord | null; failure: unknown };
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-memory-profile-race-'))), engine = join(base, 'engine');
  mkdirSync(engine, { mode: 0o700 });
  const profiles = new FileAgentProfileStore(engine), profile = profiles.initialize(join(base, 'agent'), { personalMemory: 'documents' });
  const hostOptions = { identityRegistryDirectory: join(base, 'registry') };
  return { base, engine, profiles, profile, hostOptions, assignment: join(profile.paths.metadata, 'personal-memory-profile.json'),
    ready: join(profile.paths.metadata, 'document-memory-ready.json'), close: () => rmSync(base, { recursive: true, force: true }) };
}
function launch(f: ReturnType<typeof fixture>, mode: 'stale-assignment' | 'first-open') {
  const child = spawn(process.execPath, [worker, f.engine, f.profile.root, mode, f.hostOptions.identityRegistryDirectory], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', pending = '', reply: Reply | null = null, observed = false, exited = false, processError: unknown;
  let boundaryResolve!: (value: string) => void, boundaryReject!: (error: Error) => void;
  const boundary = new Promise<string>((resolve, reject) => { boundaryResolve = resolve; boundaryReject = reject; });
  const timer = setTimeout(() => { processError = new Error('memory_profile_race_timeout'); child.kill('SIGKILL'); }, 45000);
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; reply: Reply | null; stdout: string; stderr: string; processError: unknown }>(resolve => {
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      stdout += text; pending += text;
      for (;;) {
        const end = pending.indexOf('\n'); if (end < 0) break;
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const value = JSON.parse(line) as Reply & { type: string; boundary: string };
          if (value.type === 'boundary') { observed = true; boundaryResolve(value.boundary); }
          if (value.type === 'result') reply = value;
        } catch { processError = new Error('invalid_memory_profile_worker_output:' + line); }
      }
    });
    child.stderr.on('data', (text: string) => { stderr += text; });
    child.stdin.on('error', error => { processError ??= error; });
    child.once('error', error => { processError = error; });
    child.once('close', (code, signal) => {
      exited = true; clearTimeout(timer);
      if (!observed) boundaryReject(new Error(JSON.stringify({ reason: 'boundary_not_reached', code, signal, stdout, stderr, processError: String(processError) })));
      resolve({ code, signal, reply, stdout, stderr, processError });
    });
  });
  return { boundary, done, release: () => child.stdin.end('1'), stop: async () => { if (!exited) child.kill('SIGKILL'); await done; clearTimeout(timer); } };
}
function success(result: Awaited<ReturnType<typeof launch>['done']>): Reply {
  const diagnostics = JSON.stringify(result);
  assert.equal(result.code, 0, diagnostics); assert.equal(result.signal, null, diagnostics); assert.equal(result.processError, undefined, diagnostics);
  assert.ok(result.reply, diagnostics); assert.equal(result.reply.failure, null, diagnostics); assert.equal(result.reply.status, 'ready', diagnostics);
  return result.reply;
}

test('first document open reobserves assignment when another process publishes readiness after its initial ENOENT', { skip: !posix, timeout: 60000 }, async () => {
  const f = fixture(), child = launch(f, 'stale-assignment');
  try {
    assert.equal(await child.boundary, 'assignment-observed-missing');
    assert.equal(existsSync(f.assignment), false); assert.equal(existsSync(f.ready), false);
    const stores = await openAgentStores(f.profiles, f.profile.root, undefined, f.hostOptions), record = personalRecord(f.profile.identity.agentId), scope = ownerScope(f.profile.identity.agentId);
    try { assert.equal((await stores.knowledge.commit(storageCommand(record, 'retained-before-resume', scope))).kind, 'committed'); }
    finally { await stores.close(); }
    const assignment = readFileSync(f.assignment, 'utf8'), ready = readFileSync(f.ready, 'utf8');
    child.release(); const result = success(await child.done);
    assert.equal(result.injections, 1); assert.equal(result.agentId, f.profile.identity.agentId); assert.deepEqual(result.retained, record);
    assert.equal(result.assignment, assignment); assert.equal(result.ready, ready);
    assert.equal(readFileSync(f.assignment, 'utf8'), assignment); assert.equal(readFileSync(f.ready, 'utf8'), ready);
    const reopened = await openAgentStores(f.profiles, f.profile.root, undefined, f.hostOptions);
    try {
      assert.deepEqual(await reopened.knowledge.get(record.tenantId, record.id, scope), record);
      assert.deepEqual(await reopened.knowledge.receipt(record.tenantId, record.id, 'retained-before-resume', scope),
        { digest: storageCommand(record, 'retained-before-resume', scope).commandDigest, revision: 1 });
    } finally { await reopened.close(); }
  } finally { await child.stop(); f.close(); }
});

test('simultaneous document first opens converge on the same assignment and readiness without replacing them', { skip: !posix, timeout: 60000 }, async () => {
  const f = fixture(), children = Array.from({ length: 4 }, () => launch(f, 'first-open'));
  try {
    assert.deepEqual(await Promise.all(children.map(child => child.boundary)), Array(4).fill('before-first-open'));
    assert.equal(existsSync(f.assignment), false); assert.equal(existsSync(f.ready), false);
    for (const child of children) child.release();
    const replies = (await Promise.all(children.map(child => child.done))).map(success);
    const assignment = readFileSync(f.assignment, 'utf8'), ready = readFileSync(f.ready, 'utf8');
    for (const reply of replies) {
      assert.equal(reply.injections, 0); assert.equal(reply.agentId, f.profile.identity.agentId); assert.equal(reply.retained, null);
      assert.equal(reply.assignment, assignment); assert.equal(reply.ready, ready);
    }
    const reopened = await openAgentStores(f.profiles, f.profile.root, undefined, f.hostOptions); await reopened.close();
    assert.equal(readFileSync(f.assignment, 'utf8'), assignment); assert.equal(readFileSync(f.ready, 'utf8'), ready);
  } finally { await Promise.all(children.map(child => child.stop())); f.close(); }
});
