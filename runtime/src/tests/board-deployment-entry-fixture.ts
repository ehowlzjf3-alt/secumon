import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_REQUEST_TOOLS, BOARD_WRITE_TOOLS } from '../application/board-commands.js';
import { BoardReadPageSchema, BoardRequestPageSchema } from '../application/board-contracts.js';
import { BOARD_READ_TOOL } from '../application/board-tools.js';
import { BOARD_REQUEST_READ_TOOL } from '../application/board-request-tools.js';
import { BoardWorkSourceRegistry } from '../application/board-work-source-registry.js';
import type { AgentTurnInput } from '../application/agent-turn-types.js';
import type { Tool } from '../application/ports.js';
import type { AgentTurnResult } from '../domain/agent-turn.js';
import type { BoardActor } from '../domain/board.js';
import type { ContextPacket, Evidence, Json, Policy, TaskSpec } from '../domain/model.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { SqliteBoardRepository } from '../infrastructure/sqlite-board.js';
import { StructuredAgentTurnAdapter } from '../infrastructure/structured-agent-turn.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { createLocalHostBoard } from '../presentation/host-board.js';
import type { AgentExecutionHost } from '../presentation/host-tools.js';

export const BOARD = 'shared-discussion', ENTITY = 'delivery-record', TENANT = 'board-deployment';
export const SOURCE_TOOL = 'deployment.document.read';
const PROFILE = 'board-deployment-model';
const engine = fileURLToPath(new URL('../../', import.meta.url));
const boardTools = [BOARD_READ_TOOL, BOARD_REQUEST_READ_TOOL, ...BOARD_WRITE_TOOLS, ...BOARD_REQUEST_TOOLS];
export const specs = [{ key: 'a', principalId: 'records-reader', roleId: 'records-role', purpose: '원본 일정과 질문을 확인한다.',
  source: '자료 담당의 원본: 배송 확인값은 17입니다.' },
{ key: 'b', principalId: 'conditions-reader', roleId: 'conditions-role', purpose: '원본 승인 조건과 질문을 확인한다.',
  source: '조건 담당의 원본: 승인 확인값은 29입니다.' }] as const;
export type EntryMode = 'question' | 'optional_reply' | 'request' | 'accept' | 'publish' | 'observe' | 'repeat_read';
type Spec = typeof specs[number];
type Observed = { inputs: AgentTurnInput[]; reads: { workId: string; attemptId: string }[]; modelCloses: number; toolCloses: number };
type Opened = { profile: AgentTurnProfile; observed: Observed; close(): Promise<void> };

export function entryText(mode: EntryMode, recipient = specs[0].roleId as string) {
  return JSON.stringify({ mode, boardId: BOARD, entityId: ENTITY, recipient,
    instruction: '현재 등록 원본을 읽고 게시판에서 질문 또는 인용 답글을 처리한다. 일반 답글은 선택이며 명시 요청의 답변은 요청자 확인까지 기다린다.' });
}

