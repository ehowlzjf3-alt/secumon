import { basename, dirname, win32 } from 'node:path';
import { DatabaseSync, backup, type BackupOptions, type DatabaseSyncOptions } from 'node:sqlite';
import { AgentProfileError } from '../application/agent-profile-contracts.js';
import { windowsProfileFiles } from './windows-profile-files.js';
import { windowsAbsolutePath } from './windows-metadata-files.js';
import type { WindowsDatabaseGuard } from './windows-file-addon.js';

/** Held main file + canonical native path; sidecars are checked by the native guard. */
export function openWindowsDatabaseGuard(input: string, create: boolean) {
  const path = windowsAbsolutePath(win32.resolve(input)), files = windowsProfileFiles();
  const directory = files.inspectDirectory(dirname(path), 'private');
  if (!directory) { if (!create) return null; throw new AgentProfileError('agent_storage_parent_missing'); }
  let native: WindowsDatabaseGuard | null = null, directoryClosed = false;
  const closeDirectory = () => { if (!directoryClosed) { directoryClosed = true; files.closeDirectory(directory); } };
  try {
    native = files.handle(directory).database(basename(path), create);
    if (!native) { closeDirectory(); return null; }
    const selected = native, canonical = selected.path(); let closed = false;
    return {
      path: canonical,
      check() { if (closed) throw new AgentProfileError('agent_storage_closed'); selected.check(); },
      info() { if (closed) throw new AgentProfileError('agent_storage_closed'); return selected.info(); },
      close() {
        if (closed) return; closed = true;
        const errors: unknown[] = [];
        try { selected.close(); } catch (error) { errors.push(error); }
        try { closeDirectory(); } catch (error) { errors.push(error); }
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, 'windows_database_close_failed');
      },
    };
  } catch (error) {
    const errors: unknown[] = [error];
    try { native?.close(); } catch (close) { errors.push(close); }
    try { closeDirectory(); } catch (close) { errors.push(close); }
    if (errors.length > 1) throw new AggregateError(errors, 'windows_database_open_failed');
    throw error;
  }
}
type HostDatabaseEntry = { raw: DatabaseSync; guard: NonNullable<ReturnType<typeof openWindowsDatabaseGuard>>; activeBackups: number };
const hostDatabases = new WeakMap<DatabaseSync, HostDatabaseEntry>();
export function windowsDatabaseExists(path: string): boolean {
  const guard = openWindowsDatabaseGuard(path, false); if (!guard) return false;
  try { guard.check(); return true; } finally { guard.close(); }
}
/** POSIX stays unchanged. Windows retains the native object through the actual SQLite connection lifetime. */
export function openHostSqliteDatabase(path: string, options: DatabaseSyncOptions = {}): DatabaseSync {
  if (process.platform !== 'win32' || path === ':memory:') return new DatabaseSync(path, options);
  if (options?.open === false) throw new AgentProfileError('agent_storage_lazy_open_unsupported');
  const guard = openWindowsDatabaseGuard(path, options?.readOnly !== true);
  if (!guard) throw new AgentProfileError('agent_storage_missing');
  let db: DatabaseSync;
  try { guard.check(); db = new DatabaseSync(guard.path, options); }
  catch (error) {
    try { guard.close(); } catch (close) { throw new AggregateError([error, close], 'windows_database_open_failed'); }
    throw error;
  }
  let closed = false;
  const entry: HostDatabaseEntry = { raw: db, guard, activeBackups: 0 };
  function checked<T>(action: () => T): T {
    if (entry.activeBackups) throw new AgentProfileError('agent_storage_backup_active');
    guard!.check();
    let value: T | undefined; const errors: unknown[] = [];
    try { value = action(); } catch (error) { errors.push(error); }
    try { guard!.check(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'windows_database_operation_failed');
    return value as T;
  }
  function close() {
    if (closed) return;
    if (entry.activeBackups) throw new AgentProfileError('agent_storage_backup_active');
    const errors: unknown[] = [];
    try { guard!.check(); } catch (error) { errors.push(error); }
    // A failed SQLite close may leave live handles; keep the native guard for a close retry.
    try { db.close(); } catch (error) { errors.push(error); throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'windows_database_close_failed'); }
    closed = true;
    try { guard!.close(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'windows_database_close_failed');
  }
  const cache = new WeakMap<object, object>();
  function wrap<T extends object>(target: T, kind: 'database' | 'statement' | 'iterator'): T {
    const previous = cache.get(target); if (previous) return previous as T;
    const proxy: T = new Proxy(target, { get(object, key): unknown {
      if (kind === 'database' && (key === 'close' || key === Symbol.dispose)) return close;
      if (kind === 'iterator' && key === Symbol.iterator) return () => proxy;
      const value: unknown = Reflect.get(object, key, object);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result: unknown = checked(() => Reflect.apply(value, object, args));
        if (result && typeof result === 'object') {
          if (kind === 'database' && key === 'prepare') return wrap(result, 'statement');
          if (kind === 'statement' && key === 'iterate') return wrap(result, 'iterator');
        }
        return result;
      };
    } });
    cache.set(target, proxy); return proxy;
  }
  try { guard.check(); const proxy = wrap(db, 'database'); hostDatabases.set(proxy, entry); return proxy; }
  catch (error) { try { close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'windows_database_open_failed'); } throw error; }
}

/** Use the original guarded SQLite object internally; callers never receive its raw native handle. */
export async function hostBackupSqliteDatabase(source: DatabaseSync, targetPath: string, options?: BackupOptions): Promise<number> {
  if (process.platform !== 'win32') return backup(source, targetPath, options);
  const sourceEntry = hostDatabases.get(source);
  if (!sourceEntry || sourceEntry.activeBackups) throw new AgentProfileError('agent_storage_backup_source_invalid');
  sourceEntry.guard.check();
  const target = openWindowsDatabaseGuard(targetPath, false);
  if (!target) throw new AgentProfileError('agent_storage_missing');
  const errors: unknown[] = []; let result: number | undefined;
  sourceEntry.activeBackups++;
  try {
    const check = () => { sourceEntry.guard.check(); target.check(); };
    check();
    if (sourceEntry.guard.info().identity === target.info().identity) throw new AgentProfileError('agent_storage_backup_alias');
    const progress = options?.progress;
    result = await backup(sourceEntry.raw, target.path, { ...options, progress(value) { check(); progress?.(value); check(); } });
  } catch (error) { errors.push(error); }
  try { sourceEntry.guard.check(); } catch (error) { errors.push(error); }
  try { target.check(); } catch (error) { errors.push(error); }
  try { target.close(); } catch (error) { errors.push(error); }
  sourceEntry.activeBackups--;
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'windows_database_backup_failed', { cause: errors[0] });
  return result!;
}

export function closeSqliteAfterFailure(db: DatabaseSync, primary: unknown): never {
  try { db.close(); } catch (cleanup) { throw new AggregateError([primary, cleanup], 'sqlite_constructor_close_failed'); }
  throw primary;
}
