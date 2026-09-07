import type { Json } from '../../domain/model.js';

export const MCP_FIXTURE_PROTOCOL = '2026-07-28';
export const MCP_FIXTURE_IDS = ['good', 'partial', 'error', 'invalid', 'slow', 'crash', 'oversize'] as const;
export type McpFixtureId = typeof MCP_FIXTURE_IDS[number];
export type McpFixtureName = 'documents.read' | 'observations.read';
export const MCP_FIXTURE_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: { id: { type: 'string', enum: [...MCP_FIXTURE_IDS] } },
  required: ['id'], additionalProperties: false,
} satisfies Json;

function outputSchema(source: string) {
  return { type: 'object' as const, properties: {
    id: { type: 'string' }, source: { type: 'string', const: source },
    observedAt: { type: 'integer', minimum: 0 }, value: { type: 'number' }, complete: { type: 'boolean' },
  }, required: ['id', 'source', 'observedAt', 'value', 'complete'], additionalProperties: false } satisfies Json;
}

// These are the host's exact approved schema manifest, without remote descriptions or instructions.
export const MCP_FIXTURE_DOCUMENTS_TOOL = { name: 'documents.read', inputSchema: MCP_FIXTURE_INPUT_SCHEMA,
  outputSchema: outputSchema('doc-origin') };
export const MCP_FIXTURE_OBSERVATIONS_TOOL = { name: 'observations.read', inputSchema: MCP_FIXTURE_INPUT_SCHEMA,
  outputSchema: outputSchema('observation-origin') };
export const MCP_FIXTURE_TOOLS = [MCP_FIXTURE_DOCUMENTS_TOOL, MCP_FIXTURE_OBSERVATIONS_TOOL];

export interface McpFixtureRecord {
  id: string; source: string; observedAt: number; value: number; complete: boolean;
}
export function fixtureRecord(name: McpFixtureName, id: McpFixtureId): McpFixtureRecord {
  return { id, source: name === 'documents.read' ? 'doc-origin' : 'observation-origin',
    observedAt: 900, value: name === 'documents.read' ? 30 : 1, complete: id !== 'partial' };
}

export const MCP_FIXTURE_MODES = ['normal', 'paginated', 'duplicate', 'schema', 'loop',
  'list-change', 'list-change-during-discovery', 'late'] as const;
export type McpFixtureMode = typeof MCP_FIXTURE_MODES[number];
export interface McpFixtureAudit {
  sequence: number; event: 'start' | 'method' | 'call' | 'handler-ready' | 'response-delayed' | 'response-sent' | 'list-changed' | 'close' | 'error';
  method?: string; tool?: McpFixtureName; id?: McpFixtureId; cancelled?: boolean;
  reason?: string;
}
