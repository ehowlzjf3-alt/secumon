import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

if (process.platform === 'win32') throw new Error('This verifies non-Windows rejection only. Use windows-addon.mjs on Windows.');
const require = createRequire(import.meta.url);
const addon = require(resolve(process.argv[2]));
const capabilities = addon.setupCapabilities();
assert.equal(capabilities.win32BackendCompiled, false);
assert.equal(capabilities.runtimeDispatchConnected, false);
assert.equal(capabilities.namespaceBarrier, 'unsupported');

const strict = addon.publishSetupFile('invalid parent is deliberately unused', 'scope', 'config.json', Buffer.from('{}'), 'strict-namespace');
assert.equal(strict.code, 'namespace_durability_unsupported');
assert.equal(strict.publication, 'not_attempted');
assert.equal(strict.candidateName, undefined);
const unsupported = addon.publishSetupFile('C:\\host', 'scope', 'config.json', Buffer.from('{}'), 'process-crash');
assert.equal(unsupported.code, 'unsupported_platform');
assert.equal(unsupported.publication, 'not_attempted');
const oversized = addon.publishSetupFile('C:\\host', 'scope', 'config.json', Buffer.alloc(4 * 1024 * 1024 + 1), 'process-crash');
assert.equal(oversized.code, 'file_too_large');
const escape = addon.publishSetupFile('C:\\host', 'scope', '..', Buffer.from('{}'), 'process-crash');
assert.equal(escape.code, 'unsafe_name');
const inspection = addon.inspectSetupFile('C:\\host', 'scope', 'config.json');
assert.equal(inspection.ok, false);
assert.equal(inspection.code, 'unsupported_platform');

console.log(JSON.stringify({
  kind: 'actual-nonwindows-addon-load-and-preflight', platform: process.platform,
  node: process.version, checks: 6, passed: true, nativeWindowsExecution: false,
  capabilities, strict, unsupported, inspection,
}, null, 2));
