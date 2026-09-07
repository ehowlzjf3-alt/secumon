import { closeSync, constants, openSync, realpathSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { Server, type CallToolResult, type JSONRPCMessage, type Tool, type Transport } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { MCP_FIXTURE_IDS, MCP_FIXTURE_MODES, MCP_FIXTURE_PROTOCOL, MCP_FIXTURE_TOOLS, fixtureRecord,
  type McpFixtureAudit, type McpFixtureId, type McpFixtureMode, type McpFixtureName } from './mcp-fixture-contracts.js';

const { values } = parseArgs({ options: { 'audit-file': { type: 'string' }, mode: { type: 'string', default: 'normal' },
  'delay-ms': { type: 'string', default: '750' }, 'document-value': { type: 'string', default: '30' },
  'audit-process': { type: 'boolean', default: false } }, strict: true, allowPositionals: false });
const mode = values.mode as McpFixtureMode; const delayMs = Number(values['delay-ms']); const documentValue = Number(values['document-value']);
if (!MCP_FIXTURE_MODES.includes(mode) || !Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 5000 ||
  !Number.isSafeInteger(documentValue) || documentValue < 0 || documentValue > 1_000_000) {
  throw new Error('mcp_fixture_arguments_invalid');
}

// The fixture only writes this host-selected temporary audit file; no tool can select a path.
function openAudit(path: string | undefined): number | null {
  if (path === undefined) return null;
  if (!isAbsolute(path)) throw new Error('mcp_fixture_audit_path_invalid');
  const parent = realpathSync(dirname(resolve(path)));
  const roots = [realpathSync(tmpdir())];
  if (!roots.some(root => { const tail = relative(root, parent); return tail === '' || (!tail.startsWith(`..${sep}`) && tail !== '..' && !isAbsolute(tail)); })) {
    throw new Error('mcp_fixture_audit_path_invalid');
  }
  return openSync(join(parent, basename(path)), constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
}
const auditFd = openAudit(values['audit-file']); let sequence = 0; let closed = false;
function audit(entry: Omit<McpFixtureAudit, 'sequence'>): void {
  if (auditFd !== null && !closed) writeSync(auditFd, `${JSON.stringify({ sequence: ++sequence, ...entry,
    ...(values['audit-process'] && (entry.event === 'start' || entry.event === 'close') ? { pid: process.pid } : {}) })}\n`);
}
function finish(reason: string): void {
  if (closed) return;
  audit({ event: 'close', reason }); closed = true;
  if (auditFd !== null) closeSync(auditFd);
}
const delay = () => new Promise<void>(resolve => setTimeout(resolve, delayMs));
const callRequests = new Map<string, { tool: McpFixtureName; id: McpFixtureId }>();
const key = (id: string | number) => `${typeof id}:${id}`;
const base = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 65536 });
const methods = new Set(['discover', 'initialize', 'ping', 'tools/list', 'tools/call', 'subscriptions/listen', 'subscriptions/unsubscribe',
  'notifications/initialized', 'notifications/cancelled']);

