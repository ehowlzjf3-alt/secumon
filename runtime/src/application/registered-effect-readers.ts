import type { Attempt, WorkState } from '../domain/model.js';
import type { EffectProofValidator, RuntimeServices } from './services.js';
import { ToolContracts, validProvider } from './tool-contracts.js';
import { asJson, taskDigest } from './plan-validator.js';

/** Capture host registration before composition awaits; built-in receipt readers cannot be replaced. */
export function captureEffectReaders(input?: ReadonlyMap<string, EffectProofValidator>): ReadonlyMap<string, EffectProofValidator> {
  const readers = new Map<string, EffectProofValidator>();
  for (const [provider, reader] of input ?? []) {
    if (!validProvider(provider) || ['core', 'board', 'archive', 'computer'].includes(provider) || readers.has(provider) || !reader)
      throw new Error('effect_reader_registration_invalid');
    const { current, refresh, recover } = reader;
    if (typeof current !== 'function' || typeof refresh !== 'function' || recover !== undefined && typeof recover !== 'function')
      throw new Error('effect_reader_registration_invalid');
    readers.set(provider, Object.freeze({ current: current.bind(reader), refresh: refresh.bind(reader),
      ...(recover ? { recover: recover.bind(reader) } : {}) }));
  }
  return readers;
}

type Services = Pick<RuntimeServices, 'state' | 'digester'>;
function fail(): never { throw new Error('effect_reader_binding_changed'); }
function attemptIdentity(attempt: Attempt) {
  return { id: attempt.id, taskId: attempt.taskId, toolId: attempt.toolId, toolVersion: attempt.toolVersion,
    contractDigest: attempt.contractDigest ?? null, inputDigest: attempt.inputDigest, effect: attempt.effect,
    scope: attempt.scope, goalRevision: attempt.goalRevision, planRevision: attempt.planRevision,
    owner: attempt.owner, startedAt: attempt.startedAt, leaseUntil: attempt.leaseUntil };
}

/** Delegates only receipt inspection/reconciliation. This router never invokes a tool or commits a work state. */
export function registeredEffectReaders(services: Services, contracts: ToolContracts, readers: ReadonlyMap<string, EffectProofValidator>) {
  const digest = (value: unknown) => services.digester.digest(asJson(value));
  const read = async (workId: string) => {
    const state = await services.state.get(workId);
    if (!state || state.id !== workId) throw new Error('work_not_found');
    return state;
  };
  const sameOwner = (left: WorkState, right: WorkState) => left.id === right.id && left.createdAt === right.createdAt &&
    left.policy.tenantId === right.policy.tenantId && left.policy.principalId === right.policy.principalId;
  const contract = (attempt: Attempt, provider: string) => {
    const entry = contracts.get(attempt.toolId, attempt.toolVersion);
    if (!entry || attempt.effect !== 'write' || entry.tool.definition.effect !== 'write' ||
      entry.tool.definition.provider !== provider || attempt.contractDigest !== digest(entry.tool.definition) ||
      attempt.effectReceipt && attempt.effectReceipt.provider !== provider) return fail();
    return entry;
  };
  const providers = (state: WorkState) => {
    const selected = new Set<string>();
    for (const attempt of state.attempts) if (attempt.effectReceipt && readers.has(attempt.effectReceipt.provider)) {
      contract(attempt, attempt.effectReceipt.provider); selected.add(attempt.effectReceipt.provider);
    }
    return selected;
  };
  return {
    has: (provider: string) => readers.has(provider),
    async current(state: WorkState): Promise<boolean> {
      try {
        const selected = providers(state);
        if (!selected.size) return true;
        for (const provider of selected) if (!(await readers.get(provider)!.current(structuredClone(state)))) return false;
        providers(state);
        return digest(await read(state.id)) === digest(state);
      } catch { return false; }
    },
    async refresh(workId: string): Promise<WorkState> {
      let state = await read(workId); const original = state;
      for (const provider of providers(state)) {
        // A preceding reader may have changed which receipts remain applicable.
        if (!providers(state).has(provider)) continue;
        await readers.get(provider)!.refresh(workId);
        state = await read(workId);
        if (!sameOwner(original, state)) fail();
      }
      providers(state); return state;
    },
    async recover(workId: string, attemptId: string): Promise<WorkState> {
      const state = await read(workId), attempt = state.attempts.find(value => value.id === attemptId);
      if (!attempt) return state;
      if (attempt.status === 'reserved' && !attempt.effectReceipt) return state;
      const registered = contracts.get(attempt.toolId, attempt.toolVersion);
      const provider = attempt.effectReceipt?.provider ?? (registered && attempt.contractDigest === digest(registered.tool.definition)
        ? registered.tool.definition.provider : undefined);
      const reader = provider ? readers.get(provider) : undefined;
      if (!provider || !reader?.recover) return state;
      const entry = contract(attempt, provider);
      const dispatch = await services.state.receipt(workId, `dispatch:${attemptId}`);
      const original = dispatch?.state.attempts.find(value => value.id === attemptId);
      const task = dispatch?.state.plan?.tasks.find(value => value.id === original?.taskId);
      if (!dispatch || !original || !task || original.status !== 'running' || !sameOwner(state, dispatch.state) ||
        dispatch.state.revision > state.revision || dispatch.state.updatedAt > state.updatedAt ||
        digest(attemptIdentity(original)) !== digest(attemptIdentity(attempt)) || task.effect !== 'write' ||
        task.toolId !== attempt.toolId || task.toolVersion !== attempt.toolVersion || taskDigest(task, services.digester) !== attempt.inputDigest ||
        original.scope !== dispatch.state.goal.scope || original.goalRevision !== dispatch.state.goal.revision ||
        original.planRevision !== dispatch.state.plan?.revision ||
        dispatch.digest !== digest({ type: 'attempt_dispatched', data: { attemptId, owner: original.owner } })) fail();
      if (digest(await read(workId)) !== digest(state) || contracts.get(attempt.toolId, attempt.toolVersion) !== entry) fail();
      await reader.recover(workId, attemptId);
      const current = await read(workId), recovered = current.attempts.find(value => value.id === attemptId);
      if (!sameOwner(state, current) || !recovered || digest(attemptIdentity(recovered)) !== digest(attemptIdentity(attempt)) ||
        contracts.get(attempt.toolId, attempt.toolVersion) !== entry) fail();
      contract(recovered!, provider); return current;
    },
  };
}
