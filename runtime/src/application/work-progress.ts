import type { Digester } from './ports.js';
import type { Evidence, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { ProgressGate, ProgressPolicy, WorkProgress } from '../domain/work-progress.js';
import { observeProgress } from '../domain/work-progress.js';
import { accessibleEvidence, evaluateCompletion } from '../domain/completion.js';
import { visibleArtifact } from '../domain/data-lifecycle.js';
import { asJson } from './plan-validator.js';
import { WorkProgressSchema } from './work-progress-contracts.js';
import { z } from 'zod';
import { ArtifactSchema } from './contracts.js';
import { ToolDefinitionSchema } from './resource-contracts.js';
import { GuidanceManifestSchema } from './guidance.js';
import { toolAllowed } from './tool-contracts.js';
import { BoardRequestPageSchema } from './board-contracts.js';
import { ComputerDriverIdentitySchema, ComputerViewSchema } from './computer-use-contracts.js';

type ProgressState = WorkState & { progress?: WorkProgress | undefined };
type CaptureOptions = { failureKey?: string | null; additionalKeys?: string[]; policy?: ProgressPolicy };

const resourceId = z.string().min(1).max(256);
const sourceDigest = z.string().regex(/^[0-9a-f]{64}$/);
const toolCard = z.strictObject({ provider: resourceId, id: resourceId, version: resourceId, description: z.string().max(240),
  effect: z.enum(['read', 'write']), contractDigest: sourceDigest });
const guidanceCard = z.strictObject({ id: resourceId, version: resourceId, title: z.string().min(1).max(200), summary: z.string().min(1).max(500),
  byteLength: z.number().int().positive().max(1048576), sha256: sourceDigest });
const evidenceFindInput = z.strictObject({ query: z.string().max(128), limit: z.number().int().min(1).max(20) });
const evidencePage = z.strictObject({ cards: z.array(z.strictObject({ id: z.string(), sourceId: z.string(), locator: z.string(),
  observedAt: z.number().int().nonnegative(), coverage: z.enum(['complete', 'partial', 'unknown']) })).max(20),
  hasMore: z.boolean(), truncated: z.boolean(), stateRevision: z.number().int().nonnegative() });
const evidenceGetInput = z.strictObject({ evidenceId: resourceId, detail: z.literal('evidence'), maxBytes: z.number().int().min(256).max(65536) });
function evidenceIdentity(value: Evidence) {
  return { tenantId: value.tenantId, scope: value.scope, lineageId: value.lineageId,
    facts: value.facts, coverage: value.coverage, sourceVersion: value.artifact?.sha256 ?? null };
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Preparation credit only after ordinary source/contract validation and adoption; this never supplies evidence or grants authority. */
export function acceptedToolProgressKeys(state: WorkState, task: TaskSpec, result: ToolResult, digester: Digester, verifiedComputerObservation = false): string[] {
  const attempt = state.attempts.find(value => value.id === result.attemptId);
  if (!attempt?.adopted || attempt.resultId !== result.resultId || attempt.taskId !== task.id || attempt.toolId !== task.toolId || attempt.toolVersion !== task.toolVersion ||
    attempt.goalRevision !== state.goal.revision || attempt.scope !== state.goal.scope || attempt.effect !== 'read' || attempt.effectState !== 'none' || task.effect !== 'read' ||
    !['succeeded', 'partial'].includes(attempt.status) || !['success', 'partial'].includes(result.status) || result.error || result.effectState !== 'none' ||
    result.reuse || attempt.reuse || attempt.execution?.mode === 'reused' || !state.policy.allowedTools.includes(task.toolId)) return [];
  const output = record(result.output); if (!output || (output['status'] !== undefined && output['status'] !== 'available')) return [];
  const digest = (value: unknown) => digester.digest(asJson(value));
  const key = (kind: string, value: unknown) => `preparation:${kind}:${digest({ tenantId: state.policy.tenantId, value })}`;
  if (verifiedComputerObservation && output['kind'] === 'computer_observation') {
    const view = ComputerViewSchema.safeParse(output['view']), driver = ComputerDriverIdentitySchema.safeParse(output['driver']);
    if (!view.success || !driver.success || output['sessionId'] !== view.data.sessionId ||
      typeof output['observationId'] !== 'string' || !output['observationId'].length ||
      (!view.data.elements.length && !Object.keys(view.data.facts).length)) return [];
    // Lease, observation and element handles change on reread; only screen content earns a new preparation credit.
    const elements = view.data.elements.map(({ ref: _ref, ...element }) => digest(element)).sort();
    return [key('computer-observation', { toolId: task.toolId, toolVersion: task.toolVersion, driver: driver.data,
      sessionId: view.data.sessionId, surfaceId: view.data.surfaceId, elements, facts: view.data.facts,
      partial: view.data.partial, omittedCount: view.data.omittedCount })];
  }
  if (!state.policy.allowedDestinations.includes('local')) return [];
  const catalogKey = (value: z.infer<typeof toolCard>) => key('tool-card', { id: value.id, version: value.version, contractDigest: value.contractDigest });
  const guideKey = (value: { id: string; version: string; sha256: string }) => key('guidance-card', { id: value.id, version: value.version, sha256: value.sha256 });
  const permittedCard = (value: z.infer<typeof toolCard>) => value.id.startsWith(`${value.provider}.`) && state.policy.allowedTools.includes(value.id) &&
    (value.effect !== 'write' || state.policy.allowWrites);
  if (task.toolId === 'core.evidence.find' || task.toolId === 'core.evidence.get') {
    if (task.toolVersion !== '1' || !['complete', 'partial'].includes(result.coverage) || result.evidence.length || result.artifacts.length) return [];
    const current = accessibleEvidence(state.evidence, state.policy, state.goal.scope)
      .filter(value => !value.artifact || visibleArtifact(state, value.artifact));
    const cardKey = (value: Evidence) => key('evidence-card', evidenceIdentity(value));
    if (task.toolId === 'core.evidence.find') {
      const input = evidenceFindInput.safeParse(task.input), page = evidencePage.safeParse(output);
      if (!input.success || !page.success || page.data.stateRevision > state.revision || page.data.cards.length > input.data.limit) return [];
      const query = input.data.query.normalize('NFC').toLocaleLowerCase('en-US');
      const keys: string[] = [];
      for (const card of page.data.cards) {
        const value = current.find(item => item.id === card.id);
        if (!value || !`${value.id}\n${value.sourceId}\n${value.locator}\n${JSON.stringify(value.facts)}`.normalize('NFC').toLocaleLowerCase('en-US').includes(query)) return [];
        const locator = Array.from(value.locator);
        const expected = { id: value.id, sourceId: value.sourceId, locator: locator.length > 256 ? `${locator.slice(0, 255).join('')}…` : value.locator,
          observedAt: value.observedAt, coverage: value.coverage };
        if (digest(card) !== digest(expected)) return [];
        if (value.derivedFrom.length === 0) keys.push(cardKey(value));
      }
      return [...new Set(keys)];
    }
    const input = evidenceGetInput.safeParse(task.input), body = record(output['value']);
    if (!input.success || result.status !== 'success' || result.coverage !== 'complete' || output['status'] !== 'available' ||
      !body || !record(body['evidence']) || body['view'] !== 'current_accepted_evidence' || !Number.isSafeInteger(body['stateRevision']) ||
      (body['stateRevision'] as number) < 0 || (body['stateRevision'] as number) > state.revision) return [];
    const value = current.find(item => item.id === input.data.evidenceId);
    if (!value || value.derivedFrom.length !== 0 || digest(body['evidence']) !== digest(value)) return [];
    const byteLength = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    if (output['byteLength'] !== byteLength || byteLength > input.data.maxBytes) return [];
    return [cardKey(value), key('evidence-body', evidenceIdentity(value))];
  }
  if (task.toolId === 'core.board.requests.read') {
    const page = BoardRequestPageSchema.safeParse(output); if (!page.success || page.data.boardId !== task.input['boardId']) return [];
    return page.data.requests.map(({ updatedAt: _updatedAt, ...request }) => key('request-metadata', { boardId: page.data.boardId, roleId: page.data.roleId, request }));
  }
  if (task.toolId === 'core.catalog.search') {
    const parsed = toolCard.array().max(20).safeParse(output['cards']);
    return parsed.success ? [...new Set(parsed.data.filter(permittedCard).map(catalogKey))] : [];
  }
  if (task.toolId === 'core.catalog.get') {
    const card = toolCard.safeParse(output['card']); const definition = ToolDefinitionSchema.safeParse(output['definition']);
    if (!card.success || !definition.success || !permittedCard(card.data) || !toolAllowed(definition.data, state.policy) ||
      card.data.id !== task.input['id'] || card.data.version !== task.input['version'] || definition.data.id !== card.data.id || definition.data.version !== card.data.version ||
      definition.data.provider !== card.data.provider || definition.data.effect !== card.data.effect || digest(definition.data) !== card.data.contractDigest) return [];
    return [catalogKey(card.data), key('tool-definition', { id: card.data.id, version: card.data.version, contractDigest: card.data.contractDigest })];
  }
  if (task.toolId === 'core.guidance.find') {
    const parsed = guidanceCard.array().max(20).safeParse(output['cards']);
    return parsed.success ? [...new Set(parsed.data.map(guideKey))] : [];
  }
  if (task.toolId === 'core.guidance.load') {
    const manifest = GuidanceManifestSchema.safeParse(output['manifest']); const artifact = ArtifactSchema.safeParse(output['artifact']); const selected = record(output['selectedFor']);
    if (!manifest.success || !artifact.success || output['status'] !== 'available' || output['role'] !== 'guidance_only' || output['grantsPermissions'] !== false ||
      typeof output['body'] !== 'string' || !selected || selected['workId'] !== state.id || selected['goalRevision'] !== state.goal.revision || selected['kind'] !== task.input['kind'] ||
      manifest.data.id !== task.input['id'] || manifest.data.version !== task.input['version'] || !manifest.data.supportedKinds.includes(task.input['kind'] as never) ||
      manifest.data.tenantId !== state.policy.tenantId || !manifest.data.labels.every(label => state.policy.allowedLabels.includes(label)) ||
      !visibleArtifact(state, artifact.data) || artifact.data.mediaType !== 'text/markdown' || artifact.data.sha256 !== manifest.data.sha256 ||
      artifact.data.byteLength !== manifest.data.byteLength || new TextEncoder().encode(output['body']).byteLength !== manifest.data.byteLength ||
      !manifest.data.labels.every(label => artifact.data.labels.includes(label)) || !result.artifacts.some(value => digest(value) === digest(artifact.data)) ||
      !state.artifacts.some(value => digest(value) === digest(artifact.data))) return [];
    const identity = { id: manifest.data.id, version: manifest.data.version, sha256: manifest.data.sha256,
      labels: [...manifest.data.labels].sort(), supportedKinds: [...manifest.data.supportedKinds].sort(), requiredRules: manifest.data.requiredRules ?? [] };
    return [guideKey(manifest.data), key('guidance-body', identity)];
  }
  return [];
}

/** Caller supplies an authenticated, settled state inside its transaction. No source or permission cache is used. */
export function captureProgress(state: ProgressState, digester: Digester, operationId: string, at: number, options: CaptureOptions = {}): WorkProgress {
  const digest = (value: unknown) => digester.digest(asJson(value));
  const evidence = accessibleEvidence(state.evidence, state.policy, state.goal.scope).filter(value => !value.artifact || visibleArtifact(state, value.artifact));
  const originals = evidence.filter(value => value.derivedFrom.length === 0);
  const evidenceKeys = [...new Set(originals.map(value => `evidence:${digest(evidenceIdentity(value))}`))].sort();
  const keys = [...evidenceKeys];
  const criterion = (value: WorkState['goal']['criteria'][number]) => ({ scope: state.goal.scope, key: value.key, operator: value.operator,
    equals: value.equals, minIndependentSources: value.minIndependentSources, requireCompleteCoverage: value.requireCompleteCoverage });
  const criteria = state.goal.criteria.map(criterion).map(digest).sort();
  const assessment = state.hypothesisAssessment;
  if (evidenceKeys.length && state.hypotheses.length && assessment?.goalRevision === state.goal.revision &&
    JSON.stringify([...assessment.evidenceIds].sort()) === JSON.stringify(evidence.map(value => value.id).sort()))
    keys.push(`assessment:${digest({ scope: state.goal.scope, criteria, evidenceKeys })}`);
  for (const result of evaluateCompletion(state.goal, evidence, [], state.policy, state.attempts).criteria) if (result.met) {
    const current = state.goal.criteria.find(value => value.id === result.id)!; keys.push(`criterion:${digest(criterion(current))}`);
  }
  for (const obligation of state.obligations) if (obligation.status === 'satisfied')
    keys.push(`obligation:${digest({ scope: state.goal.scope, kind: obligation.kind, wakeKey: obligation.wakeKey })}`);
  keys.push(...(options.additionalKeys ?? []));
  const next = observeProgress(state.progress, { goalRevision: state.goal.revision, operationId, keys, failureKey: options.failureKey ?? null, at }, options.policy);
  state.progress = next; return structuredClone(next);
}

/** Applies only to a new allocation; settlement, recovery, completion and external-effect reconciliation precede this gate. */
export function progressGate(state: Pick<ProgressState, 'progress' | 'deadlineAt'>, now: number, failureKey?: string | null): ProgressGate | null {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('progress_invalid');
  if (!state.progress) return null;
  const progress = WorkProgressSchema.parse(state.progress);
  if (progress.saturated) return { kind: 'blocked', reason: 'progress_capacity_exceeded' };
  const failure = failureKey ? progress.failures.find(value => value.key === failureKey) : undefined;
  if (failure && now >= Math.min(state.deadlineAt, failure.deadlineAt)) return { kind: 'blocked', reason: 'retry_deadline_exceeded' };
  if (failure && failure.count >= progress.policy.maxRepeatedFailures) return { kind: 'blocked', reason: 'repeated_failure_limit' };
  if (progress.consecutiveUnproductive >= progress.policy.maxUnproductiveSteps) return { kind: 'blocked', reason: 'no_progress_limit' };
  if (failure && now < failure.nextEligibleAt) return { kind: 'wait', reason: 'retry_backoff', wakeAt: Math.min(state.deadlineAt, failure.nextEligibleAt) };
  return null;
}
