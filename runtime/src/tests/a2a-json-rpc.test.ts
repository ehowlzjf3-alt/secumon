import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { A2aMessageSchema, type A2aCall, type A2aMessage } from '../application/a2a-contracts.js';
import { A2aJsonRpcPeer, type A2aJsonRpcOptions } from '../infrastructure/a2a-json-rpc.js';

// A finite in-process fetch substitute: these tests never contact the endpoint or exercise external A2A interoperability.
type WireCall = { url: string; method: string | undefined; headers: Headers; body: string; signal: AbortSignal; redirect: RequestRedirect | undefined };
const message = (): A2aMessage => ({ messageId: 'message-original', role: 'ROLE_USER', contextId: 'context-original',
  parts: [{ text: '원래 요청\nsecond line', mediaType: 'text/plain' }, { data: { count: 2, nested: ['가', true, null] }, mediaType: 'application/json' }],
  metadata: { trace: 'fixture-only' } });
const task = (id = 'task-original', state = 'TASK_STATE_WORKING') => ({ id, contextId: 'context-original', status: { state },
  artifacts: [{ artifactId: 'original-artifact', parts: [{ text: '원래 응답' }, { data: { complete: false } }] }] });
const call = (requestId = 'rpc-original', signal = new AbortController().signal): A2aCall => ({ requestId, signal });
const response = (id: string, result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'Content-Type': 'application/a2a+json; charset=utf-8' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
function fixture(handler: (value: WireCall, index: number) => Response | Promise<Response>, options: Partial<Omit<A2aJsonRpcOptions, 'fetch'>> = {}) {
  const calls: WireCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    assert.equal(typeof input, 'string'); assert.ok(init?.signal); assert.equal(typeof init.body, 'string');
    const value: WireCall = { url: String(input), method: init.method, headers: new Headers(init.headers),
      body: init.body as string, signal: init.signal, redirect: init.redirect };
    calls.push(value); return handler(value, calls.length - 1);
  };
  const peer = new A2aJsonRpcPeer({ id: 'fixture', endpoint: 'https://a2a.invalid/host/rpc?fixed=1', destination: 'host-a2a',
    labels: ['synthetic'], ...options, fetch });
  return { peer, calls };
}
async function bounded<T>(promise: Promise<T>, milliseconds = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('fixture_deadline')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
type Outcome = { kind: 'fulfilled'; value: unknown } | { kind: 'rejected'; error: unknown };
const outcome = (promise: Promise<unknown>): Promise<Outcome> => promise.then(value => ({ kind: 'fulfilled', value }), error => ({ kind: 'rejected', error }));

test('A2A text/data SendMessage, GetTask and CancelTask preserve originals and fixed host routing without discovery', async t => {
  const headers = { Authorization: 'Bearer fixture-only', 'X-Host-Trace': 'original' }, labels = ['synthetic'];
  const options = { endpoint: 'https://a2a.invalid/host/rpc?fixed=1', headers, labels };
  const input = message(), original = structuredClone(input), authorization = deferred<void>();
  const f = fixture((wire, index) => response(JSON.parse(wire.body).id, index === 0 ? { task: task() }
    : index === 1 ? task() : index === 2 ? task('task-original', 'TASK_STATE_CANCELED')
    : { message: { messageId: 'reply-original', role: 'ROLE_AGENT', parts: [{ text: 'direct reply' }] } }), options);
  t.after(() => { authorization.resolve(); return f.peer.close(); });
  const sent = f.peer.send(input, { ...call('send-id'), authorize: () => authorization.promise });
  input.parts[0] = { text: 'caller mutation after entry' }; headers.Authorization = 'changed'; labels.push('changed'); options.endpoint = 'https://different.invalid/';
  assert.equal(f.calls.length, 0); authorization.resolve();
  assert.deepEqual(await sent, { task: task() });
  assert.deepEqual(await f.peer.get('task-original', call('get-id')), task());
  assert.deepEqual(await f.peer.cancel('task-original', call('cancel-id')), task('task-original', 'TASK_STATE_CANCELED'));
  assert.deepEqual(await f.peer.send(message(), call('direct-id')), { message: { messageId: 'reply-original', role: 'ROLE_AGENT', parts: [{ text: 'direct reply' }] } });
  assert.equal(f.peer.protocolVersion, '1.0'); assert.equal(f.peer.destination, 'host-a2a'); assert.deepEqual(f.peer.labels, ['synthetic']);
  const expected = [
    { jsonrpc: '2.0', id: 'send-id', method: 'SendMessage', params: { message: original,
      configuration: { returnImmediately: true, historyLength: 0, acceptedOutputModes: ['text/plain', 'application/json'] } } },
    { jsonrpc: '2.0', id: 'get-id', method: 'GetTask', params: { id: 'task-original', historyLength: 0 } },
    { jsonrpc: '2.0', id: 'cancel-id', method: 'CancelTask', params: { id: 'task-original' } },
  ];
  for (const [index, wire] of f.calls.entries()) {
    assert.equal(wire.url, 'https://a2a.invalid/host/rpc?fixed=1'); assert.equal(wire.method, 'POST'); assert.equal(wire.redirect, 'error');
    assert.deepEqual(Object.fromEntries(wire.headers), { accept: 'application/json', 'a2a-version': '1.0', authorization: 'Bearer fixture-only',
      'content-type': 'application/json', 'x-host-trace': 'original' });
    if (index < expected.length) assert.equal(wire.body, JSON.stringify(expected[index]));
  }
  assert.equal(f.calls.length, 4);
});

test('A2A concurrent requests keep their own RPC identity when replies complete in reverse order', async t => {
  const first = deferred<Response>(), second = deferred<Response>();
  const f = fixture((_, index) => index === 0 ? first.promise : second.promise); t.after(() => f.peer.close());
  const one = f.peer.get('task-one', call('rpc-one')), two = f.peer.get('task-two', call('rpc-two'));
  void one.catch(() => {}); void two.catch(() => {});
  try {
    await Promise.resolve(); assert.equal(f.calls.length, 2);
    second.resolve(response('rpc-two', task('task-two'))); assert.deepEqual(await two, task('task-two'));
    first.resolve(response('rpc-one', task('task-one'))); assert.deepEqual(await one, task('task-one'));
    assert.deepEqual(f.calls.map(value => JSON.parse(value.body).params.id), ['task-one', 'task-two']);
  } finally {
    first.resolve(response('rpc-one', task('task-one'))); second.resolve(response('rpc-two', task('task-two')));
    await bounded(Promise.allSettled([one, two]));
  }
});

test('A2A invalid input, unsupported file parts and oversized request bytes fail before authorization or fetch', async t => {
  let authorizations = 0;
  const f = fixture(() => { assert.fail('invalid request reached fetch'); }, { maximumBytes: 512 }); t.after(() => f.peer.close());
  const permission = { ...call(), authorize: async () => { authorizations++; } };
  await assert.rejects(f.peer.send({ ...message(), role: 'ROLE_AGENT' }, permission), /^Error: a2a_sender_role_invalid$/);
  await assert.rejects(f.peer.send({ messageId: 'file', role: 'ROLE_USER', parts: [{ file: { uri: 'https://not-fetched.invalid/file' } }] } as unknown as A2aMessage, permission), z.ZodError);
  await assert.rejects(f.peer.get('', permission), z.ZodError);
  await assert.rejects(f.peer.get('task-original', { ...permission, requestId: '' }), z.ZodError);
  const large = A2aMessageSchema.parse({ messageId: 'wide', role: 'ROLE_USER', parts: [{ text: '가'.repeat(180) }] });
  await assert.rejects(f.peer.send(large, permission), /^Error: a2a_request_too_large$/);
  assert.equal(authorizations, 0); assert.equal(f.calls.length, 0);
});

test('A2A construction rejects unsafe endpoint and reserved protocol headers without invoking fetch', () => {
  for (const endpoint of ['http://public.invalid/rpc', 'https://user:password@a2a.invalid/rpc', 'https://a2a.invalid/rpc#fragment', 'file:///not-read'])
    assert.throws(() => fixture(() => { assert.fail('constructor fetched'); }, { endpoint }), /^Error: a2a_endpoint_invalid$/);
  assert.throws(() => fixture(() => { assert.fail('constructor fetched'); }, { headers: { 'a2A-VeRsIoN': '2.0' } }), /^Error: a2a_reserved_header$/);
  assert.throws(() => fixture(() => { assert.fail('constructor fetched'); }, { id: 'core' }), z.ZodError);
});

test('A2A rejects HTTP errors and unsupported content types, cancelling unread bodies', async () => {
  for (const [status, contentType] of [[503, 'application/json'], [200, 'text/event-stream']] as const) {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.close(); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
    const f = fixture(() => new Response(body, { status, headers: { 'Content-Type': contentType } }));
    try { await assert.rejects(f.peer.get('task-original', call()), new RegExp(`^Error: a2a_http_error:${status}$`));
      assert.equal(cancelled, 1); assert.equal(body.locked, false); assert.equal(f.calls.length, 1);
    } finally { await f.peer.close(); }
  }
  const empty = fixture(() => new Response(null, { headers: { 'Content-Type': 'application/json' } }));
  try { await assert.rejects(empty.peer.get('task-original', call()), /^Error: a2a_http_error:200$/); assert.equal(empty.calls.length, 1); }
  finally { await empty.peer.close(); }
});

test('A2A mismatched response IDs, batch envelopes and file-part results are not accepted as task replies', async () => {
  const results: { value: unknown; error: RegExp | typeof z.ZodError }[] = [
    { value: { jsonrpc: '2.0', id: 'other-request', result: task() }, error: /^Error: a2a_response_identity$/ },
    { value: [{ jsonrpc: '2.0', id: 'rpc-original', result: task() }], error: z.ZodError },
    { value: { jsonrpc: '2.0', id: 'rpc-original', result: { ...task(), artifacts: [{ artifactId: 'file', parts: [{ file: { bytes: 'Zml4dHVyZQ==' } }] }] } }, error: z.ZodError },
  ];
  for (const candidate of results) {
    const f = fixture(() => new Response(JSON.stringify(candidate.value), { headers: { 'Content-Type': 'application/json' } }));
    try { await assert.rejects(f.peer.get('task-original', call()), candidate.error); assert.equal(f.calls.length, 1); }
    finally { await f.peer.close(); }
  }
});

test('A2A GetTask and CancelTask reject another task even with a matching RPC envelope', async () => {
  for (const method of ['get', 'cancel'] as const) {
    const f = fixture(wire => response(JSON.parse(wire.body).id, task('other-task')));
    try { await assert.rejects(f.peer[method]('task-original', call()), /^Error: a2a_task_identity$/); assert.equal(f.calls.length, 1); }
    finally { await f.peer.close(); }
  }
});

test('A2A JSON-RPC errors preserve code and original error data without an automatic retry', async t => {
  const error = { code: -32001, message: 'Task unavailable', data: { reason: 'fixture-only', retryable: true } };
  const f = fixture(() => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'rpc-original', error }), { headers: { 'Content-Type': 'application/json' } }));
  t.after(() => f.peer.close());
  await assert.rejects(f.peer.get('task-original', call()), value => {
    assert.ok(value instanceof Error); assert.equal(value.message, 'a2a_rpc_error:-32001'); assert.deepEqual(value.cause, error); return true;
  });
  assert.equal(f.calls.length, 1);
});

