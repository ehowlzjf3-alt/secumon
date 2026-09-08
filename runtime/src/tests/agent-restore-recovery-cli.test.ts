import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { AgentLifecycleError } from '../application/agent-lifecycle-contracts.js';
import type { AgentProfileStore } from '../application/agent-profile-contracts.js';
import { runAgentLifecycleCli } from '../presentation/agent-lifecycle-cli.js';

function unreadProfile() {
  let calls = 0;
  const unexpected = (): never => { calls++; throw new Error('profile_access_before_restore_recovery_preflight'); };
  const profiles: AgentProfileStore = { inspect: unexpected, initialize: unexpected, clone: unexpected };
  return { profiles, calls: () => calls };
}
function prepareArgs() {
  return ['restore-recovery-prepare', '--directory', join(process.cwd(), 'original-agent'),
    '--source', join(process.cwd(), 'selected-backup'), '--destination', join(process.cwd(), 'new-recovery'),
    '--digest', 'a'.repeat(64), '--previous', 'b'.repeat(64), '--operation', '7f473a9f-df81-42d9-b4b4-767b17fc0f37', '--offline', '--json'];
}
const isCode = (code: string) => (error: unknown) => error instanceof AgentLifecycleError && error.code === code;

test('restore recovery prepare CLI requires offline confirmation before profile access', async () => {
  const fixture = unreadProfile(), args = prepareArgs().filter(value => value !== '--offline');
  await assert.rejects(runAgentLifecycleCli(args, fixture.profiles, process.cwd()), isCode('lifecycle_offline_confirmation_required'));
  assert.equal(fixture.calls(), 0);
});

test('restore recovery prepare CLI requires the selected backup, destination, and bindings before profile access', async () => {
  for (const name of ['source', 'destination', 'digest', 'previous', 'operation']) {
    const fixture = unreadProfile(), args = prepareArgs(), index = args.indexOf(`--${name}`);
    assert.ok(index > 0); args.splice(index, 2);
    await assert.rejects(runAgentLifecycleCli(args, fixture.profiles, process.cwd()), isCode(`lifecycle_${name}_required`), name);
    assert.equal(fixture.calls(), 0, name);
  }
});

test('restore recovery status CLI requires the selected recovery package before profile access', async () => {
  const fixture = unreadProfile();
  await assert.rejects(runAgentLifecycleCli(['restore-recovery-status', '--json'], fixture.profiles, process.cwd()), isCode('lifecycle_source_required'));
  assert.equal(fixture.calls(), 0);
});
