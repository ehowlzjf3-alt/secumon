import { createHash, randomUUID } from 'node:crypto';
import type { Digester, IdGenerator } from '../application/ports.js';
import type { Json } from '../domain/model.js';

export function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k]!)}`).join(',')}}`;
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('invalid_json_number');
  return JSON.stringify(value);
}
export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export class Sha256Digester implements Digester { digest(value: Json) { return sha256(canonical(value)); } }
export class RandomIds implements IdGenerator { next(prefix: string) { return `${prefix}-${randomUUID()}`; } }