test('A2A response size counts cumulative UTF-8 bytes and rejects malformed UTF-8 without retaining a reader lock', async () => {
  let cancelled = 0, chunks = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (chunks === 3) { controller.close(); return; }
    chunks++; controller.enqueue(new TextEncoder().encode('가'.repeat(100)));
  }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  const f = fixture(() => new Response(body, { headers: { 'Content-Type': 'application/json' } }), { maximumBytes: 512 });
  try { await assert.rejects(f.peer.get('task-original', call()), /^Error: a2a_response_too_large$/);
    assert.equal(chunks, 2); assert.equal(cancelled, 1); assert.equal(body.locked, false); assert.equal(f.calls.length, 1);
  } finally { await f.peer.close(); }
  const invalid = fixture(() => new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'Content-Type': 'application/json' } }));
  try { await assert.rejects(invalid.peer.get('task-original', call()), TypeError); assert.equal(invalid.calls.length, 1); }
  finally { await invalid.peer.close(); }
});

test('A2A pre-aborted, permission-denied and already-closed requests never enter fetch', async t => {
  const f = fixture(() => { assert.fail('unauthorized request reached fetch'); }); t.after(() => f.peer.close());
  const cancelled = new AbortController(), reason = new Error('host_cancelled'); cancelled.abort(reason);
  await assert.rejects(f.peer.get('task-original', call('cancelled', cancelled.signal)), value => value === reason);
  const denied = new Error('host_authorization_denied');
  await assert.rejects(f.peer.send(message(), { ...call('denied'), authorize: async () => { throw denied; } }), value => value === denied);
  await f.peer.close(); await f.peer.close();
  await assert.rejects(f.peer.cancel('task-original', call('closed')), { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
});

test('A2A cancellation while host authorization is pending is checked again before dispatch', async t => {
  const entered = deferred<void>(), release = deferred<void>(), cancelled = new AbortController(), reason = new Error('host_revoked_while_authorizing');
  const f = fixture(() => { assert.fail('cancelled authorization reached fetch'); }); t.after(() => f.peer.close());
  const result = outcome(f.peer.get('task-original', { ...call('pending', cancelled.signal), authorize: async () => { entered.resolve(); await release.promise; } }));
  try { await bounded(entered.promise); cancelled.abort(reason); release.resolve();
    const settled = await bounded(result); assert.equal(settled.kind, 'rejected'); if (settled.kind === 'rejected') assert.equal(settled.error, reason);
    assert.equal(f.calls.length, 0);
  } finally { release.resolve(); }
});

test('A2A late fetch resolution after caller cancellation is discarded and its body is cancelled without retry', async t => {
  const entered = deferred<WireCall>(), release = deferred<Response>(), cancelled = new AbortController(); let bodyCancelled = 0;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 'rpc-original', result: task() }))); },
    pull(controller) { controller.close(); }, cancel() { bodyCancelled++; } }, { highWaterMark: 0 });
  const late = new Response(body, { headers: { 'Content-Type': 'application/json' } });
  const f = fixture(async wire => { entered.resolve(wire); return release.promise; }); t.after(() => f.peer.close());
  const result = outcome(f.peer.get('task-original', call('rpc-original', cancelled.signal)));
  try { const wire = await bounded(entered.promise); cancelled.abort(new Error('host_cancelled_after_send')); assert.equal(wire.signal.aborted, true);
    release.resolve(late); const settled = await bounded(result);
    assert.equal(settled.kind, 'rejected', 'a late response must not be adopted after the caller revoked this request');
    assert.equal(bodyCancelled, 1); assert.equal(body.locked, false); assert.equal(f.calls.length, 1);
  } finally { release.resolve(late); await bounded(result); }
});

