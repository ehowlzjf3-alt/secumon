import { captureEngineApi, EngineExtensionError, type EngineApiRegistration } from '../application/engine-extension-contracts.js';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { PolicySchema } from '../application/contracts.js';
import { BoardActorSchema } from '../application/board-contracts.js';
import { BOARD_READ_TOOL } from '../application/board-tools.js';
import { BOARD_REQUEST_READ_TOOL } from '../application/board-request-tools.js';
import { BOARD_WRITE_TOOLS, BOARD_REQUEST_TOOLS } from '../application/board-commands.js';
import { parseKnowledgeActor } from '../application/knowledge-contracts.js';
import type { BoardActorProvider, BoardRepository } from '../application/board-ports.js';
import type { BoardWorkSource, BoardWorkSources } from '../application/board-work-sources.js';
import type { WorkInputSource } from '../application/work-input-source.js';
import type { InputAuthority } from '../application/knowledge-ports.js';
import { frozen } from '../application/resource-contracts.js';
import type { Policy } from '../domain/model.js';
import { FileBoardRepository } from '../infrastructure/file-board.js';
import { SqliteBoardRepository } from '../infrastructure/sqlite-board.js';
import { closeAgentTurnResources } from './host-models.js';
import { PostgresBindingSchema, PostgresStore, type PostgresBinding, type PostgresPool } from '../infrastructure/postgres-store.js';
import { PostgresBoardRepository } from '../infrastructure/postgres-board.js';

export interface HostBoardContext {
  readonly agentId: string;
  readonly root: string;
  readonly scope: string;
  readonly policy: Policy;
  readonly signal: AbortSignal;
}
export interface OpenedHostBoard {
  readonly repository: BoardRepository;
  readonly actors: BoardActorProvider;
  readonly authority: InputAuthority;
  readonly allowedTools: readonly string[];
  readonly allowWrites: boolean;
  readonly workSources?: BoardWorkSources | undefined;
  close(): Promise<void>;
}
export interface HostBoardRegistration extends EngineApiRegistration { open(context: HostBoardContext): Promise<OpenedHostBoard> }
export interface LocalHostBoardOptions {
  readonly backend: 'sqlite' | 'file';
  /** A trusted absolute database path, or directory for the file provider. */
  readonly path: string;
  readonly actors: BoardActorProvider;
  readonly authority: InputAuthority;
  readonly allowedTools: readonly string[];
  readonly allowWrites: boolean;
  readonly workSources?: BoardWorkSources | undefined;
}

