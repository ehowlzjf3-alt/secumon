import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, readdirSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { cpus, totalmem, release } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform !== 'linux' || process.version !== 'v24.20.0') throw new Error('linux_node24_required');
const root = realpathSync(process.argv[2]);
const cwd = join(root, 'runtime');
const evidence = join(root, 'evidence-final');
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
  const { createHash } = await import('node:crypto');
  const expectedAssets = [{"path":"evidence/internal-io/v024-original-metrics.json","sha256":"6c46bb940bb981a738ca72f7c7bfe99630d96bf75cc564a8565b7689cd216c54"},{"path":"evidence/internal-io/v024-instrumented-metrics.json","sha256":"3e1c4c6f0c001ee9c4c8565149014a1ef7178432e6f6910cb142fe2194f367b1"},{"path":"evidence/internal-io/v024-snapshot-manifest.json","sha256":"dc3a32a845192825e002d5f4863e206c947a2b1be8fb5f65ba739a36fabdb1d1"},{"path":"evidence/internal-io/v024-instrumented-manifest.json","sha256":"5f09ea9071f3cbd056ae0bba25b7d66714f7f84034d1370b4b0b67495aef99a2"},{"path":"evidence/internal-io/instrumented-file-artifacts.js","sha256":"0a92314eea2befcc8d7ce03bf04821afc5773536911a9ddee1e00baa6d0bb9d1"},{"path":"guidance/catalog.json","sha256":"f1b628d9d062d9d9c3ac2eadb2e962fcf46fd0c9b6e0fb1ffee96d4084add1fa"},{"path":"guidance/evidence-review.md","sha256":"e3c770b05cef3d9e96c5992d399d3c8eef0a238ab03cd8f9bd5c57bd47b81315"}];
  record.verifiedAssets = [];
  for (const item of expectedAssets) { const actual = createHash('sha256').update(readFileSync(join(cwd, item.path))).digest('hex'); if (actual !== item.sha256) throw new Error('asset_hash_mismatch:' + item.path); record.verifiedAssets.push(item); }
  persist();
  await run('build', 'npm', ['run', 'build']);
  const { verifyEvaluationBuild } = await import(pathToFileURL(resolve(cwd, 'dist/infrastructure/local-evaluation.js')).href);
  record.buildPin = await verifyEvaluationBuild(cwd); persist();
  if (record.buildPin.sourceDigest !== 'ec154bed0c07003b60c6ffb04e13f235c70c1f86d4239a1f8eb7d2133a42da55') throw new Error('source_pin_mismatch');
  await run('portability-targeted', process.execPath, ['--test', '--test-concurrency=2', '--test-reporter=tap',
    'dist/tests/local-file-paths.test.js', 'dist/tests/agent-profile.test.js', 'dist/tests/agent-stores.test.js', 'dist/tests/cli.test.js', 'dist/tests/mcp-read-tools.test.js', 'dist/tests/mcp-stdio-client.test.js', 'dist/tests/state-query.test.js']);
  await run('typecheck-core', 'npm', ['run', 'typecheck:core']);
  await run('architecture', 'npm', ['run', 'check:architecture']);
  await run('architecture-cli-fixtures', process.execPath, [join(root, 'architecture-cli-check.mjs')]);
  const tests = readdirSync(join(cwd, 'dist/tests')).filter(p => p.endsWith('.test.js')).sort().map(p => 'dist/tests/' + p);
  await run('all-tests', process.execPath, ['--test', '--test-concurrency=2', '--test-reporter=tap', ...tests]);
  await run('fixtures', 'npm', ['run', 'fixtures']);
  record.buildPin = await verifyEvaluationBuild(cwd);
  record.status = 'passed';
} catch (error) { record.status = 'failed'; record.error = String(error); process.exitCode = 1; }
finally { record.finishedAt = new Date().toISOString(); persist(); console.log(JSON.stringify({ status: record.status, finishedAt: record.finishedAt })); }
