import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentTurnInput } from '../application/agent-turn-types.js';
import type { GuidanceManifest } from '../application/guidance.js';
import type { Tool } from '../application/ports.js';
import type { AgentTurnResult } from '../domain/agent-turn.js';
import type { Evidence, Policy, TaskSpec } from '../domain/model.js';
import { sha256 } from '../infrastructure/digest.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { StructuredAgentTurnAdapter } from '../infrastructure/structured-agent-turn.js';
import { openAgentWeb } from '../presentation/agent-web.js';
import type { AgentExecutionHost } from '../presentation/host-tools.js';
import type { WorkbenchConfig } from '../presentation/web-contracts.js';
import { writeComputerEntryFixture } from './host-write-computer-entry-fixture.js';

export const deploymentEngine = fileURLToPath(new URL('../../', import.meta.url));
export const deploymentSpecs = [{
  key: 'research', name: '자료 조사 담당', purpose: '허용된 자료에서 배송 일정의 원문과 근거를 확인한다.',
  stateBackend: 'sqlite', personalMemory: 'documents', skillsMode: 'explicit', toolId: 'research.schedule.read',
  skillId: 'research.source-guide', skillBody: '배송 일정은 등록된 원본을 조회하고 출처와 함께 답한다.',
  sourceText: '조사 원본: 배송 예정일은 2031년 5월 17일입니다.', preference: '조사 기억: 날짜를 먼저 쓰고 원문 출처를 붙여 주세요.',
}, {
  key: 'review', name: '검토 담당', purpose: '허용된 검토 자료에서 승인 조건의 누락 여부를 확인한다.',
  stateBackend: 'file-journal', personalMemory: 'sqlite', skillsMode: 'on-demand', toolId: 'review.conditions.read',
  skillId: 'review.condition-guide', skillBody: '승인 조건은 등록된 검토 원문을 확인하고 누락을 단정하지 않는다.',
  sourceText: '검토 원본: 승인에 필요한 확인 항목은 담당자 서명입니다.', preference: '검토 기억: 확인 조건을 먼저 쓰고 추측을 구분해 주세요.',
}] as const;
export type DeploymentSpec = typeof deploymentSpecs[number];
export type DeploymentWeb = Awaited<ReturnType<typeof connect>>;

export function deploymentRequest(spec: DeploymentSpec, prefix = '') {
  return `${prefix}${spec.skillId}@1 지침을 선택하여 이 담당의 등록 원본을 확인하고 답해 주세요.`;
}

function errorSummary(value: unknown, depth = 0): Record<string, unknown> {
  if (!(value instanceof Error)) return { name: typeof value, message: 'non_error_throw' };
  const message = value.message;
  const safeMessage = /^[a-z][a-z0-9_]{0,119}$/.test(message) ||
    ['fetch failed', 'The operation was aborted due to timeout', 'This operation was aborted', 'The operation was aborted.'].includes(message);
  const code: unknown = (value as Error & { code?: unknown }).code;
  return { name: /^[A-Za-z0-9_]{1,80}$/.test(value.name) ? value.name : 'Error',
    message: safeMessage ? message : '[message redacted]', ...(safeMessage ? {} : { messageDigest: sha256(message) }),
    ...(typeof code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(code) ? { code } : {}),
    ...(depth === 0 && value.cause !== undefined ? { cause: errorSummary(value.cause, 1) } : {}) };
}

