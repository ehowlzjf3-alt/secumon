import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { directory, root, remoteJson, requireCleanAudit } from './migration-c03-common.mjs';
const result = remoteJson(async root => {
  const fs = await import('node:fs'), audit = await auditRoot(root);
  const prior = JSON.parse(fs.readFileSync(root + '/evidence-drafts-c03/result.json', 'utf8'));
  return { ...audit, previousD2: { status: prior.status, finishedAt: prior.finishedAt, buildPin: prior.buildPin } };
}, [root]);
writeFileSync(directory + '/preflight.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
requireCleanAudit(result); assert.equal(result.previousD2.status, 'passed'); assert.ok(result.previousD2.finishedAt);
console.log(JSON.stringify(result));
