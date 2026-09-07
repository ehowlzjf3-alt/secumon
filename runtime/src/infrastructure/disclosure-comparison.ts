import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ContextPacket, Evidence, Goal, PlanProposal, Policy, Scalar, WorkState } from '../domain/model.js';
import type { DisclosurePayload, DisclosureRule, DisclosureSurface } from '../domain/disclosure.js';
import type { StateRepository } from '../application/ports.js';
import { DisclosureService } from '../application/disclosure-service.js';
import { DisclosurePayloadSchema } from '../application/disclosure-contracts.js';
import { newWork } from '../application/new-work.js';
import { buildContextPacket } from '../application/context-packet.js';
import { asJson, validatePlan } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { validateScenario } from '../application/fixtures.js';
import { FileArtifactStore } from './file-artifacts.js';
import { FileJournalStateRepository } from './file-journal-state.js';
import { SqliteStateRepository } from './sqlite-state.js';
import { Sha256Digester, sha256 } from './digest.js';
import { FakeClock } from './fakes.js';
import { AjvSchemas } from './ajv-schemas.js';
import { StructuredPlannerAdapter, type StructuredPlannerRequest } from './structured-planner.js';

export const disclosurePlacements = ['A', 'B', 'C'] as const;
export const disclosureBackends = ['sqlite', 'file-journal'] as const;
export const disclosureFamilies = ['document_comparison', 'observation_review'] as const;
export const disclosureSurfaces: DisclosureSurface[] = ['model', 'tool', 'channel', 'summary', 'search', 'log', 'screen', 'artifact', 'a2a'];
type Placement = typeof disclosurePlacements[number];
type Backend = typeof disclosureBackends[number];
type Family = typeof disclosureFamilies[number];
const at = 1788566400000;
const actor = { tenantId: 'synthetic', principalId: 'learner' };
const internal = 'fixture.internal'; const external = 'fixture.external';
const canary = 'SYNTHETIC_PRIVATE_BODY_7A39';
const ownerCanary = 'SYNTHETIC_PRIVATE_OWNER_D862';
const sourceCanary = 'SYNTHETIC_SOURCE_ID_72A8';
const lineageCanary = 'SYNTHETIC_LINEAGE_ID_8C17';
const locatorCanary = 'SYNTHETIC_LOCATOR_330A';
const forbidden = [canary, ownerCanary, sourceCanary, lineageCanary, locatorCanary, 'private-work', 'release-private'];
const digester = new Sha256Digester();
const contracts = new ToolContracts([], new AjvSchemas());
const limits = { toolCalls: 10, modelCalls: 10, tokens: 1000000, replans: 10, wallTimeMs: 120000 };
const encode = (value: unknown) => JSON.stringify(value);
const code = (error: unknown) => error instanceof Error ? error.message : 'unexpected_failure';

export interface DisclosureTransportObservation {
  destination: string;
  role: 'lead' | 'manager' | 'advisor';
  request: StructuredPlannerRequest;
  requestDigest: string;
  requestBytes: number;
  forbiddenValuesPresent: string[];
}
export interface DisclosureComparisonSample {
  id: string;
  placement: Placement;
  backend: Backend;
  family: Family;
  fixtureDigest: string;
  ruleDigest: string;
  configurationDigest: string;
  release: DisclosurePayload;
  restoredReleaseEqual: boolean;
  sourceProofCount: number;
  finiteMappedFactsCorrect: boolean;
  aliasesPreserveLineage: boolean;
  rawExternalModel: { code: string; transportEntries: number };
  releasedDispatchEntries: number;
  surfaces: { surface: DisclosureSurface; deniedExternal: boolean; denialCode: string | null; internalOriginalVisible: boolean }[];
  requests: DisclosureTransportObservation[];
  decisions: { role: 'lead' | 'manager' | 'advisor'; supported: boolean; planValidated: boolean; adoptedAsInternalCommand: boolean }[];
  facts: { sourceSlots: number; releasedSlots: number; withheldSlots: number; requiredReleasedSlots: number };
  persisted: { workRevision: number; disclosureRecords: number; disclosureBytes: number };
  runtimeCallsAccounted: false;
  wallElapsedMs: number;
  failures: string[];
  contractPassed: boolean;
}