for (const interruption of ['abort', 'close', 'timeout'] as const) {
  test(`A2A ${interruption} interrupts a pending response-body read and releases it without another request`, { timeout: 3000 }, async t => {
    const reading = deferred<void>(), wireReady = deferred<WireCall>(), cancelled = new AbortController();
    let controller!: ReadableStreamDefaultController<Uint8Array>, bodyCancelled = 0;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { reading.resolve(); }, cancel() { bodyCancelled++; } }, { highWaterMark: 0 });
    const f = fixture(wire => { wireReady.resolve(wire); return new Response(body, { headers: { 'Content-Type': 'application/json' } }); },
      { timeoutMs: interruption === 'timeout' ? 50 : 2000 }); t.after(() => f.peer.close());
    const result = outcome(f.peer.get('task-original', call('rpc-original', cancelled.signal)));
    try {
      const wire = await bounded(wireReady.promise); await bounded(reading.promise);
      if (interruption === 'abort') cancelled.abort(new Error('host_cancelled_during_body'));
      else if (interruption === 'close') await f.peer.close();
      if (!wire.signal.aborted) await bounded(new Promise<void>(resolve => wire.signal.addEventListener('abort', () => resolve(), { once: true })));
      assert.equal(wire.signal.aborted, true);
      // A stream that awaits bytes exposes whether the adapter's lifetime actually interrupts reader.read().
      const settled = await bounded(result, 250);
      assert.equal(settled.kind, 'rejected'); assert.equal(bodyCancelled, 1); assert.equal(body.locked, false); assert.equal(f.calls.length, 1);
    } finally {
      // Failure cleanup is finite even when the current adapter ignores abort after fetch has resolved.
      if (!bodyCancelled) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 'rpc-original', result: task() }))); controller.close(); }
      await bounded(result);
    }
  });
}

