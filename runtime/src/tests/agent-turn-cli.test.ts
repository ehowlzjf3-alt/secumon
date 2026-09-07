import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { LOCAL_CONTRACT_MODEL_PROFILE } from '../presentation/local-contract-model.js';
import { SYNTHETIC_AGENT_TURN_CORRECTION, SYNTHETIC_AGENT_TURN_REQUESTS as texts } from '../infrastructure/synthetic-agent-turn.js';
import type { SessionPage, SessionRecord } from '../domain/session.js';
import { transact } from '../application/work-transactions.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('./helpers/agent-cli-isolated-worker.js', import.meta.url));
function hostOptions(directory: string) { return { models: new Map(), identityRegistryDirectory: join(dirname(directory), 'registry') }; }
function cliEnvironment(directory: string) { return { ...process.env, SECUMON_TEST_IDENTITY_REGISTRY: hostOptions(directory).identityRegistryDirectory }; }
const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
interface ChatResult {
  provider: string; notice: string; sessionId: string; workId: string; accepted?: boolean;
  snapshot: { status: string; resultReady: boolean; resultDelivery: string; pendingQuestions: { id: string; reason: string }[];
    usage: { toolCalls: number; modelCalls: number; replans: number }; execution: { activeModels: number } };
  messages: { id: string; kind: string; text: string }[];
  run?: { control: { kind: string }; reason: string };
}
function fixture(backend: 'sqlite' | 'file-journal' = 'sqlite') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-turn-cli-'))), directory = join(base, 'agent');
  const profile = new FileAgentProfileStore(runtimeRoot).initialize(directory);
  if (backend === 'file-journal') writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...profile.config, storage: { ...profile.config.storage, state: backend } }), { mode: 0o600 });
  return { base, directory, agentId: profile.identity.agentId, close: () => rmSync(base, { recursive: true, force: true }) };
}
async function call<T = ChatResult>(directory: string, args: string[]): Promise<T> {
  const result = await execute(process.execPath, [cli, 'chat', ...args, '--directory', directory, '--provider', 'synthetic', '--json'], { timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: cliEnvironment(directory) });
  assert.doesNotMatch(result.stdout, /\u001b/); return JSON.parse(result.stdout) as T;
}

async function withProfile<T>(directory: string, action: (profile: Awaited<ReturnType<typeof openAgentTurnProfile>>) => Promise<T>): Promise<T> {
  const profile = await openAgentTurnProfile(directory, { provider: 'synthetic' }, hostOptions(directory));
  try { return await action(profile); } finally { await profile.close(); }
}
async function seedFailure(directory: string, status: 'blocked' | 'failed') {
  return withProfile(directory, async profile => {
    const session = await profile.sessions.open(profile.actor, { channel: 'cli', conversationId: 'terminal' });
    const accepted = await profile.turns.accept(profile.actor, { sessionId: session.scope.sessionId, messageId: 'failure-request', rawText: texts.read,
      binding: { ...profile.executionActor, channel: 'cli', conversationId: 'terminal', destination: 'local', recipientId: profile.actor.principalId },
      scope: profile.scope, mode: 'auto', policy: profile.policy, limits: profile.limits });
    await profile.outbox.flush(accepted.workId, profile.actor);
    await transact(profile.services, accepted.workId, 'fixture-restriction', 'fixture_restriction', {}, state => {
      state.status = status; state.statusReason = 'fixture_original_restriction';
    });
    const delivery = await profile.conversation.prepare(accepted.workId, profile.actor);
    assert.equal(delivery?.kind, 'failure'); assert.equal(delivery?.status, 'pending');
    return { workId: accepted.workId, sessionId: session.scope.sessionId, failureId: delivery!.id };
  });
}
async function failureImage(directory: string, workId: string, sessionId: string) {
  return withProfile(directory, async profile => ({ state: await profile.services.state.get(workId),
    deliveries: await profile.services.state.deliveries(workId), events: await profile.services.state.events(workId, 0),
    history: await profile.sessions.history(profile.actor, sessionId, profile.policy, { limit: 100 }) }));
}

