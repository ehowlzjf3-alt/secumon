import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { AgentSetupReceiptSchema } from '../application/agent-profile-contracts.js';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('./helpers/agent-clone-worker.js', import.meta.url));
const cli = fileURLToPath(new URL('../presentation/agent-cli.js', import.meta.url));
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-clone-recovery-')));
  const engine = join(base, 'engine'); mkdirSync(engine, { mode: 0o700 });
  const profiles = new FileAgentProfileStore(engine); const source = profiles.initialize(join(base, 'source'));
  writeFileSync(join(source.paths.skills, 'lesson.md'), 'original skill', { mode: 0o600 });
  return { base, engine, profiles, source, target: join(base, 'target'), close: () => rmSync(base, { recursive: true, force: true }) };
}
async function interrupt(f: ReturnType<typeof fixture>, phase: string, command = 'clone') {
  const child = spawn(process.execPath, [worker, f.engine, f.source.root, f.target, phase, command], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  child.stderr.on('data', data => { errors += String(data); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('checkpoint_timeout: ' + errors)), 15000);
      child.stdout.on('data', data => { output += String(data); if (output.includes('checkpoint\n')) { clearTimeout(timer); resolve(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('worker_early_exit: ' + errors)); });
    });
  } finally { child.kill('SIGKILL'); await closed; }
  assert.equal((await closed).signal, 'SIGKILL');
}

for (const phase of ['setup-operation.json', 'setup.json', 'identity.json', 'config.json', 'skill', 'before-complete']) {
  test(`clone resumes with one identity after actual process termination at ${phase}`, async () => {
    const f = fixture(); try {
      await interrupt(f, phase);
      const partial = f.profiles.inspect(f.target); assert.equal(partial.status, 'incomplete');
      if (partial.status !== 'incomplete') throw new Error('expected_incomplete');
      assert.equal(partial.recovery, 'clone'); assert.notEqual(partial.agentId, f.source.identity.agentId);
      for (const repair of [false, true]) assert.throws(() => f.profiles.initialize(f.target, { repair }), /agent_clone_resume_required/);
      const recovered = f.profiles.clone(f.source.root, f.target, { resume: true });
      assert.equal(recovered.identity.agentId, partial.agentId);
      assert.equal(readFileSync(join(recovered.paths.skills, 'lesson.md'), 'utf8'), 'original skill');
      assert.deepEqual(readdirSync(join(recovered.root, 'memory')), []);
      assert.deepEqual(f.profiles.clone(f.source.root, f.target, { resume: true }), recovered);
    } finally { f.close(); }
  });
}

test('a published completion survives process termination and later source/skill edits do not trigger recopy', async () => {
  const f = fixture(); try {
    await interrupt(f, 'clone-complete.json');
    const ready = f.profiles.inspect(f.target); assert.equal(ready.status, 'ready');
    if (ready.status !== 'ready') throw new Error('expected_ready');
    writeFileSync(join(ready.paths.skills, 'lesson.md'), 'independent edit');
    writeFileSync(join(f.source.paths.skills, 'lesson.md'), 'source evolved');
    assert.equal(f.profiles.clone(f.source.root, f.target, { resume: true }).identity.agentId, ready.identity.agentId);
    assert.equal(readFileSync(join(ready.paths.skills, 'lesson.md'), 'utf8'), 'independent edit');
    assert.equal(AgentSetupReceiptSchema.safeParse(JSON.parse(readFileSync(join(ready.paths.metadata, 'setup.json'), 'utf8'))).success, false);
  } finally { f.close(); }
});

test('source changes and target conflicts are preserved during explicit clone resume', async () => {
  const f = fixture(); try {
    await interrupt(f, 'skill');
    const identity = f.profiles.inspect(f.target);
    writeFileSync(join(f.source.paths.skills, 'lesson.md'), 'changed source');
    assert.throws(() => f.profiles.clone(f.source.root, f.target, { resume: true }), /agent_clone_source_changed/);
    writeFileSync(join(f.source.paths.skills, 'lesson.md'), 'original skill');
    // Replace the target inode, avoiding mutation of the interrupted publisher's pending link.
    const targetFile = join(f.target, 'skills', 'lesson.md'); unlinkSync(targetFile); writeFileSync(targetFile, 'target edit', { mode: 0o600 });
    assert.throws(() => f.profiles.clone(f.source.root, f.target, { resume: true }), /agent_clone_target_conflict/);
    assert.equal(readFileSync(targetFile, 'utf8'), 'target edit'); assert.deepEqual(f.profiles.inspect(f.target), identity);
  } finally { f.close(); }
});

test('pending clone blocks nested setup and CLI repair explains explicit clone resume', async () => {
  const f = fixture(); try {
    await interrupt(f, 'setup-operation.json');
    const status = JSON.parse((await execute(process.execPath, [cli, 'status', '--directory', f.target, '--json'])).stdout);
    assert.equal(status.recovery, 'clone');
    await assert.rejects(execute(process.execPath, [cli, 'repair', '--directory', f.target]), /agent_clone_resume_required/);
    mkdirSync(join(f.target, 'workspace'), { mode: 0o700 });
    assert.throws(() => f.profiles.initialize(join(f.target, 'workspace', 'nested')), /agent_nested_workspace/);
    const resumed = JSON.parse((await execute(process.execPath, [cli, 'clone', '--directory', f.source.root, '--destination', f.target, '--resume', '--json'])).stdout);
    assert.equal(resumed.status, 'ready'); assert.equal(resumed.storageInitialized, true);
  } finally { f.close(); }
});

