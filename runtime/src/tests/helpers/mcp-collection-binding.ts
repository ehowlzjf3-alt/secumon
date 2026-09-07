import assert from 'node:assert/strict';
import type { ReadItem, ReadKey, ReadLimits } from '../../domain/read-collection.js';
import type { TaskSpec } from '../../domain/model.js';
import type { McpReadCollectionBinding } from '../../infrastructure/mcp-read-collections.js';
import { sha256 } from '../../infrastructure/digest.js';
import { MCPC_DOCUMENTS_TOOL, MCPC_OBSERVATIONS_TOOL, MCPC_QUERY_SCHEMA, type McpCollectionPayload } from './mcp-collection-fixture-contracts.js';

export type CollectionFamily = 'documents' | 'observations';
export function collectionBinding(family: CollectionFamily, limits: Partial<ReadLimits> = {}): McpReadCollectionBinding {
  const key = (id: string): ReadKey => ({ id, inputDigest: sha256(`${family}:${id}`) });
  const manifest = (task: TaskSpec) => {
    assert.ok(Array.isArray(task.input['ids']));
    return task.input['ids'].map(id => { assert.equal(typeof id, 'string'); return key(String(id)); }).sort((a, b) => a.id.localeCompare(b.id));
  };
  return { definition: { provider: 'fixture', id: 'fixture.collection', version: '1', description: 'Collect reviewed synthetic records',
    effect: 'read', destination: 'local', labels: ['synthetic'], inputSchema: MCPC_QUERY_SCHEMA, outputSchema: { type: 'object' },
    collection: { kind: family === 'documents' ? 'batch' : 'paged', limits: { maxPages: 5, maxItems: 20, maxCalls: 6,
      maxPageBytes: 65536, maxCheckpointBytes: 524288, pageSize: family === 'documents' ? 4 : 2, ...limits } } },
    remote: family === 'documents' ? MCPC_DOCUMENTS_TOOL : MCPC_OBSERVATIONS_TOOL,
    projectorId: `fixture-${family}-collection`, projectorVersion: '1', manifest,
    project(value, task, request) {
      const raw = value as unknown as McpCollectionPayload;
      assert.equal(raw.dataset, `${family}-v1`); assert.equal(raw.requestId, request.requestId);
      assert.equal(raw.cursor, request.cursor); const wanted = manifest(task);
      assert.equal(raw.total, wanted.length);
      const records = raw.records.map((item, index) => {
        assert.ok(wanted.some(key => key.id === item.id));
        if (request.retryItems) assert.ok(request.retryItems.some(key => key.id === item.id));
        const status: ReadItem['status'] = item.outcome === 'ok' ? 'success' : item.outcome;
        if (status === 'success' || status === 'partial') {
          assert.ok(item.record); assert.equal(item.error, null);
          assert.equal(item.record.sourceKey, `${family === 'documents' ? 'document' : 'observation'}:${item.id}`);
          assert.equal(item.record.rootSourceKey, family === 'documents' ? 'doc-origin' : 'observation-origin');
          assert.equal(item.record.recordRevision, '1'); assert.equal(item.record.observedAt, 900);
        } else assert.equal(item.record, null);
        return { ...key(item.id), status, output: item.record ? { value: item.record.value } : null,
          coverage: status === 'success' ? 'complete' as const : status === 'partial' ? 'partial' as const : 'unknown' as const,
          error: item.error, observations: status === 'success' ? [{ sourceId: item.record!.sourceKey, lineageId: item.record!.rootSourceKey,
            locator: `/value/structuredContent/records/${index}/record`, observedAt: item.record!.observedAt, coverage: 'complete' as const,
            facts: { value: item.record!.value, 'collection.record': item.id } }] : [] };
      });
      return { sourceSnapshot: raw.snapshot, cursor: raw.cursor, nextCursor: raw.nextCursor, exhausted: raw.done, totalItems: raw.total,
        expected: records.map(({ id, inputDigest }) => ({ id, inputDigest })), items: records };
    } };
}
