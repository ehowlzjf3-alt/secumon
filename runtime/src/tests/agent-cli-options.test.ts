import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { agentCliOptions, agentLaunchDirectory, agentTurnCliOptions, localCliOptions, memoryMigrationCliOptions } from '../presentation/agent-cli-options.js';

const cwd = '/temporary/agent';

test('agent CLI shared options preserve route defaults and standalone work selection', () => {
  const setup = parseArgs({ args: [], strict: true, options: agentCliOptions(cwd) }).values;
  assert.equal(setup.directory, cwd); assert.equal(setup.json, false); assert.equal(setup.resume, undefined);
  const chat = parseArgs({ args: [], strict: true, options: agentTurnCliOptions(cwd) }).values;
  assert.equal(chat.directory, cwd); assert.equal(chat.conversation, 'terminal'); assert.equal(chat['new-session'], false);
  const work = parseArgs({ args: [], strict: true, options: localCliOptions() }).values;
  assert.equal(work.directory, undefined); assert.equal(work['data-dir'], undefined); assert.equal(work.conversation, 'terminal');
  assert.equal(work.limit, '50'); assert.equal(work.steps, '40'); assert.equal(work.scenario, 'documents-simple');
  assert.equal(work['analysis-only'], false); assert.equal(work['new-session'], false); assert.equal(work.json, false);
  const migration = parseArgs({ args: [], strict: true, options: memoryMigrationCliOptions(cwd) }).values;
  assert.equal(migration.directory, cwd); assert.equal(migration.json, undefined); assert.equal(migration['offline-confirmed'], undefined);
  assert.equal(agentCliOptions('/another/agent').directory.default, '/another/agent');
  assert.equal(agentCliOptions(cwd).directory.default, cwd);
});

test('agent launcher selects ordinary routes with the same directory option and last duplicate', () => {
  for (const route of [[], ['open'], ['init'], ['status'], ['chat', 'history'], ['work', 'list'], ['memory-migrate', 'status']]) {
    assert.equal(agentLaunchDirectory(route, cwd), cwd, JSON.stringify(route));
    const args = [...route, '--directory', '/first', '--directory=./selected agent'];
    const before = [...args];
    assert.equal(agentLaunchDirectory(args, cwd), './selected agent', JSON.stringify(route));
    assert.deepEqual(args, before);
  }
  const parsed = parseArgs({ args: ['--directory=/first', '--directory', '/last'], strict: true, options: agentCliOptions(cwd) });
  assert.equal(agentLaunchDirectory(['status', '--directory=/first', '--directory', '/last'], cwd), parsed.values.directory);
});

test('agent launcher uses parsed values rather than option-shaped text and token scanning', () => {
  for (const text of ['--directory', '--help', 'lifecycle', '--directory=/wrong']) {
    const args = ['chat', 'ask', `--text=${text}`, '--directory=/selected', '--provider=registered', '--message-id=request'];
    const parsed = parseArgs({ args: args.slice(1), allowPositionals: true, strict: true, options: agentTurnCliOptions(cwd) });
    assert.equal(parsed.values.text, text);
    assert.equal(agentLaunchDirectory(args, cwd), parsed.values.directory);
  }
  const ambiguous = ['chat', 'ask', '--text', '--directory', '/wrong'];
  assert.throws(() => parseArgs({ args: ambiguous.slice(1), allowPositionals: true, strict: true, options: agentTurnCliOptions(cwd) }));
  assert.equal(agentLaunchDirectory(ambiguous, cwd), null);
  assert.equal(agentLaunchDirectory(['work', 'input', 'work-id', '--text=--directory', '--directory=/selected'], cwd), '/selected');
});

test('agent launcher preserves option terminators and the CLI first-token route boundary', () => {
  assert.equal(agentLaunchDirectory(['--directory=/selected', '--', 'status'], cwd), '/selected');
  assert.equal(agentLaunchDirectory(['chat', '--directory=/selected', '--', 'history'], cwd), '/selected');
  assert.equal(agentLaunchDirectory(['work', 'status', '--', '--directory'], cwd), cwd);
  assert.equal(agentLaunchDirectory(['work', 'status', '--', '--directory', '/wrong'], cwd), null);
  assert.equal(agentLaunchDirectory(['status', '--', '--directory=/wrong'], cwd), null);
  assert.equal(agentLaunchDirectory(['--directory=/selected', 'chat', 'history'], cwd), null);
});

test('agent launcher leaves bootstrap management and invalid parsers to the existing CLI', () => {
  for (const args of [
    ['help'], ['version'], ['--version'], ['status', '--help'], ['init', '-h'], ['repair', '--directory=/selected'],
    ['clone', '--directory=/selected', '--destination=/copy'], ['lifecycle', 'pin', '--directory=/selected'],
    ['chat'], ['chat', 'help'], ['chat', 'ask', '-h'], ['work'], ['work', 'help'], ['memory-migrate', 'help'],
    ['status', '--unknown'], ['status', '--directory'], ['chat', 'history', '--version'], ['unknown-command'],
  ]) {
    const before = [...args];
    assert.equal(agentLaunchDirectory(args, cwd), null, JSON.stringify(args));
    assert.deepEqual(args, before);
  }
});

test('agent launcher does not adopt a standalone data directory as an agent root', () => {
  assert.equal(agentLaunchDirectory(['work', 'status', 'work-id', '--data-dir=/standalone'], cwd), null);
  assert.equal(agentLaunchDirectory(['work', 'status', 'work-id', '--state-backend=file-journal'], cwd), null);
  assert.equal(agentLaunchDirectory(['work', 'status', 'work-id', '--directory=/agent'], cwd), '/agent');
  // The original CLI still owns the explicit agent/standalone conflict check.
  assert.equal(agentLaunchDirectory(['work', 'status', 'work-id', '--directory=/agent', '--data-dir=/standalone'], cwd), '/agent');
});
