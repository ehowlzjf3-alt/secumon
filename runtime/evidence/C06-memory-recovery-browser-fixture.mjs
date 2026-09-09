import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { deploymentFixture, deploymentRequest } from '../dist/tests/agent-deployment-entry-fixture.js';
import { LocalWorkbench } from '../dist/presentation/local-workbench.js';
import { startWebServer } from '../dist/presentation/web-server.js';

// Root runs this fixture and the real browser. Existing completion402 evidence
// covers normal execution; this fixture never invokes a model or source tool.
const cleanup = [];
const fixture = deploymentFixture({ after(fn) { cleanup.push(fn); }, diagnostic(message) { console.error(message); } }, { allowMemorySelection: true });
let closed = false, browserServer, limited = false, generation = 0;
const viewReads = [];
const stop = async () => {
  if (closed) return; closed = true;
  for (const action of cleanup.reverse()) await action();
};
process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
const watchdog = setTimeout(() => { void stop().then(() => process.exit(1)); }, 15 * 60 * 1000);
watchdog.unref();
try {
  const deployment = fixture.deployments[0], web = await deployment.open();
  const profile = web.app.profile.general, sourceId = 'recovery-source', memoryId = 'recovery-style';
  const originalText = `${deployment.spec.preference} ${deploymentRequest(deployment.spec)}`;
  const accepted = await web.request('/api/requests', { requestId: sourceId, rawText: originalText, mode: 'auto' });
  const saved = await web.request('/api/memories/remember', { requestId: 'recovery-save', id: memoryId, title: '복구 확인 기억 · 버전 1',
    source: { kind: 'existing', sessionId: accepted.sessionId, messageId: sourceId, quote: deployment.spec.preference } });
  assert.equal(saved.card.revision, 1);
  const before = await profile.runtime.state(accepted.workId);
  await web.request(`/api/works/${accepted.workId}/memories`, { requestId: 'recovery-select-v1',
    expectedGoalRevision: before.goal.revision, expectedStateRevision: before.revision,
    refs: [{ id: memoryId, revision: 1 }] });
  assert.equal(profile.policy.allowWrites, false);
  assert.equal(profile.actor.allowPersonalMemoryWrites, true);

  async function openBrowser(port = 0) {
    const normal = new LocalWorkbench(web.app.profile, profile.actor, 'same-conversation', { sessionId: accepted.sessionId });
    const restricted = new LocalWorkbench(web.app.profile, { ...profile.actor, allowedDestinations: [] },
      'same-conversation', { sessionId: accepted.sessionId });
    await normal.initializeSession();
    // The fixture selects a real restricted actor at the trusted server boundary.
    // Error codes and responses still come from LocalWorkbench and startWebServer.
    const routed = new Proxy(normal, {
      get(target, property) {
        if (property === 'drain') return async () => { await normal.drain(); await restricted.drain(); };
        if (property === 'config') return target.config.bind(target);
        const receiver = limited ? restricted : normal, value = Reflect.get(receiver, property, receiver);
        if (typeof value !== 'function') return value;
        return async (...args) => {
          const mode = limited ? 'restricted' : 'normal';
          try {
            const result = await value.apply(receiver, args);
            if (property === 'view') viewReads.push({ generation, mode, workId: args[0], outcome: 'ok' });
            return result;
          } catch (error) {
            if (property === 'view') viewReads.push({ generation, mode, workId: args[0], outcome: error.message });
            throw error;
          }
        };
      },
    });
    browserServer = await startWebServer(routed, { port }); generation++;
    return { origin: browserServer.origin, connectUrl: browserServer.connectUrl, generation };
  }
  const browser = await openBrowser();
  cleanup.push(async () => { await browserServer?.close(); });
  console.log(JSON.stringify({ kind: 'ready', ...browser, workId: accepted.workId, sessionId: accepted.sessionId,
    memoryId, memoryRevision: 1, stateBackend: 'sqlite', personalMemoryBackend: 'documents',
    operations: ['snapshot', 'revise', 'deny', 'allow', 'reconnect', 'stop'], actualModelCalls: 0 }));

  async function snapshot(kind = 'snapshot') {
    const state = await profile.runtime.state(accepted.workId);
    const memory = await web.request(`/api/memories/${memoryId}`);
    const selected = await web.request(`/api/works/${accepted.workId}/memories`);
    const conversation = await web.request('/api/conversation');
    assert.equal(conversation.entries.filter(entry => entry.role === 'user' && entry.sourceId === sourceId && entry.text === originalText).length, 1);
    assert.equal(web.observed.reads, 0); assert.equal(web.observed.inputs.length, 0);
    console.log(JSON.stringify({ kind, generation, restricted: limited, workId: state.id, sessionId: accepted.sessionId,
      stateRevision: state.revision, goalRevision: state.goal.revision, status: state.status,
      memoryRevision: memory.card.revision, memoryStatus: memory.card.status,
      selected, originalUserEntries: conversation.entries.filter(entry => entry.role === 'user').length,
      originalSourcePreserved: true, sourceReads: web.observed.reads, syntheticModelCalls: web.observed.inputs.length,
      actualModelCalls: 0, used: state.budget.used, recentViewReads: viewReads.slice(-12) }));
  }
  const lines = createInterface({ input: process.stdin, terminal: false });
  for await (const line of lines) {
    const { op } = JSON.parse(line);
    if (op === 'stop') { lines.close(); break; }
    if (op === 'snapshot') await snapshot();
    else if (op === 'revise') {
      const { card } = await web.request(`/api/memories/${memoryId}`);
      const revision = card.revision + 1;
      await web.request('/api/memories/revise', { requestId: `recovery-revise-v${revision}`, id: memoryId,
        title: `복구 확인 기억 · 버전 ${revision}`, expectedRevision: card.revision, reason: '다른 정상 연결에서 기억을 정정한 뒤 선택 버전을 재확인한다.',
        source: { kind: 'existing', sessionId: accepted.sessionId, messageId: sourceId, quote: deployment.spec.preference } });
      const selected = await web.request(`/api/works/${accepted.workId}/memories`);
      assert.equal(selected.available, false, 'Select the current card in the browser before the next revision step');
      const failure = await web.request(`/api/works/${accepted.workId}/view`, undefined, 403);
      assert.equal(failure.code, 'work_view_knowledge_changed');
      await snapshot('revised');
    } else if (op === 'deny' || op === 'allow') {
      limited = op === 'deny'; await snapshot(op);
    } else if (op === 'reconnect') {
      assert.equal(limited, false, 'Restore the normal actor before reconnecting');
      const stateBefore = await profile.runtime.state(accepted.workId);
      const port = Number(new URL(browserServer.origin).port);
      await browserServer.close();
      const next = await openBrowser(port);
      assert.deepEqual(await profile.runtime.state(accepted.workId), stateBefore);
      console.log(JSON.stringify({ kind: 'reconnect', ...next, workId: accepted.workId, sessionId: accepted.sessionId,
        stateUnchanged: true, note: 'Open this fresh login URL in the same browser tab; its origin and saved selection key are unchanged.' }));
    } else throw new Error('unknown_browser_fixture_command');
  }
} finally { clearTimeout(watchdog); await stop(); }