const text = (maximum: number) => z.string().min(1).max(maximum).refine(value => value.trim().length > 0 && !value.includes('\0'));
const ContextSchema = z.strictObject({ agentId: text(256), root: text(4096), scope: text(256), policy: PolicySchema });
const IdentitySchema = z.strictObject({ tenantId: text(256), principalId: text(256) });
const WorkIdentitySchema = IdentitySchema.extend({ workId: text(256) });
const toolIds = [BOARD_READ_TOOL, BOARD_REQUEST_READ_TOOL, ...BOARD_WRITE_TOOLS, ...BOARD_REQUEST_TOOLS] as const;
const writeIds = new Set<string>([...BOARD_WRITE_TOOLS, ...BOARD_REQUEST_TOOLS]);
const ToolsSchema = z.array(z.enum(toolIds)).max(toolIds.length).refine(ids => new Set(ids).size === ids.length);
function invalid(cause?: unknown): Error {
  return new Error('agent_board_registration_invalid', cause === undefined ? undefined : { cause });
}
function captureRegistration(value: unknown): HostBoardRegistration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const open = (value as HostBoardRegistration).open;
  if (typeof open !== 'function') throw invalid();
  const api = captureEngineApi(value as HostBoardRegistration);
  return Object.freeze({ ...(api.engineApi ? { engineApi: api.engineApi } : {}),
    open(...args: Parameters<HostBoardRegistration['open']>) { api.assertCurrent(); return open.apply(value, args); } });
}
function selectedTools(value: readonly string[], allowWrites: boolean) {
  if (typeof allowWrites !== 'boolean') throw invalid();
  const tools = ToolsSchema.parse(structuredClone(value));
  if (!allowWrites && tools.some(id => writeIds.has(id))) throw invalid();
  return Object.freeze(tools);
}
function captureActors(value: BoardActorProvider) {
  if (!value || typeof value !== 'object') throw invalid();
  const current = value.current; if (typeof current !== 'function') throw invalid();
  return current.bind(value);
}
function captureAuthority(value: InputAuthority) {
  if (!value || typeof value !== 'object') throw invalid();
  const resolve = value.resolve; if (typeof resolve !== 'function') throw invalid();
  return resolve.bind(value);
}
function captureWorkSources(value: BoardWorkSources | undefined, live: () => void, tenantId?: string): BoardWorkSources | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw invalid();
  const method = value.resolve; if (typeof method !== 'function') throw invalid();
  const resolve = method.bind(value);
  const captured = new WeakMap<BoardWorkSource, { owner: string; wrapped: BoardWorkSource }>();
  return Object.freeze({ async resolve(identity: Parameters<BoardWorkSources['resolve']>[0]): Promise<BoardWorkSource | null> {
    live(); const expected = frozen(WorkIdentitySchema.parse(structuredClone(identity)));
    if (tenantId !== undefined && expected.tenantId !== tenantId) throw new Error('agent_board_actor_mismatch');
    const source = await resolve(expected); live(); if (source === null) return null;
    if (!source || typeof source !== 'object') throw invalid();
    const owner = JSON.stringify([expected.tenantId, expected.principalId]), cached = captured.get(source);
    if (cached) { if (cached.owner !== owner) throw new Error('agent_board_actor_mismatch'); return cached.wrapped; }
    const { inputs, artifacts, current } = source;
    if (!inputs || !artifacts || typeof current !== 'function') throw invalid();
    const { id, state, authority, inspectInput, inspectMemory, effectsCurrent, inspectCoverage } = inputs;
    if (!state || !authority || !text(256).safeParse(id).success || typeof inspectInput !== 'function' ||
      typeof inspectMemory !== 'function' || typeof effectsCurrent !== 'function' || typeof inspectCoverage !== 'function') throw invalid();
    const getState = state.get, getArtifact = artifacts.get, exists = artifacts.exists;
    if (typeof getState !== 'function' || typeof getArtifact !== 'function' || typeof exists !== 'function') throw invalid();
    const read = getState.bind(state), readArtifact = getArtifact.bind(artifacts), hasArtifact = exists.bind(artifacts);
    const resolveActor = captureAuthority(authority), input = inspectInput.bind(inputs), memory = inspectMemory.bind(inputs);
    const effects = effectsCurrent.bind(inputs), coverage = inspectCoverage.bind(inputs), proof = current.bind(source);
    const sameOwner = (work: Parameters<BoardWorkSource['current']>[0]) => {
      live(); if (work.policy.tenantId !== expected.tenantId || work.policy.principalId !== expected.principalId) throw new Error('agent_board_actor_mismatch');
    };
    const invoke = async <A extends unknown[], R>(call: (...args: A) => Promise<R>, ...args: A): Promise<R> => {
      live(); const result = await call(...args); live(); return result;
    };
    const selectedInputs: WorkInputSource = Object.freeze({ id, identity: source.inputs.identity ?? source.inputs,
      state: Object.freeze({ async get(workId: string) { const work = await invoke(read, workId); if (work) sameOwner(work); return work; } }),
      authority: Object.freeze({ async resolve(actorIdentity: Parameters<InputAuthority['resolve']>[0]) {
        live(); if (actorIdentity.tenantId !== expected.tenantId || actorIdentity.principalId !== expected.principalId) return null;
        const actor = await invoke(resolveActor, actorIdentity); if (actor === null) return null;
        const parsed = parseKnowledgeActor(actor);
        if (parsed.tenantId !== expected.tenantId || parsed.principalId !== expected.principalId) throw new Error('agent_board_actor_mismatch');
        return parsed;
      } }),
      async inspectInput(...args: Parameters<WorkInputSource['inspectInput']>) { sameOwner(args[1]); return invoke(input, ...args); },
      async inspectMemory(...args: Parameters<WorkInputSource['inspectMemory']>) { sameOwner(args[3]); return invoke(memory, ...args); },
      async effectsCurrent(work: Parameters<WorkInputSource['effectsCurrent']>[0]) { sameOwner(work); return invoke(effects, work); },
      async inspectCoverage(work: Parameters<WorkInputSource['inspectCoverage']>[0]) { sameOwner(work); return invoke(coverage, work); },
    });
    const wrapped: BoardWorkSource = Object.freeze({ inputs: selectedInputs,
      artifacts: Object.freeze({
        get: (...args: Parameters<BoardWorkSource['artifacts']['get']>) => invoke(readArtifact, ...args),
        exists: (...args: Parameters<BoardWorkSource['artifacts']['exists']>) => invoke(hasArtifact, ...args),
      }),
      async current(work: Parameters<BoardWorkSource['current']>[0]) { sameOwner(work); return invoke(proof, work); },
    });
    captured.set(source, { owner, wrapped }); return wrapped;
  } });
}

