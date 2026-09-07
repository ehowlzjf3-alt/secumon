import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AgentTurnInput } from '../application/agent-turn-types.js';
import type { ModelCallOptions, Planner } from '../application/ports.js';
import type { SessionCompactInput } from '../domain/session-compact.js';
import type { Json } from '../domain/model.js';
import { modelContextPreviewEnvelope } from '../application/model-context-preview.js';
import { AgentTurnInputSchema } from '../application/agent-turn-contracts.js';
import { readGeneratedAnswer } from '../application/generated-answer.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { SYNTHETIC_AGENT_TURN_REQUESTS as requests, SYNTHETIC_AGENT_TURN_CORRECTION } from '../infrastructure/synthetic-agent-turn.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';

const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const correction = `[합성 규칙 결과] ${SYNTHETIC_AGENT_TURN_CORRECTION}`;
const compactLimits = { maxContextBytes: 262144, maxContextEntries: 256, keepRecentEntries: 1,
  maxCompactEntries: 4, maxSummaryBytes: 4096, triggerRatio: 0.99, targetRatio: 0.9 };
const basePlanners = new WeakMap<AgentTurnProfile, Planner>();
interface Observations {
  compacts: { input: SessionCompactInput; callId: string; inputTokens: number; outputReservation: number }[];
  turns: { input: AgentTurnInput; callId: string; inputTokens: number; outputReservation: number }[];
  previews: { callId: string; entries: number; summaryThrough: number | null; bytes: number; promptBytes: number; toolBytes: number }[];
}

