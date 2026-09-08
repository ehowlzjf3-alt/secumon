import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskSpec } from '../domain/model.js';
import { BOARD_READ_TOOL } from '../application/board-tools.js';
import { BOARD_REQUEST_READ_TOOL } from '../application/board-request-tools.js';
import { BOARD_REQUEST_TOOLS, BOARD_WRITE_TOOLS } from '../application/board-commands.js';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { openRegisteredHostBoard, resolveHostBoardRegistration } from '../presentation/host-board.js';
import { openHostArchive } from '../presentation/host-archive.js';
import { HOST_ENTRY_TEXT } from './host-tool-entry-fixture.js';
import { ARCHIVE_ID, SHARED_SCOPE, archiveRegistrationProbe, boardRegistrationProbe,
  collaborationRegistrationFixture, offCollaborationHost } from './host-collaboration-registration-fixture.js';

const execute = promisify(execFile);
const boardIds = [BOARD_READ_TOOL, BOARD_REQUEST_READ_TOOL, ...BOARD_WRITE_TOOLS, ...BOARD_REQUEST_TOOLS];
const task = (toolId: string, effect: TaskSpec['effect'], input: TaskSpec['input'] = {}): TaskSpec =>
  ({ id: 'registration-check', description: 'registration permission only', toolId, toolVersion: '1', effect, input,
    dependsOn: [], maxAttempts: 1, satisfies: [] });
const readArchiveIds = [`${ARCHIVE_ID}.get`, `${ARCHIVE_ID}.search`].sort();
const writeArchiveIds = ['register', 'revise', 'delete'].map(name => `${ARCHIVE_ID}.${name}`).sort();
const errorsIn = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(errorsIn) : [error];

