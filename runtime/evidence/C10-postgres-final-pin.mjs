import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

const build = await verifyEvaluationBuild(process.cwd());
const files = ['guidance/catalog.json', 'guidance/evidence-review.md',
  'evidence/C10-postgres-real-fixture.mjs', 'evidence/C10-postgres-real-engine-fixture.mjs',
  'evidence/C10-postgres-real-pages.mjs', 'evidence/C10-postgres-originals-diagnostic.mjs'];
const nativePath = 'native/windows-files/secumon_windows_files.node';
if (existsSync(nativePath)) files.push(nativePath);
process.stdout.write(JSON.stringify({ build, platform: process.platform, arch: process.arch, node: process.version,
  files: files.map(path => { const bytes = readFileSync(path); return { path, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }; }) }, null, 2) + '\n');
