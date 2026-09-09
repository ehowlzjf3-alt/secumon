import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AgentTurnInput } from '../application/agent-turn-types.js';
import type { ModelCallOptions, ModelInputEstimate, StateRepository } from '../application/ports.js';
import { ReadCheckpointReader } from '../application/read-checkpoint-store.js';
import { ToolResultSchema } from '../application/contracts.js';
import type { AgentTurnResult } from '../domain/agent-turn.js';
import type { ArtifactRef, Json, Limits, Policy, TaskSpec, WorkState } from '../domain/model.js';
import type { SessionScope } from '../domain/session.js';
import type { SessionCompactCandidate, SessionCompactInput } from '../domain/session-compact.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { StructuredAgentTurnAdapter } from '../infrastructure/structured-agent-turn.js';
import { StructuredSessionCompactAdapter } from '../infrastructure/structured-session-compact.js';
import { StructuredAgentModel } from '../infrastructure/structured-agent-model.js';
import { MCP_PROTOCOL_VERSION } from '../infrastructure/mcp-stdio-client.js';
import { createMcpHostTools } from '../presentation/mcp-host-tools.js';
import type { AgentExecutionHost, HostToolAssembly } from '../presentation/host-tools.js';
import { SyntheticSessionCompactPlanner } from '../presentation/synthetic-session-compact.js';
import { collectionBinding } from './helpers/mcp-collection-binding.js';
import type { McpCollectionAudit } from './helpers/mcp-collection-fixture-contracts.js';
import { MCP_AGENT_PROFILE, mcpFixtureIdentityOptions } from './mcp-agent-profile-helper.js';

export const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
export type EntryScenario = 'complete' | 'nonfinal' | 'adopted_partial';
export interface CollectionEntryOptions {
  directory: string; auditFile: string; hostAuditFile: string; backend: 'sqlite' | 'file-journal'; scenario: EntryScenario;
  now: number; window?: number;
}
export const COLLECTION_ENTRY_TEXT = '[합성 collection] 지정한 자료의 모든 항목을 읽고 항목별 값과 합계를 알려 줘. 원문 보존.';
export const COLLECTION_ENTRY_RESUME_TEXT = '[합성 collection 재개] 권한을 다시 허용했으니 저장된 원문으로 기존 항목별 값과 합계 작업을 이어서 완료해 줘. 원문 보존.';
export const COLLECTION_ENTRY_TAIL = COLLECTION_ENTRY_TEXT + ' ' +
  '원문 보존. 완료된 항목의 원래 출처를 유지하고 전체 항목을 확인한 뒤 답한다. '.repeat(32);
export const entryIds = (scenario: EntryScenario) => scenario === 'nonfinal' ? ['a', 'b', 'c', 'd'] : ['a', 'b'];
export const entryAnswer = (scenario: EntryScenario) => scenario === 'nonfinal'
  ? '[합성 collection 결과] a=1, b=1, c=1, d=1; 합계=4.' : '[합성 collection 결과] a=30, b=30; 합계=60.';
export type EntryObservation =
  | { kind: 'turn'; input: AgentTurnInput; options: ModelCallOptions; estimate: ModelInputEstimate; result: AgentTurnResult }
  | { kind: 'compact'; input: SessionCompactInput; options: ModelCallOptions; estimate: ModelInputEstimate; candidate: SessionCompactCandidate }
  | { kind: 'open'; mode: 'online' | 'stored_only' }
  | { kind: 'fetch'; requestId: string }
  | { kind: 'project'; requestId: string };
