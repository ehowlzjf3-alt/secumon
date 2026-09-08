import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentTurnInput } from '../application/agent-turn-types.js';
import { HostBudgetLedgerRouter, budgetWorkAddress } from '../application/budget-work-ledgers.js';
import { BUDGET_TOOL_IDS } from '../application/budget-tools.js';
import { ToolResultSchema } from '../application/contracts.js';
import { asJson } from '../application/plan-validator.js';
import type { ModelIdentity, Tool } from '../application/ports.js';
import type { BudgetAuthorityBinding } from '../application/budget-authority.js';
import type { AgentTurnResult } from '../domain/agent-turn.js';
import type { ArtifactRef, ContextPacket, Json, Limits, PlanProposal, Policy, TaskSpec } from '../domain/model.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { StructuredAgentTurnAdapter } from '../infrastructure/structured-agent-turn.js';
import { StructuredPlannerAdapter } from '../infrastructure/structured-planner.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import type { AgentExecutionHost } from '../presentation/host-tools.js';
import type { RegisteredTurnPlanner } from '../presentation/host-models.js';
import { initial } from './state-conformance-helpers.js';

export type BudgetEntryRole = 'sponsor' | 'recipient';
export type BudgetEntryOperation = 'status' | 'allocate' | 'run' | 'increase' | 'request' | 'return' | 'revoke' | 'reconcile';
export interface BudgetEntryStep { operation: BudgetEntryOperation; input(packet: ContextPacket): Record<string, Json>; maxAttempts?: number }
export const BUDGET_ENTRY_SOURCE = 'fixture.budget-source.read';
export const BUDGET_ENTRY_REQUEST = 'Use the explicitly registered recipient to check its own original and settle only measured resource usage.';
export const BUDGET_ENTRY_SECRET = 'RECIPIENT_RAW_ONLY: available in the recipient source; never a sponsor observation.';
export const BUDGET_ENTRY_EXTRA = { toolCalls: 1, modelCalls: 0, tokens: 0, replans: 0 };
export const BUDGET_ENTRY_REQUEST_REASON = 'RECIPIENT_PRIVATE_REASON: one additional local operation is requested.';
export const BUDGET_ENTRY_CHILD_LIMITS: Limits = { toolCalls: 4, modelCalls: 3, tokens: 50000, replans: 3, wallTimeMs: 60000 };
// These are the existing ordinary profile limits, fixed before intake. Tests never raise them to avoid a gate.
const limits: Limits = { toolCalls: 30, modelCalls: 16, tokens: 1000000, replans: 8, wallTimeMs: 3600000 };
const profileName = 'budget-entry-v1';
const roles = ['sponsor', 'recipient'] as const;

