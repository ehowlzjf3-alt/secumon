import { accessibleEvidence } from '../domain/completion.js';
import { visibleArtifact } from '../domain/data-lifecycle.js';
import { canReadKnowledge, knowledgeCard, knowledgeSourceKey } from '../domain/knowledge.js';
import type { EvidenceKnowledgeSource, EvidenceKnowledgeSourceStamp, KnowledgeDependency, KnowledgeIndexHead, KnowledgeRead, KnowledgeRecord, KnowledgeSearch, KnowledgeSource, KnowledgeSourceStamp, PersonalMemoryOwner, TrustedKnowledgeActor } from '../domain/knowledge.js';
import type { Evidence, Json, WorkState } from '../domain/model.js';
import type { Clock, Digester, StateRepository } from './ports.js';
import { scopedKnowledgeRepository } from './knowledge-ports.js';
import type { KnowledgeRepository, KnowledgeUserSources, TrustedKnowledgeActorProvider } from './knowledge-ports.js';
import type { EffectProofValidator, WorkInputValidator } from './services.js';
import { InputValidationGraph, type InputReference } from './input-validation.js';
import type { SourceInputInspection } from './source-input-inspection.js';
import { effectProofsCurrent, requiresEffectProofs } from './effect-proofs.js';
import { CreateKnowledgeSchema, KnowledgeDependencySchema, KnowledgeMutationSchema, KnowledgeQuerySchema, KnowledgeReviewSchema, ReviseKnowledgeSchema, RememberPersonalSchema, RevisePersonalSchema, parseKnowledge, parseKnowledgeActor } from './knowledge-contracts.js';
import type { CreateKnowledgeInput, KnowledgeMutationInput, KnowledgeQueryInput, KnowledgeReviewInput, ReviseKnowledgeInput, RememberPersonalInput, RevisePersonalInput } from './knowledge-contracts.js';
import type { WorkActor } from './work-resources.js';
import { retainedKnowledgeDependencies } from './knowledge-validity.js';

type Dependencies = { repository: KnowledgeRepository; states: StateRepository; actors: TrustedKnowledgeActorProvider; digester: Digester; clock: Clock;
  effects?: Pick<EffectProofValidator, 'current'> | undefined; inputs?: WorkInputValidator | undefined; signal?: AbortSignal | undefined;
  userSources?: KnowledgeUserSources | undefined; personalOwner?: PersonalMemoryOwner | undefined };
const unavailable = () => new Error('knowledge_unavailable');
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const unique = (values: string[]) => [...new Set(values)].sort();
type KnowledgeSnapshot = { reads: KnowledgeRead[]; vector: string; head: KnowledgeIndexHead | null; validUntil: number | null };
type SourceCollection = Map<string, WorkState>;
const custodyEntryLimit = 256;
const custodyByteLimit = 4 * 1024 * 1024;
export type PersonalRevisionStatus = { id: string; revision: number; currentRevision: number | null; currentStatus: KnowledgeRecord['status'] | null };

