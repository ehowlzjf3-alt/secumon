import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, unlinkSync, readdirSync, symlinkSync, chmodSync, linkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('./helpers/agent-cli-isolated-worker.js', import.meta.url));
const binCli = fileURLToPath(new URL('../presentation/agent-cli.js', import.meta.url));
const cliEnvironment = (base: string) => ({ ...process.env, SECUMON_TEST_IDENTITY_REGISTRY: join(base, 'registry') });
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-profile-'))); const engine = join(base, 'engine'); mkdirSync(engine, { mode: 0o700 });
  return { base, engine, root: join(base, 'agent'), store: new FileAgentProfileStore(engine), close: () => rmSync(base, { recursive: true, force: true }) };
}
function put(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }

test('agent setup preserves files, creates private identity/config and reopens without a model', () => {
  const f = fixture();
  try {
    mkdirSync(f.root); writeFileSync(join(f.root, 'notes.md'), 'user notes');
    assert.deepEqual(f.store.inspect(f.root), { status: 'uninitialized', root: f.root });
    const result = f.store.initialize(f.root, { name: '자료 담당', purpose: '문서 정리' });
    assert.equal(result.config.name, '자료 담당'); assert.equal(result.config.storage.state, 'sqlite'); assert.equal(result.config.model, null);
    assert.deepEqual(result.config.features, { board: false, archive: false }); assert.equal(result.modelReady, false);
    assert.equal(readFileSync(join(f.root, 'notes.md'), 'utf8'), 'user notes');
    const before = readFileSync(join(f.root, 'config.json'), 'utf8'); assert.deepEqual(f.store.initialize(f.root), result);
    assert.equal(readFileSync(join(f.root, 'config.json'), 'utf8'), before);
    assert.throws(() => f.store.initialize(f.root, { name: '다른 이름' }), /agent_config_already_exists/);
  } finally { f.close(); }
});

test('status and invalid initialization options do not create files', () => {
  const f = fixture(); try {
    assert.equal(f.store.inspect(f.root).status, 'uninitialized');
    assert.throws(() => f.store.initialize(f.root, { name: '\u0000' }), /agent_setup_options_invalid/);
    assert.deepEqual(readdirSync(f.base), ['engine']);
  } finally { f.close(); }
});

test('separate directories get distinct IDs and moving a directory preserves its identity', () => {
  const f = fixture(); try {
    const first = f.store.initialize(f.root); const second = f.store.initialize(join(f.base, 'agent2'));
    assert.notEqual(first.identity.agentId, second.identity.agentId);
    const moved = join(f.base, 'moved'); renameSync(f.root, moved); const reopened = f.store.initialize(moved);
    assert.deepEqual(reopened.identity, first.identity); assert.equal(reopened.paths.root, moved);
    assert.equal(reopened.paths.memory, join(moved, 'memory', 'memory.sqlite'));
  } finally { f.close(); }
});

test('initialization can finish after a process stops between identity and config publication', () => {
  const f = fixture(); try {
    const first = f.store.initialize(f.root);
    unlinkSync(join(f.root, '.secumon', 'setup.json')); unlinkSync(join(f.root, 'config.json'));
    const partial = f.store.inspect(f.root); assert.equal(partial.status, 'incomplete');
    const restored = f.store.initialize(f.root); assert.deepEqual(restored.identity, first.identity);
  } finally { f.close(); }
});

test('missing identity uses explicit repair with the existing config; missing completed config is not reset', () => {
  const f = fixture(); try {
    const first = f.store.initialize(f.root, { name: 'custom', purpose: 'preserve me' });
    unlinkSync(join(f.root, '.secumon', 'identity.json'));
    assert.throws(() => f.store.initialize(f.root), /agent_repair_required/);
    const repaired = f.store.initialize(f.root, { repair: true }); assert.deepEqual(repaired.identity, first.identity); assert.deepEqual(repaired.config, first.config);
    unlinkSync(join(f.root, 'config.json')); assert.throws(() => f.store.initialize(f.root, { repair: true }), /agent_recovery_source_required/);
    assert.equal(f.store.inspect(f.root).status, 'incomplete');
  } finally { f.close(); }
});

test('completed layout repairs missing directories only with explicit repair and preserves existing state', () => {
  const f = fixture(); try {
    const first = f.store.initialize(f.root); writeFileSync(first.paths.state, 'state remains');
    rmSync(first.paths.skills, { recursive: true });
    assert.throws(() => f.store.initialize(f.root), /agent_repair_required/);
    const restored = f.store.initialize(f.root, { repair: true }); assert.deepEqual(restored.identity, first.identity);
    assert.equal(readFileSync(first.paths.state, 'utf8'), 'state remains');
  } finally { f.close(); }
});

