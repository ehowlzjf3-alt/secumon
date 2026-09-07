import type { Policy, WorkState } from '../domain/model.js';
import type { WorkActor } from './work-resources.js';
import { disclosurePolicyNarrows, type DisclosurePolicy } from '../domain/disclosure.js';
import { DisclosurePolicySchema } from './disclosure-contracts.js';

export interface ExecutionActor {
  readonly tenantId: string;
  readonly principalId: string;
  readonly allowedLabels: readonly string[];
  readonly allowedTools: readonly string[];
  readonly allowedDestinations: readonly string[];
  readonly allowWrites: boolean;
}
export interface ExecutionAuthority {
  readonly actor: ExecutionActor;
  readonly scope: string;
  readonly signal: AbortSignal;
  readonly disclosure?: Readonly<DisclosurePolicy> | undefined;
}
type AuthorityServices = { executionAuthority?: ExecutionAuthority | undefined };
type ExecutionBasis = Pick<WorkState, 'policy'> & { goal: Pick<WorkState['goal'], 'scope'> };
const issued = new WeakSet<object>();
const ceilings = new WeakMap<ExecutionAuthority, Policy>();
function freezeData(value: object): void { for (const child of Object.values(value)) if (child && typeof child === 'object') freezeData(child); Object.freeze(value); }

export function createExecutionAuthority(input: { actor: WorkActor; scope: string; signal: AbortSignal; disclosure?: DisclosurePolicy | undefined }): ExecutionAuthority {
  const actor = input.actor;
  const validText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
  if (!validText(actor.tenantId) || !validText(actor.principalId) || !validText(input.scope) ||
      ![actor.allowedLabels, actor.allowedTools, actor.allowedDestinations].every(value => Array.isArray(value) && value.every(validText)) ||
      typeof actor.allowWrites !== 'boolean' || !(input.signal instanceof AbortSignal)) throw new Error('invalid_execution_authority');
  const frozenActor = Object.freeze({ tenantId: actor.tenantId, principalId: actor.principalId,
    allowedLabels: Object.freeze([...actor.allowedLabels!]), allowedTools: Object.freeze([...actor.allowedTools!]),
    allowedDestinations: Object.freeze([...actor.allowedDestinations!]), allowWrites: actor.allowWrites });
  // The signal remains live; freezing its internal state would prevent revocation.
  const disclosure = input.disclosure === undefined ? undefined : DisclosurePolicySchema.parse(input.disclosure);
  if (disclosure) freezeData(disclosure);
  const authority = Object.freeze({ actor: frozenActor, scope: input.scope, signal: input.signal, ...(disclosure ? { disclosure } : {}) });
  issued.add(authority);
  const ceiling: Policy = { ...frozenActor, allowedLabels: [...frozenActor.allowedLabels], allowedTools: [...frozenActor.allowedTools],
    allowedDestinations: [...frozenActor.allowedDestinations], ...(disclosure ? { disclosure } : {}) };
  freezeData(ceiling); ceilings.set(authority, ceiling);
  return authority;
}

export function executionAuthorityCurrent(services: AuthorityServices, state: ExecutionBasis): boolean {
  const authority = services.executionAuthority;
  if (!authority) return true;
  if (!issued.has(authority) || authority.signal.aborted || authority.scope !== state.goal.scope) return false;
  const actor = authority.actor, policy: Policy = state.policy;
  return policy.tenantId === actor.tenantId && policy.principalId === actor.principalId &&
    policy.allowedLabels.every(value => actor.allowedLabels.includes(value)) &&
    policy.allowedTools.every(value => actor.allowedTools.includes(value)) &&
    policy.allowedDestinations.every(value => actor.allowedDestinations.includes(value)) && (!policy.allowWrites || actor.allowWrites) &&
    disclosurePolicyNarrows(ceilings.get(authority)!, policy);
}

export function assertExecutionAuthority(services: AuthorityServices, state: ExecutionBasis): void {
  if (!executionAuthorityCurrent(services, state)) throw new Error('execution_authority_denied');
}

/** Checks the registered host's custody identity only; never authorizes execution or body disclosure. */
export function assertExecutionCustodyOwner(services: AuthorityServices, state: ExecutionBasis): void {
  const authority = services.executionAuthority;
  if (authority && (!issued.has(authority) || authority.scope !== state.goal.scope ||
      authority.actor.tenantId !== state.policy.tenantId || authority.actor.principalId !== state.policy.principalId))
    throw new Error('execution_custody_denied');
}

export function executionAuthoritySignal(services: AuthorityServices, signal: AbortSignal): AbortSignal {
  return services.executionAuthority ? AbortSignal.any([signal, services.executionAuthority.signal]) : signal;
}
