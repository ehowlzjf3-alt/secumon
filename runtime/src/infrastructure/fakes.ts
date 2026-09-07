import type { Clock, IdGenerator, MessageSink, ModelReply, Planner, Tool } from '../application/ports.js';
import type { ContextPacket, Delivery, Evidence, Policy, TaskSpec, ToolResult } from '../domain/model.js';
import { z } from 'zod';
import { deliveryContent } from '../domain/conversation.js';

export class FakeClock implements Clock {
  #time: number;
  constructor(start: number) { this.#time = start; }
  now() { return this.#time; }
  advance(milliseconds: number) { if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new Error('invalid_clock_advance'); this.#time += milliseconds; }
}
export class SequenceIds implements IdGenerator {
  #value = 0;
  next(prefix: string) { return `${prefix}-${++this.#value}`; }
}
export class ScriptedPlanner implements Planner {
  readonly identity = { provider: 'scripted', model: 'fixture', revision: '1' };
  readonly destination = 'local';
  readonly capabilities = { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100_000 };
  readonly inputs: ContextPacket[] = [];
  #scripts: ((packet: ContextPacket) => ModelReply)[];
  constructor(scripts: ((packet: ContextPacket) => ModelReply)[]) { this.#scripts = [...scripts]; }
  async propose(packet: ContextPacket, signal: AbortSignal): Promise<ModelReply> {
    if (signal.aborted) return { status: 'cancelled', code: 'cancelled', inputTokens: 0, outputTokens: 0 };
    this.inputs.push(structuredClone(packet));
    const script = this.#scripts.shift();
    if (!script) return { status: 'error', code: 'script_exhausted', inputTokens: 0, outputTokens: 0 };
    return structuredClone(script(structuredClone(packet)));
  }
}
export class FakeSink implements MessageSink {
  readonly capabilities = { idempotentSend: true };
  readonly delivered = new Map<string, Delivery>();
  outcome: 'delivered' | 'unknown' | 'retryable_error' = 'delivered';
  async send(delivery: Delivery) {
    if (this.outcome !== 'delivered') return { status: this.outcome };
    const key = `${delivery.workId}:${delivery.id}`;
    const prior = this.delivered.get(key);
    if (prior && JSON.stringify(deliveryContent(prior)) !== JSON.stringify(deliveryContent(delivery))) return { status: 'unknown' as const };
    if (!this.delivered.has(key)) this.delivered.set(key, structuredClone(delivery));
    return { status: 'delivered' as const, externalId: `fake:${key}` };
  }
  async lookup(delivery: Delivery) {
    const key = `${delivery.workId}:${delivery.id}`; const prior = this.delivered.get(key);
    if (!prior) return { status: 'absent' as const };
    if (JSON.stringify(deliveryContent(prior)) !== JSON.stringify(deliveryContent(delivery))) return { status: 'unknown' as const };
    return { status: 'delivered' as const, externalId: `fake:${key}` };
  }
}
const readInput = z.strictObject({ evidenceIds: z.array(z.string().min(1)).min(1).max(100) });
export class FixtureReadTool implements Tool {
  readonly definition = { provider: 'fixture', id: 'fixture.read', version: '1', description: 'Read explicitly selected synthetic evidence records.', effect: 'read' as const,
    inputSchema: { type: 'object', properties: { evidenceIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 } }, required: ['evidenceIds'], additionalProperties: false },
    outputSchema: { type: 'object' }, destination: 'local', labels: ['synthetic'] };
  readonly invocations: string[] = [];
  #evidence: Map<string, Evidence>;
  constructor(evidence: Evidence[]) { this.#evidence = new Map(evidence.map(e => [e.id, structuredClone(e)])); }
  async execute(task: TaskSpec, context: { workId: string; attemptId: string; policy: Policy; signal: AbortSignal }): Promise<ToolResult> {
    const base = { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, effectState: 'none' as const, evidence: [], artifacts: [], output: null, cursor: null };
    if (context.signal.aborted) return { ...base, status: 'cancelled', error: null, coverage: 'unknown' };
    this.invocations.push(context.attemptId);
    const parsed = readInput.safeParse(task.input);
    if (!parsed.success) return { ...base, status: 'error', error: { code: 'invalid_input', retryable: false }, coverage: 'unknown' };
    const records: Evidence[] = [];
    for (const id of parsed.data.evidenceIds) {
      const e = this.#evidence.get(id);
      if (!e || e.tenantId !== context.policy.tenantId || !e.labels.every(l => context.policy.allowedLabels.includes(l))) {
        return { ...base, status: 'error', error: { code: 'evidence_unavailable', retryable: false }, coverage: 'unknown' };
      }
      records.push(structuredClone(e));
    }
    const complete = records.every(e => e.coverage === 'complete');
    return { ...base, status: complete ? 'success' : 'partial', evidence: records, output: { evidenceIds: records.map(e => e.id) }, error: null, coverage: complete ? 'complete' : 'partial' };
  }
}