function policy(publicOnly = false): Policy {
  const labels = publicOnly ? ['public'] : ['synthetic', 'restricted', 'public'];
  return { tenantId: publicOnly ? 'published' : actor.tenantId, principalId: publicOnly ? 'public-role' : actor.principalId,
    allowedTools: [], allowedLabels: labels, allowedDestinations: [internal, external], allowWrites: false,
    disclosure: { revision: 'fixture-boundary-v1', destinations: [
      { destination: internal, surfaces: [...disclosureSurfaces], allowedLabels: labels },
      { destination: external, surfaces: [...disclosureSurfaces], allowedLabels: ['public'] },
    ], maxReleasesPerWork: 4, maxReleasedBytesPerWork: 16384 } };
}
function openState(backend: Backend, directory: string): StateRepository {
  return backend === 'sqlite' ? new SqliteStateRepository(join(directory, 'state.sqlite')) : new FileJournalStateRepository(join(directory, 'state'));
}
async function saveInitial(state: StateRepository, work: WorkState) {
  const result = await state.commit({ workId: work.id, expectedRevision: 0, commandId: `accept:${work.id}`, commandDigest: digester.digest(asJson(work)),
    next: work, events: [{ type: 'synthetic_boundary_created', at, data: {} }], deliveries: [] });
  if (result.kind !== 'committed') throw new Error('comparison_initial_commit_failed');
}
function publicGoal(): Goal {
  return { revision: 1, description: 'Review the explicitly released observations.', scope: 'published-scope', mode: 'auto',
    criteria: [{ id: 'review', description: 'The approved review condition is present.', key: 'review_ready', operator: 'equals', equals: true,
      minIndependentSources: 1, requireCompleteCoverage: true }] };
}
/** A comparison-only consumer of a release already authenticated by DisclosureService. */
export function comparisonPublicWork(input: DisclosurePayload, advisor: boolean): WorkState {
  const payload = DisclosurePayloadSchema.parse(input);
  const work = newWork({ id: advisor ? 'published-advice' : 'published-lead', goal: publicGoal(), policy: policy(true), now: at, limits });
  const roots = new Map<number, string>();
  payload.observations.forEach((observation, index) => {
    if (!observation.derived) {
      if (observation.basis.length !== 1 || observation.basis[0] !== observation.source) throw new Error('comparison_invalid_root_basis');
      if (!roots.has(observation.source)) roots.set(observation.source, `released-${index + 1}`);
    }
  });
  if (!advisor) work.evidence = payload.observations.map((observation, index): Evidence => ({
    id: `released-${index + 1}`, tenantId: work.policy.tenantId, scope: work.goal.scope, sourceId: `source-${observation.source}`, lineageId: `source-${observation.source}`,
    locator: `released:${index + 1}`, observedAt: at, recordedAt: at, labels: ['public'], coverage: observation.coverage ?? 'unknown', status: 'accepted',
    supersedes: [], derivedFrom: observation.derived ? [...new Set(observation.basis)].map(source => roots.get(source) ?? `missing-root-${source}`) : [],
    facts: structuredClone(observation.facts), artifact: null,
  }));
  return work;
}
function scriptedProposal(packet: ContextPacket): PlanProposal {
  const reviewed = packet.evidence.filter(evidence => evidence.facts['review_ready'] === true || evidence.facts['retention.days'] === 30 || evidence.facts['collection.complete'] === true);
  return { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
    reason: reviewed.length ? 'Synthetic observations satisfy the review condition.' : 'Advice remains data for an internal review.', tasks: [],
    hypotheses: reviewed.length ? [{ id: 'review-condition', question: 'Does an observed fact satisfy the review condition?', claim: 'The review condition is satisfied.',
      predictedObservation: 'The supplied records contain the required condition.', falsifier: 'A supplied current record contradicts the condition.',
      status: 'supported', supportIds: reviewed.map(evidence => evidence.id), counterIds: [], reason: 'Deterministic fixture predicate, not model reasoning.' }] : [] };
}

