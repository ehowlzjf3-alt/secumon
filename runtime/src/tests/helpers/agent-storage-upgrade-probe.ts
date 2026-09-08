import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { KnowledgeRead } from '../../domain/knowledge.js';
import type { EngineUpdateSnapshot } from './agent-engine-update-probe.js';

type Rows = Record<string, unknown>[];
export type RawKnowledge = Record<'records' | 'heads' | 'receipts' | 'index', Rows>;
export interface StorageUpgradeRaw {
  state: { version: number; schema: Rows; owner: Rows; originals: Record<'works' | 'events' | 'receipts' | 'deliveries', Rows>; eventMetadata: Rows | null; conversationWork: Rows | null };
  knowledge: { version: number; schema: Rows; owner: Rows; legacy: RawKnowledge | null; scoped: RawKnowledge | null; partitions: Rows };
  channel: { schema: Rows; tables: Record<string, Rows> };
}
export type StorageUpgradeSnapshot = Pick<EngineUpdateSnapshot, 'identity' | 'sessionId' | 'state' | 'input' | 'history' | 'hostIdentity' | 'events' | 'receipts' | 'deliveries' | 'artifacts'> & { knowledge: KnowledgeRead };
export interface StorageUpgradeSeed { snapshot: StorageUpgradeSnapshot; raw: StorageUpgradeRaw }

const [engineInput, mode, directory, argument] = process.argv.slice(2);
assert.ok(engineInput && directory); assert.ok(['seed', 'snapshot', 'raw'].includes(mode ?? ''));
const engine = realpathSync(engineInput), moduleUrl = (path: string) => pathToFileURL(join(engine, 'dist', path)).href;
const { FileAgentProfileStore } = await import(moduleUrl('infrastructure/file-agent-profile.js')) as typeof import('../../infrastructure/file-agent-profile.js');
const { openHostSqliteDatabase } = await import(moduleUrl('infrastructure/windows-sqlite.js')) as typeof import('../../infrastructure/windows-sqlite.js');
const inspected = new FileAgentProfileStore(engine).inspect(directory);
assert.equal(inspected.status, 'ready'); if (inspected.status !== 'ready') throw new Error('storage_upgrade_profile_not_ready');
const profile = inspected;
const channelPath = join(profile.paths.metadata, 'channel.sqlite'), knowledgeId = 'storage-upgrade-observation';
const rows = (db: DatabaseSync, sql: string): Rows => db.prepare(sql).all().map(row => ({ ...row }));
const exists = (db: DatabaseSync, name: string) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
const schema = (db: DatabaseSync) => rows(db, "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name");
function inspect<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = openHostSqliteDatabase(path, { readOnly: true });
  try { db.exec('BEGIN'); const result = read(db); db.exec('COMMIT'); return result; } finally { db.close(); }
}
function rawKnowledge(db: DatabaseSync, suffix: '' | '_v2'): RawKnowledge {
  return Object.fromEntries((['records', 'heads', 'receipts', 'index'] as const).map(name => [name,
    rows(db, `SELECT * FROM knowledge_${name}${suffix} ORDER BY tenant_id,${name === 'heads' ? 'namespace' : name === 'receipts' ? 'id,command_id' : 'id'}`)])) as RawKnowledge;
}
function rawSnapshot(): StorageUpgradeRaw {
  return {
    state: inspect(profile.paths.state, db => ({ version: Number(db.prepare('PRAGMA user_version').get()?.['user_version']), schema: schema(db),
      owner: rows(db, 'SELECT * FROM agent_storage_owner'), originals: {
        works: rows(db, 'SELECT * FROM works ORDER BY id'), events: rows(db, 'SELECT * FROM events ORDER BY work_id,sequence'),
        receipts: rows(db, 'SELECT * FROM receipts ORDER BY work_id,command_id'), deliveries: rows(db, 'SELECT * FROM deliveries ORDER BY work_id,id') },
      eventMetadata: exists(db, 'event_metadata') ? rows(db, 'SELECT * FROM event_metadata ORDER BY work_id,sequence') : null,
      conversationWork: exists(db, 'conversation_work') ? rows(db, 'SELECT * FROM conversation_work ORDER BY tenant_id,principal_id,channel,conversation_id,work_id') : null })),
    knowledge: inspect(profile.paths.memory, db => ({ version: Number(db.prepare('SELECT version FROM knowledge_schema').get()?.['version']), schema: schema(db),
      owner: rows(db, 'SELECT * FROM agent_storage_owner'), legacy: exists(db, 'knowledge_records') ? rawKnowledge(db, '') : null,
      scoped: exists(db, 'knowledge_records_v2') ? rawKnowledge(db, '_v2') : null,
      partitions: exists(db, 'knowledge_records_v2') ? rows(db, 'SELECT DISTINCT agent_id,partition,principal_id FROM knowledge_records_v2 ORDER BY agent_id,partition,principal_id') : [] })),
    channel: inspect(channelPath, db => ({ schema: schema(db), tables: Object.fromEntries(
      rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(row => {
        const name = String(row['name']); assert.match(name, /^(?:agent_storage_owner|local_messages|session_[a-z_]+)$/);
        return [name, rows(db, `SELECT * FROM ${name} ORDER BY rowid`)];
      })) })),
  };
}

