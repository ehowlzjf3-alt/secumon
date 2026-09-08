import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleAgentEngine, installAgentEngine } from '../../infrastructure/agent-engine-release.js';
import { copyLifecycleTree, createLifecycleDirectory } from '../../infrastructure/agent-lifecycle-files.js';

export const ENGINE_UPDATE_MARKER = 'engine-update-v2';
const runtimeRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Compatible test releases from the full built runtime. Only the private B candidate gets an executable fixture-format change. */
export function createEngineUpdateReleases(base: string, options: { customizeCandidate?: (directory: string) => void } = {}) {
  const bundleA = bundleAgentEngine(runtimeRoot, join(base, 'bundle-a'));
  const a = installAgentEngine(bundleA.directory, join(base, 'engine-a'), bundleA.release.digest);
  const candidateB = join(base, 'candidate-b'); createLifecycleDirectory(candidateB);
  copyLifecycleTree(bundleA.directory, candidateB, bundleA.release.entries);
  const packagePath = join(candidateB, 'package.json'), lockPath = join(candidateB, 'package-lock.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string };
  const originalVersion = pkg.version, version = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(originalVersion); assert.ok(version);
  const patch = Number(version[3]) + 1; assert.ok(Number.isSafeInteger(patch));
  const updatedVersion = `${version[1]}.${version[2]}.${patch}-fixture-update.2`;
  assert.notEqual(updatedVersion, originalVersion); pkg.version = updatedVersion;
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { version: string; packages: Record<string, { version?: string }> };
  assert.ok(lock.packages['']); lock.version = updatedVersion; lock.packages[''].version = updatedVersion;
  writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', { mode: 0o600 });
  const executablePath = 'dist/infrastructure/synthetic-agent-turn.js', modulePath = join(candidateB, executablePath);
  const originalCode = readFileSync(modulePath, 'utf8'), expression = 'text: `[합성 규칙 결과] ${text}`';
  assert.equal(originalCode.split(expression).length, 2, 'the actual compiled deterministic answer formatter must have one exact fixture seam');
  const updatedCode = originalCode.replace(expression, `text: \`[합성 규칙 결과 / ${ENGINE_UPDATE_MARKER}] \${text}\``);
  assert.notEqual(updatedCode, originalCode); writeFileSync(modulePath, updatedCode, { mode: 0o600 });
  options.customizeCandidate?.(candidateB);
  const bundleB = bundleAgentEngine(candidateB, join(base, 'bundle-b'));
  const b = installAgentEngine(bundleB.directory, join(base, 'engine-b'), bundleB.release.digest);
  assert.notEqual(a.release.digest, b.release.digest); assert.notEqual(a.release.version, b.release.version);
  assert.deepEqual(a.release.compatibility, b.release.compatibility);
  const codeA = a.release.entries.find(entry => entry.path === executablePath), codeB = b.release.entries.find(entry => entry.path === executablePath);
  assert.ok(codeA?.kind === 'file' && codeB?.kind === 'file'); assert.notEqual(codeA.sha256, codeB.sha256);
  for (const engine of [a, b]) for (const path of ['dist/presentation/agent-cli.js', 'node_modules/zod/package.json',
    'dist/application/workflow-runtime.js', 'dist/infrastructure/sqlite-state.js', 'fixtures/documents-simple.json'])
    assert.ok(engine.release.entries.some(entry => entry.path === path), path);
  assert.equal(readFileSync(join(a.directory, executablePath), 'utf8'), originalCode);
  assert.equal(readFileSync(join(runtimeRoot, executablePath), 'utf8'), originalCode);
  return { a, b, bundleA, bundleB, candidateB, originalVersion, updatedVersion, marker: ENGINE_UPDATE_MARKER };
}

export type EngineUpdateReleases = ReturnType<typeof createEngineUpdateReleases>;
