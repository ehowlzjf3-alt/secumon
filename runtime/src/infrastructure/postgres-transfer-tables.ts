import type { PostgresBinding } from './postgres-store.js';

export interface TransferTable {
  name: string; purpose: PostgresBinding['purpose']; columns: readonly string[]; key: readonly string[];
  integers: readonly string[]; nullable: readonly string[]; booleans: readonly string[];
}
function table(purpose: TransferTable['purpose'], name: string, columns: string, key: string, integers = '', nullable = '', booleans = ''): TransferTable {
  const split = (value: string) => Object.freeze(value ? value.split(',') : []);
  return Object.freeze({ name, purpose, columns: split(columns), key: split(key), integers: split(integers), nullable: split(nullable), booleans: split(booleans) });
}
const owner = 'tenant_id,principal_id,session_id';
const knowledge = 'tenant_id,partition,principal_id';
/** SQL identifiers are fixed here; snapshot input never supplies an executable identifier. Dependency order is intentional. */
export const TRANSFER_TABLES: readonly TransferTable[] = Object.freeze([
  table('state', 'works', 'id,revision,status,deadline_at,body', 'id', 'revision,deadline_at'),
  table('state', 'events', 'work_id,sequence,revision,type,at,command_id,body', 'work_id,sequence', 'sequence,revision,at'),
  table('state', 'state_receipts', 'work_id,command_id,digest,body', 'work_id,command_id'),
  table('state', 'deliveries', 'work_id,id,body', 'work_id,id'),
  table('state', 'conversation_work', 'tenant_id,principal_id,channel,conversation_id,work_id', 'tenant_id,principal_id,channel,conversation_id,work_id'),
  table('knowledge', 'knowledge_records', `${knowledge},id,namespace,revision,body`, `${knowledge},id`, 'revision'),
  table('knowledge', 'knowledge_heads', `${knowledge},namespace,revision,cursor,error`, `${knowledge},namespace`, 'revision,cursor', 'error'),
  table('knowledge', 'knowledge_receipts', `${knowledge},id,command_id,digest,revision,audit_body`, `${knowledge},id,command_id`, 'revision', 'audit_body'),
  table('knowledge', 'knowledge_index', `${knowledge},namespace,id,document,body`, `${knowledge},namespace,id`),
  table('channel', 'local_messages', 'work_id,delivery_id,sequence,digest,external_id,body', 'work_id,delivery_id', 'sequence'),
  table('channel', 'session_records', `${owner},created_at,revision,last_sequence,active_work_id,active_input_sequence,head_body`, owner, 'created_at,revision,last_sequence,active_input_sequence', 'active_work_id,head_body'),
  table('channel', 'session_aliases', 'tenant_id,principal_id,route,session_id', 'tenant_id,principal_id,route'),
  table('channel', 'session_inbox', `${owner},message_id,sequence,status,body`, `${owner},message_id`, 'sequence'),
  table('channel', 'session_entries', `${owner},sequence,role,work_id,user_message_id,delivery_id`, `${owner},sequence`, 'sequence', 'user_message_id,delivery_id'),
  table('channel', 'session_heads', `${owner},revision,through_sequence,digest,policy_digest`, `${owner},revision`, 'revision,through_sequence'),
  table('channel', 'session_summaries', `${owner},summary_id,revision,through_sequence,policy_digest,body`, `${owner},summary_id`, 'revision,through_sequence'),
  table('channel', 'session_summary_heads', `${owner},summary_id`, owner),
  table('channel', 'session_summary_publications', `${owner},call_id,request_digest,summary_id`, `${owner},call_id`),
  table('board', 'boards', 'tenant_id,id,revision,body', 'tenant_id,id', 'revision'),
  table('board', 'board_receipts', 'tenant_id,id,command_id,digest,revision,closed', 'tenant_id,id,command_id', 'revision', '', 'closed'),
  table('board', 'board_roots', 'tenant_id,id,after_revision', 'tenant_id,id', 'after_revision'),
  table('board', 'board_events', 'tenant_id,id,revision,body', 'tenant_id,id,revision', 'revision'),
]);
