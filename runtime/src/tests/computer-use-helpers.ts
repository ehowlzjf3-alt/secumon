import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ArtifactStore, StateRepository } from '../application/ports.js';
import type { ComputerBinding, ComputerDriver } from '../application/computer-use-ports.js';
import type { ComputerLimits, ComputerStep } from '../domain/computer-use.js';
import type { Json, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { newWork } from '../application/new-work.js';
import { FileGuidanceSource } from '../infrastructure/file-guidance.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';
import { FileJournalStateRepository } from '../infrastructure/file-journal-state.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { Sha256Digester, RandomIds } from '../infrastructure/digest.js';
import { FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { SyntheticComputerClock, SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';

export const computerActor = { tenantId: 'synthetic', principalId: 'computer-learner' };
export const computerLimits: ComputerLimits = { maxSteps: 3, maxObservations: 12, maxElements: 40, maxViewBytes: 32768, maxDurationMs: 5000, pollIntervalMs: 100 };
export type ComputerBackend = 'sqlite' | 'file-journal';
export async function computerHarness(backend: ComputerBackend, options: { directory?: string; clock?: SyntheticComputerClock;
  driver?: ComputerDriver; limits?: Partial<ComputerLimits>; store?: (store: StateRepository) => StateRepository;
  artifacts?: (store: ArtifactStore) => ArtifactStore; continuations?: boolean; leaseMs?: number; workId?: string } = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'computer-use-'));
  const state = options.store?.(openComputerStore(backend, directory)) ?? openComputerStore(backend, directory);
  const artifactStore = new FileArtifactStore(join(directory, 'artifacts'));
  const artifacts = options.artifacts?.(artifactStore) ?? artifactStore;
  const clock = options.clock ?? new SyntheticComputerClock(1000);
  const driver = options.driver ?? new SyntheticComputerDriver({ clock, stateFile: join(directory, 'app.json') });
  const binding: ComputerBinding = { provider: 'synthetic', id: 'synthetic.ui', version: '1', description: 'Read and edit a local synthetic document form',
    destination: 'local', labels: ['public'], sessionId: 'synthetic-document', driver, limits: { ...computerLimits, ...options.limits } };
  const services = { state, artifacts, clock, planner: new ScriptedPlanner([]), tools: [], digester: new Sha256Digester(), ids: new RandomIds(), sink: new FakeSink() };
  const core = await composeRuntime({ services, schemas: new AjvSchemas(), guidanceSource: new FileGuidanceSource(fileURLToPath(new URL('../../guidance/', import.meta.url))),
    owner: 'computer-worker', leaseMs: options.leaseMs ?? 10000, enablePlanning: false, computerTools: [binding] });
  const workId = options.workId ?? 'computer-work';
  if (!(await state.get(workId))) {
    const work = newWork({ id: workId, goal: { revision: 1, description: 'Save the requested note and verify its value', scope: 'computer-lesson', mode: 'deep',
      criteria: [{ id: 'saved', description: 'The app reports the saved note', key: 'savedNote', operator: 'equals', equals: 'reviewed', minIndependentSources: 1, requireCompleteCoverage: true }] },
      policy: { ...computerActor, allowedTools: ['synthetic.ui.observe', 'synthetic.ui.act', ...(options.continuations ? ['synthetic.ui.continue', 'synthetic.ui.verify'] : [])], allowedLabels: ['public'], allowedDestinations: ['local'], allowWrites: true },
      limits: { toolCalls: 30, modelCalls: 4, tokens: 10000, replans: 20, wallTimeMs: 60000 }, now: clock.now() });
    await state.commit({ workId, expectedRevision: 0, commandId: 'initial', commandDigest: 'initial', next: work, events: [{ type: 'accepted', at: clock.now(), data: {} }], deliveries: [] });
  }
  return { ...core, state, artifacts, clock, driver, binding, directory, workId,
    async close(remove = options.directory === undefined) { await core.runtime.settlePending('none'); await state.close(); if (remove) await rm(directory, { recursive: true, force: true }); } };
}
export function openComputerStore(backend: ComputerBackend, directory: string): StateRepository {
  return backend === 'sqlite' ? new SqliteStateRepository(join(directory, 'state.sqlite')) : new FileJournalStateRepository(join(directory, 'journal'));
}
export type ComputerHarness = Awaited<ReturnType<typeof computerHarness>>;
export async function submitComputerTask(h: ComputerHarness, kind: 'observe' | 'act', input: Record<string, Json> = {}) {
  const state = await h.runtime.state(h.workId);
  const task: TaskSpec = { id: `task-${state.revision}`, toolId: `synthetic.ui.${kind}`, toolVersion: '1', description: `Explicit ${kind} request`,
    input, dependsOn: [], effect: kind === 'observe' ? 'read' : 'write', maxAttempts: 1, satisfies: kind === 'act' ? ['saved'] : [] };
  await h.runtime.submitPlan(h.workId, `plan-${state.revision}`, { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
    basePlanRevision: state.plan?.revision ?? 0, reason: 'synthetic observation and confirmed typed input', tasks: [task], hypotheses: [] });
  return h.runtime.reserve(h.workId, task.id);
}
export async function computerResult(h: ComputerHarness, attemptId: string): Promise<ToolResult> {
  const state = await h.runtime.state(h.workId); const attempt = state.attempts.find(value => value.id === attemptId)!;
  if (!attempt.resultArtifact) throw new Error('test_result_missing');
  return JSON.parse(new TextDecoder().decode(await h.artifacts.get(attempt.resultArtifact, state.policy))) as ToolResult;
}
export async function observeComputer(h: ComputerHarness): Promise<{ observationId: string; attemptId: string; result: ToolResult }> {
  const attempt = await submitComputerTask(h, 'observe'); await h.runtime.execute(h.workId, attempt.id); await h.runtime.adopt(h.workId, attempt.id);
  const result = await computerResult(h, attempt.id);
  if (result.status !== 'success' && result.status !== 'partial') throw new Error(`test_observation_failed:${result.error?.code}`);
  return { observationId: (result.output as Record<string, Json>)['observationId'] as string, attemptId: attempt.id, result };
}
export function computerActInput(observationId: string, steps: ComputerStep[], timeoutMs = 5000): Record<string, Json> {
  return JSON.parse(JSON.stringify({ observationId, steps, timeoutMs })) as Record<string, Json>;
}
export const saveNoteSteps: ComputerStep[] = [
  { action: { kind: 'fill', target: { role: 'textbox', name: 'Note' }, value: 'reviewed' }, condition: { kind: 'element_value', target: { role: 'textbox', name: 'Note' }, value: 'reviewed' } },
  { action: { kind: 'click', target: { role: 'button', name: 'Save' } }, condition: { kind: 'fact_equals', key: 'savedNote', value: 'reviewed' } },
];
export async function mutateComputer(h: ComputerHarness, edit: (state: WorkState) => void) {
  const state = await h.state.get(h.workId); if (!state) throw new Error('test_work_missing');
  const next = structuredClone(state); next.revision++; edit(next);
  await h.state.commit({ workId: h.workId, expectedRevision: state.revision, commandId: `test-edit-${state.revision}`, commandDigest: 'test-edit', next,
    events: [{ type: 'test_edit', at: h.clock.now(), data: {} }], deliveries: [] });
}
