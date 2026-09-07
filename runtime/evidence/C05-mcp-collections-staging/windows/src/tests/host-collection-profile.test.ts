import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactRef, Evidence, Json, TaskSpec } from '../domain/model.js';
import type { ReadCollectionBinding, ReadCollectionSource, Tool } from '../application/ports.js';
import { readGeneratedAnswer } from '../application/generated-answer.js';
import { ToolResultSchema } from '../application/contracts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FixtureReadTool } from '../infrastructure/fakes.js';
import { SYNTHETIC_AGENT_TURN_REQUESTS as requests } from '../infrastructure/synthetic-agent-turn.js';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { openRegisteredHostTools, type AgentExecutionHost, type HostToolAssembly, type HostToolContext,
  type OpenedHostTools } from '../presentation/host-tools.js';
import { acceptHostRequest, errorLeaves, hostLimits, hostPolicy, hostToolFixture, toolHost } from './host-tool-profile-helper.js';

// A finite in-process collection source; MCP transport and interruption cases have separate fixtures.
function collectionHost() {
  const model = toolHost();
  const controls = { storedOnly: false, policy: structuredClone(hostPolicy), closeError: null as Error | null,
    edit: undefined as ((lease: OpenedHostTools) => void) | undefined };
  const opens: { context: HostToolContext; assembly: HostToolAssembly; binding: ReadCollectionBinding;
    collections: ReadCollectionBinding[]; lease: OpenedHostTools }[] = [];
  const closes: string[] = [], fetches: { agentId: string; workId: string; attemptId: string; raw: ArtifactRef; bytes: Uint8Array }[] = [];
  const host: AgentExecutionHost = { models: model.host.models, tools: { async open(context, assembly) {
    assert.ok(assembly); assert.equal(assembly.signal.aborted, false);
    let closed = false;
    const source: ReadCollectionSource = { async fetch(task, request, execution) {
      assert.equal(this, source); assert.equal(closed, false); assert.equal(controls.storedOnly, false);
      await execution.authorize?.();
      assert.deepEqual(task.input, { evidenceIds: ['doc-current'] });
      const bytes = new TextEncoder().encode(JSON.stringify({ agentId: context.agentId, request, retentionDays: 45 }));
      const raw = await assembly.custody.artifacts.put(bytes,
        { tenantId: controls.policy.tenantId, labels: ['synthetic'], mediaType: 'application/json' });
      const at = assembly.custody.clock.now();
      const evidence: Evidence = { id: 'doc-current', tenantId: controls.policy.tenantId, scope: context.scope,
        sourceId: `collection:${context.agentId}`, lineageId: `collection:${context.agentId}`, locator: `fixture://collection/${context.agentId}`,
        observedAt: at, recordedAt: at, labels: ['synthetic'], coverage: 'complete', status: 'accepted',
        supersedes: [], derivedFrom: [], facts: { 'retention.days': 45 }, artifact: raw };
      const key = { id: 'doc-current', inputDigest: assembly.custody.digester.digest({ agentId: context.agentId, id: 'doc-current' }) };
      fetches.push({ agentId: context.agentId, workId: execution.workId, attemptId: execution.attemptId, raw, bytes });
      return { requestId: request.requestId, cursor: request.cursor, sourceSnapshot: `snapshot:${context.agentId}`,
        nextCursor: null, exhausted: true, totalItems: 1, expected: [key], rawArtifact: raw,
        items: [{ ...key, status: 'success', output: { retentionDays: 45 }, evidence: [evidence], artifacts: [raw], coverage: 'complete', error: null }],
        usage: { transportCalls: 0, internalOperations: 1, imageBytes: 0, waitMs: 0 } };
    } };
    const fixtureDefinition = new FixtureReadTool([]).definition;
    const binding: ReadCollectionBinding = { definition: { ...structuredClone(fixtureDefinition),
      inputSchema: { ...fixtureDefinition.inputSchema, title: 'host-collection-input' },
      outputSchema: { type: 'object', title: 'host-collection-output' },
      collection: { kind: 'paged', limits: { maxPages: 2, maxItems: 4, maxCalls: 3, pageSize: 2,
        maxPageBytes: 65536, maxCheckpointBytes: 262144 } } }, source,
      ...(controls.storedOnly ? { availability: 'stored_only' } : {}) };
    const plain: Tool = { definition: { ...structuredClone(fixtureDefinition), id: 'fixture.plain', description: 'Unselected plain source' },
      async execute() { assert.fail('unselected plain tool must not execute'); } };
    const collections = [binding], closeError = controls.closeError;
    const lease: OpenedHostTools = { tools: [plain], collectionTools: collections,
      policy: structuredClone(controls.policy), limits: structuredClone(hostLimits), async close() {
        assert.equal(this, lease); closed = true; closes.push(context.agentId); if (closeError) throw closeError;
      } };
    controls.edit?.(lease); opens.push({ context, assembly, binding, collections, lease }); return lease;
  } } };
  return { host, model, controls, opens, closes, fetches };
}
function readTask(): TaskSpec {
  return { id: 'read-collection', description: 'Read the registered collection', dependsOn: [], toolId: 'fixture.read', toolVersion: '1',
    input: { evidenceIds: ['doc-current'] }, effect: 'read', maxAttempts: 1, satisfies: [] };
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: mixed host collection uses the profile's original stores and one compiled registry through answer and reopen`, { timeout: 60000 }, async t => {
    const f = hostToolFixture(t), ready = f.create('collection', backend), h = collectionHost();
    const compile = AjvSchemas.prototype.compile, compiled: string[] = [];
    t.mock.method(AjvSchemas.prototype, 'compile', function (this: AjvSchemas, schema: Json) {
      if (schema && typeof schema === 'object' && !Array.isArray(schema) && typeof schema['title'] === 'string' && schema['title'].startsWith('host-collection-'))
        compiled.push(schema['title']);
      return compile.call(this, schema);
    });
    const profile = await f.open(ready.root, h.host), opened = h.opens[0]!;
    assert.equal(opened.assembly.custody.state, profile.services.state); assert.equal(opened.assembly.custody.artifacts, profile.services.artifacts);
    assert.equal(opened.assembly.custody.digester, profile.services.digester); assert.equal(opened.assembly.custody.clock, profile.services.clock);
    assert.deepEqual(compiled, ['host-collection-input', 'host-collection-output']);
    assert.ok(profile.contracts.get('fixture.plain', '1')); assert.ok(profile.contracts.get('fixture.read', '1')?.tool.definition.collection);
    assert.deepEqual(profile.policy.allowedTools, ['fixture.read']);
    const capturedDefinition = structuredClone(profile.contracts.get('fixture.read', '1')!.tool.definition);
    opened.binding.definition.version = 'changed-after-open'; opened.binding.source.fetch = async () => { assert.fail('replacement fetch'); };
    opened.collections.length = 0;
    assert.deepEqual(profile.contracts.get('fixture.read', '1')!.tool.definition, capturedDefinition);
    const accepted = await acceptHostRequest(profile, 'collection-read', requests.read);
    assert.equal((await profile.workflow.run(accepted.workId, profile.actor)).control.kind, 'complete');
    const state = await profile.runtime.state(accepted.workId), attempt = state.attempts[0]!;
    assert.equal(h.fetches.length, 1); assert.equal(h.fetches[0]!.agentId, profile.agentId); assert.equal(h.fetches[0]!.workId, state.id);
    assert.equal(attempt.id, h.fetches[0]!.attemptId); assert.equal(attempt.adopted, true); assert.equal(attempt.readProgress?.phase, 'complete');
    assert.equal(state.evidence[0]!.scope, profile.scope); assert.equal(state.evidence[0]!.tenantId, profile.actor.tenantId);
    assert.equal(state.evidence[0]!.sourceId, `collection:${profile.agentId}`);
    assert.deepEqual(await profile.services.artifacts.get(h.fetches[0]!.raw, state.policy), h.fetches[0]!.bytes);
    const result = ToolResultSchema.parse(JSON.parse(Buffer.from(await profile.services.artifacts.get(attempt.resultArtifact!, state.policy)).toString('utf8')));
    assert.equal(result.collection?.checkpoint.id, attempt.readProgress!.head.id); assert.equal(result.usage?.transportCalls, 0);
    assert.equal(state.budget.used.toolCalls, 1); assert.equal(state.budget.used.modelCalls, 2);
    assert.equal((await readGeneratedAnswer(profile.services, state))!.text, '[합성 규칙 결과] 현재 근거 doc-current의 보존기간은 45일입니다.');
    const modelCalls = h.model.modelCalls.length;
    await f.close(profile); assert.deepEqual(h.closes, [profile.agentId]); assert.equal(opened.assembly.signal.aborted, true);
    const reopened = await f.open(ready.root, h.host);
    assert.equal(reopened.agentId, profile.agentId); assert.equal((await reopened.workflow.run(state.id, reopened.actor)).control.kind, 'complete');
    assert.equal(h.fetches.length, 1); assert.equal(h.model.modelCalls.length, modelCalls);
    const same = await reopened.runtime.state(state.id);
    assert.deepEqual(same.attempts[0], attempt); assert.deepEqual(same.budget, state.budget);
    assert.deepEqual(await reopened.services.artifacts.get(h.fetches[0]!.raw, same.policy), h.fetches[0]!.bytes);
  });
}

