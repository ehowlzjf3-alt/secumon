import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fail instead of reporting a skipped Windows suite as successful validation.
if (process.platform !== 'win32') throw new Error('Native Windows is required; this script cannot validate Win32 by emulation.');
const require = createRequire(import.meta.url);
const addon = require(resolve(process.argv[2]));
const parent = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '../evidence/windows-fixture-'));
const observed = [];
try {
  const strict = addon.publishSetupFile(parent, 'strict', 'config.json', Buffer.from('{}'), 'strict-namespace');
  assert.equal(strict.code, 'namespace_durability_unsupported');
  assert.equal(strict.publication, 'not_attempted');
  assert.equal(existsSync(join(parent, 'strict')), false);
  observed.push('strict refusal before private directory creation');

  const bytes = Buffer.from('{"agentId":"synthetic-owner","한글":"확인"}\n');
  const made = addon.publishSetupFile(parent, 'private', 'identity.json', bytes, 'process-crash');
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.publication, 'created');
  assert.equal(made.fileFlush, 'completed');
  assert.equal(made.namespaceBarrier, 'unsupported');
  assert.equal(made.cleanup, 'consumed_by_rename');
  observed.push('actual private creation, file flush, relative no-overwrite rename');

  const read = addon.inspectSetupFile(parent, 'private', 'identity.json');
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.deepEqual(read.bytes, bytes);
  assert.equal(read.fileIdentity, made.fileIdentity);
  observed.push('reopen and stable read with ACL and identity validation');

  const conflict = addon.publishSetupFile(parent, 'private', 'identity.json', Buffer.from('different'), 'process-crash');
  assert.equal(conflict.ok, true, JSON.stringify(conflict));
  assert.equal(conflict.publication, 'already_exists');
  assert.equal(conflict.cleanup, 'removed');
  assert.deepEqual(addon.inspectSetupFile(parent, 'private', 'identity.json').bytes, bytes);
  assert.deepEqual(readdirSync(join(parent, 'private')), ['identity.json']);
  observed.push('existing target preserved and own conflicting candidate removed');

  const alias = join(parent, 'alias.json');
  linkSync(join(parent, 'private', 'identity.json'), alias);
  try {
    const linked = addon.inspectSetupFile(parent, 'private', 'identity.json');
    assert.equal(linked.ok, false);
    assert.equal(linked.code, 'unsafe_object');
  } finally { unlinkSync(alias); }
  assert.equal(addon.inspectSetupFile(parent, 'private', 'identity.json').ok, true);
  observed.push('external hardlink rejected without modifying the file');
} finally {
  // The path is a newly minted fixture below this package; never a caller-selected root.
  rmSync(parent, { recursive: true });
}
console.log(JSON.stringify({
  kind: 'native-windows-addon-smoke', platform: process.platform, node: process.version,
  passed: true, observed, nativeWindowsExecution: true,
  notCovered: ['second OS account ACL denial', 'junction and concurrent replacement', 'process kill at publication stages',
    'sharing violations and injected I/O failures', 'namespace durability or power loss', 'runtime host dispatch'],
}, null, 2));
