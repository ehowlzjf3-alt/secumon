import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentProfileStore } from '../application/agent-profile-contracts.js';
import type { KnowledgeRepository } from '../application/knowledge-ports.js';
import type { StateRepository } from '../application/ports.js';
import { AgentProfileError } from '../application/agent-profile-contracts.js';
import { SqliteStateRepository } from './sqlite-state.js';
import { SqliteKnowledgeRepository } from './sqlite-knowledge.js';
import { FileArtifactStore } from './file-artifacts.js';
import { FileWorkspaceStore } from './file-workspaces.js';
import { LocalChannel } from './local-channel.js';
import { bindAgentDatabase } from './agent-database-owner.js';
import { bindAgentStateProfile, inspectAgentStateProfile } from './agent-state-profile.js';
import { FileJournalStateRepository, JournalStateError } from './file-journal-state.js';
import { bindAgentMemoryProfile } from './agent-memory-profile.js';
import { AgentKnowledgeRepository } from './agent-knowledge.js';
import { DocumentKnowledgeRepository } from './document-knowledge.js';
import { acquireAgentRuntimeLease, assertAgentRuntimeAvailable } from './agent-lifecycle-lease.js';
import type { AgentChannel } from './agent-channel.js';
import { bindAgentStorageSelection, openAgentPostgresStore, type AgentPostgresHost } from './agent-postgres-storage.js';
import { PostgresStateRepository } from './postgres-state.js';
import { PostgresKnowledgeRepository } from './postgres-knowledge.js';
import { PostgresChannel } from './postgres-channel.js';
import { claimAgentHostIdentity } from './agent-host-identities.js';
import { effectiveAgentPostgresSelection } from './agent-postgres-migration-profile.js';
import { inspectAgentLocalStorageCompatibility } from './agent-storage-compatibility.js';
import { engineCompatibility } from './agent-engine-release.js';

export interface AgentStoreHostOptions { readonly identityRegistryDirectory?: string }
const currentEngine = fileURLToPath(new URL('../../', import.meta.url));

/** Per-agent physical stores. Conversation/session authorization is added above these ports. */
export async function openAgentStores(profiles: AgentProfileStore, directory: string, postgresHost?: AgentPostgresHost, hostOptions: AgentStoreHostOptions = {}) {
  const profile = profiles.inspect(directory);
  if (profile.status !== 'ready') throw new AgentProfileError('agent_profile_not_ready');
  if (profile.personalMemoryMigration?.phase === 'pending') throw new AgentProfileError('agent_migration_resume_required');
  if (profile.postgresMigration?.phase === 'pending') throw new AgentProfileError('agent_postgres_migration_resume_required');
  profiles.assertRuntimeCompatible?.(profile.root);
  const registryDirectory = hostOptions.identityRegistryDirectory;
  const identityClaim = claimAgentHostIdentity(profile, {
    engineDirectories: [...new Set([currentEngine, ...(profiles.engineDirectories ?? [])])],
    ...(registryDirectory === undefined ? {} : { registryDirectory }),
  });
  let lifecycleLease: ReturnType<typeof acquireAgentRuntimeLease> | undefined;
  const agentId = profile.identity.agentId;
  const channelPath = join(profile.paths.metadata, 'channel.sqlite');
  let state: StateRepository | undefined; let knowledge: KnowledgeRepository | undefined;
  let channel: AgentChannel | undefined; let workspace: FileWorkspaceStore | undefined; let closed = false;
  async function close(primary?: { error: unknown }) {
    if (closed) { if (primary) throw primary.error; return; } closed = true;
    const errors: unknown[] = primary ? [primary.error] : [];
    let storeCloseFailed = false;
    for (const action of [() => workspace?.close(), () => channel?.close(), () => knowledge?.close(), () => state?.close()]) {
      try { await action(); } catch (error) { errors.push(error); storeCloseFailed = true; }
    }
    if (!storeCloseFailed) { try { lifecycleLease?.close(); } catch (error) { errors.push(error); } }
    try { identityClaim.close(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'agent_stores_close_failed', { cause: errors[0] });
  }
  try {
    // Reject foreign or ambiguous local stores before publishing new selection/lease metadata.
    // Binding below repeats ownership checks under the lease before any writable store opens.
    assertAgentRuntimeAvailable(profile.root);
    if (!effectiveAgentPostgresSelection(profile)?.purposes.includes('state')) inspectAgentStateProfile(profile);
    lifecycleLease = acquireAgentRuntimeLease(profile.root);
    identityClaim.assertCurrent();
    inspectAgentLocalStorageCompatibility(profile, { compatibility: engineCompatibility }, { allowUninitialized: true });
    const host = postgresHost ? { selection: structuredClone(postgresHost.selection), pool: { connect: postgresHost.pool.connect.bind(postgresHost.pool) } } : undefined;
    const pg = bindAgentStorageSelection(profile, host);
    if (pg?.purposes.includes('state')) state = new PostgresStateRepository(await openAgentPostgresStore(profile, pg, host!, 'state'));
    else {
      const backend = bindAgentStateProfile(profile);
      if (backend === 'sqlite') { bindAgentDatabase(profile.paths.state, agentId, 'state'); state = new SqliteStateRepository(profile.paths.state); }
      else state = new FileJournalStateRepository(profile.paths.state, { owner: { agentId, kind: 'state' } });
    }
    const personalMemory = profile.effectivePersonalMemory.backend === 'postgres' ? profile.effectivePersonalMemory : bindAgentMemoryProfile(profile);
    if (pg?.purposes.includes('knowledge')) knowledge = new PostgresKnowledgeRepository(await openAgentPostgresStore(profile, pg, host!, 'knowledge'));
    else { bindAgentDatabase(profile.paths.memory, agentId, 'memory'); knowledge = new SqliteKnowledgeRepository(profile.paths.memory, { mode: 'agent', agentId }); }
    if (personalMemory.backend === 'documents') {
      const personal = new DocumentKnowledgeRepository(join(dirname(profile.paths.memory), 'documents'), { agentId, storeId: personalMemory.storeId, root: profile.root });
      knowledge = new AgentKnowledgeRepository(knowledge, personal, agentId);
    }
    if (pg?.purposes.includes('channel')) channel = new PostgresChannel(await openAgentPostgresStore(profile, pg, host!, 'channel'));
    else { bindAgentDatabase(channelPath, agentId, 'channel'); channel = new LocalChannel(channelPath, agentId); }
    workspace = new FileWorkspaceStore(profile.paths.workspace);
    const artifacts = new FileArtifactStore(profile.paths.artifacts);
    identityClaim.assertCurrent();
    return { profile, state, knowledge, channel, sessions: channel.sessions!, workspace, artifacts,
      assertIdentityCurrent: () => identityClaim.assertCurrent(), close: () => close() };
  } catch (error) {
    const primary = error instanceof JournalStateError ? new AgentProfileError(error.code, { cause: error }) : error;
    await close({ error: primary });
    throw primary;
  }
}
