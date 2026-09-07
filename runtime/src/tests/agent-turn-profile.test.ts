import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { SYNTHETIC_AGENT_TURN_REQUESTS } from '../infrastructure/synthetic-agent-turn.js';

const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
function fixture(options: { backend?: 'sqlite' | 'file-journal'; personalMemory?: 'sqlite' | 'documents'; skills?: 'off' | 'explicit' | 'on-demand' } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-turn-profile-')));
  const profile = new FileAgentProfileStore(runtimeRoot).initialize(join(base, 'agent'), { purpose: '문서와 요청을 처리하는 범용 담당',
    ...(options.personalMemory ? { personalMemory: options.personalMemory } : {}) });
  writeFileSync(join(profile.root, 'config.json'), JSON.stringify({ ...profile.config,
    storage: { ...profile.config.storage, state: options.backend ?? 'sqlite' }, skills: { mode: options.skills ?? 'off' } }));
  return { base, profile, close: () => rmSync(base, { recursive: true, force: true }) };
}

test('generic profile never silently selects a model provider or initializes an absent directory', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-turn-no-provider-'))); const directory = join(base, 'absent');
  try {
    await assert.rejects(openAgentTurnProfile(directory), /agent_turn_provider_unavailable/);
    assert.equal(existsSync(directory), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('skills off bypasses invalid skill files, preserves C01 profile purpose, and keeps runtime authority host-owned', async () => {
  const f = fixture(); writeFileSync(join(f.profile.paths.skills, 'catalog.json'), 'not JSON', { mode: 0o600 });
  const profile = await openAgentTurnProfile(f.profile.root, { provider: 'synthetic' });
  try {
    assert.equal(profile.agentId, f.profile.identity.agentId); assert.equal(profile.services.planner.prompt!.profile.purpose, f.profile.config.purpose);
    assert.equal(profile.services.planner.prompt!.profile.skillsMode, 'off');
    assert.equal(profile.policy.allowedTools.some(id => id.startsWith('core.guidance.')), false);
    assert.deepEqual(profile.catalog.search(profile.policy, { query: 'guidance', limit: 20 }).cards, []);
    assert.equal(profile.guidance.metrics().sourceReadCalls, 0); assert.equal(profile.services.planner.compact, undefined);
    assert.ok(profile.planning); assert.ok(await profile.personalKnowledge(profile.actor));
    assert.deepEqual(profile.executionActor, { tenantId: 'local', principalId: 'operator' });
    assert.equal('scenarios' in profile, false); assert.equal(profile.scope, `agent:${profile.agentId}`);
    const stored = JSON.parse(readFileSync(join(f.profile.root, 'config.json'), 'utf8')) as { model: unknown };
    assert.equal(stored.model, null);
  } finally { await profile.close(); f.close(); }
});

test('file-journal plus document memory uses the same generic intake and reopens the original applied conversation', async () => {
  const f = fixture({ backend: 'file-journal', personalMemory: 'documents', skills: 'on-demand' });
  const profile = await openAgentTurnProfile(f.profile.root, { provider: 'synthetic' });
  try {
    assert.equal(profile.stateBackend, 'file-journal'); assert.equal(profile.personalMemoryBackend, 'documents'); assert.ok(profile.memoryDrafts);
    const session = await profile.sessions.open(profile.actor, { channel: 'test', conversationId: 'generic' });
    const rawText = SYNTHETIC_AGENT_TURN_REQUESTS.rewrite;
    const accepted = await profile.turns.accept(profile.actor, { sessionId: session.scope.sessionId, messageId: 'generic-user-1', rawText,
      binding: { ...profile.executionActor, channel: 'test', conversationId: 'generic', recipientId: profile.actor.principalId, destination: 'local' },
      scope: profile.scope, mode: 'auto', policy: profile.policy, limits: profile.limits });
    assert.equal(accepted.state.goal.description, rawText); assert.deepEqual(accepted.state.goal.criteria, []);
    assert.equal(accepted.state.goal.responseRequirement?.requestMessageId, 'generic-user-1');
    await profile.close();
    const reopened = await openAgentTurnProfile(f.profile.root, { provider: 'synthetic' });
    try {
      const state = await reopened.runtime.state(accepted.workId); const context = await reopened.sessions.context(state);
      assert.equal(reopened.agentId, profile.agentId); assert.equal(context?.entries[0]?.text, rawText);
      assert.equal(context?.basis.scope.sessionId, session.scope.sessionId); assert.equal(state.attempts.length, 0);
    } finally { await reopened.close(); }
  } finally { await profile.close(); f.close(); }
});

test('explicit synthetic compact delegates the existing rules under the single combined provider identity', async () => {
  const f = fixture(); const profile = await openAgentTurnProfile(f.profile.root, { provider: 'synthetic', compactProvider: 'synthetic' });
  try {
    const provider = profile.services.planner; assert.ok(provider.compact); assert.ok(profile.compactPlanning);
    const scope = { ...profile.executionActor, agentId: profile.agentId, sessionId: 'compact-session' };
    const reply = await provider.compact({ schemaVersion: 1, purpose: 'session_compact', workId: 'compact-work',
      basis: { scope, input: { messageId: 'compact-user', sequence: 1, digest: 'a'.repeat(64) } }, inputDigest: 'b'.repeat(64), policyDigest: 'c'.repeat(64),
      previous: null, expectedHead: null, prefix: { throughSequence: 1, digest: 'd'.repeat(64), entries: 1 },
      maxSummaryBytes: 8192, interpretation: 'conversation_history_not_verified_evidence', entries: [{ sequence: 1, sourceId: 'compact-user', workId: 'compact-work',
        role: 'user', text: '[합성 예제] 원문 보존', labels: ['synthetic'], artifact: null, status: 'received', kind: 'work' }] },
    new AbortController().signal, { callId: 'compact-call', maxOutputTokens: 2048, tools: [] });
    assert.equal(reply.status, 'ok'); if (reply.status !== 'ok') throw new Error('compact_expected');
    assert.equal(reply.model, provider.identity!.model); assert.equal(reply.provider, provider.identity!.provider);
    assert.equal(reply.inputTokens, 0); assert.equal(reply.outputTokens, 0); assert.equal(reply.candidate.content.retained.length, 1);
  } finally { await profile.close(); f.close(); }
});