/** Only trusted startup code supplies a board registration; agent configuration is an on/off selection. */
export function resolveHostBoardRegistration(host: { readonly board?: HostBoardRegistration } | undefined): HostBoardRegistration | null {
  try {
    if (host === undefined) return null;
    if (!host || typeof host !== 'object' || Array.isArray(host)) throw invalid();
    const registration = host.board;
    return registration === undefined ? null : captureRegistration(registration);
  } catch (error) { throw error instanceof EngineExtensionError || error instanceof Error && error.message === 'agent_board_registration_invalid' ? error : invalid(error); }
}

/** Capture one owned lease while preserving dynamic identity/grant checks on the existing board ports. */
export async function openRegisteredHostBoard(registration: HostBoardRegistration, context: HostBoardContext): Promise<OpenedHostBoard> {
  let selected: HostBoardRegistration, expected: HostBoardContext;
  try {
    selected = captureRegistration(registration);
    const { signal, ...metadata } = context;
    if (!(signal instanceof AbortSignal)) throw invalid();
    expected = Object.freeze({ ...frozen(ContextSchema.parse(structuredClone(metadata))), signal });
    if (signal.aborted) throw new Error('agent_board_unavailable');
  } catch (error) { throw error instanceof EngineExtensionError ? error : invalid(error); }
  // The registration owns partial acquisition until it returns its closer. Preserve factory errors as-is.
  const opened = await selected.open(expected);
  let close: (() => Promise<void>) | undefined;
  try {
    if (!opened || typeof opened !== 'object') throw invalid();
    const sourceClose = opened.close; if (typeof sourceClose !== 'function') throw invalid();
    const rawClose = sourceClose.bind(opened); let closing: Promise<void> | undefined, closed = false;
    close = () => { closed = true; return closing ??= Promise.resolve().then(rawClose); };
    const live = () => { if (closed || expected.signal.aborted) throw new Error('agent_board_unavailable'); };
    const allowWrites = opened.allowWrites, allowedTools = selectedTools(opened.allowedTools, allowWrites);
    const workSources = captureWorkSources(opened.workSources, live, expected.policy.tenantId);
    const current = captureActors(opened.actors), resolve = captureAuthority(opened.authority);
    const source = opened.repository;
    if (!source || typeof source !== 'object') throw invalid();
    const { get, receipt, commit, changes, close: repositoryClose } = source;
    if (typeof get !== 'function' || typeof receipt !== 'function' || typeof commit !== 'function' || typeof repositoryClose !== 'function' ||
      changes !== undefined && typeof changes !== 'function') throw invalid();
    const read = get.bind(source), readReceipt = receipt.bind(source), apply = commit.bind(source), page = changes?.bind(source);
    const tenant = (id: string) => { live(); if (id !== expected.policy.tenantId) throw new Error('agent_board_actor_mismatch'); };
    const actors: BoardActorProvider = Object.freeze({ async current() {
      live(); const actor = BoardActorSchema.parse(await current()); live();
      if (actor.tenantId !== expected.policy.tenantId || actor.principalId !== expected.policy.principalId ||
        !actor.allowedScopes.includes(expected.scope)) throw new Error('agent_board_actor_mismatch');
      return { ...actor, allowedLabels: actor.allowedLabels.filter(label => expected.policy.allowedLabels.includes(label)),
        canPublish: actor.canPublish && allowWrites, canManageBoards: actor.canManageBoards && allowWrites };
    } });
    const authority: InputAuthority = Object.freeze({ async resolve(identity: Parameters<InputAuthority['resolve']>[0]) {
      live(); const selectedIdentity = IdentitySchema.parse(structuredClone(identity));
      if (selectedIdentity.tenantId !== expected.policy.tenantId) return null;
      const value = await resolve(selectedIdentity); live(); if (value === null) return null;
      const actor = parseKnowledgeActor(value);
      if (actor.tenantId !== selectedIdentity.tenantId || actor.principalId !== selectedIdentity.principalId) throw new Error('agent_board_actor_mismatch');
      return { ...actor, allowedLabels: actor.allowedLabels.filter(label => expected.policy.allowedLabels.includes(label)),
        canPublish: actor.canPublish && allowWrites,
        ...(actor.allowedDestinations === undefined ? {} : { allowedDestinations: actor.allowedDestinations.filter(destination => expected.policy.allowedDestinations.includes(destination)) }) };
    } });
    const repository: BoardRepository = Object.freeze({
      async get(tenantId: string, id: string) { tenant(tenantId); const value = await read(tenantId, id); live(); return value; },
      async receipt(tenantId: string, id: string, commandId: string) { tenant(tenantId); const value = await readReceipt(tenantId, id, commandId); live(); return value; },
      async commit(command: Parameters<BoardRepository['commit']>[0]) {
        tenant(command.next.tenantId); if (!allowWrites) throw new Error('agent_board_write_denied');
        if (!(await actors.current()).allowedScopes.includes(command.next.scope)) throw new Error('agent_board_actor_mismatch');
        const value = await apply(command); live(); return value;
      },
      ...(page ? { async changes(tenantId: string, id: string, query: Parameters<NonNullable<BoardRepository['changes']>>[2]) {
        tenant(tenantId); const value = await page(tenantId, id, query); live(); return value;
      } } : {}), close,
    });
    await actors.current();
    return Object.freeze({ repository, actors, authority, allowedTools, allowWrites, ...(workSources ? { workSources } : {}), close });
  } catch (error) {
    await closeAgentTurnResources(close ? [close] : [], { error });
    throw error;
  }
}

