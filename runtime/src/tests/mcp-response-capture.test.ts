import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { asJson } from '../application/plan-validator.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { McpCallError, McpStdioClient, type McpCallContext, type McpDecodedResponse,
  type McpStdioConfig } from '../infrastructure/mcp-stdio-client.js';
import { MCP_FIXTURE_TOOLS, type McpFixtureAudit, type McpFixtureMode } from './helpers/mcp-fixture-contracts.js';

const server = fileURLToPath(new URL('./helpers/mcp-fixture-server.js', import.meta.url));
const signal = () => new AbortController().signal;
const noop = async () => {};
async function fixture(t: TestContext, mode: McpFixtureMode = 'normal', options: Partial<McpStdioConfig> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-response-capture-')), auditFile = join(directory, 'audit.jsonl');
  const client = new McpStdioClient({ endpointId: 'capture-fixture', command: process.execPath,
    args: [server, '--audit-file', auditFile, '--mode', mode, '--delay-ms', '350'], cwd: directory,
    env: { TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir() }, timeoutMs: 10000, ...options });
  const audit = async (): Promise<McpFixtureAudit[]> => {
    try { return (await readFile(auditFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as McpFixtureAudit); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  t.after(async () => {
    const pid = client.snapshot().pid;
    try {
      await client.close();
      if (pid !== null) assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
      assert.equal(client.snapshot().activeCalls, 0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  const until = async (event: McpFixtureAudit['event']) => {
    const deadline = Date.now() + 10000;
    while (!(await audit()).some(row => row.event === event)) {
      if (Date.now() >= deadline) throw new Error(`capture_fixture_missing_${event}`);
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  };
  const session = await client.discover(MCP_FIXTURE_TOOLS, signal());
  return { client, session, audit, until };
}
const failed = (stage: McpCallError['stage'], sent: boolean, code?: string) => (error: unknown) =>
  error instanceof McpCallError && error.stage === stage && error.sent === sent &&
  error.cause instanceof Error && (code === undefined || error.code === code);

test('a real decoded reply has one immutable request-bound capture and unchanged normal return', async t => {
  const h = await fixture(t), captured: McpDecodedResponse[] = [];
  const input = { id: 'good' }, suppliedSession = structuredClone(h.session);
  const observer = {
    time: 1234,
    now() { return this.time; },
    decoded(value: McpDecodedResponse): undefined { assert.equal(this, observer); captured.push(value); },
  };
  const result = await h.client.call(suppliedSession, 'documents.read', input, { signal: signal(), capture: observer,
    authorize: async () => {
      input.id = 'crash'; suppliedSession.generation++;
      observer.now = () => { throw new Error('changed_capture_function'); };
      observer.decoded = () => { throw new Error('changed_capture_function'); };
    } });
  assert.equal(captured.length, 1); const value = captured[0]!;
  assert.equal(value.observedAt, 1234); assert.equal(value.transportCalls, 1);
  assert.deepEqual(value.session, h.session);
  assert.equal(value.requestDigest, new Sha256Digester().digest(asJson({ session: h.session, name: 'documents.read', input: { id: 'good' } })));
  assert.equal(value.byteLength, Buffer.byteLength(value.json)); assert.deepEqual(JSON.parse(value.json), result.value);
  assert.deepEqual(Object.keys(result).sort(), ['session', 'transportCalls', 'value']);
  assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.session));
  assert.equal(Reflect.set(value, 'json', '{}'), false); assert.equal(Reflect.set(value.session, 'generation', 999), false);
  assert.deepEqual((await h.audit()).filter(row => row.event === 'call').map(row => row.id), ['good']);
});

test('post-capture abort rejects use but retains the decoded original and local send observation', async t => {
  const h = await fixture(t), controller = new AbortController(), captured: McpDecodedResponse[] = [];
  await assert.rejects(h.client.call(h.session, 'documents.read', { id: 'good' }, { signal: controller.signal, authorize: noop,
    capture: { now: () => 2000, decoded(value) { captured.push(value); controller.abort(); } },
  }), failed('post_response', true, 'mcp_cancelled'));
  assert.equal(captured.length, 1); assert.equal(captured[0]!.transportCalls, 1);
  assert.equal(JSON.parse(captured[0]!.json).structuredContent.id, 'good');
  assert.equal(h.client.snapshot().toolCalls, 1); assert.equal(h.client.snapshot().processCloses, 1);
});

test('real tools/list_changed preserves the response original with its old session before rejecting use', async t => {
  const h = await fixture(t, 'list-change'), captured: McpDecodedResponse[] = [];
  await assert.rejects(h.client.call(h.session, 'documents.read', { id: 'good' }, { signal: signal(), authorize: noop,
    capture: { now: () => 2100, decoded(value) { captured.push(value); } },
  }), failed('post_response', true, 'mcp_session_changed'));
  assert.equal(captured.length, 1); assert.deepEqual(captured[0]!.session, h.session);
  assert.ok(h.client.snapshot().generation > captured[0]!.session.generation);
  assert.equal((await h.audit()).filter(row => row.event === 'call').length, 1);
});

test('SDK reject after a real send does not fabricate a decoded response', async t => {
  const h = await fixture(t, 'late'), controller = new AbortController(); let clocks = 0, captures = 0;
  const pending = h.client.call(h.session, 'documents.read', { id: 'slow' }, { signal: controller.signal, authorize: noop,
    capture: { now: () => { clocks++; return 2200; }, decoded() { captures++; } },
  });
  const rejection = assert.rejects(pending, failed('request', true));
  void rejection.catch(() => {});
  try { await h.until('response-delayed'); controller.abort(); await rejection; }
  finally { controller.abort(); await pending.catch(() => {}); }
  assert.equal(clocks, 0); assert.equal(captures, 0); assert.equal(h.client.snapshot().toolCalls, 1);
  assert.equal((await h.audit()).filter(row => row.event === 'call').length, 1);
});

test('pre-send authority rejection invokes neither the clock nor capture and reports zero send entries', async t => {
  const h = await fixture(t); let clocks = 0, captures = 0;
  await assert.rejects(h.client.call(h.session, 'documents.read', { id: 'good' }, { signal: signal(),
    authorize: async () => { throw new Error('fixture_authority_denied'); },
    capture: { now: () => { clocks++; return 2300; }, decoded() { captures++; } },
  }), failed('request', false, 'mcp_authorization_denied'));
  assert.equal(clocks, 0); assert.equal(captures, 0); assert.equal(h.client.snapshot().toolCalls, 0);
  assert.equal((await h.audit()).filter(row => row.event === 'call').length, 0);
});

for (const invalid of ['json', 'bytes'] as const) test(`the decoded ${invalid} boundary rejects before capture`, { concurrency: false }, async t => {
  const h = await fixture(t, 'normal', { maxMessageBytes: 16384 }); let clocks = 0, captures = 0;
  const original = Client.prototype.request;
  // The real stdio request completes first. Only this isolated test substitutes
  // its decoded SDK return to exercise the client's independent defensive limit.
  const mock = t.mock.method(Client.prototype, 'request', (async function(this: Client, ...args: Parameters<typeof original>) {
    const value: unknown = await Reflect.apply(original, this, args);
    return args[0].method === 'tools/call' ? invalid === 'json' ? { value: Number.NaN } : { text: 'x'.repeat(20000) } : value;
  }) as typeof original);
  try {
    await assert.rejects(h.client.call(h.session, 'documents.read', { id: 'good' }, { signal: signal(), authorize: noop,
      capture: { now: () => { clocks++; return 2400; }, decoded() { captures++; } },
    }), failed('response_validation', true, invalid === 'bytes' ? 'mcp_response_limit' : undefined));
    assert.equal(clocks, 1); assert.equal(captures, 0);
    assert.equal((await h.audit()).filter(row => row.event === 'call').length, 1);
  } finally { mock.mock.restore(); }
});

test('an invalid observation clock cannot publish a capture', async t => {
  const h = await fixture(t); let captures = 0;
  await assert.rejects(h.client.call(h.session, 'documents.read', { id: 'good' }, { signal: signal(), authorize: noop,
    capture: { now: () => Number.NaN, decoded() { captures++; } },
  }), failed('capture', true, 'mcp_capture_time_invalid'));
  assert.equal(captures, 0); assert.equal(h.client.snapshot().toolCalls, 1);
});

test('an invalid async capture is not awaited or treated as a successful response', async t => {
  const h = await fixture(t); let captures = 0;
  const asyncObserver = (async () => { captures++; throw new Error('synthetic_async_capture'); }) as unknown as
    NonNullable<McpCallContext['capture']>['decoded'];
  await assert.rejects(h.client.call(h.session, 'documents.read', { id: 'good' }, { signal: signal(), authorize: noop,
    capture: { now: () => 2500, decoded: asyncObserver },
  }), failed('capture', true, 'mcp_capture_async_unsupported'));
  assert.equal(captures, 1); assert.equal(h.client.snapshot().activeCalls, 0);
});

test('two concurrent real requests retain separate input/session captures when the last observer closes the client', async t => {
  const h = await fixture(t), captured = new Map<string, McpDecodedResponse>();
  let closing: Promise<void> | undefined;
  const call = (name: 'documents.read' | 'observations.read', id: 'good' | 'partial', observedAt: number) =>
    h.client.call(h.session, name, { id }, { signal: signal(), authorize: noop, capture: {
      now: () => observedAt, decoded(value) {
        captured.set(name, value);
        if (captured.size === 2) { closing = h.client.close(); void closing.catch(() => {}); }
      },
    } });
  const outcomes = await Promise.allSettled([call('documents.read', 'good', 3000), call('observations.read', 'partial', 4000)]);
  assert.ok(closing); await closing;
  assert.equal(captured.size, 2);
  for (const [name, id, at] of [['documents.read', 'good', 3000], ['observations.read', 'partial', 4000]] as const) {
    const value = captured.get(name)!; assert.equal(value.observedAt, at); assert.deepEqual(value.session, h.session);
    assert.equal(value.requestDigest, new Sha256Digester().digest(asJson({ session: h.session, name, input: { id } })));
    assert.equal(JSON.parse(value.json).structuredContent.id, id); assert.equal(value.transportCalls, 1);
  }
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(value => value.status === 'rejected'); assert.ok(rejected?.status === 'rejected');
  assert.ok(failed('post_response', true, 'mcp_closed')(rejected.reason));
  assert.equal(h.client.snapshot().toolCalls, 2); assert.equal(h.client.snapshot().processCloses, 1);
});

test('capture failure and owned-process close failure preserve both causes without losing the original', { concurrency: false }, async t => {
  const h = await fixture(t), captured: McpDecodedResponse[] = [];
  const primary = new Error('capture_observer_failed'), cleanup = Object.assign(new Error('owned_exit_probe_failed'), { code: 'EPERM' });
  const pid = h.client.snapshot().pid; assert.ok(pid);
  const kill = process.kill.bind(process); let probes = 0;
  const mock = t.mock.method(process, 'kill', (target: number, requestedSignal?: string | number) => {
    if (target === pid && requestedSignal === 0 && probes++ === 0) throw cleanup;
    return kill(target, requestedSignal);
  });
  try {
    await assert.rejects(h.client.call(h.session, 'documents.read', { id: 'good' }, { signal: signal(), authorize: noop,
      capture: { now: () => 5000, decoded(value) { captured.push(value); throw primary; } },
    }), (error: unknown) => error instanceof McpCallError && error.code === 'mcp_close_unconfirmed' && error.sent &&
      error.stage === 'capture' && error.cause === primary && error.cleanupError instanceof McpCallError && error.cleanupError.cause === cleanup);
    assert.equal(captured.length, 1); assert.equal(JSON.parse(captured[0]!.json).structuredContent.id, 'good');
    assert.equal(h.client.snapshot().activeCalls, 0); assert.equal(h.client.snapshot().processCloses, 0);
  } finally { mock.mock.restore(); }
  await Promise.all([h.client.close(), h.client.close()]);
  assert.equal(h.client.snapshot().processCloses, 1);
});
