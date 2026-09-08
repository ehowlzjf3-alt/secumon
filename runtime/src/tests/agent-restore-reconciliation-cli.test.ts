import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLifecycleError } from '../application/agent-lifecycle-contracts.js';
import type { AgentProfileStore } from '../application/agent-profile-contracts.js';
import { runAgentLifecycleCli } from '../presentation/agent-lifecycle-cli.js';

function unreadProfile() {
  let calls = 0;
  const unexpected = (): never => { calls++; throw new Error('profile_access_before_restore_reconciliation_preflight'); };
  const profiles: AgentProfileStore = { inspect: unexpected, initialize: unexpected, clone: unexpected };
  return { profiles, calls: () => calls };
}

test('restore reconciliation CLI requires offline confirmation before profile access', async () => {
  const fixture = unreadProfile();
  await assert.rejects(runAgentLifecycleCli(['restore-reconcile', '--directory', process.cwd(), '--json'], fixture.profiles, process.cwd()),
    (error: unknown) => error instanceof AgentLifecycleError && error.code === 'lifecycle_offline_confirmation_required');
  assert.equal(fixture.calls(), 0);
});

test('restore reconciliation CLI requires host sources before profile access', async () => {
  const fixture = unreadProfile();
  await assert.rejects(runAgentLifecycleCli(['restore-reconcile', '--directory', process.cwd(), '--offline', '--json'], fixture.profiles, process.cwd()),
    (error: unknown) => error instanceof AgentLifecycleError && error.code === 'agent_restore_sources_required');
  assert.equal(fixture.calls(), 0);
});

test('restore reconciliation CLI rejects an empty host source registration', async () => {
  const fixture = unreadProfile();
  await assert.rejects(runAgentLifecycleCli(['restore-reconcile', '--directory', process.cwd(), '--offline', '--json'], fixture.profiles, process.cwd(),
    { restoreReconciliation: { sources: new Map() } }),
    (error: unknown) => error instanceof AgentLifecycleError && error.code === 'agent_restore_sources_required');
  assert.equal(fixture.calls(), 0);
});