/** Opens only the host-selected store. It creates no logical board, membership, post or request. */
export function createLocalHostBoard(options: LocalHostBoardOptions): HostBoardRegistration {
  const { backend, path, allowWrites } = options;
  if (!['sqlite', 'file'].includes(backend) || typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw invalid();
  const allowedTools = selectedTools(options.allowedTools, allowWrites);
  const current = captureActors(options.actors), resolve = captureAuthority(options.authority);
  const workSources = captureWorkSources(options.workSources, () => {});
  return Object.freeze({ async open(context: HostBoardContext): Promise<OpenedHostBoard> {
    if (context.signal.aborted) throw new Error('agent_board_unavailable');
    const repository = backend === 'sqlite' ? new SqliteBoardRepository(path) : new FileBoardRepository(path);
    let closing: Promise<void> | undefined;
    return { repository, actors: Object.freeze({ current }), authority: Object.freeze({ resolve }), allowedTools, allowWrites,
      ...(workSources ? { workSources } : {}),
      close: () => closing ??= Promise.resolve().then(() => repository.close()) };
  } });
}

/** The shared board has its own host-owned binding; it does not borrow a participant's personal database. */
export function createPostgresHostBoard(options: Omit<LocalHostBoardOptions, 'backend' | 'path'> & { pool: PostgresPool; binding: PostgresBinding }): HostBoardRegistration {
  const binding = PostgresBindingSchema.parse(options.binding), pool = { connect: options.pool.connect.bind(options.pool) };
  if (binding.purpose !== 'board') throw invalid();
  const allowWrites = options.allowWrites, allowedTools = selectedTools(options.allowedTools, allowWrites);
  const current = captureActors(options.actors), resolve = captureAuthority(options.authority);
  const workSources = captureWorkSources(options.workSources, () => {});
  return Object.freeze({ async open(context: HostBoardContext): Promise<OpenedHostBoard> {
    if (context.signal.aborted) throw new Error('agent_board_unavailable');
    const store = await PostgresStore.open(pool, binding);
    if (context.signal.aborted) { await store.close(); throw new Error('agent_board_unavailable'); }
    const repository = new PostgresBoardRepository(store);
    return { repository, actors: Object.freeze({ current }), authority: Object.freeze({ resolve }), allowedTools, allowWrites,
      ...(workSources ? { workSources } : {}), close: () => repository.close() };
  } });
}
