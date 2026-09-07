import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentTurnInput, AgentTurnReply } from '../application/agent-turn-types.js';
import type { ModelCallOptions, ModelInputEstimate, SessionCompactReply } from '../application/ports.js';
import type { SessionCompactInput } from '../domain/session-compact.js';
import { AgentTurnInputSchema } from '../application/agent-turn-contracts.js';
import { readGeneratedAnswer } from '../application/generated-answer.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { SYNTHETIC_AGENT_TURN_REQUESTS as requests, SYNTHETIC_AGENT_TURN_CORRECTION } from '../infrastructure/synthetic-agent-turn.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { createLocalContractHost, LOCAL_CONTRACT_MODEL_PROFILE } from '../presentation/local-contract-model.js';
import type { AgentTurnHost, RegisteredTurnPlanner } from '../presentation/host-models.js';

const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
const correction = `[합성 규칙 결과] ${SYNTHETIC_AGENT_TURN_CORRECTION}`;
const compactLimits = { maxContextBytes: 262144, maxContextEntries: 256, keepRecentEntries: 1,
  maxCompactEntries: 4, maxSummaryBytes: 4096, triggerRatio: 0.99, targetRatio: 0.9 };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
type Invocation<T, R> = { input: T; options: ModelCallOptions; estimate: ModelInputEstimate; reply: R; window: number | null };
interface Observations {
  turns: Invocation<AgentTurnInput, AgentTurnReply>[];
  compacts: Invocation<SessionCompactInput, SessionCompactReply>[];
  opened: number;
  closed: number;
}

/** Retains the registered structured provider and real full-request estimators; only the host's shared window is narrowed. */
function observedHost(observed: Observations, configuredWindow: () => number | undefined): AgentTurnHost {
  const registration = createLocalContractHost().models.get(LOCAL_CONTRACT_MODEL_PROFILE)!;
  return { models: new Map([[LOCAL_CONTRACT_MODEL_PROFILE, { execution: registration.execution, async open(promptProfile) {
    const opened = await registration.open(promptProfile), base = opened.planner;
    assert.ok(base.compact); assert.ok(base.estimateCompactInput); observed.opened++;
    const window = configuredWindow() ?? null;
    const fits = (estimate: ModelInputEstimate, options: ModelCallOptions) => {
      assert.ok(estimate.tokens > 1); assert.ok(estimate.bytes > 1);
      assert.ok(estimate.bytes <= opened.inputLimits.maxInputBytes);
      assert.equal(options.maxOutputTokens, opened.inputLimits.maxOutputTokens);
      if (window !== null) assert.ok(estimate.tokens + options.maxOutputTokens <= window,
        `${estimate.tokens} input + ${options.maxOutputTokens} output exceeds registered window ${window}`);
    };
    const planner: RegisteredTurnPlanner = {
      identity: base.identity, destination: base.destination, prompt: base.prompt, inputEstimation: base.inputEstimation,
      capabilities: { ...base.capabilities, ...(window === null ? {} : { contextWindowTokens: window }) },
      propose: base.propose.bind(base), estimateTurnInput: base.estimateTurnInput.bind(base),
      estimateContextPreview: base.estimateContextPreview.bind(base), estimateCompactInput: base.estimateCompactInput.bind(base),
      async turn(input, signal, options) {
        const estimate = base.estimateTurnInput(input, options); fits(estimate, options);
        const reply = await base.turn(input, signal, options);
        observed.turns.push({ input: structuredClone(input), options: structuredClone(options), estimate, reply: structuredClone(reply), window });
        return reply;
      },
      async compact(input, signal, options) {
        const estimate = base.estimateCompactInput!(input, options); fits(estimate, options);
        const reply = await base.compact!(input, signal, options);
        observed.compacts.push({ input: structuredClone(input), options: structuredClone(options), estimate, reply: structuredClone(reply), window });
        return reply;
      },
    };
    return { planner, inputLimits: opened.inputLimits, async close() { observed.closed++; await opened.close(); } };
  } }]]) };
}

