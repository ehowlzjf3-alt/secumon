import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AgentTurnInput, AgentTurnReply } from '../application/agent-turn-types.js';
import type { ModelCallOptions } from '../application/ports.js';
import { validateScenario } from '../application/fixtures.js';
import { FixtureReadTool } from '../infrastructure/fakes.js';
import { SyntheticAgentTurnPlanner, SYNTHETIC_AGENT_TURN_REQUESTS as requests, SYNTHETIC_AGENT_TURN_CORRECTION as correction } from '../infrastructure/synthetic-agent-turn.js';

const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-simple.json', import.meta.url), 'utf8')));
function planner() { return new SyntheticAgentTurnPlanner({ agentId: 'synthetic-turn-agent', purpose: '범용 합성 흐름 시험', skillsMode: 'off' }); }
function input(provider: SyntheticAgentTurnPlanner, text: string): AgentTurnInput {
  return { version: 1, prompt: provider.prompt, packet: structuredClone({ schemaVersion: 1, workId: 'synthetic-turn-work', stateRevision: 1,
    goal: scenario.goal, policy: scenario.policy, plan: null, hypotheses: [], obligations: [], evidence: [], activeToolIds: ['fixture.read'], purpose: 'plan',
    session: { schemaVersion: 1, interpretation: 'conversation_history_not_verified_evidence',
      basis: { scope: { tenantId: 'synthetic', agentId: 'synthetic-turn-agent', principalId: 'learner', sessionId: 'same-conversation' },
        input: { messageId: 'user-3', sequence: 3, digest: 'a'.repeat(64) } },
      head: { revision: 1, throughSequence: 3, digest: 'b'.repeat(64), policyDigest: 'c'.repeat(64) },
      entries: [{ sequence: 3, role: 'user', sourceId: 'user-3', workId: 'synthetic-turn-work', text,
        labels: ['synthetic'], artifact: null, status: 'received', kind: 'work' }] },
  }) };
}
function options(tool = new FixtureReadTool(scenario.evidence)): ModelCallOptions { return { callId: 'synthetic-turn-call', maxOutputTokens: 2048, tools: [tool.definition] }; }
const call = (provider: SyntheticAgentTurnPlanner, turn: AgentTurnInput, selected = options()) => provider.turn(turn, new AbortController().signal, selected);
function result(reply: AgentTurnReply) { assert.equal(reply.status, 'ok'); if (reply.status !== 'ok') throw new Error('result_expected'); return reply.result; }

test('explicit synthetic correction and clarification create honest answer artifacts without tools or invented evidence', async () => {
  const provider = planner(); const turn = input(provider, requests.rewrite); const estimate = provider.estimateTurnInput(turn, options());
  assert.equal(estimate.tokens, 1); assert.ok(estimate.bytes > 1000); assert.equal(estimate.method, 'synthetic_rule_engine_no_model_tokens');
  const reply = await call(provider, turn); const corrected = result(reply);
  assert.equal(corrected.kind, 'answer'); if (corrected.kind !== 'answer') throw new Error('answer_expected');
  assert.equal(corrected.text, `[합성 규칙 결과] ${correction}`); assert.deepEqual(corrected.evidenceIds, []);
  assert.match(corrected.assessment.rationale, /실제 모델의 의미 판단은 아니다/);
  assert.equal(reply.inputTokens, 0); assert.equal(reply.outputTokens, 0);
  const clarified = input(provider, requests.clarification); clarified.packet.session!.entries[0]!.kind = 'command';
  const explained = result(await call(provider, clarified));
  assert.equal(explained.kind, 'answer'); if (explained.kind === 'answer') assert.match(explained.text, /파생 기록/);
  assert.equal(result(await call(provider, input(provider, requests.question))).kind, 'question');
});

test('arbitrary natural language, quoted old requests and mismatched applied receipts are refused', async () => {
  const provider = planner();
  for (const text of ['실제 보안 조사를 수행해 줘', requests.rewrite + ' 추가 지시', ' ' + requests.rewrite])
    assert.equal((await call(provider, input(provider, text))).status, 'refused');
  const historical = input(provider, '현재 지원하지 않는 요청');
  historical.packet.goal.description = requests.rewrite;
  historical.packet.session!.entries.unshift({ ...historical.packet.session!.entries[0]!, sequence: 1, sourceId: 'user-1', text: requests.rewrite });
  assert.equal((await call(provider, historical)).status, 'refused');
  const mismatched = input(provider, requests.rewrite); mismatched.packet.session!.basis.input.messageId = 'not-the-receipt';
  assert.equal((await call(provider, mismatched)).status, 'refused');
});

