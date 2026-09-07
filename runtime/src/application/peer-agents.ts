import { z } from 'zod';
import type { ArtifactRef, TaskSpec, WorkState } from '../domain/model.js';
import { dataGeneration, visibleArtifact } from '../domain/data-lifecycle.js';
import { allowsDisclosure, disclosureLabels } from '../domain/disclosure.js';
import type { RuntimeServices } from './services.js';
import type { Tool } from './ports.js';
import { ArtifactSchema } from './contracts.js';
import { asJson, taskDigest } from './plan-validator.js';
import { frozen } from './resource-contracts.js';
import { transact } from './work-transactions.js';
import { readGeneratedAnswerArtifact } from './generated-answer.js';
import { PeerIdentitySchema, PeerReplySchema, PeerRequestSchema, PeerReviewSchema, PeerTicketSchema,
  type PeerAgent } from './peer-contracts.js';

export const PEER_TOOL_IDS = ['core.peer.consult', 'core.peer.resume'] as const;
const id = z.string().min(1).max(256);
const ConsultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ peerId: id, kind: z.literal('consult'), request: z.string().min(1).max(16000) }),
  z.strictObject({ peerId: id, kind: z.literal('review'), request: z.string().min(1).max(16000), targetHypothesisId: id }),
]);
const ResumeSchema = z.strictObject({ requestId: id });
const IntentSchema = z.strictObject({ peerId: id, peer: PeerIdentitySchema, destination: id, request: PeerRequestSchema });
const TicketRecordSchema = IntentSchema.extend({ ticket: PeerTicketSchema });
const ResponseSchema = TicketRecordSchema.extend({ schemaVersion: z.literal(1), attemptId: id, reply: PeerReplySchema });
const unavailable = () => new Error('peer_unavailable');

