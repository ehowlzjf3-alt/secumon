import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { command, initial } from './state-conformance-helpers.js';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('./helpers/agent-state-binding-worker.js', import.meta.url));
function fixture(backend: 'sqlite' | 'file-journal' = 'sqlite') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-binding-recovery-')));
  const engine = join(base, 'engine'); mkdirSync(engine, { mode: 0o700 });
  const profiles = new FileAgentProfileStore(engine); const initialized = profiles.initialize(join(base, 'agent'));
  writeFileSync(join(initialized.root, 'config.json'), JSON.stringify({ ...initialized.config, storage: { ...initialized.config.storage, state: backend } }));
  const profile = profiles.inspect(initialized.root); if (profile.status !== 'ready') throw new Error('not_ready');
  return { base, engine, profiles, profile, marker: join(profile.paths.metadata, 'state-profile.json'), close: () => rmSync(base, { recursive: true, force: true }) };
}
async function interrupt(f: ReturnType<typeof fixture>, phase: string) {
  const child = spawn(process.execPath, [worker, f.engine, f.profile.root, phase], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  const closed = new Promise<NodeJS.Signals | null>(resolve => child.once('close', (_code, signal) => resolve(signal)));
  child.stderr.on('data', data => { errors += String(data); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('checkpoint_timeout:' + errors)), 15000);
      child.stdout.on('data', data => { output += String(data); if (output.includes('checkpoint\n')) { clearTimeout(timer); resolve(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('early_exit:' + errors)); });
    });
  } finally { child.kill('SIGKILL'); await closed; }
  assert.equal(await closed, 'SIGKILL');
}

for (const backend of ['sqlite', 'file-journal'] as const) for (const phase of ['before-profile', 'published-profile']) {
  test(`${backend} initialization recovers after actual termination at ${phase}`, async () => {
    const f = fixture(backend); try {
      await interrupt(f, phase);
      assert.equal(existsSync(f.marker), phase === 'published-profile'); assert.equal(existsSync(f.profile.paths.state), false);
      if (phase === 'published-profile') assert.equal(statSync(f.marker).nlink, 2);
      const stores = await openAgentStores(f.profiles, f.profile.root);
      try { assert.equal((await stores.state.commit(command(initial('recovered'), 'create'))).kind, 'committed'); }
      finally { await stores.close(); }
      assert.deepEqual(JSON.parse(readFileSync(f.marker, 'utf8')), { schemaVersion: 1, agentId: f.profile.identity.agentId, stateBackend: backend });
      const reopened = await openAgentStores(f.profiles, f.profile.root);
      try { assert.equal((await reopened.state.get('recovered'))?.id, 'recovered'); } finally { await reopened.close(); }
    } finally { f.close(); }
  });
}
for (const phase of ['runtime.sqlite', 'memory.sqlite', 'channel.sqlite']) {
  test(`assignment permits recovery of the empty ${phase} left by actual termination`, async () => {
    const f = fixture(); try {
      await interrupt(f, phase); assert.equal(existsSync(f.marker), true);
      const path = phase === 'memory.sqlite' ? f.profile.paths.memory : join(f.profile.paths.metadata, phase);
      assert.equal(statSync(path).size, 0);
      const stores = await openAgentStores(f.profiles, f.profile.root); await stores.close();
      for (const [path, kind] of [[f.profile.paths.state, 'state'], [f.profile.paths.memory, 'memory'], [join(f.profile.paths.metadata, 'channel.sqlite'), 'channel']]) {
        const db = new DatabaseSync(path!, { readOnly: true });
        try { assert.equal(db.prepare('SELECT agent_id, kind FROM agent_storage_owner').get()?.['kind'], kind); }
        finally { db.close(); }
      }
    } finally { f.close(); }
  });
}
for (const kind of ['state', 'memory', 'channel']) {
  test(`an empty preexisting ${kind} database without assignment is not adopted`, async () => {
    const f = fixture(); try {
      const path = kind === 'state' ? f.profile.paths.state : kind === 'memory' ? f.profile.paths.memory : join(f.profile.paths.metadata, 'channel.sqlite');
      writeFileSync(path, '', { mode: 0o600 });
      await assert.rejects(openAgentStores(f.profiles, f.profile.root), /agent_storage_owner_missing/);
      assert.equal(existsSync(f.marker), false); assert.equal(statSync(path).size, 0);
    } finally { f.close(); }
  });
}
test('a valid assignment cannot adopt a database with unknown application data', async () => {
  const f = fixture(); try {
    await interrupt(f, 'runtime.sqlite');
    const db = new DatabaseSync(f.profile.paths.state); db.exec('CREATE TABLE private_data(value TEXT)'); db.close();
    const before = readFileSync(f.profile.paths.state);
    await assert.rejects(openAgentStores(f.profiles, f.profile.root), /agent_storage_owner_missing/);
    assert.deepEqual(readFileSync(f.profile.paths.state), before);
  } finally { f.close(); }
});
test('competing backend snapshots publish one choice and cannot create both stores', async () => {
  const f = fixture(); try {
    const outcomes = await Promise.allSettled(['sqlite', 'file-journal', 'sqlite', 'file-journal'].map(backend =>
      execute(process.execPath, [worker, f.engine, f.profile.root, 'none', backend], { timeout: 20000 })));
    const saved = JSON.parse(readFileSync(f.marker, 'utf8')); let successes = 0;
    for (const result of outcomes) {
      if (result.status === 'fulfilled') { successes++; assert.equal(JSON.parse(result.value.stdout).backend, saved.stateBackend); }
      else assert.match(String(result.reason), /agent_state_backend_mismatch/);
    }
    assert.ok(successes >= 1);
    assert.equal(existsSync(join(f.profile.paths.metadata, 'runtime.sqlite')), saved.stateBackend === 'sqlite');
    assert.equal(existsSync(join(f.profile.paths.metadata, 'state-journal')), saved.stateBackend === 'file-journal');
  } finally { f.close(); }
});
