import { FileAgentProfileStore } from '../../infrastructure/file-agent-profile.js';
import { runtimeRoot } from '../../presentation/local-profile.js';
import { hostFileMutations, type HostFileMutationScope } from '../../infrastructure/host-file-mutations.js';
import { previewPersonalMemoryMigration, applyPersonalMemoryMigration } from '../../infrastructure/personal-memory-migration.js';
import { PersonalMemoryMigrationOptionsSchema } from '../../application/personal-memory-migration-contracts.js';

const mode = process.argv[2], options = PersonalMemoryMigrationOptionsSchema.parse(JSON.parse(process.argv[3]!));
if (mode !== 'before-activation' && mode !== 'after-activation') throw new Error('invalid_worker_mode');
const mutations = hostFileMutations(), open = mutations.openScope.bind(mutations);
const cell = new Int32Array(new SharedArrayBuffer(4));
function stop() {
  process.send!({ phase: mode });
  Atomics.wait(cell, 0, 0);
}
mutations.openScope = input => {
  const scope = open(input), publish = scope.publish.bind(scope);
  const wrapped: HostFileMutationScope = { directory: scope.directory.bind(scope), check: scope.check.bind(scope), close: scope.close.bind(scope),
    publish(directory, leaf, bytes, options) {
      if (leaf === 'personal-memory-activation.json' && mode === 'before-activation') stop();
      const result = publish(directory, leaf, bytes, options);
      if (leaf === 'personal-memory-activation.json' && mode === 'after-activation') stop();
      return result;
    } };
  return wrapped;
};
try {
  const profiles = new FileAgentProfileStore(runtimeRoot), preview = previewPersonalMemoryMigration(profiles, options, [runtimeRoot]);
  await applyPersonalMemoryMigration(profiles, options, { expectedSnapshotDigest: preview.snapshot.snapshotDigest, offlineConfirmed: true, effectsReconciled: true }, [runtimeRoot]);
  throw new Error('activation_gate_not_reached');
} catch (error) { process.stderr.write(String((error as Error).stack ?? error)); process.exitCode = 1; }
