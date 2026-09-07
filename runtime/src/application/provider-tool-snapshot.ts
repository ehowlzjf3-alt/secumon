import type { Tool } from './ports.js';
import { snapshotTool, ToolContracts, validProvider } from './tool-contracts.js';

export interface ProviderToolPage {
  revision: string;
  tools: Tool[];
  nextCursor: string | null;
}
export interface ProviderToolSource {
  /** null nextCursor certifies a complete listing at one provider revision. Partial failure must reject. */
  list(input: { cursor: string | null; signal: AbortSignal }): Promise<ProviderToolPage>;
}
export interface ProviderRefreshOptions {
  signal: AbortSignal;
  maxPages?: number;
  maxTools?: number;
  maxBytes?: number;
}

function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error('invalid_provider_limits');
  return result;
}
function bytes(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value)).length; }
  catch { throw new Error('invalid_provider_page'); }
}
function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('provider_refresh_cancelled');
}
async function readPage(source: ProviderToolSource, cursor: string | null, signal: AbortSignal): Promise<ProviderToolPage> {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error('provider_refresh_cancelled')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    // Promise handlers consume late completion/rejection even when a source ignores cancellation.
    Promise.resolve().then(() => { cancelled(signal); return source.list({ cursor, signal }); }).then(
      page => { cleanup(); if (signal.aborted) reject(new Error('provider_refresh_cancelled')); else resolve(page); },
      error => { cleanup(); reject(new Error(signal.aborted ? 'provider_refresh_cancelled' : 'provider_listing_failed', { cause: error })); },
    );
  });
}

/** Stages bounded pages and publishes exactly once. An incomplete listing never retires a registered tool. */
export async function refreshProviderTools(contracts: ToolContracts, provider: string, source: ProviderToolSource, options: ProviderRefreshOptions) {
  if (!validProvider(provider) || !source || typeof source.list !== 'function') throw new Error('invalid_provider_source');
  const maxPages = limit(options.maxPages, 100, 1000); const maxTools = limit(options.maxTools, 1000, 10000);
  const maxBytes = limit(options.maxBytes, 4 * 1024 * 1024, 64 * 1024 * 1024); const signal = options.signal;
  const currentSource = { list: source.list.bind(source) };
  cancelled(signal);
  const expectedEpoch = contracts.providerEpoch(provider); const staged: Tool[] = []; const keys = new Set<string>();
  const cursors = new Set<string>(); let cursor: string | null = null; let sourceRevision: string | null = null; let pages = 0; let byteLength = 0;
  do {
    if (pages >= maxPages) throw new Error('provider_page_limit');
    const page = await readPage(currentSource, cursor, signal); cancelled(signal); pages++;
    if (!page || typeof page !== 'object' || Array.isArray(page) || Object.keys(page).sort().join(',') !== 'nextCursor,revision,tools' ||
        typeof page.revision !== 'string' || !page.revision.length || page.revision.length > 256 || !Array.isArray(page.tools) ||
        (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor.length || bytes(page.nextCursor) > 4096))) throw new Error('invalid_provider_page');
    if (sourceRevision !== null && page.revision !== sourceRevision) throw new Error('provider_revision_mixed');
    sourceRevision = page.revision;
    if (staged.length + page.tools.length > maxTools) throw new Error('provider_tool_limit');
    byteLength += bytes({ revision: page.revision, tools: page.tools.map(tool => tool?.definition), nextCursor: page.nextCursor });
    if (byteLength > maxBytes) throw new Error('provider_byte_limit');
    for (const candidate of page.tools) {
      const tool = snapshotTool(candidate); const d = tool.definition;
      if (d.provider !== provider) throw new Error('provider_namespace_mismatch');
      const key = JSON.stringify([d.id, d.version]);
      if (keys.has(key)) throw new Error('duplicate_or_invalid_tool');
      keys.add(key); staged.push(tool);
    }
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (cursors.has(cursor)) throw new Error('provider_cursor_cycle');
      cursors.add(cursor);
    }
  } while (cursor !== null);
  cancelled(signal);
  const snapshot = contracts.replaceProvider(provider, staged, { expectedEpoch, sourceRevision: sourceRevision!, signal });
  return { ...snapshot, revision: contracts.revision, pages, byteLength };
}
