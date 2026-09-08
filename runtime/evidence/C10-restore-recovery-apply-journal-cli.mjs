import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_LOCAL_RESTORE_COMPLETION } from '../dist/application/agent-lifecycle-contracts.js';
import { FileAgentProfileStore } from '../dist/infrastructure/file-agent-profile.js';
import { backupAgent, restoreAgentBackup } from '../dist/infrastructure/agent-lifecycle.js';
import { captureLifecycleTree } from '../dist/infrastructure/agent-lifecycle-files.js';
import { inspectAgentHostIdentity } from '../dist/infrastructure/agent-host-identities.js';
import { rebindRestoredAgentHostIdentity } from '../dist/infrastructure/agent-host-identity-recovery.js';
import { inspectAgentRestoreReconciliation } from '../dist/infrastructure/agent-restore-reconciliation.js';
import { inspectAgentRestoreRecovery } from '../dist/infrastructure/agent-restore-recovery.js';
import { openAgentTurnProfile } from '../dist/presentation/agent-turn-profile.js';
import { runAgentCli } from '../dist/presentation/agent-cli.js';
import { writeComputerEntryFixture, WRITE_COMPUTER_PROFILE, ENTRY_TEXT, WRITE_TOOL } from '../dist/tests/host-write-computer-entry-fixture.js';

