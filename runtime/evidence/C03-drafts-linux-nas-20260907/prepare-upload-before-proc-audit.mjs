// Adapted from C03-personal-linux-nas-20260907/prepare-upload.mjs; run from runtime only after source freeze.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { verifyEvaluationBuild } from '../../dist/infrastructure/local-evaluation.js';
const directory = 'evidence/C03-drafts-linux-nas-20260907', root = '/home/shaneee/secumon-linux-test.pCJ0bd';
const attempt = Number(process.argv[2] ?? 1); assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= 9);
const control = readFileSync(directory + '/control-directory.txt', 'utf8').trim() + '/control';
const pin = await verifyEvaluationBuild(process.cwd());
writeFileSync(directory + '/build-pin.json', JSON.stringify(pin, null, 2) + '\n');
execFileSync('/usr/bin/tar', ['--disable-copyfile', '--no-xattrs', '-czf', directory + '/source.tar.gz',
  'src', 'scripts', 'fixtures', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.core.json']);
const uploads = [['source.tar.gz', 'drafts-c03-source.tar.gz'], ['verify-linux-drafts-c03.mjs', 'verify-linux-drafts-c03.mjs'],
  ['build-pin.json', 'drafts-c03-build-pin.json']].map(([name, target]) => ({ local: directory + '/' + name, remote: root + '/' + target,
  sha256: createHash('sha256').update(readFileSync(directory + '/' + name)).digest('hex') }));
writeFileSync(directory + '/uploads.json', JSON.stringify(uploads, null, 2) + '\n');
for (const item of uploads) execFileSync('scp', ['-o', 'ControlPath=' + control, item.local, 'nas:' + item.remote]);

async function prepare(root, uploads, expected, attempt) {
  const fs = await import('node:fs'); const { createHash } = await import('node:crypto'); const { execFileSync } = await import('node:child_process');
  if (fs.realpathSync(root) !== root || (fs.statSync(root).mode & 0o777) !== 0o700) throw new Error('unexpected_dedicated_test_root');
  const inside = value => value === root || value.startsWith(root + '/');
  const link = path => { try { return fs.readlinkSync(path); } catch { return ''; } };
  const owned = execFileSync('/bin/ps', ['-eo', 'pid=,comm=,args='], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
    return match && Number(match[1]) !== process.pid && /^(node|npm)$/.test(match[2]) &&
      (match[3].includes(root) || inside(link('/proc/' + match[1] + '/exe')) || inside(link('/proc/' + match[1] + '/cwd'))) ? [Number(match[1])] : [];
  });
  if (owned.length) throw new Error('owned_test_processes_still_running');
  for (const item of uploads) {
    if (!item.remote.startsWith(root + '/') || createHash('sha256').update(fs.readFileSync(item.remote)).digest('hex') !== item.sha256) throw new Error('upload_hash_mismatch');
  }
  if (attempt > 1) {
    const previous = JSON.parse(fs.readFileSync(root + '/evidence-drafts-c03/result.json'));
    if (previous.status !== 'failed' || !previous.finishedAt) throw new Error('previous_failure_not_finished');
    const archived = root + '/evidence-drafts-c03-attempt' + (attempt - 1);
    if (fs.existsSync(archived)) throw new Error('previous_attempt_archive_exists');
    fs.renameSync(root + '/evidence-drafts-c03', archived);
  }
  if (fs.existsSync(root + '/evidence-drafts-c03')) throw new Error('evidence_already_exists');
  const cwd = root + '/runtime', backup = root + '/before-drafts-c03' + (attempt === 1 ? '' : '-attempt' + attempt);
  fs.mkdirSync(backup, { mode: 0o700 });
  for (const entry of ['src', 'scripts', 'fixtures', 'dist', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.core.json']) fs.renameSync(cwd + '/' + entry, backup + '/' + entry);
  execFileSync('/bin/tar', ['-xzf', root + '/drafts-c03-source.tar.gz', '-C', cwd]);
  const apple = [];
  function scan(path) { for (const entry of fs.readdirSync(path, { withFileTypes: true })) { const next = path + '/' + entry.name; if (entry.name.startsWith('._')) apple.push(next); if (entry.isDirectory()) scan(next); } }
  for (const path of ['src', 'scripts', 'fixtures']) scan(cwd + '/' + path);
  if (apple.length) throw new Error('unexpected_appledouble_metadata');
  const { sha256, canonical } = await import('file://' + backup + '/dist/infrastructure/digest.js');
  const files = [];
  function scanSource(relative) {
    for (const entry of fs.readdirSync(cwd + '/' + relative, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative + '/' + entry.name;
      if (entry.isDirectory()) scanSource(path); else if (entry.isFile()) files.push({ path, sha256: sha256(fs.readFileSync(cwd + '/' + path)) });
      else throw new Error('source_link_not_supported');
    }
  }
  for (const path of ['src', 'scripts', 'fixtures']) scanSource(path);
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.core.json']) files.push({ path, sha256: sha256(fs.readFileSync(cwd + '/' + path)) });
  const sourceDigest = sha256(canonical(files)); if (sourceDigest !== expected.sourceDigest) throw new Error('source_digest_mismatch_after_extraction');
  const oldLock = createHash('sha256').update(fs.readFileSync(backup + '/package-lock.json')).digest('hex');
  const newLock = createHash('sha256').update(fs.readFileSync(cwd + '/package-lock.json')).digest('hex');
  if (oldLock !== newLock) throw new Error('dependency_lock_changed_requires_install');
  console.log(JSON.stringify({ at: new Date().toISOString(), attempt, sourceDigest, appleDouble: apple.length, uploads, backup, dependencyLockUnchanged: true }));
}
const command = '/usr/bin/env -i PATH=/usr/bin:/bin ' + root + '/node-v24.20.0-linux-x64/bin/node --input-type=module';
const output = execFileSync('ssh', ['-S', control, 'nas', command], {
  input: 'await (' + prepare.toString() + ')(' + JSON.stringify(root) + ',' + JSON.stringify(uploads) + ',' + JSON.stringify(pin) + ',' + attempt + ');', encoding: 'utf8',
});
const result = JSON.parse(output); assert.equal(result.sourceDigest, pin.sourceDigest);
writeFileSync(directory + '/upload-verification.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ status: 'uploaded_verified', attempt, sourceDigest: pin.sourceDigest, files: uploads.length }));