async function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'registered-agent-flow-'))), directory = join(base, 'agent');
  let current: AgentTurnProfile | undefined;
  t.after(async () => { try { await current?.close(); } finally { rmSync(base, { recursive: true, force: true }); } });
  const initialized = new FileAgentProfileStore(runtimeRoot).initialize(directory);
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...initialized.config, model: { profile: LOCAL_CONTRACT_MODEL_PROFILE } }), { mode: 0o600 });
  const observed: Observations = { turns: [], compacts: [], opened: 0, closed: 0 };
  let window: number | undefined;
  const host = observedHost(observed, () => window);
  async function open() {
    await current?.close();
    current = await openAgentTurnProfile(directory, { provider: 'registered', compactLimits }, host);
    return current;
  }
  return { directory, observed, open, setWindow: (value: number) => { window = value; } };
}

function accept(profile: AgentTurnProfile, sessionId: string, messageId: string, rawText: string) {
  return profile.turns.accept(profile.actor, { sessionId, messageId, rawText, mode: 'auto',
    binding: { ...profile.executionActor, channel: 'test', conversationId: 'registered-flow', recipientId: profile.actor.principalId, destination: 'local' },
    scope: profile.scope, policy: profile.policy, limits: profile.limits });
}

test('registered local transport reads evidence, automatically compacts multiple prefixes, answers and continues the same session after reopening', { timeout: 60000 }, async t => {
  const f = await fixture(t); let profile = await f.open();
  assert.equal(profile.modelInfo.selection, 'registered'); assert.equal(profile.modelInfo.profileName, LOCAL_CONTRACT_MODEL_PROFILE);
  assert.equal(profile.modelInfo.execution, 'deterministic_fixture'); assert.equal(profile.modelInfo.compact, true);
  assert.equal(profile.stateBackend, 'sqlite'); assert.equal(profile.compactProvider, 'registered');
  const session = await profile.sessions.open(profile.actor, { channel: 'test', conversationId: 'registered-flow' });
  const x = await accept(profile, session.scope.sessionId, 'X', requests.rewrite);
  assert.equal((await profile.workflow.run(x.workId, profile.executionActor)).control.kind, 'complete');
  const xDone = await profile.runtime.state(x.workId);
  const y = await accept(profile, session.scope.sessionId, 'Y', requests.read), planCall = await profile.planning!.reserve(y.workId);
  await profile.planning!.execute(y.workId, planCall.id); assert.equal(await profile.planning!.adopt(y.workId, planCall.id), true);
  for (const action of ['reserve', 'dispatch', 'adopt']) {
    const step = await profile.planning!.step(y.workId); assert.equal(step.kind, 'continue');
    if (step.kind !== 'continue') assert.fail('expected the registered read plan to execute');
    assert.equal(step.action, action);
  }
  const read = await profile.runtime.state(y.workId);
  assert.equal(read.attempts.length, 1); assert.equal(read.attempts[0]!.status, 'succeeded'); assert.equal(read.attempts[0]!.adopted, true);
  const evidence = read.evidence.find(value => value.id === 'doc-current'); assert.ok(evidence);
  assert.equal(evidence.status, 'accepted'); assert.equal(f.observed.compacts.length, 0);
  for (let n = 1; n <= 16; n++) await profile.turns.followUp(profile.actor, { sessionId: session.scope.sessionId, workId: y.workId,
    messageId: `Y-tail-${n}`, rawText: requests.read, expectedGoalRevision: 1, action: { kind: 'continue' } });
  const before = await profile.sessions.history(profile.actor, session.scope.sessionId, profile.policy, { limit: 100 });
  const pending = await profile.runtime.state(y.workId), record = await profile.sessions.repository.get(session.scope);
  const inspection = await profile.planning!.turns.inspect(pending, 'registered-calibration', {
    maxInputBytes: profile.planning!.config.maxInputBytes, maxOutputTokens: profile.planning!.config.maxOutputTokens, maxInputTokens: 100000 });
  assert.equal(inspection.kind, 'fits'); assert.deepEqual(await profile.sessions.repository.get(session.scope), record);
  assert.deepEqual(await profile.runtime.state(y.workId), pending);
  const inputLimit = inspection.requiredEstimate.tokens + 4000, totalWindow = inputLimit + profile.planning!.config.maxOutputTokens;
  assert.ok(inputLimit < profile.planning!.config.maxInputBytes);
  assert.ok(bytes(before.entries) < Math.floor(profile.planning!.config.maxInputBytes * 0.75) * compactLimits.triggerRatio);
  f.setWindow(totalWindow); profile = await f.open();
  assert.equal(profile.services.planner.capabilities.contextWindowTokens, totalWindow);
  const narrow = await profile.planning!.turns.inspect(await profile.runtime.state(y.workId), 'registered-narrow', {
    maxInputBytes: profile.planning!.config.maxInputBytes, maxOutputTokens: profile.planning!.config.maxOutputTokens, maxInputTokens: inputLimit });
  assert.equal(narrow.kind, 'needs_session_compact'); assert.ok(narrow.requiredEstimate.tokens <= inputLimit);
  assert.equal((await profile.workflow.run(y.workId, profile.executionActor, { maxSteps: 80 })).control.kind, 'complete');
  const done = await profile.runtime.state(y.workId), compacts = f.observed.compacts.filter(value => value.input.workId === y.workId);
  assert.ok(compacts.length >= 2, JSON.stringify(compacts.map(value => value.input.prefix.throughSequence)));
  assert.equal(done.attempts.length, 2); assert.equal(done.budget.used.toolCalls, 2);
  assert.equal(done.attempts.filter(attempt => attempt.toolId === 'fixture.read').length, 1);
  assert.equal(done.attempts.filter(attempt => attempt.toolId === 'core.evidence.get').length, 1);
  assert.ok(done.attempts.every(attempt => attempt.status === 'succeeded' && attempt.adopted));
  assert.equal(done.budget.used.modelCalls, compacts.length + 3); assert.equal(done.modelCalls.length, compacts.length + 3);
  assert.equal(done.budget.reservedTokens, 0); assert.equal(done.budget.reservedModelCalls, 0); assert.equal(done.budget.reservedToolCalls, 0);
  assert.equal((await readGeneratedAnswer(profile.services, done))!.text, `[합성 규칙 결과] 현재 근거 doc-current의 보존기간은 ${evidence.facts['retention.days']}일입니다.`);
  let through = 0, summaryId: string | null = null;
  for (const invocation of compacts) {
    const { input, options, estimate } = invocation;
    assert.equal(invocation.window, totalWindow); assert.ok(estimate.tokens > 1); assert.ok(estimate.tokens + options.maxOutputTokens <= totalWindow);
    assert.ok(estimate.bytes > bytes({ compact: input, options }), 'the structured instructions/schema remain part of the estimate');
    assert.ok(input.prefix.throughSequence > through); assert.ok(input.prefix.throughSequence < input.basis.input.sequence);
    assert.equal(input.previous?.ref.id ?? null, summaryId);
    const publication = await profile.sessions.repository.publication(session.scope, options.callId); assert.ok(publication);
    assert.deepEqual(publication.prefix, input.prefix); assert.equal(publication.inputDigest, input.inputDigest);
    for (const item of publication.content.retained) for (const citation of item.citations) assert.ok(before.entries.some(entry =>
      entry.sequence === citation.sequence && entry.sourceId === citation.sourceId && entry.role === citation.role && entry.text.includes(citation.quote)));
    const call = done.modelCalls.find(value => value.id === options.callId)!;
    const saved = JSON.parse(Buffer.from(await profile.services.artifacts.get(call.inputArtifact, done.policy)).toString());
    assert.deepEqual(saved, { compact: input, options }); assert.equal(call.inputEstimate, estimate.tokens);
    through = input.prefix.throughSequence; summaryId = publication.ref.id;
  }
  const yInvocations = [...f.observed.turns.filter(value => value.input.packet.workId === y.workId), ...compacts];
  assert.ok(yInvocations.every(value => value.reply.inputTokens !== null && value.reply.outputTokens !== null));
  const reported = yInvocations.reduce((sum, value) => sum + value.reply.inputTokens! + value.reply.outputTokens!, 0);
  assert.equal(done.budget.used.tokens, reported, 'the deterministic transport reports its actual fixture usage; estimates are not fabricated usage');
  assert.ok(done.modelCalls.every(call => call.status === 'accepted' && call.usageStatus === 'reported' && call.inputEstimate > 1));
  const saved = JSON.parse(Buffer.from(await profile.services.artifacts.get(done.generatedAnswer!.inputArtifact, done.policy)).toString());
  const finalInput = AgentTurnInputSchema.parse(saved.turn), context = finalInput.packet.session;
  assert.equal(context?.schemaVersion, 2); if (context?.schemaVersion !== 2) assert.fail('expected stored summary and latest raw input');
  assert.equal(context.summary.ref.id, summaryId); assert.ok(finalInput.packet.evidence.some(value => value.id === 'doc-current'));
  assert.deepEqual(context.entries.find(value => value.sourceId === 'Y-tail-16'), before.entries.find(value => value.sourceId === 'Y-tail-16'));
  assert.equal(done.generatedAnswer!.input.input.messageId, 'Y-tail-16'); assert.equal(done.goal.responseRequirement!.requestMessageId, 'Y');
  const history = await profile.sessions.history(profile.actor, session.scope.sessionId, profile.policy, { limit: 100 });
  assert.deepEqual(history.entries.filter(entry => before.entries.some(previous => previous.sequence === entry.sequence)), before.entries);
  const callsBeforeOpen = f.observed.turns.length + f.observed.compacts.length;
  profile = await f.open();
  assert.deepEqual((await profile.sessions.open(profile.actor, { channel: 'test', conversationId: 'registered-flow' })).scope, session.scope);
  assert.deepEqual(await profile.sessions.history(profile.actor, session.scope.sessionId, profile.policy, { limit: 100 }), history);
  assert.equal(f.observed.turns.length + f.observed.compacts.length, callsBeforeOpen);
  assert.deepEqual((await profile.runtime.state(y.workId)).budget, done.budget);
  const z = await accept(profile, session.scope.sessionId, 'Z', requests.followup);
  assert.equal((await profile.runtime.state(z.workId)).budget.used.modelCalls, 0);
  assert.equal((await profile.workflow.run(z.workId, profile.executionActor, { maxSteps: 80 })).control.kind, 'complete');
  assert.equal((await readGeneratedAnswer(profile.services, await profile.runtime.state(z.workId)))!.text, correction);
  assert.deepEqual((await profile.runtime.state(x.workId)).budget, xDone.budget); assert.deepEqual((await profile.runtime.state(y.workId)).budget, done.budget);
  await profile.close(); assert.equal(f.observed.closed, f.observed.opened);
});