// Faults delay only SDK-encoded responses, preserving the official framing and negotiated envelope.
const transport: Transport = {
  async start() {
    base.onclose = () => transport.onclose?.();
    base.onerror = error => transport.onerror?.(error);
    base.onmessage = message => {
      if ('method' in message) audit({ event: 'method', method: methods.has(message.method) ? message.method : 'other' });
      transport.onmessage?.(message);
    };
    await base.start();
  },
  async send(message: JSONRPCMessage) {
    const responseId = 'id' in message && !('method' in message) ? message.id : undefined;
    const call = responseId !== undefined ? callRequests.get(key(responseId)) : undefined;
    if (call && mode === 'late') { audit({ event: 'response-delayed', ...call }); await delay(); }
    await base.send(message);
    if (call && responseId !== undefined) { audit({ event: 'response-sent', ...call }); callRequests.delete(key(responseId)); }
  },
  async close() { await base.close(); },
};
const server = new Server({ name: 'secumon-synthetic-read-fixture', version: '1' }, {
  capabilities: { tools: { listChanged: true } }, supportedProtocolVersions: [MCP_FIXTURE_PROTOCOL],
});
const tools: Tool[] = MCP_FIXTURE_TOOLS.map(tool => ({ ...structuredClone(tool), description: 'Fixed synthetic read fixture.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }));
let changed = false;
async function listChanged(): Promise<void> {
  if (changed) return;
  changed = true; await server.sendToolListChanged(); audit({ event: 'list-changed' });
}

server.setRequestHandler('tools/list', async request => {
  if (mode === 'list-change-during-discovery') await listChanged();
  const cursor = request.params?.cursor;
  if (mode === 'paginated' || mode === 'loop') {
    if (cursor === undefined) return { tools: [tools[0]!], nextCursor: 'fixture-page-2' };
    if (cursor !== 'fixture-page-2') throw new Error('mcp_fixture_cursor_invalid');
    return mode === 'loop' ? { tools: [tools[1]!], nextCursor: 'fixture-page-2' } : { tools: [tools[1]!] };
  }
  if (cursor !== undefined) throw new Error('mcp_fixture_cursor_invalid');
  if (mode === 'duplicate') return { tools: [tools[0]!, tools[0]!, tools[1]!] };
  if (mode === 'schema') return { tools: [{ ...tools[0]!, inputSchema: { type: 'object',
    properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false } }, tools[1]!] };
  return { tools };
});

server.setRequestHandler('tools/call', async (request, ctx) => {
  const name = request.params.name; const input = request.params.arguments;
  if ((name !== 'documents.read' && name !== 'observations.read') || !input || Object.keys(input).length !== 1 ||
    typeof input['id'] !== 'string' || !MCP_FIXTURE_IDS.includes(input['id'] as McpFixtureId)) {
    return { resultType: 'complete', isError: true, content: [{ type: 'text', text: 'mcp_fixture_input_invalid' }] };
  }
  const id = input['id'] as McpFixtureId; const call: { tool: McpFixtureName; id: McpFixtureId } = { tool: name, id };
  callRequests.set(key(ctx.mcpReq.id), call); audit({ event: 'call', ...call });
  if (mode === 'list-change') await listChanged();
  if (id === 'crash') { finish('intentional-fixture-crash'); process.exit(23); }
  if (id === 'slow' && mode !== 'late') await delay();
  audit({ event: 'handler-ready', ...call, cancelled: ctx.mcpReq.signal.aborted });
  let result: CallToolResult;
  if (id === 'error') result = { resultType: 'complete', isError: true, content: [{ type: 'text', text: 'synthetic_fixture_error' }] };
  else {
    const original = fixtureRecord(name, id); const record = name === 'documents.read' ? { ...original, value: documentValue } : original;
    result = { resultType: 'complete', content: [{ type: 'text', text: id === 'oversize' ? 'x'.repeat(2 * 1024 * 1024) : 'synthetic fixture record' }],
      structuredContent: id === 'invalid' ? { ...record, value: 'invalid-number' } : { ...record } };
  }
  // Low-level Server intentionally leaves per-tool schema faults for the host adapter to reject.
  return server.projectCallToolResult(result, tools.find(tool => tool.name === name)!.outputSchema);
});

audit({ event: 'start' });
const handle = serveStdio(() => server, { legacy: 'reject', transport, maxSubscriptions: 8,
  onerror: () => audit({ event: 'error', reason: 'sdk-transport-error' }) });
let stopping = false;
async function stop(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  try { await handle.close(); } finally { finish(reason); process.exit(0); }
}
process.stdin.once('end', () => { void stop('stdin-ended'); });
process.once('SIGTERM', () => { void stop('sigterm'); });
process.once('SIGINT', () => { void stop('sigint'); });
process.once('exit', () => finish('process-exit'));
