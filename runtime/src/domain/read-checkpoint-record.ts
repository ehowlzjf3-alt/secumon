import type { ArtifactRef } from './model.js';
import type { KnowledgeDependency } from './knowledge.js';
import type { ReadCall, ReadCheckpoint } from './read-checkpoint.js';

export type ReadCheckpointChange =
  | { type: 'start'; checkpoint: ReadCheckpoint }
  | { type: 'resume'; base: ArtifactRef; attemptId: string; updatedAt: number; knowledgeDependencies: KnowledgeDependency[] }
  | { type: 'intent'; base: ArtifactRef; call: ReadCall; updatedAt: number }
  | { type: 'settle'; base: ArtifactRef; call: ReadCall; updatedAt: number }
  | { type: 'stop'; base: ArtifactRef; reason: string; updatedAt: number };

/** Storage event only. The decoded logical checkpoint retains the v1 application contract. */
export interface ReadCheckpointRecord {
  schemaVersion: 2;
  kind: 'read_checkpoint_record';
  logicalDigest: string;
  change: ReadCheckpointChange;
}
