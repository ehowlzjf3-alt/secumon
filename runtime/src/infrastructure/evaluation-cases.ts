import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateScenario, type Scenario } from '../application/fixtures.js';
import type { ModelReply } from '../application/ports.js';
import type { EvaluationCase, EvaluationVariant } from '../domain/execution-evaluation.js';
import type { ContextPacket, Hypothesis, TaskSpec } from '../domain/model.js';

export const evaluationStart = 1788566400000;
export const evaluationVariants: EvaluationVariant[] = ['simple', 'complex', 'late_counterevidence', 'partial_result', 'source_missing',
  'permission_revoked', 'tool_errors', 'model_errors', 'next_day_reply', 'mode_change', 'cancel_running', 'stored_model_resume',
  'stored_tool_resume', 'compact', 'unknown_delivery', 'status_only'];
export const evaluationBackends = ['sqlite', 'file-journal'] as const;
export type EvaluationBackend = typeof evaluationBackends[number];
export interface LocalEvaluationCase { specification: EvaluationCase; scenario: Scenario }
export const evaluationConfiguration = {
  version: 'synthetic-execution-v1', planner: { provider: 'scripted', model: 'fixture', revision: '1' },
  source: 'fixed original records from four synthetic fixtures', guidance: 'empty catalog',
  lateObservationResponse: { requested: 'maintenance-ticket', returned: ['maintenance-ticket', 'denied-ticket'], outcome: 'unresolved conflicting originals' },
  compact: 'Complex fixture; auto/deep publish a forced frame before later model assessments. Fast can stop at its declared scope limit.',
  resume: 'Close and reopen repositories after a received response; preserve the ID generator and logical clock.',
  cancel: 'Hold the entered model reply until the cancelled workflow has returned; settle its reported usage and refresh the final checkpoint.',
  limits: { toolCalls: 20, modelCalls: 10, tokens: 1000000, replans: 5, wallTimeMs: 172800000 },
  clock: { initial: evaluationStart, modelMs: 20, toolMs: 5, sendMs: 2, lookupMs: 1, lateSourceMs: 1000 },
  maxStepsPerRun: 150, maxRetryWakes: 12,
} as const;

export async function loadEvaluationCases(runtimeRoot: string): Promise<LocalEvaluationCase[]> {
  const inputs = new Map<string, Scenario>();
  for (const family of ['documents', 'observations']) for (const complexity of ['simple', 'complex']) {
    const id = `${family}-${complexity}`;
    inputs.set(id, validateScenario(JSON.parse(await readFile(join(runtimeRoot, 'fixtures', `${id}.json`), 'utf8'))));
  }
  const result: LocalEvaluationCase[] = [];
  for (const family of ['documents', 'observations']) for (const backend of evaluationBackends)
    for (const mode of ['auto', 'fast', 'deep'] as const) for (const variant of evaluationVariants) {
      const complex = variant === 'complex' || variant === 'late_counterevidence' || variant === 'compact';
      const fixtureId = `${family}-${complex ? 'complex' : 'simple'}`;
      const scenario = structuredClone(inputs.get(fixtureId)!); scenario.goal.mode = mode;
      const simpleId = family === 'documents' ? 'doc-current' : 'collection-complete';
      const ids = complex ? family === 'documents' ? ['doc-b', 'doc-a-amendment'] : ['signal', 'maintenance-ticket'] : [simpleId];
      const failure = ['partial_result', 'source_missing', 'permission_revoked', 'tool_errors', 'model_errors'].includes(variant);
      const contradictory = variant === 'late_counterevidence' && family === 'observations';
      const expectedFinal = variant === 'status_only' ? 'unchanged' : variant === 'cancel_running' ? 'cancelled' :
        failure || contradictory || complex && mode === 'fast' ? 'blocked' : variant === 'unknown_delivery' ? 'wait' : 'complete';
      const complete = !failure && !contradictory && !['status_only', 'cancel_running'].includes(variant);
      const originals = ids.map(id => {
        const source = scenario.evidence.find(e => e.id === id)!;
        return { id, sourceId: source.sourceId, lineageId: source.lineageId, observedAt: source.observedAt };
      });
      result.push({ scenario, specification: {
        id: `${fixtureId}.${backend}.${mode}.${variant}`, family: scenario.family, fixtureId, backend, mode, variant,
        oracle: { expectedFinal, completionEligible: complete, requiredEvidenceIds: ids, originals,
          facts: family === 'documents' ? { 'retention.days': 30 } : complex ? { 'collection.complete': true, 'change.approved': true } : { 'collection.complete': true },
          finalHypothesis: complex ? family === 'documents' ? { id: 'period', status: 'refuted' } : { id: 'approved', status: 'supported' } : null,
          forbiddenEvidenceIds: family === 'documents' ? ['private-doc', 'other-tenant', 'bad-amendment'] : ['revoked-ticket'],
          noCompletionBefore: variant === 'next_day_reply' ? evaluationStart + 86400000 : variant === 'late_counterevidence' ? evaluationStart + 1000 : null },
      } });
    }
  return result;
}

