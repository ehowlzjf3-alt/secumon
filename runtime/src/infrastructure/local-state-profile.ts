import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseContract } from '../application/contracts.js';

export type StateBackend = 'sqlite' | 'file-journal';
const schema = z.strictObject({ kind: z.literal('local-runtime-profile'), schemaVersion: z.literal(1), stateBackend: z.enum(['sqlite', 'file-journal']) });
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
function present(file: string) { try { lstatSync(file); return true; } catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error; } }
function read(file: string) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0) throw new Error('profile_metadata_invalid');
    return parseContract(schema, JSON.parse(readFileSync(fd).toString('utf8')));
  } finally { closeSync(fd); }
}
export function resolveStateBackend(directory: string, requested?: string): StateBackend {
  if (requested !== undefined && requested !== 'sqlite' && requested !== 'file-journal') throw new Error('invalid_state_backend');
  const file = join(directory, 'profile.json');
  const sqlite = present(join(directory, 'state.sqlite')); const journal = present(join(directory, 'state-journal'));
  if (sqlite && journal) throw new Error('profile_storage_ambiguous');
  const existing: StateBackend | undefined = sqlite ? 'sqlite' : journal ? 'file-journal' : undefined;
  let profile: z.infer<typeof schema> | null = null;
  try { profile = read(file); } catch (error) { if (errorCode(error) !== 'ENOENT') throw new Error('profile_metadata_invalid', { cause: error }); }
  if (!profile) {
    if (requested && existing && requested !== existing) throw new Error('profile_backend_mismatch');
    const value = { kind: 'local-runtime-profile' as const, schemaVersion: 1 as const, stateBackend: requested ?? existing ?? 'sqlite' };
    const candidate = join(directory, `${randomUUID()}.profile.pending`);
    const fd = openSync(candidate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { try { linkSync(candidate, file); } catch (error) { if (errorCode(error) !== 'EEXIST') throw error; } }
    finally { try { unlinkSync(candidate); } catch {} }
    profile = read(file);
  }
  if ((requested && requested !== profile.stateBackend) || (existing && existing !== profile.stateBackend)) throw new Error('profile_backend_mismatch');
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  return profile.stateBackend;
}
