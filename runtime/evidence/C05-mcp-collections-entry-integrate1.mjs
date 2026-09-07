import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import {verifyEvaluationBuild, evaluationCodePin} from '../dist/infrastructure/local-evaluation.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedManifest = process.argv[2];
assert.match(expectedManifest ?? '', /^[a-f0-9]{64}$/);
const manifestPath = 'evidence/C05-mcp-collections-entry-acceptance-staging/manifest.json';
const outputPath = 'evidence/C05-mcp-collections-entry-integration1.json';
assert.equal(existsSync(outputPath), false);
const bytes = await readFile(manifestPath); assert.equal(sha(bytes), expectedManifest);
const manifest = JSON.parse(bytes);
assert.equal(manifest.files.length, 3);
const buildBefore = await verifyEvaluationBuild(process.cwd());
assert.equal(buildBefore.sourceDigest, '9efb93842e15936a7e0015b74f981b15bc90704d9e96cd0b16cf4c3e92b403af');
assert.equal(buildBefore.filesDigest, '5524f7c8db2669de0a508e225ac21d2a2f84bfdd400ae88c38eaef0369c558da');
const pending = [];
for (const item of manifest.files) {
  assert.match(item.source, /^runtime\/src\/tests\/mcp-collection-entry(?:-fixture|-worker|\.test)\.ts$/);
  assert.equal(item.originalSha256, null);
  const source = item.source.slice('runtime/'.length), staged = item.staged.slice('runtime/'.length);
  assert.match(staged, /^evidence\/C05-mcp-collections-entry-acceptance-staging\/src\/tests\/mcp-collection-entry/);
  assert.equal(existsSync(source), false, source);
  const content = await readFile(staged); assert.equal(sha(content), item.stagedSha256);
  pending.push({source, staged, content, sha256: item.stagedSha256});
}
assert.equal(new Set(pending.map(item => item.source)).size, 3);
const report = {status:'applying', startedAt:new Date().toISOString(), manifestPath,
  manifestSha256:expectedManifest, buildBefore, files:[], testsRun:false};
await writeFile(outputPath, JSON.stringify(report,null,2)+'\n', {flag:'wx',mode:0o600});
for (const {source, staged, content, sha256} of pending) {
  await writeFile(source, content, {flag:'wx'});
  assert.equal(sha(await readFile(source)), sha256);
  report.files.push({source, staged, originalSha256:null, sha256});
}
report.status = 'applied_unverified';
report.finishedAt = new Date().toISOString();
report.sourceAfter = (await evaluationCodePin(process.cwd())).digest;
await writeFile(outputPath, JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,source:report.sourceAfter,files:report.files.length,report:outputPath}));