/** Synthetic UTF-8 accounting validates window arithmetic and real request contents, not a model tokenizer or summary quality. */
function installWindow(profile: AgentTurnProfile, allowedInputTokens: number, observed: Observations) {
  const shared = profile.planning!.services;
  const original = basePlanners.get(profile) ?? shared.planner;
  basePlanners.set(profile, original);
  const maxOutputTokens = profile.planning!.config.maxOutputTokens;
  const maxInputBytes = profile.planning!.config.maxInputBytes;
  const totalWindow = allowedInputTokens + maxOutputTokens;
  const turnBytes = (input: AgentTurnInput, options: ModelCallOptions) => byteLength({ identity: original.identity, input, options });
  const compactBytes = (input: SessionCompactInput, options: ModelCallOptions) => byteLength({ identity: original.identity, compact: input, options });
  const estimate = (bytes: number) => ({ bytes, tokens: bytes, method: 'synthetic_full_request_utf8_units' });
  const assertFits = (bytes: number, options: ModelCallOptions) => {
    assert.ok(bytes > 1); assert.ok(bytes <= allowedInputTokens, `input ${bytes} exceeds ${allowedInputTokens}`);
    assert.ok(bytes <= maxInputBytes); assert.equal(options.maxOutputTokens, maxOutputTokens);
    assert.ok(bytes + options.maxOutputTokens <= totalWindow, 'actual input and reserved output share the configured window');
  };
  const planner: Planner = {
    identity: original.identity!, destination: original.destination, prompt: original.prompt!,
    inputEstimation: { id: 'synthetic-window-flow', revision: '1', templateRevision: 'full-request-v1', kind: 'conservative_estimate' },
    // The standalone input limit is deliberately wider: the effective bound comes from totalWindow - reserved output.
    capabilities: { ...original.capabilities, maxInputTokens: 100000, maxInputBytes, contextWindowTokens: totalWindow, maxOutputTokens },
    propose: original.propose.bind(original),
    estimateContextPreview: (preview, options) => {
      const envelope = modelContextPreviewEnvelope(preview, options) as Record<string, Json>;
      const bytes = byteLength(preview.turn ? { identity: original.identity, input: envelope['turn'], options } : { identity: original.identity, ...envelope });
      observed.previews.push({ callId: options.callId, entries: preview.session?.entries.length ?? 0,
        summaryThrough: preview.session?.summary?.ref.throughSequence ?? null, bytes,
        promptBytes: byteLength(preview.turn?.prompt ?? null), toolBytes: byteLength(options.tools) });
      return estimate(bytes);
    },
    estimateTurnInput: (input, options) => estimate(turnBytes(input, options)),
    estimateCompactInput: (input, options) => estimate(compactBytes(input, options)),
    turn: async (input, signal, options) => {
      const bytes = turnBytes(input, options); assertFits(bytes, options);
      observed.turns.push({ input: structuredClone(input), callId: options.callId, inputTokens: bytes, outputReservation: options.maxOutputTokens });
      const reply = await original.turn!(input, signal, options);
      return reply.status === 'ok' ? { ...reply, inputTokens: bytes, outputTokens: Math.ceil(byteLength(reply.result) / 4) } : reply;
    },
    compact: async (input, signal, options) => {
      const bytes = compactBytes(input, options); assertFits(bytes, options);
      observed.compacts.push({ input: structuredClone(input), callId: options.callId, inputTokens: bytes, outputReservation: options.maxOutputTokens });
      const reply = await original.compact!(input, signal, options);
      return reply.status === 'ok' ? { ...reply, inputTokens: bytes, outputTokens: Math.ceil(byteLength(reply.candidate.content) / 4) } : reply;
    },
  };
  shared.planner = planner;
  profile.services.planner = planner;
  return { totalWindow, maxOutputTokens, allowedInputTokens, maxInputBytes };
}

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: a measured model window drives repeated automatic compact before a general answer and survives reopening`, { timeout: 60000 }, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-turn-window-'))), directory = join(base, 'agent');
  const hostOptions = { models: new Map(), identityRegistryDirectory: join(base, 'registry') };
  const initialized = new FileAgentProfileStore(runtimeRoot).initialize(directory);
  if (backend === 'file-journal') writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...initialized.config,
    storage: { ...initialized.config.storage, state: backend } }), { mode: 0o600 });
  let profile = await openAgentTurnProfile(directory, { provider: 'synthetic', compactProvider: 'synthetic', compactLimits }, hostOptions);
  const observed: Observations = { compacts: [], turns: [], previews: [] };
  try {
    installWindow(profile, 100000, observed);
    const session = await profile.sessions.open(profile.actor, { channel: 'test', conversationId: 'automatic-window' });
    const accept = (messageId: string, rawText: string) => profile.turns.accept(profile.actor, { sessionId: session.scope.sessionId, messageId, rawText, mode: 'auto',
      binding: { ...profile.executionActor, channel: 'test', conversationId: 'automatic-window', recipientId: profile.actor.principalId, destination: 'local' },
      scope: profile.scope, policy: profile.policy, limits: profile.limits });
    const x = await accept('X', requests.rewrite);
    assert.equal((await profile.workflow.run(x.workId, profile.executionActor)).control.kind, 'complete');
    const xBefore = await profile.runtime.state(x.workId);
    assert.equal(xBefore.budget.used.modelCalls, 1); assert.ok(xBefore.modelCalls[0]!.inputEstimate > 1);
    const y = await accept('Y', requests.followup);
    for (let n = 1; n <= 16; n++) await profile.turns.followUp(profile.actor, { sessionId: session.scope.sessionId,
      workId: y.workId, messageId: `Y-tail-${n}`, rawText: requests.followup, expectedGoalRevision: 1, action: { kind: 'continue' } });
    const before = await profile.sessions.history(profile.actor, session.scope.sessionId, profile.policy, { limit: 100 });
    const state = await profile.runtime.state(y.workId);
    assert.ok(before.entries.length < compactLimits.maxContextEntries);
    assert.ok(byteLength(before.entries) < Math.floor(profile.planning!.config.maxInputBytes * 0.75) * compactLimits.triggerRatio,
      'the prior session threshold alone would not request compact');
    const sessionRecord = await profile.sessions.repository.get(session.scope);
    const calibration = await profile.planning!.turns.inspect(state, 'window-calibration', {
      maxInputBytes: profile.planning!.config.maxInputBytes, maxInputTokens: 100000, maxOutputTokens: profile.planning!.config.maxOutputTokens });
    assert.equal(calibration.kind, 'fits');
    assert.deepEqual(await profile.sessions.repository.get(session.scope), sessionRecord, 'calibration does not publish a session head');
    assert.deepEqual(await profile.runtime.state(y.workId), state);
    const inputLimit = calibration.requiredEstimate.tokens + 4000;
    assert.ok(inputLimit < 100000); assert.ok(inputLimit < profile.planning!.config.maxInputBytes);
    const window = installWindow(profile, inputLimit, observed);
    assert.equal(window.totalWindow - window.maxOutputTokens, inputLimit);
    const narrow = await profile.planning!.turns.inspect(state, 'window-too-small-for-history', {
      maxInputBytes: window.maxInputBytes, maxInputTokens: inputLimit, maxOutputTokens: window.maxOutputTokens });
    assert.equal(narrow.kind, 'needs_session_compact');
    assert.ok(narrow.requiredEstimate.tokens <= inputLimit);
    assert.ok(observed.previews.some(value => value.callId === 'window-calibration' && value.promptBytes > 100 && value.toolBytes > 100),
      'mandatory prompt and tool contracts participate in the measured request');

    const result = await profile.workflow.run(y.workId, profile.executionActor, { maxSteps: 80 });
    assert.equal(result.control.kind, 'complete', JSON.stringify(result));
    const done = await profile.runtime.state(y.workId);
    const compacts = observed.compacts.filter(value => value.input.workId === y.workId);
    assert.ok(compacts.length >= 2, JSON.stringify(compacts.map(value => ({ entries: value.input.entries.length, through: value.input.prefix.throughSequence }))));
    const main = observed.turns.filter(value => value.input.packet.workId === y.workId);
    assert.equal(main.length, 1); assert.equal((await readGeneratedAnswer(profile.services, done))!.text, correction);
    assert.equal(done.status, 'completed'); assert.equal(done.budget.used.modelCalls, compacts.length + 1);
    assert.equal(done.budget.used.toolCalls, 0); assert.equal(done.budget.used.replans, 0);
    assert.equal(done.budget.reservedTokens, 0); assert.equal(done.budget.reservedModelCalls, 0);
    assert.ok(done.budget.used.tokens > 1);
    for (const call of done.modelCalls) {
      assert.equal(call.status, 'accepted'); assert.ok(call.inputEstimate > 1);
      assert.ok(call.inputEstimate + call.maxOutputTokens <= window.totalWindow);
    }
    let previousThrough = 0, previousId: string | null = null;
    for (const { input, callId } of compacts) {
      assert.ok(input.entries.length <= 4); assert.ok(input.entries[0]!.sequence > previousThrough);
      assert.ok(input.prefix.throughSequence > previousThrough); assert.ok(input.prefix.throughSequence < input.basis.input.sequence);
      assert.equal(input.previous?.ref.id ?? null, previousId);
      const publication = await profile.sessions.repository.publication(session.scope, callId); assert.ok(publication);
      assert.deepEqual(publication.prefix, input.prefix); assert.equal(publication.inputDigest, input.inputDigest);
      for (const item of publication.content.retained) for (const citation of item.citations) assert.ok(before.entries.some(entry =>
        entry.sequence === citation.sequence && entry.role === citation.role && entry.sourceId === citation.sourceId && entry.text.includes(citation.quote)));
      previousThrough = input.prefix.throughSequence; previousId = publication.ref.id;
    }
    const saved = JSON.parse(new TextDecoder().decode(await profile.services.artifacts.get(done.generatedAnswer!.inputArtifact, done.policy)));
    const packet = AgentTurnInputSchema.parse(saved.turn).packet, context = packet.session;
    assert.equal(context?.schemaVersion, 2); if (context?.schemaVersion !== 2) assert.fail('actual main input did not retain the accepted summary');
    assert.equal(context.summary.ref.id, previousId);
    assert.ok(context.summary.content.retained.some(item => item.citations.some(citation => citation.role === 'assistant' && citation.quote === correction)));
    const currentInput = context.entries.find(entry => entry.sourceId === 'Y-tail-16');
    assert.ok(currentInput);
    assert.equal(currentInput.role, 'user'); assert.equal(currentInput.kind, 'input');
    assert.equal(currentInput.text, requests.followup); assert.equal(currentInput.sequence, context.basis.input.sequence);
    assert.deepEqual(currentInput, before.entries.find(entry => entry.sourceId === 'Y-tail-16'));
    assert.equal(done.goal.responseRequirement!.requestMessageId, 'Y');
    assert.equal(done.generatedAnswer!.input.input.messageId, 'Y-tail-16');
    const after = await profile.sessions.history(profile.actor, session.scope.sessionId, profile.policy, { limit: 100 });
    assert.deepEqual(after.entries.filter(entry => before.entries.some(old => old.sequence === entry.sequence)), before.entries);
    assert.deepEqual((await profile.runtime.state(x.workId)).budget, xBefore.budget);

    await profile.close(); profile = await openAgentTurnProfile(directory, { provider: 'synthetic', compactProvider: 'synthetic', compactLimits }, hostOptions);
    installWindow(profile, inputLimit, observed);
    const reopened = await profile.sessions.open(profile.actor, { channel: 'test', conversationId: 'automatic-window' });
    assert.deepEqual(reopened.scope, session.scope);
    assert.deepEqual(await profile.sessions.history(profile.actor, session.scope.sessionId, profile.policy, { limit: 100 }), after);
    assert.deepEqual((await profile.runtime.state(y.workId)).budget, done.budget);
    assert.equal((await readGeneratedAnswer(profile.services, await profile.runtime.state(y.workId)))!.text, correction);
    const z = await accept('Z', requests.followup), zBefore = await profile.runtime.state(z.workId);
    assert.equal(zBefore.budget.used.modelCalls, 0); assert.equal(zBefore.budget.used.tokens, 0);
    assert.equal((await profile.workflow.run(z.workId, profile.executionActor, { maxSteps: 80 })).control.kind, 'complete');
    assert.equal((await readGeneratedAnswer(profile.services, await profile.runtime.state(z.workId)))!.text, correction);
    assert.deepEqual((await profile.runtime.state(y.workId)).budget, done.budget);
  } finally { await profile.close(); rmSync(base, { recursive: true, force: true }); }
});
