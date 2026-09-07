import { closeSync, constants, fsyncSync, lstatSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AgentProfileError } from '../application/agent-profile-contracts.js';
import { agentDatabaseExists, inspectAgentDatabaseOwner } from './agent-database-owner.js';
import { profileDirectory, profileErrorCode, syncProfileDirectory } from './agent-profile-files.js';
import { openHostSqliteDatabase } from './windows-sqlite.js';

const name = z.string().min(1).max(160).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const waitCell = new Int32Array(new SharedArrayBuffer(4));
function prepareWal(db: DatabaseSync) {
  const deadline = performance.now() + 5000;
  for (;;) {
    try { db.exec('PRAGMA journal_mode=WAL;'); return; }
    catch (error) {
      const code = (error as { errcode?: number })?.errcode;
      if (typeof code !== 'number' || (code & 0xff) !== 5 || performance.now() >= deadline) throw error;
      Atomics.wait(waitCell, 0, 0, 10);
    }
  }
}
const bindingSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('agent'), agentId: name }),
  z.strictObject({ mode: z.literal('shared'), storeId: name, agentId: name }),
]);
export type KnowledgeSqliteBinding = z.infer<typeof bindingSchema>;
export function knowledgeSqliteBinding(value: KnowledgeSqliteBinding): Readonly<KnowledgeSqliteBinding> {
  return Object.freeze(bindingSchema.parse(value));
}
function table(db: DatabaseSync, name: string) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}
function sharedOwner(db: DatabaseSync, storeId: string) {
  if (table(db, 'agent_storage_owner')) throw new AgentProfileError('agent_storage_owner_mismatch');
  if (!table(db, 'knowledge_store_owner')) throw new AgentProfileError('agent_storage_owner_missing');
  const owners = db.prepare('SELECT singleton,schema_version,mode,store_id FROM knowledge_store_owner LIMIT 2').all(); const owner = owners[0];
  if (owners.length !== 1 || owner?.['singleton'] !== 1 || owner['schema_version'] !== 1 || owner['mode'] !== 'shared' || owner['store_id'] !== storeId) {
    throw new AgentProfileError('agent_storage_owner_mismatch');
  }
  if (!table(db, 'knowledge_store_agents')) throw new Error('invalid_knowledge_store_registration');
}
/** The handle supplies the binding; records and model arguments cannot enroll another agent. */
export function assertKnowledgeStoreOwner(db: DatabaseSync, binding: KnowledgeSqliteBinding): void {
  if (binding.mode === 'shared') {
    sharedOwner(db, binding.storeId);
    if (!db.prepare('SELECT 1 FROM knowledge_store_agents WHERE agent_id=?').get(binding.agentId)) throw new Error('knowledge_agent_not_registered');
    return;
  }
  if (table(db, 'knowledge_store_owner')) throw new AgentProfileError('agent_storage_owner_mismatch');
  if (!table(db, 'agent_storage_owner')) throw new AgentProfileError('agent_storage_owner_missing');
  const owners = db.prepare('SELECT singleton,schema_version,agent_id,kind FROM agent_storage_owner LIMIT 2').all(); const owner = owners[0];
  if (owners.length !== 1 || owner?.['singleton'] !== 1 || owner['schema_version'] !== 1 || owner['agent_id'] !== binding.agentId || owner['kind'] !== 'memory') {
    throw new AgentProfileError('agent_storage_owner_mismatch');
  }
}
export function preflightKnowledgeStore(path: string, binding: KnowledgeSqliteBinding): void {
  if (!profileDirectory(dirname(path), false)) throw new AgentProfileError('agent_directory_unsafe');
  if (binding.mode === 'agent') {
    if (inspectAgentDatabaseOwner(path, binding.agentId, 'memory') !== 'owned') throw new AgentProfileError('agent_storage_owner_missing');
    return;
  }
  if (!agentDatabaseExists(path)) throw new AgentProfileError('agent_storage_owner_missing');
  const db = openHostSqliteDatabase(path, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout=5000; BEGIN;'); assertKnowledgeStoreOwner(db, binding); db.exec('COMMIT;'); }
  finally { db.close(); }
}

/** Explicit host registration, separate from C01 single-agent ownership and ordinary handles. */
export function registerSharedKnowledgeStore(path: string, input: { storeId: string; agentIds: string[] }): void {
  const registration = z.strictObject({ storeId: name, agentIds: z.array(name).min(1).max(256) }).parse(input);
  const agents = [...new Set(registration.agentIds)].sort();
  if (agents.length !== registration.agentIds.length) throw new Error('invalid_knowledge_store_registration');
  if (!profileDirectory(dirname(path), false)) throw new AgentProfileError('agent_directory_unsafe');
  agentDatabaseExists(path);
  if (process.platform !== 'win32') {
    try {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error) { if (profileErrorCode(error) !== 'EEXIST') throw error; }
    if (!agentDatabaseExists(path)) throw new AgentProfileError('agent_storage_path_unsafe');
  }
  const identity = process.platform === 'win32' ? undefined : lstatSync(path);
  // Windows provisions and retains the exact main file before SQLite opens it.
  const db = openHostSqliteDatabase(path);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
    if (table(db, 'knowledge_store_owner')) {
      sharedOwner(db, registration.storeId);
      const registered = db.prepare('SELECT agent_id FROM knowledge_store_agents LIMIT 257').all().map(row => String(row['agent_id'])).sort();
      if (JSON.stringify(registered) !== JSON.stringify(agents)) throw new Error('knowledge_store_registration_conflict');
    } else {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) throw new AgentProfileError('agent_storage_owner_missing');
      db.exec(`CREATE TABLE knowledge_store_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL,mode TEXT NOT NULL,store_id TEXT NOT NULL);
        CREATE TABLE knowledge_store_agents(agent_id TEXT PRIMARY KEY);`);
      db.prepare("INSERT INTO knowledge_store_owner VALUES(1,1,'shared',?)").run(registration.storeId);
      const insert = db.prepare('INSERT INTO knowledge_store_agents VALUES(?)'); for (const agent of agents) insert.run(agent);
    }
    if (identity) {
      if (!agentDatabaseExists(path)) throw new AgentProfileError('agent_storage_path_unsafe');
      const current = lstatSync(path);
      if (current.dev !== identity.dev || current.ino !== identity.ino) throw new AgentProfileError('agent_storage_path_unsafe');
    }
    db.exec('COMMIT;'); prepareWal(db);
  } catch (error) { try { db.exec('ROLLBACK;'); } catch {} throw error; }
  finally { db.close(); }
  syncProfileDirectory(dirname(path));
}
