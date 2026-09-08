import test from 'node:test';
import assert from 'node:assert/strict';
import { residentCommandPersistence, type ResidentCommandScope, type ResidentCommandTicket } from '../presentation/web/resident-command-store.js';

class SessionStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  readonly values = new Map<string, string>();
  readonly calls: string[] = [];
  fail: 'get' | 'set' | 'remove' | null = null;
  getItem(key: string) { this.calls.push('get'); if (this.fail === 'get') throw new Error('storage read unavailable'); return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.calls.push('set'); if (this.fail === 'set') throw new Error('storage quota unavailable'); this.values.set(key, value); }
  removeItem(key: string) { this.calls.push('remove'); if (this.fail === 'remove') throw new Error('storage removal unavailable'); this.values.delete(key); }
}
const scope: ResidentCommandScope = { agentId: 'agent-a', sessionId: 'session-a', conversationId: 'conversation-a' };
const key = (value = scope) => `resident-commands:v1:${JSON.stringify([value.agentId, value.sessionId, value.conversationId])}`;
const ticket = (index = 0): ResidentCommandTicket => ({ workId: `controller-${index}`, command: {
  commandId: `command-${index}`, expectedControlRevision: index, kind: index % 2 ? 'resume' : 'pause',
} });
const envelope = (tickets: unknown = [ticket()], selectedScope: unknown = scope) => ({ version: 1, scope: selectedScope, tickets });

test('resident command storage: reload preserves only frozen original retry tickets and empty save removes the exact key', () => {
  const storage = new SessionStorage(), first = residentCommandPersistence(storage, scope), original = ticket();
  assert.deepEqual(first.load(), []); assert.equal(storage.values.size, 0);
  first.save([original]); storage.values.set('unrelated-selection', 'retain');
  assert.deepEqual(JSON.parse(storage.values.get(key())!), envelope());
  const reload = residentCommandPersistence(storage, scope), saved = reload.load();
  assert.deepEqual(saved, [original]); assert.notStrictEqual(saved[0], original); assert.notStrictEqual(saved[0]!.command, original.command);
  assert.ok(Object.isFrozen(saved)); assert.ok(Object.isFrozen(saved[0])); assert.ok(Object.isFrozen(saved[0]!.command));
  assert.throws(() => { (saved[0]!.command as { expectedControlRevision: number }).expectedControlRevision = 90; }, TypeError);
  assert.deepEqual(reload.load(), [ticket()]);
  reload.save([]); assert.equal(storage.values.has(key()), false); assert.equal(storage.values.get('unrelated-selection'), 'retain');
  assert.deepEqual(residentCommandPersistence(storage, scope).load(), []);
});

test('resident command storage: exact agent, session and conversation keys remain separate without normalizing scope identifiers', () => {
  const storage = new SessionStorage(), scopes = [scope, { ...scope, agentId: 'agent-b' }, { ...scope, sessionId: 'session-b' },
    { ...scope, conversationId: 'conversation-b' }, { agentId: 'a:b', sessionId: 'c', conversationId: '대화' },
    { agentId: 'a', sessionId: 'b:c', conversationId: '대화' }];
  scopes.forEach((selected, index) => residentCommandPersistence(storage, selected).save([ticket(index)]));
  assert.equal(storage.values.size, scopes.length);
  scopes.forEach((selected, index) => assert.deepEqual(residentCommandPersistence(storage, selected).load(), [ticket(index)]));
  const mutable = { ...scope }, selected = residentCommandPersistence(storage, mutable); mutable.agentId = 'agent-b';
  assert.deepEqual(selected.load(), [ticket(0)], 'the factory snapshots its scope');
  selected.save([]); assert.deepEqual(residentCommandPersistence(storage, scopes[1]!).load(), [ticket(1)]);
});

test('resident command storage: malformed, foreign and extra-field envelopes cannot be loaded or overwritten, even by empty save', () => {
  const storage = new SessionStorage(), persistence = residentCommandPersistence(storage, scope);
  const invalid = ['', '{', 'null', '[]', JSON.stringify({ ...envelope(), version: 2 }), JSON.stringify({ ...envelope(), accessToken: 'extra' }),
    JSON.stringify(envelope([ticket()], { ...scope, agentId: 'agent-b' })), JSON.stringify(envelope([ticket()], { ...scope, destination: 'extra' })),
    JSON.stringify({ scope, tickets: [ticket()] }), JSON.stringify(envelope(null))];
  for (const raw of invalid) {
    storage.values.set(key(), raw); storage.calls.length = 0;
    assert.throws(() => persistence.load(), /resident_command_storage_invalid/);
    assert.throws(() => persistence.save([ticket(1)]), /resident_command_storage_invalid/);
    assert.throws(() => persistence.save([]), /resident_command_storage_invalid/);
    assert.equal(storage.values.get(key()), raw); assert.ok(storage.calls.every(call => call === 'get'));
  }
});

