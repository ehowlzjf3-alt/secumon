import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentIdentity } from '../application/agent-profile-contracts.js';
import type { EnginePin } from '../application/agent-lifecycle-contracts.js';
import { captureLifecycleTree } from '../infrastructure/agent-lifecycle-files.js';
import { inspectEngineRelease } from '../infrastructure/agent-engine-release.js';
import { resolveAgentEngine } from '../infrastructure/agent-engine-registry.js';
import { SYNTHETIC_AGENT_TURN_REQUESTS } from '../infrastructure/synthetic-agent-turn.js';
import { createEngineUpdateReleases } from './helpers/agent-engine-update-releases.js';
import type { EngineUpdateSnapshot } from './helpers/agent-engine-update-probe.js';

const execute = promisify(execFile), homePreloader = fileURLToPath(new URL('./helpers/agent-installation-home.js', import.meta.url));
const probe = fileURLToPath(new URL('./helpers/agent-engine-update-probe.js', import.meta.url));
type OpenResult = { status: string; identity: AgentIdentity; engineVersion: string };
type ChatResult = { workId: string; sessionId: string; snapshot: { status: string; usage: { modelCalls: number; toolCalls: number } };
  messages: { kind: string; text: string }[] };

test('one unchanged CLI entry selects each agent pinned registered engine, preserves the saved work on resume and refuses unregistered or modified installations',
  { timeout: 240000, skip: process.platform === 'win32' ? 'POSIX local process fixture; this run does not establish native Windows launcher behavior.' : false }, async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-engine-launcher-'))), left = join(base, 'updated-agent'), right = join(base, 'original-agent');
    const home = join(base, 'test-home'), temporary = join(base, 'tmp'); mkdirSync(home, { mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 });
    const registryDirectory = join(home, '.secumon', 'engines');
    const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: temporary, LANG: 'C.UTF-8',
      NODE_OPTIONS: `--import=${pathToFileURL(homePreloader).href}`, SECUMON_INSTALLATION_HOME: home };
    const command = (args: string[], cwd = base) => execute(process.execPath, args,
      { cwd, env, timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
    const json = async <T>(args: string[], cwd = base): Promise<T> => JSON.parse((await command(args, cwd)).stdout) as T;
    try {
      // One actual full A/B installation set; this test does not repeat npm or bundle installation acceptance.
      const { a, b, marker } = createEngineUpdateReleases(base), bootstrap = a.command[1]!;
      const cli = <T>(args: string[], cwd = base) => json<T>([bootstrap, ...args, '--json'], cwd);
      const life = <T>(directory: string, args: string[]) => cli<T>(['lifecycle', ...args, '--directory', directory]);
      const reject = async (args: string[], code: string) => assert.rejects(cli(args), error => {
        const outcome = error as Error & { code?: unknown; stderr?: string }; assert.equal(outcome.code, 1); assert.equal(outcome.stderr?.trim(), code); return true;
      });
      const selected = (directory: string) => resolveAgentEngine(directory, a.directory, { registryDirectory });
      const snapshot = async (original: EngineUpdateSnapshot) => {
        const selection = await selected(left);
        // A read-only probe imports only the resolver-selected engine. No product command is invoked using B's CLI path.
        return json<EngineUpdateSnapshot>([probe, selection.directory, 'snapshot', left, original.state.id, original.sourceState.id, original.sessionId]);
      };
      const bootstrapBytes = readFileSync(bootstrap), originalModule = readFileSync(join(a.directory, 'dist/infrastructure/synthetic-agent-turn.js'));
      const leftSetup = await cli<OpenResult>(['init', '--directory', left]), rightSetup = await cli<OpenResult>(['init', '--directory', right]);
      assert.equal(leftSetup.status, 'ready'); assert.equal(rightSetup.status, 'ready'); assert.notEqual(leftSetup.identity.agentId, rightSetup.identity.agentId);
      for (const directory of [left, right]) {
        const first = await life<{ pin: EnginePin; applied: boolean }>(directory, ['pin', '--engine', a.directory, '--offline']);
        assert.equal(first.applied, true); assert.equal(first.pin.releaseDigest, a.release.digest);
      }
      const before = await json<EngineUpdateSnapshot>([probe, a.directory, 'seed', left]);
      assert.deepEqual(before.identity, leftSetup.identity); assert.notEqual(before.state.status, 'completed');
      assert.equal(before.state.budget.used.modelCalls, 1); assert.equal(before.state.budget.used.toolCalls, 1);
      const backup = await life<{ directory: string }>(left, ['backup', '--destination', join(base, 'backup'), '--offline']);
      const update = await life<{ pin: EnginePin; applied: boolean }>(left,
        ['update', '--engine', b.directory, '--previous', a.release.digest, '--backup', backup.directory, '--offline']);
      assert.equal(update.applied, true); assert.equal(update.pin.releaseDigest, b.release.digest);
      const unregisteredTree = captureLifecycleTree(left);
      await reject(['open', '--directory', left], 'engine_installation_unregistered');
      await assert.rejects(async () => selected(left), /^Error: engine_installation_unregistered$/);
      assert.deepEqual(captureLifecycleTree(left), unregisteredTree, 'selection failure must not open or modify the agent stores');
      const registration = await life<{ registryDirectory: string; published: boolean }>(left,
        ['register', '--engine', b.directory, '--digest', b.release.digest]);
      assert.equal(registration.registryDirectory, registryDirectory); assert.equal(registration.published, true);
      const selection = await selected(left); assert.equal(selection.directory, b.directory); assert.equal(selection.source, 'registered'); assert.equal(selection.releaseDigest, b.release.digest);
      const stillA = await selected(right); assert.equal(stillA.directory, a.directory); assert.equal(stillA.source, 'current'); assert.equal(stillA.releaseDigest, a.release.digest);
      const reopened = await cli<OpenResult>(['open', '--directory', left]);
      assert.equal(reopened.engineVersion, b.release.version); assert.deepEqual(reopened.identity, before.identity);
      assert.deepEqual(await snapshot(before), before, 'the same A entry routes a read-only reopen to B without changing saved work or memory');
      const cwdStatus = await cli<OpenResult>(['status'], left); assert.equal(cwdStatus.engineVersion, b.release.version); assert.deepEqual(cwdStatus.identity, before.identity);
      assert.equal((await cli<{ version: string }>(['version', '--directory', left])).version, a.release.version, 'bootstrap version remains an administrative command');
      const resumed = await cli<ChatResult>(['chat', 'resume', '--directory', left, '--provider', 'synthetic', '--conversation', 'engine-update',
        '--work', before.state.id, '--session', before.sessionId]);
      assert.equal(resumed.workId, before.state.id); assert.equal(resumed.sessionId, before.sessionId); assert.equal(resumed.snapshot.status, 'completed');
      assert.equal(resumed.snapshot.usage.modelCalls, 2); assert.equal(resumed.snapshot.usage.toolCalls, 1);
      assert.ok(resumed.messages.some(value => value.kind === 'result' && value.text.includes(marker) && value.text.includes('30일')));
      const after = await snapshot(before);
      assert.deepEqual(after.identity, before.identity); assert.deepEqual(after.hostIdentity, before.hostIdentity); assert.deepEqual(after.input, before.input);
      assert.deepEqual(after.memory, before.memory); assert.deepEqual(after.sourceState, before.sourceState); assert.deepEqual(after.sourceReceipt, before.sourceReceipt);
      assert.deepEqual(after.state.attempts, before.state.attempts); assert.deepEqual(after.state.modelCalls[0], before.state.modelCalls[0]);
      for (const receipt of before.receipts) assert.deepEqual(after.receipts.find(value => value.commandId === receipt.commandId), receipt);
      for (const artifact of before.artifacts) assert.deepEqual(after.artifacts.find(value => value.ref.id === artifact.ref.id), artifact);
      const originalAgent = await cli<OpenResult>(['open', '--directory', right]); assert.equal(originalAgent.engineVersion, a.release.version);
      assert.deepEqual(originalAgent.identity, rightSetup.identity);
      const originalAnswer = await cli<ChatResult>(['chat', 'ask', '--directory', right, '--provider', 'synthetic', '--message-id', 'stay-on-a',
        '--text', SYNTHETIC_AGENT_TURN_REQUESTS.rewrite]);
      assert.equal(originalAnswer.snapshot.status, 'completed');
      assert.ok(originalAnswer.messages.some(value => value.kind === 'result' && value.text.includes('[합성 규칙 결과]') && !value.text.includes(marker)));
      const target = join(b.directory, 'dist/infrastructure/synthetic-agent-turn.js'), originalBytes = readFileSync(target);
      const leftTree = captureLifecycleTree(left), rightTree = captureLifecycleTree(right), registryTree = captureLifecycleTree(home);
      try {
        // Only B's private test installation is damaged; restore its exact original bytes even if the expected rejection fails.
        writeFileSync(target, Buffer.concat([originalBytes, Buffer.from('\n// Deliberate installed-release digest mismatch.\n')]), { mode: 0o600 });
        await reject(['open', '--directory', left], 'engine_release_files_changed');
        await assert.rejects(async () => selected(left), /^Error: engine_release_files_changed$/);
        assert.deepEqual(captureLifecycleTree(left), leftTree); assert.deepEqual(captureLifecycleTree(right), rightTree); assert.deepEqual(captureLifecycleTree(home), registryTree);
        assert.equal((await cli<OpenResult>(['status', '--directory', right])).engineVersion, a.release.version);
      } finally { writeFileSync(target, originalBytes, { mode: 0o600 }); }
      assert.equal(inspectEngineRelease(b.directory).digest, b.release.digest); assert.equal(inspectEngineRelease(a.directory).digest, a.release.digest);
      assert.deepEqual(readFileSync(bootstrap), bootstrapBytes); assert.deepEqual(readFileSync(join(a.directory, 'dist/infrastructure/synthetic-agent-turn.js')), originalModule);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
