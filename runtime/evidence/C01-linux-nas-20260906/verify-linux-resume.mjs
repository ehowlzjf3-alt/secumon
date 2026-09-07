import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, readdirSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { cpus, totalmem, release } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform !== 'linux' || process.version !== 'v24.20.0') throw new Error('linux_node24_required');
const root = realpathSync(process.argv[2]);
const cwd = join(root, 'runtime');
const evidence = join(root, 'evidence');
mkdirSync(evidence, { recursive: true, mode: 0o700 });
process.umask(0o022);
const record = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(),
  environment: { platform: process.platform, arch: process.arch, node: process.version, kernel: release(),
    osRelease: readFileSync('/etc/os-release', 'utf8'), cpus: cpus().length, totalMemoryBytes: totalmem(),
    testConcurrency: 2, umask: '0022', temporaryDirectory: process.env.TMPDIR },
  scope: 'native_linux_runtime_build_tests_and_fixtures',
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
  record.buildReused = { reason: 'guidance_assets_added_without_source_change', priorResult: '../evidence-attempt-1/result.json' };
  record.guidanceFiles = {};
  const { createHash } = await import('node:crypto');
  for (const file of ['guidance/catalog.json', 'guidance/evidence-review.md']) record.guidanceFiles[file] = createHash('sha256').update(readFileSync(join(cwd, file))).digest('hex');
  const { verifyEvaluationBuild } = await import(pathToFileURL(resolve(cwd, 'dist/infrastructure/local-evaluation.js')).href);
  record.buildPin = await verifyEvaluationBuild(cwd); persist();
  if (record.buildPin.sourceDigest !== '0f49c4cacef25a517f21a31c4e361c1c8da77490fb5f962f7092a41b4d26d0aa') throw new Error('source_pin_mismatch');
  await run('c01-targeted', process.execPath, ['--test', '--test-concurrency=2', '--test-reporter=tap',
    'dist/tests/agent-profile.test.js', 'dist/tests/agent-stores.test.js', 'dist/tests/cli.test.js']);
  await run('typecheck-core', 'npm', ['run', 'typecheck:core']);
  await run('architecture', 'npm', ['run', 'check:architecture']);
  const tests = readdirSync(join(cwd, 'dist/tests')).filter(p => p.endsWith('.test.js')).sort().map(p => 'dist/tests/' + p);
  await run('all-tests', process.execPath, ['--test', '--test-concurrency=2', '--test-reporter=tap', ...tests]);
  await run('fixtures', 'npm', ['run', 'fixtures']);
  record.buildPin = await verifyEvaluationBuild(cwd);
  record.status = 'passed';
} catch (error) { record.status = 'failed'; record.error = String(error); process.exitCode = 1; }
finally { record.finishedAt = new Date().toISOString(); persist(); console.log(JSON.stringify({ status: record.status, finishedAt: record.finishedAt })); }
