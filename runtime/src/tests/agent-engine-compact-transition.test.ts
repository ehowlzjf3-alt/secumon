import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EnginePin } from '../application/agent-lifecycle-contracts.js';
import type { AgentIdentity } from '../application/agent-profile-contracts.js';
import { captureLifecycleTree } from '../infrastructure/agent-lifecycle-files.js';
import { resolveAgentEngine } from '../infrastructure/agent-engine-registry.js';
import { inspectEngineRelease } from '../infrastructure/agent-engine-release.js';
import { SYNTHETIC_AGENT_TURN_REQUESTS as requests, SYNTHETIC_AGENT_TURN_CORRECTION } from '../infrastructure/synthetic-agent-turn.js';
import { createEngineUpdateReleases } from './helpers/agent-engine-update-releases.js';
import type { EngineCompactSnapshot } from './helpers/agent-engine-compact-probe.js';

const execute = promisify(execFile), preloader = fileURLToPath(new URL('./helpers/agent-installation-home.js', import.meta.url));
const probe = fileURLToPath(new URL('./helpers/agent-engine-compact-probe.js', import.meta.url));
type Status = { status: string; identity: AgentIdentity; engineVersion: string; fixtureEngineNote?: string };
type Turn = { sessionId: string; workId: string; snapshot: { status: string; usage: { modelCalls: number; toolCalls: number };
  pendingQuestions: { id: string }[] }; messages: { kind: string; text: string }[] };
function customizeCandidate(directory: string) {
  const optionsPath = join(directory, 'dist/presentation/agent-cli-options.js'), cliPath = join(directory, 'dist/presentation/agent-cli.js');
  const options = readFileSync(optionsPath, 'utf8'), separator = 'export function agentTurnCliOptions(cwd) {';
  assert.equal(options.split(separator).length, 2);
  const [agentOptions, rest] = options.split(separator); assert.ok(agentOptions && rest);
  const entry = "directory: { type: 'string', default: cwd },"; assert.equal(agentOptions.split(entry).length, 2);
  writeFileSync(optionsPath, agentOptions.replace(entry, `${entry} 'fixture-engine-note': { type: 'string' },`) + separator + rest, { mode: 0o600 });
  const code = readFileSync(cliPath, 'utf8'), result = 'const result = { ...status, engineVersion: version, storageInitialized, runtimeConnected: false };';
  assert.equal(code.split(result).length, 2);
  writeFileSync(cliPath, code.replace(result, "const result = { ...status, engineVersion: version, storageInitialized, runtimeConnected: false, ...(command === 'status' && values['fixture-engine-note'] !== undefined ? { fixtureEngineNote: values['fixture-engine-note'] } : {}) };"), { mode: 0o600 });
}

