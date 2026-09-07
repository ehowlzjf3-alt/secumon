import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpCallError, McpStdioClient, type McpStdioConfig } from '../infrastructure/mcp-stdio-client.js';
import { sha256 } from '../infrastructure/digest.js';
import { evaluationCodePin } from '../infrastructure/local-evaluation.js';
import { MCP_FIXTURE_TOOLS, MCP_FIXTURE_DOCUMENTS_TOOL, type McpFixtureAudit, type McpFixtureMode } from './helpers/mcp-fixture-contracts.js';

const server = fileURLToPath(new URL('./helpers/mcp-fixture-server.js', import.meta.url));
const signal = () => new AbortController().signal;
const noop = async () => {};
const evidenceDirectory = process.env['SECUMON_MCP_EVIDENCE_DIR'];
const codeDigest = evidenceDirectory ? (await evaluationCodePin(process.cwd())).digest : null;
const isFailure = (sent: boolean, code?: string) => (error: unknown) => error instanceof McpCallError && error.sent === sent && (!code || error.code === code);
async function fixture(testName: string, mode: McpFixtureMode = 'normal', overrides: Partial<McpStdioConfig> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-client-')); const auditFile = join(directory, 'audit.jsonl');
  const client = new McpStdioClient({ endpointId: 'local-fixture', command: process.execPath,
    args: [server, '--audit-file', auditFile, '--mode', mode, '--delay-ms', '350'], cwd: directory,
    env: { TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir() }, timeoutMs: 10000, ...overrides });
  const audit = async (): Promise<McpFixtureAudit[]> => {
    try { return (await readFile(auditFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as McpFixtureAudit); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  const until = async (event: McpFixtureAudit['event']) => {
    const deadline = Date.now() + 10000;
    while (!(await audit()).some(record => record.event === event)) {
      if (Date.now() >= deadline) throw new Error(`missing_fixture_${event}`);
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  };
  return { client, directory, auditFile, audit, until, async close() {
    const beforeClose = client.snapshot(); await client.close(); const records = await audit();
    if (beforeClose.pid !== null) assert.throws(() => process.kill(beforeClose.pid!, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
    await rm(directory, { recursive: true, force: true }); await assert.rejects(stat(directory), { code: 'ENOENT' });
    if (evidenceDirectory) {
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(join(evidenceDirectory, `${sha256(JSON.stringify([testName, mode, overrides])).slice(0, 20)}-transport.json`),
        JSON.stringify({ codeDigest, test: testName, mode, beforeClose, snapshot: client.snapshot(), audit: records,
          shutdown: { pid: beforeClose.pid, ownedProcessStopped: true, temporaryFilesCleaned: true } }, null, 2) + '\n');
    }
  } };
}

test('MCP client: invalid host process configuration is rejected without starting a child', async () => {
  const base = { endpointId: 'fixture', command: process.execPath, cwd: tmpdir(), args: [] };
  for (const override of [{ command: 'node' }, { cwd: '.' }, { maxConcurrent: 0 }, { maxListPages: 0 }, { args: ['bad\0arg'] },
    { maxMessageBytes: 5 * 1024 * 1024 }, { env: { 'INVALID-NAME': 'value' } }]) {
    assert.throws(() => new McpStdioClient({ ...base, ...override }), isFailure(false, 'mcp_config_invalid'));
  }
  const client = new McpStdioClient(base); await client.close(); await client.close();
  assert.equal(client.snapshot().processStarts, 0); assert.equal(client.snapshot().pid, null);
  await assert.rejects(client.discover(MCP_FIXTURE_TOOLS, signal()), isFailure(false, 'mcp_closed'));
});

test('MCP fixture: explicit temporary root permits descendants and rejects outside and prefix-sibling paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-audit-boundary-'));
  const temporaryRoot = join(directory, 'allowed');
  const nested = join(temporaryRoot, 'nested');
  const outside = join(directory, 'outside');
  const sibling = join(directory, 'allowed-sibling');
  try {
    for (const path of [temporaryRoot, nested, outside, sibling]) await mkdir(path);
    for (const [parent, permitted] of [[nested, true], [outside, false], [sibling, false]] as const) {
      const auditFile = join(parent, 'audit.jsonl');
      const client = new McpStdioClient({ endpointId: 'audit-boundary-fixture', command: process.execPath,
        args: [server, '--audit-file', auditFile], cwd: directory,
        env: { TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot }, timeoutMs: 10000 });
      try {
        if (permitted) {
          await client.discover(MCP_FIXTURE_TOOLS, signal());
          assert.ok((await readFile(auditFile, 'utf8')).split('\n').filter(Boolean).some(line => JSON.parse(line).event === 'start'));
        } else {
          await assert.rejects(client.discover(MCP_FIXTURE_TOOLS, signal()), isFailure(false));
          await assert.rejects(stat(auditFile), { code: 'ENOENT' });
        }
      } finally { await client.close(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('MCP client: real pinned stdio discovery and repeated reads each make one fresh call', async t => {
  const h = await fixture(t.name);
  try {
    const session = await h.client.discover(MCP_FIXTURE_TOOLS, signal());
    assert.equal(session.protocolVersion, '2026-07-28'); assert.match(session.discoveryDigest, /^[0-9a-f]{64}$/);
    const first = await h.client.call(session, 'documents.read', { id: 'good' }, { signal: signal(), authorize: noop });
    const second = await h.client.call(session, 'documents.read', { id: 'good' }, { signal: signal(), authorize: noop });
    assert.equal(first.transportCalls, 1); assert.equal(second.transportCalls, 1);
    assert.equal((first.value as Record<string, unknown>)['resultType'], undefined); // SDK validates then removes the wire discriminator.
    assert.equal(((first.value as Record<string, unknown>)['structuredContent'] as Record<string, unknown>)['value'], 30);
    const records = await h.audit(); assert.equal(records.filter(record => record.event === 'call').length, 2);
    assert.equal(h.client.snapshot().toolCalls, 2); assert.equal(h.client.snapshot().processStarts, 1);
    assert.equal(h.client.snapshot().listPages, 1);
    assert.ok(h.client.snapshot().requestBytes > 0); assert.ok(h.client.snapshot().responseBytes > 0);
    const pid = h.client.snapshot().pid; assert.ok(pid);
    await h.client.close();
    assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
    assert.equal(h.client.snapshot().activeCalls, 0); assert.equal(h.client.snapshot().processCloses, 1);
  } finally { await h.close(); }
});

test('MCP client: staged paginated listing is bounded and only the approved subset can be called', async t => {
  const h = await fixture(t.name, 'paginated');
  try {
    const session = await h.client.discover([MCP_FIXTURE_DOCUMENTS_TOOL], signal());
    assert.equal(h.client.snapshot().listPages, 2);
    await assert.rejects(h.client.call(session, 'observations.read', { id: 'good' }, { signal: signal(), authorize: noop }), isFailure(false, 'mcp_tool_not_approved'));
    assert.equal((await h.audit()).filter(record => record.event === 'call').length, 0);
  } finally { await h.close(); }
});

test('MCP client: partial, mismatched and cycling listings never publish a callable session', async t => {
  for (const [mode, overrides, code] of [
    ['duplicate', {}, 'mcp_duplicate_tool'], ['schema', {}, 'mcp_manifest_mismatch'], ['loop', {}, 'mcp_cursor_invalid'],
    ['paginated', { maxListPages: 1 }, 'mcp_list_page_limit'], ['normal', { maxTools: 1 }, 'mcp_tool_limit'],
  ] as const) {
    const h = await fixture(t.name, mode, overrides);
    try {
      await assert.rejects(h.client.discover([MCP_FIXTURE_DOCUMENTS_TOOL], signal()), isFailure(false, code));
      assert.equal(h.client.snapshot().dirty, true); assert.equal(h.client.snapshot().toolCalls, 0);
    } finally { await h.close(); }
  }
});

test('MCP client: list change during discovery rejects the mixed view; explicit discovery can recover', async t => {
  const h = await fixture(t.name, 'list-change-during-discovery');
  try {
    await assert.rejects(h.client.discover(MCP_FIXTURE_TOOLS, signal()), isFailure(false, 'mcp_discovery_changed'));
    const session = await h.client.discover(MCP_FIXTURE_TOOLS, signal());
    assert.equal(h.client.snapshot().dirty, false);
    const result = await h.client.call(session, 'documents.read', { id: 'good' }, { signal: signal(), authorize: noop });
    assert.equal(result.transportCalls, 1);
  } finally { await h.close(); }
});

test('MCP client: caller mutation and rejected authorization cannot change the registered request', async t => {
  const h = await fixture(t.name);
  try {
    const session = await h.client.discover(MCP_FIXTURE_TOOLS, signal());
    await assert.rejects(h.client.call(session, 'documents.read', { id: 'good' }, { signal: signal(), authorize: async () => { throw new Error('private denial detail'); } }),
      isFailure(false, 'mcp_authorization_denied'));
    assert.equal(h.client.snapshot().toolCalls, 0);
    const input = { id: 'good' }; const suppliedSession = structuredClone(session);
    const result = await h.client.call(suppliedSession, 'documents.read', input, { signal: signal(), authorize: async () => {
      input.id = 'crash'; suppliedSession.endpointId = 'different'; suppliedSession.generation++;
    } });
    assert.equal(((result.value as Record<string, unknown>)['structuredContent'] as Record<string, unknown>)['id'], 'good');
    assert.deepEqual((await h.audit()).filter(record => record.event === 'call').map(record => record.id), ['good']);
  } finally { await h.close(); }
});

test('MCP client: cancellation while authorization is pending sends zero calls', async t => {
  const h = await fixture(t.name);
  try {
    const session = await h.client.discover(MCP_FIXTURE_TOOLS, signal()); const controller = new AbortController();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const call = h.client.call(session, 'documents.read', { id: 'good' }, { signal: controller.signal, authorize: async () => { entered(); await gate; } });
    const rejected = assert.rejects(call, isFailure(false)); await ready; controller.abort(); await rejected; release();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.client.snapshot().toolCalls, 0); assert.equal((await h.audit()).filter(record => record.event === 'call').length, 0);
  } finally { await h.close(); }
});

test('MCP client: active-call admission rejects overflow without invoking its authority callback', async t => {
  const h = await fixture(t.name, 'normal', { maxConcurrent: 1 });
  try {
    const session = await h.client.discover(MCP_FIXTURE_TOOLS, signal());
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const first = h.client.call(session, 'documents.read', { id: 'good' }, { signal: signal(), authorize: async () => { entered(); await gate; } });
    await ready; let extraAuthority = 0;
    await assert.rejects(h.client.call(session, 'documents.read', { id: 'good' }, { signal: signal(), authorize: async () => { extraAuthority++; } }), isFailure(false, 'mcp_concurrency_limit'));
    await assert.rejects(h.client.discover(MCP_FIXTURE_TOOLS, signal()), isFailure(false, 'mcp_busy'));
    release(); await first; assert.equal(extraAuthority, 0); assert.equal(h.client.snapshot().activeCalls, 0); assert.equal(h.client.snapshot().toolCalls, 1);
  } finally { await h.close(); }
});

test('MCP client: actual serialized request and oversized response are bounded', async t => {
  const h = await fixture(t.name, 'normal', { maxRequestBytes: 4096, maxMessageBytes: 16384 });
  try {
    const session = await h.client.discover(MCP_FIXTURE_TOOLS, signal());
    await assert.rejects(h.client.call(session, 'documents.read', { id: 'x'.repeat(4096) }, { signal: signal(), authorize: noop }), isFailure(false, 'mcp_request_limit'));
    assert.equal(h.client.snapshot().toolCalls, 0);
    await assert.rejects(h.client.call(session, 'documents.read', { id: 'oversize' }, { signal: signal(), authorize: noop }), isFailure(true));
    assert.equal(h.client.snapshot().dirty, true); assert.equal(h.client.snapshot().toolCalls, 1);
    assert.equal((await h.audit()).filter(record => record.event === 'call').length, 1);
  } finally { await h.close(); }
});

test('MCP client: post-dispatch list change invalidates the result and never repeats the call', async t => {
  const h = await fixture(t.name, 'list-change');
  try {
    const session = await h.client.discover(MCP_FIXTURE_TOOLS, signal());
    const beforeResponseBytes = h.client.snapshot().responseBytes;
    await assert.rejects(h.client.call(session, 'documents.read', { id: 'good' }, { signal: signal(), authorize: noop }), isFailure(true));
    assert.ok(h.client.snapshot().responseBytes > beforeResponseBytes); // Decoded but stale responses still consumed bytes.
    assert.equal(h.client.snapshot().dirty, true);
    await assert.rejects(h.client.call(session, 'documents.read', { id: 'good' }, { signal: signal(), authorize: noop }), isFailure(false, 'mcp_session_changed'));
    assert.equal(h.client.snapshot().toolCalls, 1); assert.equal((await h.audit()).filter(record => record.event === 'call').length, 1);
  } finally { await h.close(); }
});

test('MCP client: lost delayed response preserves sent uncertainty and releases the owned process', async t => {
  const h = await fixture(t.name, 'late');
  try {
    const session = await h.client.discover(MCP_FIXTURE_TOOLS, signal()); const controller = new AbortController();
    const call = h.client.call(session, 'documents.read', { id: 'slow' }, { signal: controller.signal, authorize: noop });
    const rejected = assert.rejects(call, isFailure(true)); await h.until('response-delayed'); controller.abort(); await rejected;
    assert.equal(h.client.snapshot().toolCalls, 1); assert.equal(h.client.snapshot().activeCalls, 0); assert.equal(h.client.snapshot().pid, null);
    assert.equal((await h.audit()).filter(record => record.event === 'call').length, 1);
  } finally { await h.close(); }
});

test('MCP client: uncertain exit preserves a sent call and explicit concurrent close rechecks once', { concurrency: false }, async t => {
  const h = await fixture(t.name, 'late'); let restoreKill = () => {};
  try {
    const session = await h.client.discover(MCP_FIXTURE_TOOLS, signal()); const controller = new AbortController();
    const pid = h.client.snapshot().pid; assert.ok(pid);
    const call = h.client.call(session, 'documents.read', { id: 'slow' }, { signal: controller.signal, authorize: noop });
    const rejected = assert.rejects(call, isFailure(true, 'mcp_close_unconfirmed')); await h.until('response-delayed');
    const originalKill = process.kill.bind(process); let injected = 0;
    const kill = t.mock.method(process, 'kill', (target: number, requestedSignal?: string | number) => {
      if (target === pid && requestedSignal === 0 && injected === 0) {
        injected++; throw Object.assign(new Error('synthetic exit probe failure'), { code: 'EPERM' });
      }
      return originalKill(target, requestedSignal);
    });
    restoreKill = () => kill.mock.restore();
    controller.abort(); await rejected;
    assert.equal(injected, 1); assert.equal(h.client.snapshot().toolCalls, 1); assert.equal(h.client.snapshot().activeCalls, 0);
    assert.equal(h.client.snapshot().processCloses, 0); assert.equal(h.client.snapshot().connected, false);
    assert.equal((await h.audit()).filter(record => record.event === 'call').length, 1);
    restoreKill();
    await Promise.all([h.client.close(), h.client.close()]);
    assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
    assert.equal(h.client.snapshot().processCloses, 1);
    await h.client.close(); assert.equal(h.client.snapshot().processCloses, 1);
  } finally { restoreKill(); await h.close(); }
});

test('MCP client: crashed peer requires explicit new discovery and old session is never revived', async t => {
  const h = await fixture(t.name);
  try {
    const old = await h.client.discover(MCP_FIXTURE_TOOLS, signal());
    await assert.rejects(h.client.call(old, 'documents.read', { id: 'crash' }, { signal: signal(), authorize: noop }), isFailure(true));
    const next = await h.client.discover(MCP_FIXTURE_TOOLS, signal()); assert.ok(next.generation > old.generation);
    await assert.rejects(h.client.call(old, 'documents.read', { id: 'good' }, { signal: signal(), authorize: noop }), isFailure(false, 'mcp_session_changed'));
    await h.client.call(next, 'documents.read', { id: 'good' }, { signal: signal(), authorize: noop });
    assert.equal(h.client.snapshot().processStarts, 2); assert.equal(h.client.snapshot().toolCalls, 2);
    assert.deepEqual((await h.audit()).filter(record => record.event === 'call').map(record => record.id), ['crash', 'good']);
  } finally { await h.close(); }
});

test('MCP client: ambient default environment is blanked; only explicit host variables are forwarded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-environment-')); const output = join(directory, 'env.json');
  const prior = process.env['MCP_TEST_SECRET']; process.env['MCP_TEST_SECRET'] = 'synthetic-secret-marker';
  const script = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(output)},JSON.stringify({home:process.env.HOME,path:process.env.PATH,allowed:process.env.MCP_TEST_ALLOWED,secret:process.env.MCP_TEST_SECRET??null}));`;
  const env = { MCP_TEST_ALLOWED: 'approved' };
  const client = new McpStdioClient({ endpointId: 'env-fixture', command: process.execPath, args: ['--input-type=module', '-e', script], cwd: directory, env, timeoutMs: 2000 });
  env.MCP_TEST_ALLOWED = 'changed';
  try {
    await assert.rejects(client.discover(MCP_FIXTURE_TOOLS, signal()), isFailure(false));
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { home: '', path: '', allowed: 'approved', secret: null });
  } finally {
    await client.close(); if (prior === undefined) delete process.env['MCP_TEST_SECRET']; else process.env['MCP_TEST_SECRET'] = prior;
    await rm(directory, { recursive: true, force: true });
  }
});
