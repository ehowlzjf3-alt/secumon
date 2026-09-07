import { z } from 'zod';
import type { BudgetOwner, BudgetWorkAddress } from '../domain/budget-delegation.js';
import type { Policy, WorkState } from '../domain/model.js';
import type { ArtifactStore, StateRepository } from './ports.js';
import type { RuntimeServices } from './services.js';
import type { BudgetAuthority, BudgetAuthorityBinding, BudgetInvocation } from './budget-authority.js';
import { PolicySchema } from './contracts.js';
import { BudgetWorkAddressSchema } from './budget-delegation-contracts.js';
import { effectProofsCurrent, refreshEffectProofs } from './effect-proofs.js';
import { frozen } from './resource-contracts.js';

export interface BudgetWorkLedger {
  readonly owner: BudgetOwner;
  /** Only get/receipt/commit are supported; no general work discovery or store lifetime ownership. */
  readonly state: StateRepository;
  /** Only existence checks are supported; raw text is never copied between owners. */
  readonly artifacts: ArtifactStore;
  current(): boolean;
  owns(state: StateRepository): boolean;
  refreshEffects(workId: string): Promise<void>;
  effectsCurrent(workId: string, revision: number): Promise<boolean>;
  interrupt(workId: string): Promise<void>;
  run(workId: string, maxSteps: number, signal: AbortSignal): Promise<unknown>;
}
export interface BudgetRecipient {
  readonly id: string;
  readonly owner: BudgetOwner;
  readonly policy: Policy;
  readonly revision: number;
}
export interface BudgetWorkLedgers extends BudgetAuthority {
  resolve(address: BudgetWorkAddress): BudgetWorkLedger;
  recipient(id: string): BudgetRecipient | undefined;
  recipients(): readonly BudgetRecipient[];
}
export interface BudgetLedgerRegistration {
  services: RuntimeServices;
  run(workId: string, maxSteps: number, signal: AbortSignal): Promise<unknown>;
  interrupt(workId: string): void;
}
export interface BudgetRecipientRegistration {
  owner: BudgetOwner;
  policy: Policy;
  revision: number;
  approve(binding: BudgetAuthorityBinding, purpose: 'allocation' | 'execution', signal?: AbortSignal, invocation?: BudgetInvocation): Promise<boolean>;
}
const id = z.string().min(1).max(256).refine(value => value.trim().length > 0);
const OwnerSchema = z.strictObject({ tenantId: id, principalId: id, scope: id });
const unavailable = () => new Error('budget_owner_ledger_unavailable');
export function budgetWorkAddress(work: WorkState): BudgetWorkAddress {
  return { tenantId: work.policy.tenantId, principalId: work.policy.principalId, scope: work.goal.scope, workId: work.id };
}
export function budgetAddressMatches(address: BudgetWorkAddress, work: WorkState): boolean {
  return address.workId === work.id && address.tenantId === work.policy.tenantId && address.principalId === work.policy.principalId && address.scope === work.goal.scope;
}
const key = (owner: BudgetOwner) => JSON.stringify([owner.tenantId, owner.principalId, owner.scope]);

