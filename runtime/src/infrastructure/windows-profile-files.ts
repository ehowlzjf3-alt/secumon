import { win32 } from 'node:path';
import { FileBoundaryFault, hostMetadataFiles } from './host-metadata-files.js';
import { WindowsMetadataFiles, windowsAbsolutePath } from './windows-metadata-files.js';
import type { WindowsPathInfo } from './windows-file-addon.js';

export function windowsProfileFiles(): WindowsMetadataFiles {
  const files = hostMetadataFiles();
  if (!(files instanceof WindowsMetadataFiles)) throw new FileBoundaryFault('unsupported_platform', 'directory');
  return files;
}
export function windowsProfilePath(input: string, allowMissing = false): string {
  const path = windowsAbsolutePath(win32.resolve(input));
  windowsCanonicalPath(path);
  if (!allowMissing && windowsPathInfo(path, false)?.kind !== 'directory') throw new FileBoundaryFault('missing', 'directory');
  return path;
}
/** Canonicalize through retained native ancestors; no Node stat or realpath proof. */
export function windowsCanonicalPath(path: string): string {
  windowsAbsolutePath(path); const files = windowsProfileFiles();
  let current = path; const missing: string[] = [];
  for (;;) {
    const ref = files.inspectDirectory(current, 'traverse');
    if (ref) {
      try { return win32.join(files.handle(ref).check().path, ...missing.reverse()); }
      finally { files.closeDirectory(ref); }
    }
    const parent = win32.dirname(current);
    if (parent === current) throw new FileBoundaryFault('missing', 'directory');
    missing.push(win32.basename(current)); current = parent;
  }
}
export function windowsPathInfo(path: string, privateAccess = true): WindowsPathInfo | null {
  windowsAbsolutePath(path); const files = windowsProfileFiles();
  const parent = win32.dirname(path);
  if (parent === path) {
    const ref = files.inspectDirectory(path, privateAccess ? 'private' : 'traverse'); if (!ref) return null;
    try { const info = files.handle(ref).check(); return { identity: info.identity, kind: 'directory', bytes: '0', changeToken: info.changeToken }; }
    finally { files.closeDirectory(ref); }
  }
  const ref = files.inspectDirectory(parent, 'traverse'); if (!ref) return null;
  try { return files.inspectChild(ref, win32.basename(path), privateAccess); }
  finally { files.closeDirectory(ref); }
}
export function windowsProfileNames(path: string, maximum = 4096): string[] {
  const files = windowsProfileFiles(), ref = files.inspectDirectory(path, 'traverse');
  if (!ref) throw new FileBoundaryFault('missing', 'directory');
  try { return files.names(ref, maximum); } finally { files.closeDirectory(ref); }
}
export function windowsProfileContains(parent: string, child: string): boolean {
  const tail = win32.relative(windowsCanonicalPath(parent).toUpperCase(), windowsCanonicalPath(child).toUpperCase());
  return tail === '' || !win32.isAbsolute(tail) && tail !== '..' && !tail.startsWith('..\\');
}
