import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AgentProfileError } from '../application/agent-profile-contracts.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('./helpers/agent-profile-concurrency-worker.js', import.meta.url));
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-profile-concurrency-')));
  const engine = join(base, 'engine'); const root = join(base, 'agent');
  mkdirSync(engine, { mode: 0o700 }); mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(root, 'notes.md'), 'Synthetic existing user notes', { mode: 0o600 });
  return { base, engine, root, profiles: new FileAgentProfileStore(engine), close: () => rmSync(base, { recursive: true, force: true }) };
}
function tree(root: string) {
  const entries: Array<{ path: string; mode: number; sha256: string | null }> = [];
  const visit = (path: string, name: string) => {
    const stat = statSync(path); entries.push({ path: name, mode: stat.mode & 0o777,
      sha256: stat.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : null });
    if (stat.isDirectory()) for (const child of readdirSync(path).sort()) visit(join(path, child), name ? `${name}/${child}` : child);
  };
  visit(root, ''); return entries;
}
async function race(f: ReturnType<typeof fixture>, scenario: 'valid' | 'malformed' | 'mismatch') {
  const { stdout, stderr } = await execute(process.execPath, [worker, 'race', f.engine, f.root, scenario],
    { timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout); const diagnostics = JSON.stringify({ result, stderr });
  assert.equal(result.scenario, scenario, diagnostics); assert.equal(result.injections, 1, diagnostics);
  assert.equal(result.metadataAbsentAtBoundary, true, diagnostics);
  assert.equal(result.child?.status, 0, diagnostics); assert.equal(result.child?.signal, null, diagnostics);
  assert.equal(result.child?.error, null, diagnostics); assert.equal(result.child?.reply?.status, 'ready', diagnostics);
  assert.ok(result.publishedTree?.length > 0, diagnostics); assert.deepEqual(result.finalTree, result.publishedTree, diagnostics);
  assert.equal(readFileSync(join(f.root, 'notes.md'), 'utf8'), 'Synthetic existing user notes');
  return result;
}

test('initialization joins the same identity published after its first empty metadata observation', { timeout: 30000 }, async () => {
  const f = fixture(); try {
    const result = await race(f, 'valid');
    assert.equal(result.failure, null, JSON.stringify(result)); assert.equal(result.parent?.status, 'ready');
    assert.deepEqual(result.parent.identity, result.child.reply.identity);
    const reopened = f.profiles.inspect(f.root); assert.equal(reopened.status, 'ready');
    if (reopened.status !== 'ready') throw new Error('concurrent_profile_not_ready');
    assert.deepEqual(reopened.identity, result.child.reply.identity);
    assert.deepEqual(f.profiles.initialize(f.root).identity, reopened.identity);
  } finally { f.close(); }
});

for (const [scenario, code] of [['malformed', 'agent_metadata_invalid'], ['mismatch', 'agent_identity_mismatch']] as const) {
  test(`initialization reobserves ${scenario} metadata after a concurrent publication and refuses without replacement`, { timeout: 30000 }, async () => {
    const f = fixture(); try {
      const result = await race(f, scenario);
      assert.equal(result.parent, null); assert.equal(result.failure?.code, code, JSON.stringify(result));
      const before = tree(f.root);
      assert.throws(() => f.profiles.inspect(f.root), error => error instanceof AgentProfileError && error.code === code);
      assert.deepEqual(tree(f.root), before);
      if (scenario === 'malformed') assert.equal(readFileSync(join(f.root, 'config.json'), 'utf8'), '{synthetic-malformed-config');
      else assert.notEqual(JSON.parse(readFileSync(join(f.root, 'config.json'), 'utf8')).identity.agentId, result.child.reply.identity.agentId);
    } finally { f.close(); }
  });
}

test('reobserving genuinely unowned metadata or memory still refuses assignment and preserves every original file', () => {
  for (const location of ['.secumon', 'memory']) {
    const f = fixture(); try {
      const directory = join(f.root, location); mkdirSync(directory, { mode: 0o700 });
      writeFileSync(join(directory, 'work-history.json'), JSON.stringify({ workId: 'synthetic-previous-work', outcome: 'retained without owner' }), { mode: 0o600 });
      const before = tree(f.root); const status = f.profiles.inspect(f.root);
      assert.equal(status.status, 'incomplete'); if (status.status === 'incomplete') { assert.equal(status.agentId, null); assert.equal(status.recoverable, false); }
      for (const options of [{}, { repair: true }]) {
        assert.throws(() => f.profiles.initialize(f.root, options),
          error => error instanceof AgentProfileError && error.code === 'agent_recovery_source_required');
        assert.deepEqual(tree(f.root), before);
      }
    } finally { f.close(); }
  }
});