test('general initialization keeps its selected identity after interruption at the operation marker', async () => {
  const f = fixture(); try {
    await interrupt(f, 'setup-operation.json', 'initialize');
    const partial = f.profiles.inspect(f.target); assert.equal(partial.status, 'incomplete');
    if (partial.status !== 'incomplete') throw new Error('expected_incomplete');
    assert.equal(f.profiles.initialize(f.target).identity.agentId, partial.agentId);
  } finally { f.close(); }
});

test('competing clone commands never assign two identities to the same destination', async () => {
  const f = fixture(); try {
    const replies = await Promise.allSettled(Array.from({ length: 4 }, () => execute(process.execPath, [worker, f.engine, f.source.root, f.target, 'none'], { timeout: 20000 })));
    assert.equal(replies.filter(item => item.status === 'fulfilled').length, 1);
    const result = f.profiles.inspect(f.target); assert.equal(result.status, 'ready');
    for (const item of replies) if (item.status === 'rejected') assert.match(String(item.reason), /agent_clone_target_exists/);
  } finally { f.close(); }
});

test('initialization and clone contention leave a single coherent ready profile', async () => {
  const f = fixture(); try {
    const replies = await Promise.allSettled(['initialize', 'clone'].map(command => execute(process.execPath, [worker, f.engine, f.source.root, f.target, 'none', command], { timeout: 20000 })));
    assert.ok(replies.some(item => item.status === 'fulfilled'));
    const result = f.profiles.inspect(f.target); assert.equal(result.status, 'ready');
    if (result.status !== 'ready') throw new Error('expected_ready');
    for (const item of replies) if (item.status === 'fulfilled') assert.equal(JSON.parse(item.value.stdout).identity.agentId, result.identity.agentId);
  } finally { f.close(); }
});

test('a target config changed during skill publication cannot be marked clone-complete', async () => {
  const f = fixture(); try {
    await assert.rejects(execute(process.execPath, [worker, f.engine, f.source.root, f.target, 'change-target-config'], { timeout: 15000 }), /agent_clone_target_conflict/);
    assert.equal(JSON.parse(readFileSync(join(f.target, 'config.json'), 'utf8')).name, 'changed during copy');
    assert.equal(existsSync(join(f.target, '.secumon', 'clone-complete.json')), false);
    assert.equal(f.profiles.inspect(f.target).status, 'incomplete');
  } finally { f.close(); }
});

test('legacy v1 setup without an operation marker reopens untouched and repairs with its existing identity', () => {
  const f = fixture(); try {
    const marker = join(f.source.paths.metadata, 'setup-operation.json'); unlinkSync(marker);
    const beforeConfig = readFileSync(join(f.source.root, 'config.json'));
    const beforeReceipt = readFileSync(join(f.source.paths.metadata, 'setup.json'));
    assert.deepEqual(f.profiles.initialize(f.source.root).identity, f.source.identity); assert.equal(existsSync(marker), false);
    unlinkSync(join(f.source.paths.metadata, 'identity.json'));
    assert.throws(() => f.profiles.initialize(f.source.root), /agent_repair_required/);
    assert.deepEqual(f.profiles.initialize(f.source.root, { repair: true }).identity, f.source.identity);
    assert.deepEqual(readFileSync(join(f.source.root, 'config.json')), beforeConfig);
    assert.deepEqual(readFileSync(join(f.source.paths.metadata, 'setup.json')), beforeReceipt);
  } finally { f.close(); }
});

test('pending filenames cannot hide data in clone memory, workspace or artifact directories', () => {
  for (const area of ['memory', 'workspace', '.secumon/artifacts']) {
    const f = fixture(); try {
      f.profiles.clone(f.source.root, f.target);
      unlinkSync(join(f.target, '.secumon', 'clone-complete.json'));
      const path = join(f.target, ...area.split('/'), '.secumon-init-11111111-1111-1111-1111-111111111111.pending');
      writeFileSync(path, 'Existing data must remain visible as a conflict', { mode: 0o600 });
      assert.throws(() => f.profiles.clone(f.source.root, f.target, { resume: true }), /agent_clone_target_conflict/);
      assert.equal(readFileSync(path, 'utf8'), 'Existing data must remain visible as a conflict');
      assert.equal(existsSync(join(f.target, '.secumon', 'clone-complete.json')), false);
    } finally { f.close(); }
  }
});

for (const limit of ['entries', 'bytes']) {
  test(`one interrupted publication at the ${limit} boundary can resume with its safe pending file`, async () => {
    const f = fixture(); try {
      unlinkSync(join(f.source.paths.skills, 'lesson.md'));
      const bytes = limit === 'entries' ? Buffer.from('skill') : Buffer.alloc(4 * 1024 * 1024, 7);
      const count = limit === 'entries' ? 512 : 8;
      for (let index = 0; index < count; index += 1) writeFileSync(join(f.source.paths.skills, `${index}.bin`), bytes, { mode: 0o600 });
      await interrupt(f, 'skill');
      const result = f.profiles.clone(f.source.root, f.target, { resume: true });
      assert.equal(result.status, 'ready');
      assert.equal(readdirSync(result.paths.skills).filter(file => !file.endsWith('.pending')).length, count);
      assert.deepEqual(readFileSync(join(result.paths.skills, '0.bin')), bytes);
    } finally { f.close(); }
  });
}
