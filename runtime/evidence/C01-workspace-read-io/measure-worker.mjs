import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

// Only this isolated measurement process patches built-in exports. No product hooks.
const evidence = dirname(fileURLToPath(import.meta.url));
const [variant, fixtureName, operation] = process.argv.slice(2);
assert.ok(['baseline', 'after'].includes(variant));
assert.ok(['read', 'list'].includes(operation));
const fixtureSizes = {
  'single-empty': [0],
  'single-4k': [4096],
  'single-1m': [1048576],
  'multi-mixed': [0, 1, 1024, 4096, 65536, 131072, 262144, 1048576],
};
const sizes = fixtureSizes[fixtureName];
assert.ok(sizes);
const hash = value => createHash('sha256').update(value).digest('hex');
const originals = Object.fromEntries(['openSync', 'closeSync', 'readFileSync', 'readSync', 'fstatSync', 'lstatSync', 'fsyncSync', 'readdirSync'].map(name => [name, fs[name]]));
const originalParse = JSON.parse;
const descriptors = new Map();
let active;
let readFileDepth = 0;
const fresh = () => ({
  opens: { record: 0, directory: 0, other: 0, failed: 0 },
  closes: 0,
  readFileSync: { calls: 0, returnedBytes: 0, failed: 0 },
  readSync: { directCalls: 0, directReturnedBytes: 0, nestedInReadFileSyncCalls: 0, nestedInReadFileSyncReturnedBytes: 0, failed: 0 },
  metadata: { fstat: { file: 0, directory: 0, other: 0, failed: 0 }, lstat: { file: 0, directory: 0, other: 0, failed: 0 } },
  readdirCalls: 0,
  directoryFsyncCalls: 0,
  otherFsyncCalls: 0,
  jsonParseCalls: 0,
  parseInputs: [],
});
fs.openSync = function (...args) {
  try {
    const fd = originals.openSync.apply(this, args);
    const name = String(args[0]);
    const kind = typeof args[1] === 'number' && (args[1] & fs.constants.O_DIRECTORY) !== 0 ? 'directory'
      : /[/\\]files[/\\][a-f0-9]{64}\.json$/.test(name) ? 'record' : 'other';
    descriptors.set(fd, { name, kind });
    if (active) active.opens[kind]++;
    return fd;
  } catch (error) { if (active) active.opens.failed++; throw error; }
};
fs.closeSync = function (fd) {
  try { const value = originals.closeSync.call(this, fd); if (active) active.closes++; return value; }
  finally { descriptors.delete(fd); }
};
fs.readFileSync = function (...args) {
  if (active) active.readFileSync.calls++;
  readFileDepth++;
  try {
    const result = originals.readFileSync.apply(this, args);
    if (active) active.readFileSync.returnedBytes += typeof result === 'string' ? Buffer.byteLength(result) : result.byteLength;
    return result;
  } catch (error) { if (active) active.readFileSync.failed++; throw error; }
  finally { readFileDepth--; }
};
fs.readSync = function (...args) {
  const prefix = readFileDepth ? 'nestedInReadFileSync' : 'direct';
  if (active) active.readSync[`${prefix}Calls`]++;
  try { const count = originals.readSync.apply(this, args); if (active) active.readSync[`${prefix}ReturnedBytes`] += count; return count; }
  catch (error) { if (active) active.readSync.failed++; throw error; }
};
for (const name of ['fstat', 'lstat']) fs[`${name}Sync`] = function (...args) {
  try {
    const result = originals[`${name}Sync`].apply(this, args);
    if (active) active.metadata[name][result.isFile() ? 'file' : result.isDirectory() ? 'directory' : 'other']++;
    return result;
  } catch (error) { if (active) active.metadata[name].failed++; throw error; }
};
fs.fsyncSync = function (fd) {
  if (active) active[descriptors.get(fd)?.kind === 'directory' ? 'directoryFsyncCalls' : 'otherFsyncCalls']++;
  return originals.fsyncSync.call(this, fd);
};
fs.readdirSync = function (...args) { if (active) active.readdirCalls++; return originals.readdirSync.apply(this, args); };
JSON.parse = function (text, ...rest) {
  if (active) { active.jsonParseCalls++; active.parseInputs.push(String(text)); }
  return originalParse(text, ...rest);
};
syncBuiltinESMExports();

const { FileWorkspaceStore: Baseline } = await import('./baseline-file-workspaces.mjs');
const { FileWorkspaceStore: Target } = variant === 'baseline' ? { FileWorkspaceStore: Baseline }
  : await import(pathToFileURL(resolve(evidence, '../../dist/infrastructure/file-workspaces.js')).href);