test('stored-only collection registration keeps its definition visible without granting new calls or core/skill permissions', async t => {
  const f = hostToolFixture(t), ready = f.create('stored-only'), h = collectionHost(); h.controls.storedOnly = true;
  h.controls.policy.allowedTools = ['fixture.read', 'core.evidence.get', 'core.guidance.find'];
  const profile = await f.open(ready.root, h.host), task = readTask();
  assert.equal(profile.contracts.get('fixture.read', '1')!.tool.availability, 'stored_only');
  assert.equal(profile.contracts.check(task, profile.policy), null);
  assert.equal(profile.contracts.checkExecution(task, profile.policy), 'tool_connection_required');
  assert.ok(profile.contracts.visible(profile.policy).some(definition => definition.id === task.toolId));
  assert.equal(profile.contracts.callable(profile.policy).some(definition => definition.id === task.toolId), false);
  assert.deepEqual(profile.policy.allowedTools, ['fixture.read', 'core.evidence.get']);
  assert.equal(profile.contracts.check(task, { ...profile.policy, allowedTools: [] }), 'tool_permission_denied');
  assert.equal(h.fetches.length, 0); assert.equal(h.model.modelCalls.length, 0);
});

test('a supplied collection list requires real assembly while omitted collection metadata preserves the legacy direct helper', async () => {
  const context: HostToolContext = { agentId: 'collection-owner', root: '/owned/collection', scope: 'agent:collection-owner' };
  let closes = 0;
  const lease: OpenedHostTools = { tools: [], policy: structuredClone(hostPolicy), limits: structuredClone(hostLimits), async close() { closes++; } };
  const legacy = await openRegisteredHostTools({ open: async () => lease }, context);
  assert.equal(Object.hasOwn(legacy, 'collectionTools'), false); await legacy.close(); assert.equal(closes, 1);
  await assert.rejects(openRegisteredHostTools({ open: async () => ({ ...lease, collectionTools: [] }) }, context), /agent_tool_registration_invalid/);
  assert.equal(closes, 2);
});

