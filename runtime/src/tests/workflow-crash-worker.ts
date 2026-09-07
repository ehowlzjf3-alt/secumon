import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ArtifactStore, MessageSink, Tool } from '../application/ports.js';
import { WorkflowRuntime } from '../application/workflow-runtime.js';
import { ConversationService } from '../application/conversation-service.js';
import { OutboxDispatcher } from '../application/outbox.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { validateScenario } from '../application/fixtures.js';
import { adapters, openRepository } from './state-conformance-helpers.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { LocalChannel } from '../infrastructure/local-channel.js';
import { FakeClock, FixtureReadTool, ScriptedPlanner } from '../infrastructure/fakes.js';
import { Sha256Digester, RandomIds } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';

const directory = process.argv[2]!; const family = process.argv[3]!; const checkpoint = process.argv[4]!;
const effect: 'read' | 'write' = process.argv[5] === 'write' ? 'write' : 'read';
const actor = { tenantId: 'synthetic', principalId: 'learner' };
const scenario = validateScenario(JSON.parse(readFileSync(new URL(`../../fixtures/${family}.json`, import.meta.url), 'utf8')));
const backend = adapters.find(name => name === (process.argv[6] ?? 'sqlite')); if (!backend) throw new Error('invalid_test_adapter');
const repository = openRepository(backend, directory);
const channel = new LocalChannel(join(directory, 'channel.sqlite'));
const ledger = new DatabaseSync(join(directory, 'source.sqlite'));
ledger.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS source_calls(sequence INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL, effect TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sends(sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, delivery_id TEXT NOT NULL);');
const baseArtifacts = new FileArtifactStore(join(directory, 'artifacts')); let workId = '';
async function crash(stage: string): Promise<never> {
  return new Promise<never>(() => {
    process.send!({ type: 'checkpoint', stage, workId }, () => process.kill(process.pid, 'SIGKILL'));
  });
}
const artifacts: ArtifactStore = { get: (ref, policy) => baseArtifacts.get(ref, policy), exists: ref => baseArtifacts.exists(ref), async put(bytes, attributes) {
  let toolResponse = false;
  try { const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>; toolResponse = typeof value['attemptId'] === 'string' && value['status'] === 'success'; } catch {}
  if (checkpoint === 'response-before-store' && toolResponse) return crash(checkpoint);
  return baseArtifacts.put(bytes, attributes);
} };
const fixture = new FixtureReadTool(scenario.evidence);
const tool: Tool = { definition: { ...fixture.definition, effect }, async execute(task, context) {
  ledger.prepare('INSERT INTO source_calls(attempt_id,effect) VALUES(?,?)').run(context.attemptId, effect);
  const result = await fixture.execute(task, context);
  return effect === 'write' && result.status === 'success' ? { ...result, effectState: 'confirmed' } : result;
} };
const sink: MessageSink = { capabilities: { idempotentSend: true }, lookup: delivery => channel.lookup(delivery), async send(delivery) {
  ledger.prepare('INSERT INTO sends(kind,delivery_id) VALUES(?,?)').run(delivery.kind, delivery.id);
  const result = await channel.send(delivery);
  if (checkpoint === 'receiver-committed' && delivery.kind === 'result') return crash(checkpoint);
  return result;
} };
const services = { state: repository, artifacts, sink, tools: [tool], planner: new ScriptedPlanner([]), ids: new RandomIds(), digester: new Sha256Digester(),
  clock: new FakeClock(1788566400000 + (checkpoint === 'resume' ? 2000 : 0)) };
const execution = new ExecutionRuntime(services, new ToolContracts([tool], new AjvSchemas()), `worker-${process.pid}`, 1000);
const conversation = new ConversationService(services); const outbox = new OutboxDispatcher(services, `sender-${process.pid}`, 1000);
const workflow = new WorkflowRuntime(services, execution, null, conversation, outbox);
try {
  const accepted = await workflow.accept(actor, { messageId: 'crash-workflow', binding: { ...actor, channel: 'test', conversationId: 'crash-chat', recipientId: actor.principalId, destination: 'local' },
    goal: scenario.goal, policy: { ...scenario.policy, allowWrites: effect === 'write' }, limits: { toolCalls: 5, modelCalls: 0, tokens: 10000, replans: 3, wallTimeMs: 120000 }, completionRequiresDelivery: true });
  workId = accepted.workId;
  if (!accepted.state.plan) await execution.submitPlan(workId, 'fixture-plan', { baseStateRevision: accepted.state.revision, baseGoalRevision: 1, basePlanRevision: 0,
    reason: 'Explicit synthetic source plan', hypotheses: [], tasks: [{ id: 'source', description: 'Read the synthetic source and record the synthetic effect when requested',
      dependsOn: [], toolId: 'fixture.read', toolVersion: '1', input: { evidenceIds: [family === 'documents-simple' ? 'doc-current' : 'collection-complete'] },
      effect, maxAttempts: 2, satisfies: scenario.goal.criteria.map(c => c.id) }] });
  let result = await workflow.run(workId, actor, { onStep: async () => {
    const state = await execution.state(workId);
    if (checkpoint === 'before-execution' && state.attempts.some(attempt => attempt.status === 'reserved')) await crash(checkpoint);
    if (checkpoint === 'response-stored' && state.attempts.some(attempt => attempt.status === 'received')) await crash(checkpoint);
  } });
  if (checkpoint === 'resume' && result.control.kind === 'wait' && result.reason === 'retry_backoff') {
    // The resumed worker yields until the persisted retry time instead of immediately repeating the source call.
    if (result.control.wakeAt === null || result.control.wakeAt < services.clock.now()) throw new Error('invalid_retry_wake');
    services.clock.advance(result.control.wakeAt - services.clock.now());
    result = await workflow.run(workId, actor, { previousPacket: result.checkpoint });
  }
  const final = await execution.state(workId);
  process.send!({ type: 'finished', workId, control: result.control.kind, reason: result.reason, status: final.status,
    sourceCalls: Number(ledger.prepare('SELECT COUNT(*) AS n FROM source_calls').get()!['n']),
    resultSends: Number(ledger.prepare("SELECT COUNT(*) AS n FROM sends WHERE kind='result'").get()!['n']) });
} finally { await repository.close(); channel.close(); ledger.close(); }
