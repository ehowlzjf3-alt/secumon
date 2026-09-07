import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { directory, root, configuration, remoteJson, requireCleanAudit } from './mcp-offline-c05-common.mjs';
const result = remoteJson(async (root, previousNativeResult) => {
  const fs = await import('node:fs'), { createHash } = await import('node:crypto'), audit = await auditRoot(root);
  const bytes = fs.readFileSync(root + '/' + previousNativeResult), prior = JSON.parse(bytes.toString('utf8'));
  return { ...audit, previousNative: { status: prior.status, finishedAt: prior.finishedAt, buildPin: prior.buildPin,
    sha256: createHash('sha256').update(bytes).digest('hex') } };
}, [root, configuration.previousNativeResult]);
writeFileSync(directory + '/preflight.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
requireCleanAudit(result); assert.equal(result.previousNative.status, 'passed'); assert.ok(result.previousNative.finishedAt);
assert.equal(result.previousNative.sha256, configuration.predecessor.nativeResultSha256);
console.log(JSON.stringify(result));
