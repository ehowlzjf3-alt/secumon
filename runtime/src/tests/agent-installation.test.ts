import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleAgentEngine, installAgentEngine } from '../infrastructure/agent-engine-release.js';
import { captureLifecycleTree } from '../infrastructure/agent-lifecycle-files.js';
import { SYNTHETIC_AGENT_TURN_REQUESTS } from '../infrastructure/synthetic-agent-turn.js';
import type { SessionPage } from '../domain/session.js';
import type { InstallationSnapshot } from './helpers/agent-installation-probe.js';

const execute = promisify(execFile);
const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
const homePreloader = fileURLToPath(new URL('./helpers/agent-installation-home.js', import.meta.url));
const probe = fileURLToPath(new URL('./helpers/agent-installation-probe.js', import.meta.url));
const packageName = 'long-horizon-runtime';
const packageFile = join(runtimeRoot, 'package.json');
const packageVersion = (JSON.parse(readFileSync(packageFile, 'utf8')) as { version: string }).version;
const requiredFiles = [
  'package.json', 'dist/presentation/agent-cli.js', 'dist/presentation/agent-turn-profile.js',
  'dist/infrastructure/file-guidance.js', 'dist/application/workflow-runtime.js', 'dist/domain/control.js',
  'fixtures/documents-simple.json', 'guidance/catalog.json', 'guidance/evidence-review.md', 'examples/two-agents.md',
  'src/presentation/web/index.html', 'src/presentation/web/styles.css',
  'dist/presentation/web/client.js', 'dist/presentation/web/view-state.js', 'dist/presentation/web/personal-memory.js',
] as const;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface SetupResult {
  status: string; root: string; identity: { agentId: string; createdAt: number };
  config: { storage: { state: string } }; modelReady: boolean; storageInitialized: boolean; runtimeConnected: boolean;
}
interface ChatResult {
  sessionId: string; workId: string;
  snapshot: { status: string; usage: { modelCalls: number; toolCalls: number }; resultReady: boolean };
  messages: { kind: string; text: string }[];
  run?: { reason: string };
}
interface Packed {
  filename: string; shasum: string; integrity: string;
  files: { path: string; size: number; mode: number }[];
}
interface LockPackage { version: string; resolved?: string; integrity?: string; dev?: boolean }
interface NpmCache {
  get: {
    (cache: string, key: string): Promise<{ data: Buffer; integrity: string }>;
    info(cache: string, key: string): Promise<{ integrity: string; metadata: unknown } | null>;
  };
  put(cache: string, key: string, data: Buffer, options: { integrity: string; metadata: unknown }): Promise<unknown>;
}

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-installation-')));
  const directory = join(base, 'agent'), prefix = join(base, 'prefix');
  const home = join(base, 'test-home'), temporary = join(base, 'tmp');
  for (const folder of [prefix, home, temporary]) mkdirSync(folder, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: temporary,
    LANG: 'C.UTF-8', npm_config_update_notifier: 'false' };
  // No real user config, NODE_PATH, NODE_OPTIONS, or HOME override is inherited.
  const cliEnv = { ...env, PATH: `${join(prefix, 'bin')}:${env['PATH']}`,
    NODE_OPTIONS: `--import=${pathToFileURL(homePreloader).href}`, SECUMON_INSTALLATION_HOME: home };
  async function command(file: string, args: readonly string[], product = false) {
    return execute(file, [...args], { cwd: base, env: product ? cliEnv : env,
      timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
  }
  async function json<T>(file: string, args: readonly string[]): Promise<T> {
    return JSON.parse((await command(file, args, true)).stdout) as T;
  }
  async function inspect(engine: string, workId: string, sessionId: string) {
    return json<InstallationSnapshot>(process.execPath, [probe, engine, 'snapshot', directory, workId, sessionId]);
  }
  async function assets(engine: string) {
    const result = await json<{ assets: string[]; guidance: string[] }>(process.execPath, [probe, engine, 'assets', directory]);
    assert.deepEqual(result.assets, ['/', '/assets/styles.css', '/assets/client.js', '/assets/view-state.js', '/assets/personal-memory.js']);
    assert.ok(result.guidance.includes('core.evidence-review'));
  }
  return { base, directory, prefix, home, env, command, json, inspect, assets,
    close: () => rmSync(base, { recursive: true, force: true }) };
}

/** Read the existing cache only; npm receives a separate cache containing those exact saved bytes. */
async function copyDependencyCache(npmCli: string, destination: string) {
  const source = join(process.env['SECUMON_INSTALLATION_NPM_CACHE'] ?? join(homedir(), '.npm'), '_cacache');
  const cache = createRequire(npmCli)('cacache') as NpmCache;
  const packages = (JSON.parse(readFileSync(join(runtimeRoot, 'package-lock.json'), 'utf8')) as { packages: Record<string, LockPackage> }).packages;
  let copied = 0;
  for (const [path, item] of Object.entries(packages)) {
    if (!path || item.dev) continue;
    assert.ok(path.startsWith('node_modules/') && item.resolved && item.integrity, path);
    const name = path.slice('node_modules/'.length);
    const urls = [name, name.replace('/', '%2f'), name.replace('/', '%2F')].map(value => `https://registry.npmjs.org/${value}`);
    let manifestCopied = false;
    for (const url of [...new Set(urls), item.resolved]) {
      const key = `make-fetch-happen:request-cache:${url}`, info = await cache.get.info(source, key);
      if (!info && url !== item.resolved) continue;
      assert.ok(info, `offline installation requires the pre-existing cached tarball for ${name}@${item.version}`);
      const entry = await cache.get(source, key);
      assert.equal(entry.integrity, info.integrity);
      if (url === item.resolved) assert.equal(entry.integrity, item.integrity, `${name}: locked tarball integrity`);
      else {
        const manifest = JSON.parse(entry.data.toString('utf8')) as { versions?: Record<string, { dist?: { integrity?: string } }> };
        assert.equal(manifest.versions?.[item.version]?.dist?.integrity, item.integrity, `${name}: cached package metadata`);
        manifestCopied = true;
      }
      await cache.put(join(destination, '_cacache'), key, entry.data, { integrity: info.integrity, metadata: info.metadata });
      copied++;
    }
    assert.equal(manifestCopied, true, `offline installation requires pre-existing package metadata for ${name}`);
  }
  assert.ok(copied > 0);
  return copied;
}

test('installation original npm package supports cached offline global bin setup and preserves work across reinstall',
  { timeout: 240000, skip: process.platform === 'win32' ? 'POSIX npm global-bin harness; native Windows installation is separate' : false }, async () => {
    const f = fixture();
    try {
      const npmCli = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
      assert.ok(existsSync(npmCli), 'run with the bundled Node 24 distribution including its npm CLI');
      const cache = join(f.base, 'npm-cache'), packs = join(f.base, 'packages');
      mkdirSync(packs, { mode: 0o700 });
      const userConfig = join(f.base, 'user.npmrc'), globalConfig = join(f.base, 'global.npmrc');
      writeFileSync(userConfig, '', { mode: 0o600 }); writeFileSync(globalConfig, '', { mode: 0o600 });
      const flags = ['--offline', '--ignore-scripts', '--audit=false', '--fund=false', '--cache', cache,
        '--userconfig', userConfig, '--globalconfig', globalConfig, '--loglevel=error'];
      async function npm(args: string[], cwd = f.base) {
        return execute(process.execPath, [npmCli, ...args, ...flags], { cwd, env: f.env,
          timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
      }
      const packageBytes = readFileSync(packageFile), lockBytes = readFileSync(join(runtimeRoot, 'package-lock.json'));
      // Pack the unmodified product. No bundledDependencies, edited metadata, or repository symlink installation.
      const packed = JSON.parse((await npm(['pack', '--json', '--pack-destination', packs], runtimeRoot)).stdout) as Packed[];
      assert.equal(packed.length, 1);
      const archive = packed[0]!;
      assert.equal(basename(archive.filename), archive.filename);
      const tarball = join(packs, archive.filename), bytes = readFileSync(tarball);
      assert.equal(createHash('sha1').update(bytes).digest('hex'), archive.shasum);
      assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, archive.integrity);
      for (const path of requiredFiles) assert.ok(archive.files.some(entry => entry.path === path), `npm package missing ${path}`);
      assert.equal(archive.files.some(entry => /^(?:node_modules|dist\/tests|\.tools|evidence)\//.test(entry.path)), false);
      assert.equal(archive.files.some(entry => /^src\/.*\.ts$/.test(entry.path)), false);
      assert.deepEqual(readFileSync(packageFile), packageBytes); assert.deepEqual(readFileSync(join(runtimeRoot, 'package-lock.json')), lockBytes);

      await copyDependencyCache(npmCli, cache);
      const engine = join(f.prefix, 'lib', 'node_modules', packageName), bin = join(f.prefix, 'bin', 'secumon-agent');
      const install = () => npm(['install', '--global', '--prefix', f.prefix, tarball]);
      await install();
      assert.ok(lstatSync(bin).isSymbolicLink(), 'npm, not the fixture, registers the global bin');
      assert.equal(realpathSync(bin), join(engine, 'dist/presentation/agent-cli.js'));
      for (const path of requiredFiles) assert.deepEqual(readFileSync(join(engine, path)), readFileSync(join(runtimeRoot, path)), path);
      const installedPackage = JSON.parse(readFileSync(join(engine, 'package.json'), 'utf8')) as { bin: Record<string, string>; dependencies: Record<string, string> };
      assert.equal(installedPackage.bin['secumon-agent'], 'dist/presentation/agent-cli.js');
      const requireInstalled = createRequire(join(engine, 'package.json'));
      for (const name of Object.keys(installedPackage.dependencies))
        assert.ok(requireInstalled.resolve(name).startsWith(engine + '/'), `${name} resolves within the installed prefix`);

      const cli = <T>(args: string[]) => f.json<T>('secumon-agent', args);
      assert.equal((await cli<{ version: string }>(['version', '--json'])).version, packageVersion);
      const setup = await cli<SetupResult>(['init', '--directory', f.directory, '--name', 'installation owner', '--json']);
      assert.equal(setup.status, 'ready'); assert.equal(setup.root, f.directory);
      assert.equal(setup.config.storage.state, 'sqlite'); assert.equal(setup.modelReady, false);
      assert.equal(setup.storageInitialized, true); assert.equal(setup.runtimeConnected, false);
      assert.ok(existsSync(join(f.home, '.secumon', 'host-identities')), 'the real CLI registry stays in the process-local test home');
      await f.assets(engine);
      const note = Buffer.from('사용자 담당 자료: 엔진을 제거해도 이 파일과 기존 업무는 남아야 한다.\n');
      writeFileSync(join(f.directory, 'installation-note.txt'), note, { mode: 0o600 });
      const chat = <T = ChatResult>(args: string[]) => cli<T>(['chat', ...args, '--directory', f.directory, '--provider', 'synthetic', '--json']);
      const first = await chat(['ask', '--message-id', 'installation-read', '--text', SYNTHETIC_AGENT_TURN_REQUESTS.read, '--steps', '2']);
      assert.notEqual(first.snapshot.status, 'completed'); assert.equal(first.run?.reason, 'step_limit');
      const before = await f.inspect(engine, first.workId, first.sessionId);
      assert.equal(before.state.modelCalls.length, 1); assert.equal(before.state.modelCalls[0]!.status, 'received');
      assert.ok(before.state.modelCalls[0]!.replyArtifact); assert.equal(before.state.attempts.length, 0);
      assert.ok(before.artifacts.some(item => item.ref.id === before.state.modelCalls[0]!.replyArtifact!.id));
      assert.deepEqual(before.history.entries.filter(entry => entry.role === 'user').map(entry => entry.text), [SYNTHETIC_AGENT_TURN_REQUESTS.read]);
      const agentTree = captureLifecycleTree(f.directory), hostTree = captureLifecycleTree(f.home);

      await npm(['uninstall', '--global', '--prefix', f.prefix, packageName]);
      assert.equal(existsSync(engine), false); assert.equal(existsSync(bin), false);
      assert.deepEqual(captureLifecycleTree(f.directory), agentTree); assert.deepEqual(captureLifecycleTree(f.home), hostTree);
      await install();
      assert.equal(realpathSync(bin), join(engine, 'dist/presentation/agent-cli.js'));
      assert.deepEqual(captureLifecycleTree(f.directory), agentTree); assert.deepEqual(captureLifecycleTree(f.home), hostTree);
      assert.equal((await cli<{ version: string }>(['version', '--json'])).version, packageVersion);
      const reopened = await cli<SetupResult>(['open', '--directory', f.directory, '--json']);
      assert.deepEqual(reopened.identity, setup.identity);
      assert.deepEqual(await f.inspect(engine, first.workId, first.sessionId), before, 'reopening does not execute or replace the saved work');
      const resumed = await chat(['resume', '--work', first.workId, '--session', first.sessionId]);
      assert.equal(resumed.workId, first.workId); assert.equal(resumed.sessionId, first.sessionId);
      assert.equal(resumed.snapshot.status, 'completed'); assert.equal(resumed.snapshot.resultReady, true);
      assert.equal(resumed.snapshot.usage.toolCalls, 1); assert.equal(resumed.snapshot.usage.modelCalls, 2);
      assert.ok(resumed.messages.some(message => message.kind === 'result' && message.text.includes('30일')));
      const after = await f.inspect(engine, first.workId, first.sessionId);
      assert.equal(after.state.evidence.find(item => item.id === 'doc-current')?.facts['retention.days'], 30);
      for (const original of before.artifacts) assert.deepEqual(after.artifacts.find(item => item.ref.id === original.ref.id), original);
      const history = await chat<SessionPage>(['history', '--session', first.sessionId]);
      assert.equal(history.entries.filter(entry => entry.role === 'user').length, 1);
      assert.equal(history.entries.filter(entry => entry.kind === 'ack').length, 1);
      assert.equal(history.entries.filter(entry => entry.kind === 'result').length, 1);
      assert.deepEqual(readFileSync(join(f.directory, 'installation-note.txt')), note);
    } finally { f.close(); }
  });

test('installation bundled engine uses its returned offline command and consumes packaged assets',
  { timeout: 180000, skip: process.platform === 'win32' ? 'POSIX release fixture; native Windows installation is separate' : false }, async () => {
    const f = fixture();
    try {
      const bundle = bundleAgentEngine(runtimeRoot, join(f.base, 'bundle'));
      const installed = installAgentEngine(bundle.directory, join(f.prefix, 'engine'), bundle.release.digest);
      assert.equal(installed.release.digest, bundle.release.digest);
      assert.deepEqual(installed.command, ['node', join(installed.directory, 'dist/presentation/agent-cli.js')]);
      assert.ok(installed.release.entries.some(entry => entry.path === 'node_modules/zod/package.json'));
      for (const path of requiredFiles) assert.ok(installed.release.entries.some(entry => entry.path === path), path);
      // The host chooses Node 24 for the returned command. This does not manufacture a product global-bin installer.
      const cli = <T>(args: string[]) => f.json<T>(process.execPath, [installed.command[1]!, ...args]);
      assert.equal((await cli<{ version: string }>(['version', '--json'])).version, packageVersion);
      const setup = await cli<SetupResult>(['init', '--directory', f.directory, '--json']);
      assert.equal(setup.status, 'ready'); assert.equal(setup.storageInitialized, true); assert.equal(setup.modelReady, false);
      await f.assets(installed.directory);
      const agentTree = captureLifecycleTree(f.directory), hostTree = captureLifecycleTree(f.home);
      rmSync(installed.directory, { recursive: true });
      assert.deepEqual(captureLifecycleTree(f.directory), agentTree); assert.deepEqual(captureLifecycleTree(f.home), hostTree);
      const reinstalled = installAgentEngine(bundle.directory, installed.directory, bundle.release.digest);
      assert.equal(reinstalled.release.digest, installed.release.digest);
      assert.deepEqual(captureLifecycleTree(f.directory), agentTree); assert.deepEqual(captureLifecycleTree(f.home), hostTree);
      assert.deepEqual((await cli<SetupResult>(['open', '--directory', f.directory, '--json'])).identity, setup.identity);
      assert.equal(sha256(readFileSync(packageFile)), sha256(readFileSync(join(reinstalled.directory, 'package.json'))));
    } finally { f.close(); }
  });