test('unknown data without identity is not assigned a new ID', () => {
  const f = fixture(); try {
    mkdirSync(f.root); mkdirSync(join(f.root, '.secumon'), { mode: 0o700 }); put(join(f.root, '.secumon', 'runtime.sqlite'), { old: true });
    assert.throws(() => f.store.initialize(f.root, { repair: true }), /agent_recovery_source_required/);
    assert.deepEqual(readdirSync(join(f.root, '.secumon')), ['runtime.sqlite']);
  } finally { f.close(); }
});

test('config identity mismatch, unsupported versions and malformed documents are preserved', () => {
  const f = fixture(); try {
    const first = f.store.initialize(f.root); const path = join(f.root, 'config.json');
    put(path, { ...first.config, identity: { ...first.identity, agentId: '80f92e01-9661-4439-b4c6-e57f392c84c0' } });
    assert.throws(() => f.store.initialize(f.root, { repair: true }), /agent_identity_mismatch/);
    put(path, { ...first.config, schemaVersion: 3 }); assert.throws(() => f.store.inspect(f.root), /agent_schema_unsupported/);
    writeFileSync(path, '{malformed'); assert.throws(() => f.store.initialize(f.root, { repair: true }), /agent_metadata_invalid/);
    assert.equal(readFileSync(path, 'utf8'), '{malformed');
  } finally { f.close(); }
});

test('metadata symlinks and external hard links cannot be used for setup', () => {
  const f = fixture(); try {
    const first = f.store.initialize(f.root); const path = join(f.root, 'config.json'); const outside = join(f.base, 'outside.json');
    put(outside, first.config); unlinkSync(path); symlinkSync(outside, path);
    assert.throws(() => f.store.inspect(f.root), /agent_metadata_unsafe/); unlinkSync(path); linkSync(outside, path);
    assert.throws(() => f.store.inspect(f.root), /agent_metadata_unsafe/); assert.deepEqual(JSON.parse(readFileSync(outside, 'utf8')), first.config);
  } finally { f.close(); }
});

test('managed directory links and writable/public metadata are rejected without changing permissions', () => {
  const f = fixture(); try {
    const first = f.store.initialize(f.root); rmSync(first.paths.skills, { recursive: true }); symlinkSync(f.engine, first.paths.skills);
    assert.throws(() => f.store.inspect(f.root), /agent_directory_unsafe/); unlinkSync(first.paths.skills); mkdirSync(first.paths.skills, { mode: 0o700 });
    chmodSync(join(f.root, 'config.json'), 0o644); assert.throws(() => f.store.initialize(f.root), /agent_metadata_unsafe/);
  } finally { f.close(); }
});

test('engine overlap and nested agent registration are rejected', () => {
  const f = fixture(); try {
    assert.throws(() => f.store.initialize(f.engine), /agent_engine_overlap/);
    assert.throws(() => f.store.initialize(f.base), /agent_engine_overlap/);
    assert.throws(() => f.store.initialize(join(f.engine, 'child')), /agent_engine_overlap/);
    const first = f.store.initialize(f.root); assert.throws(() => f.store.initialize(join(first.paths.workspace, 'child')), /agent_nested_workspace/);
    assert.deepEqual(readdirSync(f.engine), []);
  } finally { f.close(); }
});

test('CLI first call, status, version and invalid commands expose readiness without claiming runtime execution', async () => {
  const f = fixture(); try {
    const status = JSON.parse((await execute(process.execPath, [cli, 'status', '--directory', f.root, '--json'], { env: cliEnvironment(f.base) })).stdout);
    assert.equal(status.status, 'uninitialized'); assert.deepEqual(readdirSync(f.base), ['engine']);
    const result = JSON.parse((await execute(process.execPath, [cli, '--directory', f.root, '--json'], { env: cliEnvironment(f.base) })).stdout);
    assert.equal(result.status, 'ready'); assert.equal(result.runtimeConnected, false); assert.equal(result.modelReady, false);
    const version = JSON.parse((await execute(process.execPath, [binCli, 'version', '--json'])).stdout); assert.equal(version.version, '0.1.0');
    await assert.rejects(execute(process.execPath, [cli, 'run', '--directory', f.root], { env: cliEnvironment(f.base) }), /agent_command_invalid/);
  } finally { f.close(); }
});

test('separate CLI processes initializing concurrently settle on exactly one identity', async () => {
  const f = fixture(); try {
    const settled = await Promise.allSettled(Array.from({ length: 8 }, () => execute(process.execPath, [cli, 'init', '--directory', f.root, '--json'], { timeout: 20000, env: cliEnvironment(f.base) })));
    const failures = settled.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'concurrent_initialization_failed\n' +
      failures.map(result => String(result.reason)).join('\n'));
    const replies = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    const ids = new Set(replies.map(r => JSON.parse(r.stdout).identity.agentId)); assert.equal(ids.size, 1);
    assert.equal(f.store.inspect(f.root).status, 'ready'); assert.equal(readdirSync(join(f.root, '.secumon')).filter(n => n.endsWith('.pending')).length, 0);
  } finally { f.close(); }
});
