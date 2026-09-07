import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluationBuildFiles, evaluationCodePin, runEvaluationSuite, verifyEvaluationBuild } from '../infrastructure/local-evaluation.js';

for (const change of ['none', 'source', 'compiled', 'missing', 'runtime', 'orphan'] as const) {
  test(`evaluation build: ${change} checks source and executed output together`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'evaluation-build-'));
    try {
      for (const path of ['src', 'scripts', 'fixtures', 'dist']) await mkdir(join(root, path));
      for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.core.json']) await writeFile(join(root, path), '{}');
      await writeFile(join(root, 'src/example.ts'), 'export const version = 1;');
      await writeFile(join(root, 'dist/example.js'), 'export const version = 1;');
      await writeFile(join(root, 'dist/example.js.map'), '{}');
      await writeFile(join(root, 'dist/example.d.ts'), 'export declare const version = 1;');
      if (change === 'orphan') await writeFile(join(root, 'dist/removed.js'), 'export const removed = true;');
      const manifest = { version: 1, node: process.version, sourceDigest: (await evaluationCodePin(root)).digest, files: await evaluationBuildFiles(root) };
      const path = join(root, 'dist/build-manifest.json'); await writeFile(path, JSON.stringify(manifest));
      if (change === 'source') await writeFile(join(root, 'src/example.ts'), 'export const version = 2;');
      if (change === 'compiled') await writeFile(join(root, 'dist/example.js'), 'export const version = 2;');
      if (change === 'missing') await rm(path);
      if (change === 'runtime') await writeFile(path, JSON.stringify({ ...manifest, node: 'other-runtime' }));
      const sourceBefore = await readFile(join(root, 'src/example.ts')); const compiledBefore = await readFile(join(root, 'dist/example.js'));
      if (change === 'none') assert.equal((await verifyEvaluationBuild(root)).fileCount, 3);
      else await assert.rejects(verifyEvaluationBuild(root), /evaluation_build_(stale|manifest_missing|output_mismatch)_run_npm_build/);
      assert.deepEqual(await readFile(join(root, 'src/example.ts')), sourceBefore);
      assert.deepEqual(await readFile(join(root, 'dist/example.js')), compiledBefore);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('evaluation build: a source change during case selection cannot relabel older compiled execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evaluation-build-boundary-'));
  try {
    for (const path of ['src', 'scripts', 'fixtures', 'dist']) await mkdir(join(root, path));
    for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.core.json']) await writeFile(join(root, path), '{}');
    for (const name of ['documents-simple', 'documents-complex', 'observations-simple', 'observations-complex'])
      await copyFile(new URL(`../../fixtures/${name}.json`, import.meta.url), join(root, 'fixtures', `${name}.json`));
    const source = join(root, 'src/example.ts'); await writeFile(source, 'export const version = 1;');
    for (const path of ['example.js', 'example.js.map', 'example.d.ts']) await writeFile(join(root, 'dist', path), '{}');
    await writeFile(join(root, 'dist/build-manifest.json'), JSON.stringify({ version: 1, node: process.version,
      sourceDigest: (await evaluationCodePin(root)).digest, files: await evaluationBuildFiles(root) }));
    const output = join(root, 'output'); let changed = false;
    await assert.rejects(runEvaluationSuite(root, output, () => {
      if (!changed) { writeFileSync(source, 'export const version = 2;'); changed = true; return true; } return false;
    }), /evaluation_build_changed_before_run/);
    assert.deepEqual(await readdir(output), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
