import type { ConversationWorkQuery } from '../application/ports.js';
import { sha256 } from './digest.js';

function scope(adapter: string, query: ConversationWorkQuery): string {
  return `${adapter}:${sha256(JSON.stringify([query.tenantId, query.principalId, query.channel, query.conversationId]))}:`;
}
export function encodeStateQueryCursor(adapter: string, query: ConversationWorkQuery, key: string): string {
  return `${scope(adapter, query)}${Buffer.from(JSON.stringify(key)).toString('base64url')}`;
}
export function decodeStateQueryCursor(adapter: string, query: ConversationWorkQuery): string | null {
  if (query.cursor === undefined) return null;
  const prefix = scope(adapter, query);
  try {
    if (!query.cursor.startsWith(prefix)) throw new Error();
    const encoded = query.cursor.slice(prefix.length); const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new Error();
    const key: unknown = JSON.parse(bytes.toString('utf8'));
    if (typeof key !== 'string' || !key.length || key.length > 256) throw new Error();
    return key;
  } catch { throw new Error('invalid_state_query'); }
}
