import { basename, dirname } from 'node:path';
import { lifecycleFail } from './agent-lifecycle-files.js';
import { openProfileMutationScope, syncProfileDirectory } from './agent-profile-files.js';
import { windowsPathInfo, windowsProfileFiles, windowsProfileNames, windowsProfilePath } from './windows-profile-files.js';

export const windowsLeaseRoot = (path: string) => windowsProfilePath(path);
export const windowsLeaseExists = (path: string) => windowsPathInfo(path) !== null;
export const windowsLeaseNames = (path: string) => windowsProfileNames(path, 65536);
/** Compare the current original, then delete only the native held regular file with those exact bytes. */
export function removeWindowsLifecycleLease(root: string, path: string, expected: unknown): void {
  const scope = openProfileMutationScope(root, []), files = windowsProfileFiles();
  try {
    const parent = scope.directory(dirname(path), 'private'); if (!parent) return lifecycleFail('lifecycle_lease_changed');
    const bytes = files.readStableRegularFile(parent, basename(path), { maximum: 65536, access: 'private' });
    let actual: unknown;
    try { actual = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { return lifecycleFail('lifecycle_lease_changed'); }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return lifecycleFail('lifecycle_lease_changed');
    scope.check();
    if (!files.handle(parent).removeRegular(basename(path), bytes)) return lifecycleFail('lifecycle_lease_changed');
    syncProfileDirectory(dirname(path), scope); scope.check();
  } finally { scope.close(); }
}