export function entryObservations(options: CollectionEntryOptions): EntryObservation[] {
  try { return readFileSync(options.hostAuditFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as EntryObservation); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export function entryAudit(options: CollectionEntryOptions): McpCollectionAudit[] {
  try { return readFileSync(options.auditFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as McpCollectionAudit); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
type Commit = Parameters<StateRepository['commit']>[0];
type CommitResult = Awaited<ReturnType<StateRepository['commit']>>;
export type ResponseBarrier = (assembly: HostToolAssembly, request: Commit, result: CommitResult) => Promise<void>;

/** Only the finite transport is synthetic. The host opens the actual C01 stores and local stdio collection adapter. */
export function createCollectionEntryHost(options: CollectionEntryOptions, mode: 'online' | 'stored_only', barrier?: ResponseBarrier): AgentExecutionHost {
  const log = (row: EntryObservation) => appendFileSync(options.hostAuditFile, JSON.stringify(row) + '\n', { mode: 0o600 });
  const identity = { provider: 'local-fixture', model: 'collection-entry', revision: '1' };
  const policy: Policy = { tenantId: 'mcp-collection-company', principalId: 'reader', allowWrites: false,
    allowedTools: ['fixture.collection', 'core.evidence.find', 'core.evidence.get'],
    allowedLabels: ['synthetic', 'public'], allowedDestinations: ['local'] };
  const limits: Limits = { toolCalls: 8, modelCalls: 16, tokens: 1_000_000, replans: 6, wallTimeMs: 600_000 };
  const binding = collectionBinding(options.scenario === 'nonfinal' ? 'observations' : 'documents', { maxCalls: 4 });
  const project = binding.project;
  const measured = { ...binding, project: ((...args: Parameters<typeof project>) => {
    log({ kind: 'project', requestId: args[2].requestId }); return project(...args);
  }) };
  const common = { bindings: [], collectionBindings: [measured], policy, limits };
  const registration = mode === 'stored_only' ? createMcpHostTools({ ...common, mode, origin: {
    endpointId: 'collection-entry-local', protocolVersion: MCP_PROTOCOL_VERSION } }) : createMcpHostTools({ ...common,
    config: { endpointId: 'collection-entry-local', command: process.execPath,
      args: [fileURLToPath(new URL('./helpers/mcp-collection-fixture-server.js', import.meta.url)), '--audit-file', options.auditFile,
        '--mode', options.scenario === 'adopted_partial' ? 'item-error' : 'normal', '--delay-ms', '100'],
      cwd: runtimeRoot, env: { TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir() }, timeoutMs: 5000 } });
  return { ...mcpFixtureIdentityOptions(options), models: new Map([[MCP_AGENT_PROFILE, { execution: 'deterministic_fixture', async open(profile) {
    const configuration = { identity, destination: 'local', maxRequestBytes: 131072,
      capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true,
        maxInputTokens: 200000, maxInputBytes: 131072, maxOutputTokens: 2048,
        ...(options.window === undefined ? {} : { contextWindowTokens: options.window }) } };
    const compactFixture = new SyntheticSessionCompactPlanner([], { userTexts: [COLLECTION_ENTRY_TEXT, COLLECTION_ENTRY_TAIL],
      rules: [COLLECTION_ENTRY_TEXT, COLLECTION_ENTRY_TAIL].map(exactText => ({ role: 'user' as const, exactText,
        quote: '원문 보존', text: '합성 collection 요청은 원문을 보존하고 모든 항목을 확인한다.', kind: 'constraint' as const })) });
    const checkSize = (estimate: ModelInputEstimate, call: ModelCallOptions) => {
      assert.ok(estimate.tokens > 1); assert.ok(estimate.bytes > 1);
      assert.ok(estimate.bytes <= configuration.maxRequestBytes);
      if (options.window !== undefined) assert.ok(estimate.tokens + call.maxOutputTokens <= options.window,
        `actual fixture request ${estimate.tokens}+${call.maxOutputTokens} exceeds window ${options.window}`);
    };
    // Only a per-open loop guard: IDs and fact bodies always come from the current model packet.
    const recalls = new Map<string, { find: boolean; get: boolean }>();
    const object = (value: Json | undefined): Record<string, Json> | null =>
      value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
    const recallEvidence = (input: AgentTurnInput, call: ModelCallOptions): AgentTurnResult | null => {
      const packet = input.packet, wanted = entryIds(options.scenario);
      if (!(packet.contextView && packet.contextView.omitted.evidence > 0) || packet.readCollections?.length) return null;
      const guard = recalls.get(packet.workId) ?? { find: false, get: false };
      recalls.set(packet.workId, guard);
      const sourceIds = wanted.map(id => `${options.scenario === 'nonfinal' ? 'observation' : 'document'}:${id}`);
      const known = new Map<string, string>();
      const card = (id: unknown, sourceId: unknown, coverage: unknown) => {
        if (typeof id !== 'string' || typeof sourceId !== 'string' || !sourceIds.includes(sourceId) || coverage !== 'complete') return;
        const prior = known.get(sourceId); assert.ok(prior === undefined || prior === id, 'ambiguous fixture evidence source');
        known.set(sourceId, id);
      };
      for (const value of packet.evidence) if (value.status === 'accepted') card(value.id, value.sourceId, value.coverage);
      for (const value of packet.evidenceReferences ?? []) if (value.status === 'accepted') card(value.id, value.sourceId, value.coverage);
      for (const observation of packet.toolObservations ?? []) {
        if (observation.toolId !== 'core.evidence.find' || observation.toolVersion !== '1' ||
            observation.status !== 'success' || observation.representation !== 'full' ||
            observation.input?.query !== 'collection.record' || observation.input?.limit !== wanted.length) continue;
        const output = object(observation.output);
        if (!output || output.hasMore !== false || output.truncated !== false || !Array.isArray(output.cards)) continue;
        for (const value of output.cards) { const found = object(value); if (found) card(found.id, found.sourceId, found.coverage); }
      }
      const permitted = (id: string) => call.tools.find(tool => tool.id === id && tool.provider === 'core' &&
        tool.version === '1' && tool.effect === 'read' && tool.destination === 'local');
      let tasks: TaskSpec[];
      if (sourceIds.every(id => known.has(id)) && permitted('core.evidence.get') && !guard.get) {
        guard.get = true;
        // Read all requested items together so every final fact is protected by an actual get.
        tasks = sourceIds.map((sourceId, index) => ({ id: `collection-evidence-get-${index}`, description: '현재 저장 근거의 값을 다시 읽는다.',
          toolId: 'core.evidence.get', toolVersion: '1', input: { evidenceId: known.get(sourceId)!, detail: 'evidence', maxBytes: 4096 },
          effect: 'read', dependsOn: [], satisfies: [], maxAttempts: 1 }));
      } else if (!sourceIds.every(id => known.has(id)) && permitted('core.evidence.find') && !guard.find && !guard.get) {
        guard.find = true;
        tasks = [{ id: 'collection-evidence-find', description: '현재 허용된 collection 근거의 실제 ID를 찾는다.',
          toolId: 'core.evidence.find', toolVersion: '1', input: { query: 'collection.record', limit: wanted.length },
          effect: 'read', dependsOn: [], satisfies: [], maxAttempts: 1 }];
      } else return null;
      return { kind: 'plan', proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision,
        basePlanRevision: packet.plan?.revision ?? 0, reason: '문맥에서 생략된 근거를 기존 로컬 읽기 도구로 확인한다.', tasks, hypotheses: [] } };
    };
    const turn: StructuredAgentTurnAdapter = new StructuredAgentTurnAdapter({ ...configuration, profile }, { async invoke(request) {
      const input = request.input, packet = input.packet, session = packet.session;
      const raw = session?.entries.find(entry => entry.role === 'user' && entry.workId === packet.workId &&
        entry.sourceId === session.basis.input.messageId && entry.sequence === session.basis.input.sequence);
      assert.ok(raw && [COLLECTION_ENTRY_TEXT, COLLECTION_ENTRY_TAIL, COLLECTION_ENTRY_RESUME_TEXT].includes(raw.text), 'only exact fixture inputs are accepted');
      const wanted = entryIds(options.scenario);
      const evidence = wanted.map(id => packet.evidence.find(value => value.facts['collection.record'] === id &&
        value.status === 'accepted' && value.coverage === 'complete' && value.scope === packet.goal.scope && typeof value.facts.value === 'number'));
      let result: AgentTurnResult;
      if (evidence.every(value => value !== undefined)) {
        const values = evidence.map(value => value!.facts.value as number);
        result = { kind: 'answer', text: `[합성 collection 결과] ${wanted.map((id, index) => `${id}=${values[index]}`).join(', ')}; 합계=${values.reduce((a, b) => a + b, 0)}.`,
          evidenceIds: evidence.map(value => value!.id), assessment: { type: 'model_self_review', verdict: 'satisfied',
            rationale: '정확한 합성 입력의 모든 항목이 현재 채택된 근거에 있다.', missing: [], counterarguments: [] } };
      } else {
        const tip = packet.readCollections?.find(value => value.progress.successorAttemptId === null &&
          ['failed', 'partial'].includes(value.attemptStatus));
        const original = tip ? packet.plan?.tasks.find(task => task.id === tip.taskId && task.toolId === 'fixture.collection') : undefined;
        const active = request.options.tools.find(tool => tool.id === 'fixture.collection');
        if (tip && original && (tip.resumeMode === 'stored_complete' || active)) {
          assert.deepEqual(original.input, { ids: wanted });
          if (mode === 'stored_only') assert.equal(tip.resumeMode, 'stored_complete');
          const task: TaskSpec = { ...structuredClone(original), id: `resume-${tip.attemptId}`, dependsOn: [], maxAttempts: 1,
            readResume: { attemptId: tip.attemptId, checkpointId: tip.progress.head.id } };
          result = { kind: 'plan', proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision,
            basePlanRevision: packet.plan?.revision ?? 0, reason: '현재 원 task/query/head를 명시적으로 이어 읽는다.', tasks: [task], hypotheses: [] } };
        } else result = recallEvidence(input, request.options) ??
          { kind: 'question', question: '현재 항목의 원 자료와 재개 가능한 계약을 확인해야 합니다.' };
      }
      const estimate = turn.estimateTurnInput(input, request.options); checkSize(estimate, request.options);
      log({ kind: 'turn', input: structuredClone(input), options: structuredClone(request.options), estimate, result: structuredClone(result) });
      return { provider: identity.provider, model: identity.model, finish: 'stop', content: JSON.stringify(result), usage: { inputTokens: 200, outputTokens: 50 } };
    } });
    const compact: StructuredSessionCompactAdapter = new StructuredSessionCompactAdapter(configuration, { async invoke(request, signal) {
      const estimate = compact.estimateCompactInput(request.compact, request.options); checkSize(estimate, request.options);
      const reply = await compactFixture.compact(request.compact, signal, request.options);
      assert.equal(reply.status, 'ok'); if (reply.status !== 'ok') throw new Error('collection_compact_fixture_refused');
      log({ kind: 'compact', input: structuredClone(request.compact), options: structuredClone(request.options), estimate, candidate: reply.candidate });
      return { provider: identity.provider, model: identity.model, finish: 'stop', content: JSON.stringify(reply.candidate), usage: { inputTokens: 120, outputTokens: 30 } };
    } });
    return { planner: new StructuredAgentModel(turn, compact), inputLimits: { maxInputBytes: 131072, maxOutputTokens: 2048 }, async close() {} };
  } }]]), tools: { async open(context, assembly) {
    assert.ok(assembly); log({ kind: 'open', mode });
    const state = assembly.custody.state;
    const forwarded: StateRepository = barrier ? new Proxy(state, { get(target, property) {
      if (property === 'commit') return async (request: Commit) => {
        const result = await target.commit(request);
        if (result.kind === 'committed' && request.events.some(event => event.type === 'mcp_collection_response_recorded'))
          await barrier(assembly, request, result);
        return result;
      };
      const value: unknown = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } }) : state;
    const opened = await registration.open(context, { ...assembly, custody: { ...assembly.custody, state: forwarded } });
    return { ...opened, collectionTools: opened.collectionTools!.map(value => ({ ...value,
      source: { ...value.source, async fetch(...args: Parameters<typeof value.source.fetch>) {
        log({ kind: 'fetch', requestId: args[1].requestId }); return value.source.fetch(...args);
      } } })) };
  } } };
}

export interface CollectionEntryMarker {
  schemaVersion: 1; kind: 'raw-receipt' | 'adopted-partial'; workerPid: number; peerPid: number;
  options: CollectionEntryOptions; workId: string; scope: SessionScope; conversationId: string; channel: 'cli' | 'web';
  attemptId: string; task: TaskSpec; raw: ArtifactRef; responseCommandId: string; originalHead: ArtifactRef;
  original: WorkState; calibration: { requiredTokens: number; selectedTokens: number; inputLimit: number; window: number } | null;
}
export async function readEntry(marker: Pick<CollectionEntryMarker, 'options' | 'workId' | 'attemptId' | 'scope' | 'raw' | 'originalHead' | 'responseCommandId'>) {
  const stores = await openAgentStores(new FileAgentProfileStore(runtimeRoot), marker.options.directory, undefined, mcpFixtureIdentityOptions(marker.options));
  try {
    const state = await stores.state.get(marker.workId); assert.ok(state);
    const receipts = await Promise.all([`dispatch:${marker.attemptId}`, marker.responseCommandId,
      `read:${marker.attemptId}:${marker.originalHead.id}`].map(id => stores.state.receipt(marker.workId, id)));
    const dispatches = await Promise.all(state.attempts.map(async attempt => ({ id: attempt.id,
      receipt: await stores.state.receipt(marker.workId, `dispatch:${attempt.id}`) })));
    const input = await stores.sessions.input(marker.scope, 'original-request');
    const latestInput = await stores.sessions.input(marker.scope, state.conversation!.session!.input.messageId);
    const modelInputs = await Promise.all(state.modelCalls.map(async call => ({ id: call.id,
      value: JSON.parse(new TextDecoder().decode(await stores.artifacts.get(call.inputArtifact, state.policy))) as unknown })));
    const reader = new ReadCheckpointReader(state, stores.artifacts, new Sha256Digester());
    const checkpoints = await Promise.all(state.attempts.filter(attempt => attempt.readProgress).map(async attempt => ({ id: attempt.id,
      checkpoint: await reader.load(attempt.readProgress!.head) })));
    const results = await Promise.all(state.attempts.filter(attempt => attempt.resultArtifact).map(async attempt => ({ id: attempt.id,
      result: ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await stores.artifacts.get(attempt.resultArtifact!, state.policy)))) })));
    return { state, receipts, dispatches, input, latestInput, history: await stores.sessions.history(marker.scope, state.policy, { limit: 100 }),
      rawBytes: Array.from(await stores.artifacts.get(marker.raw, state.policy)),
      headBytes: Array.from(await stores.artifacts.get(marker.originalHead, state.policy)), modelInputs, checkpoints, results,
      events: await stores.state.events(marker.workId, 0) };
  } finally { await stores.close(); }
}
