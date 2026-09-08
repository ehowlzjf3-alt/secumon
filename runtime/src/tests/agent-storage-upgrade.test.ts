import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentBackup, EnginePin } from '../application/agent-lifecycle-contracts.js';
import type { AgentIdentity } from '../application/agent-profile-contracts.js';
import { captureLifecycleTree, lifecycleDigest } from '../infrastructure/agent-lifecycle-files.js';
import { resolveAgentEngine } from '../infrastructure/agent-engine-registry.js';
import { createEngineUpdateReleases } from './helpers/agent-engine-update-releases.js';
import type { RawKnowledge, StorageUpgradeRaw, StorageUpgradeSeed, StorageUpgradeSnapshot } from './helpers/agent-storage-upgrade-probe.js';

const execute = promisify(execFile), preloader = fileURLToPath(new URL('./helpers/agent-installation-home.js', import.meta.url));
const probe = fileURLToPath(new URL('./helpers/agent-storage-upgrade-probe.js', import.meta.url));
type Setup = { status: string; identity: AgentIdentity; engineVersion: string };
type Check = { agentId: string; pin: EnginePin; storage: { state: number; knowledge: number; session: number; sessionCompact: number | null } };
function legacyProjection(scoped: RawKnowledge): RawKnowledge {
  return Object.fromEntries(Object.entries(scoped).map(([name, rows]) => [name, rows.map(({ agent_id: _agent, partition: _partition, principal_id: _principal, audit_body, ...original }) => {
    if (name === 'receipts') assert.equal(audit_body, null); return original;
  })])) as RawKnowledge;
}

