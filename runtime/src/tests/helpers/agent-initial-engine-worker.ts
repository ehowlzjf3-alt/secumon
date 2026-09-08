import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';

export interface InitialEngineOriginal { path: string; base64: string; sha256: string; links: number; identity: string }
export interface InitialEngineBoundary {
  type: 'initial-engine-boundary'; phase: string; pid: number; root: string; source: string; target: string;
  originals: InitialEngineOriginal[];
}
const [engine, input, registry, phase, go] = process.argv.slice(2);
assert.ok(engine && input && registry && phase && process.send);
assert.ok(['operation-linked', 'pin-before-link', 'pin-linked', 'receipt-linked', 'race'].includes(phase));
const root = resolve(input), originalLink = fs.linkSync, cell = new Int32Array(new SharedArrayBuffer(4));
const targets = { 'operation-linked': join(root, '.secumon/setup-operation.json'), 'pin-before-link': join(root, '.secumon/engine-pins/00000001.json'), 'pin-linked': join(root, '.secumon/engine-pins/00000001.json'),
  'receipt-linked': join(root, '.secumon/setup.json'), race: join(root, '.secumon/setup-operation.json') };
const target = targets[phase as keyof typeof targets]; let reached = 0;
function original(path: string): InitialEngineOriginal {
  const stat = fs.lstatSync(path); assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false); assert.ok(stat.size <= 512 * 1024);
  const bytes = fs.readFileSync(path); assert.equal(bytes.length, stat.size);
  return { path, base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), links: stat.nlink, identity: `${stat.dev}:${stat.ino}` };
}
function checkpoint(source: string): void {
  assert.equal(++reached, 1);
  const names = [source, '.secumon/setup-operation.json', '.secumon/identity.json', 'config.json', '.secumon/engine-pins/00000001.json', '.secumon/setup.json'];
  const paths = [...new Set(names.map(path => path === source ? path : join(root, path)))].filter(path => fs.existsSync(path));
  const message: InitialEngineBoundary = { type: 'initial-engine-boundary', phase: phase!, pid: process.pid, root, source, target, originals: paths.map(original) };
  assert.ok(Buffer.byteLength(JSON.stringify(message)) <= 64 * 1024); process.send!(message);
  // Process interruption only: the real candidate is file-synced, but its directory publication has not completed its fsync.
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    if (phase === 'race' && go && fs.existsSync(go)) return;
    Atomics.wait(cell, 0, 0, 10);
  }
  throw new Error('initial_engine_worker_parent_deadline');
}
fs.linkSync = (source, destination) => {
  if (String(destination) === target && (phase === 'race' || phase === 'pin-before-link')) checkpoint(String(source));
  originalLink(source, destination);
  if (String(destination) === target && phase !== 'race' && phase !== 'pin-before-link') checkpoint(String(source));
};
syncBuiltinESMExports();
try {
  const { FileAgentProfileStore } = await import('../../infrastructure/file-agent-profile.js');
  const profile = new FileAgentProfileStore(engine, { engineRegistryDirectory: registry }).initialize(root, { name: 'initial-engine-fixture' });
  if (phase !== 'race') throw new Error('initial_engine_crash_boundary_not_reached');
  assert.equal(reached, 1);
  const result = { status: profile.status, identity: profile.identity,
    operation: JSON.parse(fs.readFileSync(join(root, '.secumon/setup-operation.json'), 'utf8')),
    pin: JSON.parse(fs.readFileSync(join(root, '.secumon/engine-pins/00000001.json'), 'utf8')),
    receipt: JSON.parse(fs.readFileSync(join(root, '.secumon/setup.json'), 'utf8')) };
  fs.writeSync(1, JSON.stringify(result) + '\n');
} catch (error) {
  fs.writeSync(1, JSON.stringify({ error: { code: (error as { code?: unknown })?.code ?? null,
    message: error instanceof Error ? error.message : String(error) } }) + '\n');
  process.exitCode = 1;
} finally { fs.linkSync = originalLink; syncBuiltinESMExports(); if (process.connected) process.disconnect(); }
