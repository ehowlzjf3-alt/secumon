import assert from 'node:assert/strict';
import type { ReadItem, ReadKey, ReadLimits } from '../../domain/read-collection.js';
import type { TaskSpec } from '../../domain/model.js';
import type { McpReadCollectionBinding } from '../../infrastructure/mcp-read-collections.js';
import { sha256 } from '../../infrastructure/digest.js';
import { MCPW_DOCUMENTS_TOOL, MCPW_OBSERVATIONS_TOOL, MCPW_QUERY_SCHEMA, MCPW_MAX_DELAY_MS,
  parseWaitFixturePage, parseWaitFixtureResult } from './mcp-wait-fixture-contracts.js';

export type WaitCollectionFamily = 'documents' | 'observations';
export function waitCollectionBinding(family: WaitCollectionFamily, limits: Partial<ReadLimits> = {}): McpReadCollectionBinding {
  const key = (id: string): ReadKey => ({ id, inputDigest: sha256(`${family}:${id}`) });
  const manifest = (task: TaskSpec) => {
    assert.ok(Array.isArray(task.input['ids']));
    return task.input['ids'].map(id => { assert.equal(typeof id, 'string'); return key(String(id)); }).sort((a, b) => a.id.localeCompare(b.id));
  };
  return { definition: { provider: 'fixture', id: 'fixture.collection', version: '2', description: 'Collect reviewed synthetic records with durable waits',
    effect: 'read', destination: 'local', labels: ['synthetic'], inputSchema: MCPW_QUERY_SCHEMA, outputSchema: { type: 'object' },
    collection: { kind: family === 'documents' ? 'batch' : 'paged', limits: { maxPages: 5, maxItems: 20, maxCalls: 6,
      maxPageBytes: 65536, maxCheckpointBytes: 524288, pageSize: family === 'documents' ? 4 : 2, ...limits } } },
    remote: family === 'documents' ? MCPW_DOCUMENTS_TOOL : MCPW_OBSERVATIONS_TOOL,
    projectorId: `fixture-${family}-wait-collection`, projectorVersion: '1', manifest,
    deferral: { id: `fixture-${family}-rate-limit`, version: '1', maxDelayMs: MCPW_MAX_DELAY_MS,
      project(value, _task, request) {
        const raw = parseWaitFixtureResult(value); const data = raw.structuredContent;
        assert.equal(data.dataset, `${family}-v1`); assert.equal(data.requestId, request.requestId); assert.equal(data.cursor, request.cursor);
        if (data.kind === 'page') return null;
        assert.equal(data.snapshot, request.snapshot);
        return { retryAfterMs: data.retryAfterMs };
      } },
    project(value, task, request, context) {
      const raw = parseWaitFixturePage(value);
      assert.equal(raw.dataset, `${family}-v1`); assert.equal(raw.requestId, request.requestId); assert.equal(raw.cursor, request.cursor);
      const wanted = manifest(task); assert.equal(raw.total, wanted.length);
      const records = raw.records.map((item, index) => {
        assert.ok(wanted.some(key => key.id === item.id));
        if (request.retryItems) assert.ok(request.retryItems.some(key => key.id === item.id));
        const status: ReadItem['status'] = item.outcome === 'ok' ? 'success' : 'error';
        if (item.record) {
          assert.equal(item.record.sourceKey, `${family === 'documents' ? 'document' : 'observation'}:${item.id}`);
          assert.equal(item.record.rootSourceKey, family === 'documents' ? 'doc-origin' : 'observation-origin');
          assert.equal(item.record.recordRevision, '1'); assert.equal(item.record.observedAt, 900);
        }
        return { ...key(item.id), status, output: item.record ? { value: item.record.value } : null,
          coverage: status === 'success' ? 'complete' as const : 'unknown' as const,
          error: item.error ? { code: item.error.code, retryable: item.error.retryable } : null,
          ...(item.error ? { retryAt: context.recordedAt + item.error.retryAfterMs } : {}),
          observations: item.record ? [{ sourceId: item.record.sourceKey, lineageId: item.record.rootSourceKey,
            locator: `/value/structuredContent/records/${index}/record`, observedAt: item.record.observedAt, coverage: 'complete' as const,
            facts: { value: item.record.value, 'collection.record': item.id } }] : [] };
      });
      return { sourceSnapshot: raw.snapshot, cursor: raw.cursor, nextCursor: raw.nextCursor, exhausted: raw.done, totalItems: raw.total,
        expected: records.map(({ id, inputDigest }) => ({ id, inputDigest })), items: records };
    } };
}
