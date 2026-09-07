import { writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertEvaluationOutputs, evaluationCodePin, evaluationBuildFiles } from '../dist/infrastructure/local-evaluation.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await evaluationCodePin(root);
const manifest = { version: 1, node: process.version, sourceDigest: source.digest, files: await evaluationBuildFiles(root) };
assertEvaluationOutputs(source.files, manifest.files);
await writeFile(join(root, 'dist/build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