const runtimeRoot = fileURLToPath(new URL('../', import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), 'secumon-recovery-apply-journal-cli-')));
const directory = join(base, 'agent'), recoveryDirectory = join(base, 'recovery');
const identityOptions = { registryDirectory: join(base, 'registry'), engineDirectories: [runtimeRoot] };
const profiles = new FileAgentProfileStore(runtimeRoot), active = new Set(), hosts = [];
async function open() {
  const host = writeComputerEntryFixture({ base, mode: 'write' }); hosts.push(host);
  const profile = await openAgentTurnProfile(directory, { provider: 'registered' }, host.host);
  active.add(profile); return profile;
}
async function close(profile) { await profile.close(); active.delete(profile); }
const counts = () => ({ modelCalls: hosts.reduce((sum, h) => sum + h.observed.inputs.length, 0), writes: hosts.reduce((sum, h) => sum + h.observed.writes, 0) });
async function cli(args) {
  const original = process.stdout.write; let output = '';
  process.stdout.write = function (chunk) { output += String(chunk); return true; };
  try { await runAgentCli(['lifecycle', ...args, '--json'], { identityRegistryDirectory: identityOptions.registryDirectory }); }
  finally { process.stdout.write = original; }
  assert.ok(output.length < 4096, 'CLI returns paths and counts rather than all archive entries');
  return JSON.parse(output);
}
try {
  const profile = profiles.initialize(directory, { stateBackend: 'file-journal', personalMemory: 'documents' });
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...profile.config, model: { profile: WRITE_COMPUTER_PROFILE } }), { mode: 0o600 });
  const first = await open(), session = await first.sessions.open(first.actor, { channel: 'test', conversationId: 'recovery-journal' });
  const accepted = await first.turns.accept(first.actor, { sessionId: session.scope.sessionId, messageId: 'write-before-recovery', rawText: ENTRY_TEXT,
    mode: 'auto', scope: first.scope, policy: first.policy, limits: first.limits,
    binding: { ...first.executionActor, channel: 'test', conversationId: 'recovery-journal', recipientId: first.actor.principalId, destination: 'local' } });
  await close(first);
  const old = backupAgent(profiles, directory, join(base, 'old-backup'), true);
  const writer = await open(), stop = new Error('fixture_stopped_after_original_adoption');
  await assert.rejects(writer.workflow.run(accepted.workId, writer.actor, { maxSteps: 12, async onStep() {
    if ((await writer.runtime.state(accepted.workId)).attempts.some(item => item.toolId === WRITE_TOOL && item.adopted)) throw stop;
  } }), error => error === stop);
  const applied = await writer.runtime.state(accepted.workId);
  assert.equal(applied.budget.used.toolCalls, 1); assert.equal(applied.budget.used.modelCalls, 1);
  await close(writer);
  const selected = backupAgent(profiles, directory, join(base, 'selected-backup'), true);
  const selectedTree = captureLifecycleTree(selected.directory), head = inspectAgentHostIdentity(profiles.inspect(directory), identityOptions);
  renameSync(directory, join(base, 'original-after-write'));
  const restored = restoreAgentBackup(profiles, old.directory, directory, old.manifest.digest, true);
  await rebindRestoredAgentHostIdentity({ kind: 'local', directory, backupDirectory: old.directory, operationId: restored.operationId,
    expectedBackupDigest: old.manifest.digest, expectedHeadDigest: head.digest, offline: true }, identityOptions);
  const current = profiles.inspect(directory), rebound = inspectAgentHostIdentity(current, identityOptions);
  assert.equal(current.effectivePersonalMemory.backend, 'documents');
  const before = captureLifecycleTree(directory), counters = counts();
  const prepared = await cli(['restore-recovery-prepare', '--directory', directory, '--source', selected.directory,
    '--destination', recoveryDirectory, '--digest', selected.manifest.digest, '--previous', rebound.digest, '--operation', randomUUID(), '--offline']);
  const read = await cli(['restore-recovery-status', '--source', recoveryDirectory]);
  assert.deepEqual(read, prepared); assert.equal(prepared.activation, 'not_applied');
  assert.equal(prepared.manifest, undefined);
  assert.deepEqual(captureLifecycleTree(join(recoveryDirectory, 'selected-backup')), selectedTree);
  assert.deepEqual(captureLifecycleTree(selected.directory), selectedTree);
  assert.deepEqual(captureLifecycleTree(directory), before);
  assert.deepEqual(counts(), counters);
  assert.equal(inspectAgentRestoreReconciliation(profiles, directory, identityOptions).status, 'required');
  await assert.rejects(open(), /agent_restore_reconciliation_required/);
  const inspected = inspectAgentRestoreRecovery(recoveryDirectory);
  assert.equal(inspected.manifest.selectedBackup.digest, selected.manifest.digest);
  const application = await cli(['restore-recovery-apply', '--source', recoveryDirectory, '--digest', inspected.manifest.digest, '--offline']);
  assert.equal(application.stage, 'restored'); assert.equal(application.reconciliationRequired, true);
  assert.deepEqual(captureLifecycleTree(join(recoveryDirectory, 'selected-backup')), selectedTree);
  assert.deepEqual(captureLifecycleTree(selected.directory), selectedTree);
  assert.deepEqual(captureLifecycleTree(application.retiredDirectory, path => path !== '.secumon-restore-recovery-pending.json'), before);
  const omitRestoration = path => path !== AGENT_LOCAL_RESTORE_COMPLETION && path !== '.secumon/runtime-leases' && !path.startsWith('.secumon/runtime-leases/');
  assert.deepEqual(captureLifecycleTree(directory, omitRestoration), selected.manifest.entries);
  assert.deepEqual(counts(), counters);
  const status = await cli(['restore-recovery-apply-status', '--source', recoveryDirectory]);
  assert.equal(status.stage, 'restored'); assert.equal(status.currentStateVerified, false);
  assert.equal(status.restorationId, application.restorationId);
  assert.deepEqual(await cli(['restore-recovery-apply', '--source', recoveryDirectory, '--digest', inspected.manifest.digest, '--offline']), application);
  await assert.rejects(open(), /agent_restore_reconciliation_required/);
  assert.deepEqual(counts(), counters);
  console.log(JSON.stringify({ status: 'passed', backend: 'file-journal', personalMemory: 'documents',
    scope: 'actual file effect, complete journal/document-layout replacement, public CLI apply/status/retry, original directory preserved',
    counts: counts(), stage: application.stage, newRestorationId: application.restorationId !== inspected.manifest.prior.restorationId,
    originalPreserved: true, sourceArchiveUnchanged: true, selectedOriginalsRestored: true, sameOperationReused: true,
    ordinaryExecution: 'fresh_reconciliation_required', actualModelApi: 'not_run', installedBinary: 'not_run' }, null, 2));
} finally {
  const errors = [];
  for (const profile of active) try { await profile.close(); } catch (error) { errors.push(error); }
  if (!errors.length) rmSync(base, { recursive: true, force: true });
  if (errors.length) throw new AggregateError(errors, 'recovery_journal_fixture_cleanup_failed');
}
