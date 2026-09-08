import assert from 'node:assert/strict';
import { runAgentCli } from '../dist/presentation/agent-cli.js';
import { restoreEffectsFixture } from '../dist/tests/agent-restore-effects-fixture.js';

const cleanups = [];
try {
  const f = await restoreEffectsFixture({ after(action) { cleanups.push(action); } });
  const first = await f.open(); await f.close(first.profile);
  const backup = f.backup(), restore = await f.restore(backup.manifest.digest); await restore.rebind();
  const host = { identityRegistryDirectory: f.identityOptions.registryDirectory, restoreReconciliation: { sources: f.sources } };
  async function command(name, extra = []) {
    const original = process.stdout.write; let output = '';
    process.stdout.write = function (chunk) { output += String(chunk); return true; };
    try { await runAgentCli(['lifecycle', name, '--directory', f.directory, '--json', ...extra], host); }
    finally { process.stdout.write = original; }
    return JSON.parse(output);
  }
  const before = await command('restore-status'); assert.equal(before.status, 'required');
  await assert.rejects(f.open(), /agent_restore_reconciliation_required/);
  const issued = await command('restore-reconcile', ['--offline']); assert.equal(issued.status, 'reconciled');
  const after = await command('restore-status'); assert.equal(after.status, 'reconciled');
  assert.equal(after.receiptDigest, issued.receiptDigest);
  const resumed = await f.open(); await f.close(resumed.profile);
  assert.equal(f.counts().models, 0); assert.equal(f.counts().writes, 0); assert.equal(f.counts().sends, 0);
  console.log(JSON.stringify({ status: 'passed', scope: 'public runAgentCli management arguments with a real local restored profile and registered read source',
    before: before.status, reconcile: issued.status, after: after.status, reopened: true, counts: f.counts(),
    actualModelApi: 'not_run', installedBinary: 'not_run' }, null, 2));
} finally {
  const failures = [];
  for (const cleanup of cleanups.reverse()) try { await cleanup(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'restore_cli_smoke_cleanup_failed');
}
