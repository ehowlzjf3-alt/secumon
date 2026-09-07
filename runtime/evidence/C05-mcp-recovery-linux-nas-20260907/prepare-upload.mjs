import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { verifyEvaluationBuild } from '../../dist/infrastructure/local-evaluation.js';
import { directory, root, configuration, assertPin, assertLocalResult, assertLocalStageObservation, parseTestSummary, controlPath, remoteJson, requireCleanAudit } from './mcp-recovery-c05-common.mjs';
const attempt = Number(process.argv[2] ?? 1); assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= 9);
const pin = assertPin(await verifyEvaluationBuild(process.cwd()));
const localProof = path => {
  assert.ok(typeof path === 'string' && /^evidence\/[a-zA-Z0-9_./-]+\.json$/.test(path) && !path.split('/').includes('..'), 'explicit local result path required');
  const bytes = readFileSync(path), result = JSON.parse(bytes);
  assertLocalResult(result, pin);
  for (const item of result.evidence) assert.equal(createHash('sha256').update(readFileSync(item.path)).digest('hex'), item.sha256);
  assert.deepEqual(JSON.parse(readFileSync(result.sourceObservation.pinPath, 'utf8')), pin);
  if (result.sourceObservation.kind === 'per_run_source_and_build_verification') {
    assertLocalStageObservation(result, pin, JSON.parse(readFileSync(result.sourceObservation.runnerPath, 'utf8')));
  }
  const counts = parseTestSummary(readFileSync(result.logPath, 'utf8'));
  assert.equal(counts.fail, 0); assert.equal(counts.cancelled, 0); assert.deepEqual(result.counts, counts);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), result };
};
const validationInputs = { pin, newTests: localProof(process.argv[3]), relatedTests: localProof(process.argv[4]), selectedAt: new Date().toISOString() };
const preflight = JSON.parse(readFileSync(directory + '/preflight.json', 'utf8')); requireCleanAudit(preflight);
const stamp = directory + '/upload-attempt' + attempt;
assert.equal(existsSync(stamp + '.json'), false); assert.equal(existsSync(stamp + '.tar.gz'), false);
writeFileSync(directory + '/build-pin.json', JSON.stringify(pin, null, 2) + '\n', { mode: 0o600 });
writeFileSync(stamp + '-validation-inputs.json', JSON.stringify(validationInputs, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const before = remoteJson(async root => await auditRoot(root), [root]); requireCleanAudit(before);
execFileSync('/usr/bin/tar', ['--disable-copyfile', '--no-xattrs', '-czf', stamp + '.tar.gz',
  'src', 'scripts', 'fixtures', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.core.json']);
assert.deepEqual(await verifyEvaluationBuild(process.cwd()), pin);
const uploads = [[stamp + '.tar.gz', 'mcp-recovery-c05-source-attempt' + attempt + '.tar.gz'],
  [directory + '/verify-linux-mcp-recovery-c05.mjs', 'verify-linux-mcp-recovery-c05.mjs'], [directory + '/mcp-recovery-c05-common.mjs', 'mcp-recovery-c05-common.mjs'],
  [stamp + '-validation-inputs.json', 'mcp-recovery-c05-validation-inputs.json'],
  [directory + '/mcp-recovery-c05-config.json', 'mcp-recovery-c05-config.json'],
  [directory + '/targeted-files.json', 'mcp-recovery-c05-targeted-files.json'], [directory + '/build-pin.json', 'mcp-recovery-c05-build-pin.json']]
  .map(([local, name]) => ({ local, remote: root + '/' + name, sha256: createHash('sha256').update(readFileSync(local)).digest('hex') }));
writeFileSync(stamp + '-uploads.json', JSON.stringify(uploads, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const control = controlPath();
for (const item of uploads) execFileSync('scp', ['-o', 'ControlPath=' + control.socket, item.local, configuration.sshHost + ':' + item.remote], { timeout: 120000 });
const result = remoteJson(async (root, uploads, expected, attempt, expectedDefaultNode) => {
  const fs = await import('node:fs'), { createHash } = await import('node:crypto'), { execFileSync } = await import('node:child_process');
  const audit = await auditRoot(root);
  if (audit.auditErrors.length || audit.observedOwnedProcesses || audit.realRoot !== root || audit.rootMode !== '700' || audit.defaultNode !== expectedDefaultNode) throw new Error('unsafe_prepare_environment');
  const allowed = new Set(['mcp-recovery-c05-source-attempt' + attempt + '.tar.gz', 'verify-linux-mcp-recovery-c05.mjs', 'mcp-recovery-c05-common.mjs', 'mcp-recovery-c05-targeted-files.json', 'mcp-recovery-c05-build-pin.json', 'mcp-recovery-c05-validation-inputs.json', 'mcp-recovery-c05-config.json']);
  for (const item of uploads) {
    if (!allowed.has(item.remote.slice(root.length + 1)) || item.remote !== root + '/' + item.remote.slice(root.length + 1) ||
      createHash('sha256').update(fs.readFileSync(item.remote)).digest('hex') !== item.sha256) throw new Error('upload_hash_mismatch');
  }
  const evidence = root + '/evidence-mcp-recovery-c05';
  if (attempt > 1) {
    const previous = JSON.parse(fs.readFileSync(evidence + '/result.json', 'utf8'));
    if (previous.status !== 'failed' || !previous.finishedAt) throw new Error('previous_failure_not_finished');
    const archived = evidence + '-attempt' + (attempt - 1); if (fs.existsSync(archived)) throw new Error('previous_archive_exists');
    fs.renameSync(evidence, archived);
  }
  if (fs.existsSync(evidence)) throw new Error('evidence_already_exists');
  const cwd = root + '/runtime', backup = root + '/before-mcp-recovery-c05-attempt' + attempt;
  const archive = root + '/mcp-recovery-c05-source-attempt' + attempt + '.tar.gz';
  const allowedRoots = new Set(['src', 'scripts', 'fixtures', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.core.json']);
  const names = execFileSync('/bin/tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim().split('\n');
  if (names.some(name => name.startsWith('/') || name.split('/').some(part => part === '..' || part.startsWith('._')) || !allowedRoots.has(name.split('/')[0]))) throw new Error('archive_allowlist_violation');
  const previousLock = fs.readFileSync(cwd + '/package-lock.json');
  const archivedLock = execFileSync('/bin/tar', ['-xOzf', archive, 'package-lock.json']);
  if (!previousLock.equals(archivedLock)) throw new Error('dependency_lock_changed_requires_separate_install');
  fs.mkdirSync(backup, { mode: 0o700 });
  for (const name of [...allowedRoots, 'dist']) fs.renameSync(cwd + '/' + name, backup + '/' + name);
  execFileSync('/bin/tar', ['-xzf', archive, '-C', cwd]);
  const { sha256, canonical } = await import('file://' + backup + '/dist/infrastructure/digest.js');
  const files = [];
  function scan(relative) {
    for (const entry of fs.readdirSync(cwd + '/' + relative, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative + '/' + entry.name;
      if (entry.name.startsWith('._')) throw new Error('appledouble_not_allowed');
      if (entry.isDirectory()) scan(path); else if (entry.isFile()) files.push({ path, sha256: sha256(fs.readFileSync(cwd + '/' + path)) });
      else throw new Error('source_link_not_supported');
    }
  }
  for (const path of ['src', 'scripts', 'fixtures']) scan(path);
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.core.json']) files.push({ path, sha256: sha256(fs.readFileSync(cwd + '/' + path)) });
  const sourceDigest = sha256(canonical(files)); if (sourceDigest !== expected.sourceDigest) throw new Error('source_digest_mismatch_after_extraction');
  return { at: new Date().toISOString(), attempt, sourceDigest, uploads, backup, dependencyLockUnchanged: true, beforeProcesses: audit };
}, [root, uploads, pin, attempt, configuration.expectedDefaultNode]);
assert.equal(result.sourceDigest, pin.sourceDigest);
writeFileSync(stamp + '.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ status: 'uploaded_verified', attempt, sourceDigest: pin.sourceDigest, files: uploads.length }));
