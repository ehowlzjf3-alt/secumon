import type { InputDependency } from '../domain/inputs.js';
import type { KnowledgeDependency, TrustedKnowledgeActor } from '../domain/knowledge.js';
import type { WorkState } from '../domain/model.js';
import { visibleArtifact } from '../domain/data-lifecycle.js';
import { disclosureLabels } from '../domain/disclosure.js';
import { InputDependencySchema } from './contracts.js';
import { parseKnowledgeActor } from './knowledge-contracts.js';
import type { InputAuthority } from './knowledge-ports.js';
import { retainedKnowledgeDependencies } from './knowledge-validity.js';
import { retainedInputDependencies, uniqueInputDependencies } from './input-validity.js';
import { InputValidationGraph, type InputNode, type InputReference, type InputValidationLimits } from './input-validation.js';
import { effectProofsCurrent } from './effect-proofs.js';
import { asJson } from './plan-validator.js';
import type { RuntimeServices, WorkInputValidator } from './services.js';
import type { SourceInputInspection } from './source-input-inspection.js';
import type { WorkInputSource } from './work-input-source.js';

export interface WorkInputReader {
  provider: string;
  inspect(dependency: InputDependency, work: WorkState, actor: TrustedKnowledgeActor, signal: AbortSignal): Promise<SourceInputInspection>;
}
type Dependencies = {
  sourceId?: string;
  services: Pick<RuntimeServices, 'state' | 'clock' | 'digester' | 'effects' | 'readCoverage'>;
  authority: InputAuthority;
  readers: WorkInputReader[];
  memory?: ((dependencies: KnowledgeDependency[], actor: TrustedKnowledgeActor, signal: AbortSignal, work?: WorkState) => Promise<SourceInputInspection>) | undefined;
  limits?: Partial<InputValidationLimits> | undefined;
};
const names = (values: string[]) => [...new Set(values)].sort();
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** One finite closure for work, memory, collection proofs and retained observations. */
export class WorkInputGraph implements WorkInputValidator {
  readonly #readers: Map<string, WorkInputReader['inspect']>;
  readonly source: WorkInputSource;
  constructor(readonly dependencies: Dependencies) {
    this.#readers = new Map();
    for (const reader of dependencies.readers) {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(reader.provider) || this.#readers.has(reader.provider) || typeof reader.inspect !== 'function')
        throw new Error('input_reader_invalid');
      this.#readers.set(reader.provider, reader.inspect.bind(reader));
    }
    this.source = Object.freeze({
      id: dependencies.sourceId ?? 'local',
      identity: Object.freeze({}),
      state: Object.freeze({ get: dependencies.services.state.get.bind(dependencies.services.state) }),
      authority: Object.freeze({ resolve: dependencies.authority.resolve.bind(dependencies.authority) }),
      inspectInput: async (dependency: InputDependency, work: WorkState, actor: TrustedKnowledgeActor, signal: AbortSignal) => {
        const inspect = this.#readers.get(dependency.provider);
        if (!inspect) throw new Error('input_reader_unavailable');
        return inspect(dependency, work, actor, signal);
      },
      inspectMemory: async (dependencies_: KnowledgeDependency[], actor: TrustedKnowledgeActor, signal: AbortSignal, work: WorkState) => {
        if (!dependencies.memory) throw new Error('input_memory_unavailable');
        return dependencies.memory(dependencies_, actor, signal, work);
      },
      effectsCurrent: (state: WorkState) => effectProofsCurrent(dependencies.services, state),
      inspectCoverage: (state: WorkState) => {
        if (!dependencies.services.readCoverage?.inspect) throw new Error('input_coverage_unavailable');
        return dependencies.services.readCoverage.inspect(state);
      },
    });
  }
  current(state: WorkState, signal?: AbortSignal) { return this.validate([], state, signal); }
  async validate(input: InputDependency[], initial: WorkState, signal?: AbortSignal): Promise<boolean> {
    const { services } = this.dependencies;
    const digest = (value: unknown) => services.digester.digest(asJson(value));
    const initialDigest = digest(initial);
    const works = new Map<string, { state: WorkState; actor: TrustedKnowledgeActor; source: WorkInputSource }>();
    const sources = new Map<string, WorkInputSource>();
    const bindings = new Map<string, { id: string; source: WorkInputSource }>();
    const memory = new Map<string, { workId: string; dependencies: KnowledgeDependency[] }>();
    const receipts = new Map<string, { workId: string; dependency: InputDependency }>();
    const reference = (provider: string, key: string): InputReference => ({ provider, key });
    const workRef = (id: string, source: WorkInputSource = this.source) => {
      const existing = sources.get(source.id);
      if (!source.id || (existing && (existing.identity ?? existing) !== (source.identity ?? source))) throw new Error('input_source_conflict');
      sources.set(source.id, source);
      const key = digest({ source: source.id, workId: id });
      bindings.set(key, { id, source });
      return reference('work', key);
    };
    const scopeActor = async (state: WorkState, source: WorkInputSource): Promise<TrustedKnowledgeActor> => {
      const raw = await source.authority.resolve({ tenantId: state.policy.tenantId, principalId: state.policy.principalId });
      if (!raw) throw new Error('input_authority_unavailable');
      const trusted = parseKnowledgeActor(raw);
      if (trusted.tenantId !== state.policy.tenantId || trusted.principalId !== state.policy.principalId || !trusted.allowedScopes.includes(state.goal.scope))
        throw new Error('input_authority_unavailable');
      return { ...trusted, allowedLabels: names(trusted.allowedLabels.filter(label => state.policy.allowedLabels.includes(label))),
        allowedNamespaces: names(trusted.allowedNamespaces), allowedScopes: [state.goal.scope] };
    };
    const memoryRefs = (workId: string, dependencies: KnowledgeDependency[]): InputReference[] => {
      const refs: InputReference[] = [];
      for (let offset = 0; offset < dependencies.length; offset += 50) {
        const batch = dependencies.slice(offset, offset + 50), key = digest({ workId, batch });
        memory.set(key, { workId, dependencies: batch }); refs.push(reference('memory', key));
      }
      return refs;
    };
    const inputRefs = (workId: string, dependencies: InputDependency[]): InputReference[] => dependencies.map(value => {
      const dependency = InputDependencySchema.parse(value), key = digest({ workId, dependency });
      if (dependency.workId !== works.get(workId)?.state.id) throw new Error('input_owner_mismatch');
      receipts.set(key, { workId, dependency }); return reference('receipt', key);
    });
    const node = (inspection: SourceInputInspection, owner: string): InputNode => ({ version: inspection.version,
      dependencies: [...inspection.sourceWorkIds.map(id => workRef(id, works.get(owner)!.source)),
        ...(inspection.sourceWorks ?? []).map(value => workRef(value.workId, value.source)),
        ...memoryRefs(owner, inspection.knowledgeDependencies)],
      bytesRead: inspection.bytesRead, validUntil: inspection.validUntil, current: () => inspection.current() });
    try {
      if (input.length > 50) return false;
      const additional = uniqueInputDependencies(input.map(value => InputDependencySchema.parse(value)));
      const graph = new InputValidationGraph([{
        provider: 'work', inspect: async key => {
          const binding = bindings.get(key); if (!binding) return null;
          const { id, source } = binding;
          const canonical = await source.state.get(id);
          if (!canonical || canonical.policy.tenantId !== initial.policy.tenantId) return null;
          const state = structuredClone(canonical);
          const isRoot = source === this.source && id === initial.id;
          if (isRoot) {
            // A view may narrow labels, but cannot alter canonical state or widen policy.
            if (digest({ ...initial, policy: canonical.policy }) !== digest(canonical) ||
              digest({ ...initial.policy, allowedLabels: canonical.policy.allowedLabels, allowedTools: canonical.policy.allowedTools,
                allowedDestinations: canonical.policy.allowedDestinations, allowWrites: canonical.policy.allowWrites }) !== digest(canonical.policy) ||
              !initial.policy.allowedLabels.every(label => canonical.policy.allowedLabels.includes(label)) ||
              !initial.policy.allowedTools.every(tool => canonical.policy.allowedTools.includes(tool)) ||
              !initial.policy.allowedDestinations.every(destination => canonical.policy.allowedDestinations.includes(destination)) ||
              initial.policy.allowWrites && !canonical.policy.allowWrites) return null;
            state.policy = structuredClone(initial.policy);
          }
          const actor = await scopeActor(state, source), authorityDigest = digest(actor), version = digest(canonical);
          if (!disclosureLabels(state).every(label => actor.allowedLabels.includes(label))) return null;
          if (!(await source.effectsCurrent(state))) return null;
          works.set(key, { state, actor, source });
          const dependencies = [...memoryRefs(key, retainedKnowledgeDependencies(state)),
            ...inputRefs(key, uniqueInputDependencies([...retainedInputDependencies(state), ...(isRoot ? additional : [])]))];
          if (state.goal.criteria.some(criterion => criterion.requireCollection !== undefined)) dependencies.push(reference('coverage', key));
          return { version, dependencies, bytesRead: size(canonical), current: async () => {
            const latest = await source.state.get(id);
            return latest !== null && digest(latest) === version && digest(await scopeActor(state, source)) === authorityDigest &&
              await source.effectsCurrent(state);
          } };
        },
      }, {
        provider: 'memory', inspect: async (key, innerSignal) => {
          const batch = memory.get(key), owner = batch && works.get(batch.workId);
          if (!batch || !owner) return null;
          return node(await owner.source.inspectMemory(batch.dependencies, owner.actor, innerSignal, owner.state), batch.workId);
        },
      }, {
        provider: 'receipt', inspect: async (key, innerSignal) => {
          const entry = receipts.get(key), owner = entry && works.get(entry.workId);
          if (!entry || !owner || !visibleArtifact(owner.state, entry.dependency.artifact)) return null;
          return node(await owner.source.inspectInput(entry.dependency, owner.state, owner.actor, innerSignal), entry.workId);
        },
      }, {
        provider: 'coverage', inspect: async id => {
          const owner = works.get(id); if (!owner) return null;
          return node(await owner.source.inspectCoverage(owner.state), id);
        },
      }], services.clock, this.dependencies.limits);
      return (await graph.validate([workRef(initial.id)], { signal, accept: () => digest(initial) === initialDigest })).valid;
    } catch { return false; }
  }
}