async function invoke(work: WorkState, destination: string, role: DisclosureTransportObservation['role'], requests: DisclosureTransportObservation[], advice?: DisclosurePayload) {
  const packet = buildContextPacket(work, contracts);
  if (advice) packet.retrievedKnowledge = { entries: [{ attemptId: 'public-advice-data', toolId: 'released.observations', output: asJson(advice) }], omitted: 0,
    interpretation: 'prior_observations_not_fresh_evidence' };
  const adapter = new StructuredPlannerAdapter({ identity: { provider: 'synthetic', model: 'boundary-script', revision: '1' }, destination,
    capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 1000000 } }, {
    async invoke(request) {
      const text = encode(request);
      requests.push({ destination, role, request: structuredClone(request), requestDigest: sha256(text), requestBytes: Buffer.byteLength(text),
        forbiddenValuesPresent: forbidden.filter(value => text.includes(value)) });
      return { provider: 'synthetic', model: 'boundary-script', finish: 'stop', content: encode(scriptedProposal(request.packet)), usage: null };
    },
  });
  const reply = await adapter.propose(packet, new AbortController().signal, { callId: `call-${role}`, maxOutputTokens: 2048, tools: [] });
  if (reply.status !== 'ok') return { reply, proposal: null };
  return { reply, proposal: validatePlan(reply.proposal, work, contracts, digester) };
}

export function scoreDisclosureComparison(sample: Omit<DisclosureComparisonSample, 'failures' | 'contractPassed'>): string[] {
  const failures: string[] = [];
  if (!sample.restoredReleaseEqual || sample.persisted.disclosureRecords !== 1 || sample.sourceProofCount !== 2) failures.push('release_persistence_or_source_proof');
  if (!sample.finiteMappedFactsCorrect || !sample.aliasesPreserveLineage) failures.push('release_mapping_or_lineage');
  if (sample.release.observations.length !== 2 || sample.release.observations.some(observation => observation.facts['review_ready'] !== true ||
      Object.keys(observation.facts).length !== 1 || observation.coverage !== 'complete' || observation.source !== 1)) failures.push('release_payload');
  if (encode(sample.release.observations.map(observation => ({ basis: observation.basis, derived: observation.derived }))) !==
      encode([{ basis: [1], derived: false }, { basis: [1], derived: true }])) failures.push('release_derivation');
  if (sample.rawExternalModel.transportEntries !== 0 || sample.rawExternalModel.code !== 'model_disclosure_denied') failures.push('raw_external_model');
  if (sample.surfaces.length !== disclosureSurfaces.length || disclosureSurfaces.some(surface => sample.surfaces.filter(check => check.surface === surface).length !== 1)) failures.push('surface_coverage');
  if (sample.surfaces.some(surface => !surface.deniedExternal || surface.denialCode !== 'disclosure_raw_denied' || !surface.internalOriginalVisible)) failures.push('raw_surface_gate');
  const observedExternal = sample.requests.filter(request => request.destination === external);
  const observedInternal = sample.requests.filter(request => request.destination === internal);
  if (sample.releasedDispatchEntries !== observedExternal.length) failures.push('released_dispatch_entries');
  if (observedExternal.length !== (sample.placement === 'B' ? 0 : 1) || observedInternal.length !== (sample.placement === 'A' ? 0 : 1)) failures.push('placement_call_count');
  if (sample.requests.some(request => ![internal, external].includes(request.destination))) failures.push('unknown_destination');
  for (const request of sample.requests) {
    const text = encode(request.request);
    if (request.requestDigest !== sha256(text) || request.requestBytes !== Buffer.byteLength(text) || encode(request.forbiddenValuesPresent) !== encode(forbidden.filter(value => text.includes(value)))) failures.push('request_measurement_changed');
    if (request.destination === external && forbidden.some(value => text.includes(value))) failures.push('forbidden_external_value');
    if (request.destination === internal && !text.includes(canary)) failures.push('internal_original_missing');
    if (request.request.options.tools.length || request.request.packet.policy.allowWrites || request.request.packet.policy.allowedTools.length) failures.push('unexpected_execution_capability');
    if (request.destination === external && sample.placement === 'A') {
      const evidence = request.request.packet.evidence;
      if (request.role !== 'lead' || evidence.length !== 2 || evidence.some(item => encode(item.facts) !== encode({ review_ready: true }) ||
          item.sourceId !== 'source-1' || item.lineageId !== 'source-1' || item.coverage !== 'complete')) failures.push('public_lead_required_data');
      if (encode(evidence.map(item => ({ id: item.id, derivedFrom: item.derivedFrom }))) !==
          encode([{ id: 'released-1', derivedFrom: [] }, { id: 'released-2', derivedFrom: ['released-1'] }])) failures.push('public_derivation_changed');
    }
    if (request.destination === external && sample.placement === 'C' && (request.role !== 'advisor' || request.request.packet.evidence.length !== 0 ||
        encode(request.request.packet.retrievedKnowledge?.entries[0]?.output) !== encode(sample.release))) failures.push('advisory_data_changed');
    if (request.destination === internal) {
      const sourceKey = sample.family === 'document_comparison' ? 'retention.days' : 'collection.complete';
      const sourceValue = sample.family === 'document_comparison' ? 30 : true;
      if (request.role !== 'manager' || request.request.packet.evidence.length !== 2 || request.request.packet.evidence.some(item => item.facts[sourceKey] !== sourceValue)) failures.push('internal_required_data');
    }
  }
  const decision = sample.decisions.find(value => value.role === (sample.placement === 'A' ? 'lead' : 'manager'));
  if (!decision?.supported || !decision.planValidated || !decision.adoptedAsInternalCommand) failures.push('primary_plan_validation');
  if (sample.placement === 'C' && !sample.decisions.some(value => value.role === 'advisor' && value.planValidated && !value.adoptedAsInternalCommand)) failures.push('advisor_authority');
  if (sample.facts.sourceSlots !== 6 || sample.facts.releasedSlots !== 2 || sample.facts.withheldSlots !== 4 || sample.facts.requiredReleasedSlots !== 2) failures.push('field_accounting');
  return [...new Set(failures)];
}