test('chat failure status shows only delivered current restrictions without executing or changing stored work', { timeout: 60000 }, async () => {
  for (const status of ['blocked', 'failed'] as const) {
    const f = fixture();
    try {
      const seeded = await seedFailure(f.directory, status), args = ['status', '--work', seeded.workId, '--session', seeded.sessionId];
      const pending = await failureImage(f.directory, seeded.workId, seeded.sessionId);
      assert.deepEqual((await call(f.directory, args)).messages.filter(message => message.kind === 'failure'), []);
      assert.deepEqual(await failureImage(f.directory, seeded.workId, seeded.sessionId), pending);
      await withProfile(f.directory, profile => profile.outbox.flush(seeded.workId, profile.actor));
      const delivered = await failureImage(f.directory, seeded.workId, seeded.sessionId);
      assert.equal(delivered.deliveries.find(delivery => delivery.id === seeded.failureId)?.status, 'delivered');
      for (let repeat = 0; repeat < 2; repeat++) {
        const current = await call(f.directory, args);
        assert.equal(current.snapshot.status, status); assert.equal(current.snapshot.resultReady, false);
        assert.deepEqual(current.messages.filter(message => message.kind !== 'ack'), [{ id: seeded.failureId, kind: 'failure',
          text: `[${seeded.workId}] 작업을 진행할 수 없습니다. 상태 조회에서 제한 사유를 확인해 주세요.` }]);
        assert.equal(current.snapshot.usage.modelCalls, 0); assert.equal(current.snapshot.usage.toolCalls, 0);
      }
      assert.deepEqual(await failureImage(f.directory, seeded.workId, seeded.sessionId), delivered);
    } finally { f.close(); }
  }
});

test('chat failure status withholds earlier reason and generation deliveries until a current failure is delivered', { timeout: 60000 }, async () => {
  const f = fixture();
  try {
    const seeded = await seedFailure(f.directory, 'blocked'), args = ['status', '--work', seeded.workId, '--session', seeded.sessionId];
    await withProfile(f.directory, profile => profile.outbox.flush(seeded.workId, profile.actor));
    let previousId = seeded.failureId;
    for (const change of ['reason', 'generation'] as const) {
      await withProfile(f.directory, profile => transact(profile.services, seeded.workId, `fixture-${change}`, 'fixture_restriction_changed', { change }, state => {
        if (change === 'reason') state.statusReason = 'fixture_replacement_restriction';
        else if (state.dataLifecycle) state.dataLifecycle.generation++;
        else state.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] };
      }));
      const before = await failureImage(f.directory, seeded.workId, seeded.sessionId);
      assert.equal(before.deliveries.find(delivery => delivery.id === previousId)?.status, 'delivered');
      const stale = await call(f.directory, args);
      assert.equal(stale.snapshot.status, 'blocked'); assert.deepEqual(stale.messages.filter(message => message.kind === 'failure'), []);
      assert.deepEqual(await failureImage(f.directory, seeded.workId, seeded.sessionId), before);
      const currentId = await withProfile(f.directory, async profile => {
        const current = await profile.conversation.prepare(seeded.workId, profile.actor);
        assert.equal(current?.kind, 'failure'); assert.notEqual(current!.id, previousId);
        await profile.outbox.flush(seeded.workId, profile.actor); return current!.id;
      });
      assert.deepEqual((await call(f.directory, args)).messages.filter(message => message.kind === 'failure').map(message => message.id), [currentId]);
      previousId = currentId;
    }
  } finally { f.close(); }
});

