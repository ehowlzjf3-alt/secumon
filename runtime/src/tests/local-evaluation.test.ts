import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { EvaluationCase, EvaluationReplayBundle, EvaluationVariant } from '../domain/execution-evaluation.js';
import { evaluationBackends, evaluationStart, loadEvaluationCases, type EvaluationBackend, type LocalEvaluationCase } from '../infrastructure/evaluation-cases.js';
import { evaluationPins, replayLocalEvaluation, runLocalEvaluation } from '../infrastructure/local-evaluation.js';

const cases = loadEvaluationCases(fileURLToPath(new URL('../../', import.meta.url)));
type Family = 'document_comparison' | 'observation_review';
async function selected(backend: EvaluationBackend, family: Family, variant: EvaluationVariant, mode: EvaluationCase['mode'] = 'auto') {
  const input = (await cases).find(value => value.specification.backend === backend && value.specification.family === family && value.specification.variant === variant && value.specification.mode === mode);
  assert.ok(input, `${backend}/${family}/${variant}/${mode}`); return input;
}
const final = (bundle: EvaluationReplayBundle) => bundle.sample.observations.at(-1)!.state;
const hasEvent = (bundle: EvaluationReplayBundle, event: string) => bundle.sample.observations.some(value => value.eventTypes.includes(event));
const stage = (bundle: EvaluationReplayBundle, selected: string) => bundle.sample.observations.filter(value => value.stage === selected);
async function runCase(input: LocalEvaluationCase, check: (bundle: EvaluationReplayBundle) => void | Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'execution-evaluation-'));
  const output = join(directory, 'case'); const pins = evaluationPins(input, 'a'.repeat(64), 'b'.repeat(64));
  try {
    const bundle = await runLocalEvaluation(input, output, pins);
    const diagnostic = `${input.specification.id}: ${JSON.stringify({ failures: bundle.score.failures, error: bundle.sample.runError, final: bundle.sample.finalControl })}`;
    assert.equal(bundle.sample.runError, null, diagnostic); assert.equal(bundle.score.contractPassed, true, diagnostic);
    assert.equal(bundle.sample.finalControl, input.specification.oracle.expectedFinal, diagnostic); assert.deepEqual(bundle.score.falseCompletionRevisions, [], diagnostic);
    await check(bundle);
    const saved = await readFile(join(output, 'evaluation.json'), 'utf8');
    const replay = await replayLocalEvaluation(output, pins);
    assert.equal(replay.available, true, `${input.specification.id}: replay ${JSON.stringify(replay.failures)}`);
    assert.deepEqual(replay.score, bundle.score, diagnostic); assert.deepEqual(replay.entries, { commits: 0, artifactWrites: 0 });
    assert.equal(replay.externalExecutionCapabilities, 'not_provided');
    assert.equal(replay.checkedReceipts, bundle.receipts.length); assert.equal(replay.checkedArtifacts, bundle.artifacts.length);
    const repeated = await replayLocalEvaluation(output, pins);
    assert.equal(repeated.available, true); assert.deepEqual(repeated.score, bundle.score); assert.deepEqual(repeated.entries, replay.entries);
    assert.equal(await readFile(join(output, 'evaluation.json'), 'utf8'), saved);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('local evaluation: 192 pinned cases retain two families, two stores, three modes and sixteen variants without duplicate IDs', async () => {
  const all = await cases; assert.equal(all.length, 192); assert.equal(new Set(all.map(value => value.specification.id)).size, 192);
  for (const backend of evaluationBackends) for (const family of ['document_comparison', 'observation_review']) for (const mode of ['auto', 'fast', 'deep']) {
    const cohort = all.filter(value => value.specification.backend === backend && value.specification.family === family && value.specification.mode === mode);
    assert.equal(cohort.length, 16); assert.equal(new Set(cohort.map(value => value.specification.variant)).size, 16);
    for (const value of cohort) for (const original of value.specification.oracle.originals) {
      const source = value.scenario.evidence.find(record => record.id === original.id); assert.ok(source);
      assert.deepEqual(original, { id: source.id, sourceId: source.sourceId, lineageId: source.lineageId, observedAt: source.observedAt });
    }
  }
});

for (const backend of evaluationBackends) {
  for (const family of ['document_comparison', 'observation_review'] as const) test(`local evaluation ${backend}/${family}: simple actual workflow and read-only replay preserve one model, one tool and one delivered answer`, { timeout: 30000 }, async () => {
    await runCase(await selected(backend, family, 'simple'), bundle => {
      assert.equal(bundle.score.goalCompleted, true); assert.equal(bundle.score.calls.modelEntries, 1); assert.equal(bundle.score.calls.toolEntries, 1);
      assert.equal(bundle.score.calls.sends, 2); assert.equal(bundle.score.calls.lookups, 0); assert.equal(bundle.score.calls.adoptedTools, 1);
      assert.equal(bundle.score.usage.used.modelCalls, 1); assert.equal(bundle.score.usage.used.toolCalls, 1); assert.equal(bundle.score.usage.used.tokens, 150);
      assert.ok(bundle.score.latency.firstUsefulAnswerMs! > bundle.score.latency.ackMs!); assert.ok(bundle.score.latency.verifiedCompletionMs! >= bundle.score.latency.firstUsefulAnswerMs!);
      assert.equal(final(bundle).conversation!.result!.evidenceIds.length, 1);
    });
  });

  test(`local evaluation ${backend}: complex original amendments change the hypothesis and require later model assessments`, { timeout: 30000 }, async () => {
    await runCase(await selected(backend, 'document_comparison', 'complex', 'deep'), bundle => {
      assert.equal(bundle.score.goalCompleted, true); assert.equal(bundle.score.calls.modelEntries, 4); assert.equal(bundle.score.calls.toolEntries, 3);
      assert.equal(bundle.score.usage.used.replans, 1); assert.equal(final(bundle).hypotheses[0]!.status, 'refuted');
      assert.deepEqual(final(bundle).hypotheses[0]!.counterIds, ['doc-b', 'doc-a-amendment']);
      assert.ok(bundle.sample.observations.some(value => value.state.hypotheses.some(hypothesis => hypothesis.status === 'contested')));
      assert.ok(bundle.score.latency.firstUsefulAnswerMs! >= 1000);
    });
  });

  test(`local evaluation ${backend}: fast limits reject a complex plan without claiming goal completion or invoking its tool`, { timeout: 30000 }, async () => {
    await runCase(await selected(backend, 'observation_review', 'complex', 'fast'), bundle => {
      assert.equal(bundle.score.goalCompleted, false); assert.equal(bundle.score.calls.toolEntries, 0); assert.ok(bundle.score.calls.modelEntries <= 2);
      assert.ok(final(bundle).modelCalls.some(call => call.reason === 'fast_scope_exceeded')); assert.equal(bundle.score.latency.firstUsefulAnswerMs, null);
      assert.ok(!bundle.sample.observations.some(value => value.state.status === 'completed'));
    });
  });

  for (const variant of ['stored_model_resume', 'stored_tool_resume'] as const) test(`local evaluation ${backend}: ${variant} actually crosses reopen with a received response and does not invoke it again`, { timeout: 30000 }, async () => {
    const family = variant === 'stored_model_resume' ? 'document_comparison' : 'observation_review';
    await runCase(await selected(backend, family, variant), bundle => {
      const reopened = stage(bundle, 'resumed')[0]; assert.ok(reopened);
      const response = variant === 'stored_model_resume' ? reopened.state.modelCalls.find(value => value.status === 'received') : reopened.state.attempts.find(value => value.status === 'received');
      assert.ok(response); const kind = variant === 'stored_model_resume' ? 'model' : 'tool';
      assert.equal(bundle.sample.entries.filter(value => value.kind === kind && value.id === response.id).length, 1);
      assert.equal(bundle.score.calls.modelEntries, 1); assert.equal(bundle.score.calls.toolEntries, 1); assert.equal(bundle.score.goalCompleted, true);
      assert.ok(final(bundle).modelCalls.every(value => value.status === 'accepted')); assert.ok(final(bundle).attempts.every(value => value.status === 'succeeded' && value.adopted));
    });
  });

  test(`local evaluation ${backend}: forced compact is persisted before reopen and subsequent model calls assess later originals`, { timeout: 30000 }, async () => {
    await runCase(await selected(backend, 'observation_review', 'compact', 'deep'), bundle => {
      const compact = bundle.sample.observations.find(value => value.eventTypes.includes('context_compacted')); assert.ok(compact); assert.equal(compact.stage, 'compact');
      assert.ok(compact.state.contextHead); const reopened = stage(bundle, 'resumed')[0]; assert.ok(reopened);
      assert.deepEqual(reopened.state.contextHead, compact.state.contextHead);
      assert.equal(bundle.score.calls.modelEntries, 3); assert.equal(bundle.score.calls.toolEntries, 2); assert.equal(bundle.score.goalCompleted, true);
      const originalCalls = new Set(compact.state.modelCalls.map(value => value.id));
      assert.ok(bundle.sample.entries.some(value => value.kind === 'model' && !originalCalls.has(value.id) && value.at >= reopened.at));
      assert.equal(final(bundle).hypotheses[0]!.status, 'supported');
    });
  });

  test(`local evaluation ${backend}: next-day reply preserves a real wait interval with no model or tool entries`, { timeout: 30000 }, async () => {
    await runCase(await selected(backend, 'document_comparison', 'next_day_reply'), bundle => {
      const waiting = stage(bundle, 'awaiting_reply'); assert.ok(waiting.length >= 2);
      assert.ok(waiting.some(value => value.state.status === 'waiting' && value.state.obligations.some(obligation => obligation.id === 'user-reply' && obligation.status === 'pending')));
      const resumed = stage(bundle, 'resumed')[0]; assert.ok(resumed); assert.ok(resumed.at >= evaluationStart + 86400000);
      assert.equal(bundle.sample.entries.filter(value => ['model', 'tool'].includes(value.kind) && value.at < resumed.at).length, 0);
      assert.equal(bundle.score.interventions, 2); assert.equal(bundle.score.calls.modelEntries, 1); assert.equal(bundle.score.calls.toolEntries, 1);
      assert.ok(bundle.score.latency.firstUsefulAnswerMs! >= 86400000); assert.equal(final(bundle).obligations.find(value => value.id === 'user-reply')!.status, 'satisfied');
    });
  });

  test(`local evaluation ${backend}: status-only keeps its recorded state unchanged with no execution or transport`, { timeout: 30000 }, async () => {
    await runCase(await selected(backend, 'observation_review', 'status_only', 'fast'), bundle => {
      assert.equal(bundle.sample.entries.length, 0); assert.ok(bundle.sample.observations.every(value => value.stage === 'status_only'));
      const baseline = bundle.sample.observations[0]!; for (const value of bundle.sample.observations) { assert.deepEqual(value.state, baseline.state); assert.deepEqual(value.deliveries, baseline.deliveries); }
      assert.equal(bundle.score.goalCompleted, false); assert.equal(bundle.score.latency.firstUsefulAnswerMs, null); assert.equal(bundle.score.latency.simulatedElapsedMs, 0);
    });
  });

  for (const variant of ['source_missing', 'partial_result', 'tool_errors', 'model_errors', 'permission_revoked'] as const) test(`local evaluation ${backend}: ${variant} reaches the intended failure boundary and stays incomplete`, { timeout: 30000 }, async () => {
    await runCase(await selected(backend, 'document_comparison', variant), bundle => {
      assert.equal(bundle.score.goalCompleted, false); assert.equal(bundle.score.latency.firstUsefulAnswerMs, null); assert.equal(final(bundle).status, 'blocked');
      assert.ok(bundle.score.calls.modelEntries > 0); assert.ok(bundle.score.calls.modelEntries <= 10);
      if (variant === 'model_errors') { assert.equal(bundle.score.calls.toolEntries, 0); assert.ok(final(bundle).modelCalls.some(value => value.outcome === 'error')); }
      if (variant === 'source_missing') { assert.equal(bundle.score.calls.toolEntries, 1); assert.ok(final(bundle).attempts.some(value => value.error?.code === 'evidence_unavailable')); }
      if (variant === 'partial_result') { assert.equal(bundle.score.calls.toolEntries, 1); assert.ok(final(bundle).attempts.some(value => value.status === 'partial')); }
      if (variant === 'tool_errors') { assert.equal(bundle.score.calls.toolEntries, 2); assert.equal(bundle.score.calls.uniqueQueries, 1); assert.equal(bundle.score.calls.repeatedQueries, 1); }
      if (variant === 'permission_revoked') {
        assert.ok(hasEvent(bundle, 'policy_changed')); assert.ok(stage(bundle, 'permission_revoked').length); assert.deepEqual(final(bundle).policy.allowedTools, []);
        assert.equal(bundle.score.calls.toolEntries, 0); assert.equal(bundle.score.usage.used.toolCalls, 0); assert.ok(hasEvent(bundle, 'execution_gate_rejected'));
      }
    });
  });

  test(`local evaluation ${backend}: cancellation occurs after model entry and preserves its reported usage without a tool or answer`, { timeout: 30000 }, async () => {
    await runCase(await selected(backend, 'observation_review', 'cancel_running', 'deep'), bundle => {
      const cancelled = bundle.sample.observations.find(value => value.eventTypes.includes('user_command') && value.state.status === 'cancelled'); assert.ok(cancelled);
      assert.ok(cancelled.state.modelCalls.some(value => value.status === 'running')); assert.equal(bundle.score.calls.modelEntries, 1); assert.equal(bundle.score.calls.toolEntries, 0);
      assert.equal(bundle.score.usage.used.modelCalls, 1); assert.equal(bundle.score.usage.used.tokens, 150); assert.equal(bundle.score.goalCompleted, false); assert.equal(bundle.score.interventions, 1);
      const beforeReply = stage(bundle, 'cancelled_before_late_reply')[0]; assert.ok(beforeReply);
      assert.equal(beforeReply.state.modelCalls[0]!.usageStatus, 'unknown');
      assert.ok(final(bundle).revision > beforeReply.state.revision); assert.equal(final(bundle).modelCalls[0]!.usageStatus, 'reported');
    });
  });

  test(`local evaluation ${backend}: requested mode change is first pending during the entered call and later applied`, { timeout: 30000 }, async () => {
    await runCase(await selected(backend, 'document_comparison', 'mode_change', 'fast'), bundle => {
      assert.ok(bundle.sample.observations.some(value => value.state.executionControl?.pending?.mode === 'deep' && value.state.modelCalls.some(call => call.status === 'running')));
      assert.equal(final(bundle).executionControl!.requestedMode, 'deep'); assert.equal(final(bundle).executionControl!.pending, null);
      assert.equal(bundle.score.calls.modelEntries, 1); assert.equal(bundle.score.calls.toolEntries, 1); assert.equal(bundle.score.goalCompleted, true); assert.equal(bundle.score.interventions, 1);
    });
  });

  test(`local evaluation ${backend}: unknown result delivery produces lookup rather than a duplicate send or false completion`, { timeout: 30000 }, async () => {
    await runCase(await selected(backend, 'observation_review', 'unknown_delivery'), bundle => {
      const result = bundle.sample.observations.at(-1)!.deliveries.find(value => value.kind === 'result'); assert.ok(result); assert.equal(result.status, 'unknown');
      assert.equal(bundle.sample.entries.filter(value => value.kind === 'send' && value.id === result.id).length, 1);
      assert.equal(bundle.sample.entries.filter(value => value.kind === 'lookup' && value.id === result.id).length, 1);
      assert.equal(bundle.score.calls.modelEntries, 1); assert.equal(bundle.score.calls.toolEntries, 1); assert.equal(bundle.score.goalCompleted, false); assert.equal(bundle.score.latency.firstUsefulAnswerMs, null);
    });
  });

  for (const family of ['document_comparison', 'observation_review'] as const) test(`local evaluation ${backend}/${family}: late counterevidence is actually observed before final judgment`, { timeout: 30000 }, async () => {
    await runCase(await selected(backend, family, 'late_counterevidence'), bundle => {
      const id = family === 'document_comparison' ? 'doc-a-amendment' : 'denied-ticket';
      const reached = bundle.sample.observations.find(value => value.state.evidence.some(record => record.id === id)); assert.ok(reached); assert.ok(reached.at >= evaluationStart + 1000);
      if (family === 'document_comparison') { assert.equal(bundle.score.goalCompleted, true); assert.equal(final(bundle).hypotheses[0]!.status, 'refuted'); }
      else { assert.equal(bundle.score.goalCompleted, false); assert.ok(final(bundle).evidence.some(value => value.id === 'maintenance-ticket')); assert.equal(final(bundle).hypotheses[0]!.status, 'refuted'); }
    });
  });
}
