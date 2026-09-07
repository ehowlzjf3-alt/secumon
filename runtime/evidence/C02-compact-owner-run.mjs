import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const phase = process.argv[2];
if (!['baseline-build', 'baseline-race', 'fixed-build', 'fixed-tests'].includes(phase)) throw new Error('invalid_owner_evidence_phase');
if (process.version !== 'v24.20.0') throw new Error('expected_Node_24_20_0');
const nodeBin = dirname(process.execPath);
const prefix = `evidence/C02-compact-owner-${phase}`;
const args = phase.endsWith('build') ? [join(nodeBin, 'npm'), 'run', 'build'] : phase === 'baseline-race' ?
  [process.execPath, '--test', '--test-name-pattern=^owner inspection accepts an owned database published after its first missing-main observation$', 'dist/tests/agent-database-owner.test.js'] :
  [process.execPath, '--test', '--test-concurrency=2', 'dist/tests/agent-database-owner.test.js', 'dist/tests/agent-profile.test.js',
    'dist/tests/agent-profile-concurrency.test.js', 'dist/tests/agent-stores.test.js', 'dist/tests/agent-state-binding-recovery.test.js'];
const startedAt = new Date().toISOString();
const log = openSync(join(root, prefix + '.log'), 'w', 0o600);
let exitCode = null; let signal = null; let launchError = null;
try {
  const child = spawn(args[0], args.slice(1), { cwd: root, env: { ...process.env, PATH: `${nodeBin}:${process.env.PATH ?? ''}` }, stdio: ['ignore', log, log] });
  await new Promise(resolve => {
    child.once('error', error => { launchError = String(error); });
    child.once('close', (code, closedSignal) => { exitCode = code; signal = closedSignal; resolve(); });
  });
} finally { closeSync(log); }
const record = { phase, command: args, node: process.version, platform: process.platform, arch: process.arch, startedAt,
  finishedAt: new Date().toISOString(), exitCode, signal, launchError, log: prefix + '.log' };
if (exitCode === 0 && phase.endsWith('build')) {
  copyFileSync(join(root, 'dist/build-manifest.json'), join(root, prefix + '-manifest.json'));
  const { verifyEvaluationBuild } = await import('../dist/infrastructure/local-evaluation.js');
  const pin = await verifyEvaluationBuild(root);
  writeFileSync(join(root, prefix + '-pin.json'), JSON.stringify(pin, null, 2) + '\n', { mode: 0o600 });
  record.pin = pin;
} else if (!phase.endsWith('build')) {
  const manifest = JSON.parse(readFileSync(join(root, 'dist/build-manifest.json'), 'utf8'));
  record.sourceDigest = manifest.sourceDigest;
}
writeFileSync(join(root, prefix + '-exit.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(JSON.stringify(record) + '\n');
process.exitCode = exitCode ?? 1;
