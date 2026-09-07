import { closeSync, constants, openSync, realpathSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { Server, type CallToolResult, type JSONRPCMessage, type Tool, type Transport } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { MCPC_MODES, MCPC_PROTOCOL, MCPC_TOOLS, collectionFixturePage, parseCollectionFixtureArguments,
  type McpCollectionAudit, type McpCollectionMode, type McpCollectionName } from './mcp-collection-fixture-contracts.js';

const { values } = parseArgs({ options: { 'audit-file': { type: 'string' }, mode: { type: 'string', default: 'normal' },
  'delay-ms': { type: 'string', default: '750' } }, strict: true, allowPositionals: false });
const mode = values.mode as McpCollectionMode; const delayMs = Number(values['delay-ms']);
if (!MCPC_MODES.includes(mode) || !Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 5000) throw new Error('mcpc_fixture_arguments_invalid');

// TMPDIR is an explicit host fixture setting. No tool input can select a path or read a file.
function openAudit(path: string | undefined): number | null {
  if (path === undefined) return null;
  if (!isAbsolute(path)) throw new Error('mcpc_audit_path_invalid');
  const parent = realpathSync(dirname(resolve(path))); const root = realpathSync(tmpdir()); const tail = relative(root, parent);
  if (tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw new Error('mcpc_audit_path_invalid');
  return openSync(join(parent, basename(path)), constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
}
const fd = openAudit(values['audit-file']); let sequence = 0; let closed = false;
function audit(entry: Omit<McpCollectionAudit, 'sequence' | 'pid'>): void {
  if (fd !== null && !closed) writeSync(fd, `${JSON.stringify({ sequence: ++sequence, pid: process.pid, ...entry })}\n`);
}
function finish(reason: string): void {
  if (closed) return;
  audit({ event: 'close', reason }); closed = true; if (fd !== null) closeSync(fd);
}
const delay = () => new Promise<void>(resolve => setTimeout(resolve, delayMs));
const key = (id: string | number) => `${typeof id}:${id}`;
type CallAudit = Omit<McpCollectionAudit, 'sequence' | 'pid' | 'event'>;
const requests = new Map<string, CallAudit>();
const base = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 65536 });
const methods = new Set(['server/discover', 'discover', 'initialize', 'ping', 'tools/list', 'tools/call', 'subscriptions/listen',
  'subscriptions/unsubscribe', 'notifications/initialized', 'notifications/cancelled']);
const transport: Transport = {
  async start() {
    base.onclose = () => transport.onclose?.(); base.onerror = error => transport.onerror?.(error);
    base.onmessage = message => {
      if ('method' in message) audit({ event: 'method', method: methods.has(message.method) ? message.method : 'other' });
      transport.onmessage?.(message);
    };
    await base.start();
  },
  async send(message: JSONRPCMessage) {
    const id = 'id' in message && !('method' in message) ? message.id : undefined;
    const call = id === undefined ? undefined : requests.get(key(id));
    if (call && mode === 'late') { audit({ event: 'response-delayed', ...call }); await delay(); }
    await base.send(message);
    if (call && id !== undefined) { audit({ event: 'response-sent', ...call }); requests.delete(key(id)); }
  },
  async close() { await base.close(); },
};
const server = new Server({ name: 'secumon-synthetic-collection-fixture', version: '1' }, {
  capabilities: { tools: {} }, supportedProtocolVersions: [MCPC_PROTOCOL],
});
const tools: Tool[] = MCPC_TOOLS.map(tool => ({ ...structuredClone(tool), description: 'Fixed synthetic collection records.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }));
server.setRequestHandler('tools/list', async request => {
  if (request.params?.cursor !== undefined) throw new Error('mcpc_listing_cursor_invalid');
  return { tools };
});
const failure = (code: string): CallToolResult => ({ resultType: 'complete', isError: true,
  content: [{ type: 'text', text: code }] });
server.setRequestHandler('tools/call', async (request, ctx) => {
  const name = request.params.name;
  if (name !== 'documents.batch' && name !== 'observations.page') return failure('mcpc_tool_unavailable');
  let args;
  try { args = parseCollectionFixtureArguments(request.params.arguments); } catch { return failure('mcpc_arguments_invalid'); }
  const call: CallAudit & { tool: McpCollectionName } = { tool: name, query: args.query, requestId: args.read.requestId,
    retryIds: args.read.retryIds, snapshot: args.read.snapshot, cursor: args.read.cursor };
  requests.set(key(ctx.mcpReq.id), call); audit({ event: 'call', ...call });
  if (mode === 'error' || mode === 'rate-limit') {
    audit({ event: 'handler-ready', ...call, returnedIds: [] }); return failure(mode === 'rate-limit' ? 'mcpc_rate_limited' : 'mcpc_temporary');
  }
  let payload;
  try { payload = collectionFixturePage(name, args, mode); }
  catch { audit({ event: 'handler-ready', ...call, returnedIds: [] }); return failure('mcpc_request_unavailable'); }
  const detail = { ...call, returnedIds: payload.records.map(record => record.id) };
  requests.set(key(ctx.mcpReq.id), detail); audit({ event: 'handler-ready', ...detail });
  return server.projectCallToolResult({ resultType: 'complete', content: [{ type: 'text', text: 'synthetic collection records' }],
    structuredContent: JSON.parse(JSON.stringify(payload)) as Record<string, unknown> }, tools.find(tool => tool.name === name)!.outputSchema);
});
audit({ event: 'start' });
const handle = serveStdio(() => server, { legacy: 'reject', transport, maxSubscriptions: 8,
  onerror: () => audit({ event: 'error', reason: 'sdk-transport-error' }) });
let stopping = false;
async function stop(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true; try { await handle.close(); } finally { finish(reason); process.exit(0); }
}
process.stdin.once('end', () => { void stop('stdin-ended'); });
process.once('SIGTERM', () => { void stop('sigterm'); });
process.once('SIGINT', () => { void stop('sigint'); });
process.once('exit', () => finish('process-exit'));