/** Fixture-only known old layouts, populated from real current-runtime originals. This is not a historical engine binary. */
function legacyLayout(version: 1 | 2) {
  const state = openHostSqliteDatabase(profile.paths.state);
  try {
    state.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    if (version === 1) state.exec(`
      DROP TRIGGER works_query_insert; DROP TRIGGER works_query_update; DROP TRIGGER works_query_delete;
      DROP TRIGGER events_query_insert; DROP TRIGGER events_query_update; DROP TRIGGER events_query_delete;
      DROP TABLE event_metadata; DROP TABLE conversation_work; PRAGMA user_version=1;`);
    else state.exec(`DROP TRIGGER works_query_update;
      CREATE TRIGGER works_query_update AFTER UPDATE ON works BEGIN SELECT 1; END;
      DELETE FROM event_metadata; DELETE FROM conversation_work; PRAGMA user_version=2;`);
    state.exec('COMMIT');
  } catch (error) { state.exec('ROLLBACK'); throw error; } finally { state.close(); }
  const db = openHostSqliteDatabase(profile.paths.memory);
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const name of ['records', 'heads', 'receipts', 'index']) {
      const foreign = db.prepare(`SELECT COUNT(*) AS n FROM knowledge_${name}_v2 WHERE agent_id<>? OR partition<>'work' OR principal_id<>''`).get(profile.identity.agentId);
      assert.equal(foreign?.['n'], 0, 'the fixture never demotes or drops personal/foreign knowledge');
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM knowledge_records_v2').get()?.['n'], 1);
    const record = db.prepare('SELECT body FROM knowledge_records_v2').get()!;
    // Noncanonical whitespace makes accidental parse/reserialize during migration observable.
    const originalJson = JSON.stringify(JSON.parse(String(record['body'])), null, 2) + '\n';
    db.prepare('UPDATE knowledge_records_v2 SET body=?').run(originalJson);
    db.prepare('UPDATE knowledge_index_v2 SET body=?').run(originalJson);
    db.exec("UPDATE knowledge_heads_v2 SET cursor=0,error='index_read_failed'");
    db.exec(`CREATE TABLE knowledge_records(tenant_id TEXT NOT NULL,id TEXT NOT NULL,namespace TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(tenant_id,id));
      CREATE INDEX knowledge_namespace ON knowledge_records(tenant_id,namespace);
      CREATE TABLE knowledge_heads(tenant_id TEXT NOT NULL,namespace TEXT NOT NULL,revision INTEGER NOT NULL,cursor INTEGER NOT NULL,error TEXT,PRIMARY KEY(tenant_id,namespace));
      CREATE TABLE knowledge_receipts(tenant_id TEXT NOT NULL,id TEXT NOT NULL,command_id TEXT NOT NULL,digest TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(tenant_id,id,command_id));
      CREATE TABLE knowledge_index(tenant_id TEXT NOT NULL,namespace TEXT NOT NULL,id TEXT NOT NULL,document TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(tenant_id,namespace,id));
      INSERT INTO knowledge_records SELECT tenant_id,id,namespace,revision,body FROM knowledge_records_v2;
      INSERT INTO knowledge_heads SELECT tenant_id,namespace,revision,cursor,error FROM knowledge_heads_v2;
      INSERT INTO knowledge_receipts SELECT tenant_id,id,command_id,digest,revision FROM knowledge_receipts_v2;
      INSERT INTO knowledge_index SELECT tenant_id,namespace,id,document,body FROM knowledge_index_v2;
      DROP TABLE knowledge_index_v2; DROP TABLE knowledge_receipts_v2; DROP TABLE knowledge_heads_v2; DROP TABLE knowledge_records_v2;
      DROP TABLE knowledge_scoped_schema; UPDATE knowledge_schema SET version=1; COMMIT;`);
  } catch (error) { db.exec('ROLLBACK'); throw error; } finally { db.close(); }
}

