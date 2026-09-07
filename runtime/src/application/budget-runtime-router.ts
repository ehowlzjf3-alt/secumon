import type { BudgetChildRuntime } from './budget-authority.js';
import type { RuntimeServices } from './services.js';
import type { StateRepository } from './ports.js';
import type { WorkState } from '../domain/model.js';
import { effectProofsCurrent, refreshEffectProofs } from './effect-proofs.js';

type Actor = { tenantId: string; principalId: string };
type Route = { services: RuntimeServices; interrupt: (workId: string) => void };

/** Host composition directory. Agents cannot register a runtime or select another role's session. */
export class BudgetRuntimeRouter implements BudgetChildRuntime {
  #routes = new Map<string, Route>();
  constructor(readonly state: StateRepository) {}
  private key(actor: Actor) { return JSON.stringify([actor.tenantId, actor.principalId]); }
  available(actor: Actor): boolean { return this.#routes.has(this.key(actor)); }
  register(actor: Actor, services: RuntimeServices, interrupt: Route['interrupt']): () => void {
    if (!actor.tenantId.trim() || !actor.principalId.trim() || services.state !== this.state) throw new Error('budget_runtime_registration_invalid');
    const key = this.key(actor);
    if (this.#routes.has(key) || this.#routes.size >= 1024) throw new Error('budget_runtime_registration_conflict');
    const route = { services, interrupt }; this.#routes.set(key, route);
    return () => { if (this.#routes.get(key) === route) this.#routes.delete(key); };
  }
  private async resolve(workId: string): Promise<{ state: WorkState; route: Route }> {
    const state = await this.state.get(workId); if (!state) throw new Error('work_not_found');
    const route = this.#routes.get(this.key(state.policy)); if (!route) throw new Error('budget_child_runtime_unavailable');
    return { state, route };
  }
  async refreshEffects(workId: string): Promise<void> {
    const before = await this.resolve(workId);
    await refreshEffectProofs(before.route.services, workId);
    const after = await this.resolve(workId);
    if (before.route !== after.route) throw new Error('budget_child_runtime_changed');
  }
  async effectsCurrent(workId: string, stateRevision: number): Promise<boolean> {
    try {
      const before = await this.resolve(workId);
      if (before.state.revision !== stateRevision || !(await effectProofsCurrent(before.route.services, before.state))) return false;
      const after = await this.resolve(workId);
      return before.route === after.route && after.state.revision === stateRevision;
    } catch { return false; }
  }
  async interrupt(workId: string): Promise<void> {
    const { route } = await this.resolve(workId); route.interrupt(workId);
  }
}
