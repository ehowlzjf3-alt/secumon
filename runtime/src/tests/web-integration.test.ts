import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalProfile } from '../presentation/local-profile.js';
import { LocalWorkbench } from '../presentation/local-workbench.js';
import { startWebServer } from '../presentation/web-server.js';
import type { WorkViewResult } from '../domain/work-view.js';

for (const backend of ['sqlite', 'file-journal']) test(`Web HTTP → stored workflow → restart is readonly (${backend})`, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'work-web-integration-')); let profile = await openLocalProfile(folder, backend);
  let web = await startWebServer(new LocalWorkbench(profile));
  try {
    async function session() {
      const response = await fetch(`${web.origin}/api/session`, { method: 'POST', headers: { Origin: web.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(web.connectUrl).hash.slice(9) }) });
      assert.equal(response.status, 200); const value = await response.json() as { csrf: string };
      return { Cookie: response.headers.get('set-cookie')!.split(';')[0]!, Origin: web.origin, 'Content-Type': 'application/json', 'X-Work-CSRF': value.csrf };
    }
    let headers = await session(); const ids: string[] = [];
    for (const scenarioId of ['documents-simple', 'observations-simple']) {
      const input = { requestId: scenarioId, scenarioId, mode: 'auto' };
      const accepted = await fetch(`${web.origin}/api/works`, { method: 'POST', headers, body: JSON.stringify(input) });
      assert.equal(accepted.status, 200); const workId = (await accepted.json() as { workId: string }).workId; ids.push(workId);
      const duplicate = await fetch(`${web.origin}/api/works`, { method: 'POST', headers, body: JSON.stringify(input) });
      assert.deepEqual(await duplicate.json(), { workId, accepted: false });
      const request = { requestId: `run-${scenarioId}`, kind: 'run', expectedGoalRevision: 1 };
      const run = await fetch(`${web.origin}/api/works/${workId}/commands`, { method: 'POST', headers, body: JSON.stringify(request) });
      assert.equal(run.status, 200, JSON.stringify(await run.clone().json()));
      const state = await profile.runtime.state(workId); assert.equal(state.status, 'completed');
      const duplicateRun = await fetch(`${web.origin}/api/works/${workId}/commands`, { method: 'POST', headers, body: JSON.stringify(request) });
      assert.equal(duplicateRun.status, 200); assert.equal((await duplicateRun.json() as { duplicate: boolean }).duplicate, true);
      assert.deepEqual(await profile.runtime.state(workId), state);
      const view = await fetch(`${web.origin}/api/works/${workId}/view`, { headers }); const rendered = await view.json() as WorkViewResult;
      assert.equal(rendered.kind, 'snapshot'); if (rendered.kind === 'snapshot') { assert.equal(rendered.view.progress.resultReady, true); assert.equal(rendered.view.messages.filter(m => m.kind === 'result').length, 1); }
    }
    const before = await Promise.all(ids.map(id => profile.runtime.state(id))); const oldCookie = headers.Cookie;
    await web.close(); await profile.close();
    profile = await openLocalProfile(folder, backend); web = await startWebServer(new LocalWorkbench(profile));
    assert.equal((await fetch(`${web.origin}/api/session`, { headers: { Cookie: oldCookie } })).status, 401);
    headers = await session();
    for (const workId of ids) for (const level of ['conversation', 'details', 'diagnostics']) assert.equal((await fetch(`${web.origin}/api/works/${workId}/view?level=${level}`, { headers })).status, 200);
    const list = await fetch(`${web.origin}/api/works`, { headers }); assert.equal((await list.json() as { items: unknown[] }).items.length, 2);
    assert.deepEqual(await Promise.all(ids.map(id => profile.runtime.state(id))), before);
  } finally { await web.close(); await profile.close(); await rm(folder, { recursive: true, force: true }); }
});
