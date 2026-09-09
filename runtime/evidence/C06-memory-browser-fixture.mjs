import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { deploymentFixture, deploymentRequest } from '../dist/tests/agent-deployment-entry-fixture.js';
import { startWebServer } from '../dist/presentation/web-server.js';

const cleanup = [];
const fixture = deploymentFixture({ after(fn) { cleanup.push(fn); }, diagnostic(message) { console.error(message); } }, { allowMemorySelection: true });
let closed = false;
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
  const accepted = await web.request('/api/requests', { requestId: 'browser-memory-source',
    rawText: `${deployment.spec.preference} ${deploymentRequest(deployment.spec)}`, mode: 'auto' });
  const profile = web.app.profile.general;
  assert.equal(profile.policy.allowWrites, false);
  assert.equal(profile.actor.allowPersonalMemoryWrites, true);
  // The fixture consumed its own one-time HTTP login. Give the browser a separate
  // normal server entry to the same workbench, without copying cookies or sessions.
  const browserServer = await startWebServer(web.app.workbench);
  cleanup.push(browserServer.close);
  console.log(JSON.stringify({ origin: browserServer.origin, connectUrl: browserServer.connectUrl,
    workId: accepted.workId, sessionId: accepted.sessionId, sourceText: deployment.spec.sourceText }));
  const lines = createInterface({ input: process.stdin, terminal: false });
  for await (const line of lines) {
    const { op } = JSON.parse(line);
    if (op === 'stop') { lines.close(); break; }
    if (op !== 'snapshot') throw new Error('unknown_browser_fixture_command');
    const state = await profile.runtime.state(accepted.workId);
    const memories = await web.request('/api/memories');
    const conversation = await web.request('/api/conversation');
    console.log(JSON.stringify({ status: state.status, stateRevision: state.revision,
      personalMemorySelection: state.personalMemorySelection ?? null, memories: memories.cards,
      conversation, sourceReads: web.observed.reads, modelInputs: web.observed.inputs.length,
      modelMemoryBodies: web.observed.inputs.map(value => value.packet.personalMemory?.entries.map(entry => entry.body) ?? []),
      allowWrites: profile.policy.allowWrites, allowPersonalMemoryWrites: profile.actor.allowPersonalMemoryWrites,
      used: state.budget.used, actualModelCalls: 0 }));
  }
} finally { clearTimeout(watchdog); await stop(); }
