import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { FileAgentProfileStore } from '../../infrastructure/file-agent-profile.js';
import { applyAgentSqliteRecovery, readAgentSqliteRecovery } from '../../infrastructure/agent-sqlite-recovery.js';
import { hostFileMutations, type HostFileMutationScope } from '../../infrastructure/host-file-mutations.js';

export type ApplyCrashPhase = 'before-main-retire' | 'main-retired-link' | 'after-main-retire' | 'journal-retired' | 'candidate-published-link' | 'before-complete-publish' | 'complete-published';
const [engine, directory, registry, operationId, preparedDigest, phase] = process.argv.slice(2);
assert.ok(process.platform !== 'win32' && process.send && engine && directory && registry && operationId && preparedDigest);
assert.ok(phase === 'before-main-retire' || phase === 'main-retired-link' || phase === 'after-main-retire' || phase === 'journal-retired' ||
  phase === 'candidate-published-link' || phase === 'before-complete-publish' || phase === 'complete-published');
const selectedPhase: ApplyCrashPhase = phase;
const profiles = new FileAgentProfileStore(engine), root = resolve(directory);
const before = readAgentSqliteRecovery(profiles, root, operationId);
assert.equal(before.stage, 'prepared'); assert.ok('prepared' in before && before.prepared && before.intent);
assert.equal(before.prepared.digest, preparedDigest);
const main = join(root, before.intent.relativePath), journal = main + '-journal';
const retiredMain = main + `.retired-${operationId}`, retiredJournal = journal + `.retired-${operationId}`;
const candidate = join(before.directory, before.prepared.directory, basename(main));
const complete = join(before.directory, 'complete.json'), cell = new Int32Array(new SharedArrayBuffer(4));
let entered = 0;
function checkpoint(source: string | null, target: string, publication: unknown = null): never {
  assert.equal(++entered, 1);
  process.send!({ type: 'apply-boundary', phase: selectedPhase, operationId, preparedDigest,
    pid: process.pid, source, target, publication });
  // The parent must observe IPC, kill this process, and observe exit/close. A lost parent cannot leave an infinite hold.
  Atomics.wait(cell, 0, 0, 20000);
  throw new Error('sqlite_recovery_apply_parent_did_not_stop');
}
const originalLink = fs.linkSync, originalUnlink = fs.unlinkSync;
fs.linkSync = (source, target) => {
  if (source === main && target === retiredMain && selectedPhase === 'before-main-retire') checkpoint(main, retiredMain);
  originalLink(source, target);
  if (source === main && target === retiredMain && selectedPhase === 'main-retired-link') checkpoint(main, retiredMain);
  if (source === candidate && target === main && selectedPhase === 'candidate-published-link') checkpoint(candidate, main);
};
fs.unlinkSync = path => {
  originalUnlink(path);
  if (path === main && selectedPhase === 'after-main-retire') checkpoint(main, retiredMain);
  if (path === journal && selectedPhase === 'journal-retired') checkpoint(journal, retiredJournal);
};
syncBuiltinESMExports();
const mutations = hostFileMutations(), originalScope = mutations.openScope;
mutations.openScope = function (input): HostFileMutationScope {
  const scope = originalScope.call(mutations, input);
  if (resolve(input.root) !== root || !['before-complete-publish', 'complete-published'].includes(selectedPhase)) return scope;
  return { directory: scope.directory.bind(scope), check: scope.check.bind(scope), close: scope.close.bind(scope),
    publish(directory, leaf, bytes, options) {
      if (leaf === 'complete.json' && selectedPhase === 'before-complete-publish') {
        assert.equal(fs.existsSync(complete), false);
        const receipt = JSON.parse(Buffer.from(bytes).toString('utf8')) as { operationId?: string; preparedDigest?: string };
        assert.equal(receipt.operationId, operationId); assert.equal(receipt.preparedDigest, preparedDigest);
        checkpoint(null, complete);
      }
      const result = scope.publish(directory, leaf, bytes, options);
      if (leaf === 'complete.json') {
        assert.equal(result.published, true); assert.equal(result.fileSynced, true);
        assert.equal(result.directorySynced, true); assert.equal(result.cleanup, 'removed');
        const receipt = JSON.parse(fs.readFileSync(complete, 'utf8')) as { operationId?: string; preparedDigest?: string };
        assert.equal(receipt.operationId, operationId); assert.equal(receipt.preparedDigest, preparedDigest);
        checkpoint(null, complete, result);
      }
      return result;
    } };
};
try {
  await applyAgentSqliteRecovery(profiles, root, { operationId, expectedPreparedDigest: preparedDigest, offline: true },
    { identityRegistryDirectory: registry });
  throw new Error('sqlite_recovery_apply_boundary_not_reached');
} finally {
  fs.linkSync = originalLink; fs.unlinkSync = originalUnlink; syncBuiltinESMExports();
  mutations.openScope = originalScope;
}