test('an unchanged A entry dispatches B-only options and carries an actual compacted SQLite session, explicit memory and adopted unfinished work across the installed release transition',
  { timeout: 240000, skip: process.platform === 'win32' ? 'POSIX installed-engine process fixture; native Windows and Linux execution are not inferred from a macOS run.' : false }, async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'engine-compact-transition-'))), directory = join(base, 'agent');
    const home = join(base, 'home'), temporary = join(base, 'tmp'); mkdirSync(home, { mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: temporary, LANG: 'C.UTF-8',
      NODE_OPTIONS: `--import=${pathToFileURL(preloader).href}`, SECUMON_INSTALLATION_HOME: home };
    const command = (args: string[]) => execute(process.execPath, args, { cwd: base, env, timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 });
    const json = async <T>(args: string[]): Promise<T> => JSON.parse((await command(args)).stdout) as T;
    try {
      // One full normal bundle/install pair, with the optional CLI change applied only before B's genuine manifest is made.
      const { a, b, marker } = createEngineUpdateReleases(base, { customizeCandidate }), entry = a.command[1]!;
      const cli = <T>(args: string[]) => json<T>([entry, ...args, '--json']);
      const life = <T>(args: string[]) => cli<T>(['lifecycle', ...args, '--directory', directory]);
      const chat = (args: string[]) => cli<Turn>(['chat', ...args, '--directory', directory, '--provider', 'synthetic', '--compact-provider', 'synthetic', '--conversation', 'engine-compact']);
      const selected = () => resolveAgentEngine(directory, a.directory, { registryDirectory: join(home, '.secumon', 'engines') });
      const aEntry = readFileSync(entry), aOptions = readFileSync(join(a.directory, 'dist/presentation/agent-cli-options.js'));
      assert.equal(aOptions.includes(Buffer.from('fixture-engine-note')), false);
      for (const path of ['dist/presentation/agent-cli.js', 'dist/presentation/agent-cli-options.js']) {
        const first = a.release.entries.find(value => value.path === path), second = b.release.entries.find(value => value.path === path);
        assert.ok(first?.kind === 'file' && second?.kind === 'file'); assert.notEqual(first.sha256, second.sha256);
      }
      const setup = await cli<Status>(['init', '--directory', directory]); assert.equal(setup.status, 'ready');
      const initial = await life<{ pin: EnginePin }>(['pin', '--engine', a.directory, '--offline']); assert.equal(initial.pin.releaseDigest, a.release.digest);
      const corrected = await chat(['ask', '--message-id', 'compact-correction', '--text', requests.rewrite]);
      assert.equal(corrected.snapshot.status, 'completed'); assert.equal(corrected.snapshot.usage.modelCalls, 1);
      const question = await chat(['ask', '--session', corrected.sessionId, '--message-id', 'compact-question', '--text', requests.question]);
      assert.equal(question.sessionId, corrected.sessionId); assert.notEqual(question.workId, corrected.workId); assert.equal(question.snapshot.status, 'waiting');
      const obligation = question.snapshot.pendingQuestions[0]; assert.ok(obligation);
      const clarified = await chat(['followup', '--session', corrected.sessionId, '--work', question.workId, '--message-id', 'compact-clarification',
        '--goal-revision', '1', '--obligation', obligation.id, '--text', requests.clarification]);
      assert.equal(clarified.workId, question.workId); assert.equal(clarified.snapshot.status, 'completed'); assert.equal(clarified.snapshot.usage.modelCalls, 2);
      const readProbe = (mode: 'seed' | 'snapshot', pending = '-', extra = '-') => json<EngineCompactSnapshot>([probe, selected().directory, mode, directory,
        corrected.sessionId, corrected.workId, question.workId, pending, extra]);
      const before = await readProbe('seed'), pendingBefore = before.works.find(value => value.state.id === before.pendingWorkId); assert.ok(pendingBefore);
      assert.deepEqual(before.identity, setup.identity); assert.equal(before.sessionId, corrected.sessionId);
      assert.equal(new Set(before.works.map(value => value.state.id)).size, 3);
      assert.equal(pendingBefore.state.budget.used.modelCalls, 2); assert.equal(pendingBefore.state.budget.used.toolCalls, 1);
      assert.equal(pendingBefore.state.modelCalls.filter(value => value.purpose === 'session_compact' && value.status === 'accepted').length, 1);
      const attempt = pendingBefore.state.attempts[0]; assert.ok(attempt?.adopted && attempt.resultArtifact);
      for (const id of ['conversation.accept', `dispatch:${attempt.id}`, `receive:${attempt.id}`, `adopt:${attempt.id}`])
        assert.ok(pendingBefore.receipts.some(value => value.commandId === id), id);
      assert.equal(before.context.schemaVersion, 2); assert.equal(before.context.entries.some(value => value.sourceId === 'compact-correction'), false);
      assert.ok(before.history.entries.some(value => value.sourceId === 'compact-correction' && value.text === requests.rewrite));
      const correction = `[합성 규칙 결과] ${SYNTHETIC_AGENT_TURN_CORRECTION}`;
      assert.ok(before.summary.content.retained.some(value => value.citations.some(citation => citation.quote === correction && citation.role === 'assistant')));
      assert.equal(before.memory.card.body, requests.rewrite); assert.equal(before.memory.card.owner?.agentId, setup.identity.agentId);
      const note = Buffer.from('압축 및 설치 버전 선택과 별개로 유지할 원자료.\n'); writeFileSync(join(directory, 'operator-original.txt'), note, { mode: 0o600 });
      const originalPin = readFileSync(join(directory, '.secumon', 'engine-pins', '00000001.json'));
      const backup = await life<{ directory: string }>(['backup', '--destination', join(base, 'backup-before-transition'), '--offline']);
      const backupTree = captureLifecycleTree(backup.directory);
      const updated = await life<{ pin: EnginePin; applied: boolean }>(['update', '--engine', b.directory, '--previous', a.release.digest, '--backup', backup.directory, '--offline']);
      assert.equal(updated.applied, true); assert.equal(updated.pin.releaseDigest, b.release.digest);
      await life(['register', '--engine', b.directory, '--digest', b.release.digest]);
      assert.equal(selected().directory, b.directory); assert.equal(selected().source, 'registered');
      const registeredHome = captureLifecycleTree(home), reopened = await cli<Status>(['open', '--directory', directory]);
      assert.equal(reopened.engineVersion, b.release.version); assert.deepEqual(reopened.identity, setup.identity);
      assert.deepEqual(await readProbe('snapshot', before.pendingWorkId), before, 'B reopens original compact, memory, history and unfinished work without running a model/tool');
      const opaque = 'B 전용 값 / spaces = --literal', untouched = captureLifecycleTree(directory);
      await assert.rejects(cli(['status', '--directory', directory, '--fixture-engine-note', opaque]), error => {
        const failed = error as Error & { code?: unknown; stderr?: string }; assert.equal(failed.code, 1); assert.equal(failed.stderr?.trim(), 'agent_setup_failed'); return true;
      });
      assert.deepEqual(captureLifecycleTree(directory), untouched, 'the old direct parser fails before opening the agent');
      const dispatched = await json<Status>([entry, 'dispatch', '--directory', directory, '--', 'status', '--directory', directory, '--fixture-engine-note', opaque, '--json']);
      assert.equal(dispatched.fixtureEngineNote, opaque); assert.equal(dispatched.engineVersion, b.release.version); assert.deepEqual(dispatched.identity, setup.identity);
      assert.deepEqual(captureLifecycleTree(directory), untouched, 'dispatch status does not execute unfinished work');
      const resumed = await chat(['resume', '--session', before.sessionId, '--work', before.pendingWorkId]);
      assert.equal(resumed.sessionId, before.sessionId); assert.equal(resumed.workId, before.pendingWorkId); assert.equal(resumed.snapshot.status, 'completed');
      assert.equal(resumed.snapshot.usage.modelCalls, 3); assert.equal(resumed.snapshot.usage.toolCalls, 1);
      assert.ok(resumed.messages.some(value => value.kind === 'result' && value.text.includes(marker) && value.text.includes('30일')));
      const afterResume = await readProbe('snapshot', before.pendingWorkId), pendingAfter = afterResume.works.find(value => value.state.id === before.pendingWorkId); assert.ok(pendingAfter);
      assert.deepEqual(pendingAfter.state.attempts, pendingBefore.state.attempts); assert.deepEqual(pendingAfter.state.evidence, pendingBefore.state.evidence);
      assert.deepEqual(pendingAfter.state.goal, pendingBefore.state.goal); assert.deepEqual(pendingAfter.state.budget.limits, pendingBefore.state.budget.limits);
      for (const call of pendingBefore.state.modelCalls) assert.deepEqual(pendingAfter.state.modelCalls.find(value => value.id === call.id), call);
      const next = await chat(['ask', '--session', before.sessionId, '--message-id', 'compact-after-update', '--text', requests.followup]);
      assert.equal(next.sessionId, before.sessionId); assert.ok(!before.works.some(value => value.state.id === next.workId)); assert.equal(next.snapshot.status, 'completed');
      assert.equal(next.snapshot.usage.modelCalls, 1); assert.equal(next.snapshot.usage.toolCalls, 0);
      assert.ok(next.messages.some(value => value.kind === 'result' && value.text.includes(marker) && value.text.includes(SYNTHETIC_AGENT_TURN_CORRECTION)));
      const after = await readProbe('snapshot', before.pendingWorkId, next.workId), followup = after.works.find(value => value.state.id === next.workId); assert.ok(followup);
      assert.deepEqual(after.identity, before.identity); assert.deepEqual(after.hostIdentity, before.hostIdentity); assert.deepEqual(after.memory, before.memory);
      assert.deepEqual(after.summary, before.summary); assert.equal(after.history.entries.filter(value => value.role === 'user').length, 5);
      assert.equal(after.works.reduce((sum, value) => sum + value.state.budget.used.modelCalls, 0), 7);
      assert.equal(after.works.reduce((sum, value) => sum + value.state.budget.used.toolCalls, 0), 1);
      for (const work of after.works) assert.equal(work.deliveries.filter(value => value.kind === 'result' && value.status === 'delivered').length, 1);
      const answerSession = followup.answerSession; assert.equal(answerSession?.schemaVersion, 2);
      if (answerSession?.schemaVersion !== 2) assert.fail('the actual B model input must use the stored summary');
      assert.deepEqual(answerSession.summary.ref, before.summary.ref);
      assert.equal(answerSession.entries.some(value => value.text === correction), false, 'the original A answer is outside the raw tail');
      assert.ok(answerSession.summary.content.retained.some(value => value.citations.some(citation => citation.quote === correction)));
      assert.equal(followup.state.goal.responseRequirement?.requestMessageId, 'compact-after-update');
      assert.equal(pendingAfter.state.goal.responseRequirement?.requestMessageId, 'compact-pending-read');
      for (const original of before.works) {
        const current = after.works.find(value => value.state.id === original.state.id); assert.ok(current); assert.deepEqual(current.inputs, original.inputs);
        if (original.state.id !== before.pendingWorkId) assert.deepEqual(current, original);
        else assert.deepEqual(current, pendingAfter, 'a new work cannot charge the completed read work');
        for (const receipt of original.receipts) assert.deepEqual(current.receipts.find(value => value.commandId === receipt.commandId), receipt);
        for (const event of original.events) assert.deepEqual(current.events.find(value => value.sequence === event.sequence), event);
      }
      for (const original of before.history.entries) assert.deepEqual(after.history.entries.find(value => value.sequence === original.sequence), original);
      for (const original of before.artifacts) assert.deepEqual(after.artifacts.find(value => value.ref.id === original.ref.id), original);
      const retry = await chat(['ask', '--session', before.sessionId, '--message-id', 'compact-after-update', '--text', requests.followup]);
      assert.equal(retry.workId, next.workId); assert.equal(retry.snapshot.usage.modelCalls, 1);
      assert.deepEqual(await readProbe('snapshot', before.pendingWorkId, next.workId), after, 'the repeated input does not recompact, deliver or execute again');
      assert.deepEqual(readFileSync(join(directory, 'operator-original.txt')), note); assert.deepEqual(readFileSync(join(directory, '.secumon', 'engine-pins', '00000001.json')), originalPin);
      assert.deepEqual(captureLifecycleTree(backup.directory), backupTree); assert.deepEqual(captureLifecycleTree(home), registeredHome);
      assert.deepEqual(readFileSync(entry), aEntry); assert.deepEqual(readFileSync(join(a.directory, 'dist/presentation/agent-cli-options.js')), aOptions);
      assert.equal(inspectEngineRelease(a.directory).digest, a.release.digest); assert.equal(inspectEngineRelease(b.directory).digest, b.release.digest);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