test('resident command storage: strict tickets reject hidden payloads, invalid identifiers, unsafe revisions and duplicate identities', () => {
  const storage = new SessionStorage(), persistence = residentCommandPersistence(storage, scope); persistence.save([ticket()]);
  const before = storage.values.get(key()), command = ticket().command;
  const invalid: unknown[] = [
    [{ ...ticket(), body: 'not a ticket field' }], [{ ...ticket(), command: { ...command, evidence: {} } }], [{ workId: 'work' }],
    ...['', 'x'.repeat(257), 'bad\nwork', 'path/work'].map(workId => [{ ...ticket(), workId }]),
    ...['', 'x'.repeat(257), 'bad\u0000command'].map(commandId => [{ ...ticket(), command: { ...command, commandId } }]),
    ...[-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, '0'].map(expectedControlRevision => [{ ...ticket(), command: { ...command, expectedControlRevision } }]),
    [{ ...ticket(), command: { ...command, kind: 'close' } }], [ticket(), { ...ticket(1), workId: ticket().workId }],
    [ticket(), { ...ticket(1), command: { ...ticket(1).command, commandId: command.commandId } }], new Array(1),
  ];
  for (const tickets of invalid) {
    assert.throws(() => persistence.save(tickets as ResidentCommandTicket[]), /resident_command_storage_invalid/);
    assert.equal(storage.values.get(key()), before);
    storage.values.set(key(), JSON.stringify(envelope(tickets)));
    assert.throws(() => persistence.load(), /resident_command_storage_invalid/);
    storage.values.set(key(), before!);
  }
  const upper = { ...ticket(2), command: { ...ticket(2).command, expectedControlRevision: Number.MAX_SAFE_INTEGER - 1, kind: 'stop' as const } };
  persistence.save([upper]); assert.deepEqual(persistence.load(), [upper]);
});

test('resident command storage: scope validation and accessor rejection cannot silently discard supplied data', () => {
  const storage = new SessionStorage();
  for (const invalid of [{ ...scope, agentId: '' }, { ...scope, sessionId: 'x'.repeat(257) }, { ...scope, conversationId: '\n' },
    { ...scope, body: 'extra' }, { agentId: scope.agentId, sessionId: scope.sessionId }, null]) {
    assert.throws(() => residentCommandPersistence(storage, invalid as ResidentCommandScope), /resident_command_storage_invalid/);
  }
  const persistence = residentCommandPersistence(storage, scope), source = { ...ticket(), command: ticket().command }; let reads = 0;
  Object.defineProperty(source, 'command', { get() { reads++; return ticket().command; } });
  assert.throws(() => persistence.save([source]), /resident_command_storage_invalid/); assert.equal(reads, 0);
  assert.equal(storage.values.size, 0); assert.equal(storage.calls.length, 0);
});

test('resident command storage: capacity bounds preserve all pending requests without expiry or eviction', () => {
  const storage = new SessionStorage(), persistence = residentCommandPersistence(storage, scope), sixteen = Array.from({ length: 16 }, (_, index) => ticket(index));
  persistence.save(sixteen); const before = storage.values.get(key()); assert.deepEqual(persistence.load(), sixteen);
  assert.throws(() => persistence.save([...sixteen, ticket(16)]), /resident_command_storage_capacity/); assert.equal(storage.values.get(key()), before);
  const exact = JSON.stringify(envelope()).padEnd(32768, ' '); storage.values.set(key(), exact); assert.deepEqual(persistence.load(), [ticket()]);
  const multibyte = JSON.stringify(envelope([ticket()], { ...scope, conversationId: '한'.repeat(256) })).padEnd(32768, ' ');
  for (const raw of [exact + ' ', multibyte, JSON.stringify(envelope([...sixteen, ticket(16)]))]) {
    storage.values.set(key(), raw);
    assert.throws(() => persistence.load(), /resident_command_storage_capacity/);
    assert.throws(() => persistence.save([]), /resident_command_storage_capacity/);
    assert.equal(storage.values.get(key()), raw);
  }
});

test('resident command storage: read, write and removal failures preserve the old request and block replacement', () => {
  const storage = new SessionStorage(), persistence = residentCommandPersistence(storage, scope); persistence.save([ticket()]);
  const before = storage.values.get(key());
  storage.fail = 'get'; storage.calls.length = 0;
  assert.throws(() => residentCommandPersistence(storage, scope).load(), /resident_command_storage_unavailable/);
  assert.throws(() => persistence.save([ticket(1)]), /resident_command_storage_unavailable/);
  assert.throws(() => persistence.save([]), /resident_command_storage_unavailable/);
  assert.ok(storage.calls.every(call => call === 'get')); assert.equal(storage.values.get(key()), before);
  storage.fail = 'set'; assert.throws(() => persistence.save([ticket(1)]), /resident_command_storage_unavailable/); assert.equal(storage.values.get(key()), before);
  storage.fail = 'remove'; assert.throws(() => persistence.save([]), /resident_command_storage_unavailable/); assert.equal(storage.values.get(key()), before);
  storage.fail = null; assert.deepEqual(residentCommandPersistence(storage, scope).load(), [ticket()]);
  storage.values.set(key(), '{changed after load');
  assert.throws(() => persistence.save([ticket(1)]), /resident_command_storage_invalid/);
  assert.equal(storage.values.get(key()), '{changed after load');
});