export function budgetObject(value: Json | undefined): Record<string, Json> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'an actual structured tool result is required');
  return value;
}
export function budgetOutput(packet: ContextPacket, operation: BudgetEntryOperation): Record<string, Json> {
  const found = [...(packet.toolObservations ?? [])].reverse().find(item => item.toolId === 'core.budget.' + operation && item.status === 'success');
  assert.ok(found, `the model must observe core.budget.${operation} before using its identifiers`);
  return budgetObject(found.output);
}
export function budgetGrantId(packet: ContextPacket): string {
  for (const item of [...(packet.toolObservations ?? [])].reverse()) {
    if (item.status !== 'success' || !item.toolId.startsWith('core.budget.')) continue;
    const output = budgetObject(item.output), grant = output['grant'];
    const candidate = output['grantId'] ?? (grant && typeof grant === 'object' && !Array.isArray(grant) ? grant['id'] : undefined);
    if (typeof candidate === 'string') return candidate;
    const grants = output['grants'];
    if (Array.isArray(grants) && grants.length === 1) {
      const id = budgetObject(grants[0])['id']; if (typeof id === 'string') return id;
    }
  }
  throw new Error('budget_fixture_visible_grant_required');
}
export const budgetStatus: BudgetEntryStep = { operation: 'status', input: () => ({}) };
export function budgetAllocate(selectedLimits: Limits = BUDGET_ENTRY_CHILD_LIMITS): BudgetEntryStep {
  return { operation: 'allocate', input(packet) {
    const recipients = budgetOutput(packet, 'status')['recipients']; assert.ok(Array.isArray(recipients));
    const recipient = recipients.map(value => budgetObject(value)).find(value => value['id'] === 'reviewer'); assert.ok(recipient);
    assert.equal(typeof recipient['scope'], 'string');
    return { recipientId: recipient['id']!, goal: asJson({ ...initial().goal, scope: recipient['scope'],
      description: 'Read the recipient original and verify availability.' }), limits: asJson(selectedLimits) };
  } };
}
export const budgetRun: BudgetEntryStep = { operation: 'run', input: packet => ({ grantId: budgetGrantId(packet), maxSteps: 20 }) };
export const budgetReconcile: BudgetEntryStep = { operation: 'reconcile', input: packet => ({ grantId: budgetGrantId(packet) }) };
export const budgetRevoke: BudgetEntryStep = { operation: 'revoke', input: packet => ({ grantId: budgetGrantId(packet) }) };
export const budgetIncrease: BudgetEntryStep = { operation: 'increase', input(packet) {
  const requests = budgetOutput(packet, 'status')['delegatedRequests']; assert.ok(Array.isArray(requests) && requests.length === 1);
  const request = budgetObject(requests[0]); assert.equal(typeof request['grantId'], 'string');
  assert.deepEqual(request['extra'], BUDGET_ENTRY_EXTRA); assert.equal(request['reason'], undefined);
  return { grantId: request['grantId']!, extra: request['extra']! };
} };

function task(id: string, toolId: string, input: Record<string, Json>, satisfies: string[] = [], maxAttempts = 1): TaskSpec {
  return { id, description: 'Perform the explicit resource operation using observed identifiers.', toolId, toolVersion: '1',
    effect: 'read', input, dependsOn: [], maxAttempts, satisfies };
}
function proposal(packet: ContextPacket, selected: TaskSpec): PlanProposal {
  return { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision,
    basePlanRevision: packet.plan?.revision ?? 0, reason: 'Execute the next bounded resource operation.', tasks: [selected], hypotheses: [] };
}
function sponsorTurn(input: AgentTurnInput, steps: readonly BudgetEntryStep[]): AgentTurnResult {
  const packet = input.packet;
  // The current packet supplies completed operation IDs. A fresh process can choose the same next step.
  const completed = (packet.toolObservations ?? []).map(item => /^budget-step-(\d+)$/.exec(item.taskId))
    .filter((value): value is RegExpExecArray => value !== null).map(value => Number(value[1]));
  const index = completed.length ? Math.max(...completed) : 0;
  assert.ok(index <= steps.length, 'the bounded script cannot advance beyond its observed results');
  const selected = steps[index];
  if (!selected) return { kind: 'answer', text: 'The requested resource operations are recorded; recipient source material remains private.', evidenceIds: [],
    assessment: { type: 'model_self_review', verdict: 'satisfied', rationale: 'Only actual ledger tool observations are reported.', missing: [], counterarguments: [] } };
  assert.ok(packet.activeToolIds.includes('core.budget.' + selected.operation));
  return { kind: 'plan', proposal: proposal(packet, task(`budget-step-${index + 1}`, 'core.budget.' + selected.operation, selected.input(packet), [], selected.maxAttempts)) };
}

