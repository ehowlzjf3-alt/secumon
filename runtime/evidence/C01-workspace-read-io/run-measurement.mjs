import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, basename, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const evidence = dirname(fileURLToPath(import.meta.url));
const runtime = resolve(evidence, '../..');
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const [phase = 'baseline', reportName = `${phase}-measurement.json`] = process.argv.slice(2);
assert.ok(['baseline', 'after', 'compare'].includes(phase));
assert.equal(basename(reportName), reportName);
assert.match(reportName, /^[a-z0-9-]+\.json$/);
assert.equal(fs.existsSync(join(evidence, reportName)), false, 'Existing evidence is never overwritten');
const manifest = JSON.parse(fs.readFileSync(join(evidence, 'baseline-manifest.json'), 'utf8'));
assert.equal(hash(fs.readFileSync(join(evidence, manifest.snapshot))), manifest.originalSha256);
assert.equal(hash(fs.readFileSync(join(evidence, manifest.comparisonModule))), manifest.comparisonSha256);
const dependencyFile = join(evidence, 'baseline-dependencies.json');
if (!fs.existsSync(dependencyFile)) {
  assert.equal(phase, 'baseline', 'Capture dependency provenance before changing the build');
  const visited = new Set();
  const dependencies = [];
  const visit = file => {
    if (visited.has(file)) return;
    visited.add(file);
    const bytes = fs.readFileSync(file);
    dependencies.push({ path: relative(runtime, file), sha256: hash(bytes) });
    for (const match of bytes.toString('utf8').matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"]+)\1/g)) {
      const next = resolve(dirname(file), match[2]);
      if (next.endsWith('.js')) visit(next);
    }
  };
  const original = resolve(runtime, 'dist/infrastructure/file-workspaces.js');
  for (const replacement of manifest.replacements) visit(resolve(evidence, replacement.to));
  dependencies.sort((a, b) => a.path.localeCompare(b.path));
  const observedCurrentDistSha256 = hash(fs.readFileSync(original));
  const sourceVerification = [];
  const archive = resolve(evidence, '../C01-workspace-boundary-linux-nas-20260907/source.tar.gz');
  // The parent can rebuild while this evidence harness is being prepared. If that
  // happened, verify unchanged shared compile inputs against the prior source archive.
  if (observedCurrentDistSha256 !== manifest.originalSha256) {
    const inputs = [...new Set([...dependencies.map(item => item.path.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')),
      'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.core.json'])].sort();
    for (const path of inputs) {
      const prior = spawnSync('tar', ['-xOf', archive, path], { cwd: evidence, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(prior.status, 0, `Cannot verify prior compile input ${path}: ${prior.stderr}`);
      const current = fs.readFileSync(join(runtime, path));
      assert.equal(hash(current), hash(prior.stdout), `Shared compile input changed since baseline archive: ${path}`);
      sourceVerification.push({ path, sha256: hash(current) });
    }
  }
  fs.writeFileSync(dependencyFile, JSON.stringify({ schemaVersion: 1, dependencies,
    packageLockSha256: hash(fs.readFileSync(join(runtime, 'package-lock.json'))),
    capturedAt: new Date().toISOString(), observedCurrentDistSha256,
    captureTiming: observedCurrentDistSha256 === manifest.originalSha256 ? 'before-rebuild' : 'after-rebuild-shared-source-verified',
    priorSourceArchive: sourceVerification.length ? { path: relative(runtime, archive), sha256: hash(fs.readFileSync(archive)) } : undefined,
    sharedCompileInputsVerified: sourceVerification }, null, 2) + '\n', { flag: 'wx' });
}
const dependencyManifest = JSON.parse(fs.readFileSync(dependencyFile, 'utf8'));
const checkDependencies = () => {
  for (const dependency of dependencyManifest.dependencies) assert.equal(hash(fs.readFileSync(join(runtime, dependency.path))), dependency.sha256, `Changed common dependency: ${dependency.path}`);
  assert.equal(hash(fs.readFileSync(join(runtime, 'package-lock.json'))), dependencyManifest.packageLockSha256);
};
checkDependencies();
const priorBuild = JSON.parse(fs.readFileSync(join(evidence, 'baseline-nas-build-manifest.json'), 'utf8'));
const priorFilesDigest = hash(canonical(priorBuild.files));
assert.equal(priorFilesDigest, 'a198150280bc635ae6b7e4dbe75ec2c73604fcf4a2bc8735d32eff3186019eeb');
assert.equal(priorBuild.sourceDigest, 'a6b89d53b8193ee71e6077c7f9192e008fd5a51225e35de26bc6a6bb7e71abd0');
assert.equal(priorBuild.files.length, 1131);
for (const dependency of dependencyManifest.dependencies) {
  const pinned = priorBuild.files.find(file => file.path === dependency.path);
  assert.ok(pinned, `Dependency absent from prior manifest: ${dependency.path}`);
  assert.equal(dependency.sha256, pinned.sha256, `Compiled common dependency differs from prior build: ${dependency.path}`);
}
assert.equal(priorBuild.files.find(file => file.path === 'dist/infrastructure/file-workspaces.js').sha256, manifest.originalSha256);
const provenance = { schemaVersion: 1, checkedAt: new Date().toISOString(), sourceDigest: priorBuild.sourceDigest,
  filesDigest: priorFilesDigest, fileCount: priorBuild.files.length, baselineOriginalSha256: manifest.originalSha256,
  sharedCompiledDependenciesMatched: dependencyManifest.dependencies.length,
  priorManifestSha256: hash(fs.readFileSync(join(evidence, 'baseline-nas-build-manifest.json'))),
  note: 'Prior NAS manifest canonical files digest matches the previously recorded baseline build pin; frozen baseline and every captured shared compiled dependency match that manifest.' };
const provenanceFile = join(evidence, 'baseline-build-provenance.json');
if (!fs.existsSync(provenanceFile)) fs.writeFileSync(provenanceFile, JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' });
const currentDistBefore = hash(fs.readFileSync(join(runtime, 'dist/infrastructure/file-workspaces.js')));
const reports = [];
let index = 0;
for (const fixture of ['single-empty', 'single-4k', 'single-1m', 'multi-mixed']) for (const operation of ['read', 'list']) {
  const variants = phase === 'compare' ? (index++ % 2 ? ['after', 'baseline'] : ['baseline', 'after']) : [phase];
  const pair = [];
  for (const variant of variants) {
    const child = spawnSync(process.execPath, ['--expose-gc', join(evidence, 'measure-worker.mjs'), variant, fixture, operation], {
      cwd: evidence, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(child.status, 0, `${variant}/${fixture}/${operation}: ${child.error?.stack ?? ''}\n${child.stdout}\n${child.stderr}`);
    const report = JSON.parse(child.stdout);
    reports.push(report); pair.push(report);
    const first = report.samples[0];
    process.stdout.write(`${variant} ${fixture} ${operation}: opens=${first.opens.record}, bytes=${first.deliveredBytesWithoutNestedDoubleCount}, parse=${first.jsonParseCalls}\n`);
  }
  if (pair.length === 2) {
    assert.equal(pair[0].fixtureSha256, pair[1].fixtureSha256);
    assert.equal(pair[0].resultSha256, pair[1].resultSha256);
    assert.deepEqual(pair[0].uniqueValidationInputSha256, pair[1].uniqueValidationInputSha256);
  }
}
if (phase === 'after') {
  const before = JSON.parse(fs.readFileSync(join(evidence, 'baseline-measurement.json'), 'utf8'));
  for (const report of reports) {
    const old = before.reports.find(value => value.fixture.fixtureName === report.fixture.fixtureName && value.operation === report.operation);
    assert.ok(old);
    assert.equal(report.fixtureSha256, old.fixtureSha256);
    assert.equal(report.resultSha256, old.resultSha256);
    assert.deepEqual(report.uniqueValidationInputSha256, old.uniqueValidationInputSha256);
  }
}
const summary = reports.map(report => {
  const elapsed = report.samples.map(sample => sample.elapsedMs).sort((a, b) => a - b);
  const first = report.samples[0];
  return { variant: report.variant, fixture: report.fixture.fixtureName, operation: report.operation,
    recordOpens: first.opens.record, deliveredBytes: first.deliveredBytesWithoutNestedDoubleCount,
    jsonParseCalls: first.jsonParseCalls, fstat: first.metadata.fstat, lstat: first.metadata.lstat,
    directoryFsyncCalls: first.directoryFsyncCalls,
    instrumentedElapsedMs: { min: elapsed[0], median: elapsed[Math.floor(elapsed.length / 2)], max: elapsed.at(-1) } };
});
checkDependencies();
assert.equal(hash(fs.readFileSync(join(runtime, 'dist/infrastructure/file-workspaces.js'))), currentDistBefore, 'The build changed while measuring');
const result = { schemaVersion: 1, recordedAt: new Date().toISOString(), phase,
  baselineOriginalSha256: manifest.originalSha256,
  measuredCurrentDistSha256: hash(fs.readFileSync(join(runtime, 'dist/infrastructure/file-workspaces.js'))),
  workerSha256: hash(fs.readFileSync(join(evidence, 'measure-worker.mjs'))),
  runnerSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
  dependencyManifestSha256: hash(fs.readFileSync(dependencyFile)),
  baselineBuildProvenance: provenance,
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  equivalenceAssertions: phase === 'baseline' ? 'Per-sample outputs match expected fixture; input bytes preserved. Cross-version comparison remains pending.' : 'Serialized fixture bytes, unique JSON validation inputs, and returned values match the baseline; source bytes preserved.',
  summary, reports };
fs.writeFileSync(join(evidence, reportName), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(`Saved ${join(evidence, reportName)}\n`);
