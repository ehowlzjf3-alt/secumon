import { openHostA2a } from '../dist/presentation/host-a2a.js';

const task = { id: 'other-task', status: { state: 'TASK_STATE_SUBMITTED' } };
const calls = [], actor = { tenantId: 'synthetic', principalId: 'owner', allowedTools: [], allowedLabels: ['public'], allowedDestinations: ['local'], allowWrites: true };
const opened = await openHostA2a({ allowWrites: true, async open() { return { peer: {
  id: 'bound-peer', protocolVersion: '1.0', destination: 'local', labels: ['public'],
  async get(id) { calls.push({ operation: 'get', id }); return structuredClone(task); },
  async cancel(id) { calls.push({ operation: 'cancel', id }); return structuredClone(task); },
  async send() { throw Error('not_requested'); }, async close() {},
}, async close() {} }; } }, { agentId: 'synthetic-agent', root: '/synthetic', scope: 'synthetic-scope', actor, signal: new AbortController().signal });
try {
  let wrong = 0;
  for (const operation of ['get', 'cancel']) {
    const result = await opened.peer[operation]('original-task', { requestId: 'bound-' + operation, signal: new AbortController().signal });
    console.log(JSON.stringify({ operation, requested: 'original-task', returned: result.id, rejected: false }));
    if (result.id !== 'original-task') wrong++;
  }
  console.log(JSON.stringify({ calls, wronglyAccepted: wrong }));
  process.exitCode = wrong ? 1 : 0;
} finally { await opened.close(); }