test('A2A send loss and body-reader failure preserve the first error and perform no automatic retransmission', async () => {
  const lost = new Error('fixture_response_lost_after_send'), f = fixture(() => { throw lost; });
  try { await assert.rejects(f.peer.send(message(), call()), value => value === lost); assert.equal(f.calls.length, 1);
    assert.equal(JSON.parse(f.calls[0]!.body).method, 'SendMessage');
  } finally { await f.peer.close(); }
  const readFailure = new Error('fixture_body_read_failure');
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(readFailure); } }, { highWaterMark: 0 });
  const failed = fixture(() => new Response(body, { headers: { 'Content-Type': 'application/json' } }));
  try { await assert.rejects(failed.peer.get('task-original', call()), value => value === readFailure);
    assert.equal(failed.calls.length, 1); assert.equal(body.locked, false);
  } finally { await failed.peer.close(); }
});

test('A2A close bounds a fetch that ignores cancellation, disposes its eventual body and preserves an already returned ACK', async t => {
  const entered = deferred<void>(), late = deferred<Response>(), disposed = deferred<void>(); let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++; disposed.resolve(); } }, { highWaterMark: 0 });
  const eventual = new Response(body, { headers: { 'Content-Type': 'application/json' } });
  const f = fixture((wire, index) => {
    if (index === 0) return response(JSON.parse(wire.body).id, { task: task() });
    entered.resolve(); return late.promise;
  }); t.after(() => f.peer.close());
  const acknowledged = await f.peer.send(message(), call('acknowledged'));
  const pending = outcome(f.peer.get('task-original', call('unconfirmed')));
  try {
    await bounded(entered.promise); await bounded(f.peer.close(), 250);
    const settled = await bounded(pending); assert.equal(settled.kind, 'rejected');
    assert.deepEqual(acknowledged, { task: task() }, 'close does not retract an ACK already returned to the host');
    await assert.rejects(f.peer.send(message(), call('after-close')), { name: 'AbortError' }); assert.equal(f.calls.length, 2);
    late.resolve(eventual); await bounded(disposed.promise);
    assert.equal(cancelled, 1); assert.equal(body.locked, false); assert.equal(f.calls.length, 2);
  } finally { late.resolve(eventual); await bounded(pending); }
});