export async function runDisclosureComparisonCase(directory: string, placement: Placement, backend: Backend, family: Family): Promise<DisclosureComparisonSample> {
  await mkdir(directory, { mode: 0o700 });
  const started = performance.now(); const clock = new FakeClock(at);
  let state = openState(backend, directory); const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
  const fixtureBytes = await readFile(new URL(`../../fixtures/${family === 'document_comparison' ? 'documents-simple' : 'observations-simple'}.json`, import.meta.url));
  const fixture = validateScenario(JSON.parse(fixtureBytes.toString('utf8')));
  const key = family === 'document_comparison' ? 'retention.days' : 'collection.complete';
  const value: Scalar = family === 'document_comparison' ? 30 : true;
  const original = fixture.evidence.find(evidence => evidence.coverage === 'complete' && evidence.facts[key] === value);
  if (!original) { await state.close(); throw new Error('comparison_fixture_missing'); }
  const rule: DisclosureRule = { id: 'approved-fixture-facts', version: '1', ...actor, scope: fixture.goal.scope, destination: external, surface: 'model',
    sourceLabels: ['synthetic', 'restricted'], releasedLabels: ['public'], fields: [{ sourceKey: key, outputKey: 'review_ready', values: [{ from: value, to: true }] }],
    includeCoverage: true, maxSources: 2, maxBytes: 4096 };
  const services = () => ({ state, artifacts, clock, digester });
  let service = new DisclosureService(services(), [rule]);
  try {
    const artifact = await artifacts.put(new TextEncoder().encode(`${canary}\n${ownerCanary}`), { tenantId: actor.tenantId, labels: ['synthetic', 'restricted'], mediaType: 'text/plain' });
    const work = newWork({ id: 'private-work', goal: { ...fixture.goal, description: `Review ${canary}` }, policy: policy(), now: at, limits });
    const evidence: Evidence = { ...original, id: `${sourceCanary}-original`, sourceId: sourceCanary, lineageId: lineageCanary, locator: locatorCanary,
      labels: ['synthetic', 'restricted'], facts: { [key]: value, 'private.body': canary, 'private.owner': ownerCanary }, artifact };
    work.evidence = [evidence, { ...structuredClone(evidence), id: `${sourceCanary}-copy`, derivedFrom: [evidence.id] }];
    await saveInitial(state, work);
    const released = await service.release(work.id, actor, { requestId: 'release-private', ruleId: rule.id, evidenceIds: work.evidence.map(item => item.id) });
    const beforeReopen = (await state.get(work.id))!;
    await state.close(); state = openState(backend, directory); service = new DisclosureService(services(), [rule]);
    const restored = await service.read(work.id, actor, released.id);
    const surfaces: DisclosureComparisonSample['surfaces'] = [];
    for (const surface of disclosureSurfaces) {
      let denialCode: string | null = null;
      try { await service.readRaw(work.id, actor, { artifact, destination: external, surface }); } catch (error) { denialCode = code(error); }
      const local = await service.readRaw(work.id, actor, { artifact, destination: internal, surface });
      surfaces.push({ surface, deniedExternal: denialCode !== null, denialCode, internalOriginalVisible: new TextDecoder().decode(local).includes(canary) });
    }
    const privateWork = (await state.get(work.id))!;
    const deniedRequests: DisclosureTransportObservation[] = [];
    const denied = await invoke(privateWork, external, 'lead', deniedRequests);
    const requests: DisclosureTransportObservation[] = []; const decisions: DisclosureComparisonSample['decisions'] = [];
    let releasedDispatchEntries = 0;
    if (placement === 'A') {
      const { published, decision } = await service.dispatchReleased(work.id, actor, released.id, { destination: external, surface: 'model', receive(payload) {
        releasedDispatchEntries++;
        const published = comparisonPublicWork(payload, false);
        // Build and enter the trusted transport synchronously after dispatch revalidation; persist only after the reply.
        return invoke(published, external, 'lead', requests).then(decision => ({ published, decision }));
      } });
      if (!decision.proposal) throw new Error('comparison_public_proposal_rejected');
      await saveInitial(state, published);
      await transact(services(), published.id, 'accept-public-plan', 'synthetic_plan_validated', {}, next => {
        next.plan = { revision: 1, goalRevision: next.goal.revision, reason: decision.proposal!.reason, tasks: decision.proposal!.tasks };
        next.hypotheses = decision.proposal!.hypotheses;
      });
      decisions.push({ role: 'lead', supported: decision.proposal.hypotheses[0]?.status === 'supported', planValidated: true, adoptedAsInternalCommand: true });
    } else {
      const decision = await invoke(privateWork, internal, 'manager', requests);
      if (!decision.proposal) throw new Error('comparison_internal_proposal_rejected');
      await transact(services(), privateWork.id, 'accept-internal-plan', 'synthetic_plan_validated', {}, next => {
        next.plan = { revision: 1, goalRevision: next.goal.revision, reason: decision.proposal!.reason, tasks: decision.proposal!.tasks };
        next.hypotheses = decision.proposal!.hypotheses;
      });
      decisions.push({ role: 'manager', supported: decision.proposal.hypotheses[0]?.status === 'supported', planValidated: true, adoptedAsInternalCommand: true });
      if (placement === 'C') {
        const before = encode(await state.get(privateWork.id));
        const advice = await service.dispatchReleased(work.id, actor, released.id, { destination: external, surface: 'model', receive(payload) {
          releasedDispatchEntries++;
          return invoke(comparisonPublicWork(payload, true), external, 'advisor', requests, payload);
        } });
        if (!advice.proposal) throw new Error('comparison_advisory_proposal_rejected');
        if (encode(await state.get(privateWork.id)) !== before) throw new Error('comparison_advice_mutated_internal_state');
        decisions.push({ role: 'advisor', supported: false, planValidated: true, adoptedAsInternalCommand: false });
      }
    }
    const final = (await state.get(work.id))!;
    const sourceSlots = work.evidence.reduce((sum, item) => sum + Object.keys(item.facts).length, 0);
    const releasedSlots = restored.payload.observations.reduce((sum, item) => sum + Object.keys(item.facts).length, 0);
    const base: Omit<DisclosureComparisonSample, 'failures' | 'contractPassed'> = {
      id: `${family}-${backend}-${placement}`, placement, backend, family, fixtureDigest: sha256(fixtureBytes), ruleDigest: digester.digest(asJson(rule)),
      configurationDigest: digester.digest(asJson({ policy: policy(), publicPolicy: policy(true), rule, at, limits, algorithm: 'fixture-predicate-v1' })),
      release: restored.payload, restoredReleaseEqual: encode(restored) === encode(released) && encode((await state.receipt(work.id, 'disclosure:release-private'))?.state.disclosures) === encode(beforeReopen.disclosures),
      sourceProofCount: final.disclosures?.[0]?.sources.length ?? 0,
      finiteMappedFactsCorrect: restored.payload.observations.every(observation => observation.facts['review_ready'] === true && Object.keys(observation.facts).length === 1),
      aliasesPreserveLineage: restored.payload.observations.length === 2 && restored.payload.observations.every(observation => observation.source === 1 && encode(observation.basis) === '[1]') &&
        restored.payload.observations[0]?.derived === false && restored.payload.observations[1]?.derived === true && !forbidden.some(marker => encode(restored.payload).includes(marker)),
      rawExternalModel: { code: denied.reply.status === 'ok' ? 'accepted' : denied.reply.code, transportEntries: deniedRequests.length }, releasedDispatchEntries, surfaces, requests, decisions,
      facts: { sourceSlots, releasedSlots, withheldSlots: sourceSlots - releasedSlots, requiredReleasedSlots: 2 },
      persisted: { workRevision: final.revision, disclosureRecords: final.disclosures?.length ?? 0, disclosureBytes: final.disclosures?.reduce((sum, record) => sum + record.byteLength, 0) ?? 0 },
      runtimeCallsAccounted: false, wallElapsedMs: performance.now() - started,
    };
    const failures = scoreDisclosureComparison(base); const sample = { ...base, failures, contractPassed: failures.length === 0 };
    await writeFile(join(directory, 'comparison.json'), `${JSON.stringify(sample, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return sample;
  } finally { await state.close(); }
}

export async function runDisclosureComparison(outDir: string) {
  const directory = resolve(outDir); await mkdir(directory, { mode: 0o700 });
  const samples: DisclosureComparisonSample[] = [];
  for (const family of disclosureFamilies) for (const backend of disclosureBackends) for (const placement of disclosurePlacements) {
    samples.push(await runDisclosureComparisonCase(join(directory, `${family}-${backend}-${placement}`), placement, backend, family));
  }
  const report = { schemaVersion: 1, scope: 'synthetic_disclosure_transport_contracts', actualModel: 'not_run',
    fullWorkflow: 'not_run', nonModelProductionAdapters: 'not_provided', organizationalPolicy: 'not_decided',
    releasedDispatch: 'source/policy/rule revalidated immediately before trusted receiver entry', normalizedReceiverSendLedger: 'not_implemented',
    measurements: { modelRequestBytes: 'actual StructuredPlannerTransport input JSON bytes', modelCalls: 'scripted adapter transport entries',
      fieldCounts: 'fixture fact slots, not semantic information or independent sources', wallElapsedMs: 'single local sample including I/O',
      modelTokens: null, modelCost: null, modelAccuracy: null, productionLatency: null },
    scheduled: 12, executed: samples.length, passed: samples.filter(sample => sample.contractPassed).length,
    byPlacement: disclosurePlacements.map(placement => {
      const cohort = samples.filter(sample => sample.placement === placement); const requests = cohort.flatMap(sample => sample.requests);
      return { placement, cases: cohort.length, passed: cohort.filter(sample => sample.contractPassed).length,
        releasedDispatchEntries: cohort.reduce((sum, sample) => sum + sample.releasedDispatchEntries, 0),
        internalModelCalls: requests.filter(request => request.destination === internal).length, externalModelCalls: requests.filter(request => request.destination === external).length,
        internalRequestBytes: requests.filter(request => request.destination === internal).reduce((sum, request) => sum + request.requestBytes, 0),
        externalRequestBytes: requests.filter(request => request.destination === external).reduce((sum, request) => sum + request.requestBytes, 0),
        forbiddenExternalRequests: requests.filter(request => request.destination === external && request.forbiddenValuesPresent.length > 0).length,
        rawSurfaceDenials: cohort.flatMap(sample => sample.surfaces).filter(surface => surface.deniedExternal).length };
    }), samples };
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return report;
}
