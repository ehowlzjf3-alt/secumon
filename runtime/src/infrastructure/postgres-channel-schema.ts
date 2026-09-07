/** Explicit host provisioning only. Runtime constructors never create or migrate PostgreSQL tables. */
const scope = 'store_id,agent_id,tenant_id,principal_id,session_id';
const owner = 'store_id TEXT NOT NULL,agent_id TEXT NOT NULL,tenant_id TEXT NOT NULL,principal_id TEXT NOT NULL,session_id TEXT NOT NULL';
export const POSTGRES_CHANNEL_SCHEMA: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS secumon_pg.local_messages (
    store_id TEXT NOT NULL,agent_id TEXT NOT NULL,work_id TEXT NOT NULL,delivery_id TEXT NOT NULL,
    sequence BIGINT GENERATED ALWAYS AS IDENTITY,digest TEXT NOT NULL,external_id TEXT NOT NULL,body TEXT NOT NULL,
    PRIMARY KEY(store_id,agent_id,work_id,delivery_id))`,
  `CREATE TABLE IF NOT EXISTS secumon_pg.session_records (${owner},
    created_at BIGINT NOT NULL,revision BIGINT NOT NULL,last_sequence BIGINT NOT NULL,
    active_work_id TEXT,active_input_sequence BIGINT NOT NULL,head_body TEXT,
    PRIMARY KEY(${scope}))`,
  `CREATE TABLE IF NOT EXISTS secumon_pg.session_aliases (
    store_id TEXT NOT NULL,agent_id TEXT NOT NULL,tenant_id TEXT NOT NULL,principal_id TEXT NOT NULL,route TEXT NOT NULL,session_id TEXT NOT NULL,
    PRIMARY KEY(store_id,agent_id,tenant_id,principal_id,route),
    FOREIGN KEY(${scope}) REFERENCES secumon_pg.session_records(${scope}))`,
  `CREATE TABLE IF NOT EXISTS secumon_pg.session_inbox (${owner},message_id TEXT NOT NULL,sequence BIGINT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,
    PRIMARY KEY(${scope},message_id),UNIQUE(${scope},sequence),FOREIGN KEY(${scope}) REFERENCES secumon_pg.session_records(${scope}))`,
  `CREATE INDEX IF NOT EXISTS pg_session_pending ON secumon_pg.session_inbox(${scope},status,sequence)`,
  `CREATE TABLE IF NOT EXISTS secumon_pg.session_entries (${owner},sequence BIGINT NOT NULL,role TEXT NOT NULL,work_id TEXT NOT NULL,user_message_id TEXT,delivery_id TEXT,
    PRIMARY KEY(${scope},sequence),UNIQUE(${scope},user_message_id),UNIQUE(${scope},work_id,delivery_id),
    CHECK((role='user' AND user_message_id IS NOT NULL AND delivery_id IS NULL) OR (role='assistant' AND delivery_id IS NOT NULL AND user_message_id IS NULL)),
    FOREIGN KEY(${scope}) REFERENCES secumon_pg.session_records(${scope}),
    FOREIGN KEY(${scope},user_message_id) REFERENCES secumon_pg.session_inbox(${scope},message_id),
    FOREIGN KEY(store_id,agent_id,work_id,delivery_id) REFERENCES secumon_pg.local_messages(store_id,agent_id,work_id,delivery_id))`,
  `CREATE TABLE IF NOT EXISTS secumon_pg.session_heads (${owner},revision BIGINT NOT NULL,through_sequence BIGINT NOT NULL,digest TEXT NOT NULL,policy_digest TEXT NOT NULL,
    PRIMARY KEY(${scope},revision),UNIQUE(${scope},through_sequence,digest,policy_digest),FOREIGN KEY(${scope}) REFERENCES secumon_pg.session_records(${scope}))`,
  `CREATE TABLE IF NOT EXISTS secumon_pg.session_summaries (${owner},summary_id TEXT NOT NULL,revision BIGINT NOT NULL,through_sequence BIGINT NOT NULL,policy_digest TEXT NOT NULL,body TEXT NOT NULL,
    PRIMARY KEY(${scope},summary_id),UNIQUE(${scope},revision),FOREIGN KEY(${scope}) REFERENCES secumon_pg.session_records(${scope}))`,
  `CREATE INDEX IF NOT EXISTS pg_session_summary_prefix ON secumon_pg.session_summaries(${scope},policy_digest,through_sequence)`,
  `CREATE TABLE IF NOT EXISTS secumon_pg.session_summary_heads (${owner},summary_id TEXT NOT NULL,PRIMARY KEY(${scope}),
    FOREIGN KEY(${scope},summary_id) REFERENCES secumon_pg.session_summaries(${scope},summary_id))`,
  `CREATE TABLE IF NOT EXISTS secumon_pg.session_summary_publications (${owner},call_id TEXT NOT NULL,request_digest TEXT NOT NULL,summary_id TEXT NOT NULL,
    PRIMARY KEY(${scope},call_id),UNIQUE(${scope},summary_id),FOREIGN KEY(${scope},summary_id) REFERENCES secumon_pg.session_summaries(${scope},summary_id))`,
]);