const task = (id: string): TaskSpec => ({ id, description: 'Read the declared synthetic original', toolId: 'fixture.read', toolVersion: '1',
  input: { evidenceIds: [id] }, dependsOn: [], effect: 'read', maxAttempts: 2, satisfies: [] });

/** The fixed script never branches on mode or the scorer's expected outcome. */
export function evaluationReply(input: LocalEvaluationCase, packet: ContextPacket): ModelReply {
  const known = new Set([...packet.evidence.map(e => e.id), ...(packet.evidenceReferences ?? []).map(e => e.id)]);
  let tasks: TaskSpec[]; let hypotheses: Hypothesis[] = [];
  if (input.specification.fixtureId === 'documents-complex') {
    const base: Hypothesis = { id: 'period', question: 'What is the current period?', claim: 'Current period is 90',
      predictedObservation: 'Two current sources report 90', falsifier: 'A current source specifies 30', status: 'open', supportIds: [], counterIds: [], reason: 'Check original and amendment' };
    tasks = (known.has('doc-a-old') ? ['doc-a-old', 'doc-b', 'doc-a-amendment'] : ['doc-a-old']).map(task);
    hypotheses = [known.has('doc-a-amendment') ? { ...base, status: 'refuted', counterIds: ['doc-b', 'doc-a-amendment'] } :
      known.has('doc-b') ? { ...base, status: 'contested', supportIds: ['doc-a-old'], counterIds: ['doc-b'] } :
        known.has('doc-a-old') ? { ...base, status: 'supported', supportIds: ['doc-a-old'] } : base];
  } else if (input.specification.fixtureId === 'observations-complex') {
    const base: Hypothesis = { id: 'approved', question: 'Is the change approved?', claim: 'The change is approved',
      predictedObservation: 'A matching authorization record exists', falsifier: 'A current denial record', status: 'open', supportIds: [], counterIds: [], reason: 'Check observation and authorization' };
    tasks = ['signal', 'maintenance-ticket'].map(task);
    hypotheses = [known.has('denied-ticket') ? { ...base, status: 'refuted', counterIds: ['denied-ticket'] } :
      known.has('maintenance-ticket') ? { ...base, status: 'supported', supportIds: ['maintenance-ticket'] } : base];
  } else {
    const documents = input.scenario.family === 'document_comparison';
    tasks = [task(input.specification.variant === 'partial_result' ? documents ? 'doc-partial' : 'collection-partial' :
      documents ? 'doc-current' : 'collection-complete')];
  }
  return { status: 'ok', provider: 'scripted', model: 'fixture', inputTokens: 100, outputTokens: 50,
    proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
      reason: 'Fixed synthetic proposal; no actual model inference', tasks, hypotheses } };
}
