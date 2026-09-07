import type { ArtifactRef, Evidence, Policy } from '../domain/model.js';
import { artifactBlocked, dataGeneration } from '../domain/data-lifecycle.js';
import { evidenceView } from '../domain/evidence-access.js';
import { allowsDisclosure, disclosureJson, disclosureLabels, releasedBytes, type DisclosurePayload, type DisclosureRecord, type DisclosureRule, type DisclosureSurface } from '../domain/disclosure.js';
import type { RuntimeServices } from './services.js';
import type { WorkActor } from './work-resources.js';
import { authorizedWork } from './work-resources.js';
import { DisclosurePayloadSchema, DisclosureRequestSchema, DisclosureRuleSchema } from './disclosure-contracts.js';
import { parseContract } from './contracts.js';
import { frozen } from './resource-contracts.js';
import { transact } from './work-transactions.js';
import { knowledgeInputsCurrent } from './knowledge-validity.js';
import { effectProofsCurrent } from './effect-proofs.js';

export interface DisclosureView { id: string; destination: string; surface: DisclosureSurface; labels: string[]; payload: DisclosurePayload }
export interface DisclosureReceiver<T> { destination: string; surface: DisclosureSurface; receive(payload: DisclosurePayload): Promise<T> }
type Services = Pick<RuntimeServices, 'state' | 'artifacts' | 'clock' | 'digester' | 'knowledge' | 'effects'>;