let output: StorageUpgradeRaw | StorageUpgradeSnapshot | StorageUpgradeSeed;
if (mode === 'raw') output = rawSnapshot();
else {
  const { openAgentTurnProfile } = await import(moduleUrl('presentation/agent-turn-profile.js')) as typeof import('../../presentation/agent-turn-profile.js');
  const { inspectAgentHostIdentity } = await import(moduleUrl('infrastructure/agent-host-identities.js')) as typeof import('../../infrastructure/agent-host-identities.js');
  const { SYNTHETIC_AGENT_TURN_REQUESTS } = await import(moduleUrl('infrastructure/synthetic-agent-turn.js')) as typeof import('../../infrastructure/synthetic-agent-turn.js');
  const p = await openAgentTurnProfile(directory, { provider: 'synthetic' });
  let snapshot: StorageUpgradeSnapshot;
  try {
    assert.ok(p.knowledge); let workId = argument;
    if (mode === 'seed') {
      assert.ok(argument === '1' || argument === '2');
      const session = await p.sessions.open(p.actor, { channel: 'cli', conversationId: 'storage-upgrade' });
      const accepted = await p.turns.accept(p.actor, { sessionId: session.scope.sessionId, messageId: 'storage-upgrade-read',
        rawText: SYNTHETIC_AGENT_TURN_REQUESTS.read, mode: 'auto', scope: p.scope, policy: p.policy, limits: p.limits,
        binding: { ...p.executionActor, channel: 'cli', conversationId: 'storage-upgrade', recipientId: p.actor.principalId, destination: 'local' } });
      workId = accepted.workId; const stop = new Error('storage_upgrade_real_adoption'); let reached = false;
      try {
        await p.workflow.run(workId, p.executionActor, { maxSteps: 20, onStep: async () => {
          const state = await p.runtime.state(workId!);
          if (state.attempts.some(attempt => attempt.toolId === 'fixture.read' && attempt.status === 'succeeded' && attempt.adopted)) { reached = true; throw stop; }
        } });
        assert.fail('actual read adoption boundary was not reached');
      } catch (error) { assert.equal(error, stop); }
      assert.equal(reached, true);
      const state = await p.runtime.state(workId), observed = state.evidence.find(value => value.facts['retention.days'] === 30);
      assert.ok(observed); assert.equal(state.budget.used.modelCalls, 1); assert.equal(state.budget.used.toolCalls, 1);
      // The real knowledge service validates the original observed evidence and writes a work record, never personal memory.
      await p.knowledge.create({ id: knowledgeId, commandId: 'storage-upgrade-knowledge', namespace: 'local', scope: p.scope,
        kind: 'experience', title: '업데이트 전 원 관측', body: '원 문서의 보존 기간은 30일이다.', labels: [],
        sources: [{ workId, evidenceId: observed.id }], derivedFrom: [], expiresAt: null });
      await p.knowledge.rebuildIndex('local');
    }
    assert.ok(workId);
    const state = await p.runtime.state(workId), basis = state.conversation?.session; assert.ok(basis);
    const input = await p.sessions.repository.input(basis.scope, basis.input.messageId); assert.ok(input); assert.equal(input.status, 'applied');
    const events = await p.services.state.events(workId, 0), receipts: StorageUpgradeSnapshot['receipts'] = [];
    for (const commandId of new Set(events.map(value => value.commandId))) {
      const receipt = await p.services.state.receipt(workId, commandId); assert.ok(receipt); receipts.push({ commandId, ...receipt });
    }
    const refs = new Map(state.artifacts.map(ref => [ref.id, ref]));
    for (const call of state.modelCalls) { refs.set(call.inputArtifact.id, call.inputArtifact); if (call.replyArtifact) refs.set(call.replyArtifact.id, call.replyArtifact); }
    const artifacts: StorageUpgradeSnapshot['artifacts'] = []; let bytesRead = 0;
    for (const ref of refs.values()) {
      const bytes = await p.services.artifacts.get(ref, p.policy); bytesRead += bytes.byteLength; assert.ok(bytesRead <= 8 * 1024 * 1024);
      assert.equal(bytes.byteLength, ref.byteLength); assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.sha256);
      artifacts.push({ ref, base64: Buffer.from(bytes).toString('base64') });
    }
    const hostIdentity = inspectAgentHostIdentity(profile, { engineDirectories: [engine] }); assert.ok(hostIdentity);
    snapshot = { identity: profile.identity, sessionId: basis.scope.sessionId, state, input,
      history: await p.sessions.history(p.actor, basis.scope.sessionId, p.policy, { limit: 100 }), hostIdentity,
      events, receipts, deliveries: await p.services.state.deliveries(workId), artifacts, knowledge: await p.knowledge.get(knowledgeId) };
  } finally { await p.close(); }
  if (mode === 'seed') { legacyLayout(Number(argument) as 1 | 2); output = { snapshot, raw: rawSnapshot() }; }
  else output = snapshot;
}
const serialized = JSON.stringify(output); assert.ok(Buffer.byteLength(serialized) <= 16 * 1024 * 1024);
process.stdout.write(serialized + '\n');