/** Actual independent profile stores and product ledger router; model transports are finite local fixtures. */
export async function budgetToolsEntryFixture(t: TestContext, options: {
  child?: 'read' | 'request' | 'unknown' | 'return' | 'read-then-return';
  compactPlanner?: (role: BudgetEntryRole, identity: ModelIdentity) => Pick<RegisteredTurnPlanner, 'compact' | 'estimateCompactInput'>;
} = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'budget-tools-entry-'))), runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
  const profiles = new FileAgentProfileStore(runtimeRoot), router = new HostBudgetLedgerRouter();
  const directories = { sponsor: join(base, 'sponsor'), recipient: join(base, 'recipient') };
  const initialized = { sponsor: profiles.initialize(directories.sponsor, { stateBackend: 'sqlite', personalMemory: 'sqlite' }),
    recipient: profiles.initialize(directories.recipient, { stateBackend: 'sqlite', personalMemory: 'sqlite' }) };
  for (const role of roles) writeFileSync(join(directories[role], 'config.json'), JSON.stringify({ ...initialized[role].config,
    model: { profile: profileName }, features: { ...initialized[role].config.features, peers: true }, skills: { mode: 'off' } }), { mode: 0o600 });
  const controls = { allocation: true, execution: true, child: options.child ?? 'read', steps: [] as readonly BudgetEntryStep[] };
  const observed = { sponsorInputs: [] as AgentTurnInput[], recipientInputs: [] as ContextPacket[],
    reads: [] as { role: BudgetEntryRole; workId: string; attemptId: string }[],
    approvals: [] as { purpose: 'allocation' | 'execution'; binding: BudgetAuthorityBinding }[],
    runs: [] as { workId: string; maxSteps: number }[], interrupts: [] as string[] };
  const opened = new Map<BudgetEntryRole, AgentTurnProfile>(), rawRefs = new Map<BudgetEntryRole, ArtifactRef>();
  let unregister: Array<() => void> = [];
  const current = (role: BudgetEntryRole) => { const profile = opened.get(role); assert.ok(profile); return profile; };
  function host(role: BudgetEntryRole): AgentExecutionHost {
    const identity = { provider: 'local-fixture', model: 'budget-entry-' + role, revision: '1' };
    const configuration = { identity, destination: 'local', maxRequestBytes: 131072,
      capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000, maxOutputTokens: 2048 } };
    return { identityRegistryDirectory: join(base, 'registry'), budget: { ledgers: router },
      peers: { async open() { return { peers: new Map(), allowedTools: [], async close() {} }; } },
      models: new Map([[profileName, { execution: 'deterministic_fixture', async open(profile) {
        const turn = new StructuredAgentTurnAdapter({ ...configuration, profile }, { async invoke(request) {
          assert.equal(role, 'sponsor'); observed.sponsorInputs.push(structuredClone(request.input));
          return { provider: identity.provider, model: identity.model, finish: 'stop', content: JSON.stringify(sponsorTurn(request.input, controls.steps)),
            usage: { inputTokens: 200, outputTokens: 60 } };
        } });
        const plan = new StructuredPlannerAdapter(configuration, { async invoke(request) {
          assert.equal(role, 'recipient'); observed.recipientInputs.push(structuredClone(request.packet));
          if (controls.child === 'unknown') throw new Error('injected_recipient_transport_response_lost');
          const requested = (request.packet.toolObservations ?? []).some(item => item.toolId === 'core.budget.request' && item.status === 'success');
          const read = (request.packet.toolObservations ?? []).some(item => item.toolId === BUDGET_ENTRY_SOURCE && item.status === 'success');
          const selected = controls.child === 'return' || controls.child === 'read-then-return' && read ? task('recipient-return', 'core.budget.return', {}) :
            controls.child === 'request' && !requested ? task('recipient-request', 'core.budget.request',
            { extra: BUDGET_ENTRY_EXTRA, reason: BUDGET_ENTRY_REQUEST_REASON }) :
            task('recipient-read', BUDGET_ENTRY_SOURCE, {}, ['criterion']);
          assert.ok(request.packet.activeToolIds.includes(selected.toolId));
          return { provider: identity.provider, model: identity.model, finish: 'stop', content: JSON.stringify(proposal(request.packet, selected)),
            usage: { inputTokens: 120, outputTokens: 40 } };
        } });
        // A recipient task has no chat response requirement. The registered host supplies both existing plan and turn adapters.
        const planner: RegisteredTurnPlanner = { identity: turn.identity, destination: turn.destination, capabilities: turn.capabilities,
          prompt: turn.prompt, inputEstimation: turn.inputEstimation, turn: turn.turn.bind(turn), propose: plan.propose.bind(plan),
          estimateTurnInput: turn.estimateTurnInput.bind(turn), estimateInput: plan.estimateInput.bind(plan),
          estimateContextPreview: (preview, call) => preview.turn ? turn.estimateContextPreview(preview, call) : plan.estimateContextPreview(preview, call),
          ...(options.compactPlanner?.(role, identity) ?? {}) };
        return { planner, inputLimits: { maxInputBytes: 131072, maxOutputTokens: 2048 }, async close() {} };
      } }]]),
      tools: { async open(context, assembly) {
        assert.ok(assembly);
        const policy: Policy = { tenantId: 'company', principalId: 'same-operator', allowWrites: false,
          allowedTools: role === 'recipient' ? [BUDGET_ENTRY_SOURCE] : [], allowedLabels: ['public'], allowedDestinations: ['local'] };
        let ref = rawRefs.get(role);
        if (!ref) { ref = await assembly.custody.artifacts.put(new TextEncoder().encode(role === 'recipient' ? BUDGET_ENTRY_SECRET : 'SPONSOR_RAW_ONLY'),
          { tenantId: policy.tenantId, labels: ['public'], mediaType: 'text/plain' }); rawRefs.set(role, ref); }
        const sourceRef = ref;
        const tool: Tool = { definition: { provider: 'fixture', id: BUDGET_ENTRY_SOURCE, version: '1', description: 'Read this recipient private original.',
          effect: 'read', destination: 'local', labels: ['public'], inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' } },
          async execute(_task, invocation) {
            assert.ok(invocation.authorize); await invocation.authorize();
            const bytes = await assembly.custody.artifacts.get(sourceRef, invocation.policy); await invocation.authorize();
            const text = new TextDecoder().decode(bytes), now = Date.now();
            observed.reads.push({ role, workId: invocation.workId, attemptId: invocation.attemptId });
            return { resultId: invocation.attemptId + ':result', attemptId: invocation.attemptId, status: 'success', effectState: 'none',
              evidence: [{ id: 'recipient-original:' + invocation.attemptId, tenantId: policy.tenantId, scope: context.scope,
                sourceId: 'recipient-private-source', lineageId: 'recipient-private-lineage:' + context.agentId, locator: 'local:recipient-source',
                labels: ['public'], observedAt: now, recordedAt: now, coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [],
                facts: { available: true, text }, artifact: sourceRef }], artifacts: [sourceRef], output: { available: true, text },
              cursor: null, coverage: 'complete', error: null, usage: { transportCalls: 0, internalOperations: 1, imageBytes: 0, waitMs: 0 } };
          } };
        return { tools: role === 'recipient' ? [tool] : [], policy, limits, async close() {} };
      } },
    };
  }
  const register = () => {
    for (const role of roles) {
      const profile = current(role), owner = { tenantId: profile.policy.tenantId, principalId: profile.policy.principalId, scope: profile.scope };
      unregister.push(router.register(owner, { services: profile.services,
        async run(workId, maxSteps, signal) { observed.runs.push({ workId, maxSteps }); signal.throwIfAborted();
          return profile.workflow.run(workId, profile.executionActor, { maxSteps, onStep: async () => { signal.throwIfAborted(); } }); },
        interrupt(workId) { observed.interrupts.push(workId); profile.runtime.interrupt(workId); } }));
    }
    const profile = current('recipient');
    unregister.push(router.registerRecipient('reviewer', { owner: { tenantId: profile.policy.tenantId, principalId: profile.policy.principalId, scope: profile.scope },
      policy: profile.policy, revision: 1, async approve(binding, purpose, signal) {
        observed.approvals.push({ purpose, binding: structuredClone(binding) }); return controls[purpose] && !signal?.aborted;
      } }));
  };
  const close = async () => {
    unregister.splice(0).reverse().forEach(remove => remove());
    for (const role of [...roles].reverse()) { const profile = opened.get(role); if (profile) { await profile.close(); opened.delete(role); } }
  };
  const open = async () => { for (const role of roles) opened.set(role, await openAgentTurnProfile(directories[role], { provider: 'registered' }, host(role))); register(); };
  t.after(async () => { await close(); rmSync(base, { recursive: true, force: true }); });
  await open();
  assert.notEqual(initialized.sponsor.paths.state, initialized.recipient.paths.state);
  assert.notEqual(current('sponsor').services.state, current('recipient').services.state);
  assert.equal(current('sponsor').policy.principalId, current('recipient').policy.principalId);
  assert.notEqual(current('sponsor').scope, current('recipient').scope);
  for (const role of roles) assert.ok(BUDGET_TOOL_IDS.every(id => current(role).policy.allowedTools.includes(id)));
  async function accept(messageId = 'budget-entry') {
    const profile = current('sponsor'), session = await profile.sessions.open(profile.actor, { channel: 'test', conversationId: 'budget-entry' });
    const accepted = await profile.turns.accept(profile.actor, { sessionId: session.scope.sessionId, messageId, rawText: BUDGET_ENTRY_REQUEST,
      binding: { ...profile.executionActor, channel: 'test', conversationId: 'budget-entry', recipientId: profile.actor.principalId, destination: 'local' },
      scope: profile.scope, mode: 'auto', policy: profile.policy, limits: profile.limits });
    await profile.outbox.flush(accepted.workId, profile.actor); return { ...accepted, sessionId: session.scope.sessionId };
  }
  async function result(role: BudgetEntryRole, workId: string, taskId: string) {
    const profile = current(role), state = await profile.runtime.state(workId), attempt = state.attempts.filter(value => value.taskId === taskId).at(-1);
    assert.ok(attempt?.resultArtifact, `durable result required for ${taskId}`);
    const bytes = await profile.services.artifacts.get(attempt.resultArtifact, state.policy);
    return { state, attempt, bytes, result: ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(bytes))) };
  }
  async function through(workId: string, step: number, settledAttempts = 1) {
    const profile = current('sponsor'), taskId = 'budget-step-' + step;
    assert.ok(Number.isInteger(settledAttempts) && settledAttempts >= 1 && settledAttempts <= 2);
    const done = (state: Awaited<ReturnType<typeof profile.runtime.state>>) => state.attempts.filter(value =>
      value.taskId === taskId && value.resultArtifact && !['reserved', 'running', 'received'].includes(value.status)).length >= settledAttempts;
    for (let i = 0; i < 70; i++) {
      const state = await profile.runtime.state(workId);
      if (done(state)) return result('sponsor', workId, taskId);
      const run = await profile.workflow.run(workId, profile.executionActor, { maxSteps: 1 });
      // A just-settled error may also stop control. Return its real receipt; a later step still faces the unchanged gate.
      const after = await profile.runtime.state(workId);
      if (done(after)) return result('sponsor', workId, taskId);
      assert.ok(!['blocked', 'failed', 'cancelled', 'paused', 'complete'].includes(run.control.kind), JSON.stringify(run));
      if (run.control.kind === 'wait' && run.control.reason === 'retry_backoff') {
        assert.ok(run.control.wakeAt !== null);
        const waitMs = Math.max(0, run.control.wakeAt - Date.now());
        assert.ok(waitMs <= 1000, 'only the actual bounded default retry backoff is awaited');
        if (waitMs > 0) await delay(waitMs);
      }
    }
    throw new Error('budget_fixture_step_limit');
  }
  async function child(workId: string) {
    const parent = await current('sponsor').runtime.state(workId), grant = parent.budgetGrants?.[0]; assert.ok(grant?.childAddress);
    const state = await current('recipient').runtime.state(grant.childWorkId);
    assert.deepEqual(grant.childAddress, budgetWorkAddress(state));
    assert.deepEqual(state.budgetParent?.parentAddress, budgetWorkAddress(parent));
    assert.equal(await current('sponsor').services.state.get(state.id), null);
    assert.equal(await current('recipient').services.state.get(parent.id), null);
    return { parent, grant, state };
  }
  async function memory(role: BudgetEntryRole) {
    const profile = current(role), knowledge = await profile.personalKnowledge(profile.actor);
    return (await knowledge.search({ namespace: 'personal', scope: 'personal', text: '', kinds: ['personal'], limit: 50 })).cards;
  }
  return { base, profiles, directories, initialized, router, controls, observed, current, accept, result, through, child, memory,
    raw(role: BudgetEntryRole) { const value = rawRefs.get(role); assert.ok(value); return value; },
    async reopen() { await close(); await open(); } };
}
