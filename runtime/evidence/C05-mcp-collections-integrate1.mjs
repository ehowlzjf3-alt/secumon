import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { evaluationCodePin, verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

const root = resolve('.');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inputPath = 'evidence/C05-mcp-collections-integration-input1.json';
const supplementPath = 'evidence/C05-mcp-collections-staging/metadata/supplemental-read-collection-context-manifest.json';
const outputPath = 'evidence/C05-mcp-collections-integration1.json';
const backups = 'evidence/C05-mcp-collections-integration1-originals';
assert.equal(existsSync(outputPath), false);
assert.equal(existsSync(backups), false);
const inputBytes = await readFile(inputPath), supplementBytes = await readFile(supplementPath);
assert.equal(sha(supplementBytes), '587605ff4cd817305d76fdb7d9390ae5ae1b4425bb00330218ea7a06bad0bc83');
const input = JSON.parse(inputBytes), supplement = JSON.parse(supplementBytes);
assert.equal(input.status, 'reviewed_ready_not_applied');
const proofPath = relative(root, resolve(root, '..', input.proof));
assert.equal(sha(await readFile(proofPath)), input.proofSha256);
for (const manifest of input.manifests) assert.equal(sha(await readFile(manifest.path)), manifest.sha256, manifest.path);
const files = [...input.files, ...supplement.files.map(file => ({
  source: file.path, staged: relative(root, file.stagedPath),
  originalSha256: file.originalSha256, stagedSha256: file.stagedSha256, manifest: supplementPath,
}))];
assert.equal(files.length, 30);
assert.equal(new Set(files.map(file => file.source)).size, files.length);
const pending = [];
for (const file of files) {
  assert.match(file.source, /^src\/[a-zA-Z0-9_./-]+\.ts$/);
  assert.equal(file.source.includes('..'), false);
  const staged = await readFile(file.staged);
  assert.equal(sha(staged), file.stagedSha256, file.staged);
  const original = existsSync(file.source) ? await readFile(file.source) : null;
  assert.equal(original === null ? null : sha(original), file.originalSha256, file.source);
  pending.push({ file, staged, original });
}
const buildBefore = await verifyEvaluationBuild(root);
assert.equal(buildBefore.sourceDigest, 'fe438a3d25a33c43b3b7403b9b584df78eef86f044aadf9c7102cd6969798a15');
assert.equal(buildBefore.filesDigest, 'f6c07038312ab9a9db5b94f70ef3caa106ee104d12aaa00146dc29d47c3d745f');
await mkdir(backups, { recursive: false, mode: 0o700 });
for (const { file, original } of pending) {
  if (original === null) continue;
  const backup = resolve(backups, file.source);
  await mkdir(dirname(backup), { recursive: true });
  await writeFile(backup, original, { flag: 'wx', mode: 0o600 });
}
const report = { status: 'applying', startedAt: new Date().toISOString(),
  inputPath, inputSha256: sha(inputBytes), supplementPath, supplementSha256: sha(supplementBytes),
  proofPath, proofSha256: input.proofSha256, buildBefore, backups, files: [],
  testsRun: false, buildRun: false };
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
for (const { file, staged } of pending) {
  if (file.originalSha256 !== file.stagedSha256) await writeFile(file.source, staged, { flag: file.originalSha256 === null ? 'wx' : 'w' });
  const actualSha256 = sha(await readFile(file.source));
  assert.equal(actualSha256, file.stagedSha256, file.source);
  report.files.push({ ...file, actualSha256, changed: file.originalSha256 !== file.stagedSha256 });
}
report.status = 'applied_unverified';
report.finishedAt = new Date().toISOString();
report.sourceAfter = (await evaluationCodePin(root)).digest;
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, files: report.files.length,
  written: report.files.filter(file => file.changed).length, sourceAfter: report.sourceAfter, report: outputPath }));