function object(value: Json | undefined): Record<string, Json> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** The fixture transport sees only the normal model packet, never a repository or another agent's state. */
function nextTurn(packet: ContextPacket, spec: Spec): AgentTurnResult {
  const input = JSON.parse(packet.goal.description) as { mode: EntryMode; boardId: string; entityId: string; recipient: string };
  assert.equal(input.boardId, BOARD); assert.equal(input.entityId, ENTITY);
  const observations = packet.toolObservations ?? [];
  assert.ok(observations.every(value => value.status === 'success'), 'ordinary tool failures must remain visible');
  const last = (toolId: string) => observations.findLast(value => value.toolId === toolId);
  const index = (toolId: string) => observations.findLastIndex(value => value.toolId === toolId);
  const read = last(BOARD_READ_TOOL), requestRead = last(BOARD_REQUEST_READ_TOOL);
  const page = read ? BoardReadPageSchema.parse(read.output) : null;
  const requests = requestRead ? BoardRequestPageSchema.parse(requestRead.output) : null;
  const evidence = packet.evidence.find(value => value.sourceId === SOURCE_TOOL);
  if (evidence) assert.equal(evidence.facts.summary, spec.source);
  const ownPost = page?.posts.find(post => post.workId === packet.workId);
  const published = object(last(BOARD_WRITE_TOOLS[0])?.output) ??
    (ownPost ? { status: 'published', postId: ownPost.id } : null);
  const answer = (text: string): AgentTurnResult => ({ kind: 'answer', text,
    evidenceIds: evidence ? [evidence.id] : [], assessment: { type: 'model_self_review', verdict: 'satisfied',
      rationale: '실제로 반환된 원문과 게시판 처리 결과를 확인했다. 토론을 독립 근거로 승격하지 않는다.', missing: [], counterarguments: [] } });
  type Choice = { toolId: string; input: Record<string, Json> };
  const plan = (...choices: Choice[]): AgentTurnResult => ({ kind: 'plan', proposal: {
    baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
    reason: '관측한 게시판 ID와 revision으로 다음 한 단계를 처리한다.', hypotheses: [], tasks: choices.map((choice, position): TaskSpec => {
      assert.ok(packet.activeToolIds.includes(choice.toolId), `required tool is visible: ${choice.toolId}`);
      return { ...choice, id: `step-${packet.stateRevision}-${position + 1}`, description: choice.toolId,
        toolVersion: '1', effect: boardTools.includes(choice.toolId) && choice.toolId !== BOARD_READ_TOOL && choice.toolId !== BOARD_REQUEST_READ_TOOL ? 'write' : 'read',
        dependsOn: position ? [`step-${packet.stateRevision}-${position}`] : [], maxAttempts: 1, satisfies: [] };
    }),
  } });
  const readBoard: Choice = { toolId: BOARD_READ_TOOL, input: { boardId: input.boardId, maxPosts: 20, maxBytes: 32768 } };
  const readRequests: Choice = { toolId: BOARD_REQUEST_READ_TOOL, input: { boardId: input.boardId, maxRequests: 20, maxBytes: 32768 } };
  const ownSource: Choice = { toolId: SOURCE_TOOL, input: { document: 'current' } };
  const commandRevision = (toolId: string) => {
    const output = object(last(toolId)?.output);
    if (output?.revision === undefined) return 0; // Historical results still require a revision refresh.
    assert.equal(output.boardId, input.boardId);
    assert.ok(typeof output.revision === 'number' && Number.isSafeInteger(output.revision) && output.revision > 0);
    return output.revision;
  };
  const revision = () => {
    const value = Math.max(page?.revision ?? 0, requests?.revision ?? 0,
      ...[...BOARD_WRITE_TOOLS, ...BOARD_REQUEST_TOOLS].map(commandRevision));
    assert.ok(value > 0); return value;
  };
  const publish = (kind: 'question' | 'observation', replyTo: string | null): AgentTurnResult => {
    assert.ok(evidence, 'the author must have read its own original');
    return plan({ toolId: BOARD_WRITE_TOOLS[0], input: { boardId: input.boardId, expectedRevision: revision(),
      id: `${kind === 'question' ? 'question' : 'post'}-${packet.workId}`, entityId: input.entityId, kind,
      body: kind === 'question' ? `이 원본에 관해 확인해 줄 수 있나요? ${String(evidence.facts.summary)}` : String(evidence.facts.summary),
      labels: ['synthetic'], evidenceIds: [evidence.id], quotedPostIds: [], replyTo,
      relation: replyTo ? 'clarifies' : null, causeId: `cause-${packet.workId}`, expiresAt: null } });
  };
  const command = (toolId: string, fields: Record<string, Json>) => plan({ toolId,
    input: { boardId: input.boardId, expectedRevision: revision(), ...fields } });

  if (input.mode === 'repeat_read') {
    assert.equal(observations.length, 0, 'one finite plan must hit the unchanged-read guard before another model turn');
    return plan(...Array.from({ length: 8 }, () => readBoard));
  }
  if (input.mode === 'observe') {
    if (!page) return plan(readBoard);
    return answer(`허용된 현재 게시물 ${page.posts.length}개를 읽었다. 토론은 독립 근거가 아니다.`);
  }
  if (['question', 'publish', 'request'].includes(input.mode)) {
    const obligation = input.mode === 'request' ? packet.obligations.find(value => value.source?.provider === 'board' && value.source.role === 'requester') : undefined;
    if (obligation) {
      // Persistent coordination metadata survives omission of the earlier offer/confirm observations.
      if (obligation.status === 'satisfied') return answer('인용 답글을 읽고 요청자로 확인했다.');
      assert.equal(obligation.reason, 'agent_request_answered', 'offered/accepted requests must wait without calling the model');
      const request = requests?.requests.find(value => value.id === obligation.source!.externalId);
      if (!request || request.status !== 'answered') return plan(readRequests);
      if (!page?.posts.some(post => post.id === request.answerPostId) || !page.posts.some(post => post.id === request.questionId)) return plan(readBoard);
      return command(BOARD_REQUEST_TOOLS[3], { requestId: request.id });
    }
    if (!page) return plan(readBoard, ownSource);
    assert.ok(evidence);
    if (!published) return publish(input.mode === 'publish' ? 'observation' : 'question', null);
    assert.equal(published.status, 'published');
    if (input.mode !== 'request') return answer(input.mode === 'question' ? '질문을 게시했다. 답글은 선택이다.' : String(evidence.facts.summary));
    if (!last(BOARD_REQUEST_TOOLS[0])) {
      if (!commandRevision(BOARD_WRITE_TOOLS[0]) && index(BOARD_REQUEST_READ_TOOL) < index(BOARD_WRITE_TOOLS[0])) return plan(readRequests);
      assert.equal(typeof published.postId, 'string'); assert.ok(packet.execution);
      return command(BOARD_REQUEST_TOOLS[0], { id: `request-${packet.workId}`, questionId: published.postId!,
        toAgentId: input.recipient, deliverable: '현재 자기 원본을 인용한 답글과 요청자 확인', dueAt: packet.execution.deadlineAt - 1 });
    }
    assert.fail('a confirmed offer must have a requester obligation');
  }
  if (input.mode === 'optional_reply') {
    if (!page) return plan(readBoard);
    const question = page.posts.find(post => post.kind === 'question' && post.authorId !== page.roleId); assert.ok(question);
    if (!evidence) return plan(ownSource);
    if (!published) return publish('observation', question.id);
    return answer(String(evidence.facts.summary));
  }
  assert.equal(input.mode, 'accept');
  const obligation = packet.obligations.find(value => value.source?.provider === 'board' && value.source.role === 'assignee');
  if (obligation?.status === 'satisfied') {
    assert.ok(evidence);
    return answer(String(evidence.facts.summary));
  }
  if (published && commandRevision(BOARD_WRITE_TOOLS[0]) && obligation) {
    // The accepted request identity and this publication's receipt suffice for the next CAS command.
    assert.equal(obligation.reason, 'agent_request_accepted', 'an answered request must wait for confirmation');
    assert.equal(typeof published.postId, 'string');
    return command(BOARD_REQUEST_TOOLS[2], { requestId: obligation.source!.externalId, postId: published.postId! });
  }
  if (!requests) return plan(readRequests);
  const request = requests.requests.find(value => value.toAgentId === requests.roleId); assert.ok(request, 'request ID comes from a participant read');
  if (request.acceptedWorkId !== packet.workId && !last(BOARD_REQUEST_TOOLS[1])) {
    assert.equal(request.status, 'offered');
    if (!page?.posts.some(post => post.id === request.questionId)) return plan(readBoard);
    return command(BOARD_REQUEST_TOOLS[1], { requestId: request.id });
  }
  if (last(BOARD_REQUEST_TOOLS[2])) {
    assert.equal(packet.obligations.find(value => value.source?.role === 'assignee')?.status, 'satisfied', 'answering alone must wait for confirmation');
    return answer(String(evidence!.facts.summary));
  }
  if (!evidence) return plan(ownSource);
  if (!commandRevision(BOARD_REQUEST_TOOLS[1]) &&
    (request.acceptedWorkId !== packet.workId || index(BOARD_REQUEST_READ_TOOL) < index(BOARD_REQUEST_TOOLS[1]))) return plan(readRequests);
  if (!published) return publish('observation', request.questionId);
  if (!commandRevision(BOARD_WRITE_TOOLS[0]) && index(BOARD_REQUEST_READ_TOOL) < index(BOARD_WRITE_TOOLS[0])) return plan(readRequests);
  assert.equal(typeof published.postId, 'string');
  return command(BOARD_REQUEST_TOOLS[2], { requestId: request.id, postId: published.postId! });
}

