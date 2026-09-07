import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentTurnInput } from '../application/agent-turn-types.js';
import type { Tool } from '../application/ports.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import type { AgentTurnResult } from '../domain/agent-turn.js';
import type { Evidence, Json, ToolResult, WorkState } from '../domain/model.js';
import { StructuredAgentTurnAdapter } from '../infrastructure/structured-agent-turn.js';
import { SyntheticComputerClock, SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import type { AgentExecutionHost } from '../presentation/host-tools.js';
import { computerLimits, saveNoteSteps } from './computer-use-helpers.js';

export const WRITE_COMPUTER_PROFILE = 'write-computer-entry';
export const WRITE_TOOL = 'company.note.write';
export const COMPUTER_ID = 'company.ui';
export const ENTRY_TEXT = '담당에게 연결된 저장 도구로 reviewed를 기록하고 결과를 확인해 줘.';
export interface WriteComputerEntryOptions { base: string; mode: 'write' | 'computer'; allowWrites?: boolean }

export function writeComputerEntryFixture(options: WriteComputerEntryOptions) {
  const observed = { inputs: [] as AgentTurnInput[], writes: 0, validations: 0, effectChecks: 0, toolCloses: 0, modelCloses: 0 };
  let driver: SyntheticComputerDriver | undefined;
  const identity = { provider: 'local-fixture', model: 'write-computer-entry', revision: '1' };
  const host: AgentExecutionHost = {
    identityRegistryDirectory: join(options.base, 'registry'),
    models: new Map([[WRITE_COMPUTER_PROFILE, { execution: 'deterministic_fixture', async open(profile) {
      const planner = new StructuredAgentTurnAdapter({ identity, profile, destination: 'local', maxRequestBytes: 131072,
        capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000, maxOutputTokens: 2048 } }, {
        async invoke(request) {
          const input = request.input, packet = input.packet; observed.inputs.push(structuredClone(input));
          const evidence = packet.evidence.find(item => item.facts['savedNote'] === 'reviewed');
          let result: AgentTurnResult;
          if (evidence) result = { kind: 'answer', text: 'reviewed 저장 결과를 확인했습니다.', evidenceIds: [evidence.id],
            assessment: { type: 'model_self_review', verdict: 'satisfied', rationale: '저장 도구가 반환한 원문과 검증된 결과를 사용했다.', missing: [], counterarguments: [] } };
          else {
            const observation = packet.toolObservations?.find(item => item.toolId === COMPUTER_ID + '.observe' && item.status === 'success');
            const output = observation?.output as Record<string, Json> | undefined;
            const acting = options.mode === 'computer' && typeof output?.['observationId'] === 'string';
            result = { kind: 'plan', proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision,
              basePlanRevision: packet.plan?.revision ?? 0, reason: '등록된 저장 수단으로 요청한 값을 기록하고 확인한다.', hypotheses: [], tasks: [{
                id: options.mode === 'write' ? 'write-note' : acting ? 'apply-note' : 'observe-note', description: '담당의 저장 결과 확인',
                toolId: options.mode === 'write' ? WRITE_TOOL : COMPUTER_ID + (acting ? '.act' : '.observe'), toolVersion: '1',
                effect: options.mode === 'write' || acting ? 'write' : 'read', dependsOn: [], maxAttempts: 1, satisfies: [],
                input: options.mode === 'write' ? { text: 'reviewed' } : acting ?
                  JSON.parse(JSON.stringify({ observationId: output!['observationId'], steps: saveNoteSteps, timeoutMs: 5000 })) : {},
              }] } };
          }
          return { provider: identity.provider, model: identity.model, finish: 'stop', content: JSON.stringify(result), usage: { inputTokens: 200, outputTokens: 80 } };
        },
      });
      return { planner, inputLimits: { maxInputBytes: 131072, maxOutputTokens: 2048 }, async close() { observed.modelCloses++; } };
    } }]]),
    tools: { async open(context, assembly) {
      assert.ok(assembly); const custody = assembly.custody;
      const policy = { tenantId: 'company', principalId: 'operator', allowWrites: options.allowWrites ?? true,
        allowedTools: [WRITE_TOOL, ...['observe', 'act', 'continue', 'verify'].map(kind => COMPUTER_ID + '.' + kind), ...RESOURCE_TOOL_IDS],
        allowedLabels: ['public'], allowedDestinations: ['local'] };
      const limits = { toolCalls: 10, modelCalls: 8, tokens: 1000000, replans: 4, wallTimeMs: 600000 };
      const receiptPath = (attemptId: string) => join(options.base, `write-${attemptId}.json`);
      async function validate(state: WorkState, result: ToolResult): Promise<boolean> {
        observed.validations++;
        try {
          const receipt = result.effectReceipt;
          if (!receipt || receipt.provider !== 'company' || receipt.operationId !== result.attemptId || receipt.outcome !== 'applied' ||
            receipt.origin !== 'execution' || result.status !== 'success' || result.effectState !== 'confirmed') return false;
          const bytes = await custody.artifacts.get(receipt.artifact, state.policy);
          if (!Buffer.from(bytes).equals(readFileSync(receiptPath(result.attemptId)))) return false;
          const record = JSON.parse(new TextDecoder().decode(bytes));
          return record.agentId === context.agentId && record.workId === state.id && record.attemptId === result.attemptId && record.text === 'reviewed' &&
            result.evidence.length === 1 && result.evidence[0]!.scope === context.scope && result.evidence[0]!.facts['savedNote'] === record.text;
        } catch { return false; }
      }
      const tool: Tool = { definition: { provider: 'company', id: WRITE_TOOL, version: '1', description: '임시 원본에 값을 저장하고 영수증을 남긴다.',
        effect: 'write', destination: 'local', labels: ['public'], resultValidation: 'artifact-proof-v1',
        inputSchema: { type: 'object', properties: { text: { const: 'reviewed' } }, required: ['text'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { savedNote: { const: 'reviewed' } }, required: ['savedNote'], additionalProperties: false } },
        async execute(task, invocation) {
          assert.ok(invocation.authorize); await invocation.authorize();
          assert.equal(task.input['text'], 'reviewed');
          const bytes = Buffer.from(JSON.stringify({ agentId: context.agentId, workId: invocation.workId, attemptId: invocation.attemptId, text: task.input['text'] }));
          writeFileSync(receiptPath(invocation.attemptId), bytes, { flag: 'wx', mode: 0o600 }); observed.writes++;
          const artifact = await custody.artifacts.put(bytes, { tenantId: policy.tenantId, labels: ['public'], mediaType: 'application/json' });
          const now = custody.clock.now();
          const evidence: Evidence = { id: `write-evidence:${invocation.attemptId}`, tenantId: policy.tenantId, scope: context.scope,
            sourceId: 'host-write', lineageId: context.agentId, locator: `host-write:${context.agentId}:${invocation.attemptId}`,
            observedAt: now, recordedAt: now, labels: ['public'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [],
            facts: { savedNote: 'reviewed' }, artifact };
          return { resultId: invocation.attemptId + ':result', attemptId: invocation.attemptId, status: 'success', effectState: 'confirmed',
            evidence: [evidence], artifacts: [artifact], output: { savedNote: 'reviewed' }, error: null, cursor: null, coverage: 'complete',
            effectReceipt: { provider: 'company', operationId: invocation.attemptId, outcome: 'applied', origin: 'execution', artifact, observedAt: now },
            usage: { transportCalls: 1, internalOperations: 1, imageBytes: 0, waitMs: 0 } };
        }, validateResult: validate,
      };
      if (options.mode === 'computer') {
        driver = new SyntheticComputerDriver({ clock: new SyntheticComputerClock(Date.now()), stateFile: join(options.base, 'computer-app.json') });
        return { tools: [], policy, limits, computerTools: [{ provider: 'company', id: COMPUTER_ID, version: '1', description: '연결된 시험 화면에 값을 저장한다.',
          destination: 'local', labels: ['public'], sessionId: 'synthetic-document', driver, limits: computerLimits }],
        async close() { observed.toolCloses++; assert.equal(driver!.snapshot().owner, 'available'); } };
      }
      const readState = async (workId: string) => { const state = await custody.state.get(workId); assert.ok(state); return state; };
      return { tools: [], writeTools: [tool], effectReaders: [{ provider: 'company', reader: {
        async current(state) {
          observed.effectChecks++;
          for (const attempt of state.attempts.filter(item => item.effectReceipt?.provider === 'company')) {
            if (!attempt.resultArtifact || !existsSync(receiptPath(attempt.id))) return false;
            const result = JSON.parse(new TextDecoder().decode(await custody.artifacts.get(attempt.resultArtifact, state.policy))) as ToolResult;
            if (!(await validate(state, result))) return false;
          }
          return true;
        }, refresh: readState, recover: readState,
      } }], policy, limits, async close() { observed.toolCloses++; } };
    } },
  };
  return { host, observed, driver: () => driver };
}
