import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { AgentLifecycleError } from '../application/agent-lifecycle-contracts.js';
import type { AgentProfileStore } from '../application/agent-profile-contracts.js';
import { runAgentLifecycleCli } from '../presentation/agent-lifecycle-cli.js';

function unreadProfile() {
  let calls = 0;
  const unexpected = (): never => { calls++; throw new Error('profile_access_before_restore_application_preflight'); };
  const profiles: AgentProfileStore = { inspect: unexpected, initialize: unexpected, clone: unexpected };
  return { profiles, calls: () => calls };
}
function applyArgs() {
  return ['restore-recovery-apply', '--source', join(process.cwd(), 'prepared-recovery'), '--digest', 'a'.repeat(64), '--offline', '--json'];
}
const isCode = (code: string) => (error: unknown) => error instanceof AgentLifecycleError && error.code === code;

test('restore recovery apply CLI requires offline confirmation before profile access', async () => {
  const fixture = unreadProfile(), args = applyArgs().filter(value => value !== '--offline');
  await assert.rejects(runAgentLifecycleCli(args, fixture.profiles, process.cwd()), isCode('lifecycle_offline_confirmation_required'));
  assert.equal(fixture.calls(), 0);
});

test('restore recovery apply CLI requires a selected package and its exact digest before profile access', async () => {
  for (const name of ['source', 'digest']) {
    const fixture = unreadProfile(), args = applyArgs(), index = args.indexOf(`--${name}`);
    assert.ok(index > 0); args.splice(index, 2);
    await assert.rejects(runAgentLifecycleCli(args, fixture.profiles, process.cwd()), isCode(`lifecycle_${name}_required`), name);
    assert.equal(fixture.calls(), 0, name);
  }
});

test('restore recovery apply status CLI requires the selected package before profile access', async () => {
  const fixture = unreadProfile();
  await assert.rejects(runAgentLifecycleCli(['restore-recovery-apply-status', '--json'], fixture.profiles, process.cwd()), isCode('lifecycle_source_required'));
  assert.equal(fixture.calls(), 0);
});