function hostFor(spec: DeploymentSpec, identityRegistryDirectory: string, writeHostDirectory?: string) {
  const observed = { inputs: [] as AgentTurnInput[], reads: 0, modelCloses: 0, toolCloses: 0 };
  const writeHost = writeHostDirectory ? writeComputerEntryFixture({ base: writeHostDirectory, mode: 'write' }) : null;
  const identity = { provider: 'local-fixture', model: 'two-deployment-entry', revision: '1' };
  const host: AgentExecutionHost = { identityRegistryDirectory,
    models: new Map([[`deployment-${spec.key}`, { execution: 'deterministic_fixture', async open(profile) {
      assert.equal(profile.purpose, spec.purpose); assert.equal(profile.skillsMode, spec.skillsMode);
      const turns = new Map<string, number>();
      const planner = new StructuredAgentTurnAdapter({ identity, profile, destination: 'local', maxRequestBytes: 65536,
        capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000, maxOutputTokens: 2048 } }, {
        async invoke(request) {
          const packet = request.input.packet;
          observed.inputs.push(structuredClone(request.input));
          const count = (turns.get(packet.workId) ?? 0) + 1; turns.set(packet.workId, count);
          assert.ok(count <= 3, 'finite fixture requires load, read, then answer');
          assert.ok(packet.goal.description.includes(`${spec.skillId}@1`), 'the input explicitly names the selected guide');
          const guidance = packet.activeGuidance?.find(value => value.id === spec.skillId && value.version === '1');
          const evidence = packet.evidence.find(value => value.sourceId === spec.toolId);
          let result: AgentTurnResult;
          if (evidence) {
            assert.ok(guidance); assert.equal(guidance.body, spec.skillBody);
            result = { kind: 'answer', text: String(evidence.facts.summary), evidenceIds: [evidence.id],
              assessment: { type: 'model_self_review', verdict: 'satisfied', rationale: '선택된 지침과 실제 등록 원본을 확인했다.', missing: [], counterarguments: [] } };
          } else {
            if (guidance) assert.equal(guidance.body, spec.skillBody);
            const task: Pick<TaskSpec, 'id' | 'description' | 'toolId' | 'input'> = guidance ? { id: 'read-source', description: '현재 담당의 허용 원본 조회', toolId: spec.toolId,
              input: { document: 'current' } } : { id: 'load-guide', description: '요청이 선택한 지침 읽기', toolId: 'core.guidance.load',
              input: { id: spec.skillId, version: '1', kind: 'lookup', reason: '사용자가 명시한 담당 지침을 적용한다.', maxBytes: 4096 } };
            result = { kind: 'plan', proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision,
              basePlanRevision: packet.plan?.revision ?? 0, reason: '지침과 원본을 차례로 확인한다.', hypotheses: [],
              tasks: [{ ...task, toolVersion: '1', effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] }] } };
          }
          return { provider: identity.provider, model: identity.model, finish: 'stop', content: JSON.stringify(result), usage: { inputTokens: 200, outputTokens: 50 } };
        },
      });
      return { planner, inputLimits: { maxInputBytes: 65536, maxOutputTokens: 2048 }, async close() { observed.modelCloses++; } };
    } }]]),
    tools: { async open(context, assembly) {
      // The existing host contract couples actor.allowWrites to a real write/computer
      // registration. This grants state editing; allowedTools still excludes every write.
      const writes = writeHost ? await writeHost.host.tools!.open(context, assembly) : null;
      if (writes) { assert.ok(writes.writeTools?.length); assert.ok(writes.effectReaders?.length); }
      const policy: Policy = { tenantId: 'deployment-company', principalId: 'same-operator', allowWrites: writeHost !== null,
        allowedTools: [spec.toolId, 'core.guidance.load'], allowedLabels: ['internal', 'public'], allowedDestinations: ['local'] };
      const tool: Tool = { definition: { provider: spec.key, id: spec.toolId, version: '1', description: spec.purpose,
        effect: 'read', destination: 'local', labels: ['internal'],
        inputSchema: { type: 'object', properties: { document: { const: 'current' } }, required: ['document'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } },
      async execute(_task, invocation) {
        assert.ok(invocation.authorize); await invocation.authorize(); observed.reads++;
        const now = Date.now();
        const evidence: Evidence = { id: `source:${invocation.workId}`, tenantId: policy.tenantId, scope: context.scope,
          sourceId: spec.toolId, lineageId: `${context.agentId}:${invocation.workId}`, locator: `${spec.toolId}:current`,
          observedAt: now, recordedAt: now, labels: ['internal'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [],
          facts: { summary: spec.sourceText }, artifact: null };
        return { resultId: `${invocation.attemptId}:result`, attemptId: invocation.attemptId, status: 'success', effectState: 'none',
          evidence: [evidence], artifacts: [], output: { summary: spec.sourceText }, error: null, cursor: null, coverage: 'complete' };
      } };
      return { tools: [tool], ...(writes ? { writeTools: writes.writeTools!, effectReaders: writes.effectReaders! } : {}),
        policy, limits: { toolCalls: 6, modelCalls: 6, tokens: 1000000, replans: 4, wallTimeMs: 600000 },
        async close() { observed.toolCloses++; await writes?.close(); } };
    } },
  };
  return { host, observed, writeHost: writeHost?.observed ?? null };
}