const temporary = fs.mkdtempSync(join(evidence, 'fixture-'));
const root = join(temporary, 'workspace');
const workId = 'measurement-work';
const attemptId = 'measurement-attempt';
const attributes = { tenantId: 'synthetic-tenant', labels: ['synthetic', 'io-measurement'], lifecycleGeneration: 0 };
const raw = sizes.map((size, index) => {
  const bytes = Buffer.alloc(size);
  for (let cursor = 0; cursor < size; cursor++) bytes[cursor] = (cursor * 31 + index * 17) % 256;
  return { path: `input-${String(index).padStart(2, '0')}.bin`, bytes };
});
const fileDir = join(root, hash(workId), hash(attemptId), 'files');
const diskSnapshot = () => fs.readdirSync(fileDir).sort().map(name => {
  const bytes = fs.readFileSync(join(fileDir, name));
  return { name, bytes: bytes.length, sha256: hash(bytes) };
});
let preparation;
let store;
try {
  // Fixture serialization always uses the frozen baseline, before any measured call.
  preparation = new Baseline(root);
  const expected = [];
  for (const entry of raw) expected.push(await preparation.stage(workId, attemptId, entry.path, entry.bytes, attributes));
  await preparation.close(); preparation = undefined;
  const diskBefore = diskSnapshot();
  const readIndex = raw.length - 1;
  const expectedValidationInputs = operation === 'list' ? diskBefore.map(entry => entry.sha256).sort()
    : [diskBefore.find(entry => entry.name === `${hash(raw[readIndex].path)}.json`).sha256];
  store = new Target(root);
  const invoke = () => operation === 'list' ? store.list(workId, attemptId)
    : store.read(workId, attemptId, raw[readIndex].path);
  const verifyResult = result => {
    if (operation === 'list') { assert.deepEqual(result, expected); return hash(JSON.stringify(result)); }
    assert.deepEqual(result.file, expected[readIndex]);
    assert.deepEqual(Buffer.from(result.bytes), raw[readIndex].bytes);
    return hash(JSON.stringify({ file: result.file, bytesSha256: hash(result.bytes) }));
  };
  const warmupResultSha256 = verifyResult(await invoke());
  const samples = [];
  for (let repetition = 0; repetition < 5; repetition++) {
    global.gc?.();
    const metrics = fresh();
    const heapBefore = process.memoryUsage().heapUsed;
    const began = performance.now();
    active = metrics;
    let result;
    try { result = await invoke(); } finally { active = undefined; }
    const elapsedMs = performance.now() - began;
    const heapAfter = process.memoryUsage().heapUsed;
    // Hashing, output assertions, and snapshot checks stay outside the timed window.
    const parseInputSha256 = metrics.parseInputs.map(hash).sort();
    const parseInputBytes = metrics.parseInputs.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    delete metrics.parseInputs;
    assert.deepEqual([...new Set(parseInputSha256)], expectedValidationInputs);
    const resultSha256 = verifyResult(result);
    assert.equal(resultSha256, warmupResultSha256);
    samples.push({ repetition, elapsedMs, heapUsedDeltaBytes: heapAfter - heapBefore, ...metrics,
      deliveredBytesWithoutNestedDoubleCount: metrics.readFileSync.returnedBytes + metrics.readSync.directReturnedBytes,
      parseInputBytes, parseInputSha256, resultSha256 });
  }
  const diskAfter = diskSnapshot();
  assert.deepEqual(diskAfter, diskBefore);
  const fixture = { fixtureName, sizes, workId, attemptId, attributes,
    raw: raw.map(entry => ({ path: entry.path, bytes: entry.bytes.length, sha256: hash(entry.bytes) })), serialized: diskBefore };
  process.stdout.write(JSON.stringify({ schemaVersion: 1, variant, operation, fixture,
    fixtureSha256: hash(JSON.stringify(fixture)), resultSha256: warmupResultSha256,
    uniqueValidationInputSha256: expectedValidationInputs, originalsPreserved: true, warmups: 1,
    environment: { node: process.version, platform: process.platform, arch: process.arch }, samples }) + '\n');
} finally {
  active = undefined;
  await preparation?.close();
  await store?.close();
  for (const [name, value] of Object.entries(originals)) fs[name] = value;
  JSON.parse = originalParse;
  syncBuiltinESMExports();
  fs.rmSync(temporary, { recursive: true, force: true });
}
