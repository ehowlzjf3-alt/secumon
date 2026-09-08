import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArchiveDescriptor, ArchiveProvider } from '../application/archive-contracts.js';
import type { BoardActorProvider, BoardRepository } from '../application/board-ports.js';
import type { InputAuthority } from '../application/knowledge-ports.js';
import type { BoardActor, BoardState } from '../domain/board.js';
import type { TrustedKnowledgeActor } from '../domain/knowledge.js';
import type { Policy } from '../domain/model.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import type { HostBoardContext, HostBoardRegistration, OpenedHostBoard } from '../presentation/host-board.js';
import type { HostArchiveContext, HostArchiveRegistration, OpenedArchiveProvider } from '../presentation/host-archive.js';
import type { AgentExecutionHost } from '../presentation/host-tools.js';
import { hostEntryFixture, HOST_ENTRY_PROFILE, type HostEntryOptions } from './host-tool-entry-fixture.js';

const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
export const SHARED_SCOPE = 'shared:registration-board';
export const ARCHIVE_ID = 'registered-archive';
export function collaborationRegistrationFixture(t: TestContext, features = { board: false, archive: false }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'collaboration-registration-'))), directory = join(base, 'agent');
  const ready = new FileAgentProfileStore(runtimeRoot).initialize(directory);
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...ready.config,
    model: { profile: HOST_ENTRY_PROFILE }, features: { ...ready.config.features, ...features }, skills: { mode: 'off' } }), { mode: 0o600 });
  const options = { text: '등록을 끈 담당의 원문입니다.', identityRegistryDirectory: join(base, 'registry') };
  const entry = hostEntryFixture(options), closers = new Set<() => Promise<void>>();
  t.after(async () => {
    const errors: unknown[] = [];
    for (const close of closers) { try { await close(); } catch (error) { errors.push(error); } }
    try { rmSync(base, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'collaboration_registration_cleanup_failed');
  });
  const policy: Policy = { tenantId: 'company', principalId: 'operator', allowedTools: [],
    allowedLabels: ['internal', 'public'], allowedDestinations: ['local'], allowWrites: false };
  const controller = new AbortController();
  const context: HostBoardContext = { agentId: ready.identity.agentId, root: directory,
    scope: `agent:${ready.identity.agentId}`, policy, signal: controller.signal };
  const archiveContext: HostArchiveContext = { agentId: context.agentId, root: directory, scope: context.scope, actor: policy, signal: controller.signal };
  return { base, directory, entry, options, context, archiveContext, controller,
    track<T extends { close(): Promise<void> }>(value: T): T { closers.add(() => value.close()); return value; } };
}

export function offCollaborationHost(options: HostEntryOptions) {
  const entry = hostEntryFixture(options), counts = { boardSelections: 0, archiveSelections: 0, boardOpens: 0, archiveOpens: 0 };
  const host: AgentExecutionHost = { ...entry.host,
    get board() { counts.boardSelections++; return { async open() { counts.boardOpens++; throw new Error('off_board_opened'); } }; },
    get archive() { counts.archiveSelections++; return { async open() { counts.archiveOpens++; throw new Error('off_archive_opened'); } }; },
  };
  return { ...entry, host, counts };
}