test('one installed A/B pair migrates known legacy SQLite layouts only on first selected CLI open and preserves original work custody',
  { timeout: 360000, skip: process.platform === 'win32' ? 'POSIX installed-runtime fixture; a macOS result does not establish Linux or native Windows behavior.' : false }, async t => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-storage-upgrade-'))), home = join(base, 'home'), temporary = join(base, 'tmp');
    mkdirSync(home, { mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: temporary, LANG: 'C.UTF-8',
      NODE_OPTIONS: `--import=${pathToFileURL(preloader).href}`, SECUMON_INSTALLATION_HOME: home };
    const json = async <T>(args: string[]): Promise<T> => JSON.parse((await execute(process.execPath, args,
      { cwd: base, env, timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 })).stdout) as T;
    try {
      // Both releases contain the real runtime. Only the private SQL fixture represents known old layouts, not an old binary.
      const { a, b, marker } = createEngineUpdateReleases(base), cli = <T>(args: string[]) => json<T>([a.command[1]!, ...args, '--json']);
      const bootstrapBytes = readFileSync(a.command[1]!);
      for (const version of [1, 2] as const) await t.test(`state ${version} and work-only knowledge 1 keep raw originals through backup, pin, migration and resume`, async () => {
        const directory = join(base, `agent-v${version}`), life = <T>(args: string[]) => cli<T>(['lifecycle', ...args, '--directory', directory]);
        const raw = () => json<StorageUpgradeRaw>([probe, a.directory, 'raw', directory]);
        const setup = await cli<Setup>(['init', '--directory', directory]); assert.equal(setup.status, 'ready');
        await life(['register', '--engine', b.directory, '--digest', b.release.digest]);
        const seed = await json<StorageUpgradeSeed>([probe, a.directory, 'seed', directory, String(version)]), before = seed.snapshot;
        assert.deepEqual(before.identity, setup.identity); assert.notEqual(before.state.status, 'completed');
        assert.equal(before.state.budget.used.modelCalls, 1); assert.equal(before.state.budget.used.toolCalls, 1);
        assert.equal(before.knowledge.card.kind, 'experience'); assert.equal(before.knowledge.card.owner, undefined);
        const observed = before.state.evidence.find(value => value.facts['retention.days'] === 30); assert.ok(observed);
        assert.ok(before.knowledge.dependency.sources.some(source => source.workId === before.state.id && source.type !== 'session_user_receipt' && source.evidenceId === observed.id));
        const old = seed.raw; assert.equal(old.state.version, version); assert.equal(old.knowledge.version, 1);
        assert.equal(old.knowledge.scoped, null); assert.ok(old.knowledge.legacy);
        assert.equal(old.knowledge.legacy.records.length, 1); assert.equal(old.knowledge.legacy.receipts.length, 1); assert.equal(old.knowledge.legacy.index.length, 1);
        assert.equal(old.knowledge.legacy.heads[0]?.['cursor'], 0); assert.equal(old.knowledge.legacy.heads[0]?.['error'], 'index_read_failed');
        assert.ok(String(old.knowledge.legacy.records[0]?.['body']).includes('\n  '));
        if (version === 1) { assert.equal(old.state.eventMetadata, null); assert.equal(old.state.conversationWork, null); }
        else {
          assert.deepEqual(old.state.eventMetadata, []); assert.deepEqual(old.state.conversationWork, []);
          assert.match(String(old.state.schema.find(row => row['name'] === 'works_query_update')?.['sql']), /SELECT 1/);
        }
        const originalPin = readFileSync(join(directory, '.secumon/engine-pins/00000001.json'));
        const checked = await life<Check>(['check', '--engine', b.directory]);
        assert.equal(checked.agentId, setup.identity.agentId); assert.equal(checked.storage.state, version); assert.equal(checked.storage.knowledge, 1); assert.equal(checked.storage.session, 1);
        assert.deepEqual(await raw(), old, 'lifecycle check is not the first writable migration');
        const backup = await life<{ directory: string; manifest: AgentBackup }>(['backup', '--destination', join(base, `backup-v${version}`), '--offline']);
        assert.equal(backup.manifest.agentId, setup.identity.agentId); assert.equal(backup.manifest.originalRoot, directory); assert.equal(backup.manifest.releaseDigest, a.release.digest);
        assert.deepEqual(captureLifecycleTree(join(backup.directory, 'data')), backup.manifest.entries);
        const backupTree = captureLifecycleTree(backup.directory); assert.deepEqual(await raw(), old);
        const updated = await life<{ pin: EnginePin; applied: boolean; recoveryRequired: boolean }>(['update', '--engine', b.directory,
          '--previous', a.release.digest, '--backup', backup.directory, '--offline']);
        assert.equal(updated.applied, true); assert.equal(updated.recoveryRequired, true); assert.equal(updated.pin.releaseDigest, b.release.digest);
        assert.equal(updated.pin.previous, lifecycleDigest(checked.pin)); assert.equal(updated.pin.backupDigest, backup.manifest.digest);
        assert.deepEqual(await raw(), old, 'pin publication preserves old SQLite versions and original cells');
        const selection = resolveAgentEngine(directory, a.directory, { registryDirectory: join(home, '.secumon/engines') });
        assert.deepEqual(selection, { directory: b.directory, releaseDigest: b.release.digest, source: 'registered' });
        const reopened = await cli<Setup>(['open', '--directory', directory]);
        assert.equal(reopened.engineVersion, b.release.version); assert.deepEqual(reopened.identity, before.identity);
        const migrated = await raw(); assert.equal(migrated.state.version, 3); assert.equal(migrated.knowledge.version, 2);
        assert.deepEqual(migrated.state.originals, old.state.originals); assert.deepEqual(migrated.state.owner, old.state.owner);
        assert.deepEqual(migrated.knowledge.owner, old.knowledge.owner); assert.deepEqual(migrated.knowledge.legacy, old.knowledge.legacy);
        assert.ok(migrated.knowledge.scoped); assert.deepEqual(legacyProjection(migrated.knowledge.scoped), old.knowledge.legacy);
        assert.deepEqual(migrated.knowledge.partitions, [{ agent_id: before.identity.agentId, partition: 'work', principal_id: '' }]);
        assert.deepEqual(migrated.channel, old.channel, 'session identity, inbox, retained heads and delivery originals are unchanged');
        assert.deepEqual(migrated.state.eventMetadata, before.events.map(event => ({ work_id: event.workId, sequence: event.sequence, revision: event.revision, type: event.type, at: event.at })));
        assert.ok(migrated.state.conversationWork?.some(row => row['work_id'] === before.state.id && row['conversation_id'] === 'storage-upgrade'));
        const snapshot = () => json<StorageUpgradeSnapshot>([probe, selection.directory, 'snapshot', directory, before.state.id]);
        assert.deepEqual(await snapshot(), before, 'first selected reopen changes storage layout only, with no model, tool or delivery replay');
        assert.deepEqual((await cli<Setup>(['open', '--directory', directory])).identity, before.identity);
        assert.deepEqual(await raw(), migrated); assert.deepEqual(await snapshot(), before, 'repeated reopen is idempotent');
        const result = await cli<{ workId: string; sessionId: string; snapshot: { status: string; usage: { modelCalls: number; toolCalls: number } }; messages: { kind: string; text: string }[] }>(
          ['chat', 'resume', '--directory', directory, '--provider', 'synthetic', '--conversation', 'storage-upgrade', '--work', before.state.id, '--session', before.sessionId]);
        assert.equal(result.workId, before.state.id); assert.equal(result.sessionId, before.sessionId); assert.equal(result.snapshot.status, 'completed');
        assert.equal(result.snapshot.usage.modelCalls, 2); assert.equal(result.snapshot.usage.toolCalls, 1);
        assert.ok(result.messages.some(value => value.kind === 'result' && value.text.includes(marker) && value.text.includes('30일')));
        const after = await snapshot(); assert.deepEqual(after.identity, before.identity); assert.deepEqual(after.hostIdentity, before.hostIdentity);
        assert.deepEqual(after.state.attempts, before.state.attempts); assert.deepEqual(after.state.evidence, before.state.evidence);
        assert.deepEqual(after.state.modelCalls[0], before.state.modelCalls[0]); assert.deepEqual(after.input, before.input); assert.deepEqual(after.knowledge.card, before.knowledge.card);
        for (const receipt of before.receipts) assert.deepEqual(after.receipts.find(value => value.commandId === receipt.commandId), receipt);
        for (const event of before.events) assert.deepEqual(after.events.find(value => value.sequence === event.sequence), event);
        for (const artifact of before.artifacts) assert.deepEqual(after.artifacts.find(value => value.ref.id === artifact.ref.id), artifact);
        for (const entry of before.history.entries) assert.deepEqual(after.history.entries.find(value => value.sequence === entry.sequence), entry);
        assert.equal(after.history.entries.filter(value => value.role === 'user').length, 1);
        assert.equal(after.deliveries.filter(value => value.kind === 'result' && value.status === 'delivered').length, 1);
        const completedRaw = await raw(); assert.deepEqual(completedRaw.knowledge, migrated.knowledge);
        for (const receipt of old.state.originals.receipts) assert.deepEqual(completedRaw.state.originals.receipts.find(value => value['work_id'] === receipt['work_id'] && value['command_id'] === receipt['command_id']), receipt);
        assert.deepEqual(readFileSync(join(directory, '.secumon/engine-pins/00000001.json')), originalPin);
        assert.deepEqual(captureLifecycleTree(backup.directory), backupTree); assert.deepEqual(readFileSync(a.command[1]!), bootstrapBytes);
      });
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
