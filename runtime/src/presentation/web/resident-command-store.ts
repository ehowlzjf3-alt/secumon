import type { WebResidentMissionCommandInput } from '../web-contracts.js';

export type ResidentCommandScope = Readonly<{ agentId: string; sessionId: string; conversationId: string }>;
export type ResidentCommandTicket = Readonly<{ workId: string; command: Readonly<WebResidentMissionCommandInput> }>;
export interface ResidentCommandPersistence {
  load(): readonly ResidentCommandTicket[];
  save(tickets: readonly ResidentCommandTicket[]): void;
}

const maxTickets = 16, maxBytes = 32768;
const invalid = () => new Error('resident_command_storage_invalid');
const capacity = () => new Error('resident_command_storage_capacity');
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key) ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
  return value;
}
function scopeValue(value: unknown): ResidentCommandScope {
  const source = record(value, ['agentId', 'sessionId', 'conversationId']);
  return Object.freeze({ agentId: id(source['agentId']), sessionId: id(source['sessionId']), conversationId: id(source['conversationId']) });
}
function ticketValues(value: unknown): readonly ResidentCommandTicket[] {
  if (!Array.isArray(value)) throw invalid();
  if (value.length > maxTickets) throw capacity();
  if (Reflect.ownKeys(value).length !== value.length + 1) throw invalid();
  const result: ResidentCommandTicket[] = [], works = new Set<string>(), commands = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entry || !Object.hasOwn(entry, 'value')) throw invalid();
    const ticket = record(entry.value, ['workId', 'command']), command = record(ticket['command'], ['commandId', 'expectedControlRevision', 'kind']);
    const workId = id(ticket['workId']), commandId = id(command['commandId']), expectedControlRevision = command['expectedControlRevision'], kind = command['kind'];
    if (workId.includes('/') || typeof expectedControlRevision !== 'number' || !Number.isSafeInteger(expectedControlRevision) ||
      expectedControlRevision < 0 || expectedControlRevision >= Number.MAX_SAFE_INTEGER ||
      (kind !== 'pause' && kind !== 'resume' && kind !== 'stop') || works.has(workId) || commands.has(commandId)) throw invalid();
    works.add(workId); commands.add(commandId);
    result.push(Object.freeze({ workId, command: Object.freeze({ commandId, expectedControlRevision, kind }) }));
  }
  return Object.freeze(result);
}
function bounded(value: string) {
  // Check code units first to avoid allocating an unbounded UTF-8 buffer for a malformed stored value.
  if (value.length > maxBytes || new TextEncoder().encode(value).byteLength > maxBytes) throw capacity();
}

/** Use same-origin sessionStorage. Tickets preserve retry identity; they are not authority or proof that a command ran. */
export function residentCommandPersistence(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, input: ResidentCommandScope): ResidentCommandPersistence {
  const scope = scopeValue(input), key = `resident-commands:v1:${JSON.stringify([scope.agentId, scope.sessionId, scope.conversationId])}`;
  const load = (): readonly ResidentCommandTicket[] => {
    let raw: string | null;
    try { raw = storage.getItem(key); } catch (cause) { throw new Error('resident_command_storage_unavailable', { cause }); }
    if (raw === null) return Object.freeze([]);
    if (typeof raw !== 'string') throw invalid();
    bounded(raw);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw invalid(); }
    const envelope = record(parsed, ['version', 'scope', 'tickets']), savedScope = scopeValue(envelope['scope']);
    if (envelope['version'] !== 1 || savedScope.agentId !== scope.agentId || savedScope.sessionId !== scope.sessionId ||
      savedScope.conversationId !== scope.conversationId) throw invalid();
    return ticketValues(envelope['tickets']);
  };
  return Object.freeze({
    load,
    save(tickets: readonly ResidentCommandTicket[]) {
      const selected = ticketValues(tickets), raw = JSON.stringify({ version: 1, scope, tickets: selected }); bounded(raw);
      // A caller may save without loading, or the old value may have changed. Never overwrite unreadable pending requests.
      load();
      try { if (selected.length) storage.setItem(key, raw); else storage.removeItem(key); }
      catch (cause) { throw new Error('resident_command_storage_unavailable', { cause }); }
    },
  });
}
