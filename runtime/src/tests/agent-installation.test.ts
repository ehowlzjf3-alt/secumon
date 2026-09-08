import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleAgentEngine, inspectAgentEngineBuild, inspectEngineRelease, installAgentEngine, readAgentEnginePin } from '../infrastructure/agent-engine-release.js';
import { captureLifecycleTree, lifecycleDigest } from '../infrastructure/agent-lifecycle-files.js';
import { AgentInitialSetupReceiptSchema, AgentSetupOperationV3Schema } from '../application/agent-profile-contracts.js';
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

function fixture(commandTimeoutMs = 45000) {
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
      timeout: commandTimeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
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
  { timeout: 300000, skip: process.platform === 'win32' ? 'POSIX npm global-bin harness; native Windows installation is separate' : false }, async () => {
    // First setup captures the full source twice, copies/verifies its bundle and installation, then launches the child CLI.
    const f = fixture(90000);
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
      const preparation = join(f.home, '.secumon', 'engine-releases'), registry = join(f.home, '.secumon', 'engines');
      function captureNpmSource() {
        // npm may publish dependency .bin links. Preserve their text without following them into another tree.
        const links: { path: string; target: string }[] = [];
        const entries = captureLifecycleTree(engine, path => {
          const file = join(engine, path); if (!lstatSync(file).isSymbolicLink()) return true;
          links.push({ path, target: readlinkSync(file) }); return false;
        });
        return { entries, links };
      }
      assert.equal(existsSync(join(engine, 'release.json')), false, 'the unmodified npm package is not an installed release');
      const sourceTree = captureNpmSource(), sourceRelease = inspectAgentEngineBuild(engine);
      const homeBeforeSetup = captureLifecycleTree(f.home);
      assert.equal((await cli<{ version: string }>(['version', '--json'])).version, packageVersion);
      assert.match((await f.command('secumon-agent', ['help'], true)).stdout, /secumon-agent/);
      const missing = await cli<{ status: string; root: string }>(['status', '--directory', f.directory, '--json']);
      assert.equal(missing.status, 'uninitialized'); assert.equal(missing.root, f.directory);
      for (const [args, code] of [
        [['init', '--directory', f.directory, '--unknown-installation-option', '--json'], 'agent_setup_failed'],
        [['init', '--directory', f.directory, '--state-backend', 'invalid', '--json'], 'agent_setup_options_invalid'],
      ] as const) {
        await assert.rejects(f.command('secumon-agent', args, true), (error: unknown) => {
          const failure = error as { code?: number | string; stderr?: string };
          assert.equal(failure.code, 1); assert.match(failure.stderr ?? '', new RegExp(`(?:^|\\n)${code}(?:\\n|$)`)); return true;
        });
      }
      assert.equal(existsSync(f.directory), false); assert.equal(existsSync(preparation), false);
      assert.deepEqual(captureLifecycleTree(f.home), homeBeforeSetup, 'read-only and invalid commands do not prepare or register an engine');
      assert.deepEqual(captureNpmSource(), sourceTree);

      const setup = await cli<SetupResult>(['init', '--directory', f.directory, '--name', 'installation owner', '--json']);
      assert.equal(setup.status, 'ready'); assert.equal(setup.root, f.directory);
      assert.equal(setup.config.storage.state, 'sqlite'); assert.equal(setup.modelReady, false);
      assert.equal(setup.storageInitialized, true); assert.equal(setup.runtimeConnected, false);
      assert.ok(existsSync(join(f.home, '.secumon', 'host-identities')), 'the real CLI registry stays in the process-local test home');
      const pin = readAgentEnginePin(f.directory); assert.ok(pin);
      const pinnedEngine = pin.engineDirectory, attemptDirectory = dirname(pinnedEngine), releaseDirectory = dirname(attemptDirectory);
      assert.notEqual(pinnedEngine, engine); assert.equal(basename(pinnedEngine), 'engine');
      assert.equal(dirname(releaseDirectory), preparation); assert.equal(basename(releaseDirectory), sourceRelease.digest);
      assert.match(basename(attemptDirectory), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      const installedRelease = inspectEngineRelease(pinnedEngine);
      assert.deepEqual(installedRelease, sourceRelease, 'the pin selects a full verified release of the original npm source');
      assert.equal(pin.releaseDigest, installedRelease.digest); assert.equal(pin.version, installedRelease.version);
      assert.equal(pin.agentId, setup.identity.agentId); assert.equal(pin.sequence, 1); assert.equal(pin.previous, null); assert.equal(pin.backupDigest, null);
      const operationPath = join(f.directory, '.secumon/setup-operation.json'), receiptPath = join(f.directory, '.secumon/setup.json');
      const operationBytes = readFileSync(operationPath), receiptBytes = readFileSync(receiptPath);
      const operation = AgentSetupOperationV3Schema.parse(JSON.parse(operationBytes.toString('utf8')));
      const receipt = AgentInitialSetupReceiptSchema.parse(JSON.parse(receiptBytes.toString('utf8')));
      assert.deepEqual(operation.identity, setup.identity); assert.deepEqual(operation.initialEngine.pin, pin);
      assert.deepEqual(receipt, { schemaVersion: 3, agentId: setup.identity.agentId, operationId: operation.operationId, initialPinDigest: lifecycleDigest(pin) });
      const registrations = readdirSync(registry).filter(leaf => leaf.endsWith('.json')).map(leaf =>
        JSON.parse(readFileSync(join(registry, leaf), 'utf8')) as { schemaVersion: number; kind: string; directory: string; releaseDigest: string; version: string });
      const matching = registrations.filter(value => value.directory === pinnedEngine && value.releaseDigest === pin.releaseDigest);
      assert.equal(matching.length, 1); const registration = matching[0]!;
      assert.equal(registration.schemaVersion, 1); assert.equal(registration.kind, 'secumon-engine-installation');
      assert.equal(registration.version, installedRelease.version);
      assert.equal(operation.initialEngine.registrationDigest, lifecycleDigest(registration));
      const selectionPath = join(releaseDirectory, 'selected.json'), selectionBytes = readFileSync(selectionPath);
      assert.deepEqual(JSON.parse(selectionBytes.toString('utf8')), { schemaVersion: 1, kind: 'prepared-agent-engine',
        releaseDigest: sourceRelease.digest, attemptId: basename(attemptDirectory), registrationDigest: lifecycleDigest(registration) });
      assert.deepEqual(captureNpmSource(), sourceTree, 'materialization does not modify the npm source');

      const firstAgentTree = captureLifecycleTree(f.directory), preparedTree = captureLifecycleTree(preparation);
      const secondDirectory = join(f.base, 'second-agent');
      const second = await cli<SetupResult>(['open', '--directory', secondDirectory, '--json']);
      assert.equal(second.status, 'ready'); assert.equal(second.storageInitialized, true); assert.notEqual(second.identity.agentId, setup.identity.agentId);
      const secondPin = readAgentEnginePin(secondDirectory); assert.ok(secondPin);
      assert.equal(secondPin.agentId, second.identity.agentId); assert.equal(secondPin.engineDirectory, pinnedEngine); assert.equal(secondPin.releaseDigest, pin.releaseDigest);
      assert.deepEqual(captureLifecycleTree(f.directory), firstAgentTree, 'the second initialization preserves the first agent');
      assert.deepEqual(captureLifecycleTree(preparation), preparedTree, 'a second agent reuses the same prepared installation without creating another attempt');
      assert.deepEqual(captureNpmSource(), sourceTree); assert.deepEqual(readFileSync(selectionPath), selectionBytes);
      await f.assets(pinnedEngine);
      const note = Buffer.from('사용자 담당 자료: 엔진을 제거해도 이 파일과 기존 업무는 남아야 한다.\n');
      writeFileSync(join(f.directory, 'installation-note.txt'), note, { mode: 0o600 });
      const chat = <T = ChatResult>(args: string[]) => cli<T>(['chat', ...args, '--directory', f.directory, '--provider', 'synthetic', '--json']);
      const first = await chat(['ask', '--message-id', 'installation-read', '--text', SYNTHETIC_AGENT_TURN_REQUESTS.read, '--steps', '2']);
      assert.notEqual(first.snapshot.status, 'completed'); assert.equal(first.run?.reason, 'step_limit');
      const before = await f.inspect(pinnedEngine, first.workId, first.sessionId);
      assert.equal(before.state.modelCalls.length, 1); assert.equal(before.state.modelCalls[0]!.status, 'received');
      assert.ok(before.state.modelCalls[0]!.replyArtifact); assert.equal(before.state.attempts.length, 0);
      assert.ok(before.artifacts.some(item => item.ref.id === before.state.modelCalls[0]!.replyArtifact!.id));
      assert.deepEqual(before.history.entries.filter(entry => entry.role === 'user').map(entry => entry.text), [SYNTHETIC_AGENT_TURN_REQUESTS.read]);
      const agentTree = captureLifecycleTree(f.directory), hostTree = captureLifecycleTree(f.home);

      await npm(['uninstall', '--global', '--prefix', f.prefix, packageName]);
      assert.equal(existsSync(engine), false); assert.equal(existsSync(bin), false);
      assert.ok(existsSync(join(pinnedEngine, 'release.json'))); assert.deepEqual(readAgentEnginePin(f.directory), pin);
      assert.deepEqual(captureLifecycleTree(f.directory), agentTree); assert.deepEqual(captureLifecycleTree(f.home), hostTree);
      await install();
      assert.equal(realpathSync(bin), join(engine, 'dist/presentation/agent-cli.js'));
      assert.deepEqual(captureLifecycleTree(f.directory), agentTree); assert.deepEqual(captureLifecycleTree(f.home), hostTree);
      const reinstalledSourceTree = captureNpmSource();
      assert.equal((await cli<{ version: string }>(['version', '--json'])).version, packageVersion);
      const reopened = await cli<SetupResult>(['open', '--directory', f.directory, '--json']);
      assert.deepEqual(reopened.identity, setup.identity);
      assert.deepEqual(await f.inspect(pinnedEngine, first.workId, first.sessionId), before, 'reopening does not execute or replace the saved work');
      const resumed = await chat(['resume', '--work', first.workId, '--session', first.sessionId]);
      assert.equal(resumed.workId, first.workId); assert.equal(resumed.sessionId, first.sessionId);
      assert.equal(resumed.snapshot.status, 'completed'); assert.equal(resumed.snapshot.resultReady, true);
      assert.equal(resumed.snapshot.usage.toolCalls, 1); assert.equal(resumed.snapshot.usage.modelCalls, 2);
      assert.ok(resumed.messages.some(message => message.kind === 'result' && message.text.includes('30일')));
      const after = await f.inspect(pinnedEngine, first.workId, first.sessionId);
      assert.equal(after.state.evidence.find(item => item.id === 'doc-current')?.facts['retention.days'], 30);
      for (const original of before.artifacts) assert.deepEqual(after.artifacts.find(item => item.ref.id === original.ref.id), original);
      const history = await chat<SessionPage>(['history', '--session', first.sessionId]);
      assert.equal(history.entries.filter(entry => entry.role === 'user').length, 1);
      assert.equal(history.entries.filter(entry => entry.kind === 'ack').length, 1);
      assert.equal(history.entries.filter(entry => entry.kind === 'result').length, 1);
      assert.deepEqual(readFileSync(join(f.directory, 'installation-note.txt')), note);
      assert.deepEqual(readAgentEnginePin(f.directory), pin); assert.deepEqual(readFileSync(selectionPath), selectionBytes);
      assert.deepEqual(readFileSync(operationPath), operationBytes); assert.deepEqual(readFileSync(receiptPath), receiptBytes);
      assert.deepEqual(captureLifecycleTree(preparation), preparedTree);
      assert.deepEqual(captureNpmSource(), reinstalledSourceTree, 'reinstalled npm bootstrap does not replace the original pinned engine');
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
