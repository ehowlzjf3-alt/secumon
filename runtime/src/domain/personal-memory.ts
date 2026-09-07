import type { KnowledgeDependency, PersonalMemoryRef } from './knowledge.js';
import type { AppliedSessionInput } from './session.js';

/** References consumed by this work, not a second long-term memory database. */
export interface PersonalMemorySelection {
  schemaVersion: 1;
  selectionId: string;
  basis: AppliedSessionInput;
  policy: { allowedLabels: string[]; allowedDestinations: string[] };
  entries: { ref: PersonalMemoryRef; dependency: KnowledgeDependency }[];
}
export interface PersonalMemoryContext {
  schemaVersion: 1;
  selectionId: string;
  basis: AppliedSessionInput;
  entries: { ref: PersonalMemoryRef; title: string; body: string; sourceVersions: string[] }[];
  interpretation: 'user_requested_memory_not_verified_evidence';
}