test('chat failure status retains its snapshot only for a knowledge projection change and propagates access denial', { timeout: 60000 }, async () => {
  const f = fixture();
  try {
    const seeded = await seedFailure(f.directory, 'blocked');
    await withProfile(f.directory, profile => profile.outbox.flush(seeded.workId, profile.actor));
    const before = await failureImage(f.directory, seeded.workId, seeded.sessionId);
    // This injects the projection boundary outcome after real authorization/current-message checks;
    // source deletion and knowledge-validator races remain covered by the WorkView service tests.
    const invoke = async (code: string) => {
      const program = `import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {runAgentTurnCli} from ${JSON.stringify(new URL('../presentation/agent-turn-cli.js', import.meta.url).href)};
import {WorkViewService} from ${JSON.stringify(new URL('../application/work-view-service.js', import.meta.url).href)};
const read=WorkViewService.prototype.read; let checks=0;
mock.method(WorkViewService.prototype,'read',async function(...args) {
  const result=await read.apply(this,args);
  assert.equal(result.kind,'snapshot'); assert.ok(result.view.messages.some(message=>message.kind==='failure'&&message.deliveryStatus==='delivered'));
  checks++; throw new Error(${JSON.stringify(code)});
});
try { await runAgentTurnCli(process.argv.slice(1),{models:new Map(),identityRegistryDirectory:${JSON.stringify(hostOptions(f.directory).identityRegistryDirectory)}}); }
finally { mock.restoreAll(); assert.equal(checks,1); }`;
      return execute(process.execPath, ['--input-type=module', '-e', program, 'status', '--directory', f.directory, '--provider', 'synthetic',
        '--work', seeded.workId, '--session', seeded.sessionId, '--json'], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    };
    const result = JSON.parse((await invoke('work_view_knowledge_changed')).stdout) as ChatResult;
    assert.equal(result.snapshot.status, 'blocked'); assert.equal(result.snapshot.resultReady, false);
    assert.deepEqual(result.messages.filter(message => message.kind === 'failure'), []);
    assert.equal(result.snapshot.usage.modelCalls, 0); assert.equal(result.snapshot.usage.toolCalls, 0);
    await assert.rejects(invoke('work_view_denied'), /work_view_denied/);
    assert.deepEqual(await failureImage(f.directory, seeded.workId, seeded.sessionId), before);
  } finally { f.close(); }
});

test('chat uses the trusted identity registry and retains the default registered model', async () => {
  const f = fixture();
  try {
    const configPath = join(f.directory, 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    writeFileSync(configPath, JSON.stringify({ ...config, model: { profile: LOCAL_CONTRACT_MODEL_PROFILE } }), { mode: 0o600 });
    const registry = hostOptions(f.directory).identityRegistryDirectory;
    assert.equal(existsSync(registry), false);
    const result = await execute(process.execPath, [cli, 'chat', 'ask', '--directory', f.directory, '--provider', 'registered',
      '--message-id', 'registered-read', '--text', texts.read, '--json'],
    { timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: cliEnvironment(f.directory) });
    const answer = JSON.parse(result.stdout) as ChatResult;
    assert.equal(answer.provider, 'registered');
    assert.equal(answer.snapshot.status, 'completed');
    assert.equal(answer.snapshot.usage.toolCalls, 1);
    assert.ok(answer.messages.some(message => message.kind === 'result' && message.text.includes('doc-current')));
    assert.equal(existsSync(registry), true);
    const reopened = await call(f.directory, ['status', '--work', answer.workId, '--session', answer.sessionId]);
    assert.equal(reopened.snapshot.status, 'completed');
    assert.deepEqual(reopened.snapshot.usage, answer.snapshot.usage);
  } finally { f.close(); }
});

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: installed chat CLI accepts a plain request, resumes its session and carries actual X replies into Y`, async () => {
  const f = fixture(backend);
  try {
    const first = await call(f.directory, ['ask', '--message-id', 'X', '--text', texts.rewrite]);
    assert.equal(first.provider, 'synthetic'); assert.match(first.notice, /합성 규칙 시험/);
    assert.equal(first.snapshot.status, 'completed'); assert.equal(first.snapshot.resultReady, true); assert.equal(first.snapshot.resultDelivery, 'delivered');
    assert.equal(first.snapshot.usage.modelCalls, 1); assert.equal(first.snapshot.usage.toolCalls, 0);
    assert.deepEqual(first.messages.map(message => message.kind), ['ack', 'result']);
    assert(first.messages.some(message => message.kind === 'result' && message.text.includes(SYNTHETIC_AGENT_TURN_CORRECTION)));
    const retry = await call(f.directory, ['ask', '--message-id', 'X', '--text', texts.rewrite]);
    assert.equal(retry.workId, first.workId); assert.equal(retry.accepted, false); assert.equal(retry.snapshot.usage.modelCalls, 1);
    const session = await call<{ session: SessionRecord }>(f.directory, ['session']);
    assert.equal(session.session.scope.sessionId, first.sessionId); assert.equal(session.session.scope.agentId, f.agentId);
    const second = await call(f.directory, ['ask', '--message-id', 'Y', '--text', texts.followup]);
    assert.notEqual(second.workId, first.workId); assert.equal(second.sessionId, first.sessionId); assert.equal(second.snapshot.status, 'completed');
    assert.equal(second.snapshot.usage.modelCalls, 1); assert.equal(second.snapshot.usage.toolCalls, 0);
    assert(second.messages.some(message => message.kind === 'result' && message.text.includes(SYNTHETIC_AGENT_TURN_CORRECTION)));
    const history = await call<SessionPage>(f.directory, ['history']);
    assert.deepEqual(history.entries.filter(entry => entry.role === 'user').map(entry => entry.text), [texts.rewrite, texts.followup]);
    assert.equal(history.entries.filter(entry => entry.kind === 'result').length, 2);
    const profile = await openAgentTurnProfile(f.directory, { provider: 'synthetic' }, hostOptions(f.directory));
    try {
      const state = await profile.runtime.state(second.workId);
      assert.deepEqual(state.goal.criteria, []); assert.equal(state.goal.scope, profile.scope);
      assert.equal(state.goal.responseRequirement!.requestMessageId, 'Y'); assert.equal(state.goal.description, texts.followup);
      assert.equal(state.goal.responseRequirement!.requestTextDigest, profile.services.digester.digest(texts.followup));
      assert.equal(state.conversation!.session!.scope.agentId, f.agentId); assert.equal(state.evidence.length, 0);
    } finally { await profile.close(); }
  } finally { f.close(); }
});

test('chat fast path plans one real fixture read and synthesizes a sourced answer without a graph replan', async () => {
  const f = fixture();
  try {
    const result = await call(f.directory, ['ask', '--message-id', 'read', '--text', texts.read, '--mode', 'fast']);
    assert.equal(result.snapshot.status, 'completed'); assert.equal(result.snapshot.usage.toolCalls, 1);
    assert.equal(result.snapshot.usage.modelCalls, 2); assert.equal(result.snapshot.usage.replans, 0);
    const message = result.messages.find(value => value.kind === 'result')!; assert.match(message.text, /doc-current/); assert.match(message.text, /30일/);
    const resumed = await call(f.directory, ['resume', '--work', result.workId, '--session', result.sessionId]);
    assert.equal(resumed.snapshot.status, 'completed'); assert.deepEqual(resumed.snapshot.usage, result.snapshot.usage);
    const profile = await openAgentTurnProfile(f.directory, { provider: 'synthetic' }, hostOptions(f.directory));
    try {
      const state = await profile.runtime.state(result.workId);
      assert.equal(state.attempts.length, 1); assert.equal(state.attempts[0]!.status, 'succeeded');
      assert.deepEqual(state.generatedAnswer!.evidenceIds, ['doc-current']); assert.equal(state.goal.criteria.length, 0);
      assert.deepEqual(state.modelCalls.map(call => call.purpose), ['agent_turn', 'agent_turn']);
    } finally { await profile.close(); }
  } finally { f.close(); }
});

test('chat followup distinguishes more input from resolving a question and preserves the original requirement', async () => {
  const f = fixture();
  try {
    const first = await call(f.directory, ['ask', '--message-id', 'question', '--text', texts.question]);
    assert.equal(first.snapshot.status, 'waiting'); assert.equal(first.snapshot.pendingQuestions.length, 1);
    assert.deepEqual(first.messages.map(message => message.kind), ['ack', 'question']);
    const obligationId = first.snapshot.pendingQuestions[0]!.id; assert.match(obligationId, /^agent-question:/);
    const extra = await call(f.directory, ['followup', '--work', first.workId, '--message-id', 'extra', '--text', texts.clarification, '--goal-revision', '1']);
    assert.equal(extra.snapshot.pendingQuestions[0]!.id, obligationId); assert.notEqual(extra.snapshot.status, 'completed');
    const args = ['followup', '--work', first.workId, '--message-id', 'reply', '--text', texts.clarification, '--goal-revision', '1', '--obligation', obligationId];
    const answered = await call(f.directory, args); assert.equal(answered.snapshot.status, 'completed');
    assert.deepEqual(answered.snapshot.pendingQuestions, []); assert.equal(answered.snapshot.usage.modelCalls, 2);
    assert(answered.messages.some(message => message.kind === 'result' && message.text.includes('원문')));
    const retry = await call(f.directory, args); assert.equal(retry.snapshot.status, 'completed'); assert.equal(retry.snapshot.usage.modelCalls, 2);
    const profile = await openAgentTurnProfile(f.directory, { provider: 'synthetic' }, hostOptions(f.directory));
    try {
      const state = await profile.runtime.state(first.workId);
      assert.equal(state.goal.responseRequirement!.requestMessageId, 'question');
      assert.equal(state.goal.responseRequirement!.requestTextDigest, profile.services.digester.digest(texts.question));
      assert.equal(state.conversation!.session!.input.messageId, 'reply'); assert.equal(state.generatedAnswer!.input.input.messageId, 'reply');
    } finally { await profile.close(); }
    const history = await call<SessionPage>(f.directory, ['history']);
    assert.deepEqual(history.entries.filter(entry => entry.role === 'user').map(entry => entry.text), [texts.question, texts.clarification, texts.clarification]);
  } finally { f.close(); }
});

test('chat step-limited execution resumes in another process without accepting another request', async () => {
  const f = fixture('file-journal');
  try {
    // Two steps leave a stored model response, which another owner can adopt without waiting for its lease.
    const first = await call(f.directory, ['ask', '--message-id', 'bounded', '--text', texts.read, '--steps', '2']);
    assert.notEqual(first.snapshot.status, 'completed'); assert.equal(first.run!.reason, 'step_limit');
    const profile = await openAgentTurnProfile(f.directory, { provider: 'synthetic' }, hostOptions(f.directory));
    try {
      const state = await profile.runtime.state(first.workId);
      assert.equal(state.modelCalls.length, 1); assert.equal(state.modelCalls[0]!.status, 'received');
      assert.ok(state.modelCalls[0]!.replyArtifact); assert.equal(state.attempts.length, 0);
    } finally { await profile.close(); }
    const resumed = await call(f.directory, ['resume', '--work', first.workId, '--session', first.sessionId]);
    assert.equal(resumed.snapshot.status, 'completed'); assert.equal(resumed.snapshot.usage.toolCalls, 1); assert.equal(resumed.snapshot.usage.modelCalls, 2);
    const history = await call<SessionPage>(f.directory, ['history']);
    assert.equal(history.entries.filter(entry => entry.role === 'user').length, 1);
    assert.equal(history.entries.filter(entry => entry.kind === 'ack').length, 1);
    assert.equal(history.entries.filter(entry => entry.kind === 'result').length, 1);
  } finally { f.close(); }
});

test('chat session selection prevents displaying or mutating a work from another session or agent', async () => {
  const f = fixture(), other = fixture();
  try {
    const first = await call(f.directory, ['ask', '--message-id', 'X', '--text', texts.rewrite]);
    const fresh = await call<{ session: SessionRecord }>(f.directory, ['session', '--new-session']);
    assert.notEqual(fresh.session.scope.sessionId, first.sessionId);
    assert.deepEqual((await call<SessionPage>(f.directory, ['history'])).entries, []);
    for (const args of [['status', '--work', first.workId], ['resume', '--work', first.workId],
      ['followup', '--work', first.workId, '--message-id', 'wrong', '--text', texts.clarification, '--goal-revision', '1']])
      await assert.rejects(call(f.directory, args), /session_work_unavailable/);
    const explicit = await call(f.directory, ['status', '--work', first.workId, '--session', first.sessionId]); assert.equal(explicit.snapshot.status, 'completed');
    await assert.rejects(call(other.directory, ['history', '--session', first.sessionId]), /session_unavailable/);
    assert.equal((await call<SessionPage>(f.directory, ['history', '--session', first.sessionId])).entries.filter(entry => entry.role === 'user').length, 1);
  } finally { f.close(); other.close(); }
});

test('chat requires an explicit provider before creating a profile and prints only concise user-facing messages', async () => {
  const f = fixture(), unused = join(f.base, 'uninitialized');
  try {
    await assert.rejects(execute(process.execPath, [cli, 'chat', 'ask', '--directory', unused, '--message-id', 'missing', '--text', texts.rewrite, '--json'],
      { timeout: 30000, env: cliEnvironment(unused) }), /agent_turn_provider_unavailable/);
    assert.equal(existsSync(unused), false);
    await assert.rejects(call(unused, ['ask', '--message-id', 'scenario', '--text', texts.rewrite, '--scenario', 'documents-simple']), /chat_request_failed/);
    assert.equal(existsSync(unused), false);
    const result = await execute(process.execPath, [cli, 'chat', 'ask', '--directory', f.directory, '--provider', 'synthetic', '--message-id', 'plain', '--text', texts.rewrite],
      { timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: cliEnvironment(f.directory) });
    assert.match(result.stdout, /합성 규칙 시험/); assert.match(result.stdout, /요청을 접수했습니다/); assert.match(result.stdout, /오늘 회의는 세 시에 시작됩니다/);
    assert(result.stdout.indexOf('요청을 접수했습니다') < result.stdout.indexOf(SYNTHETIC_AGENT_TURN_CORRECTION));
    assert.equal(result.stdout.split('요청을 접수했습니다').length - 1, 1);
    assert.doesNotMatch(result.stdout, /model_call_reserved|context_head|task_ready|"artifacts"|\u001b/);
  } finally { f.close(); }
});