test('a registered reply already stored before shutdown is adopted and delivered after reopening without invoking the transport again', { timeout: 60000 }, async t => {
  const f = await fixture(t); let profile = await f.open();
  const session = await profile.sessions.open(profile.actor, { channel: 'test', conversationId: 'registered-flow' });
  const accepted = await accept(profile, session.scope.sessionId, 'stored-response', requests.rewrite);
  const call = await profile.planning!.reserve(accepted.workId); await profile.planning!.execute(accepted.workId, call.id);
  const received = await profile.runtime.state(accepted.workId);
  assert.equal(received.modelCalls[0]!.status, 'received'); assert.equal(received.generatedAnswer, undefined);
  const replyRef = received.modelCalls[0]!.replyArtifact; assert.ok(replyRef);
  const replyBytes = Buffer.from(await profile.services.artifacts.get(replyRef, received.policy));
  assert.equal(f.observed.turns.length, 1); assert.equal(f.observed.compacts.length, 0);
  profile = await f.open();
  assert.equal((await profile.workflow.run(accepted.workId, profile.executionActor)).control.kind, 'complete');
  const done = await profile.runtime.state(accepted.workId);
  assert.equal(f.observed.turns.length, 1); assert.equal(f.observed.compacts.length, 0); assert.equal(done.modelCalls.length, 1);
  assert.equal(done.modelCalls[0]!.id, call.id); assert.equal(done.modelCalls[0]!.status, 'accepted');
  assert.deepEqual(done.modelCalls[0]!.replyArtifact, replyRef); assert.deepEqual(Buffer.from(await profile.services.artifacts.get(replyRef, done.policy)), replyBytes);
  assert.equal(done.budget.used.modelCalls, 1); assert.equal(done.budget.used.tokens, received.budget.used.tokens); assert.equal(done.budget.reservedTokens, 0);
  assert.equal((await readGeneratedAnswer(profile.services, done))!.text, correction);
  const results = (await profile.services.state.deliveries(done.id)).filter(value => value.kind === 'result' && value.status === 'delivered');
  assert.equal(results.length, 1); assert.equal(results[0]!.text, correction);
  assert.ok((await profile.sessions.history(profile.actor, session.scope.sessionId, profile.policy, { limit: 50 })).entries.some(entry =>
    entry.sourceId === 'stored-response' && entry.text === requests.rewrite));
  await profile.close(); assert.equal(f.observed.closed, f.observed.opened);
});