test('collection/plain identity and provider ownership conflicts fail before model open and close the acquired lease once', async t => {
  const changes: Array<(lease: OpenedHostTools) => void> = [
    lease => { Reflect.set(lease, 'tools', [{ definition: lease.collectionTools![0]!.definition, async execute() { assert.fail('unreachable'); } }]); },
    lease => { Reflect.set(lease, 'collectionTools', [lease.collectionTools![0], lease.collectionTools![0]]); },
    lease => { lease.collectionTools![0]!.definition.id = 'core.untrusted'; },
    lease => { lease.collectionTools![0]!.definition.provider = 'core'; },
    lease => { lease.collectionTools![0]!.definition.effect = 'write'; },
    lease => { Reflect.set(lease.collectionTools![0]!, 'availability', 'auto-online'); },
    lease => { Reflect.set(lease.collectionTools![0]!.source, 'fetch', null); },
    lease => {
      Reflect.set(lease, 'tools', []);
      Reflect.set(lease, 'providerSources', [{ provider: 'fixture', source: { async list() { assert.fail('conflicting listing must not run'); } } }]);
    },
  ];
  const f = hostToolFixture(t);
  for (const [index, edit] of changes.entries()) {
    const ready = f.create(`invalid-${index}`), h = collectionHost(); h.controls.edit = edit;
    await assert.rejects(openAgentTurnProfile(ready.root, { provider: 'registered' }, h.host), /agent_tool_registration_invalid/);
    assert.deepEqual(h.closes, [ready.identity.agentId]); assert.equal(h.model.modelOpens.length, 0); assert.equal(h.fetches.length, 0);
    await assert.rejects(h.opens[0]!.assembly.custody.state.get('closed-store'));
  }
});

test('a late collection schema compile failure returns no partial profile and preserves model/tools cleanup failures', async t => {
  const f = hostToolFixture(t), ready = f.create('late-schema'), h = collectionHost();
  const modelClose = new Error('collection_model_close'), toolsClose = new Error('collection_tools_close');
  h.model.controls.modelCloseError = modelClose; h.controls.closeError = toolsClose;
  h.controls.edit = lease => { lease.collectionTools![0]!.definition.outputSchema = { type: 'not-a-json-schema-type' }; };
  await assert.rejects(openAgentTurnProfile(ready.root, { provider: 'registered' }, h.host), error => {
    assert.ok(error instanceof AggregateError);
    const leaves = errorLeaves(error); assert.equal((leaves[0] as Error).message, 'invalid_tool_schema');
    assert.equal(leaves.filter(value => value === modelClose).length, 1); assert.equal(leaves.filter(value => value === toolsClose).length, 1);
    assert.equal(leaves.length, 3); return true;
  });
  assert.deepEqual(h.closes, [ready.identity.agentId]); assert.deepEqual(h.model.modelCloses, [ready.identity.agentId]);
  assert.equal(h.fetches.length, 0); assert.equal(h.model.modelCalls.length, 0);
  await assert.rejects(h.opens[0]!.assembly.custody.state.get('closed-store'));
});