export function boardDeploymentFixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'board-deployment-entry-'))), identityRegistryDirectory = join(base, 'identity-registry');
  const profiles = new FileAgentProfileStore(engine), registry = new BoardWorkSourceRegistry();
  const ready = specs.map(spec => {
    const value = profiles.initialize(join(base, spec.key), { name: spec.principalId, purpose: spec.purpose, stateBackend: 'sqlite', personalMemory: 'sqlite' });
    writeFileSync(join(value.root, 'config.json'), JSON.stringify({ ...value.config, model: { profile: PROFILE }, skills: { mode: 'off' },
      features: { board: true, archive: false, peers: false, missions: false, a2a: false } }), { mode: 0o600 });
    return value;
  });
  const actors: BoardActor[] = specs.map(spec => ({ tenantId: TENANT, principalId: spec.principalId,
    allowedScopes: ['shared-board', ...ready.map(value => `agent:${value.identity.agentId}`)], allowedLabels: ['synthetic'],
    allowedNamespaces: ['team', 'local', 'personal'], canPublish: true, canReview: false, canManageBoards: true }));
  const boardPath = join(base, 'board.sqlite'), repository = new SqliteBoardRepository(boardPath), opened = new Set<Opened>();
  t.after(async () => {
    const errors: unknown[] = [];
    for (const value of opened) try { await value.close(); } catch (error) { errors.push(error); }
    try { await repository.close(); } catch (error) { errors.push(error); }
    try { rmSync(base, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'board_deployment_cleanup_failed');
  });
  async function open(which: 0 | 1): Promise<Opened> {
    const spec = specs[which], observed: Observed = { inputs: [], reads: [], modelCloses: 0, toolCloses: 0 };
    const identity = { provider: 'local-fixture', model: 'board-entry', revision: '1' };
    const host: AgentExecutionHost = { identityRegistryDirectory,
      board: createLocalHostBoard({ backend: 'sqlite', path: boardPath, allowWrites: true, allowedTools: boardTools,
        actors: { current: async () => structuredClone(actors[which]!) }, authority: { resolve: async owner => {
          const actor = actors.find(value => value.tenantId === owner.tenantId && value.principalId === owner.principalId);
          if (!actor) return null;
          // Board administration is not part of the strict source-knowledge actor contract.
          const { canManageBoards: _manage, ...trusted } = actor;
          return structuredClone(trusted);
        } }, workSources: registry }),
      models: new Map([[PROFILE, { execution: 'deterministic_fixture', async open(profile) {
        assert.equal(profile.purpose, spec.purpose);
        const calls = new Map<string, number>();
        const planner = new StructuredAgentTurnAdapter({ identity, profile, destination: 'local', maxRequestBytes: 524288,
          capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 200000, maxOutputTokens: 4096 } }, {
          async invoke(request) {
            observed.inputs.push(structuredClone(request.input)); const id = request.input.packet.workId;
            const count = (calls.get(id) ?? 0) + 1; calls.set(id, count); assert.ok(count <= 16, 'finite board tool loop');
            const result = nextTurn(request.input.packet, spec);
            return { provider: identity.provider, model: identity.model, finish: 'stop', content: JSON.stringify(result), usage: { inputTokens: 200, outputTokens: 80 } };
          },
        });
        return { planner, inputLimits: { maxInputBytes: 524288, maxOutputTokens: 4096 }, async close() { observed.modelCloses++; } };
      } }]]),
      tools: { async open(context, assembly) {
        assert.ok(assembly);
        const policy: Policy = { tenantId: TENANT, principalId: spec.principalId, allowWrites: false,
          allowedTools: [SOURCE_TOOL], allowedLabels: ['synthetic'], allowedDestinations: ['local'] };
        const tool: Tool = { definition: { provider: 'deployment', id: SOURCE_TOOL, version: '1', description: spec.purpose,
          effect: 'read', destination: 'local', labels: ['synthetic'],
          inputSchema: { type: 'object', properties: { document: { const: 'current' } }, required: ['document'], additionalProperties: false },
          outputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } },
          async execute(_task, invocation) {
            assert.ok(invocation.authorize); await invocation.authorize();
            observed.reads.push({ workId: invocation.workId, attemptId: invocation.attemptId });
            const artifact = await assembly.custody.artifacts.put(new TextEncoder().encode(spec.source),
              { tenantId: TENANT, labels: ['synthetic'], mediaType: 'text/plain' });
            await invocation.authorize(); const now = assembly.custody.clock.now();
            const evidence: Evidence = { id: `original-${invocation.workId}`, tenantId: TENANT, scope: context.scope,
              sourceId: SOURCE_TOOL, lineageId: `${context.agentId}:${invocation.workId}`, locator: `fixture://${context.agentId}/current`,
              observedAt: now, recordedAt: now, labels: ['synthetic'], coverage: 'complete', status: 'accepted',
              supersedes: [], derivedFrom: [], facts: { summary: spec.source }, artifact };
            return { resultId: `${invocation.attemptId}:result`, attemptId: invocation.attemptId, status: 'success', effectState: 'none',
              evidence: [evidence], artifacts: [artifact], output: { summary: spec.source }, error: null, cursor: null, coverage: 'complete' };
          } };
        return { tools: [tool], policy, limits: { toolCalls: 24, modelCalls: 24, tokens: 2000000, replans: 20, wallTimeMs: 1800000 },
          async close() { observed.toolCloses++; } };
      } },
    };
    const profile = await openAgentTurnProfile(ready[which]!.root, { provider: 'registered' }, host);
    let unregister: (() => void) | undefined;
    try {
      assert.ok(actors[which]!.allowedScopes.includes(profile.scope));
      assert.ok(profile.boardWorkSource); unregister = registry.register({ tenantId: TENANT, principalId: spec.principalId }, profile.boardWorkSource);
    }
    catch (error) { try { await profile.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'board_source_registration_cleanup_failed'); } throw error; }
    let closing: Promise<void> | undefined;
    const result: Opened = { profile, observed, close() {
      return closing ??= (async () => { unregister!(); await profile.close(); opened.delete(result); })();
    } };
    opened.add(result); return result;
  }
  async function setup(profile: AgentTurnProfile) {
    assert.ok(profile.board);
    await profile.board.create({ id: BOARD, commandId: 'create-board', namespace: 'team', scope: 'shared-board', labels: ['synthetic'],
      roles: specs.map(spec => ({ id: spec.roleId, principalId: spec.principalId, purpose: spec.purpose, active: true })),
      limits: { maxPosts: 20, maxReplies: 5, maxUnproductiveReplies: 3, maxRequests: 5 } });
    await profile.board.addEntity({ boardId: BOARD, commandId: 'add-entity', expectedRevision: 1,
      entity: { id: ENTITY, authority: 'fixture', key: 'delivery', kind: 'document', title: '공동 확인 대상', validFrom: 0, validThrough: null } });
  }
  return { base, profiles, ready, actors, registry, repository, open, setup };
}

