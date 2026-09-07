import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, readdirSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { cpus, totalmem, release } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform !== 'linux' || process.version !== 'v24.20.0') throw new Error('linux_node24_required');
const root = realpathSync(process.argv[2]);
const cwd = join(root, 'runtime');
const evidence = join(root, 'evidence-post-fix');
mkdirSync(evidence, { recursive: true, mode: 0o700 });
process.umask(0o022);
const record = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(),
  environment: { platform: process.platform, arch: process.arch, node: process.version, kernel: release(),
    osRelease: readFileSync('/etc/os-release', 'utf8'), cpus: cpus().length, totalMemoryBytes: totalmem(),
    testConcurrency: 2, umask: '0022', temporaryDirectory: process.env.TMPDIR },
  scope: 'native_linux_post_fix_affected_regression',
  externalModelCalls: false, internalServiceIntegration: false, productionDeployment: false,
  steps: [], buildPin: null, finishedAt: null };
const persist = () => writeFileSync(join(evidence, 'result.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
persist();
async function run(name, command, args) {
  const log = join(evidence, name + '.log');
  const step = { name, command: [command, ...args], startedAt: new Date().toISOString(), status: 'running', log,
    exitCode: null, signal: null, finishedAt: null };
  record.steps.push(step); persist(); console.log(JSON.stringify({ event: 'started', name, at: step.startedAt }));
  const output = createWriteStream(log, { mode: 0o600 });
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
    child.on('error', reject); child.on('close', (code, signal) => output.end(() => resolve({ code, signal })));
  });
  Object.assign(step, { status: exit.code === 0 ? 'passed' : 'failed', exitCode: exit.code, signal: exit.signal, finishedAt: new Date().toISOString() });
  persist(); console.log(JSON.stringify({ event: 'finished', name, exitCode: exit.code, at: step.finishedAt }));
  if (exit.code !== 0) throw new Error('step_failed:' + name);
}
try {
  const baseline = JSON.parse(readFileSync(join(root, 'evidence/result.json'), 'utf8'));
  if (baseline.status !== 'passed' || !baseline.steps.some(step => step.name === 'all-tests' && step.status === 'passed')) throw new Error('complete_baseline_required');
  record.baseline = { sourceDigest: baseline.buildPin.sourceDigest, result: '../evidence/result.json', finishedAt: baseline.finishedAt };
  await run('build', 'npm', ['run', 'build']);
  const { verifyEvaluationBuild } = await import(pathToFileURL(resolve(cwd, 'dist/infrastructure/local-evaluation.js')).href);
  record.buildPin = await verifyEvaluationBuild(cwd); persist();
  if (record.buildPin.sourceDigest !== 'af18a5539d30ed18e36ee24f5f4b444b1cf2ef6db09103e6f64a254c5c61c51b') throw new Error('source_pin_mismatch');
  await run('paths-and-storage-regression', process.execPath, ['--test', '--test-concurrency=2', '--test-reporter=tap',
    'dist/tests/local-file-paths.test.js', 'dist/tests/agent-profile.test.js', 'dist/tests/agent-stores.test.js', 'dist/tests/workspace-checkpoints.test.js', 'dist/tests/journal-fault.test.js', 'dist/tests/state-conformance.test.js', 'dist/tests/cli.test.js']);
  await run('typecheck-core', 'npm', ['run', 'typecheck:core']);
  await run('architecture', 'npm', ['run', 'check:architecture']);
  await run('architecture-cli-fixtures', process.execPath, [join(root, 'architecture-cli-check.mjs')]);
  await run('fixtures', 'npm', ['run', 'fixtures']);
  record.buildPin = await verifyEvaluationBuild(cwd);
  record.status = 'passed';
} catch (error) { record.status = 'failed'; record.error = String(error); process.exitCode = 1; }
finally { record.finishedAt = new Date().toISOString(); persist(); console.log(JSON.stringify({ status: record.status, finishedAt: record.finishedAt })); }
