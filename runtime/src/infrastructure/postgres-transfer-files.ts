import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { TransferPageSchema, transferPageDigest, type TransferPage } from './postgres-transfer.js';
import { openProfileMutationScope, profileDirectory, publishProfileBytes, readProfileBytes, syncProfileDirectory } from './agent-profile-files.js';
import { lifecycleFail } from './agent-lifecycle-files.js';

export const postgresTransferFileLimit = 4 * 1024 ** 2;
export interface PostgresTransferFile { id: string; file: string; bytes: number; sha256: string }
function fileName(id: string) {
  if (!/^page-[0-9]{8}$/.test(id) || id === 'page-00000000') lifecycleFail('postgres_transfer_page_id_invalid');
  return `${id}.json`;
}
function parse(bytes: Buffer): TransferPage {
  const page = TransferPageSchema.parse(JSON.parse(bytes.toString('utf8'))); transferPageDigest(page); return page;
}
function identity(id: string, bytes: Buffer): PostgresTransferFile {
  return { id, file: fileName(id), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
function closeScope(scope: ReturnType<typeof openProfileMutationScope>, failure?: { error: unknown }) {
  try { scope.close(); } catch (error) {
    if (failure) throw new AggregateError([failure.error, error], 'postgres_transfer_file_cleanup_failed'); throw error;
  }
}
/** Root already exists and is host-owned. A page is published once; identical retries only resync it. */
export async function writePostgresTransferPage(input: string, id: string, raw: TransferPage): Promise<PostgresTransferFile> {
  const root = resolve(input), name = fileName(id), page = TransferPageSchema.parse(raw);
  const expected = transferPageDigest(page);
  const bytes = Buffer.from(JSON.stringify(page));
  if (bytes.length > postgresTransferFileLimit) lifecycleFail('postgres_transfer_page_too_large');
  const scope = openProfileMutationScope(root, []);
  let failure: { error: unknown } | undefined;
  try {
    if (!profileDirectory(root, false, true, scope)) lifecycleFail('postgres_transfer_directory_missing');
    const path = join(root, name);
    if (!readProfileBytes(path, postgresTransferFileLimit, true, scope)) publishProfileBytes(path, bytes, false, scope);
    const saved = readProfileBytes(path, postgresTransferFileLimit, true, scope);
    if (!saved || transferPageDigest(parse(saved)) !== expected) lifecycleFail('postgres_transfer_page_conflict');
    syncProfileDirectory(root, scope); scope.check();
    return identity(id, saved);
  } catch (error) { failure = { error }; throw error; }
  finally { closeScope(scope, failure); }
}
export async function inspectPostgresTransferPage(input: string, id: string): Promise<{ page: TransferPage; file: PostgresTransferFile }> {
  const root = resolve(input), scope = openProfileMutationScope(root, []);
  let failure: { error: unknown } | undefined;
  try {
    if (!profileDirectory(root, false, true, scope)) lifecycleFail('postgres_transfer_directory_missing');
    const bytes = readProfileBytes(join(root, fileName(id)), postgresTransferFileLimit, true, scope);
    if (!bytes) return lifecycleFail('postgres_transfer_page_missing');
    const page = parse(bytes); scope.check(); return { page, file: identity(id, bytes) };
  } catch (error) { failure = { error }; throw error; }
  finally { closeScope(scope, failure); }
}
export async function readPostgresTransferPage(root: string, id: string): Promise<TransferPage> {
  return (await inspectPostgresTransferPage(root, id)).page;
}