test('A2A cancellation retains the original reason when ignored fetch later rejects or stream cancellation fails', async () => {
  const entered = deferred<void>(), cancelled = new AbortController(), reason = new Error('original_host_abort');
  let rejectFetch!: (error: unknown) => void;
  const late = new Promise<Response>((_, reject) => { rejectFetch = reject; });
  const f = fixture(() => { entered.resolve(); return late; });
  const pending = outcome(f.peer.send(message(), call('late-rejection', cancelled.signal)));
  try {
    await bounded(entered.promise); cancelled.abort(reason);
    const settled = await bounded(pending, 250); assert.equal(settled.kind, 'rejected'); if (settled.kind === 'rejected') assert.equal(settled.error, reason);
    rejectFetch(new Error('late_transport_rejection'));
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 1);
  } finally { rejectFetch(new Error('fixture_cleanup')); await f.peer.close(); await bounded(pending); }

  const reading = deferred<void>(), controller = new AbortController(), cleanup = new Error('source_cancel_failed'); let cancelledBody = 0;
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { source = value; }, pull() { reading.resolve(); }, cancel() { cancelledBody++; return Promise.reject(cleanup); } }, { highWaterMark: 0 });
  const next = fixture(() => new Response(body, { headers: { 'Content-Type': 'application/json' } }));
  const result = outcome(next.peer.get('task-original', call('cleanup-rejection', controller.signal)));
  try {
    await bounded(reading.promise); controller.abort(reason);
    const settled = await bounded(result, 250); assert.equal(settled.kind, 'rejected'); if (settled.kind === 'rejected') assert.equal(settled.error, reason);
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(cancelledBody, 1); assert.equal(body.locked, false); assert.equal(next.calls.length, 1);
  } finally { controller.abort(reason); if (!cancelledBody) source.error(reason); await bounded(next.peer.close()); await bounded(result); }
});
