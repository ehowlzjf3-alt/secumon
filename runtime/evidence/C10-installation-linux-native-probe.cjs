const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const root = '/home/shaneee/secumon-c10-403.A0DpgL';
const nativeRoot = join(root, 'native');
const addonPath = join(nativeRoot, 'secumon_windows_files.node');
const manifest = JSON.parse(readFileSync(join(root, 'native-source-manifest.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const entry of manifest.files) {
  const bytes = readFileSync(join(nativeRoot, entry.path));
  assert.equal(bytes.length, entry.bytes);
  assert.equal(hash(bytes), entry.sha256);
}
const addonBytes = readFileSync(addonPath);
const addon = require(addonPath);
const files = addon.setupCapabilities();
const retirement = addon.directoryRetirementCapabilities();
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
assert.equal(files.platform, 'linux');
assert.equal(files.win32BackendCompiled, false);
assert.equal(files.hostFilesApiVersion, 4);
assert.equal(files.maximumBytes, 4 * 1024 * 1024);
assert.equal(files.maximumStreamBytes, 1024 ** 3);
assert.equal(files.namespaceBarrier, 'unsupported');
assert.equal(retirement.apiVersion, 1);
assert.equal(retirement.platform, 'linux');
assert.equal(retirement.noReplace, true);
for (const key of ['openDirectory', 'fileMetrics', 'retireDirectoryNoReplace']) assert.equal(typeof addon[key], 'function');
process.stdout.write(JSON.stringify({
  checkpoint: 403, platform: process.platform, arch: process.arch, node: process.version,
  addonPath, addonBytes: addonBytes.length, addonSha256: hash(addonBytes),
  sourceFiles: manifest.files.length, cargoLockSha256: manifest.cargoLockSha256, sourceStillMatches: true,
  files, retirement, requiredFunctionsPresent: true, actualLoad: 'passed',
  directoryRetirementSyscallTested: false,
}, null, 2) + '\n');
