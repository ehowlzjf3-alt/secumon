import path from 'node:path';

type PathOperations = Pick<typeof path, 'resolve' | 'dirname' | 'basename'>;

export function storageRootParts(directory: string, paths: PathOperations = path): { parent: string; name: string } | null {
  const absolute = paths.resolve(directory); const parent = paths.dirname(absolute);
  if (parent === absolute) return null;
  return { parent, name: paths.basename(absolute) };
}

export function isJournalRecordPath(file: string, paths: Pick<PathOperations, 'basename'> = path): boolean {
  return /^\d{16}\.json$/.test(paths.basename(file));
}
