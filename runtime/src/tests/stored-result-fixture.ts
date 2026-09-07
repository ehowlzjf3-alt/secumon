import type { ArtifactRef, ToolResult } from '../domain/model.js';
import type { StoredToolResult, Tool } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { StoredToolResults } from '../application/stored-tool-results.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { toolExecution } from '../application/tool-execution-usage.js';
import { transact } from '../application/work-transactions.js';
import { asJson } from '../application/plan-validator.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { Sha256Digester, RandomIds } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { command, initial } from './state-conformance-helpers.js';

/** Real in-memory state/receipt transactions with a synthetic stored response; no MCP process or model invocation. */
export async function storedResultFixture(options: { publishResponse?: boolean } = {}) {
  const state = new MemoryStateRepository(), artifacts = new MemoryArtifactStore(), clock = new FakeClock(1000);
  const digester = new Sha256Digester(), work = initial('stored-result-work');
  const controls: { valid: boolean; restoreCalls: number; proofCalls: number; executeCalls: number;
    beforeRestore?: () => Promise<void>; beforeProof?: () => Promise<void>; restored?: StoredToolResult } = {
    valid: true, restoreCalls: 0, proofCalls: 0, executeCalls: 0,
  };
  let result!: ToolResult, raw!: ArtifactRef, responseCommandId = '', receivedAt = 0;
  const tool: Tool = { definition: { provider: 'fixture', id: 'fixture.read', version: '1', description: 'Stored-result boundary fixture',
    effect: 'read', destination: 'local', labels: ['synthetic'], resultValidation: 'artifact-proof-v1',
    inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' } },
    async execute() { controls.executeCalls++; throw new Error('recovery_must_not_execute'); },
    async validateResult(_state, value) {
      controls.proofCalls++; await controls.beforeProof?.();
      return controls.valid && digester.digest(asJson(value)) === digester.digest(asJson(result));
    },
    async restoreResult(current) {
      controls.restoreCalls++; await controls.beforeRestore?.();
      if (controls.restored) return structuredClone(controls.restored);
      const receipt = await state.receipt(current.id, responseCommandId);
      return receipt ? { kind: 'available', result: structuredClone(result), receivedAt,
        receipt: { commandId: responseCommandId, digest: receipt.digest, artifact: structuredClone(raw) } } : { kind: 'absent' };
    },
  };
  const services: RuntimeServices = { state, artifacts, clock, digester, ids: new RandomIds(), tools: [tool],
    planner: new ScriptedPlanner([]), sink: new FakeSink() };
  const schemas = new AjvSchemas(), contracts = new ToolContracts([tool], schemas);
  const original = new ExecutionRuntime(services, contracts, 'original-executor', 1000);
  await state.commit(command(work, 'accept'));
  const task = { id: 'read', description: 'Read once and retain its original response', toolId: 'fixture.read', toolVersion: '1',
    input: {}, effect: 'read' as const, dependsOn: [], maxAttempts: 2, satisfies: ['criterion'] };
  await original.submitPlan(work.id, 'plan', { baseStateRevision: work.revision, baseGoalRevision: 1, basePlanRevision: 0,
    reason: 'Stored result fixture', tasks: [task], hypotheses: [] });
  const attempt = await original.reserve(work.id, task.id); await original.dispatch(work.id, attempt.id);
  clock.advance(10); receivedAt = clock.now();
  raw = await artifacts.put(new TextEncoder().encode(JSON.stringify({ kind: 'fixture_original', receivedAt, available: true })),
    { tenantId: work.policy.tenantId, labels: ['synthetic'], mediaType: 'application/json' });
  result = { resultId: `fixture:${attempt.id}`, attemptId: attempt.id, status: 'success', effectState: 'none',
    artifacts: [raw], output: { available: true }, error: null, cursor: null, coverage: 'complete',
    usage: { transportCalls: 1, internalOperations: null, imageBytes: null, waitMs: null },
    evidence: [{ id: `fixture:${attempt.id}:0`, tenantId: work.policy.tenantId, scope: work.goal.scope,
      sourceId: 'fixture-original', lineageId: 'fixture-original', locator: '/available', observedAt: 1000, recordedAt: receivedAt,
      labels: ['synthetic'], coverage: 'complete', facts: { available: true }, artifact: raw,
      status: 'accepted', access: 'available', supersedes: [], derivedFrom: [] }] };
  responseCommandId = `fixture-response:${attempt.id}`;
  const publishResponse = async () => transact(services, work.id, responseCommandId, 'fixture_response_recorded',
    asJson({ attemptId: attempt.id, artifact: raw }), current => { current.artifacts.push(structuredClone(raw)); });
  if (options.publishResponse !== false) await publishResponse();
  const current = async () => (await state.get(work.id))!;
  const markLeaseExpired = async () => {
    if (clock.now() < attempt.leaseUntil) clock.advance(attempt.leaseUntil - clock.now());
    return transact(services, work.id, `recover:${attempt.id}`, 'attempt_recovered', { attemptId: attempt.id }, next => {
      const value = next.attempts.find(item => item.id === attempt.id)!;
      value.status = 'failed'; value.finishedAt = clock.now(); value.error = { code: 'lease_expired', retryable: true };
      value.execution = toolExecution('unreported'); next.status = 'ready'; next.statusReason = 'lease_expired';
    });
  };
  return { services, state, artifacts, clock, digester, schemas, contracts, tool, controls, original, workId: work.id, task, attempt,
    result, raw, receivedAt, responseCommandId, publishResponse, current, markLeaseExpired,
    restore: new StoredToolResults(services, contracts) };
}
