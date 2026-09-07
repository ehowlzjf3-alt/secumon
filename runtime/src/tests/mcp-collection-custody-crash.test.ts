import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkState } from '../domain/model.js';
import { toolExecution, summarizeToolExecution } from '../application/tool-execution-usage.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { assertMcpPeersStopped } from './mcp-agent-profile-helper.js';
import { collectionCrashAudit, runCollectionCrashWorker } from './mcp-collection-custody-crash-fixture.js';

function originalAttempt(state: WorkState, id: string) {
  assert.equal(state.attempts.length, 1); const attempt = state.attempts[0]!; assert.equal(attempt.id, id); return attempt;
}
const measured = (transportCalls: number | null) => toolExecution('invoked', {
  transportCalls, internalOperations: null, imageBytes: null, waitMs: null,
});

for (const backend of ['sqlite', 'file-journal'] as const) for (const stage of ['raw', 'response', 'usage'] as const) {
  test(`${backend}: actual collection SIGKILL after ${stage} resumes only original receipted usage through stored-only registration`, { timeout: 60000 }, async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-collection-custody-crash-')));
    try {
      const stopped = await runCollectionCrashWorker(base, backend, stage, 'crash');
      const original = originalAttempt(stopped.state, stopped.attemptId), responseId = stopped.responseCommandId;
      assert.equal(stopped.state.status, 'cancelled'); assert.equal(stopped.state.statusReason, 'stop after actual collection SDK reply');
      assert.deepEqual(stopped.state.policy.allowedLabels, []); assert.equal(original.status, 'running');
      assert.equal(original.owner, stopped.runtimeOwner); assert.equal(original.startedAt, 1000); assert.equal(original.leaseUntil, 6000);
      assert.equal(original.resultArtifact, null); assert.equal(original.resultId, null); assert.equal(original.adopted, false);
      assert.deepEqual(stopped.state.evidence, []); assert.equal(stopped.state.modelCalls.length, 0);
      assert.equal(stopped.state.budget.used.toolCalls, 1); assert.equal(stopped.state.budget.reservedToolCalls, 0);
      assert.equal(stopped.state.budget.limits.toolCalls, 1); assert.equal(stopped.state.budget.used.modelCalls, 0);
      assert.equal(stopped.counters.calls, 1); assert.equal(stopped.counters.discoveries, 1); assert.equal(stopped.counters.captures, 1);
      assert.equal(stopped.counters.fetches, 1); assert.equal(stopped.counters.projections, 0); assert.equal(stopped.counters.rawPuts, 1);
      assert.ok(stopped.counters.manifests > 0); assert.ok(stopped.raw);
      for (const saved of [stopped.head, stopped.raw]) {
        assert.equal(createHash('sha256').update(saved.text).digest('hex'), saved.ref.sha256);
        assert.equal(Buffer.byteLength(saved.text), saved.ref.byteLength);
      }
      assert.deepEqual(original.readProgress!.head, stopped.head.ref); assert.equal(stopped.head.checkpoint.calls.length, 1);
      const call = stopped.head.checkpoint.calls[0]!;
      assert.equal(call.attemptId, original.id); assert.equal(call.status, 'intent'); assert.equal(call.response, null);
      assert.equal(stopped.head.checkpoint.phase, 'running'); assert.equal(stopped.head.checkpoint.collection.pages.length, 0);
      assert.equal(responseId, `mcp-page:${original.id}:${call.request.requestId}`);
      const envelope = JSON.parse(stopped.raw.text) as { kind: string; workId: string; attemptId: string; request: unknown;
        intentHead: unknown; recordedAt: number; transportCalls: number; failure: unknown };
      assert.equal(envelope.kind, 'mcp_collection_response'); assert.equal(envelope.workId, stopped.workId);
      assert.equal(envelope.attemptId, original.id); assert.deepEqual(envelope.request, call.request); assert.deepEqual(envelope.intentHead, stopped.head.ref);
      assert.equal(envelope.recordedAt, 1000, 'decoded time precedes the 1100 authority-change/commit clock');
      assert.equal(envelope.transportCalls, 1); assert.equal(envelope.failure, null);
      const dispatch = stopped.receipts[`dispatch:${original.id}`], intent = stopped.receipts[`read:${original.id}:${stopped.head.ref.id}`];
      assert.ok(dispatch && intent); assert.deepEqual(dispatch.state.policy.allowedLabels, ['synthetic']);
      assert.deepEqual(dispatch.state.goal, stopped.state.goal); assert.deepEqual(intent.state.policy, dispatch.state.policy);
      assert.equal(stopped.receipts[responseId] !== null, stage !== 'raw');
      assert.equal(stopped.state.artifacts.some(ref => ref.id === stopped.raw!.ref.id), stage !== 'raw');
      assert.deepEqual(original.execution, stage === 'usage' ? measured(1) : toolExecution('unreported'));
      const responseEvent = stopped.events.find(event => event.commandId === responseId);
      if (stage === 'raw') assert.equal(responseEvent, undefined);
      else {
        assert.ok(responseEvent); const payload = responseEvent.data['payload'];
        assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
        assert.deepEqual(payload['artifact'], stopped.raw.ref);
        assert.deepEqual(payload['custody'], { schemaVersion: 1, outcome: 'returned', transportCalls: 1, recordedAtKind: 'decoded_response' });
      }
      const auditBefore = collectionCrashAudit(base);
      assert.equal(auditBefore.filter(row => row.event === 'start').length, 1);
      assert.equal(auditBefore.filter(row => row.event === 'call').length, 1);
      assert.equal(auditBefore.filter(row => row.event === 'response-sent' && row.requestId === call.request.requestId).length, 1);
      assert.ok(auditBefore.some(row => row.event === 'close' && row.pid === stopped.peerPid && row.reason === 'stdin-ended'));

      // Only work/attempt identity is passed into the fresh process, never the test-observed orphan ref or path.
      const recovered = await runCollectionCrashWorker(base, backend, stage, 'recover', original.id);
      assert.notEqual(recovered.pid, stopped.pid); assert.notEqual(recovered.runtimeOwner, original.owner);
      assert.equal(recovered.agentId, stopped.agentId); assert.deepEqual(recovered.before, stopped.state);
      const after = originalAttempt(recovered.state, original.id), expected = measured(stage === 'raw' ? null : 1);
      const normalized = structuredClone(recovered.state); normalized.revision = stopped.state.revision; normalized.updatedAt = stopped.state.updatedAt;
      normalized.attempts[0]!.execution = structuredClone(original.execution!);
      assert.deepEqual(normalized, stopped.state, 'only the same original execution measurement and its transaction revision/time may change');
      assert.deepEqual(after.execution, expected); assert.deepEqual(recovered.returned, recovered.state);
      assert.equal(after.owner, original.owner); assert.equal(after.startedAt, original.startedAt); assert.equal(after.leaseUntil, original.leaseUntil);
      assert.deepEqual(after.readProgress, original.readProgress); assert.deepEqual(recovered.head, stopped.head);
      assert.deepEqual(recovered.task, stopped.task); assert.deepEqual(recovered.state.policy, stopped.state.policy);
      assert.deepEqual(recovered.state.budget, stopped.state.budget); assert.deepEqual(recovered.state.evidence, []);
      assert.equal(after.resultArtifact, null); assert.equal(after.resultId, null); assert.equal(after.adopted, false);
      assert.deepEqual(summarizeToolExecution(recovered.state).transportCalls,
        stage === 'raw' ? { measured: 0, unknown: 1 } : { measured: 1, unknown: 0 });
      const usages = recovered.events.filter(event => event.type === 'tool_execution_usage_recorded');
      assert.equal(usages.length, 1); assert.ok(recovered.receipts[usages[0]!.commandId]);
      assert.equal(recovered.events.filter(event => ['result_received', 'result_settled', 'read_response_reconciled'].includes(event.type)).length, 0);
      for (const [id, receipt] of Object.entries(stopped.receipts)) assert.deepEqual(recovered.receipts[id], receipt, `immutable original receipt ${id}`);
      if (stage === 'raw') {
        assert.equal(recovered.raw, null); assert.equal(recovered.receipts[responseId], null);
        assert.equal(recovered.counters.accountingReads.includes(stopped.raw.ref.id), false, 'the orphan raw is never a recovery input');
        assert.equal(recovered.state.artifacts.some(ref => ref.id === stopped.raw!.ref.id), false);
        // Out-of-band evidence after worker exit: inspect this exact observed orphan, without enumeration or promotion.
        const profile = new FileAgentProfileStore(join(base, 'engine')).inspect(join(base, 'agent'));
        assert.equal(profile.status, 'ready'); assert.ok(profile.status === 'ready');
        const artifacts = new FileArtifactStore(profile.paths.artifacts);
        assert.equal(Buffer.from(await artifacts.get(stopped.raw.ref, dispatch.state.policy)).toString('utf8'), stopped.raw.text);
      } else {
        assert.deepEqual(recovered.raw, stopped.raw); assert.ok(recovered.counters.accountingReads.includes(stopped.raw.ref.id));
        if (stage === 'usage') { assert.deepEqual(recovered.state, stopped.state); assert.deepEqual(recovered.events, stopped.events); }
      }
      assert.equal(recovered.counters.calls, 0); assert.equal(recovered.counters.discoveries, 0); assert.equal(recovered.counters.captures, 0);
      assert.equal(recovered.counters.fetches, 0); assert.equal(recovered.counters.projections, 0); assert.equal(recovered.counters.manifests, 0);
      assert.equal(recovered.counters.rawPuts, 0);
      assert.deepEqual(collectionCrashAudit(base), auditBefore, 'stored-only accounting does not reopen a peer or transmit');
      assertMcpPeersStopped(join(base, 'peer.jsonl'));
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}