/** Own receipts retain routing and originals; another agent's answer remains an assessment, not evidence. */
export class PeerAgents {
  readonly tools: Tool[];
  readonly #peers: ReadonlyMap<string, PeerAgent>;
  constructor(readonly services: RuntimeServices, peers: ReadonlyMap<string, PeerAgent>, readonly agentId: string) {
    id.parse(agentId); if (peers.size > 16) throw new Error('peer_registration_invalid');
    this.#peers = new Map(peers);
    this.tools = PEER_TOOL_IDS.map(toolId => this.tool(toolId));
  }
  private digest(value: unknown) { return this.services.digester.digest(asJson(value)); }
  private targetVersion(hypothesis: WorkState['hypotheses'][number] | undefined) {
    if (!hypothesis) return this.digest(null);
    const { id, question, claim, predictedObservation, falsifier } = hypothesis;
    return this.digest({ id, question, claim, predictedObservation, falsifier });
  }
  private peer(record: z.infer<typeof IntentSchema>) {
    const peer = this.#peers.get(record.peerId);
    if (!peer || this.digest(peer.identity) !== this.digest(record.peer) || peer.destination !== record.destination) throw unavailable();
    return peer;
  }
  private assertRequest(state: WorkState, record: z.infer<typeof IntentSchema>) {
    const request = record.request, peer = this.peer(record);
    if (request.from.agentId !== this.agentId || request.from.workId !== state.id || request.from.tenantId !== state.policy.tenantId ||
      request.from.principalId !== state.policy.principalId || request.from.goalRevision !== state.goal.revision ||
      request.generation !== dataGeneration(state) || request.policyDigest !== this.digest(state.policy) ||
      !state.policy.allowedDestinations.includes(peer.destination) ||
      !request.labels.every(label => peer.allowedLabels.includes(label)) ||
      !allowsDisclosure(state.policy, peer.destination, 'a2a', request.labels)) throw unavailable();
    if (request.target && this.targetVersion(state.hypotheses.find(value => value.id === request.target!.hypothesis.id)) !== request.target.version) throw unavailable();
    return peer;
  }
  private async load<T>(state: WorkState, commandId: string, type: string, schema: z.ZodType<T>): Promise<T | null> {
    const receipt = await this.services.state.receipt(state.id, commandId); if (!receipt) return null;
    const events = (await this.services.state.events(state.id, 0)).filter(event => event.commandId === commandId);
    if (events.length !== 1 || events[0]!.type !== type || events[0]!.revision !== receipt.state.revision) throw unavailable();
    const data = z.strictObject({ payload: z.strictObject({ artifact: ArtifactSchema, value: schema }) }).parse(events[0]!.data).payload;
    if (receipt.digest !== this.digest({ type, data }) || !receipt.state.artifacts.some(ref => this.digest(ref) === this.digest(data.artifact)) ||
      !visibleArtifact(state, data.artifact)) throw unavailable();
    const stored = schema.parse(JSON.parse(await readGeneratedAnswerArtifact(this.services, state, data.artifact, 'application/json', 131072)));
    if (this.digest(stored) !== this.digest(data.value)) throw unavailable(); return stored;
  }
  private async store(state: WorkState, commandId: string, type: string, value: unknown,
    guard: () => Promise<void>, edit?: (next: WorkState) => void): Promise<ArtifactRef> {
    const bytes = new TextEncoder().encode(JSON.stringify(value)); if (bytes.byteLength > 131072) throw unavailable();
    const artifact = await this.services.artifacts.put(bytes, { tenantId: state.policy.tenantId, labels: disclosureLabels(state), mediaType: 'application/json' });
    await guard();
    await transact(this.services, state.id, commandId, type, asJson({ artifact, value }), next => {
      if (next.goal.revision !== state.goal.revision || this.digest(next.policy) !== this.digest(state.policy) || dataGeneration(next) !== dataGeneration(state)) throw unavailable();
      if (!next.artifacts.some(ref => ref.id === artifact.id)) next.artifacts.push(artifact); edit?.(next);
    }, guard);
    return artifact;
  }
  private output(record: z.infer<typeof ResponseSchema>) {
    const review = record.request.kind === 'review' && record.reply.status === 'answer'
      ? PeerReviewSchema.parse(JSON.parse(record.reply.text!)) : null;
    if (review && review.targetVersion !== record.request.target!.version) throw unavailable();
    return asJson({ requestId: record.request.id, peerId: record.peerId, peer: record.peer,
      target: record.request.from, interpretation: 'peer_assessment_not_independent_evidence', cost: 'recipient_own_budget',
      status: record.reply.status, reason: record.reply.reason, recipientWorkId: record.reply.ticket.workId,
      model: record.reply.model, observedAt: record.reply.observedAt, text: record.reply.text, review });
  }
  private async descriptor(state: WorkState, task: TaskSpec, attemptId: string) {
    const receipt = await this.services.state.receipt(state.id, `dispatch:${attemptId}`);
    const original = receipt?.state.attempts.find(value => value.id === attemptId), attempt = state.attempts.find(value => value.id === attemptId);
    const definition = this.tools.find(value => value.definition.id === task.toolId)?.definition;
    if (!receipt || !original || !attempt || original.status !== 'running' || task.effect !== 'read' || !definition ||
      original.inputDigest !== taskDigest(task, this.services.digester) || attempt.inputDigest !== original.inputDigest ||
      attempt.contractDigest !== this.digest(definition) || original.contractDigest !== attempt.contractDigest ||
      original.goalRevision !== state.goal.revision || original.scope !== state.goal.scope) throw unavailable();
    return attempt;
  }
  private tool(toolId: typeof PEER_TOOL_IDS[number]): Tool {
    const inputSchema = toolId === PEER_TOOL_IDS[0] ? ConsultSchema : ResumeSchema;
    return {
      definition: { provider: 'core', id: toolId, version: '1', effect: 'read', destination: 'local', labels: [], resultValidation: 'artifact-proof-v1',
        description: toolId === PEER_TOOL_IDS[0]
          ? `Ask a registered peer using its own read-only work budget. Review a current hypothesis in separate context. Replies are assessments, never independent evidence; use hypotheses and discriminating tasks to evaluate them. Registered peers: ${JSON.stringify([...this.#peers].map(([peerId, peer]) => ({ peerId, role: peer.identity.role })))}`
          : 'Continue an already requested peer work by requestId. Does not create another work or grant resources.',
        inputSchema: asJson(z.toJSONSchema(inputSchema, { target: 'draft-7' })), outputSchema: { type: ['object', 'null'] } },
      execute: async (task, context) => {
        const state = await this.services.state.get(context.workId); if (!state) throw unavailable();
        await this.descriptor(state, task, context.attemptId);
        let intent: z.infer<typeof IntentSchema>;
        if (toolId === PEER_TOOL_IDS[0]) {
          const input = ConsultSchema.parse(task.input), peer = this.#peers.get(input.peerId); if (!peer) throw unavailable();
          const hypothesis = input.kind === 'review' ? state.hypotheses.find(value => value.id === input.targetHypothesisId) : null;
          if (input.kind === 'review' && !hypothesis) throw unavailable();
          const requestId = `peer-${this.digest({ workId: state.id, goalRevision: state.goal.revision,
            generation: dataGeneration(state), policy: state.policy, peer: peer.identity, input, hypothesis })}`;
          const recorded = await this.load(state, `peer-request:${requestId}`, 'peer_requested', IntentSchema);
          intent = recorded ?? IntentSchema.parse({ peerId: input.peerId, peer: peer.identity, destination: peer.destination,
            request: { schemaVersion: 1, id: requestId, kind: input.kind, text: input.request,
              from: { agentId: this.agentId, tenantId: state.policy.tenantId, principalId: state.policy.principalId, workId: state.id,
                goalRevision: state.goal.revision, planRevision: state.plan?.revision ?? 0 }, policyDigest: this.digest(state.policy),
              generation: dataGeneration(state), labels: disclosureLabels(state), deadlineAt: state.deadlineAt,
              target: hypothesis ? { version: this.targetVersion(hypothesis), hypothesis } : null } });
        } else {
          const input = ResumeSchema.parse(task.input);
          const saved = await this.load(state, `peer-request:${input.requestId}`, 'peer_requested', IntentSchema); if (!saved) throw unavailable(); intent = saved;
        }
        const peer = this.assertRequest(state, intent);
        const guard = async () => {
          await context.authorize?.();
          const latest = await this.services.state.get(state.id); if (!latest || context.signal.aborted || latest.deadlineAt <= this.services.clock.now() ||
            ['paused', 'cancelled', 'failed', 'completed'].includes(latest.status)) throw unavailable();
          const attempt = await this.descriptor(latest, task, context.attemptId);
          if (attempt.status !== 'running' || attempt.leaseUntil <= this.services.clock.now()) throw unavailable(); this.assertRequest(latest, intent);
        };
        await guard();
        const intentCommand = `peer-request:${intent.request.id}`;
        if (!(await this.load(state, intentCommand, 'peer_requested', IntentSchema))) await this.store(state, intentCommand, 'peer_requested', intent, guard);
        let ticketRecord = await this.load((await this.services.state.get(state.id))!, `peer-ticket:${intent.request.id}`, 'peer_accepted', TicketRecordSchema);
        if (!ticketRecord) {
          const ticket = PeerTicketSchema.parse(await peer.request(frozen(structuredClone(intent.request)), context.signal)); await guard();
          if (ticket.requestId !== intent.request.id || ticket.requestDigest !== this.digest(intent.request)) throw unavailable();
          ticketRecord = { ...intent, ticket };
          await this.store(state, `peer-ticket:${intent.request.id}`, 'peer_accepted', ticketRecord, guard);
        }
        const reply = PeerReplySchema.parse(await peer.run(intent.request, ticketRecord.ticket, context.signal)); await guard();
        if (this.digest(reply.ticket) !== this.digest(ticketRecord.ticket) || !reply.labels.every(label => state.policy.allowedLabels.includes(label)) ||
          !(await peer.current(intent.request, reply))) throw unavailable();
        const response = ResponseSchema.parse({ ...ticketRecord, schemaVersion: 1, attemptId: context.attemptId, reply });
        const output = this.output(response);
        const artifact = await this.store(state, `peer-response:${context.attemptId}`, 'peer_response_observed', response, guard, next => {
          if (reply.status === 'answer' && intent.request.kind === 'review') next.hypothesisAssessment = null;
        });
        return { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, status: 'success', coverage: 'unknown',
          effectState: 'none', evidence: [], artifacts: [artifact], cursor: null, error: null, output };
      },
      validateResult: async (state, result) => {
        try {
          if (['error', 'cancelled'].includes(result.status)) return result.artifacts.length === 0 && result.evidence.length === 0 && result.output === null && result.effectState === 'none';
          if (result.status !== 'success' || result.coverage !== 'unknown' || result.effectState !== 'none' || result.effectReceipt || result.evidence.length ||
            result.artifacts.length !== 1 || result.cursor !== null || result.error || result.reuse || result.collection) return false;
          const attempt = state.attempts.find(value => value.id === result.attemptId);
          const dispatch = await this.services.state.receipt(state.id, `dispatch:${result.attemptId}`);
          const originalTask = dispatch?.state.plan?.tasks.find(value => value.id === attempt?.taskId);
          if (!attempt || attempt.toolId !== toolId || !originalTask) return false;
          await this.descriptor(state, originalTask, result.attemptId);
          const artifact = ArtifactSchema.parse(result.artifacts[0]);
          const record = ResponseSchema.parse(JSON.parse(await readGeneratedAnswerArtifact(this.services, state, artifact, 'application/json', 131072)));
          const receipt = await this.services.state.receipt(state.id, `peer-response:${result.attemptId}`);
          const peer = this.assertRequest(state, record);
          return !!receipt && record.attemptId === result.attemptId && result.resultId === `${result.attemptId}:result` &&
            receipt.digest === this.digest({ type: 'peer_response_observed', data: { artifact, value: record } }) &&
            this.digest(result.output) === this.digest(this.output(record)) && record.reply.labels.every(label => state.policy.allowedLabels.includes(label)) &&
            await peer.current(record.request, record.reply);
        } catch { return false; }
      },
    };
  }
}
export function createPeerTools(services: RuntimeServices, peers: ReadonlyMap<string, PeerAgent>, agentId: string): Tool[] {
  return new PeerAgents(services, peers, agentId).tools;
}