/** Rules are trusted deployment configuration, never text supplied by a model, tool, or retrieved document. */
export class DisclosureService {
  readonly #rules: ReadonlyMap<string, DisclosureRule>;
  constructor(readonly services: Services, rules: DisclosureRule[]) {
    const parsed = rules.map(rule => frozen(parseContract(DisclosureRuleSchema, rule)));
    if (parsed.length > 1000 || new Set(parsed.map(rule => rule.id)).size !== parsed.length) throw new Error('disclosure_rules_invalid');
    this.#rules = new Map(parsed.map(rule => [rule.id, rule]));
  }
  private digest(value: unknown) { return this.services.digester.digest(disclosureJson(value)); }
  private rule(id: string) {
    const rule = this.#rules.get(id); if (!rule) throw new Error('disclosure_rule_unavailable'); return rule;
  }
  private async snapshot(workId: string, actor: WorkActor) {
    const raw = await this.services.state.get(workId);
    const authorized = await authorizedWork(this.services.state, workId, actor);
    if (!raw || raw.revision !== authorized.revision) throw new Error('disclosure_state_changed');
    if (!(await knowledgeInputsCurrent(this.services, authorized))) throw new Error('disclosure_knowledge_changed');
    if (!(await effectProofsCurrent(this.services, raw))) throw new Error('disclosure_effect_proof_changed');
    if ((await this.services.state.get(workId))?.revision !== raw.revision) throw new Error('disclosure_state_changed');
    return { raw, authorized };
  }
  private binding(state: Awaited<ReturnType<DisclosureService['snapshot']>>, rule: DisclosureRule) {
    const { raw, authorized } = state; const policy = authorized.policy;
    if (!raw.policy.disclosure || !raw.disclosureLabels) throw new Error('disclosure_policy_required');
    // A delegated worker cannot create a fresh disclosure budget. The owning work must mediate its release.
    if (raw.budgetParent) throw new Error('disclosure_parent_scope_required');
    if (['cancelled', 'paused', 'failed'].includes(raw.status)) throw new Error('disclosure_work_stopped');
    if (policy.tenantId !== rule.tenantId || policy.principalId !== rule.principalId || raw.goal.scope !== rule.scope ||
        !allowsDisclosure(policy, rule.destination, rule.surface, rule.releasedLabels)) throw new Error('disclosure_rule_denied');
  }
  private async originals(state: Awaited<ReturnType<DisclosureService['snapshot']>>, selectedIds: string[], rule: DisclosureRule) {
    if (selectedIds.length > rule.maxSources) throw new Error('disclosure_source_limit');
    const { authorized } = state;
    const current = new Map(evidenceView(authorized.evidence, authorized.policy, authorized.goal.scope, 'current').map(e => [e.id, e]));
    const selected: Evidence[] = []; const sources = new Map<string, Evidence>();
    const visit = (id: string) => {
      if (sources.has(id)) return;
      const evidence = current.get(id);
      if (!evidence || !evidence.labels.length || !evidence.labels.every(label => rule.sourceLabels.includes(label)) ||
          (evidence.artifact && !evidence.artifact.labels.every(label => rule.sourceLabels.includes(label)))) throw new Error('disclosure_source_unavailable');
      sources.set(id, evidence);
      if (sources.size > 100) throw new Error('disclosure_source_limit');
      evidence.derivedFrom.forEach(visit);
    };
    for (const id of selectedIds) { visit(id); selected.push(current.get(id)!); }
    for (const evidence of sources.values()) if (evidence.artifact) {
      if (artifactBlocked(authorized, evidence.artifact)) throw new Error('disclosure_source_unavailable');
      try { await this.services.artifacts.get(evidence.artifact, authorized.policy); }
      catch { throw new Error('disclosure_source_unavailable'); }
    }
    return { selected, originals: [...sources.values()], sources: [...sources.values()].map(e => ({ evidenceId: e.id, digest: this.digest(e) })) };
  }
  private project(selected: Evidence[], rule: DisclosureRule, originals: Evidence[]): DisclosurePayload {
    const lineages = new Map<string, number>();
    const records = new Map(originals.map(e => [e.id, e]));
    const alias = (evidence: Evidence) => {
      const key = JSON.stringify([evidence.tenantId, evidence.scope, evidence.lineageId]);
      if (!lineages.has(key)) lineages.set(key, lineages.size + 1);
      return lineages.get(key)!;
    };
    const rootCache = new Map<string, number[]>();
    const roots = (evidence: Evidence): number[] => {
      const cached = rootCache.get(evidence.id); if (cached) return cached;
      const result = evidence.derivedFrom.length ? [...new Set(evidence.derivedFrom.flatMap(id => roots(records.get(id)!)))].sort((a, b) => a - b) : [alias(evidence)];
      rootCache.set(evidence.id, result); return result;
    };
    const observations = selected.map(evidence => {
      const basis = roots(evidence);
      const facts: Record<string, string | number | boolean | null> = Object.create(null) as Record<string, string | number | boolean | null>;
      for (const field of rule.fields) {
        if (!Object.hasOwn(evidence.facts, field.sourceKey)) throw new Error('disclosure_value_not_allowed');
        const mapping = field.values.find(value => value.from === evidence.facts[field.sourceKey]);
        if (!mapping) throw new Error('disclosure_value_not_allowed');
        facts[field.outputKey] = mapping.to;
      }
      return { source: alias(evidence), basis, derived: evidence.derivedFrom.length > 0, facts, ...(rule.includeCoverage ? { coverage: evidence.coverage } : {}) };
    });
    return parseContract(DisclosurePayloadSchema, { schemaVersion: 1, kind: 'released_observations', observations });
  }
  private bytes(payload: DisclosurePayload) { return new TextEncoder().encode(JSON.stringify(payload)).length; }
  private view(record: DisclosureRecord): DisclosureView {
    return structuredClone({ id: record.id, destination: record.destination, surface: record.surface, labels: record.labels, payload: record.payload });
  }
  async release(workId: string, actor: WorkActor, request: { requestId: string; ruleId: string; evidenceIds: string[] }): Promise<DisclosureView> {
    const who = frozen(structuredClone(actor)); const input = parseContract(DisclosureRequestSchema, request); const rule = this.rule(input.ruleId);
    const state = await this.snapshot(workId, who); this.binding(state, rule);
    const requestDigest = this.digest(input); const existing = state.raw.disclosures?.find(record => record.id === input.requestId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw new Error('idempotency_conflict');
      return this.read(workId, who, input.requestId);
    }
    const originals = await this.originals(state, input.evidenceIds, rule); const payload = this.project(originals.selected, rule, originals.originals);
    const byteLength = this.bytes(payload);
    if (byteLength > rule.maxBytes) throw new Error('disclosure_byte_limit');
    const record: DisclosureRecord = { id: input.requestId, requestDigest, policyDigest: this.digest(state.raw.policy), ruleId: rule.id, ruleDigest: this.digest(rule),
      goalRevision: state.raw.goal.revision, dataGeneration: dataGeneration(state.raw), evidenceIds: input.evidenceIds, sources: originals.sources,
      destination: rule.destination, surface: rule.surface, labels: [...rule.releasedLabels], payload, payloadDigest: this.digest(payload), byteLength, createdAt: this.services.clock.now() };
    await transact(this.services, workId, `disclosure:${input.requestId}`, 'disclosure_recorded', input, next => {
      if (next.revision !== state.raw.revision) throw new Error('disclosure_state_changed');
      const policy = next.policy.disclosure!; const prior = next.disclosures ?? [];
      if (prior.length >= policy.maxReleasesPerWork || releasedBytes(prior) + byteLength > policy.maxReleasedBytesPerWork) throw new Error('disclosure_budget_exhausted');
      next.disclosures = [...prior, record];
    }, async () => {
      const latest = await this.snapshot(workId, who); this.binding(latest, rule);
      if (latest.raw.revision !== state.raw.revision) throw new Error('disclosure_state_changed');
      const current = await this.originals(latest, input.evidenceIds, rule);
      if (this.digest(current.sources) !== this.digest(record.sources)) throw new Error('disclosure_source_changed');
      if ((await this.snapshot(workId, who)).raw.revision !== state.raw.revision) throw new Error('disclosure_state_changed');
    });
    // A failed return still consumes the stored release. No external send is performed by release/read.
    return this.read(workId, who, input.requestId);
  }
  async read(workId: string, actor: WorkActor, releaseId: string): Promise<DisclosureView> {
    const who = frozen(structuredClone(actor)); const state = await this.snapshot(workId, who);
    const record = state.raw.disclosures?.find(item => item.id === releaseId); if (!record) throw new Error('disclosure_unavailable');
    const rule = this.rule(record.ruleId); this.binding(state, rule);
    if (record.policyDigest !== this.digest(state.raw.policy) || record.ruleDigest !== this.digest(rule) || record.goalRevision !== state.raw.goal.revision ||
        record.dataGeneration !== dataGeneration(state.raw) || record.destination !== rule.destination || record.surface !== rule.surface ||
        this.digest(record.labels) !== this.digest(rule.releasedLabels)) throw new Error('disclosure_contract_changed');
    const originals = await this.originals(state, record.evidenceIds, rule); const payload = this.project(originals.selected, rule, originals.originals);
    if (this.digest(originals.sources) !== this.digest(record.sources) || this.digest(payload) !== record.payloadDigest ||
        this.digest(record.payload) !== record.payloadDigest || this.bytes(payload) !== record.byteLength) throw new Error('disclosure_source_changed');
    if ((await this.snapshot(workId, who)).raw.revision !== state.raw.revision) throw new Error('disclosure_state_changed');
    return this.view(record);
  }
  /** A trusted transport must enter through this hook for each use of a released payload, including retries. */
  async dispatchReleased<T>(workId: string, actor: WorkActor, releaseId: string, receiver: DisclosureReceiver<T>): Promise<T> {
    const who = frozen(structuredClone(actor));
    const destination = receiver.destination; const surface = receiver.surface; const receive = receiver.receive.bind(receiver);
    const start = await this.snapshot(workId, who); const record = start.raw.disclosures?.find(item => item.id === releaseId);
    if (!record || record.destination !== destination || record.surface !== surface) throw new Error('disclosure_receiver_denied');
    const view = await this.read(workId, who, releaseId);
    const latest = await this.snapshot(workId, who);
    if (latest.raw.revision !== start.raw.revision) throw new Error('disclosure_state_changed');
    this.binding(latest, this.rule(record.ruleId));
    try { return await receive(structuredClone(view.payload)); }
    catch { throw new Error('disclosure_receiver_outcome_unknown'); }
  }
  /** Apply the same destination gate to an original used as a summary, search export, log, screen or attachment. */
  async readRaw(workId: string, actor: WorkActor, input: { artifact: ArtifactRef; destination: string; surface: DisclosureSurface }): Promise<Uint8Array> {
    const who = frozen(structuredClone(actor)); const request = structuredClone(input); const state = await this.snapshot(workId, who);
    const labels = [...new Set([...disclosureLabels(state.raw), ...request.artifact.labels])];
    const check = (policy: Policy) => {
      if (!policy.disclosure || !allowsDisclosure(policy, request.destination, request.surface, labels)) throw new Error('disclosure_raw_denied');
    };
    check(state.authorized.policy);
    const linked = state.raw.evidence.filter(e => e.artifact && this.digest(e.artifact) === this.digest(request.artifact));
    const current = new Set(evidenceView(state.authorized.evidence, state.authorized.policy, state.raw.goal.scope, 'current').map(e => e.id));
    if (artifactBlocked(state.authorized, request.artifact) || (linked.length ? linked.some(e => !current.has(e.id)) :
        !state.raw.artifacts.some(ref => this.digest(ref) === this.digest(request.artifact)))) throw new Error('disclosure_source_unavailable');
    let bytes: Uint8Array;
    try { bytes = await this.services.artifacts.get(request.artifact, state.authorized.policy); }
    catch { throw new Error('disclosure_source_unavailable'); }
    const latest = await this.snapshot(workId, who); check(latest.authorized.policy);
    if (latest.raw.revision !== state.raw.revision) throw new Error('disclosure_state_changed');
    return bytes;
  }
}