/** Small bound port doubles; storage/service mutation semantics belong to the separate board/archive suites. */
export function boardRegistrationProbe(context: HostBoardContext, options: { allowWrites?: boolean; allowedTools?: string[] } = {}) {
  const actor: BoardActor = { tenantId: context.policy.tenantId, principalId: context.policy.principalId,
    allowedLabels: ['internal', 'public', 'host-secret'], allowedNamespaces: ['team'], allowedScopes: [context.scope, SHARED_SCOPE],
    canReview: true, canPublish: true, canManageBoards: true };
  const knowledge: TrustedKnowledgeActor = { tenantId: actor.tenantId, principalId: actor.principalId,
    allowedLabels: [...actor.allowedLabels], allowedNamespaces: ['team'], allowedScopes: [...actor.allowedScopes],
    allowedDestinations: ['local', 'host-only'], canReview: true, canPublish: true };
  const board: BoardState = { schemaVersion: 1, id: 'board', tenantId: actor.tenantId, namespace: 'team', scope: SHARED_SCOPE,
    ownerId: actor.principalId, revision: 1, createdAt: 1, updatedAt: 1, labels: ['internal'],
    limits: { maxPosts: 20, maxReplies: 5, maxUnproductiveReplies: 3, maxRequests: 10 },
    roles: [{ id: 'member', principalId: actor.principalId, purpose: 'registration boundary', active: true }], entities: [], posts: [], requests: [] };
  const controls: { actor: BoardActor; knowledge: TrustedKnowledgeActor | null; beforeGet?: () => Promise<void>; closeError?: Error } = { actor, knowledge };
  const counts = { opens: 0, actors: 0, authorities: 0, gets: 0, receipts: 0, commits: 0, closes: 0, repositoryCloses: 0 };
  const contexts: HostBoardContext[] = [];
  const actors: BoardActorProvider = { async current() {
    assert.equal(this, actors); counts.actors++; return structuredClone(controls.actor);
  } };
  const authority: InputAuthority = { async resolve() {
    assert.equal(this, authority); counts.authorities++; return structuredClone(controls.knowledge);
  } };
  const repository: BoardRepository = {
    async get() { assert.equal(this, repository); counts.gets++; await controls.beforeGet?.(); return structuredClone(board); },
    async receipt() { assert.equal(this, repository); counts.receipts++; return null; },
    async commit(command) { assert.equal(this, repository); counts.commits++; return { kind: 'not_applied', revision: command.next.revision }; },
    async close() { assert.equal(this, repository); counts.repositoryCloses++; },
  };
  const lease: OpenedHostBoard = { repository, actors, authority, allowedTools: options.allowedTools ?? ['core.board.read'], allowWrites: options.allowWrites ?? false,
    async close() { assert.equal(this, lease); counts.closes++; await repository.close(); if (controls.closeError) throw controls.closeError; } };
  const registration: HostBoardRegistration = { async open(value) {
    assert.equal(this, registration); counts.opens++; contexts.push(value); return lease;
  } };
  return { registration, lease, repository, actors, authority, contexts, controls, counts, board };
}

export function archiveRegistrationProbe(options: { access?: ArchiveDescriptor['access']; allowWrites?: boolean } = {}) {
  const descriptor: ArchiveDescriptor = { id: ARCHIVE_ID, version: '1', destination: 'local', labels: ['internal'], access: options.access ?? 'read_register' };
  const controls: { beforeGet?: () => Promise<void>; closeError?: Error } = {};
  const counts = { opens: 0, searches: 0, gets: 0, mutations: 0, receipts: 0, closes: 0 };
  const contexts: Readonly<HostArchiveContext>[] = [];
  const provider: ArchiveProvider = { descriptor,
    async search() { assert.equal(this, provider); counts.searches++; return { documents: [], truncated: false }; },
    async get() { assert.equal(this, provider); counts.gets++; await controls.beforeGet?.(); return null; },
    async mutate() { assert.equal(this, provider); counts.mutations++; throw new Error('archive_mutation_outside_registration_test'); },
    async receipt() { assert.equal(this, provider); counts.receipts++; return null; },
  };
  const lease: OpenedArchiveProvider = { provider,
    async close() { assert.equal(this, lease); counts.closes++; if (controls.closeError) throw controls.closeError; } };
  const registration: HostArchiveRegistration = { ...(options.allowWrites === undefined ? {} : { allowWrites: options.allowWrites }),
    async open(context) { assert.equal(this, registration); counts.opens++; contexts.push(context); return lease; } };
  return { registration, lease, provider, descriptor, contexts, controls, counts };
}
