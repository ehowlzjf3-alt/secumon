import { accessibleEvidence } from '../domain/completion.js';
import type { Attempt, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import { ToolResultSchema } from './contracts.js';
import { knowledgeInputsCurrent, retainedKnowledgeDependencies, uniqueKnowledgeDependencies } from './knowledge-validity.js';
import { retainedInputDependencies, uniqueInputDependencies } from './input-validity.js';
import { asJson, taskDigest } from './plan-validator.js';
import type { ToolDefinition } from './ports.js';
import type { RuntimeServices } from './services.js';
import { toolAllowed, type ToolContracts } from './tool-contracts.js';
import type { WorkResources } from './work-resources.js';

/** Reuses only explicitly permitted original observations and revalidates their current custody. */
export class ToolResultReuse {
  constructor(readonly services: RuntimeServices, readonly tools: ToolContracts, readonly resources: WorkResources) {}
  private digest(value: unknown) { return this.services.digester.digest(asJson(value ?? null)); }
  private key(state: WorkState, task: TaskSpec, definition: ToolDefinition) {
    return this.digest({ workId: state.id, goal: state.goal, policy: state.policy, definition, input: task.input });
  }
  private allowed(state: WorkState, task: TaskSpec, consumer: Attempt): ToolDefinition | null {
    const definition = this.tools.get(task.toolId, task.toolVersion)?.tool.definition;
    const saved = state.attempts.find(attempt => attempt.id === consumer.id);
    const planned = state.plan?.tasks.find(value => value.id === task.id);
    if (!definition?.reuse || definition.collection || task.readResume || task.freshness === 'fresh' || task.effect !== 'read' || definition.effect !== 'read' ||
      !toolAllowed(definition, state.policy) || this.tools.check(task, state.policy) || !saved || !planned ||
      this.digest(planned) !== this.digest(task) || saved.taskId !== task.id || saved.toolId !== task.toolId || saved.toolVersion !== task.toolVersion ||
      saved.scope !== state.goal.scope || saved.goalRevision !== state.goal.revision || saved.planRevision !== state.plan?.revision ||
      saved.effect !== 'read' || saved.effectState !== 'none' || !['reserved', 'running', 'received', 'succeeded'].includes(saved.status) ||
      saved.inputDigest !== taskDigest(task, this.services.digester) || saved.contractDigest !== this.digest(definition) ||
      consumer.taskId !== saved.taskId || consumer.inputDigest !== saved.inputDigest || consumer.contractDigest !== saved.contractDigest ||
      consumer.goalRevision !== saved.goalRevision || consumer.scope !== saved.scope) return null;
    const reuse = definition.reuse;
    if (reuse.mode === 'immutable' ? typeof reuse.sourceVersion !== 'string' || !reuse.sourceVersion :
      reuse.mode !== 'ttl' || !Number.isSafeInteger(reuse.maxAgeMs) || reuse.maxAgeMs < 1) return null;
    return definition;
  }
  private ageAllowed(source: Attempt, definition: ToolDefinition) {
    const now = this.services.clock.now();
    return Number.isSafeInteger(now) && Number.isSafeInteger(source.startedAt) && source.startedAt <= now &&
      (definition.reuse?.mode !== 'ttl' || now - source.startedAt < definition.reuse.maxAgeMs);
  }
  private async current(state: WorkState) {
    if (this.digest(await this.services.state.get(state.id)) !== this.digest(state)) return false;
    if (!(await knowledgeInputsCurrent(this.services, state))) return false;
    return this.digest(await this.services.state.get(state.id)) === this.digest(state);
  }
  private contractCurrent(state: WorkState, task: TaskSpec, consumer: Attempt, expectedDigest: string) {
    const allowed = this.allowed(state, task, consumer);
    const latest = this.tools.get(task.toolId, task.toolVersion)?.tool.definition;
    return allowed !== null && latest !== undefined && this.digest(allowed) === expectedDigest && this.digest(latest) === expectedDigest;
  }
  private async candidate(state: WorkState, task: TaskSpec, consumer: Attempt, definition: ToolDefinition, source: Attempt): Promise<ToolResult | null> {
    if (source.id === consumer.id || !source.adopted || source.status !== 'succeeded' || source.effect !== 'read' || source.effectState !== 'none' ||
      source.reuse || source.execution?.mode !== 'invoked' || source.execution.implementationCalls !== 1 ||
      source.goalRevision !== state.goal.revision || source.scope !== state.goal.scope || source.toolId !== task.toolId || source.toolVersion !== task.toolVersion ||
      source.contractDigest !== this.digest(definition) || !source.resultArtifact || source.resultArtifact.byteLength > 65536 ||
      !source.resultId || source.finishedAt === null || source.finishedAt < source.startedAt || source.finishedAt > consumer.startedAt || !this.ageAllowed(source, definition)) return null;
    const receipt = await this.services.state.receipt(state.id, `dispatch:${source.id}`);
    const originalTask = receipt?.state.plan?.tasks.find(value => value.id === source.taskId);
    const dispatched = receipt?.state.attempts.find(value => value.id === source.id);
    if (!receipt || !originalTask || !dispatched || receipt.state.id !== state.id || dispatched.contractDigest !== source.contractDigest ||
      taskDigest(originalTask, this.services.digester) !== source.inputDigest || this.key(receipt.state, originalTask, definition) !== this.key(state, task, definition)) return null;
    const read = await this.resources.resultWithDependencies(state.id, state.policy, source.id, 65536);
    if (read.output.status !== 'available') return null;
    const value = read.output.value;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const original = ToolResultSchema.parse(value['result']);
    if (original.reuse || original.attemptId !== source.id || original.resultId !== source.resultId || original.status !== 'success' ||
      original.coverage !== 'complete' || original.effectState !== 'none' || original.error !== null || original.cursor !== null) return null;
    const current = new Map(accessibleEvidence(state.evidence, state.policy, state.goal.scope).map(evidence => [evidence.id, evidence]));
    if (original.evidence.some(evidence => !current.has(evidence.id) || this.digest(current.get(evidence.id)) !== this.digest(evidence))) return null;
    const dependencies = uniqueKnowledgeDependencies([...retainedKnowledgeDependencies(state), ...read.knowledgeDependencies]);
    const inputs = uniqueInputDependencies([...retainedInputDependencies(state), ...read.inputDependencies]);
    if (dependencies.length > 50 || inputs.length > 50) return null;
    const candidate: ToolResult = { ...structuredClone(original), attemptId: consumer.id, resultId: `${consumer.id}:result`,
      reuse: { attemptId: source.id, resultId: source.resultId, resultArtifact: structuredClone(source.resultArtifact),
        observedAt: source.startedAt, cacheKey: this.key(state, task, definition) },
      ...(dependencies.length ? { knowledgeDependencies: structuredClone(dependencies) } : {}),
      ...(inputs.length ? { inputDependencies: structuredClone(inputs) } : {}) };
    if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > 65536) return null;
    return candidate;
  }
  async find(value: WorkState, task: TaskSpec, consumerAttempt: Attempt): Promise<ToolResult | null> {
    try {
      const state = structuredClone(value); const consumer = structuredClone(consumerAttempt); const selected = structuredClone(task);
      const definition = this.allowed(state, selected, consumer);
      const definitionDigest = this.digest(definition);
      if (!definition || !(await this.current(state))) return null;
      const sources = [...state.attempts].sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id, 'en'));
      for (const source of sources) {
        let result: ToolResult | null;
        try { result = await this.candidate(state, selected, consumer, definition, source); } catch { continue; }
        if (result && await this.current(state) && this.ageAllowed(source, definition) && this.contractCurrent(state, selected, consumer, definitionDigest)) return result;
      }
      return null;
    } catch { return null; }
  }
  async validate(value: WorkState, task: TaskSpec, consumerAttempt: Attempt, input: ToolResult): Promise<boolean> {
    try {
      const state = structuredClone(value); const consumer = structuredClone(consumerAttempt); const selected = structuredClone(task);
      const definition = this.allowed(state, selected, consumer); const result = ToolResultSchema.parse(input);
      const definitionDigest = this.digest(definition);
      if (!definition || !result.reuse || result.attemptId !== consumer.id || result.resultId !== `${consumer.id}:result` ||
        (consumer.reuse && this.digest(consumer.reuse) !== this.digest(result.reuse)) || !(await this.current(state))) return false;
      const source = state.attempts.find(attempt => attempt.id === result.reuse!.attemptId);
      if (!source) return false;
      const expected = await this.candidate(state, selected, consumer, definition, source);
      return expected !== null && this.digest(expected) === this.digest(result) && await this.current(state) && this.ageAllowed(source, definition) &&
        this.contractCurrent(state, selected, consumer, definitionDigest);
    } catch { return false; }
  }
}
