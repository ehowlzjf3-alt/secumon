import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { bindAgentDatabase, inspectAgentDatabaseOwner, type AgentDatabaseKind } from '../../infrastructure/agent-database-owner.js';

const [operation, path, agentId] = process.argv.slice(2);
if (!operation || !path || !agentId) throw new Error('invalid_database_owner_worker_arguments');
function output(value: unknown) { process.stdout.write(JSON.stringify(value) + '\n'); }

if (operation === 'probe-lock') {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=50;');
    try { db.exec('BEGIN IMMEDIATE; ROLLBACK;'); output({ acquired: true }); }
    catch (error) {
      const sqliteCode = (error as { errcode?: number }).errcode;
      if (typeof sqliteCode !== 'number' || (sqliteCode & 0xff) !== 5) throw error;
      output({ acquired: false, sqliteCode });
    }
  } finally { db.close(); }
} else if (operation === 'hot-rollback') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=2; PRAGMA cache_spill=ON; BEGIN IMMEDIATE;');
  const result = db.prepare("UPDATE crash_fixture SET payload=replace(payload,'a','b')").run();
  if (Number(result.changes) !== 128 || !db.isTransaction) throw new Error('hot_rollback_fixture_not_written');
  setInterval(() => { if (!db.isTransaction) throw new Error('hot_rollback_transaction_lost'); }, 1000);
  process.send!({ type: 'uncommitted-write', changes: Number(result.changes) });
} else if (operation === 'bind') {
  bindAgentDatabase(path, agentId, 'state'); output({ committed: true });
} else if (operation === 'snapshot') {
  const originalPrepare = DatabaseSync.prototype.prepare; let writerCommitted = false;
  DatabaseSync.prototype.prepare = function (sql: string) {
    const statement = originalPrepare.call(this, sql);
    if (!writerCommitted && sql.includes("type='table'") && sql.includes("name='agent_storage_owner'")) {
      const originalGet = statement.get.bind(statement);
      statement.get = () => {
        const row = originalGet();
        if (row !== undefined) throw new Error('snapshot_fixture_already_owned');
        const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'bind', path, agentId],
          { encoding: 'utf8', timeout: 10000 });
        if (result.status !== 0) throw new Error(`snapshot_writer_failed:${result.error ?? ''}:${result.stderr}`);
        if (JSON.parse(result.stdout).committed !== true) throw new Error('snapshot_writer_not_committed');
        writerCommitted = true; return row;
      };
    }
    return statement;
  };
  let before: ReturnType<typeof inspectAgentDatabaseOwner>;
  try { before = inspectAgentDatabaseOwner(path, agentId, 'state'); }
  finally { DatabaseSync.prototype.prepare = originalPrepare; }
  output({ before, after: inspectAgentDatabaseOwner(path, agentId, 'state'), writerCommitted });
} else if (operation.startsWith('sidecar-unlinked-')) {
  if (!['sidecar-unlinked-absent', 'sidecar-unlinked-unsafe', 'sidecar-unlinked-persistent'].includes(operation)) throw new Error('unknown_sidecar_operation');
  // Keep the owned fixture in rollback mode so an owner read does not create unrelated WAL coordination files.
  const fixtureDb = new DatabaseSync(path);
  try { fixtureDb.exec('PRAGMA journal_mode=DELETE;'); } finally { fixtureDb.close(); }
  const sidecar = path + '-journal', originalLstat = fs.lstatSync;
  const payload = Buffer.from('preserve the detached rollback journal original');
  fs.writeFileSync(sidecar, payload, { flag: 'wx', mode: 0o600 });
  const fd = fs.openSync(sidecar, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const disk = () => fs.readdirSync(dirname(path)).sort().map(name => {
    const file = join(dirname(path), name), stat = originalLstat(file), bytes = fs.readFileSync(file);
    return { name, mode: stat.mode & 0o777, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const retained = () => {
    const stat = fs.fstatSync(fd), bytes = Buffer.alloc(payload.length);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== payload.length || stat.size !== count) throw new Error('detached_original_read_failed');
    return { bytes: count, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  let zeroObservations = 0;
  const observations: Array<{ kind: 'detached' | 'present' | 'missing'; links?: number; mode?: number }> = [];
  let result: ReturnType<typeof inspectAgentDatabaseOwner> | null = null;
  let failure: { code: string | null; message: string } | null = null;
  try {
    fs.unlinkSync(sidecar);
    // This is a real kernel stat for an unlinked, still-open inode, not a fabricated link count.
    const detached = fs.fstatSync(fd);
    const observed = { regular: detached.isFile(), symbolicLink: detached.isSymbolicLink(), links: detached.nlink,
      mode: detached.mode & 0o777, owned: typeof process.getuid !== 'function' || detached.uid === process.getuid() };
    if (!observed.regular || observed.symbolicLink || observed.links !== 0 || observed.mode !== 0o600 || !observed.owned) throw new Error('detached_sidecar_fixture_invalid');
    const originalBefore = retained();
    if (operation === 'sidecar-unlinked-unsafe') {
      fs.writeFileSync(sidecar, 'preserve this unsafe replacement', { flag: 'wx', mode: 0o600 });
      fs.chmodSync(sidecar, 0o644);
    }
    const before = disk();
    Reflect.set(fs, 'lstatSync', ((...args: unknown[]) => {
      if (String(args[0]) !== sidecar) return Reflect.apply(originalLstat, fs, args);
      if (zeroObservations === 0 || operation === 'sidecar-unlinked-persistent') {
        zeroObservations++; observations.push({ kind: 'detached', links: detached.nlink, mode: detached.mode & 0o777 });
        return detached;
      }
      try {
        const stat = Reflect.apply(originalLstat, fs, args) as fs.Stats;
        observations.push({ kind: 'present', links: stat.nlink, mode: stat.mode & 0o777 }); return stat;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') observations.push({ kind: 'missing' });
        throw error;
      }
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    try { result = inspectAgentDatabaseOwner(path, agentId, 'state'); }
    catch (error) {
      const value = error as Error & { code?: string };
      failure = { code: value.code ?? null, message: value.message };
    } finally { Reflect.set(fs, 'lstatSync', originalLstat); syncBuiltinESMExports(); }
    const after = disk(), originalAfter = retained();
    output({ operation, observed, zeroObservations, observations, result, failure, before, after, originalBefore, originalAfter,
      sidecarExistsAfter: fs.existsSync(sidecar) });
  } finally {
    Reflect.set(fs, 'lstatSync', originalLstat); syncBuiltinESMExports(); fs.closeSync(fd);
  }
} else if (operation.startsWith('presence-')) {
  const rawKind = process.argv[5] ?? 'state';
  if (!['state', 'memory', 'channel'].includes(rawKind)) throw new Error('invalid_database_owner_worker_kind');
  const kind = rawKind as AgentDatabaseKind;
  const originalLstat = fs.lstatSync; const originalPrepare = DatabaseSync.prototype.prepare;
  type DiskEntry = { name: string; mode: number; bytes: number; sha256: string };
  const disk = (): DiskEntry[] => fs.readdirSync(dirname(path)).sort().map(name => {
    const file = join(dirname(path), name); const stat = originalLstat(file); const bytes = fs.readFileSync(file);
    return { name, mode: stat.mode & 0o777, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  let injections = 0; let mainInitiallyMissing = false; let holder: DatabaseSync | undefined;
  let before: DiskEntry[] = []; let result: ReturnType<typeof inspectAgentDatabaseOwner> | null = null;
  let failure: { code: string | null; message: string; stack: string | null } | null = null;
  let owner: { agent_id: unknown; kind: unknown } | null = null; let payload: unknown = null;
  const publish = () => {
    if (operation === 'presence-unowned') fs.writeFileSync(path, '', { mode: 0o600 });
    else bindAgentDatabase(path, operation === 'presence-foreign' ? randomUUID() : agentId, kind);
    holder = new DatabaseSync(path);
    // Real SQLite keeps its real WAL/SHM alive while inspection runs. Only the observation timing is mocked.
    holder.exec("PRAGMA journal_mode=WAL; CREATE TABLE race_payload(value TEXT); INSERT INTO race_payload VALUES('preserve');");
    if (operation !== 'presence-unowned') {
      const row = holder.prepare('SELECT agent_id,kind FROM agent_storage_owner').get();
      if (!row) throw new Error('presence_fixture_owner_missing');
      owner = { agent_id: row['agent_id'], kind: row['kind'] };
    }
    payload = holder.prepare('SELECT value FROM race_payload').get()?.['value']; before = disk();
  };
  if (operation === 'presence-orphan') {
    fs.writeFileSync(path + '-wal', 'preserve-orphan-sidecar', { mode: 0o600 }); before = disk();
  } else if (operation === 'presence-removed') {
    holder = new DatabaseSync(path); holder.prepare('SELECT agent_id FROM agent_storage_owner').get();
    DatabaseSync.prototype.prepare = function (sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (sql.startsWith('SELECT singleton, schema_version, agent_id, kind FROM agent_storage_owner')) {
        const originalAll = statement.all.bind(statement);
        statement.all = () => {
          const rows = originalAll();
          if (injections === 0) { injections++; fs.unlinkSync(path); before = disk(); }
          return rows;
        };
      }
      return statement;
    };
  } else if (['presence-owned', 'presence-foreign', 'presence-unowned'].includes(operation)) {
    Reflect.set(fs, 'lstatSync', ((...args: unknown[]) => {
      try { return Reflect.apply(originalLstat, fs, args); }
      catch (error) {
        if (injections === 0 && String(args[0]) === path && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          injections++; mainInitiallyMissing = true; publish();
        }
        // Preserve the actual first ENOENT even though a valid main/sidecar pair now exists.
        throw error;
      }
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
  } else throw new Error('unknown_database_presence_operation');
  let after: DiskEntry[] = []; let mainExistsAfter = false;
  try {
    try { result = inspectAgentDatabaseOwner(path, agentId, kind); }
    catch (error) {
      const value = error as Error & { code?: string };
      failure = { code: value.code ?? null, message: value.message, stack: value.stack ?? null };
    }
    after = disk(); mainExistsAfter = fs.existsSync(path);
  } finally {
    Reflect.set(fs, 'lstatSync', originalLstat); syncBuiltinESMExports(); DatabaseSync.prototype.prepare = originalPrepare; holder?.close();
  }
  output({ operation, kind, injections, mainInitiallyMissing, result, failure, before, after, owner, payload, mainExistsAfter });
} else throw new Error('unknown_database_owner_worker_operation');
