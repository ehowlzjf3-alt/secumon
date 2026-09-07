import { z } from 'zod';
import type { MessageSink } from '../application/ports.js';
import { parseContract } from '../application/contracts.js';
import { DeliverySchema } from '../application/store-contract.js';
import type { Delivery } from '../domain/model.js';
import { deliveryContent } from '../domain/conversation.js';
import { Sha256Digester } from './digest.js';
import type { AgentChannel } from './agent-channel.js';

export interface KnoxMessage {
  idempotencyKey: string;
  conversationId: string;
  recipientId: string;
  text: string;
  kind: Delivery['kind'];
}
/** The host maps these operations to its installed MCP. A send acknowledgement must identify a delivered message. */
export interface KnoxTransport {
  readonly capabilities: { readonly idempotentSend: boolean };
  send(message: Readonly<KnoxMessage>, signal: AbortSignal): ReturnType<MessageSink['send']>;
  lookup?(message: Readonly<KnoxMessage>, signal: AbortSignal): ReturnType<NonNullable<MessageSink['lookup']>>;
}
export interface KnoxRegistration {
  readonly destination: string;
  readonly transport: KnoxTransport;
}
const delivered = z.strictObject({ status: z.literal('delivered'), externalId: z.string().min(1).max(256) });
const sendResult = z.union([delivered, z.strictObject({ status: z.enum(['unknown', 'retryable_error']) })]);
const lookupResult = z.union([delivered, z.strictObject({ status: z.enum(['absent', 'unknown']) })]);

export function captureKnoxRegistration(value: KnoxRegistration | undefined): KnoxRegistration | null {
  if (value === undefined) return null;
  const destination = z.string().trim().min(1).max(256).refine(v => v !== 'local' && !/[\x00-\x1f\x7f]/.test(v)).parse(value.destination);
  const transport = value.transport;
  if (!transport || typeof transport.send !== 'function' || typeof transport.capabilities?.idempotentSend !== 'boolean' ||
      transport.lookup !== undefined && typeof transport.lookup !== 'function') throw new Error('knox_registration_invalid');
  return Object.freeze({ destination, transport: Object.freeze({
    capabilities: Object.freeze({ idempotentSend: transport.capabilities.idempotentSend }),
    send: transport.send.bind(transport), ...(transport.lookup ? { lookup: transport.lookup.bind(transport) } : {}),
  }) });
}

/** Local and external replies share the existing durable outbox and session history. */
export class KnoxChannel implements MessageSink {
  readonly capabilities: { idempotentSend: boolean };
  readonly #digest = new Sha256Digester();
  constructor(private readonly local: AgentChannel, private readonly registration: KnoxRegistration,
    private readonly owner: { agentId: string; tenantId: string; principalId: string }, private readonly signal: AbortSignal) {
    this.capabilities = Object.freeze({ idempotentSend: registration.transport.capabilities.idempotentSend });
  }
  canRetryAbsent(d: Delivery): boolean {
    return d.context?.binding.channel === 'knox' ? this.message(d) !== null && this.registration.transport.capabilities.idempotentSend :
      d.destination === 'local' && Boolean(d.context && ['cli', 'web', 'test'].includes(d.context.binding.channel));
  }
  private message(d: Delivery): Readonly<KnoxMessage> | null {
    const b = d.context?.binding;
    if (!b || b.channel !== 'knox' || d.destination !== this.registration.destination || b.destination !== d.destination ||
      b.tenantId !== this.owner.tenantId || b.principalId !== this.owner.principalId || b.recipientId !== this.owner.principalId ||
      !b.session || b.session.agentId !== this.owner.agentId || b.session.tenantId !== this.owner.tenantId ||
      b.session.principalId !== this.owner.principalId) return null;
    return Object.freeze({ idempotencyKey: `secumon-${this.#digest.digest(deliveryContent(d))}`,
      conversationId: b.conversationId, recipientId: b.recipientId, text: d.text, kind: d.kind });
  }
  async send(value: Delivery): ReturnType<MessageSink['send']> {
    const d = parseContract(DeliverySchema, value);
    if (d.context?.binding.channel !== 'knox') return this.local.send(d);
    const message = this.message(d);
    if (!message || this.signal.aborted) return { status: 'unknown' };
    const saved = await this.local.lookup(d);
    if (saved.status !== 'absent') return saved;
    const parsed = sendResult.safeParse(await this.registration.transport.send(message, this.signal));
    if (!parsed.success) return { status: 'unknown' };
    if (parsed.data.status === 'delivered') return this.local.recordConfirmedDelivery(d, parsed.data.externalId);
    return parsed.data;
  }
  async lookup(value: Delivery): ReturnType<NonNullable<MessageSink['lookup']>> {
    const d = parseContract(DeliverySchema, value);
    if (d.context?.binding.channel !== 'knox') return this.local.lookup(d);
    const message = this.message(d);
    if (!message) return { status: 'unknown' };
    const saved = await this.local.lookup(d);
    if (saved.status !== 'absent') return saved;
    if (!this.registration.transport.lookup || this.signal.aborted) return { status: 'unknown' };
    const parsed = lookupResult.safeParse(await this.registration.transport.lookup(message, this.signal));
    if (!parsed.success) return { status: 'unknown' };
    if (parsed.data.status === 'delivered') return this.local.recordConfirmedDelivery(d, parsed.data.externalId);
    return parsed.data;
  }
  messages(...args: Parameters<AgentChannel['messages']>) { return this.local.messages(...args); }
}
