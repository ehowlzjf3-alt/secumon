import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startWebServer, type WebWorkbench } from '../presentation/web-server.js';
import type { WorkView, WorkViewResult } from '../domain/work-view.js';
import type { WorkbenchConfig } from '../presentation/web-contracts.js';

function fixture() {
  const calls = { reads: 0, commands: 0, accepts: 0, attaches: 0, drains: 0 };
  let cursor = 'wv1:initial'; let denied = false;
  const view: WorkView = { schemaVersion: 1, workId: 'work-test', revision: 1, goalRevision: 1, level: 'conversation', title: '합성 업무',
    mode: { requested: 'auto', strategy: 'direct', pending: null, revision: 1 }, reply: { channel: 'web', observingPrimary: true },
    progress: { status: 'ready', reason: 'accepted', updatedAt: 1, activeAttempts: 0, activeModels: 0, analysisReady: false, resultReady: false, resultDelivery: 'not_prepared', pendingQuestions: 0 }, messages: [] };
  const config: WorkbenchConfig = { profile: 'local-synthetic', conversationId: 'web', scenarios: [], modes: ['auto', 'fast', 'deep'], allowDiagnostics: true, model: 'disabled', deliveryMeaning: 'local-channel-storage', pageSize: 20 };
  const snapshot = (): WorkViewResult => ({ kind: 'snapshot', cursor, view: structuredClone(view) });
  const workbench: WebWorkbench = {
    config: () => config,
    list: async () => { calls.reads++; return { items: [view], nextCursor: null }; },
    view: async (_id, _level, previous) => { calls.reads++; if (denied) throw new Error('private:path/secret'); return previous === cursor ? { kind: 'unchanged', cursor } : snapshot(); },
    accept: async () => { calls.accepts++; return { workId: view.workId, accepted: true }; },
    attach: async () => { calls.attaches++; return { workId: view.workId, attached: true, duplicate: false, view: snapshot() }; },
    command: async () => { calls.commands++; return { workId: view.workId, accepted: true, duplicate: false, view: snapshot() }; },
    drain: async () => { calls.drains++; },
  };
  return { workbench, calls, view, snapshot, change: () => { cursor = 'wv1:changed'; }, deny: () => { denied = true; } };
}
type Server = Awaited<ReturnType<typeof startWebServer>>;
async function session(server: Server) {
  const response = await fetch(`${server.origin}/api/session`, { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(server.connectUrl).hash.slice('#connect='.length) }) });
  assert.equal(response.status, 200); const data = await response.json() as { csrf: string; config: WorkbenchConfig };
  const setCookie = response.headers.get('set-cookie')!;
  return { cookie: setCookie.split(';')[0]!, csrf: data.csrf, setCookie, config: data.config };
}
function auth(s: Awaited<ReturnType<typeof session>>, origin: string) { return { Cookie: s.cookie, Origin: origin, 'X-Work-CSRF': s.csrf, 'Content-Type': 'application/json' }; }
async function eventReader(response: Response) {
  assert.equal(response.status, 200); const reader = response.body!.getReader(); let buffer = '';
  return { reader, async next() {
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) { const result = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); return result; }
      const chunk = await reader.read(); if (chunk.done) return null;
      buffer += new TextDecoder().decode(chunk.value);
    }
  } };
}
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await delay(10); } assert.ok(check(), 'bounded wait completed'); }

