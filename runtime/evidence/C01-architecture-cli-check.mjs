import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const script = resolve(process.argv[2] ?? 'scripts/check-architecture.mjs');
const root = mkdtempSync(join(tmpdir(), 'secumon-architecture-'));
const cases = [
  { name: 'valid', domain: 'export type Value = string;', application: "import type { Value } from '../domain/model.js';", expectedCode: 0, inspected: 2 },
  { name: 'domain-external-import', domain: "import fs from 'node:fs';", application: '', expectedCode: 1, inspected: 2 },
  { name: 'application-outer-import', domain: '', application: "import { value } from '../infrastructure/adapter.js';", expectedCode: 1, inspected: 2 },
  { name: 'empty-core', domain: null, application: null, expectedCode: 1, inspected: 0 },
];
const results = [];
try {
  for (const item of cases) {
    const folder = join(root, item.name);
    for (const layer of ['domain', 'application']) mkdirSync(join(folder, 'src', layer), { recursive: true });
    if (item.domain !== null) writeFileSync(join(folder, 'src/domain/model.ts'), item.domain);
    if (item.application !== null) writeFileSync(join(folder, 'src/application/work.ts'), item.application);
    const result = spawnSync(process.execPath, [script], { cwd: folder, encoding: 'utf8', timeout: 20000 });
    assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, item.expectedCode, result.stderr);
    const parsed = JSON.parse(result.stdout.trim()); assert.equal(parsed.inspected, item.inspected);
    assert.equal(parsed.failures.length, item.expectedCode === 0 ? 0 : 1);
    results.push({ name: item.name, exitCode: result.status, ...parsed });
  }
  console.log(JSON.stringify({ schemaVersion: 1, kind: 'actual_cli_in_temporary_fixtures', platform: process.platform, node: process.version, results }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