/** Explicit in-process registration. Reopening requires the same owner addresses to be registered again. */
export class HostBudgetLedgerRouter implements BudgetWorkLedgers {
  readonly #ledgers = new Map<string, BudgetWorkLedger>();
  readonly #recipients = new Map<string, { value: BudgetRecipient; approve: BudgetRecipientRegistration['approve'] }>();
  register(value: BudgetOwner, registration: BudgetLedgerRegistration): () => void {
    const owner = frozen(OwnerSchema.parse(structuredClone(value))), ownerKey = key(owner);
    if (this.#ledgers.has(ownerKey) || this.#ledgers.size >= 1024) throw new Error('budget_ledger_registration_conflict');
    const { services, run, interrupt } = registration;
    if (!services || typeof run !== 'function' || typeof interrupt !== 'function') throw unavailable();
    const source = services.state, artifacts = services.artifacts;
    const get = source.get.bind(source), receipt = source.receipt.bind(source), commit = source.commit.bind(source), exists = artifacts.exists.bind(artifacts);
    const execute = run.bind(registration), stop = interrupt.bind(registration);
    const current = () => this.#ledgers.get(ownerKey) === ledger && services.state === source && services.artifacts === artifacts;
    const check = () => { if (!current()) throw unavailable(); };
    const owned = (work: WorkState) => {
      if (key(budgetWorkAddress(work)) !== ownerKey) throw new Error('budget_work_owner_mismatch');
      return work;
    };
    const read = async (workId: string) => { check(); const work = await get(workId); check(); return work ? owned(work) : null; };
    const denied = async (): Promise<never> => { throw new Error('budget_ledger_operation_denied'); };
    const state: StateRepository = {
      get: read,
      async receipt(workId, commandId) { check(); const found = await receipt(workId, commandId); check(); if (found) owned(found.state); return found; },
      async commit(request) {
        check(); owned(request.next);
        if (request.next.id !== request.workId || request.deliveries.length || !request.events.length || request.events.some(event => !event.type.startsWith('budget_')))
          throw new Error('budget_ledger_operation_denied');
        const prior = await read(request.workId); if (prior) owned(prior); check();
        const result = await commit(request); check();
        if (result.kind === 'committed' || result.kind === 'duplicate') owned(result.state);
        return result;
      },
      events: denied, recentEventMetadata: denied, deliveries: denied, workIdsForConversation: denied,
      conversationWorkPage: denied, runnable: denied, close: denied,
    };
    const ledger: BudgetWorkLedger = Object.freeze({ owner, state: Object.freeze(state),
      artifacts: Object.freeze({ put: denied, get: denied, async exists(ref) {
        check(); if (ref.tenantId !== owner.tenantId) throw new Error('budget_work_owner_mismatch');
        const result = await exists(ref); check(); return result;
      } } satisfies ArtifactStore), current, owns: (candidate: StateRepository) => current() && (candidate === source || candidate === state),
      async refreshEffects(workId: string) { if (!(await read(workId))) throw unavailable(); await refreshEffectProofs(services, workId); check(); await read(workId); },
      async effectsCurrent(workId: string, revision: number) {
        const before = await read(workId); if (!before || before.revision !== revision || !(await effectProofsCurrent(services, before))) return false;
        const after = await read(workId); return !!after && after.revision === revision;
      },
      async interrupt(workId: string) { if (!(await read(workId))) throw unavailable(); stop(workId); check(); },
      async run(workId: string, maxSteps: number, signal: AbortSignal) {
        if (signal.aborted || !Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100 || !(await read(workId))) throw unavailable();
        await execute(workId, maxSteps, signal); check();
        const after = await read(workId); if (!after) throw unavailable();
        // The sponsor receives ledger/status metadata, never a recipient context or artifact reference.
        return { status: after.status, stateRevision: after.revision, goalRevision: after.goal.revision };
      },
    });
    this.#ledgers.set(ownerKey, ledger);
    return () => { if (this.#ledgers.get(ownerKey) === ledger) this.#ledgers.delete(ownerKey); };
  }
  registerRecipient(name: string, registration: BudgetRecipientRegistration): () => void {
    id.parse(name);
    if (this.#recipients.has(name) || this.#recipients.size >= 64) throw new Error('budget_recipient_registration_conflict');
    const { owner: rawOwner, policy: rawPolicy, revision: rawRevision, approve: callback } = registration;
    const owner = OwnerSchema.parse(structuredClone(rawOwner)), policy = PolicySchema.parse(structuredClone(rawPolicy));
    const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).parse(rawRevision);
    if (typeof callback !== 'function' || policy.tenantId !== owner.tenantId || policy.principalId !== owner.principalId) throw unavailable();
    const entry = { value: frozen({ id: name, owner, policy, revision }), approve: callback.bind(registration) };
    this.#recipients.set(name, entry);
    return () => { if (this.#recipients.get(name) === entry) this.#recipients.delete(name); };
  }
  resolve(value: BudgetWorkAddress): BudgetWorkLedger {
    const address = BudgetWorkAddressSchema.parse(value), ledger = this.#ledgers.get(key(address));
    if (!ledger?.current()) throw unavailable(); return ledger;
  }
  recipient(name: string): BudgetRecipient | undefined { return this.#recipients.get(name)?.value; }
  recipients(): readonly BudgetRecipient[] { return Object.freeze([...this.#recipients.values()].map(entry => entry.value)); }
  async current(binding: BudgetAuthorityBinding, purpose: 'allocation' | 'execution', signal?: AbortSignal, invocation?: BudgetInvocation): Promise<boolean> {
    const recipientId = binding.mandate.attributes?.['recipientId'];
    const entry = recipientId ? this.#recipients.get(recipientId) : undefined;
    if (!entry || signal?.aborted || binding.mandate.provider !== 'host-budget-ledger' || binding.mandate.referenceId !== binding.grantId ||
      binding.mandate.revision !== entry.value.revision || binding.mandate.childGoalRevision !== binding.child.goalRevision ||
      binding.parent.tenantId !== entry.value.owner.tenantId || key({ ...binding.child.policy, scope: binding.child.scope }) !== key(entry.value.owner)) return false;
    const ledger = this.resolve({ ...entry.value.owner, workId: binding.child.workId });
    // A changed registered policy invalidates permission; historical accounting remains separate.
    const digest = (value: unknown) => JSON.stringify(PolicySchema.parse(value));
    if (digest(binding.child.policy) !== digest(entry.value.policy)) return false;
    const accepted = await entry.approve(frozen(structuredClone(binding)), purpose, signal, invocation ? frozen(structuredClone(invocation)) : undefined);
    return accepted === true && !signal?.aborted && this.#recipients.get(recipientId!) === entry && ledger.current();
  }
}
