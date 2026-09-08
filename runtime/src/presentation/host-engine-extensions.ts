import { captureEngineApi } from '../application/engine-extension-contracts.js';
import type { AgentPostgresHost } from '../infrastructure/agent-postgres-storage.js';
import type { HostBudgetRegistration } from './host-tools.js';

function guarded<A extends unknown[], R>(method: (...args: A) => R, owner: unknown, check: () => void) {
  return (...args: A): R => { check(); return method.apply(owner, args); };
}
/** Direct port registrations have no open callback; preserve their owner while guarding actual calls. */
export function captureHostBudgetRegistration(value: HostBudgetRegistration | undefined): HostBudgetRegistration | undefined {
  if (value === undefined) return undefined;
  const api = captureEngineApi(value), authority = value.authority, children = value.children, ledgers = value.ledgers;
  return Object.freeze({ ...(api.engineApi ? { engineApi: api.engineApi } : {}),
    ...(authority ? { authority: Object.freeze({ current: guarded(authority.current, authority, api.assertCurrent) }) } : {}),
    ...(children ? { children: Object.freeze({ available: guarded(children.available, children, api.assertCurrent),
      refreshEffects: guarded(children.refreshEffects, children, api.assertCurrent), effectsCurrent: guarded(children.effectsCurrent, children, api.assertCurrent),
      interrupt: guarded(children.interrupt, children, api.assertCurrent) }) } : {}),
    ...(ledgers ? { ledgers: Object.freeze({ current: guarded(ledgers.current, ledgers, api.assertCurrent),
      resolve: guarded(ledgers.resolve, ledgers, api.assertCurrent), recipient: guarded(ledgers.recipient, ledgers, api.assertCurrent),
      recipients: guarded(ledgers.recipients, ledgers, api.assertCurrent) }) } : {}),
  });
}
export function captureHostPostgresRegistration(value: AgentPostgresHost | undefined): AgentPostgresHost | undefined {
  if (value === undefined) return undefined;
  const api = captureEngineApi(value), pool = value.pool;
  return Object.freeze({ ...(api.engineApi ? { engineApi: api.engineApi } : {}), selection: structuredClone(value.selection),
    pool: Object.freeze({ connect: guarded(pool.connect, pool, api.assertCurrent) }) });
}