async function connect(directory: string, spec: DeploymentSpec, registry: string, sessionId?: string, writeHostDirectory?: string) {
  const fixture = hostFor(spec, registry, writeHostDirectory);
  const app = await openAgentWeb(['--directory', directory, '--provider', 'registered', '--conversation', 'same-conversation',
    ...(sessionId ? ['--session', sessionId] : [])], fixture.host);
  assert.ok(app);
  try {
    const login = await fetch(`${app.server.origin}/api/session`, { method: 'POST', headers: { Origin: app.server.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URL(app.server.connectUrl).hash.slice(9) }), signal: AbortSignal.timeout(10000) });
    assert.equal(login.status, 200);
    const session = await login.json() as { csrf: string; config: WorkbenchConfig };
    const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]!, Origin: app.server.origin, 'Content-Type': 'application/json', 'X-Work-CSRF': session.csrf };
    async function request<T>(path: string, body?: unknown, expected = 200): Promise<T> {
      // The memory-bearing completion includes source revalidation; this is a
      // bounded acceptance wait, not a claim that it meets a 20-second latency target.
      const timeoutMs = writeHostDirectory && path.endsWith('/commands') ? 60000 : 20000;
      const method = body === undefined ? 'GET' : 'POST', signal = AbortSignal.timeout(timeoutMs), started = performance.now();
      let status: number | null = null;
      try {
        const response = await fetch(`${app!.server.origin}${path}`, { headers, signal,
          ...(body === undefined ? {} : { method, body: JSON.stringify(body) }) });
        status = response.status;
        const value: unknown = await response.json(); assert.equal(status, expected, 'deployment_http_status_mismatch'); return value as T;
      } catch (error) {
        // Keep diagnostics independent of request/response bodies, auth headers and login tokens.
        throw new Error(`deployment_http_failed ${JSON.stringify({ deployment: spec.key, method, path: path.split('?')[0],
          elapsedMs: Math.round(performance.now() - started), status, expected, timeoutMs, aborted: signal.aborted,
          error: errorSummary(error), ...(signal.aborted ? { abortReason: errorSummary(signal.reason) } : {}),
          modelInputs: fixture.observed.inputs.length, sourceReads: fixture.observed.reads })}`);
      }
    }
    return { app, observed: fixture.observed, writeHost: fixture.writeHost, config: session.config, request };
  } catch (error) {
    try { await app.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'deployment_connect_cleanup_failed', { cause: error }); }
    throw error;
  }
}

export function deploymentFixture(t: TestContext, options: { allowMemorySelection?: boolean } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'two-agent-deployment-'))), registry = join(base, 'registry');
  const profiles = new FileAgentProfileStore(deploymentEngine), opened = new Set<DeploymentWeb>();
  t.after(async () => {
    const errors: unknown[] = [];
    for (const web of opened) try { await web.app.close(); } catch (error) {
      t.diagnostic(`deployment_cleanup ${JSON.stringify({ stage: 'close', error: errorSummary(error) })}`); errors.push(error);
    }
    try { rmSync(base, { recursive: true, force: true }); } catch (error) {
      t.diagnostic(`deployment_cleanup ${JSON.stringify({ stage: 'remove_temp', error: errorSummary(error) })}`); errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'deployment_fixture_cleanup_failed', { cause: errors[0] });
  });
  const deployments = deploymentSpecs.map(spec => {
    const writeHostDirectory = options.allowMemorySelection ? join(base, `${spec.key}-registered-write-host`) : undefined;
    if (writeHostDirectory) mkdirSync(writeHostDirectory, { mode: 0o700 });
    const directory = join(base, spec.key), ready = profiles.initialize(directory,
      { name: spec.name, purpose: spec.purpose, stateBackend: spec.stateBackend, personalMemory: spec.personalMemory });
    const config = { ...ready.config, model: { profile: `deployment-${spec.key}` }, skills: { mode: spec.skillsMode },
      features: { board: false, archive: false, peers: false, missions: false, a2a: false } };
    writeFileSync(join(directory, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    const manifest: GuidanceManifest = { id: spec.skillId, version: '1', title: spec.name, summary: spec.purpose,
      source: `fixture://${spec.skillId}`, tenantId: 'deployment-company', labels: ['internal'], supportedKinds: ['lookup'],
      sha256: sha256(spec.skillBody), byteLength: Buffer.byteLength(spec.skillBody), requiredRules: ['원문에 근거해 답한다.'] };
    writeFileSync(join(ready.paths.skills, 'guide.md'), spec.skillBody, { mode: 0o600 });
    writeFileSync(join(ready.paths.skills, 'catalog.json'), JSON.stringify({ schemaVersion: 1, entries: [{ ...manifest, bodyFile: 'guide.md' }] }), { mode: 0o600 });
    return { spec, directory, agentId: ready.identity.agentId, config,
      configBytes: readFileSync(join(directory, 'config.json')), catalogBytes: readFileSync(join(ready.paths.skills, 'catalog.json')),
      async open(sessionId?: string) { const web = await connect(directory, spec, registry, sessionId, writeHostDirectory); opened.add(web); return web; } };
  });
  return { base, registry, profiles, deployments };
}