export class KnowledgeService {
  readonly #d: Dependencies;
  readonly #rootRepository: KnowledgeRepository;
  readonly #cache = new Map<string, { ids: string[]; truncated: boolean }>();
  constructor(dependencies: Dependencies) {
    this.#rootRepository = dependencies.repository;
    this.#d = dependencies.personalOwner ? { ...dependencies, repository: scopedKnowledgeRepository(dependencies.repository,
      { agentId: dependencies.personalOwner.agentId, principalId: dependencies.personalOwner.principalId, partition: 'personal' }) } : dependencies;
  }

  async forPersonal(restriction?: WorkActor): Promise<KnowledgeService> {
    const selected = restriction ? structuredClone(restriction) : undefined;
    const actors: TrustedKnowledgeActorProvider = { current: async () => {
      const actor = await this.#actor();
      if (!actor.agentId || (selected && (selected.tenantId !== actor.tenantId || selected.principalId !== actor.principalId))) throw unavailable();
      return { ...actor,
        ...(selected?.allowedLabels ? { allowedLabels: actor.allowedLabels.filter(label => selected.allowedLabels!.includes(label)) } : {}),
        ...(selected?.allowedDestinations ? { allowedDestinations: (actor.allowedDestinations ?? selected.allowedDestinations).filter(destination => selected.allowedDestinations!.includes(destination)) } : {}) };
    } };
    const actor = await actors.current();
    if (!this.#d.userSources || !actor.allowedNamespaces.includes('personal')) throw unavailable();
    return new KnowledgeService({ ...this.#d, repository: this.#rootRepository, actors,
      personalOwner: { schemaVersion: 1, agentId: actor.agentId!, principalId: actor.principalId } });
  }

  async #actor(): Promise<TrustedKnowledgeActor> {
    if (this.#d.signal?.aborted) throw unavailable();
    const actor = parseKnowledgeActor(await this.#d.actors.current());
    if (this.#d.personalOwner && (actor.agentId !== this.#d.personalOwner.agentId || actor.principalId !== this.#d.personalOwner.principalId)) throw unavailable();
    if (this.#d.signal?.aborted) throw unavailable(); return actor;
  }
  #digest(value: unknown): string { return this.#d.digester.digest(json(value)); }
  #actorDigest(a: TrustedKnowledgeActor): string {
    return this.#digest({ ...a, ...(a.allowedDestinations ? { allowedDestinations: unique(a.allowedDestinations) } : {}),
      allowedLabels: unique(a.allowedLabels), allowedNamespaces: unique(a.allowedNamespaces), allowedScopes: unique(a.allowedScopes) });
  }
  #allowedPlace(actor: TrustedKnowledgeActor, namespace: string, scope?: string): void {
    if (this.#d.personalOwner) {
      if (namespace !== 'personal' || (scope !== undefined && scope !== 'personal') || !actor.allowedNamespaces.includes(namespace)) throw unavailable();
      return;
    }
    if (!actor.allowedNamespaces.includes(namespace) || (scope !== undefined && !actor.allowedScopes.includes(scope))) throw unavailable();
  }
  async #sameActor(actor: TrustedKnowledgeActor): Promise<void> {
    if (this.#actorDigest(actor) !== this.#actorDigest(await this.#actor())) throw unavailable();
  }

  async #sourceWork(workId: string, custody?: Map<string, string>, collection?: SourceCollection): Promise<WorkState | null> {
    const state = await this.#d.states.get(workId);
    if (!state) return null;
    if (collection) {
      const prior = collection.get(workId);
      if (prior && this.#digest(prior) !== this.#digest(state)) throw new Error('knowledge_contention');
      collection.set(workId, state); return state;
    }
    if (this.#d.inputs) return await this.#d.inputs.current(state, this.#d.signal) ? state : null;
    if (state.attempts.some(attempt => attempt.inputDependencies?.length)) return null;
    const hasProof = requiresEffectProofs(state);
    const hasCustody = retainedKnowledgeDependencies(state).length > 0;
    if (!hasProof && !hasCustody) return state;
    if (hasProof && !(await effectProofsCurrent(this.#d, state))) return null;
    if (hasCustody) {
      const checked = await this.#custody(state);
      if (checked === null) return null;
      custody?.set(workId, checked);
    }
    if ((await this.#d.states.get(workId))?.revision !== state.revision) throw new Error('knowledge_contention');
    return state;
  }

  #semantic(dependency: KnowledgeDependency, actor = true) {
    const { actorDigest, ...value } = dependency;
    return { ...value, ...(actor ? { actorDigest } : {}),
      sources: dependency.sources.map(({ workRevision: _revision, ...source }) => source)
        .sort((a, b) => a.workId.localeCompare(b.workId) || (a.type !== 'session_user_receipt' && b.type !== 'session_user_receipt' ?
          a.evidenceId.localeCompare(b.evidenceId) : JSON.stringify(a).localeCompare(JSON.stringify(b)))),
      parents: [...dependency.parents].sort((a, b) => a.id.localeCompare(b.id)) };
  }

  /** Check retained custody as a finite ledger, without recursively invoking the knowledge validator.
   * Other owners' current namespace/reviewer grants are unavailable from this port; this authenticates
   * canonical work policy and author/shared-reviewed access, not a reconstructed historical actor. */
  async #custody(initial: WorkState): Promise<string | null> {
    const works = new Map<string, WorkState | null>([[initial.id, initial]]);
    const records = new Map<string, KnowledgeRecord | null>();
    const workViews = new Map<string, unknown>();
    const edges: { workId: string; dependency: KnowledgeDependency }[] = [];
    const edgeIds = new Set<string>();
    let entries = 0, budgetExceeded = false;
    const known = new Set<string>();
    const entry = () => { if (++entries > custodyEntryLimit) { budgetExceeded = true; throw new Error('knowledge_contention'); } };
    const reference = (provider: 'work' | 'record', key: string, expectedVersion?: string): InputReference => {
      const identity = JSON.stringify([provider, key]); if (!known.has(identity)) { entry(); known.add(identity); }
      return { provider, key, ...(expectedVersion === undefined ? {} : { expectedVersion }) };
    };
    const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const workView = (state: WorkState) => ({ id: state.id, revision: state.revision, policy: state.policy, scope: state.goal.scope,
      evidence: state.evidence, dataLifecycle: state.dataLifecycle ?? null, dependencies: retainedKnowledgeDependencies(state) });
    const personalCurrent = async (state: WorkState, dependencies: KnowledgeDependency[]): Promise<boolean> => {
      if (!dependencies.length) return true;
      const service = await this.forPersonal({ tenantId: state.policy.tenantId, principalId: state.policy.principalId,
        allowedLabels: state.policy.allowedLabels, allowedDestinations: state.policy.allowedDestinations });
      for (const dependency of dependencies) {
        if (!dependency.owner || dependency.owner.agentId !== state.conversation?.session?.scope.agentId ||
          dependency.owner.principalId !== state.policy.principalId) return false;
        const read = await service.get(dependency.knowledgeId);
        if (this.#digest(this.#semantic(read.dependency, false)) !== this.#digest(this.#semantic(dependency, false))) return false;
      }
      return true;
    };
    const graph = new InputValidationGraph([{
      provider: 'work', inspect: async id => {
        const state = id === initial.id ? initial : await this.#d.states.get(id);
        if (!state || state.id !== id || state.policy.tenantId !== initial.policy.tenantId) return null;
        // This fallback has no general input reader; a nested work must not silently lose that custody.
        if (state.attempts.some(attempt => attempt.inputDependencies?.length)) return null;
        works.set(id, state); const view = workView(state); workViews.set(id, view);
        const personal = view.dependencies.filter(dependency => dependency.owner !== undefined);
        if (!(await personalCurrent(state, personal))) return null;
        // Preserve the existing custody entry policy before dispatching any referenced record reads.
        const dependencies: InputReference[] = [];
        for (const value of view.dependencies) {
          const dependency = KnowledgeDependencySchema.parse(value);
          if (dependency.tenantId !== state.policy.tenantId) return null;
          if (dependency.owner) { entry(); continue; }
          const key = `${state.id}:${this.#digest(this.#semantic(dependency))}`;
          if (edgeIds.has(key)) continue;
          entry(); edgeIds.add(key); edges.push({ workId: state.id, dependency });
          dependencies.push(reference('record', dependency.knowledgeId, String(dependency.knowledgeRevision)));
        }
        if (id !== initial.id && !(await effectProofsCurrent(this.#d, state))) return null;
        const version = this.#digest(view);
        return { version, dependencies, bytesRead: byteLength(view), current: async () => {
          const current = await this.#d.states.get(id);
          return current !== null && this.#digest(workView(current)) === version && await personalCurrent(current, personal);
        } };
      },
    }, {
      provider: 'record', inspect: async id => {
        const value = await this.#d.repository.get(initial.policy.tenantId, id); if (!value) return null;
        const record = parseKnowledge(value);
        if (record.id !== id || record.tenantId !== initial.policy.tenantId ||
          (record.expiresAt !== null && record.expiresAt <= this.#d.clock.now())) return null;
        records.set(id, record); const digest = this.#digest(record);
        const dependencies = [...record.sources.map(source => reference('work', source.workId)),
          ...record.derivedFrom.map(parent => reference('record', parent.id, String(parent.revision)))];
        return { version: String(record.revision), dependencies, bytesRead: byteLength(record), validUntil: record.expiresAt,
          current: async () => {
            const current = await this.#d.repository.get(initial.policy.tenantId, id);
            return current !== null && this.#digest(current) === digest;
          } };
      },
    }], this.#d.clock, { nodes: custodyEntryLimit, bytes: custodyByteLimit });
    const resolve = (record: KnowledgeRecord, owner: WorkState, path = new Set<string>(), budget = { remaining: custodyEntryLimit }): KnowledgeDependency => {
      if (--budget.remaining < 0 || path.has(record.id)) throw unavailable();
      path.add(record.id);
      const actor: TrustedKnowledgeActor = { tenantId: owner.policy.tenantId, principalId: owner.policy.principalId,
        allowedLabels: owner.policy.allowedLabels, allowedScopes: [owner.goal.scope], allowedNamespaces: [record.namespace], canReview: false, canPublish: false };
      if (!canReadKnowledge(record, actor, this.#d.clock.now())) throw unavailable();
      const parents = new Map<string, { id: string; revision: number }>();
      for (const ref of record.derivedFrom) {
        const parent = records.get(ref.id);
        if (!parent || parent.revision !== ref.revision || !parent.labels.every(label => record.labels.includes(label))) throw unavailable();
        const checked = resolve(parent, owner, new Set(path), budget); parents.set(ref.id, ref);
        for (const ancestor of checked.parents) parents.set(ancestor.id, ancestor);
      }
      const sources = record.sources.map(source => {
        if (source.type === 'session_user_receipt') throw unavailable();
        const state = works.get(source.workId);
        if (!state || state.policy.principalId !== source.ownerId) throw unavailable();
        const current = this.#source(state, source.evidenceId, actor, record.scope);
        if (current.source.sourceVersion !== source.sourceVersion || current.source.generation !== source.generation ||
          !current.source.labels.every(label => record.labels.includes(label))) throw unavailable();
        return current.stamp;
      });
      return { tenantId: record.tenantId, knowledgeId: record.id, knowledgeRevision: record.revision, actorDigest: this.#actorDigest(actor),
        sources, parents: [...parents.values()] };
    };
    const checked = await graph.validate([reference('work', initial.id)], { signal: this.#d.signal, accept: () => edges.every(edge => {
      const owner = works.get(edge.workId), record = records.get(edge.dependency.knowledgeId);
      return Boolean(owner && record && this.#digest(this.#semantic(resolve(record, owner), false)) === this.#digest(this.#semantic(edge.dependency, false)));
    }) });
    if (budgetExceeded || checked.reason === 'limit' || checked.reason === 'changed') throw new Error('knowledge_contention');
    if (!checked.valid) return null;
    return this.#digest({ works: [...workViews.entries()].sort(([a], [b]) => a.localeCompare(b)),
      records: [...records.entries()].sort(([a], [b]) => a.localeCompare(b)), edges });
  }

  #source(state: WorkState, evidenceId: string, actor: TrustedKnowledgeActor, scope: string): { source: EvidenceKnowledgeSource; stamp: EvidenceKnowledgeSourceStamp } {
    if (state.policy.tenantId !== actor.tenantId || state.goal.scope !== scope || !actor.allowedScopes.includes(scope)) throw unavailable();
    const allowed = accessibleEvidence(state.evidence, state.policy, scope);
    const evidence = allowed.find(e => e.id === evidenceId);
    if (!evidence) throw unavailable();
    const ancestors = new Map<string, Evidence>();
    const visiting = new Set<string>();
    const visit = (e: Evidence): void => {
      if (visiting.has(e.id)) throw unavailable();
      if (ancestors.has(e.id)) return;
      visiting.add(e.id);
      for (const id of e.derivedFrom) {
        const parent = allowed.find(p => p.id === id); if (!parent) throw unavailable(); visit(parent);
      }
      visiting.delete(e.id); ancestors.set(e.id, e);
    };
    visit(evidence);
    if ([...ancestors.values()].some(e => e.artifact && !visibleArtifact(state, e.artifact))) throw unavailable();
    const labels = unique([...ancestors.values()].flatMap(e => [...e.labels, ...(e.artifact?.labels ?? [])]));
    if (!labels.every(l => actor.allowedLabels.includes(l)) || !labels.every(l => state.policy.allowedLabels.includes(l))) throw unavailable();
    const sourceVersion = this.#digest([...ancestors.values()].sort((a, b) => a.id.localeCompare(b.id)).map(e => ({ ...e, access: e.access ?? 'available' })));
    const generation = state.dataLifecycle?.generation ?? 0;
    return { source: { workId: state.id, evidenceId, ownerId: state.policy.principalId, sourceId: evidence.sourceId, sourceVersion, generation,
      observedAt: evidence.observedAt, recordedAt: evidence.recordedAt, coverage: evidence.coverage, labels },
    stamp: { workId: state.id, evidenceId, sourceVersion, generation, workRevision: state.revision, policyDigest: this.#digest(state.policy) } };
  }

  async #validate(record: KnowledgeRecord, actor: TrustedKnowledgeActor, visiting = new Set<string>(), budget = { remaining: 256 }): Promise<{ sources: KnowledgeSourceStamp[]; parents: { id: string; revision: number }[] }> {
    if (--budget.remaining < 0 || visiting.has(record.id) || visiting.size >= 64 || !canReadKnowledge(record, actor, this.#d.clock.now())) throw unavailable();
    if (record.kind === 'personal') {
      if (!this.#d.personalOwner || !this.#d.userSources || this.#digest(record.owner) !== this.#digest(this.#d.personalOwner)) throw unavailable();
      parseKnowledge(record);
      const sources: KnowledgeSourceStamp[] = [];
      for (const source of record.sources) {
        if (source.type !== 'session_user_receipt') throw unavailable();
        sources.push(await this.#d.userSources.current(source, actor));
      }
      return { sources, parents: [] };
    }
    if (this.#d.personalOwner) throw unavailable();
    visiting.add(record.id);
    const parents: { id: string; revision: number }[] = [];
    for (const dependency of record.derivedFrom) {
      const parent = await this.#d.repository.get(actor.tenantId, dependency.id);
      if (!parent || parent.revision !== dependency.revision || !parent.labels.every(l => record.labels.includes(l))) throw unavailable();
      const validated = await this.#validate(parent, actor, new Set(visiting), budget);
      parents.push(dependency, ...validated.parents);
    }
    const sources: KnowledgeSourceStamp[] = [];
    for (const source of record.sources) {
      if (source.type === 'session_user_receipt') throw unavailable();
      if (--budget.remaining < 0) throw unavailable();
      const state = await this.#sourceWork(source.workId); if (!state || state.id !== source.workId || state.policy.principalId !== source.ownerId) throw unavailable();
      const current = this.#source(state, source.evidenceId, actor, record.scope);
      if (current.source.sourceVersion !== source.sourceVersion || current.source.generation !== source.generation ||
        !current.source.labels.every(l => record.labels.includes(l))) throw unavailable();
      sources.push(current.stamp);
    }
    return { sources, parents: [...new Map(parents.map(p => [p.id, p])).values()] };
  }

  async #materialize(id: string, actor: TrustedKnowledgeActor): Promise<KnowledgeRead> {
    const record = await this.#d.repository.get(actor.tenantId, id); if (!record) throw unavailable();
    const dependencies = await this.#validate(record, actor);
    return { card: knowledgeCard(record), dependency: { ...(record.owner ? { schemaVersion: 2, owner: structuredClone(record.owner) } : {}), tenantId: actor.tenantId, knowledgeId: record.id,
      knowledgeRevision: record.revision, actorDigest: this.#actorDigest(actor), ...dependencies } };
  }

  async #snapshot(ids: string[], actor: TrustedKnowledgeActor, namespace?: string, collection?: SourceCollection): Promise<KnowledgeSnapshot> {
    await this.#sameActor(actor);
    const records = new Map<string, KnowledgeRecord | null>();
    const pending = [...new Set(ids)];
    for (let index = 0; index < pending.length; index++) {
      if (pending.length > 256) throw new Error('knowledge_contention');
      const id = pending[index]!; const record = await this.#d.repository.get(actor.tenantId, id); records.set(id, record);
      if (record && canReadKnowledge(record, actor, this.#d.clock.now())) {
        for (const parent of record.derivedFrom) if (!pending.includes(parent.id)) pending.push(parent.id);
      }
    }
    const workIds = unique([...records.values()].filter((r): r is KnowledgeRecord => r !== null && canReadKnowledge(r, actor, this.#d.clock.now()))
      .flatMap(r => r.sources.filter(s => s.type !== 'session_user_receipt').map(s => s.workId)));
    if (workIds.length > 256) throw new Error('knowledge_contention');
    const states = new Map<string, WorkState | null>(); const custody = new Map<string, string>();
    for (const workId of workIds) states.set(workId, await this.#sourceWork(workId, custody, collection));
    const personal = new Map<string, { sources: KnowledgeSourceStamp[]; parents: { id: string; revision: number }[] } | null>();
    for (const [id, record] of records) if (record?.kind === 'personal') {
      try { personal.set(id, await this.#validate(record, actor)); }
      catch (error) { if (!(error instanceof Error) || error.message !== 'knowledge_unavailable') throw error; personal.set(id, null); }
    }
    const head = namespace === undefined ? null : await this.#d.repository.indexHead(actor.tenantId, namespace);
    await this.#sameActor(actor);
    const now = this.#d.clock.now();
    const resolve = (record: KnowledgeRecord, path = new Set<string>(), budget = { remaining: 256 }): KnowledgeDependency => {
      if (--budget.remaining < 0 || path.has(record.id) || path.size >= 64 || !canReadKnowledge(record, actor, now)) throw unavailable();
      if (record.kind === 'personal') {
        const checked = personal.get(record.id); if (!checked || !record.owner) throw unavailable();
        return { schemaVersion: 2, owner: structuredClone(record.owner), tenantId: actor.tenantId, knowledgeId: record.id,
          knowledgeRevision: record.revision, actorDigest: this.#actorDigest(actor), ...checked };
      }
      if (this.#d.personalOwner) throw unavailable();
      path.add(record.id); const parents = new Map<string, { id: string; revision: number }>();
      for (const ref of record.derivedFrom) {
        const parent = records.get(ref.id);
        if (!parent || parent.revision !== ref.revision || !parent.labels.every(l => record.labels.includes(l))) throw unavailable();
        const dependency = resolve(parent, new Set(path), budget); parents.set(ref.id, ref);
        for (const ancestor of dependency.parents) parents.set(ancestor.id, ancestor);
      }
      const sources: KnowledgeSourceStamp[] = [];
      for (const source of record.sources) {
        if (source.type === 'session_user_receipt') throw unavailable();
        if (--budget.remaining < 0) throw unavailable();
        const state = states.get(source.workId);
        if (!state || state.id !== source.workId || state.policy.principalId !== source.ownerId) throw unavailable();
        const current = this.#source(state, source.evidenceId, actor, record.scope);
        if (current.source.sourceVersion !== source.sourceVersion || current.source.generation !== source.generation ||
          !current.source.labels.every(l => record.labels.includes(l))) throw unavailable();
        sources.push(current.stamp);
      }
      return { tenantId: actor.tenantId, knowledgeId: record.id, knowledgeRevision: record.revision,
        actorDigest: this.#actorDigest(actor), sources, parents: [...parents.values()].sort((a, b) => a.id.localeCompare(b.id)) };
    };
    const reads: KnowledgeRead[] = [];
    for (const id of ids) {
      const record = records.get(id); if (!record) continue;
      try { reads.push({ card: knowledgeCard(record), dependency: resolve(record) }); }
      catch (error) { if (!(error instanceof Error) || error.message !== 'knowledge_unavailable') throw error; }
    }
    const vector = this.#digest({ actor: this.#actorDigest(actor), head,
      records: [...records.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, record]) => ({ id, record })),
      states: [...states.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, state]) => ({ id, state: state ? {
        revision: state.revision, policy: state.policy, evidence: state.evidence, dataLifecycle: state.dataLifecycle ?? null,
      } : null })),
      visible: reads.map(r => r.dependency), custody: [...custody.entries()].sort(([a], [b]) => a.localeCompare(b)),
    });
    const expiries = [...records.values()].flatMap(record => record?.expiresAt == null ? [] : [record.expiresAt]);
    return { reads, vector, head, validUntil: expiries.length ? Math.min(...expiries) : null };
  }

  /** Equal complete revision vectors bound one stable view; separate stores are not an atomic snapshot. */
  async #stable(ids: string[], actor: TrustedKnowledgeActor, namespace?: string, collection?: SourceCollection,
    initial?: KnowledgeSnapshot): Promise<KnowledgeSnapshot> {
    let previous = initial ?? await this.#snapshot(ids, actor, namespace, collection);
    let stableFences = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await this.#snapshot(ids, actor, namespace, collection);
      stableFences = previous.vector === current.vector ? stableFences + 1 : 0;
      if (stableFences === 2) return current;
      previous = current;
    }
    throw new Error('knowledge_contention');
  }

  async #read(id: string, actor: TrustedKnowledgeActor): Promise<KnowledgeRead> {
    const initial = await this.#snapshot([id], actor);
    if (!initial.reads.length) throw unavailable();
    const stable = await this.#stable([id], actor, undefined, undefined, initial);
    const read = stable.reads[0]; if (!read) throw unavailable(); return read;
  }

  async get(id: string): Promise<KnowledgeRead> {
    if (typeof id !== 'string' || !id.length || id.length > 160) throw unavailable();
    return this.#read(id, await this.#actor());
  }

  /** Consumers must revalidate this internal stamp before adopting copied content after another await. */
  async validateDependencies(dependencies: KnowledgeDependency[]): Promise<boolean> {
    try {
      let parsed = KnowledgeDependencySchema.array().max(50).parse(dependencies);
      if (!this.#d.personalOwner && parsed.some(value => value.owner)) {
        if (!(await (await this.forPersonal()).validateDependencies(parsed.filter(value => value.owner)))) return false;
        parsed = parsed.filter(value => !value.owner);
      }
      const actor = await this.#actor();
      for (const dependency of parsed) {
        if (dependency.tenantId !== actor.tenantId || dependency.actorDigest !== this.#actorDigest(actor) ||
          this.#digest(dependency.owner ?? null) !== this.#digest(this.#d.personalOwner ?? null)) return false;
      }
      const stable = await this.#stable(unique(parsed.map(d => d.knowledgeId)), actor);
      return parsed.every(dependency => {
        const current = stable.reads.find(r => r.dependency.knowledgeId === dependency.knowledgeId);
        return current !== undefined && this.#digest(this.#semantic(current.dependency)) === this.#digest(this.#semantic(dependency));
      });
    } catch { return false; }
  }

  /** Inspect record/source authenticity without recursively validating the source works' inputs.
   * Only a closure validator may consume this result; cards and source bodies are not returned. */
  async inspectDependencies(dependencies: KnowledgeDependency[]): Promise<SourceInputInspection> {
    const parsed = KnowledgeDependencySchema.array().max(50).parse(dependencies), actor = await this.#actor();
    if (!this.#d.personalOwner && parsed.some(value => value.owner)) {
      const inspected = [await (await this.forPersonal()).inspectDependencies(parsed.filter(value => value.owner))];
      if (parsed.some(value => !value.owner)) inspected.push(await this.inspectDependencies(parsed.filter(value => !value.owner)));
        const expiries = inspected.flatMap(value => value.validUntil == null ? [] : [value.validUntil]);
      return { version: this.#digest(inspected.map(value => value.version)), sourceWorkIds: unique(inspected.flatMap(value => value.sourceWorkIds)),
        knowledgeDependencies: inspected.flatMap(value => value.knowledgeDependencies), bytesRead: inspected.reduce((sum, value) => sum + value.bytesRead, 0),
        validUntil: expiries.length ? Math.min(...expiries) : null,
        current: async () => { for (const value of inspected) if (!(await value.current())) return false; return true; } };
    }
    if (parsed.some(value => this.#digest(value.owner ?? null) !== this.#digest(this.#d.personalOwner ?? null))) throw unavailable();
    if (parsed.some(value => value.tenantId !== actor.tenantId || value.actorDigest !== this.#actorDigest(actor))) throw unavailable();
    const ids = unique(parsed.map(value => value.knowledgeId)), collection: SourceCollection = new Map();
    const matches = (snapshot: KnowledgeSnapshot) => parsed.every(expected => {
      const current = snapshot.reads.find(value => value.dependency.knowledgeId === expected.knowledgeId);
      return current && this.#digest(this.#semantic(current.dependency)) === this.#digest(this.#semantic(expected));
    });
    const snapshot = await this.#stable(ids, actor, undefined, collection); if (!matches(snapshot)) throw unavailable();
    return { version: this.#digest(parsed.map(value => this.#semantic(value))), sourceWorkIds: [...collection.keys()].sort(),
      knowledgeDependencies: [], bytesRead: new TextEncoder().encode(JSON.stringify(snapshot)).byteLength, validUntil: snapshot.validUntil,
      current: async () => {
        try {
          const freshCollection: SourceCollection = new Map(), fresh = await this.#stable(ids, actor, undefined, freshCollection);
          return matches(fresh) === true && fresh.vector === snapshot.vector && this.#digest([...freshCollection.keys()].sort()) === this.#digest([...collection.keys()].sort());
        } catch { return false; }
      } };
  }

  async #commit(record: KnowledgeRecord, expectedRevision: number, commandId: string, commandDigest: string): Promise<void> {
    const result = await this.#d.repository.commit({ next: parseKnowledge(record), expectedRevision, commandId, commandDigest });
    if (result.kind === 'conflict') throw new Error('knowledge_revision_conflict');
    if (result.kind === 'idempotency_conflict') throw new Error('knowledge_command_conflict');
  }
  async #matchingReceipt(actor: TrustedKnowledgeActor, id: string, commandId: string, digest: string) {
    const receipt = await this.#d.repository.receipt(actor.tenantId, id, commandId);
    if (!receipt) return null;
    if (receipt.digest !== digest) throw new Error('knowledge_command_conflict');
    return receipt;
  }
  async #duplicate(actor: TrustedKnowledgeActor, id: string, commandId: string, digest: string): Promise<boolean> {
    return (await this.#matchingReceipt(actor, id, commandId, digest)) !== null;
  }
  #personalRecord(value: KnowledgeRecord | null, actor: TrustedKnowledgeActor, owner: PersonalMemoryOwner, id: string): KnowledgeRecord {
    if (!value) throw unavailable();
    const record = parseKnowledge(value);
    if (record.id !== id || record.tenantId !== actor.tenantId || record.authorId !== actor.principalId || record.kind !== 'personal' ||
      record.namespace !== 'personal' || record.scope !== 'personal' || this.#digest(record.owner) !== this.#digest(owner)) throw unavailable();
    return record;
  }
  #personalReceiptRevision(revision: number, expectedRevision: number, currentRevision: number): number {
    if (!Number.isSafeInteger(revision) || revision !== expectedRevision + 1 || revision > currentRevision) throw unavailable();
    return revision;
  }

  async create(input: CreateKnowledgeInput): Promise<KnowledgeRead> {
    if (this.#d.personalOwner) throw unavailable();
    const args = CreateKnowledgeSchema.parse(input); const actor = await this.#actor();
    this.#allowedPlace(actor, args.namespace, args.scope);
    if (!args.labels.every(l => actor.allowedLabels.includes(l)) || (args.expiresAt !== null && args.expiresAt <= this.#d.clock.now())) throw unavailable();
    const digest = this.#digest({ action: 'create', principalId: actor.principalId, args });
    if (await this.#duplicate(actor, args.id, args.commandId, digest)) return this.#read(args.id, actor);
    const sources: KnowledgeSource[] = []; const derivedFrom: { id: string; revision: number }[] = []; const inheritedLabels: string[] = [];
    for (const ref of args.sources) {
      const state = await this.#sourceWork(ref.workId);
      if (!state || state.policy.principalId !== actor.principalId) throw unavailable();
      sources.push(this.#source(state, ref.evidenceId, actor, args.scope).source);
    }
    for (const id of unique(args.derivedFrom)) {
      if (id === args.id) throw new Error('knowledge_cycle');
      const parent = await this.#d.repository.get(actor.tenantId, id); if (!parent || parent.scope !== args.scope || parent.kind === 'personal') throw unavailable();
      await this.#validate(parent, actor);
      sources.push(...parent.sources); inheritedLabels.push(...parent.labels); derivedFrom.push({ id, revision: parent.revision });
    }
    const uniqueSources = [...new Map(sources.map(s => [knowledgeSourceKey(s), s])).values()];
    const now = this.#d.clock.now();
    const record: KnowledgeRecord = { id: args.id, tenantId: actor.tenantId, namespace: args.namespace, scope: args.scope, authorId: actor.principalId,
      kind: args.kind, title: args.title, body: args.body, labels: unique([...args.labels, ...inheritedLabels, ...uniqueSources.flatMap(s => s.labels)]),
      revision: 1, contentRevision: 1, status: 'active', visibility: 'private', reviewState: 'private', review: null,
      sources: uniqueSources, derivedFrom, createdAt: now, updatedAt: now, expiresAt: args.expiresAt };
    await this.#validate(record, actor); await this.#sameActor(actor);
    await this.#commit(record, 0, args.commandId, digest);
    return this.#read(record.id, actor);
  }

  async #change(input: KnowledgeMutationInput | KnowledgeReviewInput | ReviseKnowledgeInput, action: 'submit' | 'promote' | 'retract' | 'delete' | 'revise'): Promise<{ id: string; revision: number }> {
    if (this.#d.personalOwner) throw unavailable();
    const args = action === 'promote' ? KnowledgeReviewSchema.parse(input) : action === 'revise' ? ReviseKnowledgeSchema.parse(input) : KnowledgeMutationSchema.parse(input);
    const actor = await this.#actor(); const record = await this.#d.repository.get(actor.tenantId, args.id); if (!record) throw unavailable();
    this.#allowedPlace(actor, record.namespace, record.scope);
    if (!record.labels.every(l => actor.allowedLabels.includes(l))) throw unavailable();
    const review = action === 'promote';
    if (review ? (!actor.canReview || !actor.canPublish || actor.principalId === record.authorId) : actor.principalId !== record.authorId) throw unavailable();
    const digest = this.#digest({ action, principalId: actor.principalId, args });
    if (await this.#duplicate(actor, args.id, args.commandId, digest)) { await this.#sameActor(actor); return { id: record.id, revision: record.revision }; }
    if (record.revision !== args.expectedRevision) throw new Error('knowledge_revision_conflict');
    if (record.status !== 'active' && !(action === 'delete' && record.status === 'retracted')) throw unavailable();
    if (action !== 'delete' && action !== 'retract') await this.#validate(record, actor);
    if (action === 'submit' && (!actor.canPublish || record.visibility !== 'private' || record.reviewState !== 'private')) throw unavailable();
    if (review && (record.reviewState !== 'submitted' || !('expectedContentRevision' in args) || args.expectedContentRevision !== record.contentRevision)) throw new Error('knowledge_review_revision_conflict');
    const now = this.#d.clock.now(); const next = { ...record, revision: record.revision + 1, updatedAt: now };
    if (action === 'submit') next.reviewState = 'submitted';
    if (review) { next.visibility = 'shared'; next.reviewState = 'reviewed'; next.review = { reviewerId: actor.principalId, contentRevision: record.contentRevision, at: now, reason: args.reason }; }
    if (action === 'retract') next.status = 'retracted';
    if (action === 'delete') { next.status = 'deleted'; next.body = ''; next.title = '[deleted]'; }
    if (action === 'revise' && 'title' in args && typeof args.title === 'string' && 'body' in args && typeof args.body === 'string') {
      next.title = args.title; next.body = args.body; next.contentRevision++; next.visibility = 'private'; next.reviewState = 'private'; next.review = null;
    }
    await this.#sameActor(actor); await this.#commit(next, record.revision, args.commandId, digest);
    await this.#sameActor(actor); return { id: next.id, revision: next.revision };
  }
  submitForReview(input: KnowledgeMutationInput) { return this.#change(input, 'submit'); }
  reviewAndPromote(input: KnowledgeReviewInput) { return this.#change(input, 'promote'); }
  retract(input: KnowledgeMutationInput) { return this.#change(input, 'retract'); }
  delete(input: KnowledgeMutationInput) { return this.#change(input, 'delete'); }
  revise(input: ReviseKnowledgeInput) { return this.#change(input, 'revise'); }

  async remember(input: RememberPersonalInput): Promise<KnowledgeRead> {
    const args = RememberPersonalSchema.parse(input), actor = await this.#actor(), owner = this.#d.personalOwner;
    if (!owner || !this.#d.userSources) throw unavailable();
    this.#allowedPlace(actor, 'personal', 'personal');
    const digest = this.#digest({ action: 'remember', owner, tenantId: actor.tenantId, args });
    if (await this.#duplicate(actor, args.id, args.commandId, digest)) return this.#read(args.id, actor);
    if (args.expiresAt !== null && args.expiresAt <= this.#d.clock.now()) throw unavailable();
    const source = await this.#d.userSources.capture(actor, args.source), now = this.#d.clock.now();
    const record: KnowledgeRecord = { schemaVersion: 2, owner: structuredClone(owner), id: args.id, tenantId: actor.tenantId,
      namespace: 'personal', scope: 'personal', authorId: actor.principalId, kind: 'personal', title: args.title, body: source.quote,
      labels: [...source.labels], revision: 1, contentRevision: 1, status: 'active', visibility: 'private', reviewState: 'private', review: null,
      sources: [source], derivedFrom: [], createdAt: now, updatedAt: now, expiresAt: args.expiresAt };
    await this.#validate(record, actor); await this.#sameActor(actor);
    await this.#commit(record, 0, args.commandId, digest);
    return this.#read(record.id, actor);
  }

  async revisePersonal(input: RevisePersonalInput): Promise<{ id: string; revision: number }> {
    const args = RevisePersonalSchema.parse(input), actor = await this.#actor(), owner = this.#d.personalOwner;
    if (!owner || !this.#d.userSources) throw unavailable();
    this.#allowedPlace(actor, 'personal', 'personal');
    const record = this.#personalRecord(await this.#d.repository.get(actor.tenantId, args.id), actor, owner, args.id);
    const digest = this.#digest({ action: 'revise_personal', owner, tenantId: actor.tenantId, args });
    const receipt = await this.#matchingReceipt(actor, args.id, args.commandId, digest);
    if (receipt) {
      const current = receipt.revision > record.revision ? this.#personalRecord(await this.#d.repository.get(actor.tenantId, args.id), actor, owner, args.id) : record;
      const revision = this.#personalReceiptRevision(receipt.revision, args.expectedRevision, current.revision);
      await this.#sameActor(actor); return { id: record.id, revision };
    }
    if (record.revision !== args.expectedRevision) throw new Error('knowledge_revision_conflict');
    if (record.status !== 'active') throw unavailable();
    const source = await this.#d.userSources.capture(actor, args.source);
    const next: KnowledgeRecord = { ...record, title: args.title, body: source.quote, sources: [source], labels: [...source.labels],
      revision: record.revision + 1, contentRevision: record.contentRevision + 1, updatedAt: this.#d.clock.now() };
    await this.#validate(next, actor); await this.#sameActor(actor);
    await this.#commit(next, record.revision, args.commandId, digest);
    await this.#sameActor(actor); return { id: next.id, revision: next.revision };
  }

  /** Original command result only; it does not capture another input or validate/read source bodies. */
  async revisePersonalStatus(input: RevisePersonalInput): Promise<PersonalRevisionStatus | null> {
    const args = RevisePersonalSchema.parse(input), actor = await this.#actor(), owner = this.#d.personalOwner;
    if (!owner || !this.#d.userSources) throw unavailable();
    this.#allowedPlace(actor, 'personal', 'personal');
    const digest = this.#digest({ action: 'revise_personal', owner, tenantId: actor.tenantId, args });
    const receipt = await this.#matchingReceipt(actor, args.id, args.commandId, digest);
    if (!receipt) { await this.#sameActor(actor); return null; }
    // The receipt is immutable. Observe the current record after it, so a later revision is not
    // mistaken for the original result and a removed source does not prevent acknowledgement.
    const record = this.#personalRecord(await this.#d.repository.get(actor.tenantId, args.id), actor, owner, args.id);
    const revision = this.#personalReceiptRevision(receipt.revision, args.expectedRevision, record.revision);
    const visible = record.labels.every(label => actor.allowedLabels.includes(label));
    await this.#sameActor(actor);
    return { id: args.id, revision, currentRevision: visible ? record.revision : null, currentStatus: visible ? record.status : null };
  }

  async forgetPersonal(input: KnowledgeMutationInput): Promise<{ id: string; revision: number }> {
    const args = KnowledgeMutationSchema.parse(input), actor = await this.#actor(), owner = this.#d.personalOwner;
    if (!owner) throw unavailable();
    this.#allowedPlace(actor, 'personal', 'personal');
    const record = await this.#d.repository.get(actor.tenantId, args.id);
    if (!record || record.kind !== 'personal' || this.#digest(record.owner) !== this.#digest(owner)) throw unavailable();
    const digest = this.#digest({ action: 'forget_personal', owner, tenantId: actor.tenantId, args });
    if (await this.#duplicate(actor, args.id, args.commandId, digest)) { await this.#sameActor(actor); return { id: record.id, revision: record.revision }; }
    if (record.revision !== args.expectedRevision) throw new Error('knowledge_revision_conflict');
    if (record.status !== 'active' && record.status !== 'retracted') throw unavailable();
    // Forgetting does not depend on still being able to read the old source or its removed labels.
    const next: KnowledgeRecord = { ...record, status: 'deleted', title: '[deleted]', body: '', revision: record.revision + 1,
      updatedAt: this.#d.clock.now(), sources: record.sources.map(source => source.type === 'session_user_receipt' ? { ...source, quote: '' } : source) };
    await this.#sameActor(actor); await this.#commit(next, record.revision, args.commandId, digest);
    await this.#sameActor(actor); return { id: next.id, revision: next.revision };
  }

  async search(input: KnowledgeQueryInput): Promise<KnowledgeSearch> {
    const query = KnowledgeQuerySchema.parse(input); query.text = query.text.normalize('NFC').toLocaleLowerCase('en-US');
    if (this.#d.personalOwner) {
      if (query.kinds.some(kind => kind !== 'personal')) throw unavailable();
      query.kinds = ['personal'];
    }
    const actor = await this.#actor(); this.#allowedPlace(actor, query.namespace, query.scope);
    const head = await this.#d.repository.indexHead(actor.tenantId, query.namespace);
    const key = this.#digest({ query, actor: this.#actorDigest(actor), head }); const cached = this.#cache.has(key);
    let candidates = this.#cache.get(key);
    if (!candidates) {
      try { candidates = await this.#d.repository.candidates(actor, query, 200); }
      catch {
        await this.#d.repository.markIndexError(actor.tenantId, query.namespace, 'index_read_failed');
        await this.#sameActor(actor);
        return { cards: [], dependencies: [], index: { ...head, error: 'index_read_failed', status: 'error', complete: false, cached: false } };
      }
      if (this.#cache.size >= 64) this.#cache.delete(this.#cache.keys().next().value!);
      this.#cache.set(key, candidates);
    }
    const reads: KnowledgeRead[] = [];
    let scanned = 0;
    for (const id of candidates.ids) {
      scanned++;
      try {
        const read = await this.#materialize(id, actor);
        const card = read.card;
        if (card.namespace !== query.namespace || card.scope !== query.scope ||
          (query.kinds.length && !query.kinds.includes(card.kind)) ||
          !`${card.title}\n${card.body}`.normalize('NFC').toLocaleLowerCase('en-US').includes(query.text) ||
          (query.observedFrom !== null && card.observedThrough < query.observedFrom) ||
          (query.observedThrough !== null && card.observedFrom > query.observedThrough)) continue;
        reads.push(read); if (reads.length > query.limit) break;
      } catch (error) { if (!(error instanceof Error) || error.message !== 'knowledge_unavailable') throw error; }
    }
    const scanExhausted = scanned === candidates.ids.length && !candidates.truncated;
    const stable = await this.#stable(reads.map(r => r.card.id), actor, query.namespace);
    const lastHead = stable.head!;
    const final = stable.reads.filter(({ card }) => card.namespace === query.namespace && card.scope === query.scope &&
      (!query.kinds.length || query.kinds.includes(card.kind)) &&
      `${card.title}\n${card.body}`.normalize('NFC').toLocaleLowerCase('en-US').includes(query.text) &&
      (query.observedFrom === null || card.observedThrough >= query.observedFrom) &&
      (query.observedThrough === null || card.observedFrom <= query.observedThrough));
    const changed = this.#digest(head) !== this.#digest(lastHead);
    return { cards: final.slice(0, query.limit).map(r => r.card), dependencies: final.slice(0, query.limit).map(r => r.dependency),
      index: { ...lastHead, status: lastHead.error ? 'error' : lastHead.cursor < lastHead.revision ? 'lagging' : 'ready',
        complete: !lastHead.error && lastHead.cursor === lastHead.revision && !changed && scanExhausted && final.length <= query.limit, cached } };
  }

  async rebuildIndex(namespace: string) {
    const actor = await this.#actor(); this.#allowedPlace(actor, namespace);
    const head = await this.#d.repository.rebuildIndex(actor.tenantId, namespace); await this.#sameActor(actor); this.#cache.clear(); return head;
  }
  syncIndex(namespace: string) { return this.rebuildIndex(namespace); }
}
