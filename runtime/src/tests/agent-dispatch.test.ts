import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseAgentDispatch } from '../presentation/agent-dispatch.js';
import { agentCliRoute } from '../presentation/agent-cli-options.js';
import { captureLifecycleTree } from '../infrastructure/agent-lifecycle-files.js';

const execute = promisify(execFile), entry = fileURLToPath(new URL('../presentation/agent-cli.js', import.meta.url));
const preloader = fileURLToPath(new URL('./helpers/agent-installation-home.js', import.meta.url));

test('dispatch parses only its header and retains opaque future options, terminators and literal text', () => {
  const inner = ['chat', 'ask', '--future-option=--directory', '--text=--help', '--', '--directory', '원문'];
  const args = ['dispatch', '--directory=./agent one', '--directory', './agent two', '--', ...inner], before = [...args];
  assert.deepEqual(parseAgentDispatch(args, '/cwd'), { directory: './agent two', args: inner });
  assert.deepEqual(args, before);
  assert.deepEqual(parseAgentDispatch(['dispatch', '--', 'status'], '/cwd'), { directory: '/cwd', args: ['status'] });
  assert.equal(parseAgentDispatch(['status', '--unknown'], '/cwd'), null);
  for (const invalid of [['dispatch'], ['dispatch', '--'], ['dispatch', '--directory'], ['dispatch', '--directory', '--', 'status'],
    ['dispatch', '--directory=', '--', 'status'], ['dispatch', '--unknown', '--', 'status'], ['dispatch', 'extra', '--', 'status']]) {
    assert.throws(() => parseAgentDispatch(invalid, '/cwd'), /engine_dispatch_(command_required|header_invalid)/);
  }
});

test('chosen-engine classification distinguishes parser errors and prohibited commands from parsed help', () => {
  for (const args of [['status', '--future'], ['chat', 'history', '--version'], ['unknown'], ['work', 'unknown'], ['memory-migrate'], ['status', '--', '--help']])
    assert.equal(agentCliRoute(args, '/agent').kind, 'invalid', JSON.stringify(args));
  for (const args of [['lifecycle', 'check'], ['repair'], ['clone'], ['dispatch', '--', 'status'], ['work', 'list', '--data-dir=/other']])
    assert.equal(agentCliRoute(args, '/agent').kind, 'bootstrap', JSON.stringify(args));
  for (const args of [['status', '--help'], ['--version'], ['chat'], ['chat', 'help'], ['work', 'help'], ['memory-migrate', 'help']])
    assert.equal(agentCliRoute(args, '/agent').kind, 'help', JSON.stringify(args));
  assert.deepEqual(agentCliRoute(['chat', 'ask', '--text=--help', '--message-id=--directory'], '/agent'), { kind: 'agent', directory: '/agent' });
  assert.deepEqual(agentCliRoute(['work', 'status', '--', '--directory'], '/agent'), { kind: 'agent', directory: '/agent' });
});

test('dispatch defaults every agent route to the outer root and refuses cross-root or management commands before data changes',
  { timeout: 90000, skip: process.platform === 'win32' ? 'Local POSIX process fixture; native Windows remains separate.' : false }, async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-dispatch-')));
    const home = join(base, 'home'), temporary = join(base, 'tmp');
    mkdirSync(home, { mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: temporary, LANG: 'C.UTF-8',
      NODE_OPTIONS: `--import=${pathToFileURL(preloader).href}`, SECUMON_INSTALLATION_HOME: home };
    const command = (args: string[]) => execute(process.execPath, [entry, ...args], { cwd: base, env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    const dispatch = (args: string[]) => command(['dispatch', '--directory', './selected agent', '--', ...args]);
    const json = async (args: string[]) => JSON.parse((await dispatch([...args, '--json'])).stdout) as Record<string, unknown>;
    const reject = (args: string[], code: string) => assert.rejects(dispatch(args), error => {
      const failure = error as Error & { code?: unknown; stderr?: string };
      assert.equal(failure.code, 1); assert.equal(failure.stderr?.trim(), code); return true;
    });
    try {
      const setup = await json(['init']); assert.equal(setup.status, 'ready');
      const identity = setup.identity as { agentId: string };
      assert.equal(setup.root, join(base, 'selected agent'));
      await command(['init', '--directory', './other agent', '--json']);
      const status = await json(['status', '--directory', './selected agent/.']);
      assert.deepEqual(status.identity, setup.identity);
      const chat = await json(['chat', 'session', '--provider', 'synthetic']);
      assert.equal((chat.session as { scope: { agentId: string } }).scope.agentId, identity.agentId);
      const work = await json(['work', 'session']);
      assert.equal((work.session as { scope: { agentId: string } }).scope.agentId, identity.agentId);
      const migration = await json(['memory-migrate', 'status']); assert.equal(migration.phase, 'not_started');
      assert.equal(existsSync(join(base, '.secumon')), false, 'the process cwd must not become a different agent');
      const before = captureLifecycleTree(base);
      await reject(['status', '--directory', './other agent'], 'engine_dispatch_directory_mismatch');
      await reject(['init', '--directory', './never-created'], 'engine_dispatch_directory_mismatch');
      for (const args of [['repair'], ['clone', '--destination', './clone'], ['lifecycle', 'status'], ['dispatch', '--', 'status'],
        ['work', 'list', '--data-dir', './standalone']]) await reject(args, 'engine_dispatch_command_not_supported');
      await reject(['status', '--new-engine-option'], 'agent_setup_failed');
      await reject(['status', '--', '--help'], 'agent_command_invalid');
      await reject(['chat', 'ask', '--text=--help', '--directory', './other agent'], 'engine_dispatch_directory_mismatch');
      assert.match((await dispatch(['status', '--help'])).stdout, /secumon-agent/);
      assert.ok((await json(['version'])).version);
      assert.deepEqual(captureLifecycleTree(base), before);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
