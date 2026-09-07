import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { SessionCompactInput, SessionCompactLimits } from '../domain/session-compact.js';
import type { ModelCallOptions, Planner, SessionCompactReply } from '../application/ports.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { LocalChannel } from '../infrastructure/local-channel.js';
import { bindAgentDatabase } from '../infrastructure/agent-database-owner.js';
import { FakeClock, FixtureReadTool, SequenceIds } from '../infrastructure/fakes.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { initial } from './state-conformance-helpers.js';

export const windowActor = { tenantId: 'tenant-a', principalId: 'person-a' };
export const windowText = (n: number, size = 700) => `Retain source ${n}.\n${'synthetic supporting text '.repeat(Math.ceil(size / 26))}`;

/** Real session intake/receipts over SQLite, with bounded in-memory work/artifacts and an explicit rule provider. */
export async function windowFixture(t: TestContext, count = 8, compact: Partial<SessionCompactLimits> = {}, textSize = 700) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'session-window-'))), path = join(directory, 'channel.sqlite');
  let channelToClose: LocalChannel | undefined;
  t.after(() => { try { channelToClose?.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  bindAgentDatabase(path, 'window-agent', 'channel');
  const state = new MemoryStateRepository(), artifacts = new MemoryArtifactStore(), channel = new LocalChannel(path, 'window-agent');
  channelToClose = channel;
  const planner: Planner & { inputs: SessionCompactInput[] } = {
    identity: { provider: 'synthetic', model: 'window-fixture', revision: '1' }, destination: 'local',
    capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000 }, inputs: [],
    estimateCompactInput: (input, options) => ({ tokens: 100, bytes: Buffer.byteLength(JSON.stringify({ compact: input, options })), method: 'synthetic_window_fixture' }),
    propose: async () => { throw new Error('unexpected_plan_provider'); },
    compact: async (input: SessionCompactInput, signal: AbortSignal, options: ModelCallOptions): Promise<SessionCompactReply> => {
      assert.equal(signal.aborted, false); assert.deepEqual(options.tools, []); planner.inputs.push(structuredClone(input));
      const entry = input.entries.find(value => value.role === 'user'); assert.ok(entry);
      const quote = entry.text.split('\n')[0]!;
      const retained = structuredClone(input.previous?.content.retained ?? []);
      retained.push({ id: `source-${entry.sequence}`, kind: 'constraint', text: quote, status: 'active',
        citations: [{ sequence: entry.sequence, sourceId: entry.sourceId, role: entry.role, quote }] });
      return { status: 'ok', provider: 'synthetic', model: 'window-fixture', inputTokens: 7, outputTokens: 3,
        candidate: { inputDigest: input.inputDigest, content: { narrative: 'Keep the cited synthetic constraint.', retained } } };
    },
  };
  const runtime = await composeRuntime({ services: { state, artifacts, sink: channel, planner, tools: [new FixtureReadTool([])],
    clock: new FakeClock(1100), ids: new SequenceIds(), digester: new Sha256Digester() },
    schemas: new AjvSchemas(), owner: 'window-fixture', enablePlanning: false,
    guidanceSource: { list: async () => [], read: async () => { throw new Error('unexpected_guidance'); } },
    session: { repository: channel.sessions!, agentId: 'window-agent', compact } });
  const sessions = runtime.sessions!;
  const session = await sessions.open(windowActor, { channel: 'test', conversationId: 'window' });
  const template = initial();
  const accepted = await sessions.accept(windowActor, { sessionId: session.scope.sessionId, rawText: windowText(0, textSize), request: {
    messageId: 'source-0', goal: template.goal, policy: template.policy, completionRequiresDelivery: false,
    limits: { toolCalls: 20, modelCalls: 32, tokens: 1000000, replans: 10, wallTimeMs: 600000 },
    binding: { ...windowActor, channel: 'test', conversationId: 'window', recipientId: windowActor.principalId, destination: 'local' },
  } });
  let next = 1;
  const append = async (text = windowText(next, textSize)) => {
    const messageId = `source-${next++}`;
    return sessions.input(windowActor, { sessionId: session.scope.sessionId, workId: accepted.workId, messageId, rawText: text, expectedGoalRevision: 1 });
  };
  for (let n = 1; n < count; n++) await append();
  return { ...runtime, sessions, repository: channel.sessions!, planner, session, workId: accepted.workId, append,
    current: () => runtime.runtime.state(accepted.workId),
    history: () => channel.sessions!.history(session.scope, template.policy, { limit: 256 }) };
}