test('synthetic read proposal uses exact permitted tool contract and answers from the returned current evidence value', async () => {
  const provider = planner(); const records = structuredClone(scenario.evidence); records[0]!.facts['retention.days'] = 73;
  const tool = new FixtureReadTool(records); const turn = input(provider, requests.read);
  const planned = result(await call(provider, turn, options(tool)));
  assert.equal(planned.kind, 'plan'); if (planned.kind !== 'plan') throw new Error('plan_expected');
  assert.equal(planned.proposal.baseStateRevision, 1); assert.equal(planned.proposal.baseGoalRevision, scenario.goal.revision);
  assert.equal(planned.proposal.basePlanRevision, 0); assert.equal(tool.invocations.length, 0);
  const task = planned.proposal.tasks[0]!; assert.deepEqual(task.input, { evidenceIds: ['doc-current'] });
  const observed = await tool.execute(task, { workId: turn.packet.workId, attemptId: 'real-fixture-read', policy: turn.packet.policy, signal: new AbortController().signal });
  assert.equal(observed.status, 'success'); turn.packet.evidence = observed.evidence;
  turn.packet.stateRevision = 2; turn.packet.plan = { revision: 1, goalRevision: turn.packet.goal.revision, reason: planned.proposal.reason, tasks: planned.proposal.tasks };
  const answered = result(await call(provider, turn, options(tool)));
  assert.equal(answered.kind, 'answer'); if (answered.kind !== 'answer') throw new Error('answer_expected');
  assert.match(answered.text, /73일/); assert.deepEqual(answered.evidenceIds, ['doc-current']); assert.equal(tool.invocations.length, 1);
  const wrongScope = structuredClone(turn); wrongScope.packet.evidence[0]!.scope = 'other-work-scope';
  assert.equal(result(await call(provider, wrongScope, options(tool))).kind, 'plan');
  const partial = structuredClone(turn); partial.packet.evidence[0]!.coverage = 'partial';
  assert.equal(result(await call(provider, partial, options(tool))).kind, 'plan');
});

test('read requests without the required tool ask for configuration instead of fabricating a plan or a value', async () => {
  const provider = planner(); const turn = input(provider, requests.read); turn.packet.activeToolIds = [];
  const reply = result(await call(provider, turn, { ...options(), tools: [] }));
  assert.equal(reply.kind, 'question'); if (reply.kind === 'question') assert.match(reply.question, /fixture.read 계약이 없습니다/);
  const denied = input(provider, requests.read); denied.packet.policy.allowedTools = [];
  assert.equal((await call(provider, denied)).status, 'invalid');
});

test('follow-up uses an earlier assistant original or cited accepted-summary view and does not infer omitted prior work', async () => {
  const provider = planner(); const turn = input(provider, requests.followup);
  assert.equal(result(await call(provider, turn)).kind, 'question');
  const original = { sequence: 2, sourceId: 'delivered-2', workId: 'previous-work', role: 'assistant' as const,
    text: `[합성 규칙 결과] ${correction}`, labels: ['synthetic'], artifact: null, status: 'delivered' as const, kind: 'result' };
  turn.packet.session!.entries.unshift(original);
  const recalled = result(await call(provider, turn)); assert.equal(recalled.kind, 'answer');
  if (recalled.kind === 'answer') assert.equal(recalled.text, original.text);
  assert.equal(turn.packet.plan, null); assert.deepEqual(turn.packet.evidence, []);
  const current = turn.packet.session!;
  turn.packet.session = { ...current, schemaVersion: 2, entries: current.entries.filter(entry => entry.sequence === 3), summary: {
    ref: { id: 'summary', revision: 1, throughSequence: 2, digest: 'd'.repeat(64), policyDigest: 'c'.repeat(64) },
    content: { narrative: '앞선 합성 결과', retained: [{ id: 'earlier-answer', kind: 'outcome', text: correction, status: 'active',
      citations: [{ sequence: 2, sourceId: original.sourceId, role: 'assistant', quote: original.text }] }] },
  } };
  assert.equal(result(await call(provider, turn)).kind, 'answer');
  turn.packet.session.summary.content.retained[0]!.citations[0]!.role = 'user';
  assert.equal(result(await call(provider, turn)).kind, 'question');
});