test('web session is one-time, per-instance, HttpOnly; reload and static reads never execute', async () => {
  const f = fixture(); const web = await startWebServer(f.workbench);
  try {
    const unauth = await fetch(`${web.origin}/api/works`); assert.equal(unauth.status, 401);
    const html = await fetch(web.origin); assert.equal(html.status, 200); assert.match(html.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.match(html.headers.get('cache-control')!, /no-store/); assert.ok(!(await html.text()).includes('#connect='));
    const s = await session(web); assert.match(s.setCookie, /HttpOnly; SameSite=Strict; Path=\//); assert.equal(s.config.model, 'disabled');
    const reload = await fetch(`${web.origin}/api/session`, { headers: { Cookie: s.cookie } });
    assert.deepEqual(await reload.json(), { csrf: s.csrf, config: s.config });
    const replay = await fetch(`${web.origin}/api/session`, { method: 'POST', headers: auth(s, web.origin), body: JSON.stringify({ token: new URL(web.connectUrl).hash.slice(9) }) });
    assert.equal(replay.status, 401);
    for (const path of ['/api/works', '/api/works/work-test/view', '/api/works/work-test/view?level=details']) assert.equal((await fetch(web.origin + path, { headers: auth(s, web.origin) })).status, 200);
    assert.equal(f.calls.accepts + f.calls.commands + f.calls.attaches, 0);
    const other = await startWebServer(f.workbench);
    try { const t = await session(other); assert.notEqual(t.cookie.split('=')[0], s.cookie.split('=')[0]); assert.equal((await fetch(`${other.origin}/api/session`, { headers: { Cookie: s.cookie } })).status, 401); }
    finally { await other.close(); }
  } finally { await web.close(); }
});

test('web Host, Origin, Fetch Metadata, CSRF and strict JSON reject before controller entry', async () => {
  const f = fixture(); const web = await startWebServer(f.workbench);
  try {
    const s = await session(web); const input = { requestId: 'r1', scenarioId: 'documents-simple', mode: 'auto' };
    for (const [headers, expected] of [
      [{ ...auth(s, web.origin), Origin: 'http://example.invalid' }, 403],
      [{ ...auth(s, web.origin), 'X-Work-CSRF': 'wrong' }, 403],
      [{ ...auth(s, web.origin), 'Sec-Fetch-Site': 'cross-site' }, 403],
      [{ Cookie: s.cookie, 'Content-Type': 'application/json', 'X-Work-CSRF': s.csrf }, 403],
    ] as const) {
      const r = await fetch(`${web.origin}/api/works`, { method: 'POST', headers, body: JSON.stringify(input) }); assert.equal(r.status, expected);
    }
    const wrongHost = await new Promise<number>(resolve => {
      const req = request(`${web.origin}/api/session`, { headers: { Host: 'example.invalid', Cookie: s.cookie } }, res => { res.resume(); resolve(res.statusCode!); }); req.end();
    }); assert.equal(wrongHost, 403);
    for (const [body, expected] of [[{ ...input, actor: { principalId: 'someone' } }, 400], [{ ...input, title: 'x'.repeat(40000) }, 413]] as const) {
      assert.equal((await fetch(`${web.origin}/api/works`, { method: 'POST', headers: auth(s, web.origin), body: JSON.stringify(body) })).status, expected);
    }
    assert.equal((await fetch(`${web.origin}/api/works`, { method: 'POST', headers: auth(s, web.origin), body: '{invalid' })).status, 400);
    assert.equal((await fetch(`${web.origin}/api/works`, { method: 'POST', headers: { ...auth(s, web.origin), 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal(f.calls.accepts + f.calls.commands + f.calls.attaches, 0);
    assert.equal((await fetch(`${web.origin}/api/works`, { method: 'POST', headers: auth(s, web.origin), body: JSON.stringify(input) })).status, 200); assert.equal(f.calls.accepts, 1);
  } finally { await web.close(); }
});

test('web exact assets, methods and cursor options do not expose files or internal errors', async () => {
  const f = fixture(); const web = await startWebServer(f.workbench);
  try {
    const s = await session(web);
    for (const path of ['/src/presentation/local-profile.ts', '/assets/client.js.map', '/package.json', '/assets/../local-profile.js']) assert.equal((await fetch(web.origin + path)).status, 404);
    for (const path of ['/api/works?actor=x', '/api/works/work-test/view?level=details&level=conversation', '/api/works/work-test/view?cursor=' + 'a'.repeat(257), '/api/works/work-test/events?level=diagnostics']) assert.equal((await fetch(web.origin + path, { headers: auth(s, web.origin) })).status, 400);
    assert.equal((await fetch(`${web.origin}/api/works`, { method: 'DELETE', headers: auth(s, web.origin) })).status, 405);
    f.deny(); const denied = await fetch(`${web.origin}/api/works/work-test/view`, { headers: auth(s, web.origin) });
    assert.deepEqual(await denied.json(), { code: 'request_failed' });
    assert.equal(f.calls.commands, 0);
  } finally { await web.close(); }
});

test('web session expiry during body blocks mutation entry, logout blocks late view payload', async () => {
  const f = fixture(); let now = 1; const web = await startWebServer(f.workbench, { now: () => now, sessionLifetimeMs: 1000 });
  try {
    const s = await session(web); const payload = JSON.stringify({ requestId: 'r1', scenarioId: 'documents-simple', mode: 'auto' });
    const result = new Promise<number>(resolve => {
      const req = request(`${web.origin}/api/works`, { method: 'POST', headers: { ...auth(s, web.origin), 'Content-Length': Buffer.byteLength(payload) } }, res => { res.resume(); resolve(res.statusCode!); });
      req.write(payload.slice(0, 4)); void until(() => web.stats().mutations === 1).then(() => { now = 2000; req.end(payload.slice(4)); });
    });
    assert.equal(await result, 401); assert.equal(f.calls.accepts, 0);
  } finally { await web.close(); }
  const g = fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  g.workbench.view = async () => { await gate; return g.snapshot(); };
  const web2 = await startWebServer(g.workbench);
  try {
    const s = await session(web2); const pending = fetch(`${web2.origin}/api/works/work-test/view`, { headers: auth(s, web2.origin) });
    await until(() => web2.stats().activeReads === 1);
    assert.equal((await fetch(`${web2.origin}/api/session`, { method: 'DELETE', headers: auth(s, web2.origin) })).status, 200);
    release(); const response = await pending; assert.equal(response.status, 401); assert.deepEqual(await response.json(), { code: 'session_expired' });
  } finally { release(); await web2.close(); }
});

test('web bootstrap expires and authenticated request rate has a finite window', async () => {
  const f = fixture(); let now = 1; const web = await startWebServer(f.workbench, { now: () => now, bootstrapLifetimeMs: 100 });
  try {
    now = 101; const response = await fetch(`${web.origin}/api/session`, { method: 'POST', headers: { Origin: web.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(web.connectUrl).hash.slice(9) }) }); assert.equal(response.status, 401);
  } finally { await web.close(); }
  const web2 = await startWebServer(f.workbench, { now: () => now });
  try {
    const s = await session(web2);
    for (let i = 0; i < 240; i++) assert.equal((await fetch(`${web2.origin}/api/session`, { headers: { Cookie: s.cookie } })).status, 200);
    assert.equal((await fetch(`${web2.origin}/api/session`, { headers: { Cookie: s.cookie } })).status, 429);
    now += 60000; assert.equal((await fetch(`${web2.origin}/api/session`, { headers: { Cookie: s.cookie } })).status, 200);
  } finally { await web2.close(); }
});

test('web SSE emits projection changes at same revision, reconnect is readonly, denial closes', async () => {
  const f = fixture(); const web = await startWebServer(f.workbench, { pollMs: 15, streamLifetimeMs: 2000 });
  try {
    const s = await session(web); const stream = await eventReader(await fetch(`${web.origin}/api/works/work-test/events`, { headers: auth(s, web.origin) }));
    assert.match((await stream.next())!, /event: view/); assert.match((await stream.next())!, /event: unchanged/);
    f.change(); let changed = ''; while (!changed.includes('wv1:changed')) changed = (await stream.next())!;
    assert.match(changed, /event: view/); assert.match(changed, /"revision":1/);
    await stream.reader.cancel(); await until(() => web.stats().streams === 0);
    const replay = await eventReader(await fetch(`${web.origin}/api/works/work-test/events?cursor=old`, { headers: { ...auth(s, web.origin), 'Last-Event-ID': 'wv1:changed' } }));
    assert.match((await replay.next())!, /event: unchanged/);
    f.deny(); assert.match((await replay.next())!, /event: unavailable/); assert.equal(await replay.next(), null);
    const count = f.calls.reads; await delay(40); assert.equal(f.calls.reads, count);
    assert.equal(f.calls.commands + f.calls.accepts + f.calls.attaches, 0);
  } finally { await web.close(); }
});

test('web SSE session revocation, stream cap and lifetime release resources', async () => {
  const f = fixture(); const web = await startWebServer(f.workbench, { pollMs: 20, streamLifetimeMs: 3000 });
  try {
    const s = await session(web); const opened = [];
    for (let i = 0; i < 4; i++) { const reader = await eventReader(await fetch(`${web.origin}/api/works/work-test/events`, { headers: auth(s, web.origin) })); await reader.next(); opened.push(reader); }
    assert.equal(web.stats().streams, 4); assert.equal((await fetch(`${web.origin}/api/works/work-test/events`, { headers: auth(s, web.origin) })).status, 429);
    await fetch(`${web.origin}/api/session`, { method: 'DELETE', headers: auth(s, web.origin) });
    for (const reader of opened) { let event: string | null; do { event = await reader.next(); } while (event && !event.includes('unavailable')); assert.match(event!, /session_expired/); await reader.reader.cancel(); }
    await until(() => web.stats().streams === 0);
  } finally { await web.close(); }
  const web2 = await startWebServer(f.workbench, { streamLifetimeMs: 30, pollMs: 10 });
  try { const s = await session(web2); const reader = await eventReader(await fetch(`${web2.origin}/api/works/work-test/events`, { headers: auth(s, web2.origin) })); while (await reader.next()) { /* finite stream */ } assert.equal(web2.stats().streams, 0); }
  finally { await web2.close(); }
});

test('closed SSE keeps physical read slots until completion; reconnect cannot create unbounded reads', async () => {
  const f = fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let entries = 0;
  f.workbench.view = async () => { entries++; await gate; return f.snapshot(); };
  const web = await startWebServer(f.workbench, { pollMs: 10, streamLifetimeMs: 20 });
  try {
    const s = await session(web);
    for (let i = 0; i < 16; i++) {
      const reader = await eventReader(await fetch(`${web.origin}/api/works/work-test/events`, { headers: auth(s, web.origin) }));
      while (await reader.next()) { /* close by lifetime, final request by capacity */ }
    }
    assert.equal((await fetch(`${web.origin}/api/works/work-test/events`, { headers: auth(s, web.origin) })).status, 429);
    assert.equal(entries, 16); assert.equal(web.stats().activeReads, 16); assert.equal(web.stats().streams, 0);
    release(); await until(() => web.stats().activeReads === 0);
  } finally { release(); await web.close(); }
});

test('web pending run permits independent cancel and disconnect does not call cancel', async () => {
  const f = fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const kinds: string[] = [];
  f.workbench.command = async (_id, input) => { kinds.push(input.kind); if (input.kind === 'run') await gate; return { workId: 'work-test', accepted: true, duplicate: false, view: f.snapshot() }; };
  const web = await startWebServer(f.workbench);
  try {
    const s = await session(web); const headers = auth(s, web.origin); const path = `${web.origin}/api/works/work-test/commands`;
    const run = fetch(path, { method: 'POST', headers, body: JSON.stringify({ kind: 'run', requestId: 'run', expectedGoalRevision: 1 }) });
    await until(() => kinds.length === 1);
    assert.equal((await fetch(path, { method: 'POST', headers, body: JSON.stringify({ kind: 'cancel', requestId: 'cancel', expectedGoalRevision: 1 }) })).status, 200);
    release(); assert.equal((await run).status, 200); assert.deepEqual(kinds, ['run', 'cancel']);
    await fetch(`${web.origin}/api/session`, { method: 'DELETE', headers }); assert.deepEqual(kinds, ['run', 'cancel']);
  } finally { release(); await web.close(); }
});
