import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { directory, root, configuration, remoteJson, requireCleanAudit } from './mcp-recovery-c05-common.mjs';
const result = remoteJson(async (root, previousNativeResult) => {
  const fs = await import('node:fs'), audit = await auditRoot(root);
  const prior = JSON.parse(fs.readFileSync(root + '/' + previousNativeResult, 'utf8'));
  return { ...audit, previousNative: { status: prior.status, finishedAt: prior.finishedAt, buildPin: prior.buildPin } };
}, [root, configuration.previousNativeResult]);
writeFileSync(directory + '/preflight.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
requireCleanAudit(result); assert.equal(result.previousNative.status, 'passed'); assert.ok(result.previousNative.finishedAt);
console.log(JSON.stringify(result));
