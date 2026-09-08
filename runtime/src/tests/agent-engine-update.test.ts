import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentBackup, EnginePin, EngineRelease } from '../application/agent-lifecycle-contracts.js';
import type { AgentIdentity } from '../application/agent-profile-contracts.js';
import { captureLifecycleTree, lifecycleDigest } from '../infrastructure/agent-lifecycle-files.js';
import { createEngineUpdateReleases } from './helpers/agent-engine-update-releases.js';
import type { EngineUpdateSnapshot } from './helpers/agent-engine-update-probe.js';

const execute = promisify(execFile), homePreloader = fileURLToPath(new URL('./helpers/agent-installation-home.js', import.meta.url));
const probe = fileURLToPath(new URL('./helpers/agent-engine-update-probe.js', import.meta.url));
type Setup = { status: string; identity: AgentIdentity; storageInitialized: boolean; runtimeConnected: boolean };
type PinResult = { pin: EnginePin; applied: boolean; recoveryRequired: boolean };
type CheckResult = { agentId: string; release: EngineRelease; pin: EnginePin | null; storage: { stateBackend: string; personalMemory: string } };

test('compatible full offline engine releases update an existing SQLite agent and resume its original adopted read with identity, session, memory and receipts preserved',
  { timeout: 240000, skip: process.platform === 'win32' ? 'POSIX installed-engine CLI fixture; native Windows and Linux execution are not inferred from a macOS run.' : false }, async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-engine-update-'))), directory = join(base, 'agent'), home = join(base, 'test-home'), temporary = join(base, 'tmp');
    mkdirSync(home, { mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: temporary, LANG: 'C.UTF-8',
      NODE_OPTIONS: `--import=${pathToFileURL(homePreloader).href}`, SECUMON_INSTALLATION_HOME: home };
    const command = (args: string[]) => execute(process.execPath, args, { cwd: base, env, timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
    const json = async <T>(args: string[]): Promise<T> => JSON.parse((await command(args)).stdout) as T;
    try {
      const releases = createEngineUpdateReleases(base), { a, b } = releases;
      const cli = <T>(engine: typeof a, args: string[]) => json<T>([engine.command[1]!, ...args, '--json']);
      const life = <T>(engine: typeof a, args: string[]) => cli<T>(engine, ['lifecycle', ...args, '--directory', directory]);
      const snapshot = (engine: typeof a, before: EngineUpdateSnapshot) => json<EngineUpdateSnapshot>([probe, engine.directory, 'snapshot', directory,
        before.state.id, before.sourceState.id, before.sessionId]);
      const rejectCli = async (engine: typeof a, args: string[], code: string) => assert.rejects(cli(engine, args), error => {
        const result = error as Error & { code?: unknown; stderr?: string }; assert.equal(result.code, 1); assert.equal(result.stderr?.trim(), code); return true;
      });
      for (const engine of [a, b]) {
        assert.equal((await cli<{ version: string }>(engine, ['version'])).version, engine.release.version);
        const pkg = JSON.parse(readFileSync(join(engine.directory, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
        const installed = createRequire(join(engine.directory, 'package.json'));
        for (const name of Object.keys(pkg.dependencies)) assert.ok(installed.resolve(name).startsWith(engine.directory + '/'), name);
      }
      const setup = await cli<Setup>(a, ['init', '--directory', directory, '--name', 'engine update owner']);
      assert.equal(setup.status, 'ready'); assert.equal(setup.storageInitialized, true); assert.equal(setup.runtimeConnected, false);
      const checked = await life<CheckResult>(a, ['check', '--engine', a.directory]);
      assert.equal(checked.agentId, setup.identity.agentId); assert.equal(checked.pin, null);
      assert.equal(checked.storage.stateBackend, 'sqlite'); assert.equal(checked.storage.personalMemory, 'sqlite');
      const first = await life<PinResult>(a, ['pin', '--engine', a.directory, '--offline']);
      assert.equal(first.applied, true); assert.equal(first.pin.sequence, 1); assert.equal(first.pin.previous, null); assert.equal(first.pin.backupDigest, null);
      const before = await json<EngineUpdateSnapshot>([probe, a.directory, 'seed', directory]);
      assert.deepEqual(before.identity, setup.identity); assert.equal(before.state.budget.used.modelCalls, 1); assert.equal(before.state.budget.used.toolCalls, 1);
      assert.equal(before.sourceState.budget.used.modelCalls + before.sourceState.budget.used.toolCalls, 0);
      assert.equal(before.memory.card.body, '업데이트 뒤에도 답변에 원문 출처를 함께 표시해 주세요.');
      assert.equal(before.memory.card.owner?.agentId, setup.identity.agentId); assert.equal(before.memory.card.revision, 1);
      const attempt = before.state.attempts[0]; assert.ok(attempt?.adopted); assert.ok(attempt.resultArtifact);
      for (const commandId of ['conversation.accept', `dispatch:${attempt.id}`, `receive:${attempt.id}`, `adopt:${attempt.id}`])
        assert.ok(before.receipts.some(value => value.commandId === commandId), commandId);
      const note = Buffer.from('엔진 업데이트와 별개로 유지할 담당 원자료.\n'); writeFileSync(join(directory, 'operator-note.txt'), note, { mode: 0o600 });
      const registryTree = captureLifecycleTree(home), originalPin = readFileSync(join(directory, '.secumon', 'engine-pins', '00000001.json'));
      const compatibleB = await life<CheckResult>(a, ['check', '--engine', b.directory]); assert.equal(compatibleB.release.digest, b.release.digest);
      assert.deepEqual(compatibleB.pin, first.pin);
      const backup = await life<{ directory: string; manifest: AgentBackup; recoveryRequired: boolean }>(a,
        ['backup', '--destination', join(base, 'backup-a'), '--offline']);
      assert.equal(backup.recoveryRequired, true); assert.equal(backup.manifest.releaseDigest, a.release.digest);
      assert.equal(backup.manifest.agentId, setup.identity.agentId); assert.equal(backup.manifest.originalRoot, directory);
      assert.deepEqual(captureLifecycleTree(join(backup.directory, 'data')), backup.manifest.entries);
      const backupTree = captureLifecycleTree(backup.directory), agentTree = captureLifecycleTree(directory);
      await rejectCli(a, ['lifecycle', 'update', '--directory', directory, '--engine', b.directory, '--previous', '0'.repeat(64), '--backup', backup.directory, '--offline'], 'engine_pin_conflict');
      assert.deepEqual(captureLifecycleTree(directory), agentTree);
      const updated = await life<PinResult>(a, ['update', '--engine', b.directory, '--previous', a.release.digest, '--backup', backup.directory, '--offline']);
      assert.equal(updated.applied, true); assert.equal(updated.recoveryRequired, true); assert.equal(updated.pin.sequence, 2);
      assert.equal(updated.pin.releaseDigest, b.release.digest); assert.equal(updated.pin.engineDirectory, b.directory);
      assert.equal(updated.pin.previous, lifecycleDigest(first.pin)); assert.equal(updated.pin.backupDigest, backup.manifest.digest);
      assert.deepEqual(readFileSync(join(directory, '.secumon', 'engine-pins', '00000001.json')), originalPin);
      assert.deepEqual(captureLifecycleTree(home), registryTree); assert.deepEqual(captureLifecycleTree(backup.directory), backupTree);
      const pinnedTree = captureLifecycleTree(directory);
      const duplicate = await life<PinResult>(b, ['update', '--engine', b.directory, '--previous', b.release.digest, '--backup', backup.directory, '--offline']);
      assert.equal(duplicate.applied, false); assert.deepEqual(duplicate.pin, updated.pin); assert.deepEqual(captureLifecycleTree(directory), pinnedTree);
      await rejectCli(a, ['open', '--directory', directory], 'engine_installation_unregistered');
      const reopened = await cli<Setup>(b, ['open', '--directory', directory]); assert.deepEqual(reopened.identity, setup.identity);
      assert.deepEqual(await snapshot(b, before), before, 'installed B reopens all original ledgers without executing the unfinished work');
      const resumed = await cli<{ workId: string; sessionId: string; snapshot: { status: string; usage: { modelCalls: number; toolCalls: number } }; messages: { kind: string; text: string }[] }>(b,
        ['chat', 'resume', '--directory', directory, '--provider', 'synthetic', '--conversation', 'engine-update', '--work', before.state.id, '--session', before.sessionId]);
      assert.equal(resumed.workId, before.state.id); assert.equal(resumed.sessionId, before.sessionId); assert.equal(resumed.snapshot.status, 'completed');
      assert.equal(resumed.snapshot.usage.modelCalls, 2); assert.equal(resumed.snapshot.usage.toolCalls, 1);
      assert.ok(resumed.messages.some(value => value.kind === 'result' && value.text.includes(releases.marker) && value.text.includes('30일')),
        'the final answer must run B executable code while using the original A read');
      const after = await snapshot(b, before);
      assert.deepEqual(after.identity, before.identity); assert.deepEqual(after.hostIdentity, before.hostIdentity);
      assert.deepEqual(after.state.goal, before.state.goal); assert.deepEqual(after.state.policy, before.state.policy); assert.deepEqual(after.state.budget.limits, before.state.budget.limits);
      assert.deepEqual(after.state.attempts, before.state.attempts); assert.deepEqual(after.state.modelCalls[0], before.state.modelCalls[0]);
      assert.deepEqual(after.state.evidence, before.state.evidence); assert.deepEqual(after.sourceState, before.sourceState);
      assert.deepEqual(after.input, before.input); assert.deepEqual(after.sourceInput, before.sourceInput); assert.deepEqual(after.sourceReceipt, before.sourceReceipt);
      assert.deepEqual(after.memory, before.memory); assert.equal(after.state.budget.used.tokens, before.state.budget.used.tokens);
      for (const receipt of before.receipts) assert.deepEqual(after.receipts.find(value => value.commandId === receipt.commandId), receipt);
      for (const event of before.events) assert.deepEqual(after.events.find(value => value.sequence === event.sequence), event);
      for (const artifact of before.artifacts) assert.deepEqual(after.artifacts.find(value => value.ref.id === artifact.ref.id), artifact);
      for (const entry of before.history.entries) assert.deepEqual(after.history.entries.find(value => value.sequence === entry.sequence), entry);
      assert.equal(after.history.entries.filter(value => value.role === 'user').length, 2);
      assert.equal(after.deliveries.filter(value => value.kind === 'result' && value.status === 'delivered').length, 1);
      assert.deepEqual(readFileSync(join(directory, 'operator-note.txt')), note);
      assert.deepEqual(captureLifecycleTree(backup.directory), backupTree); assert.deepEqual(captureLifecycleTree(home), registryTree);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
