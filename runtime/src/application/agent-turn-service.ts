import { z } from 'zod';
import { BindingInputSchema } from './conversation-service.js';
import { BudgetSchema, PolicySchema } from './contracts.js';
import type { Digester } from './ports.js';
import type { SessionService } from './session-service.js';
import type { WorkActor } from './work-resources.js';
import { executionControl } from '../domain/execution-policy.js';
import { SessionInputBasisSchema } from './session-base-contracts.js';
import { UserCommandSchema, type UserCommand } from './execution-runtime.js';
import { asJson } from './plan-validator.js';

const id = z.string().min(1).max(256);
const rawText = z.string().min(1).max(64000).refine(value => value.trim().length > 0, 'request_text_required');
const RequestSchema = z.strictObject({
  sessionId: id, messageId: id, rawText, binding: BindingInputSchema.omit({ session: true }),
  scope: id, mode: z.enum(['auto', 'fast', 'deep']), policy: PolicySchema, limits: BudgetSchema.shape.limits,
});
const FollowUpSchema = z.strictObject({
  sessionId: id, messageId: id, workId: id, rawText, expectedGoalRevision: z.number().int().positive(),
  action: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('continue') }),
    z.strictObject({ kind: z.literal('clarify'), obligationId: id })]),
});
const GoalChangeSchema = z.strictObject({
  sessionId: id, messageId: id, workId: id, rawText,
  expectedGoalRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
  expectedControlRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
  mode: z.enum(['auto', 'fast', 'deep']).optional(), expectedInput: SessionInputBasisSchema.optional(),
});
export type AgentTurnRequest = z.infer<typeof RequestSchema>;
export type AgentTurnFollowUp = z.infer<typeof FollowUpSchema>;
export type AgentTurnGoalChange = z.infer<typeof GoalChangeSchema>;

/** Host-supplied authority and routing surround user text; no model chooses work identity or permissions. */
export class AgentTurnService {
  constructor(private readonly sessions: SessionService, private readonly digester: Digester) {}

  async accept(actor: WorkActor, value: AgentTurnRequest) {
    const input = RequestSchema.parse(value);
    if (actor.allowedTools && input.policy.allowedTools.some(tool => !actor.allowedTools!.includes(tool)) ||
        actor.allowWrites === false && input.policy.allowWrites) throw new Error('request_not_authorized');
    // SessionService durably receives the original before creating work, then reuses its receipt on retry.
    return this.sessions.accept(actor, { sessionId: input.sessionId, rawText: input.rawText, request: {
      messageId: input.messageId, binding: input.binding, policy: input.policy, limits: input.limits, completionRequiresDelivery: true,
      goal: { revision: 1, description: input.rawText, scope: input.scope, mode: input.mode, criteria: [],
        responseRequirement: { version: 1, requestMessageId: input.messageId, requestTextDigest: this.digester.digest(input.rawText), format: 'text' } },
    } });
  }

  async followUp(actor: WorkActor, value: AgentTurnFollowUp) {
    const { action, ...input } = FollowUpSchema.parse(value);
    // Both commands advance AppliedSessionInput, while retaining the original goal and response requirement.
    return this.sessions.command(actor, { ...input, command: action.kind === 'clarify'
      ? { kind: 'resolve', obligationId: action.obligationId, reason: 'agent_question_answered' }
      : { kind: 'input', reason: 'agent_followup_received' } });
  }

  async goalChangeBasis(actor: WorkActor, value: { sessionId: string; workId: string }) {
    const { state } = await this.sessions.commandContext(actor, value);
    if (!state.goal.responseRequirement || state.goal.criteria.length) throw new Error('agent_goal_change_unavailable');
    const control = executionControl(state);
    return { workId: state.id, description: state.goal.description, expectedGoalRevision: state.goal.revision,
      expectedControlRevision: control.revision, expectedInput: state.conversation!.session!.input,
      mode: control.pending?.mode ?? control.requestedMode };
  }

  async changeGoal(actor: WorkActor, value: AgentTurnGoalChange) {
    const input = GoalChangeSchema.parse(value);
    const { state, receipt } = await this.sessions.commandContext(actor, {
      sessionId: input.sessionId, workId: input.workId, messageId: input.messageId,
    });
    const digest = (value: unknown) => this.digester.digest(asJson(value));
    const responseRequirement = { version: 1 as const, requestMessageId: input.messageId,
      requestTextDigest: this.digester.digest(input.rawText), format: 'text' as const };
    let command: Extract<UserCommand, { kind: 'goal' }>;
    if (receipt) {
      const saved = z.strictObject({ expectedGoalRevision: z.number().int().positive(), command: UserCommandSchema }).safeParse(receipt.payload);
      if (receipt.workId !== input.workId || receipt.kind !== 'command' || receipt.text !== input.rawText || !saved.success ||
        saved.data.expectedGoalRevision !== input.expectedGoalRevision || saved.data.command.kind !== 'goal') throw new Error('session_input_identity_conflict');
      command = saved.data.command;
      if (!command.expectedSessionInput || !command.expectedPolicyDigest || command.expectedControlRevision !== input.expectedControlRevision ||
        command.goal.revision !== input.expectedGoalRevision + 1 || command.goal.criteria.length || command.goal.description !== input.rawText ||
        digest(command.goal.responseRequirement) !== digest(responseRequirement) || input.mode !== undefined && input.mode !== command.goal.mode ||
        input.expectedInput !== undefined && digest(input.expectedInput) !== digest(command.expectedSessionInput)) throw new Error('session_input_identity_conflict');
    } else {
      if (!state.goal.responseRequirement || state.goal.criteria.length) throw new Error('agent_goal_change_unavailable');
      const control = executionControl(state);
      command = { kind: 'goal', expectedControlRevision: input.expectedControlRevision,
        expectedSessionInput: input.expectedInput ?? state.conversation!.session!.input, expectedPolicyDigest: digest(state.policy),
        goal: { revision: input.expectedGoalRevision + 1, description: input.rawText, scope: state.goal.scope,
          mode: input.mode ?? control.pending?.mode ?? control.requestedMode, criteria: [], responseRequirement } };
    }
    // The persisted command, including its first input/policy basis, survives post-commit receipt recovery.
    return this.sessions.command(actor, { sessionId: input.sessionId, messageId: input.messageId, workId: input.workId,
      rawText: input.rawText, expectedGoalRevision: input.expectedGoalRevision, command });
  }
}
