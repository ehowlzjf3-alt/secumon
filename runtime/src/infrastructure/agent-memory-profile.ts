import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AgentProfileError, type AgentProfileStatus } from '../application/agent-profile-contracts.js';
import { agentDatabaseExists } from './agent-database-owner.js';
import { checkProfileMutationScope, openProfileMutationScope, profileDirectory, profileStat, publishProfileJson, readProfileJson, syncProfileDirectory } from './agent-profile-files.js';
import { inspectDocumentKnowledgeStore, registerDocumentKnowledgeStore } from './document-knowledge-owner.js';
import { assertMigrationExecutionSource } from './personal-memory-migration-profile.js';

const common = { schemaVersion: z.literal(1), agentId: z.uuid() };
const AssignmentSchema = z.discriminatedUnion('backend', [
  z.strictObject({ ...common, backend: z.literal('sqlite') }),
  z.strictObject({ ...common, backend: z.literal('documents'), storeId: z.uuid() }),
]);
const ReadySchema = z.strictObject({ ...common, backend: z.literal('documents'), storeId: z.uuid() });
type Assignment = z.infer<typeof AssignmentSchema>;
type ReadyProfile = Extract<AgentProfileStatus, { status: 'ready' }>;
const fail = (code: string): never => { throw new AgentProfileError(code); };

/** Pins the personal partition independently of work state and the work-knowledge database. */
export function bindAgentMemoryProfile(profile: ReadyProfile): Assignment {
  const agentId = profile.identity.agentId;
  const current = assertMigrationExecutionSource(profile);
  if (current.effectivePersonalMemory.backend === 'postgres') return fail('agent_postgres_memory_registration_required');
  if (current.personalMemoryMigration?.phase === 'pending') fail('agent_migration_resume_required');
  if (current.personalMemoryMigration?.phase === 'activated') return { schemaVersion: 1, agentId, ...current.effectivePersonalMemory };
  const selection = current.effectivePersonalMemory.backend === 'documents' ? current.effectivePersonalMemory : null;
  const expected: Assignment = selection ? { schemaVersion: 1, agentId, ...selection } : { schemaVersion: 1, agentId, backend: 'sqlite' };
  const scope = openProfileMutationScope(profile.root, []);
  try {
    const metadata = profile.paths.metadata; profileDirectory(metadata, false, true, scope);
    const assignmentPath = join(metadata, 'personal-memory-profile.json');
    const readyPath = join(metadata, 'document-memory-ready.json');
    const documentPath = join(dirname(profile.paths.memory), 'documents');
    const validate = (actual: Assignment) => {
      if (actual.agentId !== agentId || actual.backend !== expected.backend || actual.backend === 'documents' &&
        (expected.backend !== 'documents' || actual.storeId !== expected.storeId)) fail('agent_personal_memory_profile_mismatch');
    };
    let saved = readProfileJson(assignmentPath, AssignmentSchema, undefined, undefined, scope);
    const ready = readProfileJson(readyPath, ReadySchema, undefined, undefined, scope);
    if (saved) validate(saved);
    if (ready) {
      validate(ready);
      // A concurrent opener can finish registration after our first empty assignment read.
      saved ??= readProfileJson(assignmentPath, AssignmentSchema, undefined, undefined, scope);
      if (!saved) return fail('agent_personal_memory_assignment_missing');
      validate(saved);
    }
    if (expected.backend === 'sqlite') {
      if (profileStat(documentPath) || ready) fail('agent_personal_memory_backend_mismatch');
    } else if (!saved && (agentDatabaseExists(profile.paths.memory) || profileStat(documentPath))) {
      // Only the initial assignment may create a new store. Existing data needs an explicit migration.
      const concurrent = readProfileJson(assignmentPath, AssignmentSchema, undefined, undefined, scope);
      if (!concurrent) return fail('agent_personal_memory_migration_required');
      validate(concurrent);
    }
    if (!saved) publishProfileJson(assignmentPath, expected, scope);
    const assigned = readProfileJson(assignmentPath, AssignmentSchema, undefined, undefined, scope);
    if (!assigned) return fail('agent_personal_memory_assignment_missing'); validate(assigned);
    syncProfileDirectory(metadata, scope);
    if (expected.backend === 'documents') {
      const binding = { agentId, storeId: expected.storeId, root: profile.root };
      // Recheck completion after registration races. A completed but missing store is never recreated.
      const completed = readProfileJson(readyPath, ReadySchema, undefined, undefined, scope);
      if (completed) {
        validate(completed);
        if (inspectDocumentKnowledgeStore(documentPath, binding) !== 'registered') fail('agent_document_memory_missing');
      } else {
        registerDocumentKnowledgeStore(documentPath, binding);
        if (inspectDocumentKnowledgeStore(documentPath, binding) !== 'registered') fail('agent_document_memory_not_ready');
        publishProfileJson(readyPath, expected, scope);
      }
      const receipt = readProfileJson(readyPath, ReadySchema, undefined, undefined, scope);
      if (!receipt) return fail('agent_document_memory_not_ready'); validate(receipt);
      syncProfileDirectory(documentPath, scope); syncProfileDirectory(metadata, scope);
    }
    checkProfileMutationScope(scope); return expected;
  } finally { scope.close(); }
}
