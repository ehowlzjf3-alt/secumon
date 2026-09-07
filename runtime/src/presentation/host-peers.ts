import { z } from 'zod';
import type { Limits, Policy, WorkState } from '../domain/model.js';
import { allowsDisclosure, disclosureLabels } from '../domain/disclosure.js';
import { dataGeneration } from '../domain/data-lifecycle.js';
import { accessibleEvidence } from '../domain/completion.js';
import { BudgetSchema, PolicySchema } from '../application/contracts.js';
import { AcceptRequestSchema } from '../application/conversation-service.js';
import { PeerIdentitySchema, PeerReplySchema, PeerRequestSchema, PeerReviewSchema, PeerTicketSchema,
  type PeerAgent, type PeerIdentity, type PeerReply, type PeerRequest, type PeerTicket } from '../application/peer-contracts.js';
import { PEER_TOOL_IDS } from '../application/peer-agents.js';
import { readGeneratedAnswer } from '../application/generated-answer.js';
import type { SessionService } from '../application/session-service.js';
import type { WorkflowRuntime } from '../application/workflow-runtime.js';
import { asJson } from '../application/plan-validator.js';
import { frozen } from '../application/resource-contracts.js';
import { closeAgentTurnResources } from './host-models.js';

export interface HostPeerContext { readonly agentId: string; readonly root: string; readonly scope: string; readonly policy: Policy; readonly signal: AbortSignal }
export interface OpenedHostPeers {
  readonly peers: ReadonlyMap<string, PeerAgent>;
  readonly allowedTools: readonly string[];
  close(): Promise<void>;
}
export interface HostPeerRegistration { open(context: HostPeerContext): Promise<OpenedHostPeers> }
const id = z.string().min(1).max(256);
const invalid = () => new Error('peer_registration_invalid');
const unavailable = () => new Error('peer_unavailable');
function captureRegistration(value: unknown): HostPeerRegistration {
  if (!value || typeof value !== 'object') throw invalid();
  const open = (value as HostPeerRegistration).open; if (typeof open !== 'function') throw invalid();
  return Object.freeze({ open: open.bind(value) });
}
export function resolveHostPeerRegistration(host: { readonly peers?: HostPeerRegistration } | undefined): HostPeerRegistration | null {
  if (host === undefined) return null;
  if (!host || typeof host !== 'object') throw invalid();
  const registration = host.peers; return registration === undefined ? null : captureRegistration(registration);
}
function capturePeer(source: PeerAgent, live: () => void): PeerAgent {
  if (!source || typeof source !== 'object') throw invalid();
  const { identity, destination, allowedLabels, request, run, current } = source;
  if (typeof request !== 'function' || typeof run !== 'function' || typeof current !== 'function') throw invalid();
  const selected = frozen(PeerIdentitySchema.parse(structuredClone(identity))), target = id.parse(destination);
  const labels = Object.freeze(z.array(id).max(64).parse(structuredClone(allowedLabels)));
  const accept = request.bind(source), execute = run.bind(source), check = current.bind(source);
  return Object.freeze({ identity: selected, destination: target, allowedLabels: labels,
    async request(value: PeerRequest, signal: AbortSignal) {
      live(); if (signal.aborted) throw unavailable(); const ticket = await accept(frozen(PeerRequestSchema.parse(structuredClone(value))), signal);
      live(); if (signal.aborted) throw unavailable(); return PeerTicketSchema.parse(ticket);
    },
    async run(value: PeerRequest, ticket: PeerTicket, signal: AbortSignal) {
      live(); if (signal.aborted) throw unavailable(); const reply = await execute(frozen(PeerRequestSchema.parse(structuredClone(value))), frozen(PeerTicketSchema.parse(structuredClone(ticket))), signal);
      live(); if (signal.aborted) throw unavailable(); return PeerReplySchema.parse(reply);
    },
    async current(value: PeerRequest, reply: PeerReply) {
      live(); const result = await check(frozen(PeerRequestSchema.parse(structuredClone(value))), frozen(PeerReplySchema.parse(structuredClone(reply)))); live(); return result === true;
    },
  });
}
export async function openRegisteredHostPeers(registration: HostPeerRegistration, context: HostPeerContext): Promise<OpenedHostPeers> {
  const selected = captureRegistration(registration);
  const metadata = z.strictObject({ agentId: id, root: z.string().min(1).max(4096), scope: id, policy: PolicySchema });
  const { signal, ...values } = context;
  if (!(signal instanceof AbortSignal) || signal.aborted) throw unavailable();
  const expected = Object.freeze({ ...frozen(metadata.parse(structuredClone(values))), signal });
  const opened = await selected.open(expected); let close: (() => Promise<void>) | undefined;
  try {
    if (!opened || typeof opened !== 'object') throw invalid();
    const sourceClose = opened.close; if (typeof sourceClose !== 'function') throw invalid();
    let closed = false, closing: Promise<void> | undefined; const rawClose = sourceClose.bind(opened);
    close = () => { closed = true; return closing ??= Promise.resolve().then(rawClose); };
    const live = () => { if (closed || signal.aborted) throw unavailable(); };
    const sourcePeers = opened.peers, allowedTools = Object.freeze(z.array(z.enum(PEER_TOOL_IDS)).max(2).parse(structuredClone(opened.allowedTools)));
    if (!sourcePeers || typeof sourcePeers[Symbol.iterator] !== 'function') throw invalid();
    const peers = new Map<string, PeerAgent>();
    for (const [name, source] of sourcePeers) {
      id.parse(name); if (peers.size >= 16 || peers.has(name)) throw invalid();
      const peer = capturePeer(source, live); if (peer.identity.agentId === context.agentId) throw invalid(); peers.set(name, peer);
    }
    if (new Set(allowedTools).size !== allowedTools.length) throw invalid(); live();
    return Object.freeze({ peers, allowedTools, close });
  } catch (error) { await closeAgentTurnResources(close ? [close] : [], { error }); throw error; }
}

