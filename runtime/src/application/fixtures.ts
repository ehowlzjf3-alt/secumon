import { z } from 'zod';
import { evaluateCompletion } from '../domain/completion.js';
import { decide } from '../domain/control.js';
import { newWork } from './new-work.js';
import { EvidenceSchema, GoalSchema, HypothesisSchema, ObligationSchema, PlanSchema, PolicySchema, parseContract } from './contracts.js';

export const ScenarioSchema = z.strictObject({
  id: z.string().min(1), family: z.enum(['document_comparison', 'observation_review']), complexity: z.enum(['simple', 'complex']),
  description: z.string(), synthetic: z.literal(true), goal: GoalSchema, policy: PolicySchema,
  evidence: z.array(EvidenceSchema), hypotheses: z.array(HypothesisSchema),
  checkpoints: z.array(z.strictObject({
    name: z.string(), evidenceIds: z.array(z.string()), obligations: z.array(ObligationSchema), expectedComplete: z.boolean(),
    expectedReasons: z.array(z.string()), expectedEvidenceIds: z.array(z.string()),
    goalOverride: GoalSchema.nullable(), expectedControl: z.enum(['continue', 'replan', 'wait', 'blocked', 'complete', 'cancelled']),
    execution: z.strictObject({ at: z.number().int().nonnegative(), status: z.enum(['ready', 'cancelled']), plan: PlanSchema.nullable(),
      toolCallsUsed: z.number().int().nonnegative(), toolCallLimit: z.number().int().nonnegative() }),
  })).min(1),
});
export type Scenario = z.infer<typeof ScenarioSchema>;
export function validateScenario(value: unknown): Scenario {
  const scenario = parseContract(ScenarioSchema, value);
  if (new Set(scenario.evidence.map(e => e.id)).size !== scenario.evidence.length) throw new Error('duplicate_fixture_evidence');
  if (new Set(scenario.goal.criteria.map(c => c.id)).size !== scenario.goal.criteria.length) throw new Error('duplicate_fixture_criterion');
  for (const checkpoint of scenario.checkpoints) {
    for (const id of [...checkpoint.evidenceIds, ...checkpoint.expectedEvidenceIds]) {
      if (!scenario.evidence.some(e => e.id === id)) throw new Error('missing_fixture_evidence');
    }
  }
  return scenario;
}
export function evaluateScenario(scenario: Scenario) {
  return scenario.checkpoints.map(checkpoint => {
    const evidence = checkpoint.evidenceIds.map(id => scenario.evidence.find(e => e.id === id)!);
    const result = evaluateCompletion(checkpoint.goalOverride ?? scenario.goal, evidence, checkpoint.obligations, scenario.policy);
    const reasons = [...result.blockers, ...result.criteria.flatMap(c => c.reasons)];
    const adopted = result.criteria.flatMap(c => c.evidenceIds);
    const state = newWork({ id: scenario.id, goal: checkpoint.goalOverride ?? scenario.goal, policy: scenario.policy, now: checkpoint.execution.at,
      limits: { toolCalls: checkpoint.execution.toolCallLimit, modelCalls: 3, tokens: 10000, replans: 3, wallTimeMs: 120000 } });
    state.status = checkpoint.execution.status; state.statusReason = checkpoint.execution.status === 'cancelled' ? 'user_cancelled' : 'fixture_checkpoint';
    state.plan = checkpoint.execution.plan; state.evidence = evidence; state.obligations = checkpoint.obligations;
    state.budget.used.toolCalls = checkpoint.execution.toolCallsUsed;
    const control = decide(state, checkpoint.execution.at);
    const passed = result.complete === checkpoint.expectedComplete && control.kind === checkpoint.expectedControl && checkpoint.expectedReasons.every(r => reasons.includes(r)) && checkpoint.expectedEvidenceIds.every(id => adopted.includes(id));
    return { checkpoint: checkpoint.name, passed, result, control };
  });
}
