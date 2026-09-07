import type { WorkState } from '../domain/model.js';
import type { RuntimeServices } from './services.js';
import type { SessionRepository } from './session-ports.js';
import { SessionOriginals } from './session-originals.js';
import { asJson } from './plan-validator.js';
import { UserCommandSchema } from './execution-runtime.js';
import { z } from 'zod';

/** Resolve the original request even when the working context contains only a compact summary. */
export async function agentTurnRequestCurrent(services: RuntimeServices, repository: SessionRepository, state: WorkState): Promise<boolean> {
  try {
    const requirement = state.goal.responseRequirement, basis = state.conversation?.session;
    if (!requirement || !basis) return false;
    const digest = (value: unknown) => services.digester.digest(asJson(value));
    const receipt = await repository.input(basis.scope, requirement.requestMessageId);
    if (!receipt || receipt.status !== 'applied' || !['work', 'command'].includes(receipt.kind) || receipt.workId !== state.id ||
      receipt.sequence > basis.input.sequence || digest(receipt.scope) !== digest(basis.scope) ||
      services.digester.digest(receipt.text) !== requirement.requestTextDigest) return false;
    if (receipt.kind === 'command') {
      const payload = z.strictObject({ expectedGoalRevision: z.number().int().positive(), command: UserCommandSchema }).parse(receipt.payload);
      const command = payload.command;
      if (command.kind !== 'goal' || !command.expectedSessionInput || !command.expectedPolicyDigest ||
        payload.expectedGoalRevision + 1 !== state.goal.revision || command.goal.revision !== state.goal.revision ||
        command.goal.description !== receipt.text || command.goal.description !== state.goal.description || command.goal.scope !== state.goal.scope ||
        digest(command.goal.criteria) !== digest(state.goal.criteria) || digest(command.goal.responseRequirement) !== digest(requirement)) return false;
    }
    let found = false;
    for await (const original of new SessionOriginals(services, repository).read(state, basis, receipt.sequence - 1, receipt.sequence)) {
      if (found || !original.eligible || original.pending || original.entry.role !== 'user' ||
        original.entry.workId !== state.id || original.entry.sourceId !== requirement.requestMessageId ||
        original.entry.sequence !== receipt.sequence || original.entry.text !== receipt.text) return false;
      found = true;
    }
    return found && digest(await repository.input(basis.scope, requirement.requestMessageId)) === digest(receipt);
  } catch { return false; }
}