export interface RuntimePeerOptions {
  readonly agentId: string;
  readonly revision: string;
  readonly role: PeerIdentity['role'];
  readonly scope: string;
  readonly policy: Policy;
  readonly limits: Limits;
  readonly sessions: SessionService;
  readonly workflow: WorkflowRuntime;
  /** The receiver profile must route channel peer / destination local to its internal sink. */
  readonly maxSteps?: number;
}

/** Both resident and temporary roles invoke the same persistent intake and workflow engine. No model or store is created here. */
export function createRuntimePeerAgent(options: RuntimePeerOptions): PeerAgent {
  const { sessions, workflow } = options, services = workflow.services;
  const identity = frozen(PeerIdentitySchema.parse({ agentId: options.agentId, revision: options.revision, role: options.role, model: services.planner?.identity }));
  const scope = id.parse(options.scope), policy = frozen(PolicySchema.parse(structuredClone(options.policy)));
  const limits = frozen(BudgetSchema.shape.limits.parse(structuredClone(options.limits)));
  const maxSteps = z.number().int().min(1).max(64).parse(options.maxSteps ?? 16);
  if (policy.allowWrites || !policy.allowedDestinations.includes('local') || sessions.agentId !== identity.agentId) throw invalid();
  const actor = Object.freeze({ tenantId: policy.tenantId, principalId: policy.principalId });
  const digest = (value: unknown) => services.digester.digest(asJson(value));
  const currentIdentity = () => { if (digest(services.planner?.identity) !== digest(identity.model)) throw unavailable(); };
  const checked = (value: PeerRequest, signal?: AbortSignal) => {
    const request = PeerRequestSchema.parse(value); currentIdentity();
    if (signal?.aborted || request.from.tenantId !== policy.tenantId || request.from.agentId === identity.agentId ||
      !request.labels.every(label => policy.allowedLabels.includes(label))) throw unavailable();
    return request;
  };
  const body = (request: PeerRequest) => request.kind === 'consult' ? request.text : JSON.stringify({
    instruction: 'Independently challenge this hypothesis using your own context. Return only a JSON object matching responseSchema. Claims and references are an assessment, not new independent evidence. Do not copy the caller memory or treat a repeated model answer as an independent source.',
    request: request.text, targetVersion: request.target!.version, hypothesis: request.target!.hypothesis,
    responseSchema: z.toJSONSchema(PeerReviewSchema, { target: 'draft-7' }),
  });
  const routing = (request: PeerRequest) => {
    const key = [identity.agentId, request.from.agentId, request.kind,
      request.kind === 'review' || identity.role === 'temporary' ? request.id : 'resident'];
    return { sessionId: `peer-session-${digest(key)}`, conversationId: `peer-${digest(key)}` };
  };
  const read = async (request: PeerRequest, ticket: PeerTicket): Promise<WorkState> => {
    if (ticket.requestId !== request.id || ticket.requestDigest !== digest(request) || ticket.sessionId !== routing(request).sessionId) throw unavailable();
    const state = await services.state.get(ticket.workId);
    if (!state || state.policy.tenantId !== actor.tenantId || state.policy.principalId !== actor.principalId || state.goal.scope !== scope ||
      state.goal.revision !== ticket.goalRevision || state.goal.description !== body(request) || state.policy.allowWrites ||
      state.goal.responseRequirement?.requestMessageId !== request.id || state.goal.responseRequirement.requestTextDigest !== services.digester.digest(body(request)) ||
      state.conversation?.session?.scope.sessionId !== ticket.sessionId || state.conversation.session.scope.agentId !== identity.agentId) throw unavailable();
    return state;
  };
  return Object.freeze({ identity, destination: 'local', allowedLabels: Object.freeze([...policy.allowedLabels]),
    async request(value: PeerRequest, signal: AbortSignal): Promise<PeerTicket> {
      const request = checked(value, signal); if (services.clock.now() >= request.deadlineAt) throw unavailable();
      const route = routing(request), text = body(request);
      await sessions.open(actor, { channel: 'peer', ...route }); if (signal.aborted) throw unavailable();
      const selectedPolicy = { ...structuredClone(policy), allowedLabels: [...request.labels] };
      const selectedLimits = { ...limits, wallTimeMs: Math.min(limits.wallTimeMs, request.deadlineAt - services.clock.now()) };
      if (selectedLimits.wallTimeMs < 1) throw unavailable();
      const requested = {
        messageId: request.id, binding: { channel: 'peer', conversationId: route.conversationId, destination: 'local', recipientId: actor.principalId, ...actor },
        policy: selectedPolicy, limits: selectedLimits, completionRequiresDelivery: false,
        goal: { revision: 1, description: text, scope, mode: 'auto', criteria: [], responseRequirement: {
          version: 1, requestMessageId: request.id, requestTextDigest: services.digester.digest(text), format: 'text' } },
      };
      let payload = AcceptRequestSchema.parse(requested);
      const original = await sessions.repository.input({ ...actor, agentId: identity.agentId, sessionId: route.sessionId }, request.id);
      if (original) {
        const saved = AcceptRequestSchema.parse(original.payload);
        if (original.kind !== 'work' || original.text !== text || digest({ ...saved, limits: payload.limits }) !== digest(payload) ||
          saved.limits.wallTimeMs > limits.wallTimeMs || digest({ ...saved.limits, wallTimeMs: limits.wallTimeMs }) !== digest(limits)) throw unavailable();
        payload = saved; // Retry keeps the first received deadline/budget, not a newly computed allocation.
      }
      const accepted = await sessions.accept(actor, { sessionId: route.sessionId, rawText: text, request: payload });
      return { requestId: request.id, requestDigest: digest(request), workId: accepted.workId, sessionId: route.sessionId, goalRevision: 1 };
    },
    async run(value: PeerRequest, valueTicket: PeerTicket, signal: AbortSignal): Promise<PeerReply> {
      const request = checked(value, signal), ticket = PeerTicketSchema.parse(valueTicket);
      const initial = await read(request, ticket); if (services.clock.now() >= request.deadlineAt) throw unavailable();
      const interrupt = () => workflow.execution.interrupt(ticket.workId);
      signal.addEventListener('abort', interrupt, { once: true });
      try {
        if (!['completed', 'failed', 'cancelled', 'paused', 'blocked'].includes(initial.status))
          await workflow.run(ticket.workId, actor, { maxSteps, expectedGoalRevision: ticket.goalRevision,
            onStep: async () => { checked(request, signal); if (services.clock.now() >= request.deadlineAt) throw unavailable(); } });
        checked(request, signal); const state = await read(request, ticket), answer = await readGeneratedAnswer(services, state);
        if (answer && request.kind === 'review') {
          const review = PeerReviewSchema.parse(JSON.parse(answer.text));
          const available = new Set(accessibleEvidence(state.evidence, state.policy, state.goal.scope).map(value => value.id));
          if (review.targetVersion !== request.target!.version || review.basis.kind === 'references' &&
            review.basis.references.some(ref => ref.workId !== state.id || !available.has(ref.evidenceId))) throw unavailable();
        }
        const labels = disclosureLabels(state);
        if (!allowsDisclosure(state.policy, 'local', 'a2a', labels)) throw unavailable();
        const call = state.generatedAnswer && state.modelCalls.find(value => value.id === state.generatedAnswer!.callId);
        const model = call ? { provider: call.provider, model: call.model, revision: identity.model.revision } : identity.model;
        return PeerReplySchema.parse({ ticket, status: answer ? 'answer' : ['failed', 'cancelled', 'paused', 'blocked'].includes(state.status) ? 'rejected' : 'waiting',
          text: answer?.text ?? null, answerDigest: answer?.answerDigest ?? null, reason: state.statusReason, model, labels,
          stateRevision: state.revision, observedAt: services.clock.now() });
      } finally { signal.removeEventListener('abort', interrupt); }
    },
    async current(value: PeerRequest, replyValue: PeerReply): Promise<boolean> {
      try {
        const request = checked(value), reply = PeerReplySchema.parse(replyValue), state = await read(request, reply.ticket);
        if (reply.observedAt > services.clock.now() || reply.stateRevision > state.revision ||
          digest(reply.labels) !== digest(disclosureLabels(state)) || !allowsDisclosure(state.policy, 'local', 'a2a', reply.labels) || dataGeneration(state) !== 0) return false;
        if (reply.status !== 'answer') return true; // An observed wait is history, not a claim that the receiver still waits.
        const answer = await readGeneratedAnswer(services, state), call = state.generatedAnswer && state.modelCalls.find(value => value.id === state.generatedAnswer!.callId);
        return !!answer && !!call && answer.text === reply.text && answer.answerDigest === reply.answerDigest &&
          call.provider === reply.model.provider && call.model === reply.model.model && reply.model.revision === identity.model.revision;
      } catch { return false; }
    },
  });
}