export async function acceptEntry(opened: Opened, mode: EntryMode, messageId: string, sessionId?: string, recipient?: string, conversationId = 'board-entry') {
  const profile = opened.profile;
  const session = await profile.sessions.open(profile.actor, { channel: 'test', conversationId, ...(sessionId ? { sessionId } : {}) });
  return profile.turns.accept(profile.actor, { sessionId: session.scope.sessionId, messageId, rawText: entryText(mode, recipient), mode: 'auto',
    binding: { ...profile.executionActor, channel: 'test', conversationId, recipientId: profile.actor.principalId, destination: 'local' },
    scope: profile.scope, policy: profile.policy, limits: profile.limits });
}

export async function runEntry(opened: Opened, workId: string) {
  const result = await opened.profile.workflow.run(workId, opened.profile.actor, { maxSteps: 100 });
  const state = await opened.profile.runtime.state(workId);
  assert.ok(['complete', 'wait'].includes(result.control.kind), JSON.stringify({ control: result.control,
    status: state.status, reason: state.statusReason,
    progress: state.progress && { productiveSteps: state.progress.productiveSteps, unproductiveSteps: state.progress.unproductiveSteps,
      consecutiveUnproductive: state.progress.consecutiveUnproductive },
    attempts: state.attempts.map(value => ({ taskId: value.taskId, toolId: value.toolId, status: value.status, error: value.error })),
    models: state.modelCalls.map(value => ({ status: value.status, reason: value.reason, outcome: value.outcome })),
    recentInputs: opened.observed.inputs.filter(value => value.packet.workId === workId).slice(-4).map(({ packet }) => ({
      stateRevision: packet.stateRevision, planRevision: packet.plan?.revision, activeTools: packet.activeToolIds,
      evidenceIds: packet.evidence.map(value => value.id),
      observations: (packet.toolObservations ?? []).map(value => {
        const output = object(value.output), requests = BoardRequestPageSchema.safeParse(value.output);
        return { taskId: value.taskId, toolId: value.toolId, representation: value.representation,
          status: value.status, outputStatus: output?.status, boardRevision: output?.revision,
          ...(requests.success ? { requests: requests.data.requests.map(request => ({ id: request.id, status: request.status, effectiveStatus: request.effectiveStatus })) } : {}) };
      }),
    })) }));
  return { result, state, deliveries: await opened.profile.services.state.deliveries(workId) };
}
