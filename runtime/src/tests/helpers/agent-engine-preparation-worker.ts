import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';

export type PreparationStage = 'engine-before-manifest' | 'engine-after-manifest' | 'selector-before-link';
export interface PreparationBoundary {
  type: 'engine-preparation-boundary'; stage: PreparationStage; pid: number;
  source: string; target: string; candidate: { base64: string; sha256: string; identity: string; links: number };
}

const [input, agent, preparation, registry, phase, gates] = process.argv.slice(2);
assert.ok(input && agent && preparation && registry && gates && process.send);
assert.ok(phase === 'partial' || phase === 'linked' || phase === 'race');
const root = resolve(preparation), originalLink = fs.linkSync, cell = new Int32Array(new SharedArrayBuffer(4));
const reached = new Set<PreparationStage>();
function checkpoint(stage: PreparationStage, source: string, target: string) {
  assert.equal(reached.has(stage), false); reached.add(stage);
  assert.ok(source.startsWith(root + '/') && target.startsWith(root + '/'));
  const stat = fs.lstatSync(source), bytes = fs.readFileSync(source);
  const links = stage === 'engine-after-manifest' ? 2 : 1;
  assert.ok(stat.isFile() && !stat.isSymbolicLink()); assert.equal(stat.nlink, links); assert.ok(bytes.length <= 128 * 1024);
  if (stage === 'engine-after-manifest') {
    const published = fs.lstatSync(target); assert.ok(published.isFile() && !published.isSymbolicLink());
    assert.equal(published.nlink, 2); assert.equal(`${published.dev}:${published.ino}`, `${stat.dev}:${stat.ino}`);
    assert.deepEqual(fs.readFileSync(target), bytes);
  }
  const message: PreparationBoundary = { type: 'engine-preparation-boundary', stage, pid: process.pid, source, target,
    candidate: { base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), identity: `${stat.dev}:${stat.ino}`, links: stat.nlink } };
  process.send!(message);
  // Pause real filesystem publication after the candidate fsync. The parent observes and releases or kills this process.
  const deadline = performance.now() + 20000, go = join(gates!, stage);
  while (performance.now() < deadline) {
    if (phase === 'race' && fs.existsSync(go)) return;
    Atomics.wait(cell, 0, 0, 10);
  }
  throw new Error(`engine_preparation_worker_parent_deadline:${stage}`);
}
fs.linkSync = (source, destination) => {
  const target = String(destination);
  const manifest = target.startsWith(root + '/') && target.endsWith('/engine/release.json');
  if (manifest && phase !== 'linked') checkpoint('engine-before-manifest', String(source), target);
  if (phase === 'race' && target.startsWith(root + '/') && target.endsWith('/selected.json')) checkpoint('selector-before-link', String(source), target);
  originalLink(source, destination);
  if (manifest && phase === 'linked') checkpoint('engine-after-manifest', String(source), target);
};
syncBuiltinESMExports();
try {
  const { prepareAgentEngine } = await import('../../infrastructure/agent-engine-preparation.js');
  const result = prepareAgentEngine(input, agent, { preparationDirectory: root, registryDirectory: registry });
  if (phase !== 'race' || reached.size !== 2) throw new Error('engine_preparation_boundary_not_reached');
  fs.writeSync(1, JSON.stringify(result) + '\n');
} catch (error) {
  fs.writeSync(1, JSON.stringify({ error: { code: (error as { code?: unknown })?.code ?? null,
    message: error instanceof Error ? error.message : String(error) } }) + '\n');
  process.exitCode = 1;
} finally {
  fs.linkSync = originalLink; syncBuiltinESMExports(); if (process.connected) process.disconnect();
}
