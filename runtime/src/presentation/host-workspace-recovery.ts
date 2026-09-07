import { recoverAgentWorkspace, openRecoveredAgentWorkspace, type WorkspaceRecoveryHost } from '../infrastructure/agent-workspace-recovery.js';
import { disjoint, lifecycleRoot } from '../infrastructure/agent-lifecycle-files.js';

/** Host API only. It does not register a tool, change a default workspace, or run an attempt. */
export function createHostWorkspaceRecovery(input: WorkspaceRecoveryHost & { root: string; signal: AbortSignal }) {
  const actor = structuredClone(input.actor);
  const root = lifecycleRoot(input.root);
  const current = input.assertCurrent.bind(input);
  const pending = new Set<Promise<unknown>>();
  const opened = new Set<Awaited<ReturnType<typeof openRecoveredAgentWorkspace>>>();
  let closed = false, closing: Promise<void> | undefined;
  const assertCurrent = async () => {
    if (closed || input.signal.aborted) throw new Error('workspace_recovery_host_closed');
    await current();
    if (closed || input.signal.aborted) throw new Error('workspace_recovery_host_closed');
  };
  const host: WorkspaceRecoveryHost = { agentId: input.agentId, services: input.services, actor, assertCurrent };
  function run<T>(action: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(async () => { await assertCurrent(); return action(); });
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }
  return Object.freeze({
    recover(options: Parameters<typeof recoverAgentWorkspace>[1]) {
      const selected = structuredClone(options);
      return run(() => {
        const destination = lifecycleRoot(selected.destination, false); disjoint(root, destination);
        return recoverAgentWorkspace(host, { ...selected, destination });
      });
    },
    open(options: Parameters<typeof openRecoveredAgentWorkspace>[1]) {
      const selected = structuredClone(options);
      return run(async () => {
        const directory = lifecycleRoot(selected.directory); disjoint(root, directory);
        const value = await openRecoveredAgentWorkspace(host, { ...selected, directory });
        try { await assertCurrent(); }
        catch (error) {
          try { await value.close(); }
          catch (cleanup) { throw new AggregateError([error, cleanup], 'workspace_recovery_open_close_failed', { cause: error }); }
          throw error;
        }
        let closingValue: Promise<void> | undefined;
        const managed = Object.freeze({ ...value,
          close: () => closingValue ??= value.close().then(() => { opened.delete(managed); }) });
        opened.add(managed);
        return managed;
      });
    },
    close() {
      closed = true;
      return closing ??= (async () => {
        const settled = await Promise.allSettled([...pending]);
        const errors: unknown[] = settled.flatMap(value => value.status === 'rejected' ? [value.reason] : []);
        for (const value of opened) {
          try { await value.close(); opened.delete(value); } catch (error) { errors.push(error); }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, 'workspace_recovery_host_close_failed');
      })();
    },
  });
}