test('collaboration registration: disabled factories stay unopened while the ordinary CLI keeps a usable persistent session', { timeout: 90000 }, async t => {
  const f = collaborationRegistrationFixture(t), audit = join(f.base, 'cli-audit.jsonl');
  const program = `import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import {runAgentTurnCli} from ${JSON.stringify(new URL('../presentation/agent-turn-cli.js', import.meta.url).href)};
import {offCollaborationHost} from ${JSON.stringify(new URL('./host-collaboration-registration-fixture.js', import.meta.url).href)};
const f=offCollaborationHost(${JSON.stringify(f.options)});
await runAgentTurnCli(process.argv.slice(1),f.host);
assert.deepEqual(f.counts,{boardSelections:0,archiveSelections:0,boardOpens:0,archiveOpens:0});
for(const input of f.observed.modelInputs)assert.equal(input.packet.activeToolIds.some(id=>id.startsWith('core.board.')||id.startsWith(${JSON.stringify(ARCHIVE_ID + '.')})),false);
appendFileSync(${JSON.stringify(audit)},JSON.stringify({counts:f.counts,reads:f.observed.reads,models:f.observed.modelInputs.length,toolCloses:f.observed.toolCloses,modelCloses:f.observed.modelCloses})+String.fromCharCode(10),{mode:0o600});`;
  interface Chat { workId: string; sessionId: string; snapshot: { status: string }; messages: { kind: string; text: string }[] }
  async function cli(args: string[]) {
    const result = await execute(process.execPath, ['--input-type=module', '-e', program, ...args, '--directory', f.directory, '--provider', 'registered', '--json'],
      { timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(result.stdout) as Chat;
  }
  const first = await cli(['ask', '--message-id', 'first', '--text', HOST_ENTRY_TEXT]);
  assert.equal(first.snapshot.status, 'completed'); assert.equal(first.messages.find(value => value.kind === 'result')?.text, f.options.text);
  const again = await cli(['resume', '--work', first.workId, '--session', first.sessionId]);
  assert.equal(again.workId, first.workId); assert.equal(again.sessionId, first.sessionId); assert.equal(again.snapshot.status, 'completed');
  const next = await cli(['ask', '--message-id', 'next', '--session', first.sessionId, '--text', HOST_ENTRY_TEXT]);
  assert.equal(next.snapshot.status, 'completed'); assert.notEqual(next.workId, first.workId); assert.equal(next.sessionId, first.sessionId);
  const observations = readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { reads: number; models: number; toolCloses: number; modelCloses: number });
  assert.deepEqual(observations.map(value => [value.reads, value.models, value.toolCloses, value.modelCloses]), [[1, 2, 1, 1], [0, 0, 1, 1], [1, 2, 1, 1]]);
  const host = offCollaborationHost(f.options), profile = f.track(await openAgentTurnProfile(f.directory, { provider: 'registered' }, host.host));
  assert.equal(profile.board, null); assert.equal(profile.archive, null);
  for (const id of [...boardIds, ...readArchiveIds, ...writeArchiveIds]) assert.equal(profile.contracts.get(id, '1'), undefined);
  const history = await profile.sessions.history(profile.actor, first.sessionId, profile.policy, { limit: 100 });
  assert.deepEqual(history.entries.filter(entry => entry.role === 'user').map(entry => entry.sourceId), ['first', 'next']);
  assert.deepEqual(host.counts, { boardSelections: 0, archiveSelections: 0, boardOpens: 0, archiveOpens: 0 });
  await profile.close();
});

test('collaboration registration: enabled board or archive without a host registration fails before providers open', async t => {
  for (const feature of ['board', 'archive'] as const) {
    const f = collaborationRegistrationFixture(t, { board: feature === 'board', archive: feature === 'archive' });
    await assert.rejects(openAgentTurnProfile(f.directory, { provider: 'registered' }, f.entry.host), new RegExp(`^Error: agent_${feature}_registration_required$`));
    assert.equal(f.entry.observed.toolContexts.length, 0); assert.equal(f.entry.observed.modelInputs.length, 0);
    assert.equal(f.entry.observed.toolCloses, 0); assert.equal(f.entry.observed.modelCloses, 0);
  }
});

test('collaboration registration: board write permission enables only the explicitly selected board tools', async t => {
  for (const allowWrites of [false, true]) {
    const f = collaborationRegistrationFixture(t, { board: true, archive: false });
    const selected: string[] = [BOARD_READ_TOOL, ...(allowWrites ? [BOARD_WRITE_TOOLS[0]] : [])];
    const board = boardRegistrationProbe(f.context, { allowWrites, allowedTools: selected });
    const profile = f.track(await openAgentTurnProfile(f.directory, { provider: 'registered' }, { ...f.entry.host, board: board.registration }));
    assert.ok(profile.board); assert.equal(profile.archive, null); assert.equal(profile.policy.allowWrites, allowWrites);
    assert.equal(profile.actor.allowWrites, allowWrites);
    assert.deepEqual(profile.contracts.visible(profile.policy).filter(item => item.id.startsWith('core.board.')).map(item => item.id).sort(), selected.sort());
    for (const id of boardIds.filter(id => !selected.includes(id))) {
      const definition = profile.contracts.get(id, '1')!.tool.definition;
      assert.equal(profile.contracts.checkExecution(task(id, definition.effect), profile.policy), 'tool_permission_denied');
    }
    assert.equal(board.counts.commits, 0); assert.equal(f.entry.observed.modelInputs.length, 0);
    const close = profile.close(); assert.equal(profile.close(), close); await close; await profile.close();
    assert.equal(board.counts.closes, 1); assert.equal(board.counts.repositoryCloses, 1);
    assert.equal(f.entry.observed.toolCloses, 1); assert.equal(f.entry.observed.modelCloses, 1);
  }
  const f = collaborationRegistrationFixture(t, { board: true, archive: false });
  const denied = boardRegistrationProbe(f.context, { allowWrites: false, allowedTools: [BOARD_WRITE_TOOLS[0]] });
  await assert.rejects(openAgentTurnProfile(f.directory, { provider: 'registered' }, { ...f.entry.host, board: denied.registration }), /agent_board_registration_invalid/);
  assert.equal(denied.counts.closes, 1); assert.equal(denied.counts.commits, 0);
});

test('collaboration registration: archive capability and explicit host write grant remain separate in the ordinary profile', async t => {
  for (const access of ['read_only', 'read_register'] as const) for (const allowWrites of [false, true]) {
    const f = collaborationRegistrationFixture(t, { board: false, archive: true }), archive = archiveRegistrationProbe({ access, allowWrites });
    const open = () => openAgentTurnProfile(f.directory, { provider: 'registered' }, { ...f.entry.host, archive: archive.registration });
    if (access === 'read_only' && allowWrites) {
      await assert.rejects(open(), /archive_write_not_supported/); assert.equal(archive.counts.closes, 1);
    } else {
      const profile = f.track(await open()); assert.ok(profile.archive); assert.equal(profile.board, null);
      assert.equal(profile.archive.descriptor.access, access); assert.equal(profile.archive.allowWrites, allowWrites);
      assert.equal(profile.policy.allowWrites, allowWrites); assert.equal(profile.actor.allowWrites, allowWrites);
      assert.deepEqual(profile.contracts.visible(profile.policy).filter(item => item.provider === ARCHIVE_ID).map(item => item.id).sort(),
        [...readArchiveIds, ...(allowWrites ? writeArchiveIds : [])].sort());
      if (!allowWrites) for (const id of writeArchiveIds) assert.equal(profile.contracts.get(id, '1'), undefined);
      await profile.close(); await profile.close(); assert.equal(archive.counts.closes, 1);
      assert.equal(f.entry.observed.modelCloses, 1);
    }
    assert.equal(archive.counts.mutations, 0); assert.equal(archive.counts.searches, 0); assert.equal(archive.counts.gets, 0);
    assert.equal(f.entry.observed.modelInputs.length, 0); assert.equal(f.entry.observed.toolCloses, 1);
  }
});

test('collaboration registration: board actor identity is current and explicit shared scopes survive policy intersection', async t => {
  const f = collaborationRegistrationFixture(t, { board: true, archive: false });
  for (const change of ['tenant', 'principal', 'scope'] as const) {
    const board = boardRegistrationProbe(f.context);
    if (change === 'tenant') board.controls.actor.tenantId = 'another-company';
    if (change === 'principal') board.controls.actor.principalId = 'another-operator';
    if (change === 'scope') board.controls.actor.allowedScopes = [SHARED_SCOPE];
    await assert.rejects(openAgentTurnProfile(f.directory, { provider: 'registered' }, { ...f.entry.host, board: board.registration }), /agent_board_actor_mismatch/);
    assert.equal(board.counts.closes, 1); assert.equal(board.counts.gets, 0); assert.equal(board.counts.commits, 0);
  }
  const board = boardRegistrationProbe(f.context), opened = f.track(await openRegisteredHostBoard(board.registration, f.context));
  const actor = await opened.actors.current();
  assert.deepEqual(actor.allowedScopes, [f.context.scope, SHARED_SCOPE]); assert.deepEqual(actor.allowedLabels, ['internal', 'public']);
  assert.equal(actor.canPublish, false); assert.equal(actor.canManageBoards, false);
  const identity = { tenantId: f.context.policy.tenantId, principalId: f.context.policy.principalId };
  const authorized = await opened.authority.resolve(identity); assert.ok(authorized);
  assert.deepEqual(authorized.allowedDestinations, ['local']); assert.deepEqual(authorized.allowedScopes, actor.allowedScopes); assert.equal(authorized.canPublish, false);
  const calls = board.counts.authorities;
  assert.equal(await opened.authority.resolve({ ...identity, tenantId: 'another-company' }), null);
  assert.equal(board.counts.authorities, calls);
  await assert.rejects(opened.authority.resolve({ ...identity, principalId: 'another-operator' }), /agent_board_actor_mismatch/);
  await assert.rejects(opened.repository.get('another-company', 'board'), /agent_board_actor_mismatch/); assert.equal(board.counts.gets, 0);
  board.controls.actor.principalId = 'changed-after-open';
  await assert.rejects(opened.actors.current(), /agent_board_actor_mismatch/);
  await assert.rejects(opened.repository.commit({ expectedRevision: 0, commandId: 'not-permitted', commandDigest: 'a'.repeat(64), next: board.board }), /agent_board_write_denied/);
  assert.equal(board.counts.commits, 0); await opened.close();
});

test('collaboration registration: board selection metadata and bound provider methods are captured once', async t => {
  const f = collaborationRegistrationFixture(t), board = boardRegistrationProbe(f.context);
  const originalOpen = board.registration.open; let reads = 0;
  Object.defineProperty(board.registration, 'open', { configurable: true, get() { reads++; return originalOpen; } });
  const selected = resolveHostBoardRegistration({ board: board.registration }); assert.ok(selected);
  Object.defineProperty(board.registration, 'open', { value: async () => { assert.fail('replacement board factory'); } });
  const opened = f.track(await openRegisteredHostBoard(selected, f.context));
  assert.equal(reads, 1); assert.equal(board.counts.opens, 1);
  assert.equal(Object.isFrozen(board.contexts[0]), true); assert.equal(Object.isFrozen(board.contexts[0]!.policy), true);
  assert.notEqual(board.contexts[0]!.policy, f.context.policy);
  (board.lease.allowedTools as string[]).push(BOARD_WRITE_TOOLS[0]);
  board.repository.get = async () => { assert.fail('replacement board get'); };
  board.repository.receipt = async () => { assert.fail('replacement board receipt'); };
  board.actors.current = async () => { assert.fail('replacement board actor'); };
  board.authority.resolve = async () => { assert.fail('replacement board authority'); };
  board.lease.close = async () => { assert.fail('replacement board close'); };
  assert.deepEqual(opened.allowedTools, [BOARD_READ_TOOL]); assert.equal(Object.isFrozen(opened.allowedTools), true);
  assert.deepEqual(await opened.repository.get('company', 'board'), board.board);
  assert.equal(await opened.repository.receipt('company', 'board', 'command'), null);
  assert.equal((await opened.actors.current()).principalId, 'operator');
  assert.ok(await opened.authority.resolve({ tenantId: 'company', principalId: 'operator' }));
  const close = opened.close(); assert.equal(opened.close(), close); await close;
  assert.equal(board.counts.gets, 1); assert.equal(board.counts.receipts, 1); assert.equal(board.counts.closes, 1);
});

test('collaboration registration: archive captures descriptor and provider receiver while rejecting foreign actors', async t => {
  const f = collaborationRegistrationFixture(t), archive = archiveRegistrationProbe();
  const originalOpen = archive.registration.open; let reads = 0;
  Object.defineProperty(archive.registration, 'open', { configurable: true, get() { reads++; return originalOpen; } });
  const opened = await openHostArchive(archive.registration, f.archiveContext); assert.ok(opened); f.track(opened);
  const originalActor = structuredClone(f.archiveContext.actor);
  assert.deepEqual(opened.service.owner, { tenantId: 'company', principalId: 'operator', agentId: f.context.agentId, scope: f.context.scope });
  assert.equal(reads, 1); assert.equal(Object.isFrozen(archive.contexts[0]), true); assert.equal(Object.isFrozen(archive.contexts[0]!.actor), true);
  assert.notEqual(archive.contexts[0]!.actor, f.archiveContext.actor);
  archive.descriptor.id = 'replacement'; archive.descriptor.labels.push('host-secret');
  archive.provider.search = async () => { assert.fail('replacement archive search'); };
  archive.provider.get = async () => { assert.fail('replacement archive get'); };
  archive.lease.close = async () => { assert.fail('replacement archive close'); };
  Reflect.set(archive.registration, 'allowWrites', true);
  assert.equal(opened.allowWrites, false); assert.deepEqual([...opened.allowedTools].sort(), readArchiveIds);
  assert.deepEqual(await opened.service.search(originalActor, { query: '', limit: 1 }), { documents: [], truncated: false });
  assert.equal(await opened.service.get(originalActor, 'document'), null);
  for (const actor of [{ ...originalActor, tenantId: 'foreign' }, { ...originalActor, principalId: 'foreign' },
    { ...originalActor, allowedLabels: [] }, { ...originalActor, allowedDestinations: [] }])
    await assert.rejects(opened.service.get(actor, 'document'), /archive_access_denied/);
  assert.equal(archive.counts.gets, 1); assert.equal(archive.counts.searches, 1); assert.equal(archive.counts.mutations, 0);
  const close = opened.close(); assert.equal(opened.close(), close); await close; assert.equal(archive.counts.closes, 1);
});

test('collaboration registration: close rejects new and in-flight reads and closes each acquired provider once', { timeout: 10000 }, async t => {
  const f = collaborationRegistrationFixture(t), board = boardRegistrationProbe(f.context), archive = archiveRegistrationProbe();
  const openedBoard = f.track(await openRegisteredHostBoard(board.registration, f.context));
  const openedArchive = await openHostArchive(archive.registration, f.archiveContext); assert.ok(openedArchive); f.track(openedArchive);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  board.controls.beforeGet = () => gate; archive.controls.beforeGet = () => gate;
  const boardRead = openedBoard.repository.get('company', 'board').then(() => null, error => error as unknown);
  const archiveRead = openedArchive.service.get(f.archiveContext.actor, 'document').then(() => null, error => error as unknown);
  try {
    assert.equal(board.counts.gets, 1); assert.equal(archive.counts.gets, 1);
    const boardClose = openedBoard.close(), archiveClose = openedArchive.close();
    await assert.rejects(openedBoard.repository.get('company', 'board'), /agent_board_unavailable/);
    await assert.rejects(openedBoard.actors.current(), /agent_board_unavailable/);
    await assert.rejects(openedArchive.service.get(f.archiveContext.actor, 'document'), /archive_closed/);
    release();
    assert.match(String(await boardRead), /agent_board_unavailable/); assert.match(String(await archiveRead), /archive_closed/);
    await Promise.all([boardClose, archiveClose, openedBoard.close(), openedArchive.close()]);
    assert.equal(board.counts.gets, 1); assert.equal(archive.counts.gets, 1);
    assert.equal(board.counts.closes, 1); assert.equal(archive.counts.closes, 1);
  } finally { release(); await Promise.all([boardRead, archiveRead]); }
});

test('collaboration registration: factory and acquired-provider failures preserve errors and close unrelated owned resources', async t => {
  const f = collaborationRegistrationFixture(t, { board: true, archive: true });
  const board = boardRegistrationProbe(f.context), original = new Error('archive_factory_original');
  await assert.rejects(openAgentTurnProfile(f.directory, { provider: 'registered' }, { ...f.entry.host,
    board: board.registration, archive: { async open() { throw original; } } }), error => { assert.equal(error, original); return true; });
  assert.equal(board.counts.closes, 1); assert.equal(f.entry.observed.toolCloses, 1); assert.equal(f.entry.observed.modelCloses, 0);

  const other = collaborationRegistrationFixture(t, { board: true, archive: true });
  const acquiredBoard = boardRegistrationProbe(other.context), acquiredArchive = archiveRegistrationProbe();
  const boardClose = new Error('board_close_original'), archiveClose = new Error('archive_close_original');
  acquiredBoard.controls.closeError = boardClose; acquiredArchive.controls.closeError = archiveClose;
  Reflect.set(acquiredArchive.provider, 'search', undefined);
  await assert.rejects(openAgentTurnProfile(other.directory, { provider: 'registered' }, { ...other.entry.host,
    board: acquiredBoard.registration, archive: acquiredArchive.registration }), error => {
    const errors = errorsIn(error);
    assert.ok(errors.includes(boardClose)); assert.ok(errors.includes(archiveClose));
    assert.ok(errors.some(value => value instanceof Error && value.message === 'archive_registration_invalid')); return true;
  });
  assert.equal(acquiredBoard.counts.closes, 1); assert.equal(acquiredArchive.counts.closes, 1);
  assert.equal(other.entry.observed.toolCloses, 1); assert.equal(other.entry.observed.modelCloses, 0);
  assert.equal(acquiredBoard.counts.commits, 0); assert.equal(acquiredArchive.counts.mutations, 0);
});
