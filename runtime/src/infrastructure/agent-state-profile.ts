import { join } from 'node:path';
import { z } from 'zod';
import { AgentProfileError, type AgentProfileStatus } from '../application/agent-profile-contracts.js';
import { agentDatabaseExists, inspectAgentDatabaseOwner } from './agent-database-owner.js';
import { inspectJournalOwnership } from './file-journal-state.js';
import { profileDirectory, profileStat, publishProfileJson, readProfileJson, syncProfileDirectory, openProfileMutationScope, checkProfileMutationScope } from './agent-profile-files.js';
import type { HostFileMutationScope } from './host-file-mutations.js';
import { assertMigrationExecutionSource } from './personal-memory-migration-profile.js';

const StateProfileSchema = z.strictObject({ schemaVersion: z.literal(1), agentId: z.uuid(), stateBackend: z.enum(['sqlite', 'file-journal']) });
type ReadyProfile = Extract<AgentProfileStatus, { status: 'ready' }>;

/** Pins the initial choice, not completion of storage initialization. Never migrates data. */
export function bindAgentStateProfile(profile: ReadyProfile) {
  const scope = openProfileMutationScope(profile.root, []);
  try { const result = inspectScopedStateProfile(profile, scope, true); checkProfileMutationScope(scope); return result; }
  finally { scope.close(); }
}
/** Read-only preflight; normal binding repeats these checks after acquiring its runtime lease. */
export function inspectAgentStateProfile(profile: ReadyProfile) {
  const scope = openProfileMutationScope(profile.root, []);
  try { const result = inspectScopedStateProfile(profile, scope, false); checkProfileMutationScope(scope); return result; }
  finally { scope.close(); }
}
function inspectScopedStateProfile(profile: ReadyProfile, scope: HostFileMutationScope, bind: boolean) {
  const { agentId } = profile.identity; const stateBackend = profile.config.storage.state;
  const metadata = profile.paths.metadata; profileDirectory(metadata, false, true, scope);
  const path = join(metadata, 'state-profile.json');
  const validate = (saved: z.infer<typeof StateProfileSchema>) => {
    if (saved.agentId !== agentId) throw new AgentProfileError('agent_state_profile_mismatch');
    if (saved.stateBackend !== stateBackend) throw new AgentProfileError('agent_state_backend_mismatch');
  };
  const saved = readProfileJson(path, StateProfileSchema, undefined, undefined, scope); if (saved) validate(saved);
  const sqlitePath = join(metadata, 'runtime.sqlite'); const journalPath = join(metadata, 'state-journal');
  const sqlite = agentDatabaseExists(sqlitePath); const journal = profileStat(journalPath) !== null;
  if (journal) profileDirectory(journalPath, false, true, scope);
  if (sqlite && journal || sqlite && stateBackend !== 'sqlite' || journal && stateBackend !== 'file-journal') {
    throw new AgentProfileError('agent_state_backend_mismatch');
  }
  const databases = [
    ...(stateBackend === 'sqlite' ? [{ path: sqlitePath, kind: 'state' as const }] : []),
    { path: profile.paths.memory, kind: 'memory' as const },
    { path: join(metadata, 'channel.sqlite'), kind: 'channel' as const },
  ];
  for (const database of databases) {
    const ownership = inspectAgentDatabaseOwner(database.path, agentId, database.kind);
    // An empty database without a prior assignment has no provenance. A matching
    // assignment allows recovery after interruption between file creation and owner commit.
    if (!saved && ownership === 'empty') {
      const concurrent = readProfileJson(path, StateProfileSchema, undefined, undefined, scope);
      if (!concurrent) throw new AgentProfileError('agent_storage_owner_missing');
      validate(concurrent);
    }
  }
  if (stateBackend === 'file-journal') inspectJournalOwnership(journalPath, { agentId, kind: 'state' });
  if (!bind) return stateBackend;
  // Read-only metadata/ownership failures above precede any new memory probe or assignment publication.
  assertMigrationExecutionSource(profile);
  if (!saved) publishProfileJson(path, { schemaVersion: 1, agentId, stateBackend }, scope);
  const actual = readProfileJson(path, StateProfileSchema, undefined, undefined, scope);
  if (!actual) throw new AgentProfileError('agent_state_profile_missing'); validate(actual);
  syncProfileDirectory(metadata, scope);
  return stateBackend;
}
